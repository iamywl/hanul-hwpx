import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

async function generateIcon() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });

  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 256px;
      height: 256px;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Segoe UI", Roboto, sans-serif;
    }
    .icon-container {
      width: 240px;
      height: 240px;
      border-radius: 52px;
      background: linear-gradient(135deg, #1e2638 0%, #0d121d 100%);
      border: 2px solid rgba(88, 166, 255, 0.4);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6), inset 0 1px 2px rgba(255, 255, 255, 0.25);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .grid-symbol {
      display: grid;
      grid-template-columns: repeat(2, 42px);
      grid-gap: 12px;
      margin-bottom: 8px;
    }
    .cell {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.08);
      border: 1.5px solid rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(8px);
      box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.2);
    }
    .cell.active {
      background: linear-gradient(135deg, #007acc 0%, #005999 100%);
      border-color: #388bfd;
      box-shadow: 0 4px 14px rgba(0, 122, 204, 0.5), inset 0 1px 2px rgba(255, 255, 255, 0.4);
    }
    .cell.accent {
      background: linear-gradient(135deg, #2ea043 0%, #238636 100%);
      border-color: #3fb950;
      box-shadow: 0 4px 14px rgba(46, 160, 67, 0.4);
    }
    .title {
      font-size: 26px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.5px;
      text-shadow: 0 2px 8px rgba(0,0,0,0.6);
      margin-top: 4px;
    }
    .tag {
      font-size: 11px;
      font-weight: 700;
      color: #58a6ff;
      background: rgba(56, 139, 253, 0.15);
      border: 1px solid rgba(56, 139, 253, 0.4);
      padding: 2px 8px;
      border-radius: 10px;
      margin-top: 4px;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="icon-container">
    <div class="grid-symbol">
      <div class="cell active"></div>
      <div class="cell"></div>
      <div class="cell"></div>
      <div class="cell accent"></div>
    </div>
    <div class="title">한울</div>
    <div class="tag">HWP · HWPX</div>
  </div>
</body>
</html>
  `;

  await page.setContent(html);
  const iconPath = path.resolve('docs/assets/icon.png');
  await page.screenshot({ path: iconPath, omitBackground: true });
  await browser.close();

  console.log('✅ Extension Icon 생성 완료:', iconPath);
}

generateIcon().catch(console.error);
