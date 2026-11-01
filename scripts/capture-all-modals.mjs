import { chromium } from 'playwright';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startPreview } from './preview.mjs';

const ARTIFACT_DIR = '/Users/ywlee/.gemini/antigravity/brain/98a013cf-d54b-4dd5-8adf-fc564a36b27c/screenshots';
const REPO_DIR = resolve('docs/assets/screenshots');

mkdirSync(ARTIFACT_DIR, { recursive: true });
mkdirSync(REPO_DIR, { recursive: true });

async function saveScreenshot(page, filename, selector = null) {
  const artifactPath = `${ARTIFACT_DIR}/${filename}`;
  const repoPath = `${REPO_DIR}/${filename}`;
  
  if (selector) {
    const el = page.locator(selector).first();
    if (await el.isVisible()) {
      await el.screenshot({ path: artifactPath });
      copyFileSync(artifactPath, repoPath);
      console.log(`Saved element [${selector}] screenshot: ${filename}`);
      return;
    }
  }
  
  await page.screenshot({ path: artifactPath, fullPage: false });
  copyFileSync(artifactPath, repoPath);
  console.log(`Saved page screenshot: ${filename}`);
}

async function run() {
  console.log('🚀 한컴 UI/UX 및 모달 다이얼로그 전수 스크린샷 캡처 시작...');
  const preview = await startPreview(0);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2 // High-DPI Retina capture
  });

  const page = await context.newPage();

  try {
    await page.goto(preview.url);
    await page.waitForFunction(() => document.getElementById('hanul-state')?.textContent === '편집 준비 완료', null, { timeout: 30000 });
    await page.waitForTimeout(600);

    // 1. 메인 에디터 화면 (Glassmorphism Header, Ribbon, Ruler, Document Canvas, Status Bar)
    console.log('[1/15] 메인 에디터 화면 캡처...');
    // 본문에 안내 문구 입력
    await page.locator('#scroll-container').click({ position: { x: 450, y: 180 } });
    await page.keyboard.insertText('한울(Hanul) 차세대 크로스플랫폼 한글 위지윅(WYSIWYG) 에디터');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('macOS · Linux · Windows 100% 동일 렌더링 & 한컴 142대 표준 스펙 지원');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await saveScreenshot(page, '01_main_editor_ui.png');

    // 2. F7 편집 용지 대화상자
    console.log('[2/15] 편집 용지(F7) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('file:page-setup'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '02_page_setup_f7.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 3. Alt+L 글자 모양 대화상자
    console.log('[3/15] 글자 모양(Alt+L) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('format:char-shape'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '03_char_shape_alt_l.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 4. Alt+T 문단 모양 대화상자
    console.log('[4/15] 문단 모양(Alt+T) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('format:para-shape'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '04_para_shape_alt_t.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 5. F6 스타일 대화상자
    console.log('[5/15] 스타일(F6) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('format:style-dialog'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '05_style_dialog_f6.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 6. Ctrl+Alt+M 수식 편집기 대화상자
    console.log('[6/15] 수식 편집기(Ctrl+Alt+M) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('insert:equation'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '06_equation_ctrl_alt_m.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 7. Ctrl+F10 문자표(특수문자) 대화상자
    console.log('[7/15] 문자표(Ctrl+F10) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('insert:symbols'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '07_symbols_ctrl_f10.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 8. Ctrl+F 찾기 대화상자
    console.log('[8/15] 찾기(Ctrl+F) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('edit:find'));
    await page.waitForSelector('.find-dialog', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '08_find_replace_ctrl_f.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 9. 표 만들기 대화상자
    console.log('[9/15] 표 만들기 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('table:create'));
    await page.waitForTimeout(300);
    const tableMenuBtn = page.getByText('표 만들기...', { exact: false }).last();
    if (await tableMenuBtn.isVisible()) {
      await tableMenuBtn.click();
      await page.waitForTimeout(300);
      await saveScreenshot(page, '09_table_create_dialog.png');
      // 표 생성 완료
      await page.getByRole('button', { name: '만들기', exact: true }).click();
      await page.waitForTimeout(400);
    }

    // 10. 표 선택 시 상단 플로팅 글래스 HUD (Table Floating Glass HUD)
    console.log('[10/15] 표 선택 시 상단 플로팅 글래스 HUD...');
    await page.keyboard.press('F5');
    await page.waitForTimeout(400);
    await saveScreenshot(page, '10_table_floating_glass_hud.png');

    // 11. 표/셀 속성(P) 대화상자
    console.log('[11/15] 표/셀 속성(P) 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('table:cell-props'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '11_table_cell_props_p.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 12. 셀 테두리/배경 대화상자
    console.log('[12/15] 셀 테두리/배경 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('table:border-each'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '12_table_border_bg.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 13. 줄/칸 추가하기(Alt+Insert) 대화상자
    console.log('[13/15] 줄/칸 추가하기 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('table:insert-row-col'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '13_table_insert_row_col.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 14. 계산식 대화상자
    console.log('[14/15] 계산식 대화상자...');
    await page.evaluate(() => window.__hanulEngine.command('table:formula'));
    await page.waitForSelector('.modal-overlay', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '14_table_formula_dialog.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 15. 문서 구조 진단 보고서 글래스 모달
    console.log('[15/15] 문서 구조 진단 보고서 글래스 모달...');
    await page.evaluate(() => {
      // Trigger diagnosis warning modal
      window.__hanulShowWarningModal?.([
        { key: 'sec[0].para[2].tbl[0]', val: '너비 초과 (페이지 영역 102%)' },
        { key: 'sec[0].para[5].ctrl[0]', val: 'BehindText 도장 이미지 배치 완료' }
      ]);
    });
    await page.waitForSelector('#hanul-warning-modal', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await saveScreenshot(page, '15_doc_diagnosis_modal.png');

    console.log('🎉 총 15종의 UI/UX 및 모달 다이얼로그 스크린샷 캡처가 모두 완료되었습니다!');
  } finally {
    await browser.close();
    await preview.close();
  }
}

run().catch(err => {
  console.error('스크린샷 캡처 실패:', err);
  process.exit(1);
});
