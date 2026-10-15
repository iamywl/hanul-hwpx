import { readFile, writeFile } from 'node:fs/promises';
export async function patchStudio() {
  const html = await readFile('vendor/studio/index.html', 'utf8');
  const entry = html.match(/src="\/rhwp\/(assets\/index[^" ]+\.js)"/)[1];
  let code = await readFile(`vendor/studio/${entry}`, 'utf8');
  for (const anchor of ['var $=VA();', 'gA=await hh()', 'var vA=uD(window.location.search)', 'async function Sj()', 'async function hj(', 'window.rhwpStudio=']) {
    if (!code.includes(anchor)) throw Error(`Pinned runtime adapter requires review: ${anchor}`);
  }
  code = code.replace('gA=await hh()', 'gA={disableExternalWebFonts:!0}')
    .replace('var vA=uD(window.location.search)', 'var vA=uD("?chrome=embed")')
    .replace('$.then(()=>{hA&&mD()})', '$.then(()=>{})');

  // [Hanul Permanent Core Patch 1] pu 함수 보강 (hover 캐시 비동기 레이스 방지 & 즉각 hitTest 폴백)
  const puTarget = "function pu(e,t,n,r){if(e.cachedTableRef&&e.cachedCellBboxes?.length){let n=e.cachedCellBboxes.filter(e=>e.pageIndex===t);if(n.length>0)return{tableRef:e.cachedTableRef,bboxes:e.cachedCellBboxes,pageBboxes:n}}return null}";
  const puReplacement = "function pu(e,t,n,r){if(e.cachedTableRef&&e.cachedCellBboxes?.length){let n=e.cachedCellBboxes.filter(e=>e.pageIndex===t);if(n.length>0)return{tableRef:e.cachedTableRef,bboxes:e.cachedCellBboxes,pageBboxes:n}}try{let i=e.wasm?.hitTest(t,n,r);if(i&&i.parentParaIndex!==void 0&&i.controlIndex!==void 0&&!i.isTextBox){let a={sec:i.sectionIndex,ppi:i.parentParaIndex,ci:i.controlIndex},o=iu(e,a,t);if(o&&o.length>0){let e=o.filter(e=>e.pageIndex===t);if(e.length>0)return{tableRef:a,bboxes:o,pageBboxes:e}}}}catch{}return null}";
  if (code.includes(puTarget)) {
    code = code.replace(puTarget, puReplacement);
  }

  // [Hanul Permanent Core Patch 1-2] iu 함수 영구 실패 캐시(tableBboxFetchFailures) 버그 제거
  const iuTarget = "function iu(e,t,n){let r=e.cachedTableRef;if(r&&e.cachedCellBboxes&&e.cachedCellBboxes.length>0&&tu(r,t)&&(r.pageHint===n||r.pageIndexes?.has(n)===!0))return e.cachedCellBboxes;let i=nu(t,n);if(e.tableBboxFetchFailures.has(i))return null;try{let r=e.wasm.getTableCellBboxes(t.sec,t.ppi,t.ci,n);if(r&&r.length>0)return ru(e,t,n,r)}catch{}return e.tableBboxFetchFailures.add(i),null}";
  const iuReplacement = "function iu(e,t,n){let r=e.cachedTableRef;if(r&&e.cachedCellBboxes&&e.cachedCellBboxes.length>0&&tu(r,t)&&(r.pageHint===n||r.pageIndexes?.has(n)===!0))return e.cachedCellBboxes;try{let r=e.wasm.getTableCellBboxes(t.sec,t.ppi,t.ci,n);if(r&&r.length>0)return ru(e,t,n,r)}catch{}return null}";
  if (code.includes(iuTarget)) {
    code = code.replace(iuTarget, iuReplacement);
  }

  // [Hanul Permanent Core Patch 2] hitTestBorder tolerance 4pt -> 10pt 확대 (마우스 경계선 잡기 극대화)
  const hitTarget = "hitTestBorder(e,t,n,r=4){if(n.length===0)return null";
  const hitReplacement = "hitTestBorder(e,t,n,r=10){if(n.length===0)return null";
  if (code.includes(hitTarget)) {
    code = code.replace(hitTarget, hitReplacement);
  }

  // [Hanul Permanent Core Patch 3] 표 셀 내부에서 Ctrl/Alt/Shift + 방향키 누를 시 자동 셀 선택 모드 진입
  const keydownTarget = "if(this.cursor.isInBlockSelectionMode()&&e.key===`Escape`){e.preventDefault(),this.cursor.exitBlockSelectionMode(),this.selectionRenderer.clear(),this.updateCaret();return}if(this.cursor.isInCellSelectionMode()){";
  const keydownReplacement = "if(this.cursor.isInBlockSelectionMode()&&e.key===`Escape`){e.preventDefault(),this.cursor.exitBlockSelectionMode(),this.selectionRenderer.clear(),this.updateCaret();return}if(!this.cursor.isInCellSelectionMode()&&this.cursor.isInCell()&&!this.cursor.isInTextBox()&&(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)&&(e.key===`ArrowUp`||e.key===`ArrowDown`||e.key===`ArrowLeft`||e.key===`ArrowRight`)){this.cursor.enterCellSelectionMode()&&(this.caret.hide(),this.selectionRenderer.clear(),this.updateCellSelection())}if(this.cursor.isInCellSelectionMode()){";
  if (code.includes(keydownTarget)) {
    code = code.replace(keydownTarget, keydownReplacement);
  }

  // [Hanul Permanent Core Patch 4] 표 외곽 조절점(8개 핸들) 마우스 드래그 크기 조절 구현
  const handleDownTarget = "let a=this.wasm.getTableBBoxAtPage(n.sec,n.ppi,n.ci,c);if(u>=a.x&&u<=a.x+a.width&&d>=a.y&&d<=a.y+a.height){t=!0,e.preventDefault(),this.isMoveDragging=!0";
  const handleDownReplacement = "if(r){t=!0,e.preventDefault();let i=this.wasm.getTableCellBboxes(n.sec,n.ppi,n.ci,c),a=this.wasm.getTableDimensions(n.sec,n.ppi,n.ci);this.isTableHandleResizeDragging=!0,this.tableHandleResizeState={tableRef:{sec:n.sec,ppi:n.ppi,ci:n.ci},dir:r,startClientX:e.clientX,startClientY:e.clientY,zoom:this.viewportManager.getZoom(),bboxes:i,dims:a,pageIndex:c};let o={nw:`nwse-resize`,se:`nwse-resize`,ne:`nesw-resize`,sw:`nesw-resize`,n:`ns-resize`,s:`ns-resize`,e:`ew-resize`,w:`ew-resize`};this.container.style.cursor=o[r]??`se-resize`,document.addEventListener(`mouseup`,this.onMouseUpBound,{once:!0}),this.textarea.focus();return}let a=this.wasm.getTableBBoxAtPage(n.sec,n.ppi,n.ci,c);if(!r&&u>=a.x&&u<=a.x+a.width&&d>=a.y&&d<=a.y+a.height){t=!0,e.preventDefault(),this.isMoveDragging=!0";
  if (code.includes(handleDownTarget)) {
    code = code.replace(handleDownTarget, handleDownReplacement);
  }

  // [Hanul Permanent Core Patch 5] onMouseMove 마우스 드래그 중 커서 유지
  const handleMoveTarget = "if(this.isPictureResizeDragging&&this.pictureResizeState){";
  const handleMoveReplacement = "if(this.isTableHandleResizeDragging&&this.tableHandleResizeState){let e={nw:`nwse-resize`,se:`nwse-resize`,ne:`nesw-resize`,sw:`nesw-resize`,n:`ns-resize`,s:`ns-resize`,e:`ew-resize`,w:`ew-resize`};this.container.style.cursor=e[this.tableHandleResizeState.dir]??`se-resize`;return}if(this.isPictureResizeDragging&&this.pictureResizeState){";
  if (code.includes(handleMoveTarget)) {
    code = code.replace(handleMoveTarget, handleMoveReplacement);
  }

  // [Hanul Permanent Core Patch 6] onMouseUp 마우스 뗐을 때 표 전체 크기 조절 커밋
  const handleUpTarget = "if(this.isPictureResizeDragging){this.finishPictureResizeDrag(e);return}";
  const handleUpReplacement = "if(this.isTableHandleResizeDragging&&this.tableHandleResizeState){let t=this.tableHandleResizeState;this.isTableHandleResizeDragging=!1,this.tableHandleResizeState=null,this.container.style.cursor=``;let n=(e.clientX-t.startClientX)/t.zoom,r=(e.clientY-t.startClientY)/t.zoom,i=0,a=0;t.dir.includes(`e`)?i=Math.round(n*75):t.dir.includes(`w`)&&(i=Math.round(-n*75)),t.dir.includes(`s`)?a=Math.round(r*75):t.dir.includes(`n`)&&(a=Math.round(-r*75));if(Math.abs(i)>50||Math.abs(a)>50){let e=t.dims.cols||1,n=t.dims.rows||1,r=Math.round(i/e),o=Math.round(a/n),s=[],c=new Set;for(let e of t.bboxes)if(!c.has(e.cellIdx)){c.add(e.cellIdx);let t={cellIdx:e.cellIdx};r!==0&&(t.widthDelta=r),o!==0&&(t.heightDelta=o),s.push(t)}if(s.length>0)try{this.executeOperation({kind:`snapshot`,operationType:`resizeTableHandle`,operation:e=>(e.resizeTableCells(t.tableRef.sec,t.tableRef.ppi,t.tableRef.ci,s),this.cursor.getPosition())}),this.renderTableObjectSelection()}catch{}}return}if(this.isPictureResizeDragging){this.finishPictureResizeDrag(e);return}";
  if (code.includes(handleUpTarget)) {
    code = code.replace(handleUpTarget, handleUpReplacement);
  }

  // [Hanul Permanent Core Patch 7] 글자 모양(Alt+L) 대화상자 선택 영역 없을 때도 호출 지원
  const charShapeTarget = "let n=t.getCharProperties(),r=t.getSelection();if(!r)return;let i=new CS(e.wasm,e.eventBus);";
  const charShapeReplacement = "let n=t.getCharProperties(),r=t.getSelection();if(!r){let p=t.getCursorPosition?.()??{sectionIndex:0,paragraphIndex:0,charOffset:0};r={start:p,end:p}}let i=new CS(e.wasm,e.eventBus);";
  if (code.includes(charShapeTarget)) {
    code = code.replace(charShapeTarget, charShapeReplacement);
  }

  const adapter = await readFile('media/engine-adapter.js', 'utf8');
  await writeFile('vendor/studio/assets/hanul-runtime.js', code + '\n' + adapter);
  const cssEntry = html.match(/href="\/rhwp\/(assets\/index[^" ]+\.css)"/)[1];
  const css = await readFile(`vendor/studio/${cssEntry}`, 'utf8');
  await writeFile('vendor/studio/assets/hanul-runtime.css', css.replaceAll('/rhwp/images/', '../images/'));
  return entry;
}
