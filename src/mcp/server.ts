/**
 * Hanul MCP (Model Context Protocol) Server
 * AI 에이전트(Claude Desktop, Cursor, Antigravity 등)가
 * HWP 및 HWPX 문서를 1:1로 직접 검사, 분석, 복호화, 변환 및 생성할 수 있도록 지원하는 표준 프로토콜 서버입니다.
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { openDocument, parseDocumentBuffer } from '../core/document.js';
import { CompoundFile } from '../core/cfbf.js';
import { parseFileHeader } from '../core/hwp-record.js';
import { validateBytes } from '../storage.js';

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

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function detectImageMime(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString() === 'GIF89a' || buf.subarray(0, 6).toString() === 'GIF87a')) {
    return 'image/gif';
  }
  return 'application/octet-stream';
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
  {
    name: 'hanul_get_document_info',
    description: 'HWP 5.x 또는 HWPX 문서의 메타데이터(포맷, 버전, 배포용 문서 여부, 압축/암호화 플래그, 문단/표/이미지 통계, 파일 크기)를 상세 분석합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '분석할 HWP 또는 HWPX 파일의 절대 경로',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_extract_images',
    description: 'HWP 또는 HWPX 문서 내에 임베디드된 그림(BinData) 파일들을 목록화하고 디스크에 저장하거나 Base64 데이터로 추출합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '분석할 HWP 또는 HWPX 파일의 절대 경로',
        },
        outputDir: {
          type: 'string',
          description: '이미지 파일들을 저장할 출력 디렉토리 경로 (생략 시 파일 저장은 건너뜀)',
        },
        includeBase64: {
          type: 'boolean',
          description: '반환 결과에 Base64 데이터 URI를 포함할지 여부 (기본값: false)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_unlock_document',
    description: '한컴 배포용 문서(ViewText 암호화)를 복호화하여 편집 가능한 일반 텍스트 또는 마크다운 파일로 승격 해제합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '잠금을 해제할 배포용 HWP 파일 경로',
        },
        outputPath: {
          type: 'string',
          description: '복호화된 마크다운 또는 텍스트를 저장할 파일 경로 (선택)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_convert_document',
    description: 'HWP 또는 HWPX 문서를 Markdown, Plain Text, 또는 정규화된 JSON AST 구조체로 상호 변환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '변환할 HWP 또는 HWPX 파일 경로',
        },
        targetFormat: {
          type: 'string',
          enum: ['markdown', 'text', 'json'],
          description: '변환할 대상 포맷 (기본값: markdown)',
        },
        outputPath: {
          type: 'string',
          description: '변환 결과를 저장할 파일 경로 (선택)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_create_document',
    description: '제목, 문단 본문, 표 데이터를 바탕으로 표준 HWPX(KS X 6101) 문서를 즉시 생성하여 파일로 저장합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: {
          type: 'string',
          description: '생성할 HWPX 파일의 저장 경로',
        },
        title: {
          type: 'string',
          description: '문서 제목',
        },
        paragraphs: {
          type: 'array',
          items: { type: 'string' },
          description: '본문 문단 배열',
        },
        tables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              rows: {
                type: 'array',
                items: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
            required: ['rows'],
          },
          description: '문서에 포함할 표 목록 (각 표는 2차원 문자열 배열)',
        },
      },
      required: ['outputPath', 'title', 'paragraphs'],
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

      if (name === 'hanul_get_document_info') {
        const filePath = path.resolve(args.filePath);
        const buf = fs.readFileSync(filePath);
        const stats = fs.statSync(filePath);
        const doc = parseDocumentBuffer(buf);

        let isDistribution = false;
        let isEncrypted = false;
        let isCompressed = false;
        let imageCount = 0;

        if (doc.format === 'hwp') {
          try {
            const cfb = new CompoundFile(buf);
            const headerStream = cfb.getStream('FileHeader');
            if (headerStream) {
              const header = parseFileHeader(headerStream);
              isDistribution = header.flags.distribution;
              isEncrypted = header.flags.encrypted;
              isCompressed = header.flags.compressed;
            }
            imageCount = cfb.listEntries().filter((e) => e.path.toLowerCase().startsWith('bindata/')).length;
          } catch {}
        } else {
          try {
            const unzipped = unzipSync(buf);
            imageCount = Object.keys(unzipped).filter((k) => k.toLowerCase().startsWith('bindata/')).length;
          } catch {}
        }

        const info = {
          filePath,
          fileName: path.basename(filePath),
          fileSize: stats.size,
          format: doc.format,
          version: doc.version,
          flags: {
            distribution: isDistribution,
            encrypted: isEncrypted,
            compressed: isCompressed,
          },
          paragraphCount: doc.paragraphs.length,
          tableCount: doc.tables.length,
          imageCount,
          preview: doc.paragraphs.slice(0, 3).join('\n'),
        };

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(info, null, 2),
            },
          ],
          metadata: info,
        });
      }

      if (name === 'hanul_extract_images') {
        const filePath = path.resolve(args.filePath);
        const buf = fs.readFileSync(filePath);
        const outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
        const includeBase64 = Boolean(args.includeBase64);

        if (outputDir && !fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const extractedImages: Array<{
          name: string;
          size: number;
          mimeType: string;
          savedPath?: string;
          dataUri?: string;
        }> = [];

        if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
          // HWP 바이너리 BinData 스트림 추출
          const cfb = new CompoundFile(buf);
          const entries = cfb.listEntries().filter((e) => e.path.toLowerCase().startsWith('bindata/'));
          for (const entry of entries) {
            const stream = cfb.getStream(entry);
            if (!stream) continue;
            const mimeType = detectImageMime(stream);
            let ext = path.extname(entry.name);
            if (!ext) {
              ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : '.bmp';
            }
            const fileName = path.basename(entry.name);
            let savedPath: string | undefined;

            if (outputDir) {
              savedPath = path.join(outputDir, fileName);
              fs.writeFileSync(savedPath, stream);
            }

            extractedImages.push({
              name: fileName,
              size: stream.length,
              mimeType,
              savedPath,
              dataUri: includeBase64 ? `data:${mimeType};base64,${stream.toString('base64')}` : undefined,
            });
          }
        } else {
          // HWPX ZIP BinData 추출
          const unzipped = unzipSync(buf);
          for (const [key, bytes] of Object.entries(unzipped)) {
            if (key.toLowerCase().startsWith('bindata/') && bytes.length > 0) {
              const imageBuf = Buffer.from(bytes);
              const mimeType = detectImageMime(imageBuf);
              const fileName = path.basename(key);
              let savedPath: string | undefined;

              if (outputDir) {
                savedPath = path.join(outputDir, fileName);
                fs.writeFileSync(savedPath, imageBuf);
              }

              extractedImages.push({
                name: fileName,
                size: imageBuf.length,
                mimeType,
                savedPath,
                dataUri: includeBase64 ? `data:${mimeType};base64,${imageBuf.toString('base64')}` : undefined,
              });
            }
          }
        }

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `총 ${extractedImages.length}개의 임베디드 이미지를 성공적으로 추출했습니다.` +
                (outputDir ? ` (저장 위치: ${outputDir})` : ''),
            },
          ],
          totalImages: extractedImages.length,
          images: extractedImages,
        });
      }

      if (name === 'hanul_unlock_document') {
        const filePath = path.resolve(args.filePath);
        const doc = openDocument(filePath);
        const markdown = doc.toMarkdown();
        let outputPath: string | undefined;

        if (args.outputPath) {
          outputPath = path.resolve(args.outputPath);
          fs.writeFileSync(outputPath, markdown, 'utf8');
        }

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `배포용 문서 복호화 완료: 문단 ${doc.paragraphs.length}개, 표 ${doc.tables.length}개 복원됨.` +
                (outputPath ? `\n해제본 저장 완료: ${outputPath}` : ''),
            },
          ],
          metadata: {
            paragraphCount: doc.paragraphs.length,
            tableCount: doc.tables.length,
            outputPath,
          },
          markdown,
        });
      }

      if (name === 'hanul_convert_document') {
        const filePath = path.resolve(args.filePath);
        const doc = openDocument(filePath);
        const targetFormat = args.targetFormat || 'markdown';
        let resultText = '';

        if (targetFormat === 'markdown') {
          resultText = doc.toMarkdown();
        } else if (targetFormat === 'text') {
          resultText = doc.fullText;
        } else if (targetFormat === 'json') {
          resultText = JSON.stringify(
            {
              format: doc.format,
              version: doc.version,
              paragraphs: doc.paragraphs,
              tables: doc.tables,
            },
            null,
            2
          );
        }

        let outputPath: string | undefined;
        if (args.outputPath) {
          outputPath = path.resolve(args.outputPath);
          fs.writeFileSync(outputPath, resultText, 'utf8');
        }

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
          format: doc.format,
          targetFormat,
          outputPath,
        });
      }

      if (name === 'hanul_create_document') {
        const outputPath = path.resolve(args.outputPath);
        const title = String(args.title || '새 문서');
        const paragraphs = Array.isArray(args.paragraphs) ? args.paragraphs : [];
        const tables = Array.isArray(args.tables) ? args.tables : [];

        // 템플릿 로드
        const templatePath = path.resolve('templates/report.hwpx');
        const templateBuf = fs.readFileSync(templatePath);
        const unzipped = unzipSync(templateBuf);

        // 새로운 section0.xml 생성
        let secXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
        secXml += `<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">\n`;

        // 1. 문서 제목
        secXml += `  <hp:p id="0" paraPrIDRef="0" styleIDRef="0">\n`;
        secXml += `    <hp:run charPrIDRef="8"><hp:t>${escapeXml(title)}</hp:t></hp:run>\n`;
        secXml += `  </hp:p>\n`;

        // 2. 본문 문단들
        let pId = 1;
        for (const p of paragraphs) {
          secXml += `  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0">\n`;
          secXml += `    <hp:run charPrIDRef="9"><hp:t>${escapeXml(p)}</hp:t></hp:run>\n`;
          secXml += `  </hp:p>\n`;
        }

        // 3. 표들
        let tblId = 0;
        for (const tbl of tables) {
          const rows = tbl.rows || [];
          if (rows.length === 0) continue;
          const rowCount = rows.length;
          const colCount = Math.max(...rows.map((r: string[]) => r.length));

          secXml += `  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0">\n`;
          secXml += `    <hp:run charPrIDRef="9">\n`;
          secXml += `      <hp:tbl id="${tblId++}" rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0">\n`;

          for (let r = 0; r < rowCount; r++) {
            secXml += `        <hp:tr>\n`;
            for (let c = 0; c < colCount; c++) {
              const cellText = rows[r]?.[c] || '';
              secXml += `          <hp:tc>\n`;
              secXml += `            <hp:subList>\n`;
              secXml += `              <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0">\n`;
              secXml += `                <hp:run charPrIDRef="9"><hp:t>${escapeXml(cellText)}</hp:t></hp:run>\n`;
              secXml += `              </hp:p>\n`;
              secXml += `            </hp:subList>\n`;
              secXml += `            <hp:cellAddr colAddr="${c}" rowAddr="${r}"/>\n`;
              secXml += `          </hp:tc>\n`;
            }
            secXml += `        </hp:tr>\n`;
          }

          secXml += `      </hp:tbl>\n`;
          secXml += `    </hp:run>\n`;
          secXml += `  </hp:p>\n`;
        }

        secXml += `</hs:sec>`;

        unzipped['Contents/section0.xml'] = strToU8(secXml);
        const zipped = zipSync(unzipped);

        validateBytes(new Uint8Array(zipped), 'hwpx');
        const parentDir = path.dirname(outputPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(outputPath, Buffer.from(zipped));

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `표준 HWPX 문서 생성 완료: ${outputPath} (${zipped.length} bytes)`,
            },
          ],
          success: true,
          outputPath,
          fileSize: zipped.length,
          paragraphsCount: paragraphs.length,
          tablesCount: tables.length,
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
