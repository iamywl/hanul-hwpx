/**
 * Hanul Native Webview Template
 * 한울 코어 엔진의 파싱 결과를 A4 문서 레이아웃으로 미려하게 렌더링합니다.
 */

import type { Webview, Uri } from 'vscode';
import { randomBytes } from 'node:crypto';

export function editorHtml(webview: Webview, extensionUri: Uri, development = false): string {
  const nonce = randomBytes(16).toString('base64');
  const cspSource = webview.cspSource;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}' ${cspSource}; font-src ${cspSource} data:; img-src ${cspSource} data: blob:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>한울 한글 뷰어</title>
  <style>
    :root {
      --hanul-bg: #e9ecef;
      --paper-bg: #ffffff;
      --text-color: #212529;
      --border-color: #ced4da;
      --primary-color: #1a73e8;
      --header-bg: #f8f9fa;
      --table-border: #495057;
      --table-header: #f1f3f5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --hanul-bg: #1e1e1e;
        --paper-bg: #252526;
        --text-color: #cccccc;
        --border-color: #3c3c3c;
        --header-bg: #2d2d2d;
        --table-border: #555555;
        --table-header: #333333;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--hanul-bg);
      color: var(--text-color);
      font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", sans-serif;
      font-size: 14px;
      line-height: 1.6;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #toolbar {
      height: 48px;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 12px;
      flex-shrink: 0;
      user-select: none;
    }
    .logo {
      font-weight: 800;
      color: var(--primary-color);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .logo-badge {
      background: var(--primary-color);
      color: #fff;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
    }
    .meta-tag {
      font-size: 12px;
      color: #6c757d;
      background: rgba(0,0,0,0.05);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .spacer { flex: 1; }
    .search-box {
      display: flex;
      align-items: center;
      background: var(--paper-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 2px 8px;
    }
    .search-box input {
      border: none;
      outline: none;
      background: transparent;
      color: inherit;
      font-size: 12px;
      width: 140px;
    }
    button.btn {
      background: var(--paper-bg);
      border: 1px solid var(--border-color);
      color: inherit;
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }
    button.btn:hover { background: rgba(0,0,0,0.05); }
    button.btn.primary { background: var(--primary-color); color: #fff; border-color: var(--primary-color); }
    
    #viewport {
      flex: 1;
      overflow: auto;
      padding: 32px 16px;
      display: flex;
      justify-content: center;
    }
    #paper {
      width: 800px;
      min-height: 1130px;
      background: var(--paper-bg);
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      border-radius: 2px;
      padding: 60px 50px;
      font-size: 15px;
      position: relative;
    }
    .doc-header {
      border-bottom: 2px solid var(--primary-color);
      padding-bottom: 12px;
      margin-bottom: 30px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .doc-title { font-size: 20px; font-weight: bold; }
    .doc-status { font-size: 12px; color: #28a745; font-weight: bold; }
    .distribution-alert {
      background: #fff3cd;
      color: #856404;
      border: 1px solid #ffeeba;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    p.para {
      margin-bottom: 14px;
      word-break: keep-all;
      white-space: pre-wrap;
    }
    .table-container {
      margin: 24px 0;
      overflow-x: auto;
    }
    table.hanul-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      border: 1px solid var(--table-border);
    }
    table.hanul-table th, table.hanul-table td {
      border: 1px solid var(--table-border);
      padding: 8px 10px;
      vertical-align: middle;
    }
    table.hanul-table th, table.hanul-table tr:first-child td {
      background-color: var(--table-header);
      font-weight: 600;
      text-align: center;
    }
    .highlight { background-color: #fff3cd; color: #000; padding: 1px 2px; }
    #empty-state {
      text-align: center;
      color: #6c757d;
      margin-top: 100px;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <div class="logo">
      <span>한울 Hanul</span>
      <span class="logo-badge" id="doc-format">HWP</span>
    </div>
    <span class="meta-tag" id="doc-version">버전 확인 중...</span>
    <span class="meta-tag" id="doc-stats"></span>
    <div class="spacer"></div>
    <div class="search-box">
      <input type="text" id="search-input" placeholder="문서 검색 (Enter)...">
    </div>
    <button class="btn" id="btn-copy">텍스트 복사</button>
  </div>

  <div id="viewport">
    <div id="paper">
      <div id="empty-state">
        <p>문서를 불러오는 중입니다...</p>
      </div>
      <div id="doc-content" style="display: none;"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentDoc = null;

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'renderDocument') {
        render(msg.data);
      }
    });

    function render(data) {
      currentDoc = data;
      document.getElementById('empty-state').style.display = 'none';
      const container = document.getElementById('doc-content');
      container.style.display = 'block';

      document.getElementById('doc-format').textContent = data.format.toUpperCase();
      document.getElementById('doc-version').textContent = data.version;
      document.getElementById('doc-stats').textContent = \`문단 \${data.paragraphs.length}개 · 표 \${data.tables.length}개\`;

      let html = '';
      if (data.isDistribution) {
        html += \`<div class="distribution-alert">
          <span>🔒 <strong>한컴 배포용 문서 복원 완료</strong>: Hanul Core Engine이 잠긴 공문서 본문을 안전하게 복원했습니다.</span>
        </div>\`;
      }

      // 본문 문단 및 표 렌더링
      const paras = data.paragraphs || [];
      for (const p of paras) {
        if (!p.trim()) continue;
        html += \`<p class="para">\${escapeHtml(p)}</p>\`;
      }

      // 표 렌더링
      if (data.tables && data.tables.length > 0) {
        html += \`<hr style="margin: 30px 0; border: none; border-top: 1px dashed var(--border-color);" />\`;
        html += \`<h3 style="margin-bottom: 16px; font-size: 16px;">문서 내 포함된 표 (\${data.tables.length}개)</h3>\`;
        data.tables.forEach((tbl, idx) => {
          html += \`<div class="table-container">\`;
          html += \`<div style="font-size: 12px; margin-bottom: 6px; color: #6c757d;">[표 \${idx + 1}] \${tbl.rows}행 x \${tbl.cols}열</div>\`;
          html += \`<table class="hanul-table">\`;
          tbl.cells.forEach((row, rIdx) => {
            html += '<tr>';
            row.forEach(cell => {
              const tag = rIdx === 0 ? 'th' : 'td';
              html += \`<\${tag}>\${escapeHtml(cell || '')}</\${tag}>\`;
            });
            html += '</tr>';
          });
          html += \`</table></div>\`;
        });
      }

      container.innerHTML = html;
    }

    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // 복사 버튼
    document.getElementById('btn-copy').addEventListener('click', () => {
      if (!currentDoc) return;
      navigator.clipboard.writeText(currentDoc.fullText).then(() => {
        alert('문서 텍스트 전체가 클립보드에 복사되었습니다.');
      });
    });

    // 검색
    document.getElementById('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const query = e.target.value.trim().toLowerCase();
        if (!query) return;
        const paras = document.querySelectorAll('.para');
        let found = false;
        paras.forEach(p => {
          const text = p.textContent;
          if (text.toLowerCase().includes(query)) {
            p.scrollIntoView({ behavior: 'smooth', block: 'center' });
            p.classList.add('highlight');
            setTimeout(() => p.classList.remove('highlight'), 2000);
            found = true;
          }
        });
        if (!found) alert('일치하는 텍스트가 없습니다.');
      }
    });

    // 준비 완료 알림
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
