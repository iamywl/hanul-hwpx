import { chromium } from 'playwright';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { startPreview } from './preview.mjs';
import { validateBytes } from '../dist/storage.mjs';

function findDocByHint(dir, hint, ext) {
  if (!existsSync(dir)) return null;
  const normalizedHint = hint.normalize('NFC');
  for (const entry of readdirSync(dir)) {
    const nfc = entry.normalize('NFC');
    if (nfc.endsWith(ext) && !nfc.endsWith('.hanul-backup') && nfc.includes(normalizedHint)) {
      return join(dir, entry);
    }
  }
  return null;
}

function parseRgb(colorStr) {
  const match = String(colorStr || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return { r: 0, g: 0, b: 0 };
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function relativeLuminance({ r, g, b }) {
  const [sR, sG, sB] = [r, g, b].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(parseRgb(c1));
  const l2 = relativeLuminance(parseRgb(c2));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function loadDocumentBytes(page, filePath) {
  const bytes = Array.from(readFileSync(filePath));
  const name = filePath.split('/').pop().normalize('NFC');
  const reqId = `load-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await page.evaluate(({ reqId, bytes, name }) => {
    window.postMessage({
      type: 'request',
      id: reqId,
      method: 'load',
      params: { bytes, name }
    }, location.origin);
  }, { reqId, bytes, name });

  await page.waitForFunction(
    id => window.__previewMessages?.some(m => m.type === 'response' && m.id === id),
    reqId,
    { timeout: 45000 }
  );
  const resp = await page.evaluate(id => window.__previewMessages.find(m => m.type === 'response' && m.id === id), reqId);
  assert(!resp.error, `문서 로드 실패 (${name}): ${resp.error}`);
  await page.waitForTimeout(250);
  return name;
}

async function findEditableCellClickTarget(page) {
  return await page.evaluate(() => {
    const ih = window.__hanulEngine?.getInputHandler?.();
    const wasm = ih?.wasm || window.__hanulEngine?.getWasm?.();
    const sc = ih?.container?.querySelector?.('#scroll-content') || document.getElementById('scroll-content');
    if (!ih || !wasm || !sc || !ih.virtualScroll || !ih.viewportManager) return null;

    const zoom = ih.viewportManager.getZoom();
    const s = sc.getBoundingClientRect();
    const pageLeft = ih.virtualScroll.getPageLeftResolved(0, sc.clientWidth);
    const pageOffset = ih.virtualScroll.getPageOffset(0);

    for (let ppi = 0; ppi < 40; ppi++) {
      for (let ci = 0; ci < 5; ci++) {
        let bboxes = null;
        try {
          bboxes = wasm.getTableCellBboxes(0, ppi, ci, 0);
        } catch {}
        if (!bboxes || !bboxes.length) continue;

        let tblBox = null;
        try { tblBox = wasm.getTableBBoxAtPage(0, ppi, ci, 0); } catch {}

        // Prefer interior cells (away from outer 5pt table border) with comfortable width/height
        const sorted = [...bboxes]
          .filter(b => b.pageIndex === 0 && b.w >= 24 && b.h >= 10)
          .sort((a, b) => (a.row === 0 ? 1 : 0) - (b.row === 0 ? 1 : 0));

        for (const b of sorted) {
          let isProt = false;
          try {
            isProt = wasm.getCellProperties(0, ppi, ci, b.cellIdx)?.cellProtect === true;
          } catch {}
          if (isProt) continue;

          const pageX = b.x + b.w * 0.5;
          const pageY = b.y + b.h * 0.5;
          if (tblBox) {
            if (Math.abs(pageX - tblBox.x) <= 5.5 || Math.abs(pageX - (tblBox.x + tblBox.width)) <= 5.5) continue;
            if (Math.abs(pageY - tblBox.y) <= 5.5 || Math.abs(pageY - (tblBox.y + tblBox.height)) <= 5.5) continue;
          }

          const clientX = s.left + pageLeft + pageX * zoom;
          const clientY = s.top + pageOffset + pageY * zoom;
          if (clientX > 40 && clientY > 110 && clientX < window.innerWidth - 40 && clientY < window.innerHeight - 40) {
            return { ppi, ci, cellIdx: b.cellIdx, clientX, clientY, bbox: b };
          }
        }
      }
    }
    return null;
  });
}

const kstartupDir = '/Users/ywlee/sideproejct/K_startup/03_reports';
const fixturesDir = resolve('tests/fixtures');

const hwpCandidates = [
  findDocByHint(kstartupDir, '거래명세서 (2)', '.hwp'),
  findDocByHint(kstartupDir, '창업동아리 양식', '.hwp'),
  findDocByHint(fixturesDir, '2026애니참가신청서', '.hwp'),
  findDocByHint(fixturesDir, '인터뷰 진행 양식', '.hwp'),
].filter(Boolean);

const hwpxCandidates = [
  findDocByHint(kstartupDir, '외주용역서류 (2) 복사본', '.hwpx'),
  findDocByHint(fixturesDir, '공고문(양주 나리농원', '.hwpx'),
].filter(Boolean);

assert(hwpCandidates.length >= 2, '검증용 실제 .hwp 파일이 최소 2개 이상 필요합니다.');
assert(hwpxCandidates.length >= 1, '검증용 실제 .hwpx 파일이 최소 1개 이상 필요합니다.');

const preview = await startPreview(0);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
});

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark'
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(preview.url);
  await page.waitForFunction(() => document.getElementById('hanul-state')?.textContent === '편집 준비 완료', null, { timeout: 45000 });

  console.log('=== [1/5] 실제 .hwp 문서 마우스 클릭(플로팅 표 포함) & 단일 문자(A/W/H/M/S/P + 한글 자모) 타이핑 검증 ===');
  for (const hwpPath of hwpCandidates.slice(0, 3)) {
    const docName = await loadDocumentBytes(page, hwpPath);
    const target = await findEditableCellClickTarget(page);
    assert(target, `${docName}: 편집 가능한 표 셀 좌표를 찾지 못했습니다.`);

    // 실제 마우스 클릭!
    await page.mouse.click(target.clientX, target.clientY);
    await page.waitForTimeout(150);

    const clickState = await page.evaluate(() => {
      const ih = window.__hanulEngine?.getInputHandler?.();
      return {
        active: !!ih?.active,
        inPicObj: !!ih?.isInPictureObjectSelection?.(),
        inTableObj: !!ih?.cursor?.isInTableObjectSelection?.(),
        inCell: !!ih?.cursor?.isInCell?.(),
        inCellSel: !!ih?.cursor?.isInCellSelectionMode?.(),
      };
    });
    console.log(`  📄 [${docName}] 셀 클릭 직후 상태:`, clickState);
    assert.equal(clickState.inPicObj, false, `${docName}: 플로팅 표 셀 클릭이 그림 개체 선택으로 납치되면 안 됩니다!`);
    assert.equal(clickState.inTableObj, false, `${docName}: 일반 셀 클릭이 표 개체 선택으로 납치되면 안 됩니다!`);
    assert.equal(clickState.inCell, true, `${docName}: 셀 내부에 텍스트 커서가 배치되어야 합니다!`);
    assert.equal(clickState.active, true, `${docName}: InputHandler가 활성 상태여야 합니다!`);

    // 실제 키보드 keydown 이벤트로 단일 알파벳(a,w,h,m,s,p 포함) 타이핑!
    const marker = `HANUL_awhmsp_${Math.floor(Math.random() * 900 + 100)}`;
    await page.keyboard.type(marker);
    await page.waitForTimeout(100);

    // 한글 두벌식 자모 keydown 가로채기 여부 검증 (KeyA='ㅁ', KeyW='ㅈ', KeyH='ㅗ', KeyM='ㅡ', KeyS='ㄴ', KeyP='ㅔ')
    const jamoNotPrevented = await page.evaluate(() => {
      const ta = window.__hanulEngine.getInputHandler().textarea;
      ta.focus();
      const pairs = [
        ['ㅁ', 'KeyA'], ['ㅈ', 'KeyW'], ['ㅗ', 'KeyH'],
        ['ㅡ', 'KeyM'], ['ㄴ', 'KeyS'], ['ㅔ', 'KeyP']
      ];
      return pairs.every(([key, code]) => {
        const ev = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
        return ta.dispatchEvent(ev) === true; // preventDefault가 호출되지 않아야 true
      });
    });
    assert.equal(jamoNotPrevented, true, `${docName}: 표 셀 텍스트 입력 중 한글 자모(ㅁ/ㅈ/ㅗ/ㅡ/ㄴ/ㅔ) keydown이 차단되면 안 됩니다!`);

    // Shift + ArrowLeft 텍스트 범위 선택 검증 (셀 경계선 이동으로 납치 금지!)
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    const shiftSelState = await page.evaluate(() => {
      const ih = window.__hanulEngine.getInputHandler();
      return {
        inCellSel: !!ih.cursor.isInCellSelectionMode(),
        hasTextSel: !!ih.cursor.hasSelection?.(),
      };
    });
    assert.equal(shiftSelState.inCellSel, false, `${docName}: 셀 내부 Shift+ArrowLeft가 셀 선택 모드로 진입하면 안 됩니다!`);
    assert.equal(shiftSelState.hasTextSel, true, `${docName}: 셀 내부 Shift+ArrowLeft로 텍스트 블록 선택이 되어야 합니다!`);

    // 선택 해제 후 HWP 포맷 무손실 저장 & 재열기 라운드트립 검증!
    await page.keyboard.press('ArrowRight');
    const exportedHwp = await page.evaluate(() => window.__hanulEngine.export('hwp'));
    validateBytes(new Uint8Array(exportedHwp), 'hwp');

    const reloadId = `reload-hwp-${Date.now()}`;
    await page.evaluate(({ id, bytes, name }) => {
      window.postMessage({ type: 'request', id, method: 'load', params: { bytes, name } }, location.origin);
    }, { id: reloadId, bytes: exportedHwp, name: docName });
    await page.waitForFunction(id => window.__previewMessages.some(m => m.type === 'response' && m.id === id), reloadId, { timeout: 30000 });

    const verifyHwpx = await page.evaluate(() => window.__hanulEngine.export('hwpx'));
    const unzipped = unzipSync(new Uint8Array(verifyHwpx));
    const allXml = Object.keys(unzipped)
      .filter(k => k.startsWith('Contents/section') && k.endsWith('.xml'))
      .map(k => new TextDecoder().decode(unzipped[k]))
      .join('\n');
    assert(allXml.includes(marker), `${docName}: HWP로 저장 후 다시 열었을 때 입력한 '${marker}' 텍스트가 100% 보존되어야 합니다!`);
    console.log(`  ✅ [${docName}] HWP 텍스트 타이핑, Shift+방향키 선택, HWP 저장 및 재열기 검증 완료!`);
  }

  console.log('=== [2/5] 셀 보호(cellProtect) 잠금 안내 및 1클릭 [🔓 보호해제] 검증 ===');
  {
    const target = await findEditableCellClickTarget(page);
    await page.mouse.click(target.clientX, target.clientY);
    await page.waitForTimeout(120);

    // 셀 보호 켜기
    await page.locator('#hanul-btn-cell-protect').click();
    await page.waitForTimeout(120);
    const lockedState = await page.evaluate(() => {
      const ih = window.__hanulEngine.getInputHandler();
      return {
        isProtMode: !!ih.cursor.isProtectedCellSelectionMode?.(),
        btnText: document.getElementById('hanul-btn-cell-protect')?.textContent || '',
      };
    });
    assert.equal(lockedState.isProtMode, true, '셀 보호 버튼 클릭 시 보호 모드로 전환되어야 합니다.');
    assert(lockedState.btnText.includes('보호해제'), '셀 보호 상태에서 버튼 라벨이 [🔓 보호해제]로 표시되어야 합니다.');

    // 잠긴 상태에서 키 입력 시 안내 배너 표시 확인
    await page.keyboard.press('a');
    await page.waitForTimeout(80);
    const noticeText = await page.evaluate(() => document.getElementById('hanul-notice')?.textContent || '');
    assert(noticeText.includes('셀 보호'), '보호된 셀에서 타이핑 시 명확한 안내 토스트가 표시되어야 합니다.');

    // 1클릭 보호 해제 후 즉시 타이핑 검증
    await page.locator('#hanul-btn-cell-protect').click();
    await page.waitForTimeout(120);
    await page.keyboard.type('PROT_UNLOCK_OK');
    const afterUnlockHwpx = await page.evaluate(() => window.__hanulEngine.export('hwpx'));
    const secXml = new TextDecoder().decode(unzipSync(new Uint8Array(afterUnlockHwpx))['Contents/section0.xml']);
    assert(secXml.includes('PROT_UNLOCK_OK'), '셀 보호 해제 직후 자유롭게 텍스트 입력이 가능해야 합니다.');
    console.log('  ✅ 셀 보호 잠금 토스트 안내 및 1클릭 [🔓 보호해제] 후 편집 성공!');
  }

  console.log('=== [3/5] F5 셀 선택 모드 내 단일키(W) 동작 및 Esc 해제 후 타이핑 복귀 검증 ===');
  {
    await page.keyboard.press('F5');
    await page.waitForTimeout(80);
    const inF5 = await page.evaluate(() => window.__hanulEngine.getInputHandler().cursor.isInCellSelectionMode());
    assert.equal(inF5, true, 'F5 입력 시 셀 선택 모드로 진입해야 합니다.');

    await page.keyboard.press('w');
    await page.waitForTimeout(80);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);

    const exitedF5 = await page.evaluate(() => window.__hanulEngine.getInputHandler().cursor.isInCellSelectionMode());
    assert.equal(exitedF5, false, 'Escape 입력 시 셀 선택 모드가 해제되어야 합니다.');

    await page.keyboard.type('w_typed_ok');
    const hwpx = await page.evaluate(() => window.__hanulEngine.export('hwpx'));
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(hwpx))['Contents/section0.xml']);
    assert(xml.includes('w_typed_ok'), 'F5 해제 후 알파벳 w가 정상 입력되어야 합니다.');
    console.log('  ✅ F5 셀 선택 단축키(W) 및 일반 텍스트 타이핑 모드 분리 검증 완료!');
  }

  console.log('=== [4/5] 모달 <input> 키 입력 격리 & 다크모드 글머리표 모달 명도 대비(WCAG AAA) 검증 ===');
  {
    // F5 셀 선택 상태에서 하이퍼링크 모달을 열어도 input 타이핑/백스페이스가 뺏기지 않아야 함
    await page.keyboard.press('F5');
    await page.locator('#hanul-btn-hyperlink').click();
    await page.waitForSelector('#hanul-link-text', { state: 'visible' });
    await page.locator('#hanul-link-text').fill('');
    await page.locator('#hanul-link-text').focus();
    await page.keyboard.type('awhmspX');
    await page.keyboard.press('Backspace');
    const inputVal = await page.locator('#hanul-link-text').inputValue();
    assert.equal(inputVal, 'awhmsp', `모달 입력창에서 키 입력이 캔버스에 탈취되면 안 됩니다 (실측값: ${inputVal})`);
    await page.locator('#hanul-hyperlink-close').click();
    await page.keyboard.press('Escape');

    // 다크 모드 글머리표 모달 명도 대비 실측
    await page.locator('#hanul-btn-bullet-shape').click();
    await page.waitForSelector('#hanul-bullet-modal .bullet-opt', { state: 'visible' });
    const bulletContrast = await page.evaluate(() => {
      const btn = document.querySelector('#hanul-bullet-modal .bullet-opt:not(.active)');
      const activeBtn = document.querySelector('#hanul-bullet-modal .bullet-opt.active');
      const cs1 = getComputedStyle(btn);
      const cs2 = getComputedStyle(activeBtn);
      return {
        bg: cs1.backgroundColor,
        fg: cs1.color,
        activeBg: cs2.backgroundColor,
        activeFg: cs2.color,
      };
    });
    const ratio = contrastRatio(bulletContrast.bg, bulletContrast.fg);
    console.log(`  🎨 다크모드 불릿 옵션 명도 대비: ${ratio.toFixed(2)}:1 (bg=${bulletContrast.bg}, fg=${bulletContrast.fg})`);
    assert(ratio >= 7.0, `다크모드 불릿 카드 명도 대비가 WCAG AAA(7:1) 이상이어야 합니다 (실측: ${ratio.toFixed(2)}:1)`);

    // 라이트 모드 양방향 전환 후 불릿 모달 명도 대비 실측
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(100);
    const lightBulletContrast = await page.evaluate(() => {
      const btn = document.querySelector('#hanul-bullet-modal .bullet-opt:not(.active)');
      const cs = getComputedStyle(btn);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    const lightRatio = contrastRatio(lightBulletContrast.bg, lightBulletContrast.fg);
    console.log(`  ☀️ 라이트모드 불릿 옵션 명도 대비: ${lightRatio.toFixed(2)}:1 (bg=${lightBulletContrast.bg}, fg=${lightBulletContrast.fg})`);
    assert(lightRatio >= 7.0, `라이트모드 불릿 카드 명도 대비가 WCAG AAA(7:1) 이상이어야 합니다 (실측: ${lightRatio.toFixed(2)}:1)`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('#hanul-bullet-close').click();
  }

  console.log('=== [5/5] 실제 .hwpx 문서(글 뒤 서명/표 포함) 클릭 편집 및 무손실 저장 검증 ===');
  {
    const hwpxPath = hwpxCandidates[0];
    const hwpxName = await loadDocumentBytes(page, hwpxPath);
    const target = await findEditableCellClickTarget(page);
    if (target) {
      await page.mouse.click(target.clientX, target.clientY);
    } else {
      await page.locator('#scroll-container').click({ position: { x: 420, y: 240 } });
    }
    await page.waitForTimeout(150);
    const hwpxMarker = `HWPX_EDIT_${Date.now()}`;
    await page.keyboard.type(hwpxMarker);
    const savedBytes = await page.evaluate(() => window.__hanulEngine.export('hwpx'));
    validateBytes(new Uint8Array(savedBytes), 'hwpx');
    const unzipped = unzipSync(new Uint8Array(savedBytes));
    const allXml = Object.keys(unzipped)
      .filter(k => k.startsWith('Contents/section') && k.endsWith('.xml'))
      .map(k => new TextDecoder().decode(unzipped[k]))
      .join('\n');
    assert(allXml.includes(hwpxMarker), `${hwpxName}: HWPX 편집 내용이 저장 본문에 반영되어야 합니다.`);
    console.log(`  ✅ [${hwpxName}] 실제 HWPX 문서 클릭·타이핑·저장 라운드트립 완료!`);
  }

  assert.deepEqual(pageErrors, [], `런타임 페이지 에러가 없어야 합니다: ${pageErrors.join('; ')}`);
  console.log('\n🎉 전수 통과: 실제 .hwp / .hwpx 문서 텍스트 편집, 키보드 단축키 분리, 셀 보호 해제, 모달 입력 격리 및 다크모드 대비 검증 100% 완료!');
  await context.close();
} finally {
  await browser.close();
  await preview.close();
}
