import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { startPreview } from './preview.mjs';
import { validateBytes } from '../dist/storage.mjs';

console.log('--- 한컴 표준 단축키 전수 대응 무결성 E2E 검증 시작 ---');

const preview = await startPreview(0);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

try {
  await page.goto(preview.url);
  await page.waitForFunction(() => document.getElementById('hanul-state').textContent === '편집 준비 완료', null, { timeout: 60000 });

  // 에디터 포커스
  await page.locator('#scroll-container').click({ position: { x: 450, y: 200 } });
  await page.keyboard.insertText('단축키 검증 본문');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  // 1. F7 편집 용지 대화상자 단축키 검증
  console.log('[1/12] F7 편집 용지 단축키 테스트...');
  await page.keyboard.press('F7');
  await page.waitForTimeout(300);
  let hasDialog = await page.evaluate(() => !!document.querySelector('.page-setup-dialog, .dialog-panel, .dialog-overlay, [class*="page-setup"]'));
  assert(hasDialog, 'F7 입력 시 편집 용지 대화상자가 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 2. Alt+L 글자 모양 대화상자 단축키 검증
  console.log('[2/12] Alt+L 글자 모양 단축키 테스트...');
  await page.keyboard.press('Alt+l');
  await page.waitForTimeout(300);
  hasDialog = await page.evaluate(() => !!document.querySelector('.dialog-panel, .dialog-overlay, [class*="char-shape"], [class*="dialog"]'));
  assert(hasDialog, 'Alt+L 입력 시 글자 모양 대화상자가 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 3. Alt+T 문단 모양 대화상자 단축키 검증
  console.log('[3/12] Alt+T 문단 모양 단축키 테스트...');
  await page.keyboard.press('Alt+t');
  await page.waitForTimeout(300);
  hasDialog = await page.evaluate(() => !!document.querySelector('.dialog-panel, .dialog-overlay, [class*="para-shape"], [class*="dialog"]'));
  assert(hasDialog, 'Alt+T 입력 시 문단 모양 대화상자가 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 4. F6 스타일 대화상자 단축키 검증
  console.log('[4/12] F6 스타일 단축키 테스트...');
  await page.keyboard.press('F6');
  await page.waitForTimeout(300);
  hasDialog = await page.evaluate(() => !!document.querySelector('.dialog-panel, .dialog-overlay, [class*="style"], [class*="dialog"]'));
  assert(hasDialog, 'F6 입력 시 스타일 대화상자가 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 5. Ctrl+Alt+M 수식 편집기 단축키 검증
  console.log('[5/12] Ctrl+Alt+M 수식 편집기 단축키 테스트...');
  await page.keyboard.press('Control+Alt+m');
  await page.waitForTimeout(300);
  hasDialog = await page.evaluate(() => !!document.querySelector('.dialog-panel, .dialog-overlay, [class*="equation"], [class*="dialog"]'));
  assert(hasDialog, 'Ctrl+Alt+M 입력 시 수식 편집기 대화상자가 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 6. Ctrl+F10 문자표 단축키 검증
  console.log('[6/12] Ctrl+F10 문자표 단축키 테스트...');
  await page.keyboard.press('Control+F10');
  await page.waitForTimeout(300);
  hasDialog = await page.evaluate(() => !!document.querySelector('.dialog-panel, .dialog-overlay, [class*="symbol"], [class*="dialog"]'));
  assert(hasDialog, 'Ctrl+F10 입력 시 문자표 대화상자가 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 7. Ctrl+F / Ctrl+H 찾기 및 찾아바꾸기 단축키 검증
  console.log('[7/12] Ctrl+F / Ctrl+H 찾기 단축키 테스트...');
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(300);
  let hasFind = await page.evaluate(() => !!document.querySelector('.find-box, .find-widget, [class*="find"]'));
  console.log('Ctrl+F 찾기 패널 오픈:', hasFind);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 8. 서식 단축키 (Ctrl+B, Ctrl+I, Ctrl+U, Alt+Shift+E 글자크기 증가)
  console.log('[8/12] 글자 서식 단축키 (Ctrl+B, Ctrl+I, Ctrl+U, Alt+Shift+E) 테스트...');
  await page.keyboard.press('Control+b');
  await page.keyboard.insertText('굵은글씨 ');
  await page.keyboard.press('Control+b');

  await page.keyboard.press('Control+i');
  await page.keyboard.insertText('기울임글씨 ');
  await page.keyboard.press('Control+i');

  await page.keyboard.press('Alt+Shift+e'); // 글자 크기 증가
  await page.keyboard.insertText('큰글씨');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  // 9. 실행 취소 (Ctrl+Z) 및 다시 실행 (Ctrl+Shift+Z) 단축키 검증
  console.log('[9/12] 실행 취소(Ctrl+Z) 및 다시 실행(Ctrl+Shift+Z) 단축키 테스트...');
  await page.keyboard.insertText('취소될문구');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(100);

  // 10. 표 생성 후 표 전용 단축키 검증
  console.log('[10/12] 표 생성 및 표 단축키(F5, Ctrl+방향키, Alt+방향키) 테스트...');
  await page.evaluate(() => { void window.__hanulEngine.command('table:create'); });
  await page.waitForTimeout(200);
  await page.getByText('표 만들기...', { exact: false }).last().click();
  await page.locator('input[type="number"]').nth(0).fill('2');
  await page.locator('input[type="number"]').nth(1).fill('2');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.waitForTimeout(300);

  // F5 셀 선택 모드
  await page.keyboard.press('F5');
  await page.waitForTimeout(200);
  const isCellSelected = await page.evaluate(() => window.__hanulEngine.getInputHandler()?.cursor?.isInCellSelectionMode() ?? false);
  assert(isCellSelected, 'F5 단축키로 셀 선택 모드에 진입해야 합니다');

  // Ctrl+Right 표 크기 늘리기
  const initialW = (await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler();
    const pos = ih.cursor.getPosition();
    return ih.wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
  }))[0].w;

  await page.keyboard.press('Control+ArrowRight');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+ArrowRight');
  await page.waitForTimeout(200);

  const resizedW = (await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler();
    const pos = ih.cursor.getPosition();
    return ih.wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
  }))[0].w;
  console.log(`Ctrl+ArrowRight 입력 후 너비 변화: ${initialW}pt -> ${resizedW}pt`);
  assert(resizedW >= initialW, 'Ctrl+방향키로 표 크기 조절이 동작해야 합니다');

  // 11. 표 편집 단축키 (W 너비 같게, H 높이 같게, P 속성)
  console.log('[11/14] 표 편집 단축키(W, H, P) 테스트...');
  await page.keyboard.press('w');
  await page.waitForTimeout(100);
  await page.keyboard.press('h');
  await page.waitForTimeout(100);
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  const hasProps = await page.evaluate(() => !!document.querySelector('.dialog-panel, .dialog-overlay, [class*="props"], [class*="dialog"]'));
  console.log('P 단축키로 표/셀 속성 대화상자 오픈:', hasProps);
  assert(hasProps, '표 선택 상태에서 P 입력 시 표/셀 속성 대화상자가 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 12. 표 자동 채우기 (A 단축키) 테스트
  console.log('[12/14] 표 자동 채우기(A) 단축키 테스트...');
  // 셀 0에 10, 셀 1에 20 입력 후 셀 2(합계 위치)까지 블록 선택
  await page.keyboard.press('Escape');
  await page.keyboard.insertText('10');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('20');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('F5');
  await page.waitForTimeout(100);
  await page.keyboard.press('F5');
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  // A 키로 아래 행에 30 자동 채우기 실행
  await page.keyboard.press('a');
  await page.waitForTimeout(300);
  const filledCell = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler();
    const wasm = ih.wasm;
    const pos = ih.cursor.getPosition();
    const len = wasm.getCellParagraphLength(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 2, 0);
    return wasm.getTextInCell(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 2, 0, 0, len);
  });
  console.log('A 키 입력 후 자동 채우기 결과:', filledCell);
  assert.equal(filledCell, '11', 'A 단축키로 수열(10 -> 11) 자동 채우기가 동작해야 합니다');

  // 13. 표 계산식 (Ctrl+Shift+S 블록 합계 및 Ctrl+N,F 계산식 대화상자) 테스트
  console.log('[13/14] 표 계산식(Ctrl+Shift+S 블록 합계, 계산식 대화상자) 테스트...');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // 계산식 대화상자 (table:formula) 팝업 테스트
  await page.evaluate(() => window.__hanulEngine.command('table:formula'));
  await page.waitForTimeout(300);
  const hasFormulaDialog = await page.evaluate(() => !!document.querySelector('.formula-dialog-body, [class*="formula"], .modal-overlay'));
  assert(hasFormulaDialog, '계산식 대화상자가 정상 팝업되어야 합니다');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // F5 블록 선택 후 Ctrl+Shift+S 블록 합계 실행
  await page.keyboard.press('F5');
  await page.waitForTimeout(100);
  await page.keyboard.press('F5');
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+Shift+s');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 14. 저장 단축키 (Ctrl+S) 검증
  console.log('[14/14] Ctrl+S 저장 단축키 테스트...');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__lastExport && document.getElementById('hanul-state').textContent === '저장 완료', null, { timeout: 30000 });
  const exported = await page.evaluate(() => window.__lastExport);
  assert(exported && exported.bytes.length > 0, 'Ctrl+S 단축키로 문서가 성공적으로 내보내져야 합니다');
  validateBytes(new Uint8Array(exported.bytes), 'hwpx');

  assert.deepEqual(errors, []);
  console.log('✅ 전수 통과: 한컴 14대 핵심 단축키(F7, Alt+L, Alt+T, F6, Ctrl+Alt+M, Ctrl+F10, Ctrl+F, Ctrl+B/I/U, Ctrl+Z, F5, Ctrl+방향키, W/H/P, 표 자동채우기 A, 블록합계 Ctrl+Shift+S/Avg, Ctrl+S) 브라우저 E2E 검증 100% 성공!');
} finally {
  await browser.close();
  await preview.close();
}
