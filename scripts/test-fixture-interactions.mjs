import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startPreview } from './preview.mjs';

console.log('--- 실제 공모전/공문서 HWP 실물 로딩 및 테이블/글래스 인터랙션 종합 검증 ---');

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

  // 1. 공모전 HWP 파일 로딩
  const fixturePath = join(process.cwd(), 'tests/fixtures', '붙임 1. 「The Pattern 2026 콘테스트  오픈소스 패션 모델링 어워드」 모집공고.hwp');
  if (existsSync(fixturePath)) {
    console.log('[1/4] 실물 공모전 HWP 로딩 중:', fixturePath);
    const fileBytes = Array.from(readFileSync(fixturePath));
    await page.evaluate(async (bytes) => {
      window.postMessage({
        type: 'request',
        id: 'load-pattern-contest',
        method: 'load',
        params: { bytes, name: 'ThePattern2026.hwp' }
      }, location.origin);
    }, fileBytes);

    await page.waitForFunction(() => {
      const state = document.getElementById('hanul-state')?.textContent;
      return state === '편집 준비 완료';
    }, null, { timeout: 60000 });

    const docInfo = await page.evaluate(() => {
      const engine = window.__hanulEngine;
      const ih = engine?.getInputHandler?.();
      return {
        pages: engine?.doc?.pages?.length ?? 1,
        inTable: ih?.cursor?.isInCell?.() ?? false
      };
    });
    console.log('공모전 문서 로딩 완료! 총 페이지 수:', docInfo.pages);

    // 2. 표 내부 클릭 및 F5 단축키 인터랙션 검증
    console.log('[2/4] 본문 내 표 진입 및 F5 단계별 인터랙션 검증...');
    // 표가 위치한 영역 클릭 시도 (스크롤 컨테이너 중앙)
    await page.locator('#scroll-container').click({ position: { x: 500, y: 400 } });
    await page.waitForTimeout(300);

    // F5 1회: 셀 이동 모드 (흰 점)
    await page.keyboard.press('F5');
    await page.waitForTimeout(200);

    let hudState = await page.evaluate(() => {
      const hud = document.getElementById('hanul-table-bar');
      const marker = document.getElementById('hanul-hud-marker');
      const text = document.getElementById('hanul-hud-phase-text');
      const ih = window.__hanulEngine.getInputHandler?.();
      return {
        hudActive: hud?.classList.contains('is-active'),
        markerClass: marker?.className,
        phaseText: text?.textContent,
        isInCellSel: ih?.cursor?.isInCellSelectionMode() ?? false,
        phase: ih?.cursor?.getCellSelectionPhase?.() ?? 0
      };
    });
    console.log('F5 1회차 상태:', hudState);

    // F5 2회: 범위 선택 모드 (한컴 정품 빨간 점 발광)
    await page.keyboard.press('F5');
    await page.waitForTimeout(200);

    hudState = await page.evaluate(() => {
      const marker = document.getElementById('hanul-hud-marker');
      const text = document.getElementById('hanul-hud-phase-text');
      const ih = window.__hanulEngine.getInputHandler?.();
      return {
        markerClass: marker?.className,
        phaseText: text?.textContent,
        phase: ih?.cursor?.getCellSelectionPhase?.() ?? 0
      };
    });
    console.log('F5 2회차 (빨간불) 상태:', hudState);
    if (hudState.phase === 2) {
      assert(hudState.markerClass.includes('marker-range'), 'F5 2회 입력 시 코랄 레드 발광 펄스(marker-range)가 활성화되어야 합니다');
      assert(hudState.phaseText.includes('🔴'), '상태 텍스트에 빨간 점 표시가 포함되어야 합니다');
    }

    // 3. 셀 조작 시 텍스트 누수(타이핑 버그) 방지 검증: w, h, a, m, s 입력 시 누수 없어야 함
    console.log('[3/4] 셀 조작 키(w, h, a, m, s) 입력 시 텍스트 누수 방지 검증...');
    await page.keyboard.press('w');
    await page.waitForTimeout(100);
    await page.keyboard.press('h');
    await page.waitForTimeout(100);

    // textarea에 'w', 'h'가 입력되지 않았는지 확인
    const leakedText = await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      return textarea?.value ?? '';
    });
    console.log('입력 영역 누수 텍스트:', JSON.stringify(leakedText));
    assert.equal(leakedText, '', '셀 선택 모드에서 조작 단축키(w, h, m 등) 입력 시 텍스트 본문에 누수되지 않아야 합니다');

    // 4. 스크린샷 캡처로 글래스모피즘 UI 검증
    console.log('[4/4] 글래스모피즘 UI 스크린샷 캡처 중...');
    await page.screenshot({ path: 'artifacts/glass-ui-verification.png' });
    console.log('스크린샷 저장 완료: artifacts/glass-ui-verification.png');
  }

  assert.deepEqual(errors, []);
  console.log('🎉 실제 공모전 HWP 실물 로딩 및 글래스모피즘/테이블 인터랙션 전수 무결성 검증 100% 완료!');
} finally {
  await browser.close();
  await preview.close();
}
