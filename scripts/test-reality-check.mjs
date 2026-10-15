import { chromium } from 'playwright';
import { startPreview } from './preview.mjs';

const preview = await startPreview(0);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));

try {
  await page.goto(preview.url);
  await page.waitForFunction(() => document.getElementById('hanul-state').textContent === '편집 준비 완료', null, { timeout: 60000 });

  // 1. Check format copy command
  console.log('Testing edit:format-copy command...');
  const formatCopyResult = await page.evaluate(() => {
    try {
      const res = window.__hanulEngine.command('edit:format-copy');
      return { success: true, res };
    } catch (e) {
      return { success: false, error: e.message, stack: e.stack };
    }
  });
  console.log('formatCopyResult:', formatCopyResult);

  // 2. Check input handler methods
  const ihMethods = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    if (!ih) return 'no ih';
    return {
      hasPerformFormatCopy: typeof ih.performFormatCopy,
      hasFormatCopyState: ih.formatCopyState,
      cursorIsInCell: ih.cursor?.isInCell?.(),
      cursorPos: ih.cursor?.getPosition?.()
    };
  });
  console.log('ihMethods:', ihMethods);

  // 3. Create a table and test F5 and Alt+C in cell
  await page.evaluate(() => { void window.__hanulEngine.command('table:create'); });
  await page.waitForTimeout(300);
  await page.getByText('표 만들기...', { exact: false }).last().click();
  await page.locator('input[type="number"]').nth(0).fill('2');
  await page.locator('input[type="number"]').nth(1).fill('2');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.waitForTimeout(300);

  // Now cursor is in table cell
  const inCellCheck = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    return {
      isInCell: ih?.cursor?.isInCell?.(),
      isInCellSelection: ih?.cursor?.isInCellSelectionMode?.(),
      phase: ih?.cursor?.getCellSelectionPhase?.()
    };
  });
  console.log('inCellCheck:', inCellCheck);

  // Test Alt+C in cell
  await page.keyboard.press('Alt+c');
  await page.waitForTimeout(200);

  const afterAltC = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    return {
      formatCopyState: ih?.formatCopyState,
      hasNotice: document.getElementById('hanul-notice')?.textContent
    };
  });
  console.log('afterAltC:', afterAltC);

  // Test F5
  await page.keyboard.press('F5');
  await page.waitForTimeout(200);
  const afterF5 = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    return {
      isInCellSelection: ih?.cursor?.isInCellSelectionMode?.(),
      phase: ih?.cursor?.getCellSelectionPhase?.(),
      notice: document.getElementById('hanul-notice')?.textContent
    };
  });
  console.log('afterF5:', afterF5);

  console.log('Recent logs:', logs.slice(-10));
} finally {
  await browser.close();
  await preview.close();
}
