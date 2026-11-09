import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { openDocument, parseHwpBuffer } from '../dist/core.mjs';
import { validateBytes } from '../dist/storage.mjs';

function callMcp(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/mcp.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = [];
    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }
    });

    child.on('close', () => {
      if (buffer.trim()) {
        responses.push(JSON.parse(buffer));
      }
      resolve(responses);
    });
    child.on('error', reject);

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
    child.stdin.end();
  });
}

function makeRecord(tagId, level, data) {
  const size = data.length;
  if (size < 0xfff) {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(((tagId & 0x3ff) | ((level & 0x3ff) << 10) | ((size & 0xfff) << 20)) >>> 0, 0);
    return Buffer.concat([hdr, data]);
  }
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32LE(((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (0xfff << 20)) >>> 0, 0);
  hdr.writeUInt32LE(size >>> 0, 4);
  return Buffer.concat([hdr, data]);
}

/**
 * 테스트용 순수 CFBF(HWP 5.x) 바이너리 빌더 (miniStreamCutoff=0, 512B 섹터)
 */
function buildSyntheticHwpCfb({ compressed, sectionRaw, binPngCompressed }) {
  const sectorSize = 512;
  const headerStream = Buffer.alloc(256, 0);
  headerStream.write('HWP Document File', 0, 'ascii');
  headerStream.writeUInt32LE((5 << 24) | (1 << 16) | (0 << 8) | 1, 32);
  headerStream.writeUInt32LE(compressed ? 1 : 0, 36);

  const sectionPayload = compressed ? zlib.deflateRawSync(sectionRaw) : sectionRaw;
  const streams = [
    { data: headerStream },
    { data: sectionPayload },
    { data: binPngCompressed },
  ];

  const sectors = [];
  const fat = [];
  const streamMeta = [];

  for (const s of streams) {
    const count = Math.max(1, Math.ceil(s.data.length / sectorSize));
    const startSec = sectors.length;
    for (let i = 0; i < count; i++) {
      const secBuf = Buffer.alloc(sectorSize, 0);
      s.data.copy(secBuf, 0, i * sectorSize, Math.min(s.data.length, (i + 1) * sectorSize));
      sectors.push(secBuf);
      fat.push(i === count - 1 ? 0xfffffffe : startSec + i + 1);
    }
    streamMeta.push({ startSec, size: s.data.length });
  }

  // Directory entries (6 entries -> 2 directory sectors)
  // 0: Root Entry (child: 1)
  // 1: FileHeader (left: 2, right: 3)
  // 2: BodyText storage (child: 4)
  // 3: BinData storage (child: 5)
  // 4: Section0 stream
  // 5: BIN0001.png stream
  const dirDefs = [
    { name: 'Root Entry', type: 5, left: 0xffffffff, right: 0xffffffff, child: 1, start: 0xfffffffe, size: 0 },
    { name: 'FileHeader', type: 2, left: 2, right: 3, child: 0xffffffff, start: streamMeta[0].startSec, size: streamMeta[0].size },
    { name: 'BodyText', type: 1, left: 0xffffffff, right: 0xffffffff, child: 4, start: 0xfffffffe, size: 0 },
    { name: 'BinData', type: 1, left: 0xffffffff, right: 0xffffffff, child: 5, start: 0xfffffffe, size: 0 },
    { name: 'Section0', type: 2, left: 0xffffffff, right: 0xffffffff, child: 0xffffffff, start: streamMeta[1].startSec, size: streamMeta[1].size },
    { name: 'BIN0001.png', type: 2, left: 0xffffffff, right: 0xffffffff, child: 0xffffffff, start: streamMeta[2].startSec, size: streamMeta[2].size },
  ];

  const dirSecCount = Math.ceil(dirDefs.length / 4);
  const firstDirSec = sectors.length;
  for (let s = 0; s < dirSecCount; s++) {
    const secBuf = Buffer.alloc(sectorSize, 0);
    for (let i = 0; i < 4; i++) {
      const d = dirDefs[s * 4 + i];
      if (!d) continue;
      const off = i * 128;
      const nameUtf16 = Buffer.from(d.name + '\0', 'utf16le');
      nameUtf16.copy(secBuf, off);
      secBuf.writeUInt16LE(nameUtf16.length, off + 64);
      secBuf.writeUInt8(d.type, off + 66);
      secBuf.writeUInt8(1, off + 67);
      secBuf.writeUInt32LE(d.left >>> 0, off + 68);
      secBuf.writeUInt32LE(d.right >>> 0, off + 72);
      secBuf.writeUInt32LE(d.child >>> 0, off + 76);
      secBuf.writeUInt32LE(d.start >>> 0, off + 116);
      secBuf.writeUInt32LE(d.size >>> 0, off + 120);
    }
    sectors.push(secBuf);
    fat.push(s === dirSecCount - 1 ? 0xfffffffe : firstDirSec + s + 1);
  }

  // 1 FAT sector
  const fatSecIdx = sectors.length;
  fat.push(0xfffffffd); // FATSECT
  const fatBuf = Buffer.alloc(sectorSize, 0xff);
  for (let i = 0; i < fat.length; i++) {
    fatBuf.writeUInt32LE(fat[i] >>> 0, i * 4);
  }
  sectors.push(fatBuf);

  const cfbHeader = Buffer.alloc(sectorSize, 0xff);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfbHeader, 0);
  cfbHeader.fill(0, 8, 76);
  cfbHeader.writeUInt16LE(0x003e, 24);
  cfbHeader.writeUInt16LE(0x0003, 26);
  cfbHeader.writeUInt16LE(0xfffe, 28);
  cfbHeader.writeUInt16LE(9, 30); // 512B sector
  cfbHeader.writeUInt16LE(6, 32); // 64B mini sector
  cfbHeader.writeUInt32LE(1, 44); // 1 FAT sector
  cfbHeader.writeUInt32LE(firstDirSec, 48);
  cfbHeader.writeUInt32LE(0, 56); // miniStreamCutoff = 0 -> all streams in main sectors
  cfbHeader.writeUInt32LE(0xfffffffe, 60);
  cfbHeader.writeUInt32LE(0, 64);
  cfbHeader.writeUInt32LE(0xfffffffe, 68);
  cfbHeader.writeUInt32LE(0, 72);
  cfbHeader.writeUInt32LE(fatSecIdx, 76);

  return Buffer.concat([cfbHeader, ...sectors]);
}

test('GAP-HWPX-01: hanul_insert_image가 표준 KS X 6101 <hc:img> 및 content.hpf <opf:item>을 등록하는지 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-hwpx-01-'));
  try {
    const hwpxPath = path.join(tmpDir, 'doc.hwpx');
    const imgPath = path.join(tmpDir, 'stamp.png');
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    fs.writeFileSync(imgPath, pngBytes);

    const res = await callMcp([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'hanul_create_document',
          arguments: { outputPath: hwpxPath, title: '이미지 스키마 검증', paragraphs: ['본문'] },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hanul_insert_image',
          arguments: { filePath: hwpxPath, imagePath: imgPath, behindText: true, widthPt: 80, heightPt: 60 },
        },
      },
    ]);

    assert.equal(res[1].result.success, true);
    const outBytes = fs.readFileSync(hwpxPath);
    assert.doesNotThrow(() => validateBytes(outBytes, 'hwpx'));

    const zip = unzipSync(new Uint8Array(outBytes));
    const parser = new DOMParser();
    const secDoc = parser.parseFromString(strFromU8(zip['Contents/section0.xml']), 'text/xml');
    const hpfDoc = parser.parseFromString(strFromU8(zip['Contents/content.hpf']), 'text/xml');

    // 비표준 <hp:img> 태그가 절대 생성되지 않아야 함
    assert.equal(secDoc.getElementsByTagName('hp:img').length, 0, '비표준 <hp:img> 태그 금지');

    const pics = secDoc.getElementsByTagName('hp:pic');
    assert.equal(pics.length, 1);
    const pic = pics.item(0);
    assert.equal(pic.parentNode.nodeName, 'hp:run');
    assert.equal(pic.parentNode.parentNode.nodeName, 'hp:p');
    assert.equal(pic.getElementsByTagName('hp:orgSz').length, 1);
    assert.equal(pic.getElementsByTagName('hp:curSz').length, 1);

    const hcImgs = pic.getElementsByTagName('hc:img');
    assert.equal(hcImgs.length, 1);
    const hcImg = hcImgs.item(0);
    const binRef = hcImg.getAttribute('binaryItemIDRef');
    assert.ok(binRef && binRef.length > 0);
    assert.equal(hcImg.getAttribute('effect'), 'REAL_PIC');

    // content.hpf 매니페스트 등록 검증
    const opfItems = Array.from(hpfDoc.getElementsByTagName('opf:item'));
    const matched = opfItems.find((item) => item.getAttribute('id') === binRef);
    assert.ok(matched, 'Contents/content.hpf 내 <opf:item>이 누락 없이 등록되어야 합니다.');
    assert.equal(matched.getAttribute('media-type'), 'image/png');
    assert.equal(matched.getAttribute('isEmbeded'), '1');
    assert.ok(zip[matched.getAttribute('href')], 'ZIP 아카이브 내부 BinData 엔트리와 일치해야 합니다.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GAP-HWPX-02: hanul_append_content 표가 <hp:p><hp:run><hp:tbl>로 래핑되고 셀 필수 요소를 완비하는지 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-hwpx-02-'));
  try {
    const hwpxPath = path.join(tmpDir, 'append_tbl.hwpx');
    await callMcp([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'hanul_create_document',
          arguments: { outputPath: hwpxPath, title: '표 래핑 테스트', paragraphs: ['초기 문단'] },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hanul_append_content',
          arguments: {
            filePath: hwpxPath,
            heading: '추가 표 섹션',
            paragraphs: ['설명 문단'],
            table: {
              rows: [
                ['구분', '예산(백만원)'],
                ['인건비', '120'],
              ],
            },
          },
        },
      },
    ]);

    const zip = unzipSync(new Uint8Array(fs.readFileSync(hwpxPath)));
    const secDoc = new DOMParser().parseFromString(strFromU8(zip['Contents/section0.xml']), 'text/xml');
    const secElem = secDoc.documentElement;

    // <hs:sec> 직하위에 <hp:tbl>이 직접 놓이면 절대 안 됨
    for (let i = 0; i < secElem.childNodes.length; i++) {
      const child = secElem.childNodes.item(i);
      if (child && child.nodeType === 1) {
        assert.notEqual(child.nodeName, 'hp:tbl', '<hs:sec> 직하위에 <hp:tbl> 배치 금지');
      }
    }

    const tbls = secDoc.getElementsByTagName('hp:tbl');
    assert.equal(tbls.length, 1);
    const tbl = tbls.item(0);
    assert.equal(tbl.parentNode.nodeName, 'hp:run');
    assert.equal(tbl.parentNode.parentNode.nodeName, 'hp:p');
    assert.ok(tbl.getAttribute('borderFillIDRef'), '표 borderFillIDRef 필수');

    const tcs = tbl.getElementsByTagName('hp:tc');
    assert.equal(tcs.length, 4);
    for (let i = 0; i < tcs.length; i++) {
      const tc = tcs.item(i);
      assert.ok(tc.getAttribute('borderFillIDRef'), '셀 borderFillIDRef 필수');
      assert.equal(tc.getElementsByTagName('hp:cellAddr').length, 1);
      assert.equal(tc.getElementsByTagName('hp:cellSpan').length, 1);
      assert.equal(tc.getElementsByTagName('hp:cellSz').length, 1);
    }

    const parsed = openDocument(hwpxPath);
    assert.equal(parsed.tables.length, 1);
    assert.deepEqual(parsed.tables[0].cells, [
      ['구분', '예산(백만원)'],
      ['인건비', '120'],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GAP-HWPX-03: hanul_find_and_replace가 XML 태그/속성을 훼손하지 않고 <hp:t> 내부만 안전 치환하는지 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-hwpx-03-'));
  try {
    const hwpxPath = path.join(tmpDir, 'replace_safe.hwpx');
    await callMcp([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'hanul_create_document',
          arguments: {
            outputPath: hwpxPath,
            title: 'XML 안전 치환 검증',
            paragraphs: ['본문 내 hp:p 문자열과 TARGET 토큰을 치환합니다.'],
          },
        },
      },
      // 1) 태그명과 동일한 'hp:p' 치환 시 본문 <hp:t>의 'hp:p' 1건만 바뀌고 실제 <hp:p> 태그는 보존되어야 함
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hanul_find_and_replace',
          arguments: { filePath: hwpxPath, findText: 'hp:p', replaceText: '문단태그' },
        },
      },
      // 2) XML 특수문자 및 정규식 역참조 문자($1, $&)가 포함된 치환 문자열 안전 이스케이프 검증
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'hanul_find_and_replace',
          arguments: { filePath: hwpxPath, findText: 'TARGET', replaceText: '<특수 & "값" $1>' },
        },
      },
    ]);

    const rawBytes = fs.readFileSync(hwpxPath);
    assert.doesNotThrow(() => validateBytes(rawBytes, 'hwpx'), '치환 후 XML 무결성이 100% 유지되어야 합니다.');

    const doc = openDocument(hwpxPath);
    assert.ok(doc.fullText.includes('본문 내 문단태그 문자열과 <특수 & "값" $1> 토큰을 치환합니다.'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GAP-HWPX-04: hanul_fill_fields가 동일 문단(<hp:p>) 내 형제 <hp:t> 런을 지우지 않고 필드 범위만 격리 갱신하는지 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-hwpx-04-'));
  try {
    const hwpxPath = path.join(tmpDir, 'fields_sibling.hwpx');
    await callMcp([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'hanul_create_document',
          arguments: { outputPath: hwpxPath, title: '누름틀 격리 테스트', paragraphs: ['안내문'] },
        },
      },
    ]);

    // 동일 <hp:p> 안에 일반 텍스트 런 + 필드1 + 구분 텍스트 런 + 빈 필드2 + 후행 텍스트 런 구성
    const zip = unzipSync(new Uint8Array(fs.readFileSync(hwpxPath)));
    const parser = new DOMParser();
    const doc = parser.parseFromString(strFromU8(zip['Contents/section0.xml']), 'text/xml');
    const secElem = doc.documentElement;

    const pMulti = doc.createElement('hp:p');
    pMulti.setAttribute('id', '500');
    const rPrefix = doc.createElement('hp:run');
    const tPrefix = doc.createElement('hp:t');
    tPrefix.textContent = '신청자: ';
    rPrefix.appendChild(tPrefix);
    pMulti.appendChild(rPrefix);

    const rF1Begin = doc.createElement('hp:run');
    const fb1 = doc.createElement('hp:fieldBegin');
    fb1.setAttribute('id', '10');
    fb1.setAttribute('name', '성명');
    fb1.setAttribute('type', 'CLICK_HERE');
    rF1Begin.appendChild(fb1);
    pMulti.appendChild(rF1Begin);

    const rF1Val = doc.createElement('hp:run');
    const tF1Val = doc.createElement('hp:t');
    tF1Val.textContent = '기존이름';
    rF1Val.appendChild(tF1Val);
    pMulti.appendChild(rF1Val);

    const rF1End = doc.createElement('hp:run');
    const fe1 = doc.createElement('hp:fieldEnd');
    fe1.setAttribute('beginIDRef', '10');
    rF1End.appendChild(fe1);
    pMulti.appendChild(rF1End);

    const rMid = doc.createElement('hp:run');
    const tMid = doc.createElement('hp:t');
    tMid.textContent = ' / 직책: ';
    rMid.appendChild(tMid);
    pMulti.appendChild(rMid);

    // 빈 누름틀 (사이에 <hp:t> 없음) + 후행 형제 <hp:t>
    const rInline = doc.createElement('hp:run');
    const fb2 = doc.createElement('hp:fieldBegin');
    fb2.setAttribute('id', '11');
    fb2.setAttribute('name', '직책');
    rInline.appendChild(fb2);
    const fe2 = doc.createElement('hp:fieldEnd');
    fe2.setAttribute('beginIDRef', '11');
    rInline.appendChild(fe2);
    const tSuffix = doc.createElement('hp:t');
    tSuffix.textContent = ' (서명/인)';
    rInline.appendChild(tSuffix);
    pMulti.appendChild(rInline);

    secElem.appendChild(pMulti);
    zip['Contents/section0.xml'] = strToU8(new XMLSerializer().serializeToString(doc));
    fs.writeFileSync(hwpxPath, Buffer.from(zipSync(zip)));

    const res = await callMcp([
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hanul_fill_fields',
          arguments: {
            filePath: hwpxPath,
            data: { 성명: '장영실', 직책: '책임연구원' },
          },
        },
      },
    ]);
    assert.equal(res[0].result.filledCount, 2);

    const updated = openDocument(hwpxPath);
    const targetPara = updated.paragraphs.find((p) => p.includes('신청자:'));
    assert.ok(targetPara, '신청자 문단이 유지되어야 합니다.');
    assert.ok(targetPara.includes('신청자:'), '선행 형제 텍스트 보존');
    assert.ok(targetPara.includes('장영실'), '첫 번째 필드 값 반영');
    assert.ok(targetPara.includes('/ 직책:'), '중간 형제 텍스트 보존');
    assert.ok(targetPara.includes('책임연구원'), '빈 두 번째 필드 값 반영');
    assert.ok(targetPara.includes('(서명/인)'), '후행 형제 텍스트 보존');
    assert.ok(!targetPara.includes('기존이름'), '이전 필드 플레이스홀더 제거');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GAP-HWPX-05: hwpx-parser.ts가 <hp:tbl>/<hp:tc> 내부 셀 문단을 상위 paragraphs에 중복 수집하지 않는지 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-hwpx-05-'));
  try {
    const hwpxPath = path.join(tmpDir, 'no_dup.hwpx');
    await callMcp([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'hanul_create_document',
          arguments: {
            outputPath: hwpxPath,
            title: '본문제목_유일',
            paragraphs: ['독립문단_하나', '독립문단_둘'],
            tables: [
              {
                rows: [
                  ['셀전용_헤더A', '셀전용_헤더B'],
                  ['셀전용_값1', '셀전용_값2'],
                ],
              },
            ],
          },
        },
      },
    ]);

    const doc = openDocument(hwpxPath);
    assert.deepEqual(doc.paragraphs, ['본문제목_유일', '독립문단_하나', '독립문단_둘']);
    for (const p of doc.paragraphs) {
      assert.ok(!p.includes('셀전용_'), `표 셀 텍스트가 본문 paragraphs에 중복 유입됨: ${p}`);
    }
    assert.equal(doc.tables.length, 1);
    assert.deepEqual(doc.tables[0].cells, [
      ['셀전용_헤더A', '셀전용_헤더B'],
      ['셀전용_값1', '셀전용_값2'],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GAP-HWPX-06: HWP 5.x 압축 BinData/누름틀 복원 및 최상위 표 종료 시 tableStack 팝 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-hwpx-06-'));
  try {
    // 1x1 PNG 원본 및 raw deflate 압축 스트림 준비
    const origPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const compressedPng = zlib.deflateRawSync(origPng);

    // Section0 레코드 구성:
    // 1) 최상위 1x2 표 (level=2) -> 셀(0,0)="표셀좌", 셀(0,1)="표셀우"
    // 2) 표 종료 후 일반 본문 문단 (level=0/1) -> "표바깥_후속문단" (절대 셀(0,1)에 합쳐지면 안 됨!)
    // 3) %clk 누름틀 CTRL_HEADER (name="지원자_성명")
    const tblData = Buffer.alloc(16, 0);
    tblData.writeUInt16LE(1, 4); // rows = 1
    tblData.writeUInt16LE(2, 6); // cols = 2

    const makeCellHeader = (col, row) => {
      const b = Buffer.alloc(18, 0);
      b.writeUInt16LE(col, 2);
      b.writeUInt16LE(row, 4);
      b.writeUInt16LE(1, 6);
      b.writeUInt16LE(1, 8);
      b.writeUInt32LE(20000, 10);
      b.writeUInt32LE(1000, 14);
      return b;
    };

    const cmdUtf16 = Buffer.from('지원자_성명:이름을 입력하세요', 'utf16le');
    const clkCtrl = Buffer.alloc(11 + cmdUtf16.length + 4, 0);
    // '%clk' reversed in little-endian: 'k', 'l', 'c', '%'
    Buffer.from('klc%', 'ascii').copy(clkCtrl, 0);
    clkCtrl.writeUInt16LE(cmdUtf16.length / 2, 9);
    cmdUtf16.copy(clkCtrl, 11);

    const sectionRaw = Buffer.concat([
      makeRecord(66, 0, Buffer.alloc(22, 0)), // PARA_HEADER (lvl 0)
      makeRecord(71, 1, Buffer.from(' lbt', 'ascii')), // CTRL_HEADER 'tbl ' (lvl 1)
      makeRecord(77, 2, tblData), // TABLE 1x2 (lvl 2)
      makeRecord(72, 2, makeCellHeader(0, 0)), // LIST_HEADER cell(0,0) (lvl 2)
      makeRecord(66, 2, Buffer.alloc(22, 0)), // PARA_HEADER (lvl 2)
      makeRecord(67, 3, Buffer.from('표셀좌\r', 'utf16le')), // PARA_TEXT (lvl 3)
      makeRecord(72, 2, makeCellHeader(1, 0)), // LIST_HEADER cell(0,1) (lvl 2)
      makeRecord(66, 2, Buffer.alloc(22, 0)), // PARA_HEADER (lvl 2)
      makeRecord(67, 3, Buffer.from('표셀우\r', 'utf16le')), // PARA_TEXT (lvl 3)
      // 최상위 표 종료 -> 본문 레벨(lvl 0) 복귀!
      makeRecord(66, 0, Buffer.alloc(22, 0)), // PARA_HEADER (lvl 0)
      makeRecord(67, 1, Buffer.from('표바깥_후속문단\r', 'utf16le')), // PARA_TEXT (lvl 1)
      makeRecord(71, 1, clkCtrl), // CTRL_HEADER '%clk' (lvl 1)
      makeRecord(67, 1, Buffer.from('홍길동\r', 'utf16le')),
    ]);

    const hwpBuf = buildSyntheticHwpCfb({
      compressed: true,
      sectionRaw,
      binPngCompressed: compressedPng,
    });
    const hwpPath = path.join(tmpDir, 'synthetic_compressed.hwp');
    fs.writeFileSync(hwpPath, hwpBuf);

    // A. hwp-parser.ts: 최상위 표 종료 시 tableStack 팝 검증
    const parsedHwp = parseHwpBuffer(hwpBuf);
    assert.equal(parsedHwp.sections[0].tables.length, 1);
    assert.deepEqual(parsedHwp.sections[0].tables[0].cells, [['표셀좌', '표셀우']]);
    assert.ok(
      !parsedHwp.sections[0].tables[0].cells[0][1].includes('표바깥_후속문단'),
      '최상위 표 종료 후 본문 문단이 마지막 표 셀에 오염되면 안 됩니다.'
    );
    assert.ok(parsedHwp.sections[0].paragraphs.includes('표바깥_후속문단'));

    // B. MCP hanul_extract_images & hanul_get_fields 압축 스트림 복원 검증
    const imgOutDir = path.join(tmpDir, 'extracted');
    const mcpRes = await callMcp([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'hanul_extract_images',
          arguments: { filePath: hwpPath, outputDir: imgOutDir, includeBase64: true },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hanul_get_fields',
          arguments: { filePath: hwpPath },
        },
      },
    ]);

    const imgResult = mcpRes[0].result;
    assert.equal(imgResult.totalImages, 1);
    assert.equal(imgResult.images[0].mimeType, 'image/png', '압축 해제 후 PNG 시그니처가 복원되어야 합니다.');
    const savedPng = fs.readFileSync(path.join(imgOutDir, 'BIN0001.png'));
    assert.deepEqual(savedPng, origPng, '복원된 PNG 바이트가 원본과 100% 일치해야 합니다.');

    const fieldResult = mcpRes[1].result;
    assert.ok(
      fieldResult.fields.some((f) => f.name === '지원자_성명'),
      '압축된 BodyText/Section0에서 누름틀 필드명이 복원되어야 합니다.'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
