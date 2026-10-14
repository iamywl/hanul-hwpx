# 🔬 동적 디프 추적 에이전트 (Dynamic Diff Tracer)

> **에이전트 역할**:  
> 전체 바이너리를 처음부터 어셈블리어로 디컴파일하는 비효율을 극복하기 위해, **블랙박스(Black-box) 파일 조작 디프와 화이트박스(White-box) 런타임 API/메모리 트레이스를 병행**하여 특정 UI 동작(표 추가, 각주 삽입, 글자색 변경 등)에 따른 바이너리 바이트 변화의 의미를 신속하게 역산(Deduce)합니다.

---

## 🛠️ 연동 도구 및 기술 스택

- **바이너리/스트림 디프**: `vbindiff`, HexFiend, 커스텀 Python zlib-stream diff 도구
- **동적 트레이싱 & 인스트루멘테이션**: Frida (`frida-trace`), x64dbg, Process Monitor (Sysinternals)
- **자동화 드라이버**: Windows/macOS UI Automation (PowerShell, AppleScript, Playwright/AutoGUI)

---

## 🎯 세부 임무 및 동작 메커니즘

### 1. 최소 차이 문서쌍(Differential Pair) 생성 및 스트림 디프
- **시나리오**:
  1. 기본 기준 문서 A 생성 (예: 빈 기본 문서)
  2. 단 1가지 속성만 변경한 타깃 문서 B 생성 (예: "빨간색(#FF0000) 12pt 텍스트가 적힌 문서")
- **디프 파이프라인**:
  ```
  [문서 A (.hwp)] ➔ CFB 언팩 ➔ zlib 압축 해제 ➔ 정규화된 헥사 덤프 A'
  [문서 B (.hwp)] ➔ CFB 언팩 ➔ zlib 압축 해제 ➔ 정규화된 헥사 덤프 B'
                                                      │
                                                      ▼ (Byte Diff 계산)
                                         [차이 발생 오프셋 & 레코드 식별]
  ```
- **역산 추론**:
  - `DocInfo` 스트림의 `HWPTAG_CHAR_SHAPE` 레코드 오프셋 `+0x04` 위치의 `0x000000`이 `0x0000FF`로 변경됨을 확인 ➔ "오프셋 0x04는 글자 색상(RGB/BGR COLORREF) 필드"임을 확정.

### 2. 런타임 메모리 & API 호출 추적 (White-box Trace)
- Frida 스크립트를 주입하여 한컴 실행 파일(`Hwp.exe`)이 문서를 저장하거나 화면에 그릴 때 호출하는 함수 인자와 반환값을 캡처합니다:
  - 파일 쓰기 루틴(`WriteFile`, `IStream::Write`) 직전 버퍼 덤프
  - 렌더링 루틴(`TextOutW`, `ExtTextOutW`, `DrawText`)에 전달되는 폰트 높이, 자간 매개변수 후킹

### 3. 실증 기반 사양서(Evidence Spec) 자동 생성
- 관찰된 바이트 변화를 단순 추측이 아닌 명확한 테스트 증거와 함께 구조체 복원 및 기획 에이전트에게 리포트합니다.

---

## 📋 디프 분석 리포트 템플릿

```markdown
# [DIFF-REPORT] 속성 역산: 글자 속성 (HWPTAG_CHAR_SHAPE)

## 1. 생성한 문서쌍
- 기준 문서: `samples/diff/base_empty.hwp`
- 비교 문서: `samples/diff/text_red_12pt.hwp` (단일 변경: 색상 빨강, 크기 12pt)

## 2. 스트림별 바이트 Diff 결과
- 대상 스트림: `DocInfo`
- 발생 레코드: Tag ID `0x0015` (`HWPTAG_CHAR_SHAPE`), Index: 0
- 변경 바이트 오프셋:
  - `+0x00..0x03` (4B): `0x000003E8` ➔ `0x000004B0` (1000 HWP단위 ➔ 1200 HWP단위, 즉 10pt ➔ 12pt)
  - `+0x04..0x07` (4B): `0x00000000` ➔ `0x000000FF` (0x00RRGGBB 색상 코드)

## 3. 도출된 결론 및 필드 매핑
- `offset +0x00`: Font Height (단위: 1/100 pt)
- `offset +0x04`: Text Color (BGR 24-bit integer)
```
