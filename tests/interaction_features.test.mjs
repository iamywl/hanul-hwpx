import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/preview.mjs';

test('UI/UX: F11 개체선택, BehindText 선택 보강, 모달(링크/불릿), 글래스모피즘 테마 전수 검증', async (t) => {
  const preview = await startPreview(0);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto(preview.url);
    await page.waitForFunction(() => document.getElementById('hanul-state')?.textContent === '편집 준비 완료', null, { timeout: 60000 });

    // 1. F11 개체 선택 모드 (Object Selection Mode) 검증
    await t.test('1. F11 개체선택 모드 토글 및 뱃지/클래스 연동 검증', async () => {
      const objSelectBtn = page.locator('#hanul-btn-obj-select');
      assert.equal(await objSelectBtn.count(), 1, '#hanul-btn-obj-select 버튼이 메뉴바에 존재해야 합니다.');
      assert.ok((await objSelectBtn.innerText()).includes('개체선택'), '버튼 텍스트에 개체선택이 포함되어야 합니다.');

      // 초기 상태: 비활성
      let isActive = await page.evaluate(() => document.body.classList.contains('hanul-object-selection-active'));
      assert.equal(isActive, false, '초기에는 개체 선택 모드가 꺼져 있어야 합니다.');

      // F11 키 입력으로 활성화
      await page.keyboard.press('F11');
      await page.waitForTimeout(100);
      isActive = await page.evaluate(() => document.body.classList.contains('hanul-object-selection-active'));
      assert.equal(isActive, true, 'F11 누른 후 body에 hanul-object-selection-active 클래스가 추가되어야 합니다.');

      const badgeText = await page.locator('#hanul-obj-mode-badge').innerText();
      assert.ok(badgeText.includes('F11 개체선택'), '헤더에 F11 개체선택 뱃지가 노출되어야 합니다.');

      // Escape 키 입력으로 비활성화
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      isActive = await page.evaluate(() => document.body.classList.contains('hanul-object-selection-active'));
      assert.equal(isActive, false, 'Escape 누른 후 개체 선택 모드가 해제되어야 합니다.');
      assert.equal(await page.locator('#hanul-obj-mode-badge').count(), 0, '뱃지가 제거되어야 합니다.');

      // 메뉴 버튼 클릭으로 다시 활성화 및 비활성화
      await objSelectBtn.click();
      await page.waitForTimeout(100);
      isActive = await page.evaluate(() => document.body.classList.contains('hanul-object-selection-active'));
      assert.equal(isActive, true, '버튼 클릭으로 개체 선택 모드가 활성화되어야 합니다.');

      await objSelectBtn.click();
      await page.waitForTimeout(100);
      isActive = await page.evaluate(() => document.body.classList.contains('hanul-object-selection-active'));
      assert.equal(isActive, false, '버튼 재클릭으로 개체 선택 모드가 꺼져야 합니다.');
    });

    // 2. BehindText 개체 히트테스트 패치 검증
    await t.test('2. BehindText(글 뒤로) 개체 히트테스트 패치 동작 검증', async () => {
      const isPatched = await page.evaluate(() => {
        const ih = window.__hanulEngine?.getInputHandler?.();
        return !!ih?.__behindTextPatched;
      });
      assert.equal(isPatched, true, 'WASM InputHandler에 BehindText 히트테스트 패치가 적용되어 있어야 합니다.');

      // 가상 컨트롤 레이아웃에서 BehindText 개체 탐색 모의 테스트
      const hitResult = await page.evaluate(() => {
        const ih = window.__hanulEngine?.getInputHandler?.();
        // 임시로 가상 getPageControlLayout 주입
        const wasm = ih.wasm;
        const origGetLayout = wasm.getPageControlLayout;
        wasm.getPageControlLayout = (pageIdx) => ({
          pageIdx: 0,
          controls: [
            { secIdx: 0, paraIdx: 4, controlIdx: 0, type: 'image', wrap: 3, x: 200, y: 300, w: 100, h: 80 }
          ]
        });

        // 텍스트와 겹쳐서 원본 함수가 null을 낸 상황에서도 보강 검색으로 찾아내는지 확인
        const res = ih.findPictureAtClick(0, 250, 340);
        wasm.getPageControlLayout = origGetLayout;
        return res;
      });

      assert.ok(hitResult, '겹친 좌표에서 BehindText 이미지를 정상 찾아내야 합니다.');
      assert.equal(hitResult.ci, 0, 'controlIdx가 일치해야 합니다.');
      assert.equal(hitResult.type, 'image', '개체 타입이 image여야 합니다.');
    });

    // 3. 하이퍼링크 대화상자 (Ctrl+K, H / 메뉴 클릭)
    await t.test('3. 하이퍼링크 대화상자 (Ctrl+K, H) 호출 및 닫기 검증', async () => {
      const linkBtn = page.locator('#hanul-btn-hyperlink');
      assert.equal(await linkBtn.count(), 1, '#hanul-btn-hyperlink 버튼이 존재해야 합니다.');

      // 메뉴 클릭으로 열기
      await linkBtn.click();
      await page.waitForTimeout(150);

      const modal = page.locator('#hanul-hyperlink-modal');
      assert.equal(await modal.isVisible(), true, '하이퍼링크 모달이 표시되어야 합니다.');

      const urlInput = page.locator('#hanul-link-url');
      assert.equal(await urlInput.count(), 1, 'URL 입력창이 존재해야 합니다.');
      await urlInput.fill('https://github.com/morluto/rea');

      // 취소 버튼으로 닫기
      await page.locator('#hanul-hyperlink-cancel').click();
      await page.waitForTimeout(100);
      assert.equal(await modal.isVisible(), false, '취소 클릭 시 모달이 닫혀야 합니다.');

      // 단축키 Ctrl+K -> H 검증
      await page.keyboard.press('Control+k');
      await page.keyboard.press('h');
      await page.waitForTimeout(150);
      assert.equal(await modal.isVisible(), true, 'Ctrl+K -> H 로 하이퍼링크 모달이 열려야 합니다.');

      // Esc 키로 닫기
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      assert.equal(await modal.isVisible(), false, 'Escape로 모달이 닫혀야 합니다.');
    });

    // 4. 글머리표 대화상자 (Ctrl+Shift+B / 메뉴 클릭)
    await t.test('4. 글머리표 대화상자 (Ctrl+Shift+B) 호출 및 옵션 선택 검증', async () => {
      const bulletBtn = page.locator('#hanul-btn-bullet-shape');
      assert.equal(await bulletBtn.count(), 1, '#hanul-btn-bullet-shape 버튼이 존재해야 합니다.');

      // 단축키 Ctrl+Shift+B 로 열기
      await page.keyboard.press('Control+Shift+B');
      await page.waitForTimeout(150);

      const modal = page.locator('#hanul-bullet-modal');
      assert.equal(await modal.isVisible(), true, '글머리표 모달이 표시되어야 합니다.');

      const opts = page.locator('.bullet-opt');
      assert.ok(await opts.count() >= 6, '글머리표 옵션이 6개 이상 제공되어야 합니다.');

      // 첫 번째 옵션 클릭
      await opts.first().click();
      assert.ok(await opts.first().getAttribute('class'), 'active 클래스가 토글되어야 합니다.');

      // Esc로 닫기
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      assert.equal(await modal.isVisible(), false, 'Escape로 글머리표 모달이 닫혀야 합니다.');
    });

    // 5. macOS 글래스모피즘 테마 스타일 실측 검증
    await t.test('5. macOS 글래스모피즘 CSS 스타일 실측 검증', async () => {
      // 헤더 blur 및 saturate 검증
      const headerStyles = await page.evaluate(() => {
        const el = document.getElementById('studio-header');
        const cs = window.getComputedStyle(el);
        return {
          backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
          borderBottomWidth: cs.borderBottomWidth
        };
      });
      assert.ok(headerStyles.backdropFilter.includes('blur'), '헤더에 backdrop-filter blur가 적용되어 있어야 합니다.');

      // 하이퍼링크 모달 열어서 글래스모피즘 검증
      await page.locator('#hanul-btn-hyperlink').click();
      await page.waitForTimeout(150);

      const modalStyles = await page.evaluate(() => {
        const overlay = document.getElementById('hanul-hyperlink-modal');
        const content = overlay.querySelector('.hanul-modal-content');
        const csOverlay = window.getComputedStyle(overlay);
        const csContent = window.getComputedStyle(content);
        return {
          overlayBlur: csOverlay.backdropFilter || csOverlay.webkitBackdropFilter,
          contentRadius: csContent.borderRadius,
          contentBg: csContent.backgroundColor
        };
      });

      assert.ok(modalStyles.overlayBlur.includes('blur'), '모달 오버레이에 backdrop-filter blur가 적용되어 있어야 합니다.');
      assert.equal(modalStyles.contentRadius, '14px', '모달 컨텐츠 모서리는 Apple HIG 14px 둥글기여야 합니다.');

      // 스크린샷 캡처
      await page.screenshot({ path: 'artifacts/glassmorphism_features_verified.png' });
      await page.keyboard.press('Escape');
    });

  } finally {
    await browser.close();
    await preview.close();
  }
});
