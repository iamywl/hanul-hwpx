// This adapter is appended inside the pinned rhwp ES module. Fail closed on upgrades.
window.__hanulEngine = {
  async ready() { await $; if (!hA) throw Error(mA || '문서 엔진을 초기화하지 못했습니다.'); },
  async load(bytes, name) {
    await $;
    await hj(new Uint8Array(bytes), name, null, undefined, { suppressDialogs: true, skipRecent: true });
    if (Y.requiresPasswordForSave) throw Error('이 시제품은 암호 문서 편집·저장을 지원하지 않습니다.');
    return { pages: Y.pageCount, warnings: Y.getValidationWarnings() };
  },
  async create() { await $; await Sj(); return { pages: Y.pageCount }; },
  async export(format) {
    await $;
    if (Y.requiresPasswordForSave) throw Error('암호 문서는 저장할 수 없습니다.');
    const artifact = format === 'hwp' ? Y.exportHwpWithReport() : Y.exportHwpxWithReport();
    if (!artifact.bytes || artifact.contentLoss?.losses?.length) {
      const losses = artifact.contentLoss?.losses || [];
      throw Error('내용 손실이 감지되어 저장을 중단했습니다. ' + JSON.stringify(losses.slice(0, 3)));
    }
    // Reload using an independent document; never swap the live editor during validation.
    const validation = new Y.doc.constructor(artifact.bytes);
    try { if (validation.pageCount() < 1) throw Error('저장 후 문서 재열기 검사에 실패했습니다.'); }
    finally { validation.free(); }
    return Array.from(artifact.bytes);
  },
  async saved(name) { return oA(name); },
  command(id) { return wA.dispatch(id); },
  commands() { return TA.listCommands(); },
  onChange(callback) {
    const off1 = X.on('document-mutated', callback);
    const off2 = X.on('document-changed', callback);
    return () => { off1(); off2(); };
  },
  info() { return { pages: Y.pageCount, format: Y.getSourceFormat(), warnings: Y.getValidationWarnings() }; },
  svg(page = 0) { return Y.renderPageSvg(page); },
  getInputHandler() { return Q; },
  getWasm() { return Y?.doc ?? null; },
  getEventBus() { return X; },
  getDispatcher() { return wA; }
};

