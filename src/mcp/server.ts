/**
 * Hanul MCP (Model Context Protocol) Server
 * AI 에이전트(Claude Desktop, Cursor, Antigravity 등)가
 * HWP 및 HWPX 문서를 직접 읽고 분석할 수 있도록 지원하는 표준 프로토콜 서버입니다.
 */

import * as readline from 'node:readline';
import { openDocument } from '../core/document.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

const TOOLS = [
  {
    name: 'hanul_read_document',
    description: 'HWP 5.x 또는 HWPX 문서의 전체 본문 텍스트와 마크다운 요약을 추출합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '분석할 HWP 또는 HWPX 파일의 절대 경로',
        },
        asMarkdown: {
          type: 'boolean',
          description: '마크다운 형식(표 포함)으로 반환할지 여부 (기본값: true)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_inspect_tables',
    description: 'HWP 또는 HWPX 문서 내의 모든 표 구조와 셀 데이터(2차원 배열)를 추출합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '분석할 HWP 또는 HWPX 파일의 절대 경로',
        },
        tableIndex: {
          type: 'integer',
          description: '특정 표의 인덱스 (0부터 시작, 생략 시 모든 표 반환)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_search_text',
    description: 'HWP 또는 HWPX 문서 내에서 특정 키워드를 검색하여 일치하는 문단들을 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '분석할 HWP 또는 HWPX 파일의 절대 경로',
        },
        keyword: {
          type: 'string',
          description: '검색할 키워드 또는 문구',
        },
      },
      required: ['filePath', 'keyword'],
    },
  },
];

export class HanulMcpServer {
  public start() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const req: JsonRpcRequest = JSON.parse(line);
        this.handleRequest(req);
      } catch (err: any) {
        this.sendError(null, -32700, `Parse error: ${err.message}`);
      }
    });

    process.stderr.write('Hanul MCP Server started on stdio\n');
  }

  private handleRequest(req: JsonRpcRequest) {
    const id = req.id !== undefined ? req.id : null;

    switch (req.method) {
      case 'initialize':
        this.sendResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'hanul-mcp',
            version: '0.1.0',
          },
        });
        break;

      case 'notifications/initialized':
        // no-op
        break;

      case 'tools/list':
        this.sendResult(id, { tools: TOOLS });
        break;

      case 'tools/call':
        this.handleToolCall(id, req.params);
        break;

      default:
        this.sendError(id, -32601, `Method not found: ${req.method}`);
        break;
    }
  }

  private handleToolCall(id: string | number | null, params: any) {
    if (!params || !params.name) {
      return this.sendError(id, -32602, 'Invalid params: name is required');
    }

    const { name, arguments: args } = params;

    try {
      if (name === 'hanul_read_document') {
        const doc = openDocument(args.filePath);
        const asMarkdown = args.asMarkdown !== false;
        const text = asMarkdown ? doc.toMarkdown() : doc.fullText;

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text,
            },
          ],
          metadata: {
            format: doc.format,
            version: doc.version,
            paragraphCount: doc.paragraphs.length,
            tableCount: doc.tables.length,
          },
        });
      }

      if (name === 'hanul_inspect_tables') {
        const doc = openDocument(args.filePath);
        let tables = doc.tables;

        if (typeof args.tableIndex === 'number') {
          const idx = args.tableIndex;
          if (idx < 0 || idx >= doc.tables.length) {
            return this.sendError(id, -32602, `tableIndex ${idx} 범위를 벗어났습니다. (총 ${doc.tables.length}개)`);
          }
          tables = [doc.tables[idx]];
        }

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tables, null, 2),
            },
          ],
          tableCount: doc.tables.length,
        });
      }

      if (name === 'hanul_search_text') {
        const doc = openDocument(args.filePath);
        const keyword = String(args.keyword || '').toLowerCase();
        const matches = doc.paragraphs
          .map((p, idx) => ({ paragraphIndex: idx, text: p }))
          .filter((item) => item.text.toLowerCase().includes(keyword));

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(matches, null, 2),
            },
          ],
          totalMatches: matches.length,
        });
      }

      return this.sendError(id, -32601, `Unknown tool: ${name}`);
    } catch (err: any) {
      return this.sendResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: `한글 문서 처리 중 오류 발생: ${err.message}`,
          },
        ],
      });
    }
  }

  private sendResult(id: string | number | null, result: any) {
    const res: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    process.stdout.write(JSON.stringify(res) + '\n');
  }

  private sendError(id: string | number | null, code: number, message: string, data?: any) {
    const res: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    process.stdout.write(JSON.stringify(res) + '\n');
  }
}

// 직접 실행 시 서버 시작
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('mcp.mjs')) {
  const server = new HanulMcpServer();
  server.start();
}
