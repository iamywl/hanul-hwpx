#!/usr/bin/env node
/**
 * Hanul CLI Tool
 * 터미널에서 HWP/HWPX 문서를 열람, 검색, 마크다운 변환할 수 있는 독립형 도구입니다.
 */

import { openDocument } from './core/document.js';
import * as path from 'node:path';

function printHelp() {
  console.log(`
Hanul (한울) · Universal HWP/HWPX Engine

사용법:
  hanul <파일경로> [옵션]

옵션:
  -m, --markdown       마크다운 형식으로 출력 (표 서식 포함)
  -t, --tables         문서 내 표 데이터만 JSON 형식으로 출력
  -s, --search <단어>  특정 키워드가 포함된 문단 검색
  --info               문서 메타데이터 및 통계 정보 출력
  -h, --help           도움말 출력

예시:
  hanul sample.hwp
  hanul sample.hwpx --markdown
  hanul report.hwp --search "지원금"
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const filePath = args[0];
  const absPath = path.resolve(process.cwd(), filePath);

  try {
    const doc = openDocument(absPath);

    if (args.includes('--info')) {
      console.log(`[문서 정보]`);
      console.log(`- 파일명: ${path.basename(absPath)}`);
      console.log(`- 포맷: ${doc.format.toUpperCase()} (${doc.version})`);
      console.log(`- 문단 수: ${doc.paragraphs.length}`);
      console.log(`- 표 개수: ${doc.tables.length}`);
      return;
    }

    if (args.includes('-t') || args.includes('--tables')) {
      console.log(JSON.stringify(doc.tables, null, 2));
      return;
    }

    const searchIdx = args.findIndex((a) => a === '-s' || a === '--search');
    if (searchIdx !== -1 && args[searchIdx + 1]) {
      const keyword = args[searchIdx + 1].toLowerCase();
      const matches = doc.paragraphs.filter((p) => p.toLowerCase().includes(keyword));
      console.log(`총 ${matches.length}개의 문단이 검색되었습니다:\n`);
      matches.forEach((m, i) => console.log(`[${i + 1}] ${m}\n`));
      return;
    }

    if (args.includes('-m') || args.includes('--markdown')) {
      console.log(doc.toMarkdown());
      return;
    }

    // 기본: 전체 본문 텍스트 출력
    console.log(doc.fullText);
  } catch (err: any) {
    console.error(`❌ 한울 오류: ${err.message}`);
    process.exit(1);
  }
}

main();
