import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openDocument } from '../dist/core.mjs';
import { HwpxBuilder } from '../dist/hwpx-builder.mjs';
import { compileMarkdownToHwpx } from '../dist/markdown-compiler.mjs';

test('실전 대용량 공모전 공고문 (notice.hwpx) 파싱 검증', () => {
  const filePath = path.resolve('tests/fixtures/contests/notice.hwpx');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.paragraphs.length > 10, `문단 수가 너무 적습니다: ${doc.paragraphs.length}`);
  assert.ok(doc.fullText.length > 1000, '본문 텍스트가 정상 추출되어야 합니다.');
});

test('HWP 5.x 배포용 문서 (ViewText AES-128 복호화) 파싱 및 표 복원 검증', () => {
  const filePath = path.resolve('tests/fixtures/[공고] 2022년 예비창업패키지 예비창업자 모집공고.hwp');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwp');
  assert.ok(doc.paragraphs.length >= 1000, '배포용 문서 ViewText 복호화로 1,000개 이상의 문단이 복원되어야 합니다.');
  assert.ok(doc.tables.length >= 40, '배포용 문서 ViewText 복호화로 40개 이상의 표가 복원되어야 합니다.');
  assert.ok(doc.fullText.includes('중소벤처기업부') && doc.fullText.includes('예비창업패키지'), '본문 키워드가 온전히 포함되어야 합니다.');
});

test('HWP 5.x 표준 샘플 문서 (sample-5017.hwp) 파싱 검증', () => {
  const filePath = path.resolve('tests/fixtures/samples/sample-5017.hwp');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwp');
  assert.ok(doc.tables.length >= 2, '표가 파싱되어야 합니다.');
  assert.ok(doc.fullText.includes('글 워드 프로세서'), '본문 텍스트가 정상 추출되어야 합니다.');
});

test('HWPX 표준 문서 (fsc_fund_report.hwpx) 파싱 및 마크다운 변환 검증', () => {
  const filePath = path.resolve('tests/fixtures/samples/fsc_fund_report.hwpx');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwpx');
  assert.equal(doc.version, 'KS X 6101 HWPX');
  assert.ok(doc.paragraphs.length >= 50, '문단이 파싱되어야 합니다.');
  assert.ok(doc.tables.length >= 5, '표가 파싱되어야 합니다.');
  assert.ok(doc.fullText.includes('국민성장펀드'), '본문 키워드가 포함되어야 합니다.');

  const md = doc.toMarkdown();
  assert.ok(md.includes('# HWPX 문서'), '마크다운 헤더가 포함되어야 합니다.');
  assert.ok(md.includes('|'), '마크다운 표 문법이 포함되어야 합니다.');
});

test('tests/fixtures 내 모든 실무 공문서/공모전 파일 전수 호환성 검증', () => {
  const fixturesDir = path.resolve('tests/fixtures');
  const files = fs.readdirSync(fixturesDir).filter((f) => (f.endsWith('.hwp') || f.endsWith('.hwpx')) && !f.startsWith('.'));

  assert.ok(files.length >= 10, '최소 10개 이상의 실무 테스트 파일이 존재해야 합니다.');

  for (const file of files) {
    const fullPath = path.join(fixturesDir, file);
    const doc = openDocument(fullPath);
    assert.ok(doc.format === 'hwp' || doc.format === 'hwpx');
    assert.ok(doc.paragraphs.length > 0, `${file}에서 1개 이상의 문단이 추출되어야 합니다.`);
    assert.ok(doc.fullText.length > 0, `${file}에서 본문 텍스트가 추출되어야 합니다.`);
  }
});

test('HWPX 서명 및 도장 "글 뒤로(BEHIND_TEXT)" 생성 및 무손실 파싱 검증', () => {
  const outHwpx = path.resolve('dist/test_signature_behind.hwpx');
  if (fs.existsSync(outHwpx)) fs.unlinkSync(outHwpx);

  // 1. 임시 서명 이미지 생성 (1x1 PNG)
  const dummyImg = path.resolve('dist/dummy_stamp.png');
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(dummyImg, Buffer.from(pngBase64, 'base64'));

  // 2. HwpxBuilder로 서명 및 "글 뒤로" 이미지 생성
  const builder = new HwpxBuilder();
  builder.addHeading('창업지원사업 협약서 및 서명란', 1);
  builder.addParagraph('본 협약의 성립을 증명하기 위하여 대표자가 서명 및 날인합니다.');
  builder.addSignature({
    label: '보 고 자 (동아리 대표) : 홍길동 (서명/인)',
    imagePath: dummyImg,
    width: 6000,
    height: 6000,
  });

  const hwpxBytes = builder.build();
  fs.writeFileSync(outHwpx, hwpxBytes);

  // 3. openDocument로 파싱하여 pictures 검증
  const doc = openDocument(outHwpx);
  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.fullText.includes('홍길동'));
  assert.ok(doc.fullText.includes('(서명/인)'));
  assert.ok(doc.pictures && doc.pictures.length >= 1, '파싱된 문서에 그림 개체가 포함되어야 합니다.');

  const sigPic = doc.pictures[0];
  assert.equal(sigPic.isBehindText, true, '서명 이미지는 isBehindText가 true이어야 합니다.');
  assert.equal(sigPic.textWrap, 'BEHIND_TEXT', '서명 이미지는 textWrap이 BEHIND_TEXT이어야 합니다.');
  assert.equal(sigPic.treatAsChar, false, '서명 이미지는 treatAsChar가 false이어야 합니다.');
  assert.equal(sigPic.allowOverlap, true, '서명 이미지는 allowOverlap이 true이어야 합니다.');
  assert.equal(sigPic.zOrder, -1, '서명 이미지는 zOrder가 -1이어야 합니다.');
});

test('Markdown 컴파일러 서명 및 "글 뒤로" 문법 컴파일 검증', () => {
  const outHwpx = path.resolve('dist/test_md_signature.hwpx');
  if (fs.existsSync(outHwpx)) fs.unlinkSync(outHwpx);

  const dummyImg = path.resolve('dist/dummy_stamp.png');
  const md = `# 결과보고서\n\n위 내용이 사실임을 확인합니다.\n\n대표자 : 홍길동 (서명/인) ![서명|behind](${dummyImg})\n`;
  compileMarkdownToHwpx(md, outHwpx);

  const doc = openDocument(outHwpx);
  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.fullText.includes('홍길동'));
  assert.ok(doc.fullText.includes('(서명/인)'));
  assert.ok(doc.pictures && doc.pictures.length >= 1, '마크다운 서명 이미지가 파싱되어야 합니다.');
  const pic = doc.pictures[0];
  assert.equal(pic.isBehindText, true, '마크다운 서명 이미지는 글 뒤로(isBehindText)로 생성되어야 합니다.');
});
