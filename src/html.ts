import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Webview, Uri } from 'vscode';

export function editorHtml(webview: Webview, extensionUri: Uri, development = false): string {
  const nonce = randomBytes(18).toString('base64');
  const base = webview.asWebviewUri(extensionUri.with({ path: extensionUri.path + '/vendor/studio' })).toString() + '/';
  const media = webview.asWebviewUri(extensionUri.with({ path: extensionUri.path + '/media' })).toString() + '/';
  return makeHtml(readFileSync(join(extensionUri.fsPath, 'vendor/studio/index.html'), 'utf8'), base, media, nonce, webview.cspSource, development);
}

export function makeHtml(source: string, base: string, media: string, nonce: string, cspSource: string, development = false): string {
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${cspSource} 'wasm-unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data: blob:; font-src ${cspSource} data:; connect-src ${cspSource}; worker-src blob:;`;
  const entry = source.match(/src="\/rhwp\/assets\/index[^" ]+\.js"/)?.[0];
  if (!entry) throw Error('문서 편집 화면 진입점이 없습니다.');
  source = source.replace(/<script[^>]*registerSW[^>]*><\/script>/g, '').replace(/<link[^>]*rel="(?:manifest|icon|apple-touch-icon)"[^>]*>/g, '');
  source = source.replace(entry, `src="${base}assets/hanul-runtime.js"`);
  source = source.replace(/href="\/rhwp\/assets\/index[^" ]+\.css"/, `href="${base}assets/hanul-runtime.css"`);
  source = source.replace(/(src|href)="\/rhwp\/([^" ]+)"/g, (_all, attribute, path) => `${attribute}="${base}${path}"`);
  source = source.replace(/<script/g, `<script nonce="${nonce}"`);
  const config = JSON.stringify({ base, media, development }).replace(/</g, '\\u003c');
  source = source.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${base}"><script nonce="${nonce}">window.__hanulConfig=${config};</script><script nonce="${nonce}" src="${media}host.js"></script><link rel="stylesheet" href="${media}host.css">`);

  // VS Code 전용: 중복된 상단 hanul-bar를 완전 제거하고 기존 DOM 식별자 호환성만 유지
  const compatHiddenBar = `<div id="hanul-bar" style="display:none !important;" hidden aria-hidden="true"><span class="hanul-logo">H</span><strong>한울</strong><span id="hanul-name"></span><span class="hanul-tag"></span><span id="hanul-state"></span><button id="hanul-new"></button><button id="hanul-open"></button><button id="hanul-save-as"></button><button id="hanul-save"></button></div><div id="hanul-notice" role="status" hidden></div>`;
  return source.replace('<body>', `<body>${compatHiddenBar}`);
}
