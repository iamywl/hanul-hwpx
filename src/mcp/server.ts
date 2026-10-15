/**
 * Hanul MCP (Model Context Protocol) Server
 * AI 에이전트(Claude Desktop, Cursor, Antigravity 등)가
 * HWP 및 HWPX 문서를 1:1로 직접 검사, 분석, 복호화, 변환 및 생성할 수 있도록 지원하는 표준 프로토콜 서버입니다.
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { openDocument, parseDocumentBuffer } from '../core/document.js';
import { CompoundFile } from '../core/cfbf.js';
import { parseFileHeader } from '../core/hwp-record.js';
import { validateBytes } from '../storage.js';
import { HwpxDocumentBuilder, TableDef } from '../core/hwpx-builder.js';
import { compileMarkdownToHwpx } from '../core/markdown-compiler.js';
import { parseHwpxBuffer, ParsedPicture } from '../core/hwpx-parser.js';

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
  {
    name: 'hanul_markdown_to_hwpx',
    description: '마크다운(GFM) 파일 또는 문자열을 표, 정렬, 페이지 구분, 이미지 증빙이 완벽히 포함된 고품질 HWPX 문서로 직접 컴파일합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: {
          type: 'string',
          description: '컴파일할 마크다운 파일의 경로 (markdownContent가 없을 때 필수)',
        },
        markdownContent: {
          type: 'string',
          description: '컴파일할 마크다운 문자열 내용 (inputPath가 없을 때 필수)',
        },
        outputPath: {
          type: 'string',
          description: '생성할 HWPX 파일의 저장 경로',
        },
        baseDir: {
          type: 'string',
          description: '이미지 상대경로 기준 디렉토리 (기본값: inputPath 또는 outputPath 디렉토리)',
        },
      },
      required: ['outputPath'],
    },
  },
  {
    name: 'hanul_create_styled_document',
    description: '컬럼별 너비(colWidths), 헤더 음영, 셀 병합(colSpan/rowSpan), 제목, 문단, 스크린샷 이미지 증빙을 자유롭게 조합하여 전문 관공서/사업계획서/외주용역 양식 HWPX 문서를 생성합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: {
          type: 'string',
          description: '생성할 HWPX 파일의 저장 경로',
        },
        title: {
          type: 'string',
          description: '문서 최상단 대제목',
        },
        subtitle: {
          type: 'string',
          description: '부제목 (선택)',
        },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: '섹션 제목' },
              level: { type: 'integer', enum: [1, 2, 3], description: '헤딩 레벨 (1, 2, 3)' },
              paragraphs: {
                type: 'array',
                items: { type: 'string' },
                description: '섹션 본문 문단들',
              },
              table: {
                type: 'object',
                properties: {
                  colWidths: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: '컬럼별 너비 목록 (합계 42520)',
                  },
                  rows: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        cells: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              text: { type: 'string' },
                              colSpan: { type: 'integer' },
                              rowSpan: { type: 'integer' },
                              header: { type: 'boolean' },
                              align: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY'] },
                              bold: { type: 'boolean' },
                            },
                            required: ['text'],
                          },
                        },
                      },
                      required: ['cells'],
                    },
                  },
                },
                required: ['colWidths', 'rows'],
              },
              images: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    imagePath: { type: 'string' },
                    caption: { type: 'string' },
                  },
                  required: ['imagePath'],
                },
              },
              pageBreak: { type: 'boolean', description: '섹션 종료 후 페이지 나누기 여부' },
            },
          },
          description: '문서를 구성하는 구조적 섹션 목록',
        },
      },
      required: ['outputPath', 'title'],
    },
  },
  {
    name: 'hanul_find_and_replace',
    description: 'HWPX 문서 내에서 특정 단어/문구를 찾아 다른 단어로 일괄 치환(Find & Replace)하고 새 파일로 저장하거나 원본을 갱신합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '치환 대상 HWPX 파일의 경로' },
        findText: { type: 'string', description: '찾을 텍스트' },
        replaceText: { type: 'string', description: '바꿀 새 텍스트' },
        outputPath: { type: 'string', description: '결과를 저장할 파일 경로 (생략 시 filePath에 덮어쓰기)' },
        matchCase: { type: 'boolean', description: '대소문자 일치 여부 (기본값: false)' },
      },
      required: ['filePath', 'findText', 'replaceText'],
    },
  },
  {
    name: 'hanul_modify_table',
    description: '기존 HWPX 문서 내의 특정 표(Table)에서 특정 셀의 텍스트를 수정하거나, 새 행(Row)을 추가하여 문서를 갱신합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '수정할 HWPX 파일 경로' },
        tableIndex: { type: 'integer', description: '수정할 표의 인덱스 (0부터 시작, 기본값: 0)' },
        cellUpdates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              row: { type: 'integer', description: '행 번호 (0부터 시작)' },
              col: { type: 'integer', description: '열 번호 (0부터 시작)' },
              text: { type: 'string', description: '입력할 새 텍스트' },
            },
            required: ['row', 'col', 'text'],
          },
          description: '수정할 셀 좌표 및 텍스트 목록',
        },
        appendRows: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' },
          },
          description: '표의 맨 끝에 추가할 새 행 데이터 (2차원 문자열 배열)',
        },
        outputPath: { type: 'string', description: '저장할 파일 경로 (생략 시 filePath에 덮어쓰기)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_insert_image',
    description: '기존 HWPX 문서의 본문 끝 또는 특정 위치에 이미지나 서명(글 뒤로)을 삽입합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '이미지를 삽입할 HWPX 파일 경로' },
        imagePath: { type: 'string', description: '삽입할 이미지 파일 경로 (PNG, JPG, BMP)' },
        behindText: { type: 'boolean', description: '글 뒤로 배치 여부 (서명/직인 모드, 기본값: false)' },
        widthPt: { type: 'number', description: '이미지 가로 너비(pt 단위, 기본값: 150)' },
        heightPt: { type: 'number', description: '이미지 세로 높이(pt 단위, 기본값: 150)' },
        outputPath: { type: 'string', description: '저장할 파일 경로 (생략 시 filePath에 덮어쓰기)' },
      },
      required: ['filePath', 'imagePath'],
    },
  },
  {
    name: 'hanul_set_page_layout',
    description: 'HWPX 문서의 편집 용지 규격(A4, B5 등), 방향(세로/가로), 상하좌우 및 머리말/꼬리말 여백(mm 단위)을 변경합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '설정할 HWPX 파일 경로' },
        paperSize: { type: 'string', enum: ['A4', 'A3', 'B5', 'Letter'], description: '용지 규격 (기본값: A4)' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: '용지 방향 (기본값: portrait)' },
        margins: {
          type: 'object',
          properties: {
            left: { type: 'number', description: '좌측 여백 (mm)' },
            right: { type: 'number', description: '우측 여백 (mm)' },
            top: { type: 'number', description: '상단 여백 (mm)' },
            bottom: { type: 'number', description: '하단 여백 (mm)' },
            header: { type: 'number', description: '머리말 여백 (mm)' },
            footer: { type: 'number', description: '꼬리말 여백 (mm)' },
          },
          description: '여백 설정 (단위: mm)',
        },
        outputPath: { type: 'string', description: '저장할 파일 경로 (생략 시 filePath에 덮어쓰기)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'hanul_append_content',
    description: '기존 HWPX 문서의 마지막에 새로운 소제목, 본문 문단들, 또는 표를 덧붙여 문서를 확장합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '내용을 추가할 HWPX 파일 경로' },
        heading: { type: 'string', description: '추가할 섹션 제목 (선택)' },
        paragraphs: {
          type: 'array',
          items: { type: 'string' },
          description: '추가할 본문 문단 목록',
        },
        table: {
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
          description: '추가할 표 데이터',
        },
        outputPath: { type: 'string', description: '저장할 파일 경로 (생략 시 filePath에 덮어쓰기)' },
      },
      required: ['filePath'],
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

        let behindTextImageCount = 0;
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
            const hwpxDoc = parseHwpxBuffer(buf);
            for (const sec of hwpxDoc.sections) {
              if (sec.pictures) {
                behindTextImageCount += sec.pictures.filter((p) => p.isBehindText).length;
              }
            }
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
          behindTextImageCount, // 서명/도장 등 '글 뒤로' 배치된 개체 개수
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

        const builder = new HwpxDocumentBuilder();
        builder.addTitle(title);

        for (const p of paragraphs) {
          builder.addParagraph(p);
        }

        for (const tbl of tables) {
          const rows = tbl.rows || [];
          if (rows.length === 0) continue;
          const colCount = Math.max(...rows.map((r: string[]) => r.length));
          const totalWidth = 42520;
          const colWidth = Math.floor(totalWidth / colCount);
          const colWidths = Array(colCount).fill(colWidth);
          colWidths[colCount - 1] += totalWidth - colWidth * colCount;

          builder.addTable({
            colWidths,
            rows: rows.map((r: string[], rIdx: number) => ({
              cells: r.map((c: string) => ({
                text: c,
                header: rIdx === 0,
                align: rIdx === 0 ? 'CENTER' : 'LEFT',
                bold: rIdx === 0,
              })),
            })),
          });
        }

        builder.saveToFile(outputPath);
        const stats = fs.statSync(outputPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `표준 HWPX 문서 생성 완료: ${outputPath} (${stats.size} bytes)`,
            },
          ],
          success: true,
          outputPath,
          fileSize: stats.size,
          paragraphsCount: paragraphs.length,
          tablesCount: tables.length,
        });
      }

      if (name === 'hanul_markdown_to_hwpx') {
        const outputPath = path.resolve(args.outputPath);
        let markdown = '';

        if (args.inputPath) {
          const inPath = path.resolve(args.inputPath);
          markdown = fs.readFileSync(inPath, 'utf8');
        } else if (args.markdownContent) {
          markdown = String(args.markdownContent);
        } else {
          return this.sendError(id, -32602, 'inputPath 또는 markdownContent 중 하나는 필수입니다.');
        }

        const baseDir = args.baseDir
          ? path.resolve(args.baseDir)
          : args.inputPath
          ? path.dirname(path.resolve(args.inputPath))
          : path.dirname(outputPath);

        compileMarkdownToHwpx(markdown, outputPath, { baseDir });
        const stats = fs.statSync(outputPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `마크다운 -> HWPX 컴파일 완료: ${outputPath} (${stats.size} bytes)`,
            },
          ],
          success: true,
          outputPath,
          fileSize: stats.size,
        });
      }

      if (name === 'hanul_create_styled_document') {
        const outputPath = path.resolve(args.outputPath);
        const title = String(args.title || '새 문서');
        const subtitle = args.subtitle ? String(args.subtitle) : undefined;
        const sections = Array.isArray(args.sections) ? args.sections : [];

        const builder = new HwpxDocumentBuilder();
        builder.addTitle(title, subtitle);

        for (const sec of sections) {
          if (sec.heading) {
            builder.addHeading(sec.heading, sec.level || 1);
          }

          if (Array.isArray(sec.paragraphs)) {
            for (const p of sec.paragraphs) {
              builder.addParagraph(p);
            }
          }

          if (sec.table && Array.isArray(sec.table.rows)) {
            builder.addTable(sec.table);
          }

          if (Array.isArray(sec.images)) {
            for (const img of sec.images) {
              builder.addImage(img);
            }
          }

          if (Array.isArray(sec.signatures)) {
            for (const sig of sec.signatures) {
              builder.addSignature(sig);
            }
          }

          if (sec.pageBreak) {
            builder.addPageBreak();
          }
        }

        builder.saveToFile(outputPath);
        const stats = fs.statSync(outputPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `서식화된 HWPX 문서 생성 완료: ${outputPath} (${stats.size} bytes)`,
            },
          ],
          success: true,
          outputPath,
          fileSize: stats.size,
          sectionsCount: sections.length,
        });
      }

      if (name === 'hanul_find_and_replace') {
        const filePath = path.resolve(args.filePath);
        if (!fs.existsSync(filePath)) {
          return this.sendError(id, -32602, `파일을 찾을 수 없습니다: ${filePath}`);
        }
        const outPath = args.outputPath ? path.resolve(args.outputPath) : filePath;
        const findText = String(args.findText || '');
        const replaceText = String(args.replaceText ?? '');
        const matchCase = Boolean(args.matchCase);

        if (!findText) {
          return this.sendError(id, -32602, 'findText는 필수 파라미터입니다.');
        }

        const buf = fs.readFileSync(filePath);
        const zipData = unzipSync(new Uint8Array(buf));
        let totalReplaced = 0;
        const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, matchCase ? 'g' : 'gi');

        for (const [entryName, u8] of Object.entries(zipData)) {
          if (entryName.startsWith('Contents/section') && entryName.endsWith('.xml')) {
            let xml = strFromU8(u8);
            const matches = xml.match(regex);
            if (matches && matches.length > 0) {
              totalReplaced += matches.length;
              xml = xml.replace(regex, replaceText);
              zipData[entryName] = strToU8(xml);
            }
          }
        }

        const outZip = zipSync(zipData);
        fs.writeFileSync(outPath, Buffer.from(outZip));
        const stats = fs.statSync(outPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `텍스트 치환 완료: '${findText}' -> '${replaceText}' (총 ${totalReplaced}건 치환됨, 파일: ${outPath})`,
            },
          ],
          success: true,
          replacedCount: totalReplaced,
          outputPath: outPath,
          fileSize: stats.size,
        });
      }

      if (name === 'hanul_modify_table') {
        const filePath = path.resolve(args.filePath);
        if (!fs.existsSync(filePath)) {
          return this.sendError(id, -32602, `파일을 찾을 수 없습니다: ${filePath}`);
        }
        const outPath = args.outputPath ? path.resolve(args.outputPath) : filePath;
        const tableIndex = Number(args.tableIndex || 0);
        const cellUpdates = Array.isArray(args.cellUpdates) ? args.cellUpdates : [];
        const appendRows = Array.isArray(args.appendRows) ? args.appendRows : [];

        const buf = fs.readFileSync(filePath);
        const zipData = unzipSync(new Uint8Array(buf));
        const secEntry = 'Contents/section0.xml';

        if (!zipData[secEntry]) {
          return this.sendError(id, -32602, 'HWPX 내에서 Contents/section0.xml을 찾을 수 없습니다.');
        }

        const xmlStr = strFromU8(zipData[secEntry]);
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlStr, 'text/xml');

        const tables = doc.getElementsByTagName('hp:tbl');
        if (tables.length <= tableIndex) {
          return this.sendError(id, -32602, `문서 내에 ${tableIndex}번 표가 존재하지 않습니다. (총 표 개수: ${tables.length})`);
        }

        const tbl = tables.item(tableIndex)!;
        const rows = tbl.getElementsByTagName('hp:tr');
        let updatedCellsCount = 0;

        for (const u of cellUpdates) {
          const r = Number(u.row);
          const c = Number(u.col);
          if (r < rows.length) {
            const rowElem = rows.item(r)!;
            const cells = rowElem.getElementsByTagName('hp:tc');
            if (c < cells.length) {
              const cellElem = cells.item(c)!;
              const tNodes = cellElem.getElementsByTagName('hp:t');
              if (tNodes.length > 0) {
                tNodes.item(0)!.textContent = String(u.text);
                updatedCellsCount++;
              }
            }
          }
        }

        let appendedRowsCount = 0;
        if (appendRows.length > 0 && rows.length > 0) {
          const templateRow = rows.item(rows.length - 1)!;
          let newRowIdx = rows.length;
          for (const newRowData of appendRows) {
            const newRow = templateRow.cloneNode(true) as any;
            const cells = newRow.getElementsByTagName('hp:tc');
            for (let c = 0; c < cells.length; c++) {
              const cellElem = cells.item(c)!;
              const cellAddrList = cellElem.getElementsByTagName('hp:cellAddr');
              if (cellAddrList.length > 0) {
                cellAddrList.item(0)!.setAttribute('rowAddr', String(newRowIdx));
                cellAddrList.item(0)!.setAttribute('colAddr', String(c));
              }
              const tNodes = cellElem.getElementsByTagName('hp:t');
              const cellText = c < newRowData.length ? String(newRowData[c]) : '';
              if (tNodes.length > 0) {
                tNodes.item(0)!.textContent = cellText;
              }
            }
            tbl.appendChild(newRow);
            appendedRowsCount++;
            newRowIdx++;
          }
        }

        const serializer = new XMLSerializer();
        const newXml = serializer.serializeToString(doc);
        zipData[secEntry] = strToU8(newXml);

        const outZip = zipSync(zipData);
        fs.writeFileSync(outPath, Buffer.from(outZip));
        const stats = fs.statSync(outPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `표(Table #${tableIndex}) 수정 완료: 셀 수정 ${updatedCellsCount}개, 새 행 추가 ${appendedRowsCount}개 (${outPath})`,
            },
          ],
          success: true,
          tableIndex,
          updatedCellsCount,
          appendedRowsCount,
          outputPath: outPath,
          fileSize: stats.size,
        });
      }

      if (name === 'hanul_insert_image') {
        const filePath = path.resolve(args.filePath);
        const imagePath = path.resolve(args.imagePath);
        if (!fs.existsSync(filePath)) {
          return this.sendError(id, -32602, `문서 파일을 찾을 수 없습니다: ${filePath}`);
        }
        if (!fs.existsSync(imagePath)) {
          return this.sendError(id, -32602, `이미지 파일을 찾을 수 없습니다: ${imagePath}`);
        }
        const outPath = args.outputPath ? path.resolve(args.outputPath) : filePath;
        const behindText = Boolean(args.behindText);
        const widthPt = Number(args.widthPt || 150);
        const heightPt = Number(args.heightPt || 150);
        const widthHwpu = Math.round(widthPt * 100);
        const heightHwpu = Math.round(heightPt * 100);

        const buf = fs.readFileSync(filePath);
        const imgBuf = fs.readFileSync(imagePath);
        const zipData = unzipSync(new Uint8Array(buf));

        const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'png';
        const imgBinaryId = `image_${Date.now()}`;
        const binDataPath = `BinData/${imgBinaryId}.${ext}`;
        zipData[binDataPath] = new Uint8Array(imgBuf);

        const secEntry = 'Contents/section0.xml';
        if (!zipData[secEntry]) {
          return this.sendError(id, -32602, 'HWPX section0.xml을 찾을 수 없습니다.');
        }

        const xmlStr = strFromU8(zipData[secEntry]);
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlStr, 'text/xml');
        const secElem = doc.documentElement;
        if (!secElem) {
          return this.sendError(id, -32602, '유효한 섹션 요소를 찾을 수 없습니다.');
        }

        const newP = doc.createElement('hp:p');
        const newRun = doc.createElement('hp:run');
        const newPic = doc.createElement('hp:pic');
        newPic.setAttribute('id', String(Date.now()));
        newPic.setAttribute('zOrder', behindText ? '-1' : '0');
        newPic.setAttribute('textWrap', behindText ? 'behindText' : 'inLineWithText');
        newPic.setAttribute('width', String(widthHwpu));
        newPic.setAttribute('height', String(heightHwpu));

        const szElem = doc.createElement('hp:sz');
        szElem.setAttribute('width', String(widthHwpu));
        szElem.setAttribute('height', String(heightHwpu));
        newPic.appendChild(szElem);

        const imgElem = doc.createElement('hp:img');
        imgElem.setAttribute('src', binDataPath);
        newPic.appendChild(imgElem);

        newRun.appendChild(newPic);
        newP.appendChild(newRun);
        secElem.appendChild(newP);

        const serializer = new XMLSerializer();
        const newXml = serializer.serializeToString(doc);
        zipData[secEntry] = strToU8(newXml);

        const outZip = zipSync(zipData);
        fs.writeFileSync(outPath, Buffer.from(outZip));
        const stats = fs.statSync(outPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `이미지 삽입 완료 (${behindText ? '글 뒤로(서명/직인)' : '일반 배치'}): ${outPath} (${stats.size} bytes)`,
            },
          ],
          success: true,
          behindText,
          binDataPath,
          outputPath: outPath,
          fileSize: stats.size,
        });
      }

      if (name === 'hanul_set_page_layout') {
        const filePath = path.resolve(args.filePath);
        if (!fs.existsSync(filePath)) {
          return this.sendError(id, -32602, `파일을 찾을 수 없습니다: ${filePath}`);
        }
        const outPath = args.outputPath ? path.resolve(args.outputPath) : filePath;
        const paperSize = String(args.paperSize || 'A4').toUpperCase();
        const orientation = String(args.orientation || 'portrait').toLowerCase();
        const margins = args.margins || {};

        const buf = fs.readFileSync(filePath);
        const zipData = unzipSync(new Uint8Array(buf));
        const secEntry = 'Contents/section0.xml';

        if (!zipData[secEntry]) {
          return this.sendError(id, -32602, 'HWPX section0.xml을 찾을 수 없습니다.');
        }

        const xmlStr = strFromU8(zipData[secEntry]);
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlStr, 'text/xml');

        let w = 59528;
        let h = 84188;
        if (paperSize === 'B5') { w = 51590; h = 72850; }
        else if (paperSize === 'A3') { w = 84188; h = 119056; }
        else if (paperSize === 'LETTER') { w = 61200; h = 79200; }

        if (orientation === 'landscape') {
          const tmp = w; w = h; h = tmp;
        }

        const pagePrList = doc.getElementsByTagName('hp:pagePr');
        if (pagePrList.length > 0) {
          const pagePr = pagePrList.item(0)!;
          pagePr.setAttribute('width', String(w));
          pagePr.setAttribute('height', String(h));
          pagePr.setAttribute('landscape', orientation === 'landscape' ? '1' : '0');

          const marginList = pagePr.getElementsByTagName('hp:margin');
          const marginElem = marginList.length > 0 ? marginList.item(0)! : doc.createElement('hp:margin');
          const toHwpu = (mm?: number, defMm = 20) => Math.round((mm !== undefined ? mm : defMm) * 283.46);

          marginElem.setAttribute('left', String(toHwpu(margins.left, 20)));
          marginElem.setAttribute('right', String(toHwpu(margins.right, 20)));
          marginElem.setAttribute('top', String(toHwpu(margins.top, 20)));
          marginElem.setAttribute('bottom', String(toHwpu(margins.bottom, 15)));
          marginElem.setAttribute('header', String(toHwpu(margins.header, 10)));
          marginElem.setAttribute('footer', String(toHwpu(margins.footer, 10)));

          if (marginList.length === 0) {
            pagePr.appendChild(marginElem);
          }
        }

        const serializer = new XMLSerializer();
        const newXml = serializer.serializeToString(doc);
        zipData[secEntry] = strToU8(newXml);

        const outZip = zipSync(zipData);
        fs.writeFileSync(outPath, Buffer.from(outZip));
        const stats = fs.statSync(outPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `편집 용지 설정 완료: ${paperSize} (${orientation}, 좌우 ${margins.left || 20}mm, 상하 ${margins.top || 20}mm) -> ${outPath}`,
            },
          ],
          success: true,
          paperSize,
          orientation,
          outputPath: outPath,
          fileSize: stats.size,
        });
      }

      if (name === 'hanul_append_content') {
        const filePath = path.resolve(args.filePath);
        if (!fs.existsSync(filePath)) {
          return this.sendError(id, -32602, `파일을 찾을 수 없습니다: ${filePath}`);
        }
        const outPath = args.outputPath ? path.resolve(args.outputPath) : filePath;
        const heading = args.heading ? String(args.heading) : undefined;
        const paragraphs = Array.isArray(args.paragraphs) ? args.paragraphs : [];
        const table = args.table;

        const buf = fs.readFileSync(filePath);
        const zipData = unzipSync(new Uint8Array(buf));
        const secEntry = 'Contents/section0.xml';

        if (!zipData[secEntry]) {
          return this.sendError(id, -32602, 'HWPX section0.xml을 찾을 수 없습니다.');
        }

        const xmlStr = strFromU8(zipData[secEntry]);
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlStr, 'text/xml');
        const secElem = doc.documentElement;
        if (!secElem) {
          return this.sendError(id, -32602, '유효한 섹션 요소를 찾을 수 없습니다.');
        }

        // 1. 소제목 추가
        if (heading) {
          const headP = doc.createElement('hp:p');
          const run = doc.createElement('hp:run');
          const t = doc.createElement('hp:t');
          t.textContent = heading;
          run.appendChild(t);
          headP.appendChild(run);
          secElem.appendChild(headP);
        }

        // 2. 문단 추가
        for (const pText of paragraphs) {
          const pElem = doc.createElement('hp:p');
          const run = doc.createElement('hp:run');
          const t = doc.createElement('hp:t');
          t.textContent = String(pText);
          run.appendChild(t);
          pElem.appendChild(run);
          secElem.appendChild(pElem);
        }

        // 3. 표 추가
        if (table && Array.isArray(table.rows) && table.rows.length > 0) {
          const tblElem = doc.createElement('hp:tbl');
          tblElem.setAttribute('id', String(Date.now()));
          tblElem.setAttribute('zOrder', '0');

          for (const rowData of table.rows) {
            const trElem = doc.createElement('hp:tr');
            for (const cellText of rowData) {
              const tcElem = doc.createElement('hp:tc');
              const cellP = doc.createElement('hp:p');
              const run = doc.createElement('hp:run');
              const t = doc.createElement('hp:t');
              t.textContent = String(cellText);
              run.appendChild(t);
              cellP.appendChild(run);
              tcElem.appendChild(cellP);
              trElem.appendChild(tcElem);
            }
            tblElem.appendChild(trElem);
          }
          secElem.appendChild(tblElem);
        }

        const serializer = new XMLSerializer();
        const newXml = serializer.serializeToString(doc);
        zipData[secEntry] = strToU8(newXml);

        const outZip = zipSync(zipData);
        fs.writeFileSync(outPath, Buffer.from(outZip));
        const stats = fs.statSync(outPath);

        return this.sendResult(id, {
          content: [
            {
              type: 'text',
              text: `문서 내용 덧붙이기 완료: 문단 ${paragraphs.length}개${heading ? ', 소제목' : ''}${table ? ', 신규 표' : ''} 추가 (${outPath})`,
            },
          ],
          success: true,
          outputPath: outPath,
          fileSize: stats.size,
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
