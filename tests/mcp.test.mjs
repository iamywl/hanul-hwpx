import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { openDocument } from '../dist/core.mjs';

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
      buffer = lines.pop(); // keep remainder
      for (const line of lines) {
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line));
          } catch (e) {
            console.error('JSON parse error from MCP:', line);
          }
        }
      }
    });

    child.stderr.on('data', () => {});

    child.on('close', () => {
      if (buffer.trim()) {
        try {
          responses.push(JSON.parse(buffer));
        } catch {}
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

test('MCP: tools/list는 10개 도구를 모두 제공해야 합니다', async () => {
  const responses = await callMcp([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  ]);

  assert.equal(responses.length, 1);
  const tools = responses[0].result.tools;
  assert.equal(tools.length, 10);
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes('hanul_read_document'));
  assert.ok(toolNames.includes('hanul_inspect_tables'));
  assert.ok(toolNames.includes('hanul_search_text'));
  assert.ok(toolNames.includes('hanul_get_document_info'));
  assert.ok(toolNames.includes('hanul_extract_images'));
  assert.ok(toolNames.includes('hanul_unlock_document'));
  assert.ok(toolNames.includes('hanul_convert_document'));
  assert.ok(toolNames.includes('hanul_create_document'));
  assert.ok(toolNames.includes('hanul_markdown_to_hwpx'));
  assert.ok(toolNames.includes('hanul_create_styled_document'));
});

test('MCP: hanul_read_document로 본문 및 마크다운 추출 검증', async () => {
  const filePath = path.resolve('tests/fixtures/contests/notice.hwpx');
  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'hanul_read_document',
        arguments: { filePath, asMarkdown: true },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const res = responses[0].result;
  assert.ok(res.content[0].text.length > 500);
  assert.equal(res.metadata.format, 'hwpx');
});

test('MCP: hanul_inspect_tables로 표 구조 추출 검증', async () => {
  const filePath = path.resolve('tests/fixtures/samples/sample-5017.hwp');
  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'hanul_inspect_tables',
        arguments: { filePath },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const tables = JSON.parse(responses[0].result.content[0].text);
  assert.ok(Array.isArray(tables) && tables.length >= 2);
  assert.ok(tables[0].rows > 0 && tables[0].cols > 0);
});

test('MCP: hanul_search_text로 키워드 검색 검증', async () => {
  const filePath = path.resolve('tests/fixtures/contests/notice.hwpx');
  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'hanul_search_text',
        arguments: { filePath, keyword: '공모' },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const matches = JSON.parse(responses[0].result.content[0].text);
  assert.ok(Array.isArray(matches) && matches.length > 0);
  assert.ok(matches[0].text.includes('공모'));
});

test('MCP: hanul_get_document_info로 메타데이터 및 배포용 문서 감지 검증', async () => {
  const distFile = path.resolve('tests/fixtures/[공고] 2022년 예비창업패키지 예비창업자 모집공고.hwp');
  const normalFile = path.resolve('tests/fixtures/samples/sample-5017.hwp');

  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'hanul_get_document_info',
        arguments: { filePath: distFile },
      },
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'hanul_get_document_info',
        arguments: { filePath: normalFile },
      },
    },
  ]);

  assert.equal(responses.length, 2);
  const distInfo = responses[0].result.metadata;
  assert.equal(distInfo.format, 'hwp');
  assert.equal(distInfo.flags.distribution, true);
  assert.ok(distInfo.paragraphCount > 1000);
  assert.ok(distInfo.tableCount >= 40);

  const normalInfo = responses[1].result.metadata;
  assert.equal(normalInfo.format, 'hwp');
  assert.equal(normalInfo.flags.distribution, false);
});

test('MCP: hanul_extract_images로 임베디드 이미지 추출 검증', async () => {
  const filePath = path.resolve('tests/fixtures/붙임 1. 「The Pattern 2026 콘테스트  오픈소스 패션 모델링 어워드」 모집공고.hwp');
  const tempDir = path.resolve('.preview/mcp-images-test');

  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'hanul_extract_images',
        arguments: { filePath, outputDir: tempDir },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const res = responses[0].result;
  assert.ok(res.totalImages >= 5, '최소 5개 이상의 이미지가 추출되어야 합니다.');
  assert.ok(fs.existsSync(tempDir));
  const files = fs.readdirSync(tempDir);
  assert.ok(files.length >= 5);
});

test('MCP: hanul_unlock_document로 배포용 문서 복호화 및 저장 검증', async () => {
  const filePath = path.resolve('tests/fixtures/[공고] 2022년 예비창업패키지 예비창업자 모집공고.hwp');
  const outMd = path.resolve('.preview/unlocked-mcp.md');

  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'hanul_unlock_document',
        arguments: { filePath, outputPath: outMd },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const res = responses[0].result;
  assert.ok(res.metadata.tableCount >= 40);
  assert.ok(fs.existsSync(outMd));
  const savedContent = fs.readFileSync(outMd, 'utf8');
  assert.ok(savedContent.includes('중소벤처기업부'));
  assert.ok(savedContent.includes('|'));
});

test('MCP: hanul_convert_document로 Markdown 및 JSON 변환 검증', async () => {
  const filePath = path.resolve('tests/fixtures/samples/sample-5017.hwp');

  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'hanul_convert_document',
        arguments: { filePath, targetFormat: 'json' },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const res = responses[0].result;
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.format, 'hwp');
  assert.ok(parsed.paragraphs.length > 0);
  assert.ok(parsed.tables.length > 0);
});

test('MCP: hanul_create_document로 새 HWPX 문서 생성 및 검증', async () => {
  const outHwpx = path.resolve('.preview/created-by-mcp.hwpx');

  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'hanul_create_document',
        arguments: {
          outputPath: outHwpx,
          title: 'AI 에이전트 생성 보고서',
          paragraphs: [
            '본 문서는 Hanul MCP 서버를 통해 인공지능 에이전트가 자동 생성한 문서입니다.',
            'HWP 및 HWPX 표준 규격을 100% 준수합니다.',
          ],
          tables: [
            {
              rows: [
                ['항목', '상태', '비고'],
                ['MCP 프로토콜 연동', '100% 완료', '표준 입출력'],
                ['위지윅 편집기', '복원 완료', '타이핑 및 저장'],
              ],
            },
          ],
        },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const res = responses[0].result;
  assert.equal(res.success, true);
  assert.ok(fs.existsSync(outHwpx));

  // 생성된 HWPX 문서를 다시 열어서 검증
  const doc = openDocument(outHwpx);
  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.fullText.includes('AI 에이전트 생성 보고서'));
  assert.ok(doc.fullText.includes('MCP 프로토콜 연동'));
  assert.equal(doc.tables.length, 1);
  assert.equal(doc.tables[0].rows, 3);
  assert.equal(doc.tables[0].cols, 3);
});

test('MCP: hanul_markdown_to_hwpx로 마크다운을 HWPX로 컴파일 검증', async () => {
  const outHwpx = path.resolve('dist/test_md_compiled.hwpx');
  if (fs.existsSync(outHwpx)) fs.unlinkSync(outHwpx);

  const md = `# 과업지시서\n\n## 1. 개요\n본 과업은 플랫폼 개발입니다.\n\n| 구분 | 항목 | 내용 |\n| :--- | :---: | ---: |\n| 1 | 프론트엔드 | Next.js 15 |\n| 2 | 백엔드 | NestJS 11 |\n`;

  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'hanul_markdown_to_hwpx',
        arguments: {
          markdownContent: md,
          outputPath: outHwpx,
        },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const res = responses[0].result;
  assert.equal(res.success, true);
  assert.ok(fs.existsSync(outHwpx));

  const doc = openDocument(outHwpx);
  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.fullText.includes('과업지시서'));
  assert.ok(doc.fullText.includes('Next.js 15'));
  assert.equal(doc.tables.length, 1);
  assert.equal(doc.tables[0].rows, 3);
});

test('MCP: hanul_create_styled_document로 고급 서식 HWPX 생성 검증', async () => {
  const outHwpx = path.resolve('dist/test_styled.hwpx');
  if (fs.existsSync(outHwpx)) fs.unlinkSync(outHwpx);

  const responses = await callMcp([
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'hanul_create_styled_document',
        arguments: {
          outputPath: outHwpx,
          title: '창업동아리 활동계획서',
          subtitle: 'StudyBridge 플랫폼 개발 계획',
          sections: [
            {
              heading: '1. 동아리 개요',
              level: 1,
              paragraphs: ['동아리 소개 문단입니다.'],
              table: {
                colWidths: [10000, 32520],
                rows: [
                  {
                    cells: [
                      { text: '동아리명', header: true },
                      { text: 'StudyBridge', align: 'LEFT' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    },
  ]);

  assert.equal(responses.length, 1);
  const res = responses[0].result;
  assert.equal(res.success, true);
  assert.ok(fs.existsSync(outHwpx));

  const doc = openDocument(outHwpx);
  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.fullText.includes('창업동아리 활동계획서'));
  assert.ok(doc.fullText.includes('StudyBridge'));
});
