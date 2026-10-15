import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const artifactsDir = path.resolve('artifacts');

if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
}

const outFile = path.join(artifactsDir, `hanul-hwpx-${version}.vsix`);

console.log(`📦 VSIX 패키징 시작 (버전: ${version})...`);

const res = spawnSync('npx', [
  '@vscode/vsce',
  'package',
  '--no-dependencies',
  '--allow-missing-repository',
  '--out',
  outFile
], { stdio: 'inherit' });

if (res.status !== 0) {
  process.exit(res.status || 1);
}

// 편의를 위해 고정 파일명으로도 복사
const fixedOut = path.join(artifactsDir, 'hanul-hwpx.vsix');
fs.copyFileSync(outFile, fixedOut);

console.log(`✅ 패키징 완료: ${outFile}`);
