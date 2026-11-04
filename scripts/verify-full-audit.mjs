import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startPreview } from './preview.mjs';

const OUT_DIR = resolve('artifacts/audit_shots');
mkdirSync(OUT_DIR, { recursive: true });

function auditContrastInPage(rootSelector = 'body') {
  const parseRgba = (str) => {
    const m = String(str || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const blend = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 255, g: 255, b: 255, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a
    };
  };
  const effectiveBg = (el) => {
    const layers = [];
    let cur = el;
    while (cur && cur !== document) {
      const cs = getComputedStyle(cur);
      const c = parseRgba(cs.backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 0.99) break;
      cur = cur.parentElement;
    }
    const isDark = document.documentElement.dataset.themeEffective === 'dark';
    let base = isDark ? { r: 24, g: 26, b: 32, a: 1 } : { r: 241, g: 245, b: 249, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) {
      base = blend(layers[i], base);
    }
    return base;
  };
  const lum = ({ r, g, b }) => {
    const [sr, sg, sb] = [r, g, b].map(v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
  };
  const ratio = (c1, c2) => {
    const l1 = lum(c1), l2 = lum(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const root = document.querySelector(rootSelector);
  if (!root) return [];
  const issues = [];
  const candidates = root.querySelectorAll('button, input, select, textarea, label, span, div, a, th, td, p, h1, h2, h3, h4');
  for (const el of candidates) {
    if (el.closest('[hidden], .visually-hidden')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.2) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const isDisabled = el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('.disabled');

    let text = '';
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'color' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') continue;
      text = el.value || el.placeholder || (el.options?.[el.selectedIndex]?.text ?? '');
    } else {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) text += n.textContent.trim() + ' ';
      }
      text = text.trim();
    }
    if (!text) continue;

    const bg = effectiveBg(el);
    let fgRaw = parseRgba(cs.color);
    if (fgRaw.a === 0 && cs.webkitTextStrokeWidth && cs.webkitTextStrokeWidth !== '0px') {
      fgRaw = parseRgba(cs.webkitTextStrokeColor);
    }
    const fg = blend(fgRaw, bg);
    const cr = ratio(fg, bg);
    const threshold = isDisabled ? 2.2 : 4.5;
    if (cr < threshold) {
      issues.push({
        tag: el.tagName,
        id: el.id || '',
        cls: String(el.className || '').slice(0, 60),
        text: text.slice(0, 35),
        disabled: !!isDisabled,
        contrast: +cr.toFixed(2),
        fg: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      });
    }
  }
  return issues;
}

const preview = await startPreview(0);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
});

let totalFailures = 0;

try {
  for (const theme of ['dark', 'light']) {
    console.log(`\n==================== AUDIT THEME: ${theme.toUpperCase()} ====================`);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 2,
      colorScheme: theme
    });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push(`PAGEERROR: ${e.message}`));
    page.on('response', r => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) {
        consoleErrors.push(`HTTP ${r.status()}: ${r.url()}`);
      }
    });

    await page.goto(preview.url);
    await page.waitForFunction(() => document.getElementById('hanul-state')?.textContent === '편집 준비 완료', null, { timeout: 45000 });
    await page.evaluate(`window.__hanulAuditContrast = ${auditContrastInPage.toString()};`);
    await page.waitForTimeout(350);

    const kDir = '/Users/ywlee/sideproejct/K_startup/03_reports';
    let hwpBytes;
    let docName = 'sample.hwp';
    if (existsSync(kDir)) {
      const sampleEntry = readdirSync(kDir).find(f => f.normalize('NFC').includes('거래명세서 (2).hwp'));
      if (sampleEntry) {
        hwpBytes = Array.from(readFileSync(join(kDir, sampleEntry)));
        docName = '거래명세서 (2).hwp';
      }
    }
    if (!hwpBytes) {
      hwpBytes = Array.from(readFileSync(resolve('tests/fixtures/distribute_doc_sample.hwp')));
      docName = 'distribute_doc_sample.hwp';
    }
    await page.evaluate(({ bytes, name }) => {
      window.postMessage({ type: 'request', id: 'audit-load', method: 'load', params: { bytes, name } }, location.origin);
    }, { bytes: hwpBytes, name: docName });
    await page.waitForFunction(() => window.__previewMessages?.some(m => m.type === 'response' && m.id === 'audit-load'), null, { timeout: 30000 });
    await page.waitForTimeout(350);

    const chromeCheck = await page.evaluate(() => {
      const w = sel => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().width) : 0;
      };
      const saveBtn = document.getElementById('hanul-menu-save')?.getBoundingClientRect();
      const saveAsBtn = document.getElementById('hanul-menu-save-as')?.getBoundingClientRect();
      return {
        ghostRotateW: w('.tb-rotate-group'),
        ghostHeaderFooterW: w('.tb-headerfooter-group'),
        ghostNoteW: w('.tb-note-group'),
        ghostCompareW: w('[data-cmd="edit:compare-documents"]'),
        saveClipped: !saveBtn || saveBtn.right > window.innerWidth || saveBtn.left < 0,
        saveAsClipped: !saveAsBtn || saveAsBtn.right > window.innerWidth || saveAsBtn.left < 0,
      };
    });
    console.log(`[${theme}] Chrome & Ghost Toolbar Check (1440px):`, JSON.stringify(chromeCheck));
    if (chromeCheck.ghostRotateW > 0 || chromeCheck.ghostHeaderFooterW > 0 || chromeCheck.ghostNoteW > 0 || chromeCheck.ghostCompareW > 0 || chromeCheck.saveClipped || chromeCheck.saveAsClipped) {
      totalFailures++;
    }

    const mainContrastIssues = await page.evaluate(() => window.__hanulAuditContrast('body'));
    console.log(`[${theme}] Main Editor Contrast Issues (${mainContrastIssues.length}):`, JSON.stringify(mainContrastIssues));
    if (mainContrastIssues.length > 0) totalFailures += mainContrastIssues.length;

    const clickTableCell = async () => {
      const pt = await page.evaluate(() => {
        const ih = window.__hanulEngine.getInputHandler();
        const sc = document.getElementById('scroll-content');
        const s = sc.getBoundingClientRect();
        const zoom = ih.viewportManager.getZoom();
        const pl = ih.virtualScroll.getPageLeftResolved(0, sc.clientWidth);
        const po = ih.virtualScroll.getPageOffset(0);
        let bboxes = null;
        for (let ppi = 0; ppi < 30 && !bboxes; ppi++) {
          for (let ci = 0; ci < 5; ci++) {
            try {
              const cand = ih.wasm.getTableCellBboxes(0, ppi, ci, 0);
              if (cand && cand.length) { bboxes = cand; break; }
            } catch {}
          }
        }
        const b = bboxes.find(x => x.row >= 3 && x.w > 40) || bboxes[0];
        return { x: s.left + pl + (b.x + b.w / 2) * zoom, y: s.top + po + (b.y + b.h / 2) * zoom };
      });
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(220);
    };

    await clickTableCell();

    const hudMetrics1440 = await page.evaluate(() => {
      const hud = document.getElementById('hanul-table-bar');
      const r = hud.getBoundingClientRect();
      const btns = Array.from(hud.querySelectorAll('button')).filter(b => getComputedStyle(b).display !== 'none');
      const clippedBtns = btns.filter(b => {
        const br = b.getBoundingClientRect();
        return br.left < 0 || br.right > window.innerWidth || br.left < r.left || br.right > r.right + 1;
      }).map(b => b.textContent.trim());
      return {
        visible: hud.classList.contains('is-active'),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) },
        overflowsViewport: r.x < 0 || r.right > window.innerWidth,
        clippedBtns,
        contrastIssues: window.__hanulAuditContrast('#hanul-table-bar'),
      };
    });
    console.log(`[${theme}] Table HUD @ 1440px:`, JSON.stringify(hudMetrics1440));
    if (!hudMetrics1440.visible || hudMetrics1440.overflowsViewport || hudMetrics1440.clippedBtns.length > 0 || hudMetrics1440.contrastIssues.length > 0) {
      totalFailures++;
    }

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(220);
    const metrics1200 = await page.evaluate(() => {
      const menuBar = document.getElementById('menu-bar');
      const saveBtn = document.getElementById('hanul-menu-save')?.getBoundingClientRect();
      const saveAsBtn = document.getElementById('hanul-menu-save-as')?.getBoundingClientRect();
      const hud = document.getElementById('hanul-table-bar');
      const hr = hud.getBoundingClientRect();
      const hudBtns = Array.from(hud.querySelectorAll('button')).filter(b => getComputedStyle(b).display !== 'none');
      const clippedHudBtns = hudBtns.filter(b => {
        const br = b.getBoundingClientRect();
        return br.left < 0 || br.right > window.innerWidth || br.left < hr.left - 1 || br.right > hr.right + 1;
      }).map(b => b.textContent.trim());
      return {
        menuBarScrollW: menuBar.scrollWidth,
        menuBarClientW: menuBar.clientWidth,
        saveClipped: !saveBtn || saveBtn.right > window.innerWidth || saveBtn.left < 0,
        saveAsClipped: !saveAsBtn || saveAsBtn.right > window.innerWidth || saveAsBtn.left < 0,
        hudClipped: hr.x < 0 || hr.right > window.innerWidth || clippedHudBtns.length > 0,
        clippedHudBtns,
      };
    });
    console.log(`[${theme}] Responsive @ 1200x800:`, JSON.stringify(metrics1200));
    if (metrics1200.saveClipped || metrics1200.saveAsClipped || metrics1200.hudClipped) totalFailures++;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(200);

    for (const menuKey of ['table', 'insert', 'format']) {
      await page.locator(`#menu-bar .menu-item[data-menu="${menuKey}"] .menu-title`).click();
      await page.waitForTimeout(180);
      const ddCheck = await page.evaluate((k) => {
        const sel = `#menu-bar .menu-item[data-menu="${k}"] .menu-dropdown`;
        const hyperlinkDisabled = document.querySelector('[data-cmd="insert:hyperlink"]')?.classList.contains('disabled');
        const bulletDisabled = document.querySelector('[data-cmd="format:bullet-shape"]')?.classList.contains('disabled');
        return {
          contrastIssues: window.__hanulAuditContrast(sel),
          hyperlinkDisabled,
          bulletDisabled,
        };
      }, menuKey);
      console.log(`[${theme}] Menu [${menuKey}] Dropdown Check:`, JSON.stringify(ddCheck));
      if (ddCheck.contrastIssues.length > 0 || ddCheck.hyperlinkDisabled || ddCheck.bulletDisabled) {
        totalFailures += Math.max(1, ddCheck.contrastIssues.length);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }

    const closeAllModals = async () => {
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        document.querySelectorAll('.hanul-modal-overlay').forEach(el => { el.style.display = 'none'; });
        document.querySelector('.find-dialog .dialog-close, .find-dialog button[aria-label="닫기"], .modal-overlay .dialog-close')?.click?.();
        document.querySelector('.find-dialog')?.remove?.();
      });
      await page.waitForTimeout(140);
    };

    await clickTableCell();

    const modalsInTableDoc = [
      { name: 'page_setup', open: () => window.__hanulEngine.command('file:page-setup'), sel: '.dialog-wrap' },
      { name: 'char_shape', open: () => window.__hanulEngine.command('format:char-shape'), sel: '.dialog-wrap' },
      { name: 'para_shape', open: () => window.__hanulEngine.command('format:para-shape'), sel: '.dialog-wrap' },
      { name: 'style_f6', open: () => window.__hanulEngine.command('format:style-dialog'), sel: '.dialog-wrap' },
      { name: 'find_replace', open: () => window.__hanulEngine.command('edit:find-replace'), sel: '.find-dialog' },
      { name: 'symbols', open: () => window.__hanulEngine.command('insert:symbols'), sel: '.sym-dialog' },
      { name: 'table_cell_props', open: () => window.__hanulEngine.command('table:cell-props'), sel: '.dialog-wrap' },
      { name: 'hyperlink', open: () => window.__hanulEngine.command('insert:hyperlink'), sel: '#hanul-hyperlink-modal .hanul-modal-content' },
      { name: 'bullet', open: () => window.__hanulEngine.command('format:bullet-shape'), sel: '#hanul-bullet-modal .hanul-modal-content' },
    ];

    for (const m of modalsInTableDoc) {
      if (m.name === 'table_cell_props') await clickTableCell();
      await page.evaluate(m.open);
      await page.waitForTimeout(260);
      const modalCheck = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false, contrastIssues: [] };
        const r = el.getBoundingClientRect();
        return {
          found: r.width > 0 && r.height > 0,
          contrastIssues: window.__hanulAuditContrast(sel)
        };
      }, m.sel);
      console.log(`[${theme}] Modal [${m.name}]:`, JSON.stringify(modalCheck));
      if (!modalCheck.found || modalCheck.contrastIssues.length > 0) {
        totalFailures += Math.max(1, modalCheck.contrastIssues.length);
      }
      await closeAllModals();
    }

    await clickTableCell();
    await page.locator('#hanul-btn-equation').click();
    await page.waitForTimeout(180);
    const eqTableNotice = await page.locator('#hanul-notice').textContent();
    if (!eqTableNotice?.includes('표 셀 안에서는 수식을 직접 삽입할 수 없습니다')) totalFailures++;

    await page.evaluate(() => window.__hanulEngine.getWasm().createBlankDocument?.() || window.__hanulEngine.command('file:new'));
    await page.waitForTimeout(300);
    await page.locator('#scroll-container').click({ position: { x: 450, y: 220 } });
    await page.waitForTimeout(120);
    await page.locator('#hanul-btn-equation').click();
    await page.waitForTimeout(260);
    const eqModalCheck = await page.evaluate(() => {
      const el = document.querySelector('.eq-dialog');
      if (!el) return { found: false, contrastIssues: [] };
      const r = el.getBoundingClientRect();
      return {
        found: r.width > 0 && r.height > 0,
        contrastIssues: window.__hanulAuditContrast('.eq-dialog')
      };
    });
    console.log(`[${theme}] Modal [equation]:`, JSON.stringify(eqModalCheck));
    if (!eqModalCheck.found || eqModalCheck.contrastIssues.length > 0) {
      totalFailures += Math.max(1, eqModalCheck.contrastIssues.length);
    }
    await closeAllModals();

    if (theme === 'dark') {
      const cmdAudit = await page.evaluate(() => {
        const reg = window.__hanulEngine.getRegistry?.();
        const items = Array.from(document.querySelectorAll('[data-cmd]'));
        const missing = [];
        const total = new Set();
        for (const el of items) {
          if (el.hidden || el.closest('[hidden]')) continue;
          const cmd = el.getAttribute('data-cmd');
          if (!cmd || total.has(cmd)) continue;
          total.add(cmd);
          if (!reg?.get?.(cmd)) missing.push({ cmd, label: el.textContent.trim().slice(0, 40) });
        }
        const unwiredTbBtns = Array.from(document.querySelectorAll('#icon-toolbar .tb-btn')).filter(el => {
          if (el.hidden || el.closest('[hidden]')) return false;
          if (el.classList.contains('tb-split-arrow') || el.closest('.tb-split-wrap')) return false;
          return !el.getAttribute('data-cmd') && el.dataset.hanulWired !== '1' && !el.id;
        }).map(el => el.title || el.textContent.trim());
        return { totalVisibleCmds: total.size, missing, unwiredTbBtns };
      });
      console.log('Registry [data-cmd] & Toolbar Wiring Audit:', JSON.stringify(cmdAudit));
      if (cmdAudit.missing.length > 0 || cmdAudit.unwiredTbBtns.length > 0) {
        totalFailures += cmdAudit.missing.length + cmdAudit.unwiredTbBtns.length;
      }

      await page.locator('#scroll-container').click({ position: { x: 450, y: 220 } });
      await page.keyboard.type('가나다라마바사 테스트 문단입니다.');
      await page.waitForTimeout(150);

      const canvasWBefore = await page.evaluate(() => document.querySelector('#scroll-container canvas')?.width || 0);
      await page.evaluate(() => window.__hanulEngine.command('file:page-setup'));
      await page.waitForTimeout(220);
      await page.locator('.modal-overlay .icon-radio-card', { hasText: '가로' }).click();
      await page.locator('.modal-overlay .dialog-btn-primary').click();
      await page.waitForTimeout(280);
      const canvasWAfter = await page.evaluate(() => document.querySelector('#scroll-container canvas')?.width || 0);
      if (!(canvasWAfter > canvasWBefore)) totalFailures++;

      await page.locator('#icon-toolbar button[title*="하이퍼링크"]').click();
      await page.waitForTimeout(180);
      const hlOpened = await page.evaluate(() => getComputedStyle(document.getElementById('hanul-hyperlink-modal')).display === 'flex');
      await page.fill('#hanul-link-text', '한울공식사이트');
      await page.fill('#hanul-link-url', 'https://hanul.example.com');
      await page.click('#hanul-hyperlink-confirm');
      await page.waitForTimeout(200);
      const hlHits = await page.evaluate(() => window.__hanulEngine.getWasm().searchText('한울공식사이트')?.length || 0);
      if (!hlOpened || hlHits < 1) totalFailures++;

      await page.evaluate(() => window.__hanulEngine.command('edit:find-replace'));
      await page.waitForTimeout(200);
      const frInputs = page.locator('.find-dialog-input');
      await frInputs.nth(0).fill('가나다라마바사');
      await frInputs.nth(1).fill('한울에디터완성');
      await page.locator('.find-dialog button', { hasText: '모두 바꾸기' }).click();
      await page.waitForTimeout(220);
      const replaceHits = await page.evaluate(() => window.__hanulEngine.getWasm().searchText('한울에디터완성')?.length || 0);
      if (replaceHits < 1) totalFailures++;
      await closeAllModals();

      await page.locator('#scroll-container').click({ position: { x: 450, y: 220 } });
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.evaluate(() => { void window.__hanulEngine.command('table:create'); });
      await page.waitForTimeout(180);
      await page.getByText('표 만들기...', { exact: false }).last().click();
      await page.waitForTimeout(150);
      await page.locator('.modal-overlay input[type="number"]').nth(0).fill('2');
      await page.locator('.modal-overlay input[type="number"]').nth(1).fill('2');
      await page.getByRole('button', { name: '만들기', exact: true }).click();
      await page.waitForTimeout(280);
      await page.keyboard.insertText('셀삭제테스트');
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const ih = window.__hanulEngine.getInputHandler();
        const pos = ih.cursor.getPosition();
        window.__testTblRef = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex };
      });
      const cellBeforeDel = await page.evaluate(() => {
        const r = window.__testTblRef;
        return (window.__hanulEngine.getWasm().getTextInCell(r.sec, r.ppi, r.ci, 0, 0, 0, 999) || '').trim();
      });
      await page.keyboard.press('F5');
      await page.waitForTimeout(120);
      await page.locator('#hanul-btn-merge').click();
      await page.waitForTimeout(120);
      const singleMergeNotice = await page.locator('#hanul-notice').textContent();
      await page.keyboard.press('Delete');
      await page.waitForTimeout(180);
      const cellAfterDel = await page.evaluate(() => {
        const r = window.__testTblRef;
        return (window.__hanulEngine.getWasm().getTextInCell(r.sec, r.ppi, r.ci, 0, 0, 0, 999) || '').trim();
      });
      await page.keyboard.press('Meta+z');
      await page.waitForTimeout(200);
      const cellAfterUndo = await page.evaluate(() => {
        const r = window.__testTblRef;
        return (window.__hanulEngine.getWasm().getTextInCell(r.sec, r.ppi, r.ci, 0, 0, 0, 999) || '').trim();
      });
      const cellsBeforeMerge = await page.evaluate(() => {
        const r = window.__testTblRef;
        return window.__hanulEngine.getInputHandler().wasm.getTableCellBboxes(r.sec, r.ppi, r.ci, 0).length;
      });
      await page.evaluate(() => {
        const ih = window.__hanulEngine.getInputHandler();
        if (ih.cursor.isInCellSelectionMode()) ih.cursor.exitCellSelectionMode();
      });
      await page.keyboard.press('F5');
      await page.keyboard.press('F5');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(120);
      await page.keyboard.press('m');
      await page.waitForTimeout(200);
      const cellsAfterMerge = await page.evaluate(() => {
        const r = window.__testTblRef;
        return window.__hanulEngine.getInputHandler().wasm.getTableCellBboxes(r.sec, r.ppi, r.ci, 0).length;
      });
      if (
        cellBeforeDel !== '셀삭제테스트' ||
        !singleMergeNotice?.includes('2개 이상') ||
        cellAfterDel !== '' ||
        cellAfterUndo !== '셀삭제테스트' ||
        cellsAfterMerge !== cellsBeforeMerge - 1
      ) {
        totalFailures++;
      }
    }

    if (consoleErrors.length > 0) totalFailures += consoleErrors.length;
    await ctx.close();
  }

  console.log(`\n==================== FINAL DEEP AUDIT SUMMARY ====================`);
  console.log(`Total Failures: ${totalFailures}`);
  if (totalFailures > 0) process.exitCode = 1;
} finally {
  await browser.close();
  await preview.close();
}
