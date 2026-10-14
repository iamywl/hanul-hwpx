/**
 * Compound File Binary Format (CFBF / OLE2) 순수 파서
 * HWP 5.x 문서의 바이너리 컨테이너 스트림 및 계층 트리를 완벽 추출합니다.
 * Zero Native Dependency - macOS, Linux, Windows 100% 호환
 */

export interface DirectoryEntry {
  id: number;
  name: string;
  path: string; // 계층형 전체 경로 (예: 'BodyText/Section0')
  type: number; // 1: Storage, 2: Stream, 5: Root
  startSector: number;
  size: number;
  leftSibling: number;
  rightSibling: number;
  child: number;
}

export class CompoundFile {
  private buffer: Buffer;
  private sectorSize: number;
  private miniSectorSize: number;
  private miniStreamCutoff: number;
  private fat: number[] = [];
  private miniFat: number[] = [];
  private dirEntries: DirectoryEntry[] = [];
  private miniStreamBuffer: Buffer | null = null;

  private static MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    if (buffer.length < 512 || !buffer.subarray(0, 8).equals(CompoundFile.MAGIC)) {
      throw new Error('유효한 OLE2/CFBF(HWP 5.x) 바이너리 형식이 아닙니다.');
    }

    const sectorShift = buffer.readUInt16LE(30);
    this.sectorSize = 1 << sectorShift;

    const miniSectorShift = buffer.readUInt16LE(32);
    this.miniSectorSize = 1 << miniSectorShift;

    this.miniStreamCutoff = buffer.readUInt32LE(56);

    const fatSectorCount = buffer.readUInt32LE(44);
    const firstDirSector = buffer.readUInt32LE(48);
    const firstMiniFatSector = buffer.readUInt32LE(60);
    const miniFatSectorCount = buffer.readUInt32LE(64);
    const firstDifatSector = buffer.readUInt32LE(68);
    const difatSectorCount = buffer.readUInt32LE(72);

    this.loadFAT(fatSectorCount, firstDifatSector, difatSectorCount);
    this.loadMiniFAT(firstMiniFatSector, miniFatSectorCount);
    this.loadDirectory(firstDirSector);
    this.initMiniStream();
    this.resolveHierarchy();
  }

  private getSectorOffset(sectorIndex: number): number {
    return (sectorIndex + 1) * this.sectorSize;
  }

  private loadFAT(fatCount: number, firstDifat: number, difatCount: number) {
    const fatSectorIndices: number[] = [];

    // Header 내부 109개 DIFAT 엔트리 로드
    for (let i = 0; i < 109 && fatSectorIndices.length < fatCount; i++) {
      const idx = this.buffer.readUInt32LE(76 + i * 4);
      if (idx === 0xfffffffe || idx === 0xffffffff) break;
      fatSectorIndices.push(idx);
    }

    // 추가 DIFAT 섹터 로드
    let currDifat = firstDifat;
    for (let d = 0; d < difatCount && currDifat < 0xfffffffe; d++) {
      const offset = this.getSectorOffset(currDifat);
      const entriesPerSector = (this.sectorSize / 4) - 1;
      for (let i = 0; i < entriesPerSector && fatSectorIndices.length < fatCount; i++) {
        const idx = this.buffer.readUInt32LE(offset + i * 4);
        if (idx === 0xfffffffe || idx === 0xffffffff) break;
        fatSectorIndices.push(idx);
      }
      currDifat = this.buffer.readUInt32LE(offset + entriesPerSector * 4);
    }

    // 각 FAT 섹터에서 FAT 체인 테이블 빌드
    for (const sectorIdx of fatSectorIndices) {
      const offset = this.getSectorOffset(sectorIdx);
      const count = this.sectorSize / 4;
      for (let i = 0; i < count; i++) {
        this.fat.push(this.buffer.readUInt32LE(offset + i * 4));
      }
    }
  }

  private loadMiniFAT(firstMiniFat: number, count: number) {
    if (firstMiniFat >= 0xfffffffe || count === 0) return;
    const sectors = this.getSectorChain(firstMiniFat, this.fat);
    for (const sec of sectors) {
      const offset = this.getSectorOffset(sec);
      const numEntries = this.sectorSize / 4;
      for (let i = 0; i < numEntries; i++) {
        this.miniFat.push(this.buffer.readUInt32LE(offset + i * 4));
      }
    }
  }

  private getSectorChain(startSector: number, fatTable: number[]): number[] {
    const chain: number[] = [];
    let curr = startSector;
    const visited = new Set<number>();
    while (curr < 0xfffffffe && !visited.has(curr)) {
      visited.add(curr);
      chain.push(curr);
      if (curr >= fatTable.length) break;
      curr = fatTable[curr];
    }
    return chain;
  }

  private loadDirectory(firstDirSector: number) {
    const chain = this.getSectorChain(firstDirSector, this.fat);
    let idCounter = 0;

    for (const sec of chain) {
      const offset = this.getSectorOffset(sec);
      const entriesPerSec = this.sectorSize / 128;
      for (let i = 0; i < entriesPerSec; i++) {
        const entryOffset = offset + i * 128;
        const nameLen = this.buffer.readUInt16LE(entryOffset + 64);
        if (nameLen === 0) continue;

        // UTF-16LE 디코딩 (null terminator 제외)
        const nameBytes = this.buffer.subarray(entryOffset, entryOffset + Math.max(0, nameLen - 2));
        const name = nameBytes.toString('utf16le');
        const type = this.buffer.readUInt8(entryOffset + 66);
        const leftSibling = this.buffer.readUInt32LE(entryOffset + 68);
        const rightSibling = this.buffer.readUInt32LE(entryOffset + 72);
        const child = this.buffer.readUInt32LE(entryOffset + 76);
        const startSector = this.buffer.readUInt32LE(entryOffset + 116);
        const size = this.buffer.readUInt32LE(entryOffset + 120);

        this.dirEntries.push({
          id: idCounter++,
          name,
          path: name,
          type,
          leftSibling,
          rightSibling,
          child,
          startSector,
          size,
        });
      }
    }
  }

  private resolveHierarchy() {
    if (this.dirEntries.length === 0) return;

    const traverse = (nodeId: number, parentPath: string) => {
      if (nodeId === 0xffffffff || nodeId >= this.dirEntries.length) return;
      const node = this.dirEntries[nodeId];

      const currentPath = parentPath
        ? `${parentPath}/${node.name}`
        : (node.type === 5 ? '' : node.name);

      if (currentPath) {
        node.path = currentPath;
      }

      traverse(node.leftSibling, parentPath);
      traverse(node.rightSibling, parentPath);

      if (node.child !== 0xffffffff) {
        traverse(node.child, node.path);
      }
    };

    const root = this.dirEntries[0];
    if (root && root.child !== 0xffffffff) {
      traverse(root.child, '');
    }
  }

  private initMiniStream() {
    if (this.dirEntries.length > 0 && this.dirEntries[0].type === 5) {
      const root = this.dirEntries[0];
      if (root.size > 0 && root.startSector < 0xfffffffe) {
        const chain = this.getSectorChain(root.startSector, this.fat);
        const chunks: Buffer[] = [];
        for (const sec of chain) {
          const off = this.getSectorOffset(sec);
          chunks.push(this.buffer.subarray(off, off + this.sectorSize));
        }
        this.miniStreamBuffer = Buffer.concat(chunks).subarray(0, root.size);
      }
    }
  }

  public listEntries(): DirectoryEntry[] {
    return this.dirEntries;
  }

  /**
   * 이름 또는 경로(예: 'BodyText/Section0', 'FileHeader')로 스트림 데이터 읽기
   */
  public getStream(target: string | DirectoryEntry): Buffer | null {
    let entry: DirectoryEntry | undefined;

    if (typeof target === 'string') {
      // 1. 전체 path 일치 검색 (예: 'BodyText/Section0')
      entry = this.dirEntries.find((e) => e.path.toLowerCase() === target.toLowerCase() && e.type === 2);
      // 2. 단일 이름 일치 검색 (예: 'FileHeader')
      if (!entry) {
        entry = this.dirEntries.find((e) => e.name.toLowerCase() === target.toLowerCase() && e.type === 2);
      }
    } else {
      entry = target;
    }

    if (!entry || entry.type !== 2) return null;

    if (entry.size < this.miniStreamCutoff && this.miniStreamBuffer) {
      // Mini Stream 읽기
      const chain = this.getSectorChain(entry.startSector, this.miniFat);
      const chunks: Buffer[] = [];
      for (const miniSec of chain) {
        const off = miniSec * this.miniSectorSize;
        if (off + this.miniSectorSize <= this.miniStreamBuffer.length) {
          chunks.push(this.miniStreamBuffer.subarray(off, off + this.miniSectorSize));
        }
      }
      return Buffer.concat(chunks).subarray(0, entry.size);
    } else {
      // 일반 Sector 읽기
      const chain = this.getSectorChain(entry.startSector, this.fat);
      const chunks: Buffer[] = [];
      for (const sec of chain) {
        const off = this.getSectorOffset(sec);
        if (off + this.sectorSize <= this.buffer.length) {
          chunks.push(this.buffer.subarray(off, off + this.sectorSize));
        }
      }
      return Buffer.concat(chunks).subarray(0, entry.size);
    }
  }
}
