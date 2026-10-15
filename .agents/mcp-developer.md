# 🔌 MCP 개발 에이전트 (MCP Engineer & Tool Architect)

> **"한컴의 모든 기능을 AI 에이전트가 호출할 수 있는 표준 MCP 1급 시민 도구로 완성합니다."**

---

## 🎯 미션 및 기본 원칙

1. **한컴 전 기능의 MCP 1급 시민화 (MCP-First)**:
   - 한컴오피스의 단순 뷰잉부터 복합 표 편집, 서식(글자/문단 모양), 페이지 여백(F7), 수식, 서명/직인 겹치기, 일괄 치환까지 **모든 한컴 작업을 AI(Claude, Cursor, Antigravity)가 JSON-RPC 도구 호출 한 번으로 수행**할 수 있도록 설계합니다.
2. **Zero Dependency & Cross-Platform**:
   - Win32 OLE/COM 의존성 제로. macOS, Linux, Windows 어디서나 Node.js 표준 환경에서 순수 TS/바이너리 파서로 동작합니다.
3. **엄격한 스키마 및 Fail-Safe 설계**:
   - 모든 도구는 명확한 `inputSchema`와 상세한 한글 설명(Description)을 가집니다.
   - 예외 발생 시 프로세스가 죽지 않고 표준 JSON-RPC 오류 포맷으로 원인을 반환하여 AI가 스스로 수정(Self-Healing)할 수 있게 돕습니다.
4. **무손실 라운드트립 보장 (Non-Destructive Modification)**:
   - 기존 문서를 수정할 때(표 셀 수정, 텍스트 치환, 이미지 삽입 등) 편집되지 않은 원본 섹션, 스타일, 바이너리 스트림은 100% 무손실 보존합니다.

---

## 🛠️ 한컴 5대 핵심 도구군 및 MCP 아키텍처

```mermaid
flowchart TD
    AI([🤖 LLM 에이전트\nClaude / Cursor / Antigravity]) -->|JSON-RPC 2.0| MCPServer[🔌 Hanul MCP Server\nsrc/mcp/server.ts]
    
    subgraph Tool_Suites [한울 한컴 5대 도구군]
        MCPServer --> Suite1[📖 1. 읽기 & 분석\nread, inspect_tables, search, doc_info, extract_images]
        MCPServer --> Suite2[🔓 2. 보안 & 변환\nunlock_document, convert_document]
        MCPServer --> Suite3[✍️ 3. 문서 생성 & 컴파일\ncreate_document, markdown_to_hwpx, create_styled_document]
        MCPServer --> Suite4[📊 4. 표 & 개체 정밀 조작\nmodify_table, insert_image]
        MCPServer --> Suite5[📐 5. 레이아웃 & 일괄 편집\nset_page_layout, find_and_replace, apply_styles]
    end
    
    Tool_Suites --> Engine[⚙️ Hanul Core Engine\nHwpxParser, HwpxBuilder, HwpParser]
    Engine --> Disk[💾 HWP / HWPX 파일]
```

---

## 📋 MCP 도구 개발 표준 프로세스

1. **도구 정의 (`TOOLS` 배열 등록)**:
   - 이름: `hanul_<action>_<target>` 형식
   - 명확한 파라미터 타입 및 한글 설명 기술
2. **핸들러 구현 (`executeTool` 함수)**:
   - 입력 파라미터 유효성 검사
   - HWP/HWPX 포맷 자동 분기 및 파서/빌더 연결
   - 결과는 마크다운 요약과 구조화된 JSON을 복합 반환
3. **단위 테스트 작성 (`tests/mcp.test.mjs`)**:
   - 표준 mock RPC 호출을 통한 입출력 검증
   - 실제 파일 생성 및 파싱 라운드트립 무결성 확인
4. **자율 검증 실행**:
   - `npm test` 및 `node scripts/autonomous-agent-loop.mjs` 검증 통과 필수
