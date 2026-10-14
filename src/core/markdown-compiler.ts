/**
 * Hanul Markdown to HWPX Compiler
 * 표준 마크다운(GFM) 문서를 분석하여 완벽한 표 레이아웃, 셀 서식,
 * 페이지 구분선 및 스크린샷 이미지가 포함된 HWPX 문서로 컴파일합니다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HwpxDocumentBuilder, TableDef, TableRowDef, TableCellDef } from './hwpx-builder.js';

export interface MarkdownCompilerOptions {
  baseDir?: string;
  templatePath?: string;
}

export function compileMarkdownToHwpx(
  markdownContent: string,
  outputPath: string,
  options?: MarkdownCompilerOptions
): void {
  const baseDir = options?.baseDir || path.dirname(outputPath);
  const builder = new HwpxDocumentBuilder(options?.templatePath);

  const lines = markdownContent.split('\n');
  let i = 0;
  let isFirstHeading = true;

  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // 1. 빈 줄
    if (!line) {
      i++;
      continue;
    }

    // 2. 페이지 나누기 (--- 또는 <pagebreak>)
    if (line === '---' || line === '<pagebreak>' || line === '\\pagebreak') {
      builder.addPageBreak();
      i++;
      continue;
    }

    // 3. 제목 (#, ##, ###, ####)
    if (line.startsWith('#')) {
      const match = line.match(/^(#{1,4})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        const text = match[2].trim();

        if (level === 1) {
          if (isFirstHeading) {
            builder.addTitle(text);
            isFirstHeading = false;
          } else {
            builder.addHeading(text, 1);
          }
        } else if (level === 2) {
          builder.addHeading(text, 1);
        } else if (level === 3) {
          builder.addHeading(text, 2);
        } else {
          builder.addHeading(text, 3);
        }
        i++;
        continue;
      }
    }

    // 4. 이미지 태그 (![alt](path))
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const caption = imgMatch[1];
      const relImgPath = imgMatch[2];
      const resolvedImgPath = path.isAbsolute(relImgPath)
        ? relImgPath
        : path.resolve(baseDir, relImgPath);

      builder.addImage({
        imagePath: resolvedImgPath,
        caption: caption ? `[증빙] ${caption}` : undefined,
        width: 38000,
        height: 22000,
      });
      i++;
      continue;
    }

    // 5. 마크다운 표 (| ... |) 감지 및 파싱
    if (line.startsWith('|') && line.endsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        parseAndAddTable(builder, tableLines);
      }
      continue;
    }

    // 6. 인용구 (> ...)
    if (line.startsWith('>')) {
      const calloutLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        calloutLines.push(lines[i].trim().replace(/^>\s*/, ''));
        i++;
      }
      builder.addCalloutBox(calloutLines);
      continue;
    }

    // 7. 리스트 항목 (- 또는 * 또는 1.)
    if (line.match(/^[-*]\s+(.+)$/)) {
      const bulletText = line.replace(/^[-*]\s+/, '◦ ');
      builder.addParagraph(bulletText, { align: 'LEFT' });
      i++;
      continue;
    }
    if (line.match(/^\d+\.\s+(.+)$/)) {
      builder.addParagraph(line, { align: 'LEFT' });
      i++;
      continue;
    }

    // 8. 일반 본문 문단
    builder.addParagraph(line, { align: 'LEFT' });
    i++;
  }

  builder.saveToFile(outputPath);
}

function parseAndAddTable(builder: HwpxDocumentBuilder, tableLines: string[]): void {
  // 행 분리
  const rawRows: string[][] = [];
  let alignRow: string[] = [];

  for (let idx = 0; idx < tableLines.length; idx++) {
    const raw = tableLines[idx];
    const cells = raw
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim().replace(/<br\s*\/?>/gi, '\n'));

    // 구분선 행 (| :--- | :---: | ---: |)
    if (idx === 1 && cells.every((c) => /^:?-+:?$/.test(c))) {
      alignRow = cells;
      continue;
    }
    rawRows.push(cells);
  }

  if (rawRows.length === 0) return;

  const colCount = Math.max(...rawRows.map((r) => r.length));
  const alignments: ('LEFT' | 'CENTER' | 'RIGHT')[] = [];

  for (let c = 0; c < colCount; c++) {
    const spec = alignRow[c] || '';
    if (spec.startsWith(':') && spec.endsWith(':')) {
      alignments.push('CENTER');
    } else if (spec.endsWith(':')) {
      alignments.push('RIGHT');
    } else {
      alignments.push('LEFT');
    }
  }

  // 컬럼별 내용 길이 분석을 통한 최적 너비 분배
  const totalWidth = 42520;
  const colLengths: number[] = Array(colCount).fill(0);

  for (const r of rawRows) {
    for (let c = 0; c < colCount; c++) {
      const len = (r[c] || '').length;
      if (len > colLengths[c]) colLengths[c] = len;
    }
  }

  // 너비 비율 계산 (최소 4500 보장)
  let sumWeight = 0;
  const weights = colLengths.map((l) => {
    const w = Math.max(10, Math.min(l, 80));
    sumWeight += w;
    return w;
  });

  let colWidths: number[];
  if (colCount === 2) {
    // 2열 표준: [항목 25%, 내용 75%]
    colWidths = [10630, 31890];
  } else if (colCount === 5) {
    // 5열 표준 (지출/견적/검수): [구분 15%, 항목 18%, 산출내역 41%, 금액 13%, 비고 13%]
    colWidths = [6378, 7653, 17433, 5528, 5528];
  } else if (colCount === 6) {
    // 6열 표준 (팀원/품목): [이름 14%, 소속 22%, 학번 15%, 연락처 18%, 이메일 21%, 동의 10%]
    colWidths = [5952, 9354, 6378, 7653, 8929, 4254];
  } else {
    colWidths = weights.map((w) => Math.floor((w / sumWeight) * totalWidth));
    const assigned = colWidths.reduce((a, b) => a + b, 0);
    colWidths[colCount - 1] += totalWidth - assigned;
  }

  const rows: TableRowDef[] = [];

  for (let r = 0; r < rawRows.length; r++) {
    const isHeader = r === 0;
    const cells: TableCellDef[] = [];

    for (let c = 0; c < colCount; c++) {
      const cellText = rawRows[r][c] || '';
      cells.push({
        text: cellText,
        header: isHeader,
        align: isHeader ? 'CENTER' : alignments[c] || 'LEFT',
        bold: isHeader,
      });
    }

    rows.push({ cells });
  }

  builder.addTable({
    colWidths,
    rows,
  });
}
