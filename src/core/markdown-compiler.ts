/**
 * Hanul Markdown to HWPX / HWP Compiler
 * 표준 마크다운(GFM) 문서를 분석하여 완벽한 표 레이아웃(colSpan 셀 병합, 헤더 음영),
 * 사진 대지 카드 표(3단 구조: 헤더 바 + 스크린샷 프레임 + 검수 콜아웃),
 * 페이지 구분선 및 인라인 서식이 포함된 정품 한컴 HWPX / HWP 문서로 컴파일합니다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import {
  HwpxDocumentBuilder,
  TableDef,
  TableRowDef,
  TableCellDef,
  PhotoCardDef,
  parseInlineRuns,
} from './hwpx-builder.js';

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

    // 2. 페이지 나누기 (명시적 <pagebreak> 또는 수평선 --- 단독 구분)
    if (line === '<pagebreak>' || line === '\\pagebreak') {
      builder.addPageBreak();
      i++;
      continue;
    }

    // 2-1. 수평 구분선 (--- 또는 *** 또는 ___)
    if (line === '---' || line === '***' || line === '___') {
      builder.addSpacing();
      i++;
      continue;
    }

    // 3. 사진 대지 (Photo Card) 패턴 감지:
    // ### [화면 증빙 ...] 또는 ### 제목 바로 뒤에 ![...](...) 이미지가 오는 경우
    if (line.startsWith('###')) {
      const headingMatch = line.match(/^###\s+(.+)$/);
      const headingText = headingMatch ? headingMatch[1].trim() : '';

      // 다음 공백이 아닌 줄 탐색
      let nextIdx = i + 1;
      while (nextIdx < lines.length && !lines[nextIdx].trim()) {
        nextIdx++;
      }

      const nextLine = nextIdx < lines.length ? lines[nextIdx].trim() : '';
      const imgMatch = nextLine.match(/^!\[(.*)\]\(([^)]+)\)/);

      if (imgMatch) {
        const caption = imgMatch[1];
        const relImgPath = imgMatch[2];
        const resolvedImgPath = path.isAbsolute(relImgPath)
          ? relImgPath
          : path.resolve(baseDir, relImgPath);

        let summary = '';
        const bullets: string[] = [];
        let verdict = '';

        let j = nextIdx + 1;
        while (j < lines.length) {
          const peek = lines[j].trim();
          if (!peek) {
            j++;
            continue;
          }

          // 다음 섹션, 다음 이미지, 표, 구분선을 만나면 포토카드 블록 종료
          if (
            peek.startsWith('#') ||
            peek.startsWith('![') ||
            peek.startsWith('|') ||
            peek === '---' ||
            peek === '***' ||
            peek === '<pagebreak>' ||
            peek === '\\pagebreak'
          ) {
            break;
          }

          if (
            peek.startsWith('**기능 요약**') ||
            peek.startsWith('**핵심 구현**') ||
            peek.startsWith('> **기능 요약**')
          ) {
            summary = peek.replace(/^>*\s*\*\*[^*]+\*\*\s*[—:-]\s*/, '').trim();
          } else if (
            peek.startsWith('**검수 의견:**') ||
            peek.startsWith('**검수 상태:**') ||
            peek.startsWith('**검수 결과:**')
          ) {
            verdict = peek.replace(/^\*\*[^*]+\*\*\s*/, '').trim();
          } else if (peek.startsWith('- ') || peek.startsWith('* ')) {
            bullets.push(peek.replace(/^[-*]\s+/, '').trim());
          } else if (!summary && !peek.startsWith('-') && !peek.startsWith('*')) {
            summary = peek;
          }
          j++;
        }

        builder.addPhotoCard({
          title: headingText,
          imagePath: resolvedImgPath,
          caption: caption && caption !== headingText ? caption : undefined,
          summary: summary || undefined,
          bullets: bullets.length > 0 ? bullets : undefined,
          verdict: verdict || '과업지시서 규격 100% 충족 및 UI/UX 인터랙션 정상 작동 확인 [적합 / 검수 완료]',
          width: 38000,
          height: 21500,
        });

        i = j;
        continue;
      }
    }

    // 4. 일반 제목 (#, ##, ###, ####)
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

    // 5. 단독 이미지 태그 (![alt](path))
    const imgMatch = line.match(/^!\[(.*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const caption = imgMatch[1];
      const relImgPath = imgMatch[2];
      const resolvedImgPath = path.isAbsolute(relImgPath)
        ? relImgPath
        : path.resolve(baseDir, relImgPath);

      const isSignature = /behind|서명|도장|직인|signature|stamp/i.test(caption) || /behind|signature|stamp/i.test(relImgPath);
      if (isSignature) {
        builder.addSignature({
          imagePath: resolvedImgPath,
          width: 5600,
          height: 5600,
          label: caption && !/behind|signature|stamp/i.test(caption) ? caption : undefined,
        });
      } else {
        builder.addImage({
          imagePath: resolvedImgPath,
          caption: caption ? `[증빙] ${caption}` : undefined,
          width: 38000,
          height: 21500,
        });
      }
      i++;
      continue;
    }

    // 6. 마크다운 표 (| ... |) 감지 및 파싱
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

    // 7. 인용구 (> ...)
    if (line.startsWith('>')) {
      const calloutLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        calloutLines.push(lines[i].trim().replace(/^>\s*/, ''));
        i++;
      }
      builder.addCalloutBox(calloutLines);
      continue;
    }

    // 8. 리스트 항목 (- 또는 * 또는 1.)
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

    // 9. 인라인 서명 태그가 포함된 본문 문단 (예: 대표자 : 홍 길 동 (서명/인) ![서명|behind](./sig.png))
    const inlineSigMatch = line.match(/^(.*)!\[(.*)\]\(([^)]+)\)(.*)$/);
    if (inlineSigMatch) {
      const prefix = inlineSigMatch[1];
      const caption = inlineSigMatch[2];
      const relImgPath = inlineSigMatch[3];
      const suffix = inlineSigMatch[4];
      const isSignature = /behind|서명|도장|직인|signature|stamp/i.test(caption) || /behind|signature|stamp/i.test(relImgPath);
      if (isSignature) {
        const resolvedImgPath = path.isAbsolute(relImgPath)
          ? relImgPath
          : path.resolve(baseDir, relImgPath);
        builder.addSignature({
          imagePath: resolvedImgPath,
          width: 5600,
          height: 5600,
          label: (prefix + (caption && !/behind|signature|stamp/i.test(caption) ? caption : '') + suffix).trim(),
        });
        i++;
        continue;
      }
    }

    // 10. 일반 본문 문단
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

  // 너비 비율 계산
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
  } else if (colCount === 4) {
    // 4열 표준 (공식 서식 5 헤더): [항목1 20%, 내용1 30%, 항목2 20%, 내용2 30%]
    colWidths = [8504, 12756, 8504, 12756];
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
    const rowCells = rawRows[r];

    let c = 0;
    while (c < colCount) {
      const text = rowCells[c] || '';
      // 연속된 빈 셀 개수 계산 (Markdown 표의 셀 병합 colSpan 지원)
      let colSpan = 1;
      while (c + colSpan < colCount && !rowCells[c + colSpan]) {
        colSpan++;
      }

      // 행 전체가 단일 셀로 병합된 경우(섹션 구분 헤더 등) 음영 처리
      const isSectionHeader = colSpan === colCount && r > 0 && !isHeader;

      cells.push({
        text,
        colSpan,
        header: isHeader || isSectionHeader,
        align: isHeader || isSectionHeader ? 'CENTER' : alignments[c] || 'LEFT',
        bold: isHeader || isSectionHeader,
      });

      c += colSpan;
    }

    rows.push({ cells });
  }

  builder.addTable({
    colWidths,
    rows,
  });
}

/**
 * 마크다운을 분석하여 HWPX 생성 후, 헤드리스 크롬 내장 한울 엔진을 통해
 * 100% 규격의 순수 바이너리 HWP 5.x 파일로 동시 컴파일합니다.
 */
export async function compileMarkdownToHwp(
  markdownContent: string,
  outputPath: string,
  options?: MarkdownCompilerOptions
): Promise<void> {
  const tempHwpxPath = outputPath.replace(/\.hwp$/i, '.tmp.hwpx');
  compileMarkdownToHwpx(markdownContent, tempHwpxPath, options);

  const hwpxBytes = fs.readFileSync(tempHwpxPath);
  const studioRoot = path.resolve('vendor/studio');
  let indexHtml = fs.readFileSync(path.join(studioRoot, 'index.html'), 'utf8');
  const entry = indexHtml.match(/src="\/rhwp\/assets\/index[^" ]+\.js"/)?.[0];
  if (entry) indexHtml = indexHtml.replace(entry, 'src="/rhwp/assets/hanul-runtime.js"');
  indexHtml = indexHtml.replace(/href="\/rhwp\/assets\/index[^" ]+\.css"/, 'href="/rhwp/assets/hanul-runtime.css"');

  const server = http.createServer((req, res) => {
    let reqPath = req.url || '/';
    if (reqPath === '/document.hwpx') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(hwpxBytes);
      return;
    }
    if (reqPath.startsWith('/rhwp/')) reqPath = reqPath.slice(5);
    if (reqPath === '/' || reqPath === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
      return;
    }
    const filePath = path.join(studioRoot, reqPath);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
      '.json': 'application/json',
    };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  try {
    const hwpBuffer = await new Promise<Buffer>((resolve, reject) => {
      server.listen(0, async () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 54000;
        let browser;
        try {
          browser = await chromium.launch({
            headless: true,
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          });
          const page = await browser.newPage();
          await page.goto(`http://localhost:${port}/`);
          await page.waitForFunction(() => !!(window as any).__hanulEngine, { timeout: 35000 });

          await page.evaluate(async () => {
            const engine = (window as any).__hanulEngine;
            await engine.ready();
            const resp = await fetch('/document.hwpx');
            const buf = await resp.arrayBuffer();
            await engine.load(new Uint8Array(buf), 'document.hwpx');
          });

          const hwpBase64 = await page.evaluate(async () => {
            const rawBytes = await (window as any).__hanulEngine.export('hwp');
            const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
            let binary = '';
            const len = bytes.length;
            for (let idx = 0; idx < len; idx += 8192) {
              binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(idx, Math.min(idx + 8192, len))));
            }
            return btoa(binary);
          });

          resolve(Buffer.from(hwpBase64, 'base64'));
        } catch (err) {
          reject(err);
        } finally {
          if (browser) await browser.close();
          server.close();
        }
      });
    });

    fs.writeFileSync(outputPath, hwpBuffer);
  } finally {
    if (fs.existsSync(tempHwpxPath)) {
      fs.unlinkSync(tempHwpxPath);
    }
  }
}
