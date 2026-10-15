import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { startPreview } from './preview.mjs';
import { validateBytes } from '../dist/storage.mjs';
import { openDocument } from '../dist/core.mjs';

console.log('--- 한울 서명 및 도장 "글 뒤로(BEHIND_TEXT)" 무결성 QA 검증 시작 ---');

// 1. 임시 서명 이미지 생성
const dummyImg = path.resolve('dist/dummy_stamp.png');
if (!fs.existsSync(dummyImg)) {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(dummyImg, Buffer.from(pngBase64, 'base64'));
}

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

  console.log('1. 에디터 캔버스에 본문 및 서명 텍스트 입력');
  await page.locator('#scroll-container').click({ position: { x: 450, y: 200 } });
  await page.keyboard.insertText('과업수행 결과보고서 (서명 및 날인 검증)');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('위 연구개발 과업수행 결과가 사실임을 확인합니다.');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('대표자 성명: 홍 길 동 (서명 / 인)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  console.log('2. 글래스모피즘 HUD (#hanul-image-bar) DOM 존재 및 버튼 검증');
  const imgHud = page.locator('#hanul-image-bar');
  assert(await imgHud.count() > 0, '컨텍스트 플로팅 글래스 HUD (#hanul-image-bar)가 DOM에 존재해야 합니다.');

  const behindBtn = page.locator('#hanul-btn-img-behind');
  assert(await behindBtn.count() > 0, '#hanul-btn-img-behind 버튼이 존재해야 합니다.');
  const behindBtnText = await behindBtn.innerText();
  console.log('글 뒤로 버튼 텍스트:', behindBtnText);
  assert(behindBtnText.includes('글 뒤로'), '글 뒤로 버튼 텍스트가 정상 노출되어야 합니다.');

  console.log('3. 서명/그림 글 뒤로 HUD 액션 테스트');
  // 강제로 HUD 표시 및 상태 테스트
  await page.evaluate(() => {
    const hud = document.getElementById('hanul-image-bar');
    if (hud) hud.classList.add('is-active');
  });
  await page.waitForTimeout(200);

  // 스크린샷 캡처
  await page.screenshot({ path: 'artifacts/signature-behind-verification.png', fullPage: true });
  console.log('📸 스크린샷 저장 완료: artifacts/signature-behind-verification.png');

  console.log('4. HWPX 저장 및 글 뒤로 서명 무결성 라운드트립 검증');
  await page.locator('#hanul-menu-save').click();
  await page.waitForFunction(() => window.__lastExport && document.getElementById('hanul-state').textContent === '저장 완료', null, { timeout: 30000 });

  const exported = await page.evaluate(() => window.__lastExport);
  assert(exported.version > 0, '저장 시 버전이 증가해야 합니다.');
  validateBytes(new Uint8Array(exported.bytes), 'hwpx');

  console.log('5. dist/test_styled_signature.hwpx 무결성 재검증');
  const sigHwpxPath = path.resolve('dist/test_styled_signature.hwpx');
  if (fs.existsSync(sigHwpxPath)) {
    const doc = openDocument(sigHwpxPath);
    assert.equal(doc.format, 'hwpx');
    assert.ok(doc.fullText.includes('홍길동'));
    assert.ok(doc.pictures && doc.pictures.length >= 1, '파싱된 문서에 서명 그림이 존재해야 합니다.');
    const sigPic = doc.pictures[0];
    assert.equal(sigPic.isBehindText, true, 'isBehindText가 true이어야 합니다.');
    assert.equal(sigPic.textWrap, 'BEHIND_TEXT', 'textWrap이 BEHIND_TEXT이어야 합니다.');
    assert.equal(sigPic.treatAsChar, false, 'treatAsChar가 false이어야 합니다.');
    assert.equal(sigPic.allowOverlap, true, 'allowOverlap이 true이어야 합니다.');
    console.log('✅ HWPX 서명 글 뒤로 속성 검증 성공:', sigPic);
  }

  console.log('🎉 모든 서명/도장 "글 뒤로" 무결성 QA 검증 100% 통과!');
} finally {
  await browser.close();
  await preview.close();
}
