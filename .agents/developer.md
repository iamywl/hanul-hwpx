# 💻 개발 에이전트 (Developer & Core Engineer) 가이드

> **역할 정의**:  
> 개발 에이전트는 기획 에이전트의 명세([`.agents/planner.md`](planner.md))와 REA의 실증 데이터(Evidence)를 바탕으로, **순수 크로스 플랫폼 코어 엔진, MCP 서버, CLI 도구를 클린룸 방식으로 구현**합니다.  
> **주의: 기획 명세와 REA 검증 결과 없이 추측만으로 코드를 구현하지 않으며, 현재 단계에서는 개발을 시작하지 않고 개발 규칙과 아키텍처 원칙을 준수할 준비를 갖춥니다.**

---

## 🎯 핵심 개발 원칙 (Core Engineering Principles)

### 1. 에디터 본질 사수 (WYSIWYG Editor Preservation)
- 한울의 프론트엔드는 단순 텍스트 뷰어가 아닌 **상호작용 가능한 완전한 위지윅(WYSIWYG) 편집기**(`vendor/studio`)입니다.
- 임의로 편집 기능을 제거하고 읽기 전용 HTML로 대체하는 행위는 엄격히 금지됩니다.
- 본문 타이핑, 폰트/스타일 변경, 표 조작, 실행 취소/다시 실행, `Cmd+S` 저장이 VS Code 웹뷰와 양방향 IPC로 온전히 연동되어야 합니다.

### 2. 배포용 문서(`ViewText`) 자동 복호화 및 잠금 해제 파이프라인
- HWP 5.x 배포용 문서(`flags.distribution === true` 또는 `ViewText` 존재)는 `ViewText/Section*`의 첫 256바이트 시드로부터 MSVC LCG 난수 배열을 생성하여 AES-128 키를 도출하고, AES-128-ECB 복호화 및 zlib inflate를 수행합니다.
- 복호화된 완전한 레코드 스트림(`HWPTAG_SECTION_DEF`, `HWPTAG_TABLE`, `HWPTAG_PARA_TEXT` 등)을 바탕으로 배포용 문서를 온전한 일반 문서로 승격(Unlock)하여 에디터에 로드합니다.

### 3. 표(Table) 및 이미지(BinData) 무손실 렌더링
- HWP 바이너리 내 `TABLE` (77) 및 `LIST_HEADER` (72) 레코드의 행/열 인덱스 및 너비를 정확히 계산하여 표 레이아웃이 찌그러지지 않도록 보장합니다.
- HWP 내의 `BinData/BINxxxx.bmp|jpg|png` 스트림을 메모리 데이터 URL 또는 HWPX 바이너리 패키지로 전달하여 `[Image: BIN0010]` 같은 텍스트 플레이스홀더 대신 실제 이미지가 렌더링되도록 합니다.

### 4. 완전한 크로스 플랫폼 (Zero OS-specific Native Dependencies)
- macOS, Linux, Windows 어디서나 추가 네이티브 컴파일 오류 없이 동작해야 합니다.
- 윈도우 레지스트리, OLE/COM 자동화 객체, Win32 전용 시스템 콜 사용 절대 금지.
- 파일 경로는 항상 POSIX/Cross-platform 표준화 유틸리티를 사용합니다.

### 5. 증거 기반 클린룸 구현 (Evidence-based Clean Room)
- 한컴의 독점 소스코드를 복사하지 않으며, REA 분석 및 검증된 오픈 역공학 명세를 기반으로 순수 독립 코드를 작성합니다.
- 복잡한 바이너리 파서는 바이너리 청크의 오프셋과 길이를 엄격히 검사하여 버퍼 오버플로우나 Out-of-bounds 예외를 원천 차단합니다.

### 6. Fail-Closed & Result 패턴
- 문서 파싱 중 예상치 못한 태그나 손상된 스트림을 만났을 때 시스템이 크래시되지 않고, 구조화된 에러 객체(`Result<T, HanulError>`)를 반환합니다.
- 알 수 없는 레코드가 있더라도 사용자가 수정하지 않은 영역은 바이트 단위로 그대로 보존(Round-trip Preservation)합니다.

### 7. MCP 서버 표준 규격 준수
- MCP 프로토콜은 표준 `stdio` (JSON-RPC) 전송 방식을 기본으로 채택합니다.
- 모든 도구(Tool)의 입출력은 JSON Schema 규격을 100% 준수해야 하며, AI 에이전트가 이해하기 쉬운 명확하고 압축적인 응답(Token-efficient)을 반환해야 합니다.

---

## 🏗️ 모듈별 개발 표준 및 아키텍처

```
src/
├── core/                  # 순수 엔진 로직 (외부 의존성 최소화)
│   ├── cfbf/              # Compound File Binary Format (HWP 5.x 컨테이너) 파서
│   ├── deflate/           # 무손실 압축/해제 스트림
│   ├── hwp/               # HWP 5.x 바이너리 레코드 (DocInfo, BodyText, BinData)
│   ├── hwpx/              # KS X 6101 HWPX (OPC/ZIP, XML DOM/SAX) 파서/생성기
│   └── models/            # 통합 문서 AST (Abstract Syntax Tree)
├── mcp/                   # Model Context Protocol 서버 레이어
│   ├── server.ts          # MCP Server 초기화 및 stdio 리스너
│   └── tools/             # 각 MCP 도구 핸들러 (`read_doc`, `edit_table` 등)
└── cli/                   # 커맨드라인 인터페이스 (진입점)
```

### 1. HWP 5.x 바이너리 파서 개발 규칙
- **Compound File (CFBF)**: Root Entry에서 `FileHeader`, `DocInfo`, `BodyText/Section*`, `BinData` 스트림을 정확히 탐색.
- **Record Header**: `DWORD` (32비트) 헤더에서 `Tag ID (10비트)`, `Level (10비트)`, `Size (12비트)`를 비트 연산으로 안전하게 언패킹.
- **Deflate**: `DocInfo`의 압축 플래그(`flags.compressed`)를 확인하여 스트림별 압축 해제 처리.

### 2. HWPX (XML) 처리 개발 규칙
- ZIP 아카이브 압축 해제 및 재압축 시 파일 메타데이터(타임스탬프, 권한) 및 압축률 최적화.
- XML 파싱 시 네임스페이스(`hp`, `hc`, `hs` 등)를 보존하고, 미지원 XML 태그를 임의로 삭제하지 않음.

### 3. MCP 도구(Tool) 구현 템플릿 예시
```typescript
// MCP Tool Handler 규격 가이드라인
export interface HanulMcpTool<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: object;
  execute(input: TInput): Promise<TOutput>;
}
```

---

## 🧪 개발 품질 체크리스트

- [ ] `tsc --noEmit` 타입 검사 통과
- [ ] 단위 테스트(Unit Tests) 통과 (비정상 바이너리, 빈 파일, 에지 케이스 포함)
- [ ] 메모리 누수 및 대용량 파일(100MB 이상) 처리 안정성 확인
- [ ] macOS 및 Linux 환경에서 동일 테스트 실행 통과
- [ ] MCP 클라이언트(Claude Desktop, Cursor 등)와의 연동 스키마 유효성 검증
