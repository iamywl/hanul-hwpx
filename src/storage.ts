import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, writeFile, copyFile, rename, unlink, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

export type Format = 'hwp' | 'hwpx' | 'hml';
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function formatOf(name: string): Format {
  if (/\.hwpx$/i.test(name)) return 'hwpx';
  if (/\.hwp$/i.test(name)) return 'hwp';
  if (/\.hml$/i.test(name)) return 'hml';
  return 'hwpx';
}
export function validateBytes(bytes: Uint8Array, format: Format): void {
  if (bytes.length === 0 || bytes.length > 100 * 1024 * 1024) throw Error('파일은 100MB 이하여야 합니다.');
  if (format === 'hwp') {
    const isCfb = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
    const isHwp3 = bytes.length >= 17 && new TextDecoder('latin1').decode(bytes.subarray(0, 17)).startsWith('HWP Document');
    if (!isCfb && !isHwp3 && bytes.length < 512) {
      throw Error('유효한 HWP 파일이 아닙니다.');
    }
    return;
  }
  if (format === 'hml') {
    return;
  }
  // Bound expansion before inflating untrusted ZIPs (central directory sizes).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    const count = view.getUint16(i + 10, true);
    let offset = view.getUint32(i + 16, true);
    if (count > 10000) throw Error('ZIP 항목이 너무 많습니다.');
    for (let n = 0; n < count; n++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw Error('ZIP 구조가 손상되었습니다.');
      total += view.getUint32(offset + 24, true);
      if (total > 200 * 1024 * 1024) throw Error('압축 해제 크기가 제한을 초과합니다.');
      offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    break;
  }
  if (!total) throw Error('유효한 HWPX ZIP 파일이 아닙니다.');
  const entries = unzipSync(bytes);
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const entryKeys = Object.keys(entries);
  const hasHeader = entryKeys.some(k => /^(Contents\/)?header\.xml$/i.test(k));
  const hasHpf = entryKeys.some(k => /^(Contents\/)?content\.hpf$/i.test(k));
  const hasSection = entryKeys.some(k => /^(Contents\/)?section\d+\.xml$/i.test(k));
  if (!hasHeader && !hasHpf && !hasSection) throw Error('필수 HWPX 구성 요소가 없습니다.');
  for (const [name, value] of Object.entries(entries)) {
    if (!/\.(xml|hpf)$/i.test(name)) continue;
    const xml = decode(value);
    if (/<!ENTITY\s+[^>]+(?:SYSTEM|PUBLIC)/i.test(xml)) throw Error('외부 엔티티가 있는 XML은 보안상 지원하지 않습니다.');
    const parser = new DOMParser({ onError: () => {} });
    parser.parseFromString(xml, 'application/xml');
  }
}
export async function readDigest(path: string): Promise<string | null> {
  try { return digest(await readFile(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function atomicSave(path: string, bytes: Uint8Array, expected: string | null | undefined, backup = true): Promise<void> {
  const current = await readDigest(path);
  if (expected !== undefined && current !== expected) throw Error('파일이 외부에서 변경되었습니다. 다시 열거나 다른 이름으로 저장해 주세요.');
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    if (backup && current !== null) {
      try { await copyFile(path, `${path}.hanul-backup`, constants.COPYFILE_EXCL); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (await readDigest(path) !== current) throw Error('저장 중 파일이 외부에서 변경되었습니다. 원본을 유지했습니다.');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
