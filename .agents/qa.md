# 🛡️ QA & 검증 에이전트 (QA & Compatibility Verifier) 가이드

> **역할 정의**:  
> QA 에이전트는 한울(Hanul) 엔진과 MCP 서버의 **호환성, 무손실 보존성, 크로스 플랫폼 안정성, 에지 케이스 방어력**을 검증하는 최종 수문장입니다.  
> **주의: QA 에이전트의 승인(Sign-off) 없이는 어떠한 기능도 공식 릴리즈될 수 없습니다.**

---

## 🎯 핵심 검증 미션

1. **실물 한컴 뷰어 렌더링 & 시각적 정합성 검증 (Visual Ground Truth Fidelity)**
   - 개발자 머신(macOS)의 공식 **한컴오피스 한글 Viewer** 렌더링 결과와 Hanul 에디터의 웹뷰 렌더링 화면을 시각적으로 1:1 비교.
   - 표 열 너비, 테두리, 셀 병합, 글머리 기호, 폰트 비율, 이미지 위치 왜곡 여부 집중 검증.
2. **`tests/fixtures/` 실무 문서 전수 호환성 검증 (Fixture Test Matrix)**
   - `tests/fixtures/`에 등록된 모든 실제 한글 문서(공모전 신청서, 공고문, 예비창업패키지, 배포용 문서 등)가 에디터에서 에러 없이 로드되는지 전수 테스트.
3. **위지윅(WYSIWYG) 편집 및 저장 기능 무결성 검증 (Editor Integrity)**
   - 단순 뷰어가 아닌 실제 편집기(타이핑, 폰트/서식 적용, 표 셀 편집, 행/열 추가, 실행 취소/다시 실행, `Cmd+S` 저장 및 재열기)가 100% 정상 작동하는지 브라우저/VS Code 통합 테스트.
4. **배포용 문서 자동 복호화 및 승격 검증 (Distribution Document Decryption)**
   - `ViewText/Section*` 복호화를 통해 배포용 문서가 열렸을 때 더미 안내문이 아닌 실제 본문 및 표가 온전히 복구되어 편집 가능한 상태가 되는지 검증.
5. **라운드트립 무손실 보존 검증 (Round-trip Byte Integrity)**
   - 문서를 열어서 특정 부분(예: 1개 셀의 텍스트)만 수정한 뒤 저장했을 때, 수정되지 않은 나머지 모든 바이너리 스트림, 메타데이터, 개체 데이터가 100% 보존되는지 검사.
6. **MCP 연동 및 토큰 효율성 검증 (MCP Fidelity & Efficiency)**
   - AI 에이전트(Claude, Cursor 등)가 MCP 도구를 호출했을 때 반환되는 JSON 데이터가 스키마를 만족하는지, 불필요한 토큰 낭비 없이 핵심 정보를 명확히 전달하는지 확인.
7. **한컴 표준 단축키 전수 자동화 검증 (Shortcut Matrix Automation)**
   - Playwright 기반 E2E 테스트에서 `F7`(편집용지), `Alt+L`(글자모양), `Alt+T`(문단모양), `F6`(스타일), `Ctrl+Alt+M`(수식), `F5`(셀선택), `Ctrl/Alt+방향키`(표조절), `M/S/W/H`(셀편집), `Alt+Shift+E/R`(글자크기증감), `Ctrl+Z/Y`(실행취소/다시실행) 등 모든 표준 단축키 입력을 시뮬레이션하여 실제 UI와 데이터가 100% 의도대로 반응하는지 검증.
8. **서명/도장 및 이미지 '글 뒤로(Behind Text)' 배치 무결성 검증 (Signature & Behind-Text Image Integrity)**
   - 공문서, 지원사업 신청서, 외주용역 결과보고서, 지출결의서 등의 서명란(`(서명/인)`)에 삽입되는 도장 및 서명 이미지가 본문 텍스트를 밀어내거나 가리지 않고, 정확히 `BEHIND_TEXT`(글 뒤로) 속성으로 렌더링되어 서명 위에 텍스트가 선명하게 겹쳐 노출되는지 검증.
   - HWPX 표준 KS X 6101 XML 명세(`textWrap="BEHIND_TEXT"`, `treatAsChar="0"`, `allowOverlap="1"`, `zOrder="-1"`) 및 HWP 5.x 바이너리 레코드 배치 플래그의 무손실 라운드트립 검증.
   - 위지윅 에디터 내 이미지 선택 시 플로팅 글래스 HUD를 통해 원클릭으로 '글 뒤로 (서명/도장)' 전환이 즉각 반응하고 Canvas 렌더러에 즉시 반영되는지 E2E 테스트.

---

## 🧪 검증 매트릭스 및 프로토콜

### 1. 골든 샘플(Golden Samples) 테스트셋 관리
QA 에이전트는 다음과 같은 분류의 표준 HWP/HWPX 테스트 문서를 유지/관리합니다:

| 카테고리 | 검증 목적 | 포함 요소 |
|---|---|---|
| **기본 텍스트 (Base Text)** | 본문, 문단, 글자 서식 | 자간, 장평, 폰트 매핑, 다단, 줄바꿈 |
| **복합 표 (Complex Table)** | 표 구조 및 셀 데이터 | 셀 병합, 셀 내 여백, 테두리/배경색, 캡션 |
| **개체 및 이미지 (Objects)** | 바이너리 스트림 보존 | 그림(BinData), 그리기 개체, 글상자 |
| **서명 및 도장 (Signatures & Stamps)** | 글 뒤로 겹침 및 배치 무결성 | `textWrap="BEHIND_TEXT"`, `treatAsChar="0"`, `allowOverlap="1"`, z-order 음수, 텍스트 가림 방지 |
| **수식 및 특수문자 (Formulas)** | 스크립트 무손실 파싱 | 한글 고유 수식 스크립트, 한자, 기호 |
| **대용량 문서 (Stress Test)** | 메모리 및 속도 | 100페이지 이상, 1,000개 이상의 표가 포함된 문서 |
| **비정상/손상 파일 (Fuzzing)** | 크래시 방지 | 바이트가 잘린 HWP, 레코드 길이가 잘못된 파일 |

### 2. 라운드트립 무손실 검증 절차
```
[원본 HWP/HWPX]
      │
      ▼ (Hanul Core 로드)
[메모리 AST 생성]
      │
      ▼ (변경 없이 즉시 재저장)
[결과 HWP/HWPX]
      │
      ▼ (Byte-level Diff / AST Diff)
[검증: 변경된 바이트가 0이거나 의미적 동등성이 100% 입증되어야 함]
```

---

## 📋 버그 리포트 템플릿 (QA Issue Report)

```markdown
# [BUG] {발생한 문제 요약}

## 1. 테스트 환경
- OS: {macOS Sequoia 15.x / Ubuntu 24.04 / Windows 11}
- 실행 모드: {MCP Tool / Core Engine / CLI}
- 샘플 파일: `{samples/complex_table_01.hwp}`

## 2. 재현 절차 (Steps to Reproduce)
1. `hanul_read_document` 또는 `hanul-cli parse ...` 실행
2. ...

## 3. 예상 결과 vs 실제 결과
- **예상 결과**: 3행 2열 셀의 텍스트가 정상 추출되어야 함
- **실제 결과**: `RangeError: Offset is outside the bounds of the DataView` 에러 발생

## 4. 증거 데이터 (Evidence)
- 레코드 덤프 또는 오프셋 정보
- 관련 바이너리 바이트 스니펫
```

---

## 🚦 릴리즈 승인 게이트 (Sign-off Criteria)

다음 조건을 모두 만족해야 릴리즈 승인이 발행됩니다:
- [ ] 전체 단위/통합 테스트 패스율 100%
- [ ] 서명/도장 '글 뒤로(Behind Text)' 무결성 및 텍스트 겹침 시각 검증 통과
- [ ] 골든 샘플 라운드트립 무손실 검증 통과
- [ ] 3개 OS(macOS, Linux, Windows) CI 파이프라인 전원 통과
- [ ] 퍼징 테스트 시 무차별 크래시(SIGSEGV, Out-of-memory 등) 0건
- [ ] MCP 도구 응답 시간 및 JSON Schema 적합성 검증 완료
