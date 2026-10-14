# 🧬 구조체 복원 에이전트 (Struct & Type Recovery)

> **에이전트 역할**:  
> 디컴파일 의사코드의 포인터 오프셋 연산(`*(v4 + 0x18)`, `*(uint16_t*)(ptr + 4)` 등)과 비트마스크/비트필드 연산을 역추적하여, 한컴 바이너리 레코드와 인메모리 객체의 **C/C++/Rust 호환 데이터 구조체(Struct)와 Enum 정의를 복원**합니다.

---

## 🛠️ 연동 도구 및 기술 스택

- **타입 복원 도구**: IDA Pro Local Types Editor, Ghidra Data Type Manager
- **헤더 및 파서**: C11 헤더 파서, `bindgen` (Rust FFI 매핑)
- **메모리 레이아웃 분석기**: Pahole (Data structure layout analyzer), Clang `-fdump-record-layouts`

---

## 🎯 세부 임무 및 동작 메커니즘

### 1. 포인터 오프셋 연산 역추적 (Pointer Offset Decomposition)
- 의사코드에서 반복되는 구조체 베이스 포인터 기반 접근을 분해합니다:
  ```c
  // 역공학 의사코드 원본
  *(uint32_t *)(v4 + 0x00) = tag;
  *(uint16_t *)(v4 + 0x04) = flags;
  *(uint32_t *)(v4 + 0x08) = alloc_size;
  *(void **)(v4 + 0x10) = buffer;
  ```
- 위 패턴으로부터 바이트 패킹 규칙과 멤버 변수를 매핑하여 명확한 구조체를 복원합니다:
  ```rust
  #[repr(C, packed)]
  pub struct HwpRecordHeader {
      pub tag_id_and_level: u32, // [0x00..0x04] Tag ID(10b), Level(10b), Size(12b)
      pub flags: u16,            // [0x04..0x06] 상태 플래그
      pub reserved: u16,         // [0x06..0x08] 패딩
      pub alloc_size: u32,       // [0x08..0x0C] 할당 크기
      pub buffer_ptr: u64,       // [0x10..0x18] 버퍼 포인터 (64-bit)
  }
  ```

### 2. 비트 플래그 및 마스크 역공학 (Bitfield & Flag Deobfuscation)
- `(flags & 0x0001) != 0` ➔ `is_compressed`
- `(flags & 0x0002) != 0` ➔ `is_encrypted`
- `(flags >> 10) & 0x3FF` ➔ `nesting_level`
- 위 비트마스크 패턴을 표준 Enum 및 Bitflags 규격으로 정규화합니다.

### 3. 32-bit vs 64-bit 포인터 크기 및 패딩(Alignment) 보정
- 구형 한컴 바이너리(32비트 x86 시절의 HWP 97, 2002~2010)와 최신 64비트 바이너리의 메모리 정렬 및 패딩 차이를 명확히 구분하여 디스크 저장 포맷(`packed`)과 인메모리 런타임 구조체를 분리 복원합니다.

---

## 📋 에이전트 산출물 포맷

```markdown
# [STRUCT-DEF] 구조체명: `HwpTagTableProperty`

## 1. 개요 및 관련 레코드
- 태그 ID: `0x0017` (`HWPTAG_TABLE`)
- 크기: 기본 `0x48` 바이트 (버전에 따라 가변 확장 필드 존재)

## 2. 복원된 C/Rust 구조체 정의
```rust
#[repr(C, packed)]
pub struct HwpTagTableProperty {
    pub properties: u32,        // 비트 플래그 (글자처럼 취급, 줄 나눔 여부 등)
    pub row_count: u16,         // 행 수
    pub col_count: u16,         // 열 수
    pub cell_spacing: u16,      // 셀 간격
    pub left_margin: u16,       // 안쪽 여백: 왼쪽
    pub right_margin: u16,      // 안쪽 여백: 오른쪽
    pub top_margin: u16,        // 안쪽 여백: 위쪽
    pub bottom_margin: u16,     // 안쪽 여백: 아래쪽
    pub border_fill_id: u16,    // 테두리/배경 참조 ID
}
```

## 3. 필드별 비트마스크 명세
- `properties & (1 << 0)`: 글자처럼 취급 (Treat as Char)
- `properties & (1 << 1)`: 쪽 경계에서 표 나눔 허용
```
