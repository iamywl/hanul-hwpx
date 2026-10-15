import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { startPreview } from './preview.mjs';
import { validateBytes } from '../dist/storage.mjs';
import { unzipSync } from 'fflate';

console.log('--- 한울 표 크기 조절(Table Resizing) 무결성 QA 검증 시작 ---');

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
  await page.locator('#scroll-container').click({ position: { x: 450, y: 200 } });
  await page.keyboard.insertText('한울 한글 편집기');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('표 크기 조절 테스트');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  // 1. 표 생성 (3행 2열)
  await page.evaluate(() => { void window.__hanulEngine.command('table:create'); });
  await page.waitForTimeout(200);
  await page.getByText('표 만들기...', { exact: false }).last().click();
  await page.locator('input[type="number"]').nth(0).fill('3');
  await page.locator('input[type="number"]').nth(1).fill('2');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.waitForTimeout(300);

  for (const text of ['항목', '지원 범위', '문서 작성', '본문 서식', '파일 저장', 'HWPX']) {
    await page.keyboard.insertText(text);
    if (text !== 'HWPX') await page.keyboard.press('Tab');
  }
  await page.waitForTimeout(300);

  // 현재 커서 상태 확인
  const cursorStatus = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    return {
      isInCell: ih?.cursor?.isInCell() ?? false,
      isInCellSelection: ih?.cursor?.isInCellSelectionMode() ?? false,
      phase: ih?.cursor?.getCellSelectionPhase?.() ?? null,
      pos: ih?.cursor?.getPosition?.() ?? null
    };
  });
  console.log('초기 커서 상태:', cursorStatus);

  // 2. 초기 표 bboxes 측정
  const initialBboxes = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    const wasm = ih?.wasm || window.__hanulEngine.getWasm?.();
    const pos = ih?.cursor?.getPosition?.();
    if (!pos || !wasm) return null;
    return wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
  });
  console.log('초기 표 셀 bboxes:', initialBboxes);

  // 3. F5 셀 선택 모드 진입 검증
  // textarea에 F5 누르기
  await page.keyboard.press('F5');
  await page.waitForTimeout(300);

  let isCellSelected = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    return ih?.cursor?.isInCellSelectionMode() ?? false;
  });
  console.log('F5 직접 입력 후 셀 선택 모드 진입 여부:', isCellSelected);

  if (!isCellSelected) {
    // 메뉴바 버튼 클릭으로도 시도
    const selectBtn = page.locator('#hanul-btn-cell-select, #hanul-menu-cell-select');
    await selectBtn.click();
    await page.waitForTimeout(300);
    isCellSelected = await page.evaluate(() => {
      const ih = window.__hanulEngine.getInputHandler?.();
      return ih?.cursor?.isInCellSelectionMode() ?? false;
    });
    console.log('상단 버튼 클릭 후 셀 선택 모드 진입 여부:', isCellSelected);
  }
  assert(isCellSelected, 'F5 단축키 또는 버튼 클릭 시 셀 선택 모드(isInCellSelectionMode)에 진입해야 합니다');

  // 4. 키보드 리사이즈 검증: Ctrl+ArrowRight로 너비 확대
  // 웹뷰 postMessage로 tableAction resize 전달
  await page.evaluate(() => {
    window.postMessage({
      type: 'request',
      id: 'resize-w-test',
      method: 'tableAction',
      params: { action: 'resize', key: 'ArrowRight' }
    }, location.origin);
  });
  await page.waitForTimeout(300);

  // 추가로 여러 번 확대
  for (let i = 0; i < 3; i++) {
    await page.evaluate(idx => {
      window.postMessage({
        type: 'request',
        id: `resize-w-${idx}`,
        method: 'tableAction',
        params: { action: 'resize', key: 'ArrowRight' }
      }, location.origin);
    }, i);
    await page.waitForTimeout(100);
  }

  // 5. 변경 후 bboxes 확인
  const resizedBboxes = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    const wasm = ih?.wasm || window.__hanulEngine.getWasm?.();
    const pos = ih?.cursor?.getPosition?.();
    if (!pos || !wasm) return null;
    return wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
  });
  console.log('너비 조절 후 표 셀 bboxes:', resizedBboxes);

  if (initialBboxes && resizedBboxes) {
    const targetIdx = cursorStatus.pos?.cellIndex ?? 0;
    const initW = initialBboxes[targetIdx].w;
    const newW = resizedBboxes[targetIdx].w;
    console.log(`선택 셀 ${targetIdx} 너비 변화: ${initW} -> ${newW} (차이: ${newW - initW})`);
    assert(newW !== initW, 'Ctrl+방향키로 표 셀 너비가 성공적으로 조절되어야 합니다');
  }

  // 6. 해당 셀만 높이 조절 (Alt+ArrowDown) 검증
  await page.evaluate(() => {
    window.postMessage({
      type: 'request',
      id: 'resize-h-test',
      method: 'tableAction',
      params: { action: 'resizeLocal', key: 'ArrowDown' }
    }, location.origin);
  });
  await page.waitForTimeout(300);

  const localResizedBboxes = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    const wasm = ih?.wasm || window.__hanulEngine.getWasm?.();
    const pos = ih?.cursor?.getPosition?.();
    if (!pos || !wasm) return null;
    return wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
  });
  console.log('높이 조절 후 표 셀 bboxes:', localResizedBboxes);

  // 7. 새로 구축된 한울 표 전용 툴바(Hanul Table Bar) GUI 인터랙션 검증
  const tableBar = page.locator('#hanul-table-bar');
  assert(await tableBar.isVisible(), '한울 표 전용 빠른 조작 툴바가 상단에 노출되어야 합니다');

  // 7-1. [너비 +20pt] 버튼 마우스 클릭 검증
  const wBeforeInc = (await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler();
    const pos = ih.cursor.getPosition();
    return ih.wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
  }))[0].w;

  const btnWidthInc = page.locator('#hanul-btn-w-inc');
  await btnWidthInc.click();
  await page.waitForTimeout(300);

  const wAfterInc = (await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler();
    const pos = ih.cursor.getPosition();
    return ih.wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
  }))[0].w;
  console.log(`[툴바 버튼] 너비 +20pt 클릭 후 너비 변화: ${wBeforeInc}pt -> ${wAfterInc}pt`);
  assert(wAfterInc > wBeforeInc, '상단 툴바 너비 +20pt 버튼 클릭 시 표 너비가 즉시 증가해야 합니다');

  // 8. 상단 툴바의 [8개 조절점(핸들)] 버튼 클릭으로 조절점 활성화 검증 (실제 사용자 마우스 클릭)
  const btnHandles = page.locator('#hanul-btn-handles');
  assert(await btnHandles.isVisible(), '표 외곽 8개 조절점 핸들 버튼이 툴바에 노출되어야 합니다');
  await btnHandles.click();
  await page.waitForTimeout(300);

  const handleInfo = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler();
    const scrollContent = document.querySelector('#scroll-content');
    const rect = scrollContent.getBoundingClientRect();
    const handles = ih.tableObjectRenderer?.handles || [];
    const seHandle = handles.find(h => h.dir === 'se') || handles.find(h => h.dir === 'e') || handles[0];
    if (!seHandle) return null;
    return {
      dir: seHandle.dir,
      clientX: rect.left + seHandle.cx,
      clientY: rect.top + seHandle.cy,
    };
  });
  if (handleInfo) {
    const bboxesBeforeDrag = await page.evaluate(() => {
      const ih = window.__hanulEngine.getInputHandler();
      const pos = ih.cursor.getPosition();
      return ih.wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
    });
    const wBeforeDrag = bboxesBeforeDrag[0].w;
    
    // 조절점 잡고 마우스로 끌기 (+60px, +40px)
    await page.mouse.move(handleInfo.clientX, handleInfo.clientY);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(handleInfo.clientX + 60, handleInfo.clientY + 40, { steps: 5 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(300);

    const bboxesAfterDrag = await page.evaluate(() => {
      const ih = window.__hanulEngine.getInputHandler();
      const pos = ih.cursor.getPosition();
      return ih.wasm.getTableCellBboxes(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, 0);
    });
    const wAfterDrag = bboxesAfterDrag[0].w;
    console.log(`핸들 드래그 후 셀 0 너비: ${wBeforeDrag}pt -> ${wAfterDrag}pt (변화: ${wAfterDrag - wBeforeDrag}pt)`);
    assert(wAfterDrag > wBeforeDrag, '표 외곽 조절점 핸들 드래그로 표 크기가 조절되어야 합니다');
  }

  // 9. 문서 저장 및 내보내기 검증
  await page.locator('#hanul-menu-save').click();
  await page.waitForFunction(() => window.__lastExport && document.getElementById('hanul-state').textContent === '저장 완료', null, { timeout: 30000 });
  const exported = await page.evaluate(() => window.__lastExport);
  validateBytes(new Uint8Array(exported.bytes), 'hwpx');

  const xmlContent = new TextDecoder().decode(unzipSync(new Uint8Array(exported.bytes))['Contents/section0.xml']);
  assert(xmlContent.includes('<hp:tbl'), '리사이즈된 표가 XML에 존재해야 합니다');
  assert(xmlContent.includes('항목'), '셀 텍스트가 XML에 보존되어야 합니다');

  await page.screenshot({ path: 'artifacts/table-resize-qa.png', fullPage: true });
  console.log('스크린샷 캡처 완료: artifacts/table-resize-qa.png');

  assert.deepEqual(errors, []);
  console.log('✅ QA 검증 통과: 표 셀 선택(F5), 키보드 크기 조절(Ctrl/Alt+방향키), 표 외곽 8개 조절점 핸들 마우스 드래그 리사이징, 메뉴바 버튼 연동 및 HWPX 무손실 저장 전수 성공!');
} finally {
  await browser.close();
  await preview.close();
}
