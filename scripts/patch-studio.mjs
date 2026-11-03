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

  // [Hanul Permanent Core Patch 2] hitTestBorder 정밀 허용치(r=3pt 및 셀 높이/너비 22% 상한) 적용 — 좁은 HWP 표 행(14~20pt) 내부 텍스트 클릭이 경계선 드래그로 오인되는 버그 원천 차단
  const hitTarget = "hitTestBorder(e,t,n,r=4){if(n.length===0)return null;let{rowIndexByY:i,colIndexByX:a}=this.computeBorderLines(n),o=n[0].pageIndex,s=e=>Math.round(e*10)/10,c=[];for(let a of n){if(e<a.x-r||e>a.x+a.w+r)continue;let n=i.get(s(a.y));n!==void 0&&Math.abs(t-a.y)<=r&&c.push({edge:{type:`row`,index:n,pageIndex:o},distance:Math.abs(t-a.y),priority:1});let l=a.y+a.h,u=i.get(s(l));u!==void 0&&Math.abs(t-l)<=r&&c.push({edge:{type:`row`,index:u,pageIndex:o},distance:Math.abs(t-l),priority:1})}for(let i of n){if(t<i.y-r||t>i.y+i.h+r)continue;let n=a.get(s(i.x));n!==void 0&&Math.abs(e-i.x)<=r&&c.push({edge:{type:`col`,index:n,pageIndex:o},distance:Math.abs(e-i.x),priority:0});let l=i.x+i.w,u=a.get(s(l));u!==void 0&&Math.abs(e-l)<=r&&c.push({edge:{type:`col`,index:u,pageIndex:o},distance:Math.abs(e-l),priority:0})}";
  const hitReplacement = "hitTestBorder(e,t,n,r=3){if(n.length===0)return null;let{rowIndexByY:i,colIndexByX:a}=this.computeBorderLines(n),o=n[0].pageIndex,s=e=>Math.round(e*10)/10,c=[];for(let a of n){let d=Math.min(r,Math.max(1.5,(a.h||12)*.22));if(e<a.x-d||e>a.x+a.w+d)continue;let n=i.get(s(a.y));n!==void 0&&Math.abs(t-a.y)<=d&&c.push({edge:{type:`row`,index:n,pageIndex:o},distance:Math.abs(t-a.y),priority:1});let l=a.y+a.h,u=i.get(s(l));u!==void 0&&Math.abs(t-l)<=d&&c.push({edge:{type:`row`,index:u,pageIndex:o},distance:Math.abs(t-l),priority:1})}for(let i of n){let d=Math.min(r,Math.max(1.5,(i.w||12)*.22));if(t<i.y-d||t>i.y+i.h+d)continue;let n=a.get(s(i.x));n!==void 0&&Math.abs(e-i.x)<=d&&c.push({edge:{type:`col`,index:n,pageIndex:o},distance:Math.abs(e-i.x),priority:0});let l=i.x+i.w,u=a.get(s(l));u!==void 0&&Math.abs(e-l)<=d&&c.push({edge:{type:`col`,index:u,pageIndex:o},distance:Math.abs(e-l),priority:0})}";
  if (code.includes(hitTarget)) {
    code = code.replace(hitTarget, hitReplacement);
  }

  // [Hanul Permanent Core Patch 3] 표 셀 내부에서 Ctrl/Alt + 방향키 누를 시 자동 셀 선택 모드 진입 (Shift 단독 방향키는 텍스트 블록 선택 보존)
  const keydownTarget = "if(this.cursor.isInBlockSelectionMode()&&e.key===`Escape`){e.preventDefault(),this.cursor.exitBlockSelectionMode(),this.selectionRenderer.clear(),this.updateCaret();return}if(this.cursor.isInCellSelectionMode()){";
  const keydownReplacement = "if(this.cursor.isInBlockSelectionMode()&&e.key===`Escape`){e.preventDefault(),this.cursor.exitBlockSelectionMode(),this.selectionRenderer.clear(),this.updateCaret();return}if(!this.cursor.isInCellSelectionMode()&&this.cursor.isInCell()&&!this.cursor.isInTextBox()&&(e.ctrlKey||e.metaKey||e.altKey)&&(e.key===`ArrowUp`||e.key===`ArrowDown`||e.key===`ArrowLeft`||e.key===`ArrowRight`)){this.cursor.enterCellSelectionMode()&&(this.caret.hide(),this.selectionRenderer.clear(),this.updateCellSelection())}if(this.cursor.isInCellSelectionMode()){";
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

  // [Hanul Permanent Core Patch 8] 보호된 셀(cellProtect) 선택 트랩 방지: Cmd/Ctrl 단축키, Tab 다음 셀 이동, 비보호 셀 자동 전환 및 안내 콜백 지원
  const protTarget = "if(this.cursor.isProtectedCellSelectionMode()){e.preventDefault(),this.textarea.focus();return}";
  const protReplacement = "if(this.cursor.isProtectedCellSelectionMode()){if(e.ctrlKey||e.metaKey){e.key!==`Control`&&e.key!==`Meta`&&this.handleCtrlKey(e);return}if(e.key===`Tab`){e.preventDefault(),this.cursor.exitCellSelectionMode(),this.cellSelectionRenderer?.clear(),e.shiftKey?this.cursor.moveToCellPrev():this.cursor.moveToCellNext();let t=this.cursor.getPosition();ou(this,t)?uu.call(this,t):this.updateCaret(),this.textarea.focus();return}if(ou(this,this.cursor.getPosition())){e.key!==`Shift`&&e.key!==`Control`&&e.key!==`Alt`&&e.key!==`Meta`&&window.__hanulOnProtectedCellInput?.(),e.preventDefault(),this.textarea.focus();return}}";
  if (code.includes(protTarget)) {
    code = code.replace(protTarget, protReplacement);
  }

  // [Hanul Permanent Core Patch 9] 초기 문서 로드 시 캐럿 배치 예외 안전 방어 (특수 HWP 양식 로드 중단 방지)
  const caretInitTarget = "catch(e){console.warn(`[InputHandler] 캐럿 자동 배치 실패:`,e),this.cursor.moveTo({sectionIndex:0,paragraphIndex:0,charOffset:0}),this.active=!0,tm(this.cursor.getRect(),this.viewportManager.getZoom(),this.caret,this.eventBus),this.focusTextarea()}";
  const caretInitReplacement = "catch(e){console.warn(`[InputHandler] 캐럿 자동 배치 실패:`,e);try{this.cursor.moveTo({sectionIndex:0,paragraphIndex:0,charOffset:0});let e=this.cursor.getRect();e&&tm(e,this.viewportManager.getZoom(),this.caret,this.eventBus)}catch{}this.active=!0,this.focusTextarea()}";
  if (code.includes(caretInitTarget)) {
    code = code.replace(caretInitTarget, caretInitReplacement);
  }

  const adapter = await readFile('media/engine-adapter.js', 'utf8');
  await writeFile('vendor/studio/assets/hanul-runtime.js', code + '\n' + adapter);
  const cssEntry = html.match(/href="\/rhwp\/(assets\/index[^" ]+\.css)"/)[1];
  const css = await readFile(`vendor/studio/${cssEntry}`, 'utf8');
  await writeFile('vendor/studio/assets/hanul-runtime.css', css.replaceAll('/rhwp/images/', '../images/'));
  return entry;
}
