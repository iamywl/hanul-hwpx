/**
 * Hanul 통합 문서 인터페이스
 * HWP와 HWPX 포맷을 자동 감지하여 일관된 문서 모델과 마크다운 출력을 제공합니다.
 */

import * as fs from 'node:fs';
import { parseHwpBuffer, ParsedHwpDocument, ParsedTable } from './hwp-parser.js';
import { parseHwpxBuffer, ParsedHwpxDocument } from './hwpx-parser.js';
import { CompoundFile } from './cfbf.js';
import { parseRecords, decompressStream } from './hwp-record.js';

export { CompoundFile, parseRecords, decompressStream, parseHwpBuffer, parseHwpxBuffer };

export interface UnifiedDocument {
  format: 'hwp' | 'hwpx';
  version: string;
  fullText: string;
  paragraphs: string[];
  tables: ParsedTable[];
  toMarkdown(): string;
}

/**
 * 2D 셀 배열을 마크다운 표 문법으로 변환
 */
function tableToMarkdown(table: ParsedTable): string {
  if (table.cells.length === 0 || table.cells[0].length === 0) return '';
  const rows = table.cells;
  const colCount = Math.max(...rows.map((r) => r.length));

  let md = '';
  // 헤더 행
  const header = rows[0];
  md += '| ' + Array.from({ length: colCount }, (_, i) => header[i] || '').join(' | ') + ' |\n';
  md += '| ' + Array.from({ length: colCount }, () => '---').join(' | ') + ' |\n';

  // 본문 행들
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    md += '| ' + Array.from({ length: colCount }, (_, i) => (row[i] || '').replace(/\|/g, '\\|')).join(' | ') + ' |\n';
  }

  return md;
}

/**
 * 파일 경로에서 문서를 읽고 통합 모델로 반환
 */
export function openDocument(filePath: string): UnifiedDocument {
  const buffer = fs.readFileSync(filePath);
  return parseDocumentBuffer(buffer);
}

/**
 * 바이너리 버퍼에서 문서를 자동 판별하여 파싱
 */
export function parseDocumentBuffer(buffer: Buffer): UnifiedDocument {
  // 1. HWP 5.x CFBF Magic 감지 (D0 CF 11 E0)
  if (buffer.length >= 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    const parsed = parseHwpBuffer(buffer);
    const paragraphs: string[] = [];
    const tables: ParsedTable[] = [];

    for (const sec of parsed.sections) {
      paragraphs.push(...sec.paragraphs);
      tables.push(...sec.tables);
    }

    const ver = `${parsed.header.version.major}.${parsed.header.version.minor}.${parsed.header.version.build}`;

    return {
      format: 'hwp',
      version: `HWP ${ver}`,
      fullText: parsed.fullText,
      paragraphs,
      tables,
      toMarkdown(): string {
        let md = `# HWP 문서 (v${ver})\n\n`;
        md += parsed.fullText;
        if (tables.length > 0) {
          md += '\n\n## 포함된 표 목록\n\n';
          for (let i = 0; i < tables.length; i++) {
            md += `### 표 ${i + 1} (${tables[i].rows}행 x ${tables[i].cols}열)\n\n`;
            md += tableToMarkdown(tables[i]) + '\n\n';
          }
        }
        return md;
      },
    };
  }

  // 2. HWPX ZIP Magic 감지 (50 4B 03 04 또는 50 4B 05 06)
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const parsed = parseHwpxBuffer(buffer);
    const paragraphs: string[] = [];
    const tables: ParsedTable[] = [];

    for (const sec of parsed.sections) {
      paragraphs.push(...sec.paragraphs);
      tables.push(...sec.tables);
    }

    return {
      format: 'hwpx',
      version: parsed.version,
      fullText: parsed.fullText,
      paragraphs,
      tables,
      toMarkdown(): string {
        let md = `# HWPX 문서 (${parsed.version})\n\n`;
        md += parsed.fullText;
        if (tables.length > 0) {
          md += '\n\n## 포함된 표 목록\n\n';
          for (let i = 0; i < tables.length; i++) {
            md += `### 표 ${i + 1} (${tables[i].rows}행 x ${tables[i].cols}열)\n\n`;
            md += tableToMarkdown(tables[i]) + '\n\n';
          }
        }
        return md;
      },
    };
  }

  throw new Error('지원하지 않는 문서 형식입니다. (HWP 5.x 또는 HWPX 파일이어야 합니다)');
}
