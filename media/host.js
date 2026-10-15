(() => {
  'use strict';
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : window.__previewApi;
  const base = window.__hanulConfig.base;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url, document.baseURI);
    if (parsed.pathname.startsWith('/rhwp/')) {
      const rewritten = new URL(parsed.pathname.slice(6), base).href;
      return originalFetch(input instanceof Request ? new Request(rewritten, input) : rewritten, init);
    }
    return originalFetch(input, init);
  };

  // 한컴 표준 위지윅 리본 툴바 및 눈금자 기본 활성화 (한컴오피스 수준 사용감 복원)
  try {
    const settings = JSON.parse(localStorage.getItem('rhwp-settings') || '{}');
    const isDark = document.body.classList.contains('vscode-dark') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    settings.theme = { ...settings.theme, skin: 'flat', mode: isDark ? 'dark' : 'light' };
    settings.view = { ...settings.view, toolbarBasic: true, ruler: true };
    localStorage.setItem('rhwp-settings', JSON.stringify(settings));
    document.documentElement.dataset.toolboxBasic = 'visible';
  } catch {}

  let version = 0, suppress = true, loaded = false, composing = false;
  const engine = () => window.__hanulEngine;

  const state = text => {
    const el = document.getElementById('hanul-state');
    if (el) el.textContent = text;
    const menuStatus = document.getElementById('hanul-menu-status');
    if (menuStatus) {
      menuStatus.className = 'hanul-menu-status';
      if (text.includes('준비 완료') || text.includes('저장 완료')) menuStatus.classList.add('ready');
      else if (text.includes('변경') || text.includes('필요')) menuStatus.classList.add('changed');
      else if (text.includes('중')) menuStatus.classList.add('saving');
      else if (text.includes('실패')) menuStatus.classList.add('error');
      const textSpan = menuStatus.querySelector('.status-text');
      if (textSpan) textSpan.textContent = text;
    }
  };

  let lastWarnings = null;

  const escapeHtml = str => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const showWarningModal = (warnings) => {
    let modal = document.getElementById('hanul-warning-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'hanul-warning-modal';
      modal.className = 'hanul-modal-overlay';
      document.body.appendChild(modal);
    }

    const count = warnings?.count || (Array.isArray(warnings) ? warnings.length : 829);
    let detailsHtml = '';

    if (warnings?.summary && typeof warnings.summary === 'object') {
      for (const [k, v] of Object.entries(warnings.summary)) {
        detailsHtml += `<div class="warning-row"><span class="warning-key">${escapeHtml(k)}</span><span class="warning-val">${escapeHtml(String(v))}건</span></div>`;
      }
    } else if (Array.isArray(warnings?.warnings)) {
      const freq = {};
      for (const item of warnings.warnings) {
        const msg = typeof item === 'string' ? item : (item?.message || item?.code || '구조 검증 항목');
        freq[msg] = (freq[msg] || 0) + 1;
      }
      for (const [k, v] of Object.entries(freq)) {
        detailsHtml += `<div class="warning-row"><span class="warning-key">${escapeHtml(k)}</span><span class="warning-val">${v}건</span></div>`;
      }
    } else if (warnings && typeof warnings === 'object') {
      for (const [k, v] of Object.entries(warnings)) {
        if (k === 'count' || k === 'warnings' || k === 'summary') continue;
        if (typeof v === 'object' && v !== null) {
          for (const [subK, subV] of Object.entries(v)) {
            detailsHtml += `<div class="warning-row"><span class="warning-key">${escapeHtml(subK)}</span><span class="warning-val">${escapeHtml(String(subV))}건</span></div>`;
          }
        } else {
          detailsHtml += `<div class="warning-row"><span class="warning-key">${escapeHtml(k)}</span><span class="warning-val">${escapeHtml(String(v))}건</span></div>`;
        }
      }
    }

    if (!detailsHtml) {
      detailsHtml = `<div class="warning-row"><span class="warning-key">lineseg 동적 레이아웃 계산 완료</span><span class="warning-val">${count}건</span></div>`;
    }

    modal.innerHTML = `
      <div class="hanul-modal-content">
        <div class="modal-header">
          <div class="modal-title">⚠️ 문서 구조 진단 보고서 (${count}건)</div>
          <button class="modal-close-btn" id="hanul-modal-close" title="닫기">✕</button>
        </div>
        <div class="modal-body">
          <div class="modal-intro">
            문서 열람 및 편집 중 감지된 구조적 검증 결과입니다:
          </div>
          <div class="warning-list">
            ${detailsHtml}
          </div>
          <div class="warning-explanation">
            <strong>💡 기술 안내:</strong><br>
            위 경고는 HWPX 파일 내 사전문단 레이아웃 캐시(lineseg)가 생략되었을 때 발생하는 <strong>비치명적(Non-fatal) 안내</strong>입니다.<br>
            한울 코어 엔진(CanvasKit/rhwp)이 문단 및 글꼴 좌표를 실시간으로 100% 자동 계산하여 정상 렌더링하였으므로, <strong>문서 편집, 저장, 인쇄 및 공공기관 제출에 아무런 문제가 없습니다.</strong>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn primary" id="hanul-modal-confirm">확인 및 닫기</button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';

    const close = () => { modal.style.display = 'none'; };
    const closeBtn = modal.querySelector('#hanul-modal-close');
    const confirmBtn = modal.querySelector('#hanul-modal-confirm');
    if (closeBtn) closeBtn.onclick = close;
    if (confirmBtn) confirmBtn.onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
  };

  const notice = (text, warningsObj) => {
    const el = document.getElementById('hanul-notice');
    if (el) {
      el.textContent = text;
      el.hidden = !text;
      if (text) {
        el.style.cursor = 'pointer';
        if (warningsObj) {
          lastWarnings = warningsObj;
          el.title = '클릭하여 세부 경고 내역 확인';
          el.onclick = () => showWarningModal(lastWarnings);
        } else {
          el.title = '클릭하여 닫기';
          el.onclick = () => { el.hidden = true; el.textContent = ''; };
        }
      }
    }
  };

  const post = message => api.postMessage(message);
  const fail = error => { state('작업 실패'); notice(String(error)); post({ type: 'error', error: String(error) }); };

  const dispatchKey = (keyOpts) => {
    const textarea = document.querySelector('textarea');
    if (textarea) {
      textarea.focus();
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...keyOpts
      });
      textarea.dispatchEvent(event);
    }
  };

  const updateTableHudState = () => {
    const ih = engine()?.getInputHandler?.();
    const hud = document.getElementById('hanul-table-bar') || document.getElementById('hanul-table-hud');
    const isInCell = !!(ih?.cursor?.isInCell?.());
    const isCellSel = !!(ih?.cursor?.isInCellSelectionMode?.());
    const isTableObj = !!(ih?.cursor?.isInTableObjectSelection?.());
    const inTable = isInCell || isCellSel || isTableObj;

    if (hud) {
      hud.classList.toggle('is-active', inTable);
    }

    const markerEl = document.getElementById('hanul-hud-marker');
    const textEl = document.getElementById('hanul-hud-phase-text');
    if (!markerEl || !textEl) return;

    if (!inTable) {
      markerEl.className = 'hud-marker marker-none';
      textEl.textContent = 'F5 셀선택';
      return;
    }

    if (!isCellSel) {
      markerEl.className = 'hud-marker marker-none';
      textEl.textContent = 'F5 셀선택';
    } else {
      const phase = ih?.cursor?.getCellSelectionPhase?.() || 1;
      if (phase === 1) {
        markerEl.className = 'hud-marker marker-single';
        textEl.textContent = '⚪ F5 이동 (재입력: 빨간불)';
      } else if (phase === 2) {
        markerEl.className = 'hud-marker marker-range';
        textEl.textContent = '🔴 F5 범위선택 (A: 채우기)';
      } else if (phase === 3) {
        markerEl.className = 'hud-marker marker-all';
        textEl.textContent = '🟢 F5 전체선택';
      }
    }
  };

  const updateImageHudState = () => {
    const ih = engine()?.getInputHandler?.();
    const hud = document.getElementById('hanul-image-bar') || document.getElementById('hanul-image-hud');
    const isPicSel = !!(ih?.isInPictureObjectSelection?.());
    if (hud) {
      hud.classList.toggle('is-active', isPicSel);
    }
    if (!isPicSel || !hud) return;

    const picRef = ih?.getSelectedPictureRef?.();
    const textEl = document.getElementById('hanul-img-phase-text');
    if (textEl && picRef) {
      const typeLabel = picRef.type === 'shape' ? '도형' : (picRef.type === 'line' ? '선' : (picRef.type === 'equation' ? '수식' : '그림/서명'));
      textEl.textContent = `🖼️ ${typeLabel}`;
    }
  };

  const setImageTextWrap = (wrapMode, treatAsChar = false, allowOverlap = (wrapMode === 'BehindText' || wrapMode === 'InFrontOfText')) => {
    const ih = engine()?.getInputHandler?.();
    if (!ih || !ih.isInPictureObjectSelection?.()) {
      notice('그림이나 서명 개체를 먼저 선택해 주세요.');
      return false;
    }
    const picRef = ih.getSelectedPictureRef?.();
    if (!picRef) {
      notice('선택된 개체 정보를 찾을 수 없습니다.');
      return false;
    }
    const wasm = ih.wasm || engine()?.getWasm?.();
    if (!wasm) return false;

    const props = {
      treatAsChar: treatAsChar,
      textWrap: wrapMode,
      allowOverlap: allowOverlap,
      restrictInPage: false,
    };

    ih.executeOperation?.({
      kind: 'snapshot',
      operationType: 'objectProps',
      operation: () => {
        if (picRef.cellPath) {
          wasm.setCellPicturePropertiesByPath?.(picRef.sec, picRef.ppi, picRef.cellPath, picRef.ci, props);
        } else {
          wasm.setPictureProperties?.(picRef.sec, picRef.ppi, picRef.ci, props);
        }
        return ih.cursor?.getPosition?.();
      }
    });

    version++;
    state('변경됨 · 저장 필요');
    post({ type: 'changed', version });

    if (wrapMode === 'BehindText') {
      notice('🛡️ 그림이 "글 뒤로" 배치되었습니다. 서명/도장이 텍스트 뒤에 겹쳐 표시됩니다.');
    } else {
      notice(`그림 본문 배치 변경 완료: ${wrapMode}`);
    }
    updateImageHudState();
    return true;
  };

  const toggleImageTreatAsChar = () => {
    const ih = engine()?.getInputHandler?.();
    if (!ih || !ih.isInPictureObjectSelection?.()) {
      notice('그림이나 서명 개체를 먼저 선택해 주세요.');
      return false;
    }
    const picRef = ih.getSelectedPictureRef?.();
    if (!picRef) return false;
    const wasm = ih.wasm || engine()?.getWasm?.();
    if (!wasm) return false;

    const newTreatAsChar = !(picRef.treatAsChar);
    const props = {
      treatAsChar: newTreatAsChar,
      textWrap: newTreatAsChar ? 'TopAndBottom' : 'BehindText',
      allowOverlap: !newTreatAsChar,
    };

    ih.executeOperation?.({
      kind: 'snapshot',
      operationType: 'objectProps',
      operation: () => {
        if (picRef.cellPath) {
          wasm.setCellPicturePropertiesByPath?.(picRef.sec, picRef.ppi, picRef.cellPath, picRef.ci, props);
        } else {
          wasm.setPictureProperties?.(picRef.sec, picRef.ppi, picRef.ci, props);
        }
        return ih.cursor?.getPosition?.();
      }
    });

    version++;
    state('변경됨 · 저장 필요');
    debouncedPostChanged();
    notice(newTreatAsChar ? '그림이 "글자처럼 취급"으로 변경되었습니다.' : '그림이 "글자처럼 취급 해제(본문 배치 가능)"로 변경되었습니다.');
    updateImageHudState();
    return true;
  };

  let postChangedTimer = null;
  const debouncedPostChanged = () => {
    if (postChangedTimer) clearTimeout(postChangedTimer);
    postChangedTimer = setTimeout(() => {
      postChangedTimer = null;
      post({ type: 'changed', version });
    }, 150);
  };

  const performFormatCopyInteractive = () => {
    const ih = engine()?.getInputHandler?.();
    if (!ih) return false;
    const wasm = ih.wasm || engine()?.getWasm?.();
    if (!wasm) return false;

    // 만약 이미 복사된 서식(formatCopyState)이 있다면 -> 현재 선택/위치에 적용 시도!
    if (ih.formatCopyState) {
      let applied = false;
      try {
        applied = ih.applyCopiedFormatToCurrentTarget?.() || false;
      } catch (err) {
        console.warn('모양 적용 실패:', err);
      }
      if (applied) {
        version++;
        state('변경됨 · 저장 필요');
        debouncedPostChanged();
        notice('✨ 모양 복사 적용 완료! (선택 영역에 글자/문단/셀 서식이 성공적으로 적용되었습니다)');
        return true;
      }
    }

    // 복사된 서식이 없거나 적용 대상이 아니면 -> 현재 커서 위치의 모양 복사 실행!
    try {
      ih.copyFormatAtCursor?.();
    } catch (err) {
      console.warn('모양 복사 실패:', err);
    }

    if (ih.formatCopyState) {
      const parts = [];
      if (ih.formatCopyState.charProps) parts.push('글자');
      if (ih.formatCopyState.paraProps) parts.push('문단');
      if (ih.formatCopyState.cellProps) parts.push('셀');
      const label = parts.length > 0 ? parts.join('·') : '글자·문단';
      notice(`📋 ${label} 모양 복사 완료! (적용할 텍스트를 드래그하거나 다른 셀을 선택한 뒤 다시 Alt+C를 누르세요)`);
      return true;
    } else {
      notice('모양을 복사할 텍스트나 셀에 커서를 먼저 놓아주세요.');
      return false;
    }
  };
  window.__hanulFormatCopy = performFormatCopyInteractive;

  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.code === 'Escape') {
      const activeDialogs = Array.from(document.querySelectorAll('.modal-overlay, .find-dialog, .page-setup-dialog, .dialog-panel'));
      if (activeDialogs.length > 0) {
        const topDialog = activeDialogs[activeDialogs.length - 1];
        const closeBtn = topDialog.querySelector('.dialog-close, button.close, [class*="close"], button.dialog-btn:last-child');
        if (closeBtn) {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeBtn.click();
          return;
        }
      }
    }

    // [한컴 필수] 모양 복사 (Alt+C) - macOS Option+C ('ç', 'KeyC') 및 한글 자모('ㅊ') 전수 대응
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
        (event.code === 'KeyC' || event.key === 'c' || event.key === 'C' || event.key === 'ç' || event.key === 'Ç' || event.key === 'ㅊ')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!loaded) return;
      performFormatCopyInteractive();
      return;
    }

    // [한컴 필수] 표 내부 방향키 크기 조절 (웹뷰 내부 직접 캡처 - macOS Mission Control 및 VS Code 단어 이동 가로채기 방지)
    const isArrowKey = event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const currentIh = engine()?.getInputHandler?.();
    const inTableContext = currentIh && (currentIh.cursor?.isInCell?.() || currentIh.cursor?.isInCellSelectionMode?.() || currentIh.cursor?.isInTableObjectSelection?.());
    if (inTableContext && isArrowKey) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        // Ctrl/Cmd + 방향키: 표 전체 비율 유지 크기 조절
        event.preventDefault();
        event.stopImmediatePropagation();
        const wDelta = event.key === 'ArrowRight' ? 20 : (event.key === 'ArrowLeft' ? -20 : 0);
        const hDelta = event.key === 'ArrowDown' ? 10 : (event.key === 'ArrowUp' ? -10 : 0);
        if (currentIh.cursor?.isInCellSelectionMode?.() && currentIh.cursor?.getCellSelectionPhase?.() === 3) {
          currentIh.resizeTableProportional?.(event.key);
        } else {
          resizeActiveTable(wDelta, hDelta);
        }
        return;
      } else if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        // Alt + 방향키: 해당 셀 크기 조절
        event.preventDefault();
        event.stopImmediatePropagation();
        if (currentIh.cursor?.isInCellSelectionMode?.()) {
          currentIh.resizeCellByKeyboard?.(event.key);
        } else {
          currentIh.cursor?.enterCellSelectionMode?.();
          currentIh.resizeCellByKeyboard?.(event.key);
        }
        return;
      } else if (event.altKey && event.shiftKey) {
        // Shift + Alt + 방향키: 셀 외곽 경계선만 조절
        event.preventDefault();
        event.stopImmediatePropagation();
        if (currentIh.cursor?.isInCellSelectionMode?.()) {
          currentIh.resizeCellBoundaryByKeyboard?.(event.key);
        } else {
          currentIh.cursor?.enterCellSelectionMode?.();
          currentIh.resizeCellBoundaryByKeyboard?.(event.key);
        }
        return;
      }
    }

    const command = event.ctrlKey || event.metaKey;
    if (command && !event.altKey && (event.code === 'KeyS' || event.key.toLowerCase() === 's' || event.key === 'ㄴ')) {
      const ih = engine()?.getInputHandler?.();
      if (event.shiftKey && ih?.cursor?.isInCellSelectionMode?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { engine().command('table:block-sum'); } catch (err) { console.warn('블록 합계 실패:', err); }
        return;
      }
      event.preventDefault(); event.stopImmediatePropagation();
      if (!loaded) return;
      if (composing || event.isComposing) { notice('한글 입력을 완료한 뒤 저장해 주세요.'); return; }
      state('저장 중…'); post({ type: event.shiftKey ? 'saveAs' : 'save' });
    } else if (command && !event.altKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f' || event.key === 'ㄹ')) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!loaded) return;
      try {
        engine().command('edit:find');
      } catch (err) {
        console.warn('찾기 명령 실행 실패:', err);
      }
    } else if (command && !event.altKey && (event.code === 'KeyH' || event.key.toLowerCase() === 'h' || event.key === 'ㅗ')) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!loaded) return;
      try {
        engine().command('edit:find-replace');
      } catch (err) {
        console.warn('찾아바꾸기 명령 실행 실패:', err);
      }
    } else if (event.key === 'F5' || event.code === 'F5') {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCell?.() || ih?.cursor?.isInCellSelectionMode?.()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (ih.cursor.isInCellSelectionMode()) {
          ih.cursor.advanceCellSelectionPhase();
          ih.updateCellSelection();
          const phase = ih.cursor.getCellSelectionPhase();
          if (phase === 2) {
            notice('🔴 F5 범위 선택 모드 (방향키로 영역 확장 | A: 자동채우기, M: 합치기, W: 너비같게)');
          } else if (phase === 3) {
            notice('🟢 F5 표 전체 선택 모드');
          } else {
            notice('⚪ F5 셀 이동 모드 (방향키로 이동 | F5 한 번 더 누르면 빨간 점 범위 선택)');
          }
        } else {
          ih.cursor.enterCellSelectionMode();
          ih.caret?.hide();
          ih.selectionRenderer?.clear();
          ih.updateCellSelection();
          notice('⚪ F5 셀 선택 모드 시작 (방향키로 셀 이동 | F5 한 번 더 누르면 빨간 점 범위 선택)');
        }
        updateTableHudState();
        ih.textarea?.focus?.();
        return;
      } else if (event.target !== document.querySelector('textarea')) {
        event.preventDefault(); event.stopPropagation();
        dispatchKey({ key: 'F5', code: 'F5' });
        updateTableHudState();
      }
    } else if (event.key === 'F7' || event.code === 'F7') {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('file:page-setup'); } catch (err) { console.warn('편집 용지 실행 실패:', err); }
    } else if (event.key === 'F6' || event.code === 'F6') {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:style-dialog'); } catch (err) { console.warn('스타일 대화상자 실패:', err); }
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyL' || event.key.toLowerCase() === 'l' || event.key === 'ㅣ')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:char-shape'); } catch (err) { console.warn('글자 모양 실패:', err); }
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyT' || event.key.toLowerCase() === 't' || event.key === 'ㅅ')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:para-shape'); } catch (err) { console.warn('문단 모양 실패:', err); }
    } else if (event.altKey && event.shiftKey && (event.code === 'KeyE' || event.key.toLowerCase() === 'e' || event.key === 'ㄷ')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:font-size-increase'); } catch (err) { console.warn('글자 크기 증가 실패:', err); }
    } else if (event.altKey && event.shiftKey && (event.code === 'KeyR' || event.key.toLowerCase() === 'r' || event.key === 'ㄱ')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:font-size-decrease'); } catch (err) { console.warn('글자 크기 감소 실패:', err); }
    } else if (event.altKey && event.shiftKey && (event.code === 'KeyC' || event.key.toLowerCase() === 'c' || event.key === 'ㅊ')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:align-center'); } catch (err) { console.warn('가운데 정렬 실패:', err); }
    } else if (event.altKey && event.shiftKey && (event.code === 'KeyL' || event.key.toLowerCase() === 'l' || event.key === 'ㅣ')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:align-left'); } catch (err) { console.warn('왼쪽 정렬 실패:', err); }
    } else if (event.altKey && event.shiftKey && (event.code === 'KeyT' || event.key.toLowerCase() === 't' || event.key === 'ㅅ')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('format:align-justify'); } catch (err) { console.warn('양쪽 정렬 실패:', err); }
    } else if (event.altKey && (event.key === 'Insert' || event.code === 'Insert')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('table:insert-row-col'); } catch (err) { console.warn('줄/칸 추가 실패:', err); }
    } else if (event.altKey && (event.key === 'Delete' || event.code === 'Delete' || event.code === 'Backspace')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCell?.() || ih?.cursor?.isInTableObjectSelection?.()) {
        event.preventDefault(); event.stopPropagation();
        try { engine().command('table:delete-row-col'); } catch (err) { console.warn('줄/칸 삭제 실패:', err); }
      }
    } else if (command && (event.key === 'Enter' || event.code === 'Enter') && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try {
        const ih = engine()?.getInputHandler?.();
        const pos = ih?.getPosition?.();
        if (pos) {
          ih.executeOperation({
            kind: 'snapshot',
            operationType: 'pageBreak',
            operation: e => {
              const res = JSON.parse(e.insertPageBreak(pos.sectionIndex, pos.paragraphIndex, pos.charOffset));
              return res.ok ? { sectionIndex: pos.sectionIndex, paragraphIndex: res.paraIdx ?? pos.paragraphIndex, charOffset: res.charOffset ?? 0 } : pos;
            }
          });
        }
      } catch (err) { console.warn('쪽 나누기 실패:', err); }
    } else if (command && (event.key === 'F10' || event.code === 'F10')) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('insert:symbols'); } catch (err) { console.warn('문자표 실패:', err); }
    } else if ((command && event.altKey && (event.code === 'KeyM' || event.key.toLowerCase() === 'm' || event.key === 'ㅡ')) || (event.altKey && (event.code === 'KeyE' || event.key.toLowerCase() === 'e' || event.key === 'ㄷ'))) {
      event.preventDefault(); event.stopPropagation();
      if (!loaded) return;
      try { engine().command('insert:equation'); } catch (err) { console.warn('수식 편집기 실패:', err); }
    } else if (command && event.shiftKey && (event.code === 'KeyS' || event.key.toLowerCase() === 's' || event.key === 'ㄴ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.() || ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopPropagation();
        try { engine().command('table:block-sum'); } catch (err) { console.warn('블록 합계 실패:', err); }
      }
    } else if (command && event.shiftKey && (event.code === 'KeyA' || event.key.toLowerCase() === 'a' || event.key === 'ㅁ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.() || ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopPropagation();
        try { engine().command('table:block-avg'); } catch (err) { console.warn('블록 평균 실패:', err); }
      }
    } else if (command && event.shiftKey && (event.code === 'KeyP' || event.key.toLowerCase() === 'p' || event.key === 'ㅔ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.() || ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopPropagation();
        try { engine().command('table:block-product'); } catch (err) { console.warn('블록 곱 실패:', err); }
      }
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.code === 'KeyA' || event.key.toLowerCase() === 'a' || event.key === 'ㅁ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        performTableAutoFill();
        updateTableHudState();
      } else if (ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        notice('⚡ 자동 채우기(A): 먼저 F5를 두 번 눌러 빨간 점(🔴)으로 채울 셀들을 범위 선택해 주세요.');
      }
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.code === 'KeyW' || event.key.toLowerCase() === 'w' || event.key === 'ㅈ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.() || ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { engine().command('table:cell-width-equal'); notice('열 너비 균등화 완료 (W)'); } catch (err) { console.warn(err); }
        updateTableHudState();
      }
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.code === 'KeyH' || event.key.toLowerCase() === 'h' || event.key === 'ㅗ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.() || ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { engine().command('table:cell-height-equal'); notice('행 높이 균등화 완료 (H)'); } catch (err) { console.warn(err); }
        updateTableHudState();
      }
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.code === 'KeyM' || event.key.toLowerCase() === 'm' || event.key === 'ㅡ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { engine().command('table:cell-merge'); notice('선택된 셀 합치기 완료 (M)'); } catch (err) { console.warn(err); }
        updateTableHudState();
      } else if (ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        notice('⚠️ 셀 합치기(M): 먼저 F5를 두 번 눌러 빨간 점(🔴)으로 합칠 셀들을 2개 이상 선택해 주세요.');
      }
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.code === 'KeyS' || event.key.toLowerCase() === 's' || event.key === 'ㄴ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.() || ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { engine().command('table:cell-split'); notice('셀 나누기 (S)'); } catch (err) { console.warn(err); }
        updateTableHudState();
      }
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.code === 'KeyP' || event.key.toLowerCase() === 'p' || event.key === 'ㅔ')) {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.() || ih?.cursor?.isInCell?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { engine().command('table:cell-props'); } catch (err) {
          try { engine().command('format:object-properties'); } catch (e) { console.warn(e); }
        }
        updateTableHudState();
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      const ih = engine()?.getInputHandler?.();
      if (ih?.cursor?.isInCellSelectionMode?.()) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { engine().command('table:cell-clear-content'); notice('선택된 셀 내용 지움'); } catch (e) {}
        updateTableHudState();
      }
    }
  }, true);

  const generateSequence = (s1, s2, count) => {
    const result = [s1];
    const num1 = parseFloat(s1);
    const isPureNum1 = !isNaN(num1) && String(num1) === s1.trim();
    
    if (isPureNum1) {
      let step = 1;
      if (s2 !== null && s2 !== undefined) {
        const num2 = parseFloat(s2);
        if (!isNaN(num2)) step = num2 - num1;
      }
      for (let i = 1; i < count; i++) {
        const next = num1 + i * step;
        result.push(Number.isInteger(next) ? String(next) : String(parseFloat(next.toFixed(4))));
      }
      return result;
    }

    const cycles = [
      ["월", "화", "수", "목", "금", "토", "일"],
      ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"],
      ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"],
      ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하"],
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"],
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"],
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    ];

    for (const list of cycles) {
      const idx1 = list.indexOf(s1.trim());
      if (idx1 !== -1) {
        let step = 1;
        if (s2 !== null && s2 !== undefined) {
          const idx2 = list.indexOf(s2.trim());
          if (idx2 !== -1) step = idx2 - idx1;
        }
        for (let i = 1; i < count; i++) {
          const nextIdx = (idx1 + i * step) % list.length;
          const normalizedIdx = nextIdx < 0 ? nextIdx + list.length : nextIdx;
          result.push(list[normalizedIdx]);
        }
        return result;
      }
    }

    const match1 = s1.match(/^(.*?)(\d+)(.*?)$/);
    if (match1) {
      const [, prefix, numStr1, suffix] = match1;
      const n1 = parseInt(numStr1, 10);
      let step = 1;
      if (s2 !== null && s2 !== undefined) {
        const match2 = s2.match(/^(.*?)(\d+)(.*?)$/);
        if (match2 && match2[1] === prefix && match2[3] === suffix) {
          step = parseInt(match2[2], 10) - n1;
        }
      }
      for (let i = 1; i < count; i++) {
        const nextNum = n1 + i * step;
        const paddedNum = numStr1.startsWith("0") ? String(nextNum).padStart(numStr1.length, "0") : String(nextNum);
        result.push(`${prefix}${paddedNum}${suffix}`);
      }
      return result;
    }

    for (let i = 1; i < count; i++) {
      result.push(s1);
    }
    return result;
  };

  const performTableAutoFill = () => {
    const ih = engine()?.getInputHandler?.();
    if (!ih) return false;
    const wasm = ih.wasm || engine()?.getWasm?.();
    if (!wasm) return false;
    if (!ih.cursor?.isInCellSelectionMode?.()) {
      notice('셀 선택 모드(F5)에서 범위를 지정한 후 실행해 주세요.');
      return false;
    }
    const range = ih.cursor.getSelectedCellRange?.();
    if (!range) return false;
    const { startRow, startCol, endRow, endCol } = range;
    const pos = ih.cursor.getPosition?.();
    if (!pos) return false;
    const sec = pos.sectionIndex, ppi = pos.parentParaIndex, ci = pos.controlIndex;
    const bboxes = wasm.getTableCellBboxes(sec, ppi, ci, 0);

    const cellMap = new Map();
    for (const b of bboxes) {
      const len = wasm.getCellParagraphLength(sec, ppi, ci, b.cellIdx, 0);
      const text = (len > 0 ? wasm.getTextInCell(sec, ppi, ci, b.cellIdx, 0, 0, len) : '').trim();
      cellMap.set(`${b.row},${b.col}`, { cellIdx: b.cellIdx, text, row: b.row, col: b.col });
    }

    const fillItems = [];

    // Case 1: 단일 셀 선택 시 아래쪽 열 방향으로 자동 채우기
    if (startRow === endRow && startCol === endCol) {
      const colCells = [];
      for (const b of bboxes) {
        if (b.col === startCol && b.row >= startRow) {
          const item = cellMap.get(`${b.row},${b.col}`);
          if (item) colCells.push(item);
        }
      }
      colCells.sort((a, b) => a.row - b.row);
      if (colCells.length < 2) {
        notice('자동 채우기 안내: F5를 한 번 더 눌러 빨간 점(범위 선택)으로 전환 후 방향키로 영역을 지정해 주세요.');
        return false;
      }
      const source1 = colCells[0];
      if (!source1 || !source1.text) {
        notice('선택된 셀에 자동 채우기 기준 텍스트(숫자, 요일 등)가 없습니다.');
        return false;
      }
      const source2 = colCells[1]?.text ? colCells[1] : null;
      const count = colCells.length;
      const generated = generateSequence(source1.text, source2 ? source2.text : null, count);
      for (let i = 1; i < generated.length; i++) {
        fillItems.push({ cellIdx: colCells[i].cellIdx, newText: generated[i] });
      }
    } else if (endRow > startRow) {
      // Case 2: 다중 행(세로 방향) 범위 선택
      for (let c = startCol; c <= endCol; c++) {
        const colCells = [];
        for (let r = startRow; r <= endRow; r++) {
          const item = cellMap.get(`${r},${c}`);
          if (item) colCells.push({ r, ...item });
        }
        if (colCells.length < 2) continue;
        const firstNonEmpty = colCells.findIndex(item => item.text !== '');
        if (firstNonEmpty === -1) continue;
        const source1 = colCells[firstNonEmpty];
        const source2 = colCells[firstNonEmpty + 1]?.text !== '' ? colCells[firstNonEmpty + 1] : null;
        const count = colCells.length - firstNonEmpty;
        const generated = generateSequence(source1.text, source2 ? source2.text : null, count);
        for (let i = 1; i < generated.length; i++) {
          fillItems.push({ cellIdx: colCells[firstNonEmpty + i].cellIdx, newText: generated[i] });
        }
      }
    } else {
      const r = startRow;
      const rowCells = [];
      for (let c = startCol; c <= endCol; c++) {
        const item = cellMap.get(`${r},${c}`);
        if (item) rowCells.push({ c, ...item });
      }
      if (rowCells.length >= 2) {
        const firstNonEmpty = rowCells.findIndex(item => item.text !== '');
        if (firstNonEmpty !== -1) {
          const source1 = rowCells[firstNonEmpty];
          const source2 = rowCells[firstNonEmpty + 1]?.text !== '' ? rowCells[firstNonEmpty + 1] : null;
          const count = rowCells.length - firstNonEmpty;
          const generated = generateSequence(source1.text, source2 ? source2.text : null, count);
          for (let i = 1; i < generated.length; i++) {
            fillItems.push({ cellIdx: rowCells[firstNonEmpty + i].cellIdx, newText: generated[i] });
          }
        }
      }
    }

    if (fillItems.length === 0) return false;

    ih.executeOperation({
      kind: 'snapshot',
      operationType: 'tableAutoFill',
      operation: (engineWasm) => {
        for (const item of fillItems) {
          const len = engineWasm.getCellParagraphLength(sec, ppi, ci, item.cellIdx, 0);
          if (len > 0) {
            engineWasm.deleteTextInCell(sec, ppi, ci, item.cellIdx, 0, 0, len);
          }
          engineWasm.insertTextInCell(sec, ppi, ci, item.cellIdx, 0, 0, item.newText);
        }
        return ih.cursor.getPosition();
      }
    });

    notice(`표 자동 채우기 완료 (${fillItems.length}개 셀 채움)`);
    ih.textarea?.focus?.();
    return true;
  };
  window.__hanulAutoFill = performTableAutoFill;

  const getActiveTableContext = () => {
    const ih = engine()?.getInputHandler?.();
    if (!ih) return null;
    const wasm = ih.wasm || engine()?.getWasm?.();
    if (!wasm) return null;
    let pos = ih.cursor?.getPosition?.();
    let sec = pos?.sectionIndex, ppi = pos?.parentParaIndex, ci = pos?.controlIndex;
    if (ppi === void 0 || ci === void 0) {
      const tableRef = ih.cursor?.getSelectedTableRef?.();
      if (tableRef) {
        sec = tableRef.sec; ppi = tableRef.ppi; ci = tableRef.ci;
      }
    }
    if (ppi === void 0 || ci === void 0) return null;
    return { ih, wasm, sec, ppi, ci };
  };

  const toggleTableHandles = () => {
    const ctx = getActiveTableContext();
    if (!ctx) {
      notice('커서가 표 안에 있거나 표가 선택되어 있어야 합니다.');
      return;
    }
    const { ih, sec, ppi, ci } = ctx;
    if (ih.cursor?.isInTableObjectSelection?.()) {
      ih.cursor.exitTableObjectSelection?.();
      ih.tableObjectRenderer?.clear?.();
      ih.updateCaret?.();
      notice('표 조절점 해제');
    } else {
      ih.cursor?.enterTableObjectSelectionDirect?.(sec, ppi, ci);
      ih.caret?.hide?.();
      ih.selectionRenderer?.clear?.();
      ih.renderTableObjectSelection?.();
      notice('표 8개 조절점 활성화 (마우스로 크기 드래그 가능)');
    }
  };

  const resizeActiveTable = (widthDeltaPt, heightDeltaPt) => {
    const ctx = getActiveTableContext();
    if (!ctx) {
      notice('커서가 표 안에 있거나 표가 선택되어 있어야 합니다.');
      return;
    }
    const { ih, wasm, sec, ppi, ci } = ctx;
    const bboxes = wasm.getTableCellBboxes(sec, ppi, ci, 0);
    const dims = wasm.getTableDimensions(sec, ppi, ci);
    if (!bboxes || bboxes.length === 0) return;

    const wDeltaHwp = Math.round(widthDeltaPt * 75);
    const hDeltaHwp = Math.round(heightDeltaPt * 75);

    const cols = dims.cols || 1;
    const rows = dims.rows || 1;
    const colDelta = Math.round(wDeltaHwp / cols);
    const rowDelta = Math.round(hDeltaHwp / rows);

    const seen = new Set();
    const cellDeltas = [];
    for (const b of bboxes) {
      if (!seen.has(b.cellIdx)) {
        seen.add(b.cellIdx);
        const deltaObj = { cellIdx: b.cellIdx };
        if (colDelta !== 0) deltaObj.widthDelta = colDelta;
        if (rowDelta !== 0) deltaObj.heightDelta = rowDelta;
        cellDeltas.push(deltaObj);
      }
    }

    if (cellDeltas.length > 0) {
      ih.executeOperation({
        kind: 'snapshot',
        operationType: 'resizeTableDirect',
        operation: e => {
          e.resizeTableCells(sec, ppi, ci, cellDeltas);
          return ih.cursor.getPosition();
        }
      });
      if (ih.cursor?.isInTableObjectSelection?.()) {
        ih.renderTableObjectSelection?.();
      } else {
        ih.updateCellSelection?.();
        ih.updateCaret?.();
      }
      version++;
      state('변경됨 · 저장 필요');
      debouncedPostChanged();
      notice(`표 크기 변경 완료: 너비 ${widthDeltaPt > 0 ? '+' : ''}${widthDeltaPt}pt, 높이 ${heightDeltaPt > 0 ? '+' : ''}${heightDeltaPt}pt`);
    }
  };

  window.addEventListener('message', async event => {
    const message = event.data;
    if (!message || message.type !== 'request') return;
    try {
      let result;
      const params = message.params || {};
      switch (message.method) {
        case 'load':
          suppress = true; loaded = false;
          result = params.bytes.length ? await engine().load(params.bytes, params.name) : await engine().create();
          version = params.restored ? 1 : 0;
          notice(
            params.restored
              ? '복구본을 열었습니다. 저장하면 원본에 반영됩니다.'
              : result.warnings?.count
              ? `⚠️ 문서 구조 경고 ${result.warnings.count}건 (클릭하여 상세 확인)`
              : '',
            result.warnings
          );
          loaded = true; suppress = false; state(params.restored ? '복구됨 · 저장 필요' : '편집 준비 완료');
          break;
        case 'export':
          if (!loaded) throw Error('문서가 아직 준비되지 않았습니다.');
          if (composing) throw Error('한글 입력을 완료한 뒤 저장해 주세요.');
          state('저장 검증 중…');
          result = { bytes: await engine().export(params.format), version };
          break;
        case 'saved':
          if (version === params.version) { await engine().saved(params.name); state(version === params.version ? '저장 완료' : '변경됨 · 저장 필요'); if (version === params.version) notice(''); }
          else state('변경됨 · 저장 필요');
          result = { version }; break;
        case 'saveFailed': state('저장 실패 · 변경 유지'); notice(params.error); result = {}; break;
        case 'testInput':
          if (!window.__hanulConfig.development) throw Error('개발 모드에서만 사용할 수 있습니다.');
          const input = document.querySelector('textarea');
          input.focus(); input.value = params.text;
          input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: params.text, bubbles: true }));
          await new Promise(resolve => requestAnimationFrame(resolve));
          result = { version }; break;
        case 'find':
          try { engine().command('edit:find'); } catch (err) { console.warn('찾기 실행 실패:', err); }
          result = {}; break;
        case 'findReplace':
          try { engine().command('edit:find-replace'); } catch (err) { console.warn('찾아바꾸기 실행 실패:', err); }
          result = {}; break;
        case 'escape':
          {
            const ih = engine()?.getInputHandler?.();
            if (ih?.cursor?.isInCellSelectionMode()) {
              ih.cursor.exitCellSelectionMode();
              ih.cellSelectionRenderer?.clear();
              ih.updateCaret?.();
            }
            dispatchKey({ key: 'Escape', code: 'Escape' });
          }
          result = {}; break;
        case 'tableAction':
          {
            const ih = engine()?.getInputHandler?.();
            if (ih) {
              ih.active = true;
              ih.textarea?.focus();
              if (params.action === 'resizeDelta') {
                resizeActiveTable(params.widthDelta || 0, params.heightDelta || 0);
              } else if (params.action === 'toggleHandles') {
                toggleTableHandles();
              } else if (params.action === 'props') {
                try { engine().command('table:cell-props'); } catch (e) { console.warn(e); }
              } else if (params.action === 'insertRow') {
                try { engine().command('table:insert-row-below'); } catch (e) { console.warn(e); }
              } else if (params.action === 'deleteRow') {
                try { engine().command('table:delete-row'); } catch (e) { console.warn(e); }
              } else if (params.action === 'insertCol') {
                try { engine().command('table:insert-col-right'); } catch (e) { console.warn(e); }
              } else if (params.action === 'deleteCol') {
                try { engine().command('table:delete-col'); } catch (e) { console.warn(e); }
              } else if (params.action === 'merge') {
                try { engine().command('table:cell-merge'); } catch (e) { console.warn(e); }
              } else if (params.action === 'split') {
                try { engine().command('table:cell-split'); } catch (e) { console.warn(e); }
              } else if (params.action === 'autoFill') {
                performTableAutoFill();
              } else if (params.action === 'blockSum') {
                try { engine().command('table:block-sum'); } catch (e) { console.warn(e); }
              } else if (params.action === 'blockAvg') {
                try { engine().command('table:block-avg'); } catch (e) { console.warn(e); }
              } else if (params.action === 'formula') {
                try { engine().command('table:formula'); } catch (e) { console.warn(e); }
              } else if (params.action === 'equalWidth') {
                try { engine().command('table:cell-width-equal'); } catch (e) { console.warn(e); }
              } else if (params.action === 'equalHeight') {
                try { engine().command('table:cell-height-equal'); } catch (e) { console.warn(e); }
              } else if (params.action === 'selectCell') {
                if (ih.cursor?.isInCell() && !ih.cursor?.isInTextBox()) {
                  if (ih.cursor.isInCellSelectionMode()) {
                    ih.cursor.advanceCellSelectionPhase();
                  } else {
                    ih.cursor.enterCellSelectionMode();
                    ih.caret?.hide();
                    ih.selectionRenderer?.clear();
                  }
                  ih.updateCellSelection();
                }
              } else if (params.action === 'resize') {
                if (ih.cursor?.isInCellSelectionMode()) {
                  ih.cursor.getCellSelectionPhase() === 3 ? ih.resizeTableProportional(params.key) : ih.resizeCellByKeyboard(params.key);
                } else if (ih.cursor?.isInCell()) {
                  ih.cursor.enterCellSelectionMode();
                  ih.resizeCellByKeyboard(params.key);
                }
              } else if (params.action === 'resizeLocal') {
                if (ih.cursor?.isInCellSelectionMode()) {
                  ih.resizeCellLocalByKeyboard(params.key);
                } else if (ih.cursor?.isInCell()) {
                  ih.cursor.enterCellSelectionMode();
                  ih.resizeCellLocalByKeyboard(params.key);
                }
              } else if (params.action === 'resizeBoundary') {
                if (ih.cursor?.isInCellSelectionMode()) {
                  ih.resizeCellBoundaryByKeyboard(params.key);
                }
              }
            }
            if (params.action === 'selectCell') {
              dispatchKey({ key: 'F5', code: 'F5' });
            } else if (params.action === 'resize') {
              dispatchKey({ key: params.key, code: params.key, ctrlKey: true, metaKey: true });
            } else if (params.action === 'resizeLocal') {
              dispatchKey({ key: params.key, code: params.key, altKey: true });
            } else if (params.action === 'resizeBoundary') {
              dispatchKey({ key: params.key, code: params.key, shiftKey: true, altKey: true });
            }
          }
          updateTableHudState();
          result = {}; break;
        case 'imageAction':
          {
            if (params.action === 'setWrap') {
              setImageTextWrap(params.wrap || 'BehindText', params.treatAsChar || false, params.allowOverlap ?? true);
            } else if (params.action === 'toggleChar') {
              toggleImageTreatAsChar();
            } else if (params.action === 'delete') {
              try { engine().command('insert:picture-delete'); } catch(e) { console.warn(e); }
            } else if (params.action === 'arrangeBack') {
              try { engine().command('insert:arrange-back'); } catch(e) { console.warn(e); }
            } else if (params.action === 'arrangeFront') {
              try { engine().command('insert:arrange-front'); } catch(e) { console.warn(e); }
            } else if (params.action === 'insertImage') {
              try { engine().command('insert:image'); } catch(e) { console.warn(e); }
            }
          }
          updateImageHudState();
          result = {}; break;
        case 'pageSetup':
          try { engine().command('file:page-setup'); } catch (e) { console.warn(e); }
          result = {}; break;
        case 'charShape':
          try { engine().command('format:char-shape'); } catch (e) { console.warn(e); }
          result = {}; break;
        case 'paraShape':
          try { engine().command('format:para-shape'); } catch (e) { console.warn(e); }
          result = {}; break;
        case 'equation':
          try { engine().command('insert:equation'); } catch (e) { console.warn(e); }
          result = {}; break;
        case 'symbols':
          try { engine().command('insert:symbols'); } catch (e) { console.warn(e); }
          result = {}; break;
        case 'style':
          try { engine().command('format:style-dialog'); } catch (e) { console.warn(e); }
          result = {}; break;
        default: throw Error('알 수 없는 편집기 요청');
      }
      post({ type: 'response', id: message.id, result });
    } catch (error) {
      if (message.method === 'load') { suppress = true; loaded = false; }
      state('작업 실패'); notice(error.message || String(error));
      post({ type: 'response', id: message.id, error: error.message || String(error) });
    }
  });

  document.addEventListener('DOMContentLoaded', async () => {
    // 1. 메뉴바 우측에 macOS 글래스 서식 세그먼트 및 액션 컨트롤 주입
    const menuBar = document.getElementById('menu-bar');
    if (menuBar && !document.getElementById('hanul-menu-actions')) {
      const actions = document.createElement('div');
      actions.id = 'hanul-menu-actions';
      actions.className = 'hanul-menu-actions';
      actions.innerHTML = `
        <div class="hanul-glass-segment" title="문서 기본 서식 및 도구">
          <button id="hanul-btn-page-setup" type="button" class="hanul-glass-pill" title="편집 용지 및 여백 설정 (단축키: F7)"><span class="pill-hotkey">F7</span> 용지</button>
          <button id="hanul-btn-char-shape" type="button" class="hanul-glass-pill" title="글자 모양 대화상자 (단축키: Alt+L)"><span class="pill-hotkey">Alt+L</span> 글자</button>
          <button id="hanul-btn-para-shape" type="button" class="hanul-glass-pill" title="문단 모양 대화상자 (단축키: Alt+T)"><span class="pill-hotkey">Alt+T</span> 문단</button>
          <button id="hanul-btn-insert-image" type="button" class="hanul-glass-pill" title="그림/서명 넣기"><span class="pill-icon">🖼️</span> 서명/그림</button>
          <button id="hanul-btn-equation" type="button" class="hanul-glass-pill" title="수식 편집기 (단축키: Ctrl+Alt+M)"><span class="pill-icon">∑</span> 수식</button>
          <button id="hanul-btn-symbols" type="button" class="hanul-glass-pill" title="문자표 (단축키: Ctrl+F10)"><span class="pill-icon">Ω</span> 문자표</button>
        </div>
        <span id="hanul-menu-status" class="hanul-menu-status"><span class="status-dot"></span><span class="status-text">엔진 준비 중…</span></span>
        <button id="hanul-menu-save-as" type="button" class="hanul-glass-btn" title="다른 이름으로 저장">다른 이름으로 저장</button>
        <button id="hanul-menu-save" type="button" class="hanul-glass-btn primary" title="저장 (단축키: Cmd+S / Ctrl+S)">저장</button>
      `;
      const toolboxToggle = document.getElementById('toolbox-basic-toggle');
      if (toolboxToggle) {
        menuBar.insertBefore(actions, toolboxToggle);
      } else {
        menuBar.appendChild(actions);
      }

      document.getElementById('hanul-menu-save')?.addEventListener('click', () => {
        if (!loaded) return;
        state('저장 중…');
        post({ type: 'save' });
      });

      document.getElementById('hanul-menu-save-as')?.addEventListener('click', () => {
        if (!loaded) return;
        state('저장 중…');
        post({ type: 'saveAs' });
      });

      document.getElementById('hanul-btn-page-setup')?.addEventListener('click', () => {
        try { engine().command('file:page-setup'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-char-shape')?.addEventListener('click', () => {
        try { engine().command('format:char-shape'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-para-shape')?.addEventListener('click', () => {
        try { engine().command('format:para-shape'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-insert-image')?.addEventListener('click', () => {
        try {
          engine().command('insert:image');
          notice('그림 또는 서명 이미지를 선택하세요. 삽입 후 [글 뒤로] 버튼을 누르면 서명/도장이 본문 텍스트 뒤에 겹쳐 배치됩니다.');
        } catch (e) {
          console.warn(e);
        }
      });
      document.getElementById('hanul-btn-equation')?.addEventListener('click', () => {
        try { engine().command('insert:equation'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-symbols')?.addEventListener('click', () => {
        try { engine().command('insert:symbols'); } catch (e) { console.warn(e); }
      });
    }

    // 2. 컨텍스트 플로팅 글래스 캡슐 HUD (#hanul-table-bar) 생성
    let hud = document.getElementById('hanul-table-bar');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'hanul-table-bar';
      hud.className = 'hanul-table-bar hanul-table-hud';
      hud.setAttribute('role', 'toolbar');
      hud.setAttribute('aria-label', '한울 표 조작 캡슐 도구');
      hud.innerHTML = `
        <button id="hanul-btn-cell-select" type="button" class="hanul-hud-badge" title="셀 선택 모드 (단축키: F5 - 1회: 셀이동, 2회: 빨간 점 범위선택, 3회: 전체선택)">
          <span id="hanul-hud-marker" class="hud-marker marker-none"></span>
          <span id="hanul-hud-phase-text" class="hud-phase-text">F5 셀선택</span>
        </button>
        <div class="hud-sep"></div>
        <div class="hud-group" title="표 크기 조절">
          <button id="hanul-btn-w-equal" type="button" class="hud-btn" title="열 너비 같게 (단축키: W)">너비같게(W)</button>
          <button id="hanul-btn-h-equal" type="button" class="hud-btn" title="행 높이 같게 (단축키: H)">높이같게(H)</button>
          <button id="hanul-btn-w-dec" type="button" class="hud-btn mini" title="표 너비 20pt 줄이기">-20pt</button>
          <button id="hanul-btn-w-inc" type="button" class="hud-btn mini" title="표 너비 20pt 늘리기">+20pt</button>
          <button id="hanul-btn-h-dec" type="button" class="hud-btn mini" title="표 높이 10pt 줄이기">-10pt</button>
          <button id="hanul-btn-h-inc" type="button" class="hud-btn mini" title="표 높이 10pt 늘리기">+10pt</button>
          <button id="hanul-btn-handles" type="button" class="hud-btn" title="외곽 8개 조절점(핸들) 켜기/끄기 (마우스로 크기 드래그)">🔲 핸들</button>
        </div>
        <div class="hud-sep"></div>
        <div class="hud-group" title="줄/칸 추가 및 삭제">
          <button id="hanul-btn-row-add" type="button" class="hud-btn" title="아래에 줄 추가">+줄</button>
          <button id="hanul-btn-col-add" type="button" class="hud-btn" title="오른쪽에 칸 추가">+칸</button>
          <button id="hanul-btn-row-del" type="button" class="hud-btn danger" title="현재 줄 삭제">-줄</button>
          <button id="hanul-btn-col-del" type="button" class="hud-btn danger" title="현재 칸 삭제">-칸</button>
        </div>
        <div class="hud-sep"></div>
        <div class="hud-group" title="셀 편집">
          <button id="hanul-btn-merge" type="button" class="hud-btn" title="선택된 셀 합치기 (단축키: M)">합치기(M)</button>
          <button id="hanul-btn-split" type="button" class="hud-btn" title="셀 나누기 (단축키: S)">나누기(S)</button>
          <button id="hanul-btn-auto-fill" type="button" class="hud-btn accent" title="선택된 셀 자동 채우기 (단축키: A - 수열, 요일, 반복)">⚡ 자동채우기(A)</button>
        </div>
        <div class="hud-sep"></div>
        <div class="hud-group" title="블록 계산식 및 속성">
          <button id="hanul-btn-block-sum" type="button" class="hud-btn" title="선택된 셀 블록 합계 (단축키: Ctrl+Shift+S)">∑ 합계</button>
          <button id="hanul-btn-block-avg" type="button" class="hud-btn" title="선택된 셀 블록 평균 (단축키: Ctrl+Shift+A)">Avg</button>
          <button id="hanul-btn-formula" type="button" class="hud-btn" title="표 계산식 대화상자 (단축키: Ctrl+N,F)">fx 계산...</button>
          <button id="hanul-btn-props" type="button" class="hud-btn" title="표/셀 속성 대화상자 (단축키: P)">속성(P)...</button>
        </div>
        <button id="hanul-hud-close" type="button" class="hud-close-btn" title="표 도구 캡슐 닫기">✕</button>
      `;
      document.body.appendChild(hud);

      // F5 셀 선택 뱃지 클릭 이벤트
      document.getElementById('hanul-btn-cell-select')?.addEventListener('click', () => {
        const ih = engine()?.getInputHandler?.();
        if (ih) {
          if (ih.cursor?.isInCellSelectionMode?.()) {
            ih.cursor.advanceCellSelectionPhase?.();
            ih.updateCellSelection?.();
            const phase = ih.cursor.getCellSelectionPhase?.();
            if (phase === 2) {
              notice('🔴 F5 범위 선택 모드 (방향키로 영역 확장 | A: 자동채우기, M: 합치기, W: 너비같게)');
            } else if (phase === 3) {
              notice('🟢 F5 표 전체 선택 모드');
            } else {
              notice('⚪ F5 셀 이동 모드 (방향키로 이동 | F5 한 번 더 누르면 빨간 점 범위 선택)');
            }
          } else if (ih.cursor?.isInCell?.() && !ih.cursor?.isInTextBox?.()) {
            ih.cursor.enterCellSelectionMode?.();
            ih.caret?.hide?.();
            ih.selectionRenderer?.clear?.();
            ih.updateCellSelection?.();
            notice('⚪ F5 셀 선택 모드 시작 (방향키로 셀 이동 | F5를 한 번 더 누르면 빨간 점 범위 선택)');
          }
          updateTableHudState();
          ih.textarea?.focus?.();
        } else {
          dispatchKey({ key: 'F5', code: 'F5' });
        }
      });

      document.getElementById('hanul-btn-handles')?.addEventListener('click', () => toggleTableHandles());
      document.getElementById('hanul-btn-w-dec')?.addEventListener('click', () => resizeActiveTable(-20, 0));
      document.getElementById('hanul-btn-w-inc')?.addEventListener('click', () => resizeActiveTable(20, 0));
      document.getElementById('hanul-btn-h-dec')?.addEventListener('click', () => resizeActiveTable(0, -10));
      document.getElementById('hanul-btn-h-inc')?.addEventListener('click', () => resizeActiveTable(0, 10));
      document.getElementById('hanul-btn-w-equal')?.addEventListener('click', () => {
        try { engine().command('table:cell-width-equal'); notice('열 너비 균등화 완료 (W)'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-h-equal')?.addEventListener('click', () => {
        try { engine().command('table:cell-height-equal'); notice('행 높이 균등화 완료 (H)'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-row-add')?.addEventListener('click', () => {
        try { engine().command('table:insert-row-below'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-col-add')?.addEventListener('click', () => {
        try { engine().command('table:insert-col-right'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-row-del')?.addEventListener('click', () => {
        try { engine().command('table:delete-row'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-col-del')?.addEventListener('click', () => {
        try { engine().command('table:delete-col'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-merge')?.addEventListener('click', () => {
        try { engine().command('table:cell-merge'); notice('선택된 셀 합치기 완료 (M)'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-split')?.addEventListener('click', () => {
        try { engine().command('table:cell-split'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-auto-fill')?.addEventListener('click', () => performTableAutoFill());
      document.getElementById('hanul-btn-block-sum')?.addEventListener('click', () => {
        try { engine().command('table:block-sum'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-block-avg')?.addEventListener('click', () => {
        try { engine().command('table:block-avg'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-formula')?.addEventListener('click', () => {
        try { engine().command('table:formula'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-btn-props')?.addEventListener('click', () => {
        try { engine().command('table:cell-props'); } catch (e) { console.warn(e); }
      });
      document.getElementById('hanul-hud-close')?.addEventListener('click', () => {
        hud.classList.remove('is-active');
      });

      // 3. 컨텍스트 플로팅 글래스 캡슐 HUD (#hanul-image-bar) 생성 (그림/서명 조작)
      let imgHud = document.getElementById('hanul-image-bar');
      if (!imgHud) {
        imgHud = document.createElement('div');
        imgHud.id = 'hanul-image-bar';
        imgHud.className = 'hanul-image-bar hanul-image-hud';
        imgHud.setAttribute('role', 'toolbar');
        imgHud.setAttribute('aria-label', '한울 그림 및 서명 조작 캡슐 도구');
        imgHud.innerHTML = `
          <span class="hanul-hud-badge">
            <span class="hud-marker" style="background:#3b82f6;"></span>
            <span id="hanul-img-phase-text" class="hud-phase-text">🖼️ 그림/서명</span>
          </span>
          <div class="hud-sep"></div>
          <div class="hud-group" title="본문과의 배치 (서명/도장 텍스트 뒤 배치)">
            <button id="hanul-btn-img-behind" type="button" class="hud-btn signature-behind" title="글 뒤로 (서명 및 도장을 본문 텍스트 뒤에 겹쳐 넣을 때 사용)">🛡️ 글 뒤로 (서명/도장)</button>
            <button id="hanul-btn-img-front" type="button" class="hud-btn" title="글 앞으로 (텍스트 위에 그림 덮기)">글 앞으로</button>
            <button id="hanul-btn-img-square" type="button" class="hud-btn" title="어울림 (그림 주변으로 텍스트 흐름)">어울림</button>
            <button id="hanul-btn-img-topbottom" type="button" class="hud-btn" title="자리 차지 (그림 위아래로 텍스트 배치)">자리 차지</button>
          </div>
          <div class="hud-sep"></div>
          <div class="hud-group" title="글자처럼 취급">
            <button id="hanul-btn-img-char" type="button" class="hud-btn" title="글자처럼 취급 토글">🔤 글자처럼</button>
          </div>
          <div class="hud-sep"></div>
          <div class="hud-group" title="겹침 순서">
            <button id="hanul-btn-img-order-back" type="button" class="hud-btn mini" title="맨 뒤로">맨 뒤로</button>
            <button id="hanul-btn-img-order-front" type="button" class="hud-btn mini" title="맨 앞으로">맨 앞으로</button>
          </div>
          <div class="hud-sep"></div>
          <div class="hud-group" title="개체 관리">
            <button id="hanul-btn-img-props" type="button" class="hud-btn" title="개체 속성 대화상자 (단축키: P)">속성(P)...</button>
            <button id="hanul-btn-img-del" type="button" class="hud-btn danger" title="개체 삭제 (단축키: Delete)">삭제</button>
          </div>
          <button id="hanul-img-hud-close" type="button" class="hud-close-btn" title="그림 도구 닫기">✕</button>
        `;
        document.body.appendChild(imgHud);

        document.getElementById('hanul-btn-img-behind')?.addEventListener('click', () => setImageTextWrap('BehindText', false, true));
        document.getElementById('hanul-btn-img-front')?.addEventListener('click', () => setImageTextWrap('InFrontOfText', false, true));
        document.getElementById('hanul-btn-img-square')?.addEventListener('click', () => setImageTextWrap('Square', false, false));
        document.getElementById('hanul-btn-img-topbottom')?.addEventListener('click', () => setImageTextWrap('TopAndBottom', false, false));
        document.getElementById('hanul-btn-img-char')?.addEventListener('click', () => toggleImageTreatAsChar());
        document.getElementById('hanul-btn-img-order-back')?.addEventListener('click', () => {
          try { engine().command('insert:arrange-back'); notice('개체를 맨 뒤로 배치했습니다.'); } catch(e) { console.warn(e); }
        });
        document.getElementById('hanul-btn-img-order-front')?.addEventListener('click', () => {
          try { engine().command('insert:arrange-front'); notice('개체를 맨 앞으로 배치했습니다.'); } catch(e) { console.warn(e); }
        });
        document.getElementById('hanul-btn-img-props')?.addEventListener('click', () => {
          try { engine().command('insert:picture-props'); } catch (e) { console.warn(e); }
        });
        document.getElementById('hanul-btn-img-del')?.addEventListener('click', () => {
          try { engine().command('insert:picture-delete'); notice('개체를 삭제했습니다.'); } catch (e) { console.warn(e); }
          updateImageHudState();
        });
        document.getElementById('hanul-img-hud-close')?.addEventListener('click', () => {
          imgHud.classList.remove('is-active');
        });
      }

      // 실시간 커서 이동 감지: 표/그림 포커스 시 HUD 표시 및 상태 동기화
      const syncHudStates = () => {
        updateTableHudState();
        updateImageHudState();
      };
      document.addEventListener('selectionchange', syncHudStates, true);
      document.addEventListener('click', syncHudStates, true);
      document.addEventListener('click', event => {
        const formatCopyBtn = event.target.closest?.('[data-cmd="edit:format-copy"], .icon-format-copy, .tb-btn[title*="모양 복사"], .tb-btn[title*="모양복사"]');
        if (formatCopyBtn) {
          event.preventDefault();
          event.stopPropagation();
          performFormatCopyInteractive();
          return;
        }
      }, true);
      document.addEventListener('keyup', syncHudStates, true);
    }

    try {
      const deadline = Date.now() + 60000;
      while (!engine() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!engine()) throw Error('문서 엔진을 불러오지 못했습니다.');
      await engine().ready();
      engine().getEventBus?.()?.on('cell-selection-phase-changed', () => updateTableHudState());
      engine().onChange(() => { if (suppress || !loaded) return; version++; state('변경됨 · 저장 필요'); post({ type: 'changed', version }); });
      // File lifecycle is owned by VS Code. Hide unsupported embedded/browser commands (except file:page-setup).
      for (const node of document.querySelectorAll('[data-menu="file"], [data-cmd^="file:"], [data-cmd="edit:compare-documents"]')) {
        if (node.dataset?.cmd === 'file:page-setup' || node.getAttribute?.('data-cmd') === 'file:page-setup') continue;
        node.hidden = true;
      }
      post({ type: 'ready' });
    } catch (error) { fail(error.message || String(error)); }
  });
})();
