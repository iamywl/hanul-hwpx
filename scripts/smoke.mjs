import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startPreview } from './preview.mjs';
import { validateBytes } from '../dist/storage.mjs';
import { unzipSync } from 'fflate';

const preview = await startPreview(0);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') console.log('BROWSER', m.text().slice(0, 400)); });
page.on('requestfailed', r => console.log('FAILED', r.url(), r.failure()?.errorText));
page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
await page.route('**/*', route => new URL(route.request().url()).origin === preview.url ? route.continue() : route.abort());
try {
  await page.goto(preview.url);
  await page.waitForFunction(() => document.getElementById('hanul-state').textContent === '편집 준비 완료', null, { timeout: 60000 });
  console.log('ENGINE READY', await page.evaluate(() => window.__hanulEngine.info()));
  await page.screenshot({ path: 'artifacts/editor-empty.png', fullPage: true });
  await page.locator('#scroll-container').click({ position: { x: 450, y: 200 } });
  await page.keyboard.insertText('한울 한글 편집기');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Control+b');
  await page.locator('#font-size').fill('22');
  await page.locator('#font-size').press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+b');
  await page.locator('#font-size').fill('11');
  await page.locator('#font-size').press('Enter');
  await page.keyboard.insertText('한컴 설치 없이 문서를 작성하고 저장합니다.');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('본문과 표를 수정하고, 저장한 파일을 다시 열어 확인하세요.');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('실행 취소 확인');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+z');
  await page.evaluate(() => { void window.__hanulEngine.command('table:create'); });
  await page.waitForTimeout(200);
  await page.getByText('표 만들기...', { exact: false }).last().click();
  await page.locator('input[type="number"]').nth(0).fill('3');
  await page.locator('input[type="number"]').nth(1).fill('2');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.waitForTimeout(200);
  for (const text of ['항목', '지원 범위', '문서 작성', '본문 · 표 · 기본 서식', '파일 저장', 'HWPX · HWP']) {
    await page.keyboard.insertText(text);
    if (text !== 'HWPX · HWP') await page.keyboard.press('Tab');
  }
  // F7 편집용지 대화상자 GUI 노출 및 팝업 검증
  const pageSetupBtn = page.locator('#hanul-btn-page-setup');
  assert(await pageSetupBtn.isVisible(), '편집용지(F7) 버튼이 툴바에 노출되어야 합니다');
  await pageSetupBtn.click();
  await page.waitForTimeout(300);
  const hasDialog = await page.evaluate(() => {
    return !!document.querySelector('.page-setup-dialog, .dialog-panel, .dialog-overlay, .modal-dialog, [class*="dialog"]');
  });
  console.log('F7 편집용지 대화상자 팝업 여부:', hasDialog);
  assert(hasDialog, 'F7 편집용지 대화상자가 화면에 정상 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  console.log('STATE', await page.locator('#hanul-state').innerText());
  await page.locator('#hanul-menu-save').click();
  await page.waitForFunction(() => window.__lastExport && document.getElementById('hanul-state').textContent === '저장 완료', null, { timeout: 30000 });
  const exported = await page.evaluate(() => window.__lastExport);
  assert(exported.version > 0, 'Typing must mark document dirty');
  validateBytes(new Uint8Array(exported.bytes), 'hwpx');
  const before = new TextDecoder().decode(unzipSync(new Uint8Array(exported.bytes))['Contents/section0.xml']);
  assert(before.includes('<hp:tbl'), 'Created table must be serialized');
  assert(before.includes('지원 범위'), 'Table cell text must be serialized');
  assert(!before.includes('실행 취소 확인'), 'Undo must remove test text');
  await mkdir('templates', { recursive: true });
  await writeFile('templates/report.hwpx', new Uint8Array(exported.bytes));
  await page.evaluate(bytes => window.postMessage({ type: 'request', id: 'reload-test', method: 'load', params: { bytes, name: '재열기.hwpx' } }, location.origin), exported.bytes);
  await page.waitForFunction(() => window.__previewMessages.some(m => m.type === 'response' && m.id === 'reload-test'), null, { timeout: 30000 });
  const reply = await page.evaluate(() => window.__previewMessages.find(m => m.type === 'response' && m.id === 'reload-test'));
  assert(!reply.error, reply.error);
  const roundtrip = await page.evaluate(() => window.__hanulEngine.export('hwpx'));
  const section = new TextDecoder().decode(unzipSync(new Uint8Array(roundtrip))['Contents/section0.xml']);
  assert(section.includes('한울 한글 편집기'), 'Saved text must survive reload');
  assert(section.includes('지원 범위'), 'Table cell text must survive reload');
  const hwp = await page.evaluate(() => window.__hanulEngine.export('hwp'));
  validateBytes(new Uint8Array(hwp), 'hwp');
  await page.evaluate(bytes => window.postMessage({ type: 'request', id: 'hwp-test', method: 'load', params: { bytes, name: '호환성.hwp' } }, location.origin), hwp);
  await page.waitForFunction(() => window.__previewMessages.some(m => m.type === 'response' && m.id === 'hwp-test'), null, { timeout: 30000 });
  const hwpReply = await page.evaluate(() => window.__previewMessages.find(m => m.type === 'response' && m.id === 'hwp-test'));
  assert(!hwpReply.error, hwpReply.error);
  const hwpRoundtrip = await page.evaluate(() => window.__hanulEngine.export('hwpx'));
  assert(new TextDecoder().decode(unzipSync(new Uint8Array(hwpRoundtrip))['Contents/section0.xml']).includes('지원 범위'), 'Table text must survive HWP conversion');
  await page.evaluate(bytes => window.postMessage({ type: 'request', id: 'restore-test', method: 'load', params: { bytes, name: '복구.hwpx', restored: true } }, location.origin), exported.bytes);
  await page.waitForFunction(() => window.__previewMessages.some(m => m.type === 'response' && m.id === 'restore-test'));
  await page.locator('#hanul-menu-save').click();
  await page.waitForFunction(() => window.__lastExport?.version === 1 && document.getElementById('hanul-state').textContent === '저장 완료');
  await page.screenshot({ path: 'artifacts/editor-preview.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: offline initialization, Korean input, formatting, undo/redo, table creation/editing, HWPX save/reload, HWP export/reload.');
} finally { await browser.close(); await preview.close(); }
