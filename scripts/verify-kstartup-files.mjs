import { readdirSync, statSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { openDocument } from '../dist/core.mjs';
import { startPreview } from './preview.mjs';
import { chromium } from 'playwright';

const KSTARTUP_DIR = '/Users/ywlee/sideproejct/K_startup';
const ARTIFACT_DIR = '/Users/ywlee/.gemini/antigravity/brain/98a013cf-d54b-4dd5-8adf-fc564a36b27c/screenshots/kstartup';
const REPO_DIR = resolve('docs/assets/screenshots/kstartup');

mkdirSync(ARTIFACT_DIR, { recursive: true });
mkdirSync(REPO_DIR, { recursive: true });

function findFiles(dir, exts = ['.hwpx', '.hwp']) {
  let results = [];
  try {
    const list = readdirSync(dir);
    for (const file of list) {
      if (file.startsWith('.')) continue;
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results = results.concat(findFiles(fullPath, exts));
      } else if (exts.some(ext => file.toLowerCase().endsWith(ext))) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    console.error(`디렉토리 접근 에러 [${dir}]:`, e.message);
  }
  return results;
}

async function run() {
  console.log('================================================================');
  console.log('📂 K_startup 실제 실무 한글(HWPX / HWP) 문서 전수 호환성 실측');
  console.log('================================================================\n');

  const files = findFiles(KSTARTUP_DIR);
  console.log(`발견된 총 파일 수: ${files.length}개\n`);

  const report = [];
  let hwpxSuccess = 0, hwpxFail = 0;
  let hwpSuccess = 0, hwpFail = 0;

  // 1단계: 코어 엔진 바이너리 & XML 파싱 실측
  for (const filePath of files) {
    const name = basename(filePath);
    const isHwpx = name.toLowerCase().endsWith('.hwpx');
    try {
      const doc = openDocument(filePath);
      const row = {
        name,
        type: isHwpx ? 'HWPX' : 'HWP',
        status: '🟢 성공',
        paragraphs: doc.paragraphs?.length || 0,
        tables: doc.tables?.length || 0,
        images: doc.images?.length || 0,
        textLen: doc.fullText?.length || 0,
        detail: `문단 ${doc.paragraphs?.length || 0}개, 표 ${doc.tables?.length || 0}개, 이미지 ${doc.images?.length || 0}개`
      };
      report.push(row);
      if (isHwpx) hwpxSuccess++; else hwpSuccess++;
    } catch (err) {
      const row = {
        name,
        type: isHwpx ? 'HWPX' : 'HWP',
        status: '🔴 실패',
        paragraphs: 0,
        tables: 0,
        images: 0,
        textLen: 0,
        detail: err.message
      };
      report.push(row);
      if (isHwpx) hwpxFail++; else hwpFail++;
    }
  }

  console.table(report.map(r => ({
    '파일명': r.name.length > 35 ? r.name.slice(0, 32) + '...' : r.name,
    '포맷': r.type,
    '상태': r.status,
    '문단': r.paragraphs,
    '표': r.tables,
    '이미지': r.images,
    '글자수': r.textLen
  })));

  console.log(`\n📊 1단계 코어 엔진 파싱 실측 결과:`);
  console.log(`   - HWPX 문서: 성공 ${hwpxSuccess}개 / 실패 ${hwpxFail}개 (성공률: ${((hwpxSuccess / (hwpxSuccess + hwpxFail || 1)) * 100).toFixed(1)}%)`);
  console.log(`   - HWP 문서:  성공 ${hwpSuccess}개 / 실패 ${hwpFail}개 (성공률: ${((hwpSuccess / (hwpSuccess + hwpFail || 1)) * 100).toFixed(1)}%)`);

  // 2단계: 실제 브라우저/위지윅 에디터 렌더링 실측 및 스크린샷 캡처
  console.log('\n================================================================');
  console.log('🖥️ 2단계: Hanul 위지윅 캔버스 실물 렌더링 및 스크린샷 캡처 실측');
  console.log('================================================================\n');

  // 실물 렌더링 실측 대상: K_startup 내 모든 HWPX 문서 (18개 전수 렌더링)
  const targetFiles = files.filter(f => f.toLowerCase().endsWith('.hwpx'));
  console.log(`선정된 실물 렌더링 실측 대상: ${targetFiles.length}개 HWPX 파일 전수 렌더링`);

  const preview = await startPreview(0);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });

  const renderResults = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
      deviceScaleFactor: 2
    });

    const page = await context.newPage();
    await page.goto(preview.url);
    await page.waitForFunction(() => document.getElementById('hanul-state')?.textContent === '편집 준비 완료', null, { timeout: 30000 });

    for (let i = 0; i < targetFiles.length; i++) {
      const filePath = targetFiles[i];
      const fileName = basename(filePath).normalize('NFC');
      console.log(`\n[${i + 1}/${targetFiles.length}] 렌더링 실측: ${fileName}`);

      try {
        // HTTP 스트리밍으로 바이너리를 브라우저 WebAssembly 메모리에 직접 주입 (OOM 방지)
        const loadResult = await page.evaluate(async ({ targetPath, name }) => {
          const resp = await fetch(`/api/file?path=${encodeURIComponent(targetPath)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status} 파일 로드 실패`);
          const ab = await resp.arrayBuffer();
          const bytes = new Uint8Array(ab);
          return await window.__hanulEngine.load(bytes, name);
        }, { targetPath: filePath, name: fileName });

        // 렌더링 완료 대기
        await page.waitForTimeout(600);

        // 캔버스 페이지 및 DOM 통계 추출
        const stats = await page.evaluate(() => {
          const info = window.__hanulEngine.info();
          const stateEl = document.getElementById('hanul-state');
          return {
            pages: info.pages,
            format: info.format,
            statusText: stateEl ? stateEl.textContent : ''
          };
        });

        console.log(`   ➔ 렌더링 완료: ${stats.pages}페이지 [${stats.format.toUpperCase()}], 상태: "${stats.statusText}"`);
        renderResults.push({ name: fileName, pages: stats.pages, format: stats.format, success: true });

        // 스크린샷 캡처
        const safeName = fileName.replace(/[^a-zA-Z0-9가-힣_.-]/g, '_');
        const screenshotFilename = `kstartup_hwpx_${String(i + 1).padStart(2, '0')}_${safeName}.png`;
        const artifactPath = `${ARTIFACT_DIR}/${screenshotFilename}`;
        const repoPath = `${REPO_DIR}/${screenshotFilename}`;

        await page.screenshot({ path: artifactPath, fullPage: false });
        copyFileSync(artifactPath, repoPath);
        console.log(`   📸 스크린샷 증거 확보: ${screenshotFilename}`);
      } catch (renderErr) {
        console.error(`   ❌ 렌더링 실패: ${renderErr.message}`);
        renderResults.push({ name: fileName, pages: 0, format: 'HWPX', success: false, error: renderErr.message });
      }
    }

    await context.close();
  } finally {
    await browser.close();
    preview.server.close();
  }

  console.log('\n================================================================');
  console.log('📊 2단계 Hanul 위지윅 렌더링 전수 결과 집계');
  console.log('================================================================');
  console.table(renderResults);
  const successCount = renderResults.filter(r => r.success).length;
  console.log(`\n결과: 렌더링 성공 ${successCount} / ${renderResults.length} (${((successCount / renderResults.length) * 100).toFixed(1)}%)`);

  console.log('\n================================================================');
  console.log('✅ K_startup 실무 HWPX 문서 전수 실측 및 비주얼 검증 완료');
  console.log('================================================================');
}

run().catch(err => {
  console.error('\n❌ 실측 중 치명적 오류 발생:', err);
  process.exit(1);
});
