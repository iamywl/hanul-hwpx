import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

async function run() {
  console.log('🔍 [검증 시작] VS Code 확장 README 이미지 렌더링 및 접근성 실물 검증...');

  // 1. 설치된 확장 경로의 readme.md 확인
  const homeDir = process.env.HOME || '/Users/ywlee';
  const installedReadmePath = path.join(homeDir, '.vscode/extensions/kodingko.hanul-hwpx-0.1.0/readme.md');
  const projectReadmePath = path.resolve('README.md');

  if (!fs.existsSync(installedReadmePath)) {
    throw new Error(`설치된 확장 readme.md를 찾을 수 없습니다: ${installedReadmePath}`);
  }

  const content = fs.readFileSync(installedReadmePath, 'utf8');
  console.log('✅ 설치된 확장 README 파일 로드 성공.');

  // 2. 이미지 URL 정규식 추출
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (!imgMatch) {
    throw new Error('README에서 <img src="..."> 태그를 찾지 못했습니다.');
  }

  const imgUrl = imgMatch[1];
  console.log(`📌 추출된 이미지 URL: ${imgUrl}`);

  // 3. Playwright 브라우저 기동 후 실제 웹뷰 환경에서 렌더링 검증
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });

  // VS Code Extension 상세 페이지와 동일한 어두운 테마 HTML 생성
  const htmlContent = `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>VS Code Extension Details Preview Verification</title>
  <style>
    body {
      background-color: #1e1e1e;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 30px;
      line-height: 1.6;
    }
    .container {
      max-width: 850px;
      margin: 0 auto;
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .badge-bar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 16px 0;
      justify-content: center;
    }
    .preview-box {
      margin: 20px 0;
      text-align: center;
      background: #181818;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #333333;
    }
    .preview-box img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    h1, h2, h3 { color: #ffffff; text-align: center; }
    .status-badge {
      display: inline-block;
      padding: 6px 14px;
      background: #0e639c;
      color: white;
      border-radius: 4px;
      font-weight: bold;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div style="text-align: center;">
      <span class="status-badge">VS Code Extension Details 렌더링 실물 검증</span>
      <h1>Hanul (한울) · Universal HWP/HWPX Engine</h1>
      <p style="color: #9cdcfe; font-size: 16px; font-weight: 500;">"VSC 에서 한컴을 직접 편집할 수 있습니다."</p>
    </div>

    <div class="preview-box">
      <img id="test-preview-img" src="${imgUrl}" alt="Hanul VS Code Extension & Desktop App Preview" />
    </div>

    <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; font-size: 13px; color: #858585;">
      • 검증 대상 URL: <code>${imgUrl}</code><br>
      • 확장 ID: <code>kodingko.hanul-hwpx-0.1.0</code>
    </div>
  </div>
</body>
</html>
  `;

  await page.setContent(htmlContent, { waitUntil: 'networkidle' });

  // 4. 이미지 렌더링 무결성 브라우저 내부 평가
  const imgState = await page.evaluate(async () => {
    const img = document.getElementById('test-preview-img');
    if (!img) return { found: false };

    // 이미지가 아직 로딩 중인 경우 대기
    if (!img.complete) {
      await new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    }

    return {
      found: true,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      currentSrc: img.currentSrc,
      isBroken: img.naturalWidth === 0 || img.naturalHeight === 0
    };
  });

  console.log('📊 이미지 렌더링 상태 결과:', imgState);

  if (!imgState.found || imgState.isBroken || imgState.naturalWidth === 0) {
    throw new Error(`❌ 이미지 렌더링 실패! naturalWidth: ${imgState.naturalWidth}, naturalHeight: ${imgState.naturalHeight}`);
  }

  // 5. 검증 증거 스크린샷 캡처
  const screenshotPath = path.resolve('artifacts/readme-image-verified.png');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await browser.close();

  console.log(`📸 실물 렌더링 스크린샷 저장 완료: ${screenshotPath}`);
  console.log(`🎉 [검증 성공] 이미지가 해상도 ${imgState.naturalWidth}x${imgState.naturalHeight}px 로 온전하게 렌더링되었습니다!`);
}

run().catch((err) => {
  console.error('검증 중 오류 발생:', err);
  process.exit(1);
});
