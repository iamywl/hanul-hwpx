/**
 * HWPX (KS X 6101 / OWPML) 파서
 * ZIP 패키지 내부의 Contents/section*.xml을 파싱하여 본문 텍스트와 표를 추출합니다.
 */

import * as fflate from 'fflate';
import { ParsedTable } from './hwp-parser.js';

export interface ParsedHwpxDocument {
  version: string;
  sections: {
    index: number;
    paragraphs: string[];
    tables: ParsedTable[];
  }[];
  fullText: string;
}

/**
 * HWPX 버퍼 파싱
 */
export function parseHwpxBuffer(buffer: Buffer): ParsedHwpxDocument {
  // fflate로 zip 압축 해제
  const unzipped = fflate.unzipSync(new Uint8Array(buffer));

  // section*.xml 파일들 탐색
  const sectionFiles = Object.keys(unzipped)
    .filter((k) => /Contents\/section\d+\.xml$/i.test(k) || /section\d+\.xml$/i.test(k))
    .sort();

  const sections: ParsedHwpxDocument['sections'] = [];
  let fullText = '';

  for (let i = 0; i < sectionFiles.length; i++) {
    const filename = sectionFiles[i];
    const xmlBytes = unzipped[filename];
    const xml = new TextDecoder('utf-8').decode(xmlBytes);

    const paragraphs: string[] = [];
    const tables: ParsedTable[] = [];

    // 1. 표 (<hp:tbl> ... </hp:tbl>) 추출
    const tableRegex = /<hp:tbl\b[^>]*>([\s\S]*?)<\/hp:tbl>/gi;
    let tableMatch: RegExpExecArray | null;

    while ((tableMatch = tableRegex.exec(xml)) !== null) {
      const tableXml = tableMatch[1];
      const rows: string[][] = [];

      // 각 행 (<hp:tr> ... </hp:tr>)
      const trRegex = /<hp:tr\b[^>]*>([\s\S]*?)<\/hp:tr>/gi;
      let trMatch: RegExpExecArray | null;

      while ((trMatch = trRegex.exec(tableXml)) !== null) {
        const rowXml = trMatch[1];
        const cells: string[] = [];

        // 각 셀 (<hp:tc> ... </hp:tc>)
        const tcRegex = /<hp:tc\b[^>]*>([\s\S]*?)<\/hp:tc>/gi;
        let tcMatch: RegExpExecArray | null;

        while ((tcMatch = tcRegex.exec(rowXml)) !== null) {
          const cellXml = tcMatch[1];
          // 셀 내부 텍스트 (<hp:t> ... </hp:t>) 추출
          const textMatches = cellXml.match(/<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>/gi) || [];
          const cellText = textMatches
            .map((t) => t.replace(/<[^>]+>/g, '').trim())
            .filter(Boolean)
            .join(' ');
          cells.push(cellText);
        }

        if (cells.length > 0) {
          rows.push(cells);
        }
      }

      if (rows.length > 0) {
        tables.push({
          rows: rows.length,
          cols: rows[0].length,
          cells: rows,
        });
      }
    }

    // 2. 일반 문단 (<hp:p> ... </hp:p>) 추출
    // (표 내부가 아닌 최상위 문단 중심)
    const pRegex = /<hp:p\b[^>]*>([\s\S]*?)<\/hp:p>/gi;
    let pMatch: RegExpExecArray | null;

    while ((pMatch = pRegex.exec(xml)) !== null) {
      const pXml = pMatch[1];
      // <hp:t> 태그 안의 텍스트 추출
      const textMatches = pXml.match(/<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>/gi) || [];
      const pText = textMatches
        .map((t) => t.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join(' ');

      if (pText.length > 0) {
        paragraphs.push(pText);
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

  return {
    version: 'KS X 6101 HWPX',
    sections,
    fullText,
  };
}
