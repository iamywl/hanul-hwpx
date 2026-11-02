import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeHtml } from '../dist/html.mjs';
import { validateBytes } from '../dist/storage.mjs';

export async function startPreview(port = 4317) {
  const root = resolve('.');
  const previewBridge = `window.__previewApi={postMessage(m){window.__previewMessages ||= []; window.__previewMessages.push(m); const send=(method,params={})=>window.postMessage({type:'request',id:crypto.randomUUID(),method,params},location.origin); if(m.type==='ready')send('load',{bytes:[],name:'새 문서.hwpx'}); if(m.type==='new')send('load',{bytes:[],name:'새 문서.hwpx'}); if(m.type==='save'||m.type==='saveAs')send('export',{format:'hwpx'}); if(m.type==='response'&&m.result?.bytes){window.__lastExport=m.result; fetch('/api/save',{method:'POST',body:new Uint8Array(m.result.bytes)}).then(r=>{if(!r.ok)throw Error('저장 실패');send('saved',{name:'preview.hwpx',version:m.result.version});}).catch(e=>console.error(e));}}};`;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const nonce = randomBytes(18).toString('base64');
        let html = makeHtml(await readFile('vendor/studio/index.html', 'utf8'), `${origin}/studio/`, `${origin}/media/`, nonce, "'self'");
        html = html.replace('<head>', `<head><script nonce="${nonce}">${previewBridge}</script>`);
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return;
      }
      if (url.pathname === '/api/save' && request.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 100 * 1024 * 1024) throw Error('Too large'); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks);
        validateBytes(bytes, 'hwpx');
        await mkdir('.preview', { recursive: true }); await writeFile('.preview/preview.hwpx', bytes);
        response.end('ok'); return;
      }
      const relative = url.pathname.startsWith('/studio/') ? `vendor/studio/${url.pathname.slice(8)}` : url.pathname.startsWith('/media/') ? `media/${url.pathname.slice(7)}` : url.pathname.startsWith('/rhwp/') ? `vendor/studio/${url.pathname.slice(6)}` : '';
      const path = resolve(root, relative);
      if (!relative || !path.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
      const types = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
      response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); response.end(await readFile(path));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1]?.endsWith('preview.mjs')) { const preview = await startPreview(); console.log(`미리보기: ${preview.url}`); }
