/**
 * HWP 5.x 고수준 파서
 * CompoundFile + RecordParser를 결합하여 문서의 본문 텍스트, 문단, 표 데이터를 추출합니다.
 * 배포용 문서(Distribution Document) 및 일반 문서 모두 지원합니다.
 */

import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { CompoundFile, DirectoryEntry } from './cfbf.js';
import { parseFileHeader, decompressStream, parseRecords, HWP_TAG, HwpFileHeader, HwpRecord } from './hwp-record.js';

class MsvcRandom {
  private seed: number;
  constructor(seed: number) { this.seed = seed >>> 0; }
  rand(): number {
    this.seed = (Math.imul(this.seed, 214013) + 2531011) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }
}

function decodeHeadToKey(payload: Buffer): Buffer {
  const data = Buffer.from(payload);
  const seed = data.readUInt32LE(0);
  const rng = new MsvcRandom(seed);
  let n = 0;
  let key = 0;
  for (let i = 0; i < 256; i++) {
    if (n === 0) {
      key = rng.rand() & 0xff;
      n = (rng.rand() & 0xf) + 1;
    }
    if (i >= 4) {
      data[i] = data[i] ^ key;
    }
    n--;
  }
  const sha1offset = 4 + (seed & 0xf);
  return data.subarray(sha1offset, sha1offset + 16);
}

/**
 * 배포용 문서(ViewText/Section*) 복호화
 * HWPTAG_DISTRIBUTE_DOC_DATA(0x1c)에서 시드 추출 -> AES-128 키 생성 -> AES-128-ECB 복호화 -> zlib inflate
 */
export function decryptViewTextStream(stream: Buffer): Buffer {
  if (stream.length < 260) return stream;
  const header = stream.readUInt32LE(0);
  const tagId = header & 0x3ff;
  let size = (header >>> 20) & 0xfff;
  let offset = 4;
  if (size === 0xfff) {
    size = stream.readUInt32LE(4);
    offset = 8;
  }
  // HWPTAG_DISTRIBUTE_DOC_DATA는 28 (0x1c)
  if (tagId !== 28 || offset + size > stream.length) return stream;

  const payload = stream.subarray(offset, offset + size);
  const aesKey = decodeHeadToKey(payload);
  const tail = stream.subarray(offset + size);

  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(tail), decipher.final()]);
    try {
      return zlib.inflateRawSync(decrypted);
    } catch {
      try {
        return zlib.inflateSync(decrypted);
      } catch {
        return decrypted;
      }
    }
  } catch {
    return stream;
  }
}

export interface ParsedTable {
  rows: number;
  cols: number;
  cells: string[][]; // 2D 텍스트 배열
}

export interface ParsedHwpDocument {
  header: HwpFileHeader;
  sections: {
    index: number;
    paragraphs: string[];
    tables: ParsedTable[];
  }[];
  fullText: string;
}

/**
 * HWPTAG_PARA_TEXT 바이너리 버퍼에서 순수 본문 텍스트 추출
 */
export function cleanParaText(data: Buffer): string {
  let result = '';
  let i = 0;

  while (i + 1 < data.length) {
    const code = data.readUInt16LE(i);
    i += 2;

    if (code === 0x0000) {
      break;
    } else if (code === 0x000d) {
      result += '\n';
    } else if (code === 0x0009) {
      result += '\t';
    } else if (code === 0x000a) {
      result += '\n';
    } else if (code >= 0x0001 && code <= 0x001f) {
      // 인라인 컨트롤 확장 코드 (0x000b: 표/그림, 0x0003: 필드 등)
      if (code === 0x000b || code === 0x000c || code === 0x0003 || code === 0x0002) {
        i += 12; // 인라인 확장 토큰 건너뛰기
      } else if (code === 0x001e || code === 0x001f) {
        result += ' ';
      }
    } else {
      result += String.fromCharCode(code);
    }
  }

  return result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/**
 * HWP 5.x 버퍼 전체 파싱
 */
export function parseHwpBuffer(buffer: Buffer): ParsedHwpDocument {
  const cfb = new CompoundFile(buffer);

  // 1. FileHeader 스트림 파싱
  const headerStream = cfb.getStream('FileHeader');
  if (!headerStream) {
    throw new Error('HWP FileHeader 스트림을 찾을 수 없습니다.');
  }
  const header = parseFileHeader(headerStream);

  // 2. BodyText 또는 배포용 문서인 경우 ViewText 하위의 Section* 스트림 탐색
  const entries = cfb.listEntries();
  const hasViewText = entries.some((e) => /viewtext\/section\d+$/i.test(e.path));
  const isDistribution = header.flags.distribution || hasViewText;

  let sectionEntries: DirectoryEntry[] = [];

  if (isDistribution && hasViewText) {
    // 배포용 문서는 ViewText 우선 탐색
    for (const entry of entries) {
      if (entry.type === 2 && /section\d+$/i.test(entry.name) && entry.path.toLowerCase().includes('viewtext')) {
        if (!sectionEntries.some((e) => e.id === entry.id)) {
          sectionEntries.push(entry);
        }
      }
    }
  }

  // 일반 문서이거나 ViewText가 없으면 BodyText 탐색
  if (sectionEntries.length === 0) {
    for (const entry of entries) {
      const isSection = /section\d+$/i.test(entry.name) || /bodytext\/section\d+$/i.test(entry.path);
      const isBodyText = entry.path.toLowerCase().includes('bodytext') || !entry.path.toLowerCase().includes('viewtext');

      if (entry.type === 2 && isSection && isBodyText) {
        if (!sectionEntries.some((e) => e.id === entry.id)) {
          sectionEntries.push(entry);
        }
      }
    }
  }

  sectionEntries.sort((a, b) => {
    const numA = parseInt(a.name.replace(/\D/g, '') || '0', 10);
    const numB = parseInt(b.name.replace(/\D/g, '') || '0', 10);
    return numA - numB;
  });

  const sections: ParsedHwpDocument['sections'] = [];
  let fullText = '';

  for (let i = 0; i < sectionEntries.length; i++) {
    const secEntry = sectionEntries[i];
    let stream = cfb.getStream(secEntry);
    if (!stream) continue;

    const isViewTextStream = secEntry.path.toLowerCase().includes('viewtext');
    let records: HwpRecord[] = [];

    if (isViewTextStream) {
      // 배포용 문서 복호화 파이프라인
      const decrypted = decryptViewTextStream(stream);
      records = parseRecords(decrypted);
    } else {
      if (header.flags.compressed) {
        stream = decompressStream(stream);
      }
      records = parseRecords(stream);
    }

    const paragraphs: string[] = [];
    const tables: ParsedTable[] = [];

    let currentTable: ParsedTable | null = null;
    let currentCellRow = 0;
    let currentCellCol = 0;

    for (let r = 0; r < records.length; r++) {
      const rec = records[r];

      // 문단 텍스트 (PARA_TEXT = 67)
      if (rec.tagId === HWP_TAG.PARA_TEXT) {
        const text = cleanParaText(rec.data).trim();
        if (text.length > 0) {
          paragraphs.push(text);
          if (currentTable && currentCellRow < currentTable.rows && currentCellCol < currentTable.cols) {
            const existing = currentTable.cells[currentCellRow][currentCellCol];
            currentTable.cells[currentCellRow][currentCellCol] = existing ? `${existing} ${text}` : text;
          }
        }
      }

      // 표 속성 (TABLE = 77)
      if (rec.tagId === HWP_TAG.TABLE && rec.data.length >= 8) {
        const rows = rec.data.readUInt16LE(4);
        const cols = rec.data.readUInt16LE(6);

        if (rows > 0 && cols > 0 && rows < 1000 && cols < 100) {
          currentTable = {
            rows,
            cols,
            cells: Array.from({ length: rows }, () => Array(cols).fill('')),
          };
          tables.push(currentTable);
          currentCellRow = 0;
          currentCellCol = 0;
        }
      }

      // 셀 헤더 (LIST_HEADER = 72)
      if (rec.tagId === HWP_TAG.LIST_HEADER && currentTable && rec.data.length >= 8) {
        const colIdx = rec.data.readUInt16LE(2);
        const rowIdx = rec.data.readUInt16LE(4);
        if (rowIdx < currentTable.rows && colIdx < currentTable.cols) {
          currentCellRow = rowIdx;
          currentCellCol = colIdx;
        }
      }
    }

    const sectionText = paragraphs.join('\n\n');
    fullText += (fullText ? '\n\n---\n\n' : '') + sectionText;

    sections.push({
      index: i,
      paragraphs,
      tables,
    });
  }

  // 배포용 문서이거나 본문 텍스트가 매우 짧고(더미 안내문) PrvText가 있는 경우 보강
  const isDummyNotice = fullText.includes('상위 버전의 배포용 문서') || fullText.trim().length === 0;
  if (isDummyNotice) {
    const prvStream = cfb.getStream('PrvText');
    if (prvStream && prvStream.length > 0) {
      const prvText = prvStream.toString('utf16le').replace(/\0.*$/, '').trim();
      if (prvText.length > 0) {
        const prvParagraphs = prvText.split(/\r?\n+/).map((p) => p.trim()).filter(Boolean);
        fullText = prvText;
        if (sections.length > 0) {
          sections[0].paragraphs = prvParagraphs;
        } else {
          sections.push({ index: 0, paragraphs: prvParagraphs, tables: [] });
        }
      }
    }
  }

  return {
    header,
    sections,
    fullText,
  };
}
