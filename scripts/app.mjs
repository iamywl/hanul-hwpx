#!/usr/bin/env node
/**
 * Hanul Desktop App Launcher (macOS / Linux / Windows)
 * 브라우저 프레임 없는 독립 데스크톱 애플리케이션 창(App Window Mode)으로 즉시 실행합니다.
 */

import { startPreview } from './preview.mjs';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

async function launchDesktop() {
  console.log('🚀 한울(Hanul) 데스크톱 애플리케이션을 시작합니다...');
  const preview = await startPreview(0);
  const targetUrl = preview.url;
  console.log(`🌐 로컬 엔진 준비 완료: ${targetUrl}`);

  const currentPlatform = platform();
  let proc;

  if (currentPlatform === 'darwin') {
    // macOS: Chrome, Brave, Edge의 App 모드 또는 시스템 기본 열기
    const appArgs = [`--app=${targetUrl}`, '--window-size=1440,960'];
    const chromePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    let launched = false;
    for (const bin of chromePaths) {
      try {
        proc = spawn(bin, appArgs, { stdio: 'ignore', detached: true });
        proc.unref();
        launched = true;
        console.log(`✨ macOS 전용 독립 앱 창 모드로 실행되었습니다 (${bin})`);
        break;
      } catch {}
    }
    if (!launched) {
      // 일반 브라우저로 열기
      spawn('open', [targetUrl], { stdio: 'ignore', detached: true }).unref();
      console.log('✨ 기본 브라우저로 실행되었습니다.');
    }
  } else if (currentPlatform === 'win32') {
    // Windows: Chrome App 모드 또는 start
    spawn('cmd', ['/c', 'start', 'chrome', `--app=${targetUrl}`, '--window-size=1440,960'], { stdio: 'ignore', detached: true }).unref();
  } else {
    // Linux
    spawn('google-chrome', [`--app=${targetUrl}`, '--window-size=1440,960'], { stdio: 'ignore', detached: true }).unref();
  }

  console.log('💡 종료하려면 터미널에서 Ctrl+C를 누르세요.');
}

launchDesktop().catch(err => {
  console.error('❌ 앱 실행 오류:', err);
  process.exit(1);
});
