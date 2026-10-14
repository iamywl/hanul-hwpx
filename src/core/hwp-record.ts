/**
 * HWP 5.x 레코드 파서 및 스트림 해독기
 * Tag-Size-Data 레코드 구조체와 zlib 압축 해제를 처리합니다.
 */

import * as zlib from 'node:zlib';

export interface HwpFileHeader {
  signature: string;
  version: {
    major: number;
    minor: number;
    build: number;
    revision: number;
  };
  flags: {
    compressed: boolean;
    encrypted: boolean;
    distribution: boolean;
    script: boolean;
    drm: boolean;
    hasHistory: boolean;
    hasSignature: boolean;
  };
}

export interface HwpRecord {
  tagId: number;
  level: number;
  size: number;
  data: Buffer;
}

export const HWP_TAG = {
  // DocInfo (0x10 ~)
  DOCUMENT_PROPERTIES: 0x0010, // 16
  ID_MAPPINGS: 0x0011,         // 17
  BIN_DATA: 0x0012,            // 18
  FACE_NAME: 0x0013,           // 19
  BORDER_FILL: 0x0014,         // 20
  CHAR_SHAPE: 0x0015,          // 21
  TAB_DEF: 0x0016,             // 22
  NUMBERING: 0x0017,           // 23
  BULLET: 0x0018,              // 24
  PARA_SHAPE: 0x0019,          // 25
  STYLE: 0x001a,               // 26
  DOC_DATA: 0x001b,            // 27
  DISTRIBUTE_DOC_DATA: 0x001c, // 28

  // BodyText (0x42 ~)
  PARA_HEADER: 0x0042,         // 66
  PARA_TEXT: 0x0043,           // 67
  PARA_CHAR_SHAPE: 0x0044,     // 68
  PARA_LINE_SEG: 0x0045,       // 69
  PARA_RANGE_TAG: 0x0046,      // 70
  CTRL_HEADER: 0x0047,         // 71
  LIST_HEADER: 0x0048,         // 72
  PAGE_DEF: 0x0049,            // 73
  FOOTNOTE_SHAPE: 0x004a,      // 74
  PAGE_BORDER_FILL: 0x004b,    // 75
  SHAPE_COMPONENT: 0x004c,     // 76
  TABLE: 0x004d,               // 77
  SHAPE_COMPONENT_LINE: 0x004e,
  SHAPE_COMPONENT_RECT: 0x004f,
  SHAPE_COMPONENT_PICTURE: 0x0051,
} as const;

/**
 * FileHeader 스트림 파싱
 */
export function parseFileHeader(stream: Buffer): HwpFileHeader {
  if (stream.length < 256) {
    throw new Error('FileHeader 스트림 길이가 너무 짧습니다.');
  }

  const sigBytes = stream.subarray(0, 32);
  const signature = sigBytes.toString('ascii').replace(/\0.*$/, '');

  if (!signature.startsWith('HWP Document File')) {
    throw new Error(`알 수 없는 HWP 시그니처: ${signature}`);
  }

  const versionNum = stream.readUInt32LE(32);
  const revision = (versionNum >> 0) & 0xff;
  const build = (versionNum >> 8) & 0xff;
  const minor = (versionNum >> 16) & 0xff;
  const major = (versionNum >> 24) & 0xff;

  const flagsWord = stream.readUInt32LE(36);
  const flags = {
    compressed: (flagsWord & (1 << 0)) !== 0,
    encrypted: (flagsWord & (1 << 1)) !== 0,
    distribution: (flagsWord & (1 << 2)) !== 0,
    script: (flagsWord & (1 << 3)) !== 0,
    drm: (flagsWord & (1 << 4)) !== 0,
    hasHistory: (flagsWord & (1 << 6)) !== 0,
    hasSignature: (flagsWord & (1 << 7)) !== 0,
  };

  return {
    signature,
    version: { major, minor, build, revision },
    flags,
  };
}

/**
 * 압축된 스트림(DocInfo, BodyText/Section*)을 안전하게 inflate
 */
export function decompressStream(buffer: Buffer): Buffer {
  try {
    // 1. zlib header 포맷 시도
    return zlib.inflateSync(buffer);
  } catch {
    try {
      // 2. raw deflate 포맷 시도
      return zlib.inflateRawSync(buffer);
    } catch {
      // 3. 압축되지 않은 원본 그대로 반환
      return buffer;
    }
  }
}

/**
 * 스트림에서 Tag-Size-Data 레코드 체인 파싱
 */
export function parseRecords(stream: Buffer): HwpRecord[] {
  const records: HwpRecord[] = [];
  let offset = 0;

  while (offset + 4 <= stream.length) {
    const header = stream.readUInt32LE(offset);
    offset += 4;

    const tagId = header & 0x3ff;
    const level = (header >> 10) & 0x3ff;
    let size = (header >> 20) & 0xfff;

    // 확장 크기 처리 (size가 4095 = 0xFFF일 경우)
    if (size === 0xfff) {
      if (offset + 4 > stream.length) break;
      size = stream.readUInt32LE(offset);
      offset += 4;
    }

    if (offset + size > stream.length) {
      // 버퍼 경계를 초과하는 경우 남은 부분까지만 슬라이스
      const data = stream.subarray(offset);
      records.push({ tagId, level, size: data.length, data });
      break;
    }

    const data = stream.subarray(offset, offset + size);
    offset += size;

    records.push({ tagId, level, size, data });
  }

  return records;
}
