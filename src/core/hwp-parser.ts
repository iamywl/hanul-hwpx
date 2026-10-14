/**
 * HWP 5.x 고수준 파서
 * CompoundFile + RecordParser를 결합하여 문서의 본문 텍스트, 문단, 표 데이터를 추출합니다.
 * 배포용 문서(Distribution Document) 및 일반 문서 모두 지원합니다.
 */

import { CompoundFile, DirectoryEntry } from './cfbf.js';
import { parseFileHeader, decompressStream, parseRecords, HWP_TAG, HwpFileHeader } from './hwp-record.js';

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

  // 2. BodyText 하위의 Section* 스트림 탐색
  const entries = cfb.listEntries();
  const sectionEntries: DirectoryEntry[] = [];

  for (const entry of entries) {
    const isSection = /section\d+$/i.test(entry.name) || /bodytext\/section\d+$/i.test(entry.path);
    const isBodyText = entry.path.toLowerCase().includes('bodytext') || !entry.path.toLowerCase().includes('viewtext');

    if (entry.type === 2 && isSection && isBodyText) {
      if (!sectionEntries.some((e) => e.id === entry.id)) {
        sectionEntries.push(entry);
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

    if (header.flags.compressed) {
      stream = decompressStream(stream);
    }

    const records = parseRecords(stream);
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
  if ((header.flags.distribution || isDummyNotice)) {
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
