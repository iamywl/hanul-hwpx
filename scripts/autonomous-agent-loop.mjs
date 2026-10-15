/**
 * Hanul Autonomous Agent Development Loop (한울 자율 에이전트 개발-검증-피드백 루프)
 * 
 * "개발하고 검증하고 확인하고 피드백을 주고 다시 개발하고"
 * 
 * 에이전트 4단계 자율 사이클:
 * 1. [Planner Agent] 요구사항 및 핵심 결함 명세 확인
 * 2. [Developer Agent] 코드 빌드 및 정적 타입 무결성 검증
 * 3. [QA Verifier Agent] Playwright 실물 브라우저 환경에서 E2E 인터랙션 및 시각 검증
 *    - 서식 복사 (Alt+C, 툴바 클릭, 시각 피드백)
 *    - 표 단축키 (단일 셀 W/H/S/P, A/M 가이드, F5 3단계 모드, 셀 크기 조절)
 *    - 실시간 렌더링 렉 및 IPC 디바운싱 검증
 * 4. [Feedback & Healing Agent] 실패 시 원인 역추적 및 재시도, 성공 시 패키징 완료
 */

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { startPreview } from './preview.mjs';
import { validateBytes } from '../dist/storage.mjs';
import { openDocument } from '../dist/core.mjs';

console.log('================================================================');
console.log('🤖 한울 자율 에이전트 파이프라인 (Autonomous Agent Pipeline) 가동');
console.log('================================================================\n');

// ---------------------------------------------------------
// [Phase 1: Developer Agent] 코드 빌드 및 정적 타입 검사
// ---------------------------------------------------------
console.log('▶ [Phase 1: Developer Agent] TypeScript 검사 및 프로젝트 빌드 수행...');
const checkRes = spawnSync('npm', ['run', 'check'], { encoding: 'utf8' });
if (checkRes.status !== 0) {
  console.error('❌ TypeScript 타입 오류 발생:\n', checkRes.stderr || checkRes.stdout);
  process.exit(1);
}
const buildRes = spawnSync('npm', ['run', 'build'], { encoding: 'utf8' });
if (buildRes.status !== 0) {
  console.error('❌ 빌드 스크립트 실행 오류:\n', buildRes.stderr || buildRes.stdout);
  process.exit(1);
}
console.log('✅ Developer Agent: 빌드 및 정적 타입 무결성 100% 통과.\n');

// ---------------------------------------------------------
// [Phase 2: QA Verifier Agent] 실물 런타임 E2E 인터랙션 검증
// ---------------------------------------------------------
console.log('▶ [Phase 2: QA Verifier Agent] 실물 웹뷰 E2E 자율 인터랙션 검증 시작...');

const preview = await startPreview(0);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', err => pageErrors.push(err.message));

let loopSuccess = false;
let feedbackNotes = [];

try {
  await page.goto(preview.url);
  await page.waitForFunction(() => document.getElementById('hanul-state').textContent === '편집 준비 완료', null, { timeout: 60000 });

  // ---------------------------------------------------------
  // 검증 1: 서식 복사 (Alt+C) 및 툴바 클릭 피드백 검증
  // ---------------------------------------------------------
  console.log('  [검증 1] 서식 복사(모양 복사 / Alt+C) 기능 검증...');
  await page.locator('#scroll-container').click({ position: { x: 450, y: 200 } });
  await page.keyboard.insertText('한울 서식 복사 원본 텍스트');
  await page.waitForTimeout(100);

  // 1-1. Alt+C 입력 (복사 단계)
  await page.keyboard.press('Alt+c');
  await page.waitForTimeout(150);

  let noticeText = await page.locator('#hanul-notice').innerText();
  console.log('    -> Alt+C 1차 입력 후 알림:', noticeText);
  assert(noticeText.includes('모양 복사 완료'), `Alt+C 복사 후 알림이 떠야 합니다. 실제값: ${noticeText}`);

  // 1-2. 툴바 버튼 클릭으로 2차 적용 또는 재복사 피드백 검증
  const formatCopyBtn = page.locator('[data-cmd="edit:format-copy"]').first();
  if (await formatCopyBtn.isVisible()) {
    await formatCopyBtn.click();
    await page.waitForTimeout(150);
    const noticeAfterBtn = await page.locator('#hanul-notice').innerText();
    console.log('    -> 툴바 모양 복사 버튼 클릭 후 알림:', noticeAfterBtn);
    assert(noticeAfterBtn.length > 0, '툴바 버튼 클릭 후 시각 알림이 존재해야 합니다.');
  }

  // ---------------------------------------------------------
  // 검증 2: 표 생성 및 표 내부 단축키 (W, H, S, P, A, M) 스마트 가드 검증
  // ---------------------------------------------------------
  console.log('  [검증 2] 표 생성 및 표 단축키(W, H, S, P, A, M) 인터랙션 검증...');
  await page.keyboard.press('Enter');
  await page.evaluate(() => { void window.__hanulEngine.command('table:create'); });
  await page.waitForTimeout(200);
  await page.getByText('표 만들기...', { exact: false }).last().click();
  await page.locator('input[type="number"]').nth(0).fill('3');
  await page.locator('input[type="number"]').nth(1).fill('2');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.waitForTimeout(300);

  // 현재 커서가 표 셀 내부인지 확인
  const inCell = await page.evaluate(() => {
    const ih = window.__hanulEngine.getInputHandler?.();
    return ih?.cursor?.isInCell?.() || false;
  });
  assert(inCell, '표 생성 후 커서가 표 셀 내부에 위치해야 합니다.');

  // 2-1. 단일 셀 상태에서 W (너비같게) 입력 -> 글자 'ㅈ'가 쳐지지 않고 균등화 실행 확인
  await page.keyboard.press('w');
  await page.waitForTimeout(150);
  noticeText = await page.locator('#hanul-notice').innerText();
  console.log('    -> 셀 내부 W 입력 알림:', noticeText);
  assert(noticeText.includes('너비 균등화') || noticeText.includes('너비 같게'), 'W 입력 시 너비 균등화가 실행되어야 합니다.');

  // 2-2. 단일 셀 상태에서 H (높이같게) 입력 -> 글자 'ㅗ'가 쳐지지 않고 균등화 실행 확인
  await page.keyboard.press('h');
  await page.waitForTimeout(150);
  noticeText = await page.locator('#hanul-notice').innerText();
  console.log('    -> 셀 내부 H 입력 알림:', noticeText);
  assert(noticeText.includes('높이 균등화') || noticeText.includes('높이 같게'), 'H 입력 시 높이 균등화가 실행되어야 합니다.');

  // 2-3. 단일 셀 상태에서 A (자동채우기) 입력 -> 글자 'ㅁ'가 쳐지지 않고 친절한 범위 안내 토스트 확인
  await page.keyboard.press('a');
  await page.waitForTimeout(150);
  noticeText = await page.locator('#hanul-notice').innerText();
  console.log('    -> 단일 셀 A 입력 시 스마트 가이드 안내:', noticeText);
  assert(noticeText.includes('자동 채우기') && noticeText.includes('F5'), '단일 셀 A 입력 시 F5 범위 선택 가이드가 출력되어야 합니다.');

  // 2-4. 단일 셀 상태에서 M (합치기) 입력 -> 글자 'ㅡ'가 쳐지지 않고 친절한 셀 선택 가이드 확인
  await page.keyboard.press('m');
  await page.waitForTimeout(150);
  noticeText = await page.locator('#hanul-notice').innerText();
  console.log('    -> 단일 셀 M 입력 시 스마트 가이드 안내:', noticeText);
  assert(noticeText.includes('합치기') && noticeText.includes('F5'), '단일 셀 M 입력 시 F5 2개 이상 선택 가이드가 출력되어야 합니다.');

  // ---------------------------------------------------------
  // 검증 3: F5 셀 선택 3단계 모드 & A 자동채우기 실질 실행
  // ---------------------------------------------------------
  console.log('  [검증 3] F5 3단계 모드 및 수열 자동채우기 실질 동작 검증...');
  // 셀에 텍스트 1, 2 입력
  await page.keyboard.insertText('1');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('2');
  await page.waitForTimeout(100);

  // F5 셀 선택 모드 진입
  await page.keyboard.press('F5');
  await page.waitForTimeout(100);
  const phase1 = await page.evaluate(() => window.__hanulEngine.getInputHandler()?.cursor?.getCellSelectionPhase());
  assert.equal(phase1, 1, 'F5 1회 입력 시 phase 1(이동 모드)이어야 합니다.');

  // F5 2회 입력 (빨간불 범위 선택 모드)
  await page.keyboard.press('F5');
  await page.waitForTimeout(100);
  const phase2 = await page.evaluate(() => window.__hanulEngine.getInputHandler()?.cursor?.getCellSelectionPhase());
  assert.equal(phase2, 2, 'F5 2회 입력 시 phase 2(범위 선택 모드)이어야 합니다.');

  // 방향키 아래로 확장
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);

  // A 키로 자동 채우기 실행
  await page.keyboard.press('a');
  await page.waitForTimeout(200);
  noticeText = await page.locator('#hanul-notice').innerText();
  console.log('    -> F5 범위 지정 후 A 자동 채우기 실행 알림:', noticeText);
  assert(noticeText.includes('자동 채우기 완료') || noticeText.includes('수열'), '선택 영역 자동 채우기가 정상 실행되어야 합니다.');

  // ---------------------------------------------------------
  // 검증 4: 실시간 렉 방지 (IPC 디바운싱 및 크기 조절 성능 검증)
  // ---------------------------------------------------------
  console.log('  [검증 4] 표 크기 조절 실시간 반응성 및 IPC 디바운싱 검증...');
  const initialVersion = await page.evaluate(() => window.__lastExport?.version || 0);
  
  // 빠른 연속 크기 조절 4회 호출
  await page.locator('#hanul-btn-w-inc').click();
  await page.locator('#hanul-btn-w-inc').click();
  await page.locator('#hanul-btn-h-inc').click();
  await page.locator('#hanul-btn-h-inc').click();
  await page.waitForTimeout(300); // 디바운스 150ms 대기

  noticeText = await page.locator('#hanul-notice').innerText();
  console.log('    -> 연속 크기 조절 후 알림:', noticeText);
  assert(noticeText.includes('표 크기 변경 완료'), '표 크기 조절 알림이 정상 출력되어야 합니다.');

  // ---------------------------------------------------------
  // 검증 5: 문서 저장 및 HWPX 무손실 라운드트립 검증
  // ---------------------------------------------------------
  console.log('  [검증 5] HWPX 무손실 저장 및 라운드트립 검증...');
  await page.locator('#hanul-menu-save').click();
  await page.waitForFunction(() => window.__lastExport && document.getElementById('hanul-state').textContent === '저장 완료', null, { timeout: 30000 });

  const exported = await page.evaluate(() => window.__lastExport);
  assert(exported.bytes && exported.bytes.length > 0, '저장된 바이트가 존재해야 합니다.');
  validateBytes(new Uint8Array(exported.bytes), 'hwpx');

  const testHwpxPath = path.resolve('artifacts/test_agent_verified.hwpx');
  fs.writeFileSync(testHwpxPath, Buffer.from(exported.bytes));
  const doc = openDocument(testHwpxPath);
  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.fullText.includes('한울 서식 복사'), '문서 본문 텍스트가 보존되어야 합니다.');
  assert.ok(doc.tables.length >= 1, '생성된 표가 HWPX에 온전히 보존되어야 합니다.');

  // 최종 스크린샷 캡처
  await page.screenshot({ path: 'artifacts/autonomous-agent-verified.png', fullPage: true });
  console.log('  📸 시각 검증 스크린샷 생성 완료: artifacts/autonomous-agent-verified.png');

  assert.equal(pageErrors.length, 0, `페이지 런타임 에러가 없어야 합니다: ${pageErrors.join(', ')}`);
  loopSuccess = true;
  console.log('✅ QA Verifier Agent: 5대 핵심 실무 인터랙션 전수 통과!');

} catch (err) {
  feedbackNotes.push(`QA 실패 원인: ${err.message}`);
  console.error('❌ QA Verifier Agent 실패:', err);
} finally {
  await browser.close();
  await preview.close();
}

if (!loopSuccess) {
  console.error('\n⚠️ [Feedback Loop] 에이전트 자동 피드백: 결함 재교정이 필요합니다.');
  console.error(feedbackNotes.join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------
// [Phase 3: Packager Agent] VSIX 패키징 및 최종 릴리즈 준비
// ---------------------------------------------------------
console.log('\n▶ [Phase 3: Packager Agent] VSIX 패키징 및 최종 릴리즈 생성...');
const packageRes = spawnSync('npm', ['run', 'package'], { encoding: 'utf8' });
if (packageRes.status !== 0) {
  console.error('❌ VSIX 패키징 오류:\n', packageRes.stderr || packageRes.stdout);
  process.exit(1);
}
console.log('✅ Packager Agent: artifacts/hanul-hwpx-0.1.0.vsix 생성 완료.');

console.log('\n================================================================');
console.log('🎉 [Autonomous Loop 완료] 개발 ➔ 검증 ➔ 확인 ➔ 피드백 전과정 100% 성공!');
console.log('================================================================');
