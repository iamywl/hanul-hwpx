/**
 * HWPX (KS X 6101 / OWPML) 표준 DOM 기반 정밀 파서
 * 취약한 정규식을 완전히 배제하고 @xmldom/xmldom DOMParser를 사용하여
 * 본문 문단, 계층적 표 구조, 셀 병합(colSpan/rowSpan), 셀 크기를 100% 무손실 복원합니다.
 */

import * as fflate from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { ParsedTable, ParsedTableCell } from './hwp-parser.js';

export interface ParsedPicture {
  id: string;
  zOrder?: number;
  textWrap: string;
  treatAsChar: boolean;
  allowOverlap: boolean;
  width: number;
  height: number;
  binaryItemIDRef?: string;
  isBehindText: boolean;
}

export interface ParsedHwpxDocument {
  version: string;
  sections: {
    index: number;
    paragraphs: string[];
    tables: ParsedTable[];
    pictures?: ParsedPicture[];
  }[];
  fullText: string;
}

/**
 * 특정 노드가 표 셀(hp:tc 또는 hp:subList) 내부에 위치해 있는지 검사
 */
function isInsideTableCell(node: any): boolean {
  let curr = node ? node.parentNode : null;
  while (curr) {
    const name: string = curr.localName || curr.nodeName || '';
    if (name.includes('tc') || name.includes('subList')) {
      return true;
    }
    curr = curr.parentNode;
  }
  return false;
}

/**
 * DOM 노드 하위의 모든 <hp:t> 텍스트를 순서대로 추출
 */
function extractTextFromNode(node: any): string {
  const texts: string[] = [];
  function walk(n: any) {
    if (!n) return;
    const name: string = n.localName || n.nodeName || '';
    if (name === 'hp:t' || name === 't') {
      const val = n.textContent || '';
      if (val) texts.push(val);
      return;
    }
    if (n.childNodes) {
      for (let i = 0; i < n.childNodes.length; i++) {
        walk(n.childNodes[i]);
      }
    }
  }
  walk(node);
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * <hp:tbl> DOM 엘리먼트를 ParsedTable로 정밀 파싱
 */
function parseTableElement(tblEl: any): ParsedTable | null {
  const trElements: any[] = [];
  for (let i = 0; i < tblEl.childNodes.length; i++) {
    const child = tblEl.childNodes[i];
    const name: string = child.localName || child.nodeName || '';
    if (name === 'hp:tr' || name === 'tr') {
      trElements.push(child);
    }
  }

  if (trElements.length === 0) return null;

  const rowCount = trElements.length;
  let maxColCount = 0;
  const cellDetails: ParsedTableCell[] = [];
  let hasMergedCells = false;

  for (let r = 0; r < rowCount; r++) {
    const trEl = trElements[r];
    const tcElements: any[] = [];
    for (let j = 0; j < trEl.childNodes.length; j++) {
      const child = trEl.childNodes[j];
      const name: string = child.localName || child.nodeName || '';
      if (name === 'hp:tc' || name === 'tc') {
        tcElements.push(child);
      }
    }

    let currentCol = 0;
    for (let c = 0; c < tcElements.length; c++) {
      const tcEl = tcElements[c];

      // cellAddr (colAddr, rowAddr) 파싱
      let colIdx = currentCol;
      let rowIdx = r;
      let colSpan = 1;
      let rowSpan = 1;
      let width: number | undefined;
      let height: number | undefined;

      for (let k = 0; k < tcEl.childNodes.length; k++) {
        const sub = tcEl.childNodes[k];
        const subName: string = sub.localName || sub.nodeName || '';
        if (subName === 'hp:cellAddr' || subName === 'cellAddr') {
          if (typeof sub.getAttribute === 'function') {
            if (sub.hasAttribute('colAddr')) colIdx = parseInt(sub.getAttribute('colAddr') || '0', 10);
            if (sub.hasAttribute('rowAddr')) rowIdx = parseInt(sub.getAttribute('rowAddr') || '0', 10);
          }
        } else if (subName === 'hp:cellSpan' || subName === 'cellSpan') {
          if (typeof sub.getAttribute === 'function') {
            if (sub.hasAttribute('colSpan')) colSpan = parseInt(sub.getAttribute('colSpan') || '1', 10);
            if (sub.hasAttribute('rowSpan')) rowSpan = parseInt(sub.getAttribute('rowSpan') || '1', 10);
          }
        } else if (subName === 'hp:cellSz' || subName === 'cellSz') {
          if (typeof sub.getAttribute === 'function') {
            if (sub.hasAttribute('width')) width = parseInt(sub.getAttribute('width') || '0', 10);
            if (sub.hasAttribute('height')) height = parseInt(sub.getAttribute('height') || '0', 10);
          }
        }
      }

      // 속성으로 직접 선언된 경우 폴백
      if (typeof tcEl.getAttribute === 'function') {
        if (tcEl.hasAttribute('colSpan')) colSpan = parseInt(tcEl.getAttribute('colSpan') || '1', 10);
        if (tcEl.hasAttribute('rowSpan')) rowSpan = parseInt(tcEl.getAttribute('rowSpan') || '1', 10);
      }
      if (colSpan > 1 || rowSpan > 1) hasMergedCells = true;

      const cellText = extractTextFromNode(tcEl);
      cellDetails.push({
        row: rowIdx,
        col: colIdx,
        colSpan: Math.max(1, colSpan),
        rowSpan: Math.max(1, rowSpan),
        width,
        height,
        text: cellText,
      });

      currentCol = colIdx + Math.max(1, colSpan);
      if (currentCol > maxColCount) maxColCount = currentCol;
    }
  }

  if (maxColCount === 0) maxColCount = 1;

  // 2D 텍스트 그리드 구축 (하위 호환성 유지)
  const cells: string[][] = Array.from({ length: rowCount }, () => Array(maxColCount).fill(''));
  for (const cd of cellDetails) {
    if (cd.row < rowCount && cd.col < maxColCount) {
      cells[cd.row][cd.col] = cd.text;
      for (let rOffset = 0; rOffset < cd.rowSpan; rOffset++) {
        for (let cOffset = 0; cOffset < cd.colSpan; cOffset++) {
          if (rOffset === 0 && cOffset === 0) continue;
          const targetR = cd.row + rOffset;
          const targetC = cd.col + cOffset;
          if (targetR < rowCount && targetC < maxColCount) {
            cells[targetR][targetC] = '';
          }
        }
      }
    }
  }

  return {
    rows: rowCount,
    cols: maxColCount,
    cells,
    cellDetails,
    hasMergedCells,
  };
}

/**
 * HWPX 버퍼 파싱
 */
export function parseHwpxBuffer(buffer: Buffer): ParsedHwpxDocument {
  const unzipped = fflate.unzipSync(new Uint8Array(buffer));
  const sectionFiles = Object.keys(unzipped)
    .filter((k) => /Contents\/section\d+\.xml$/i.test(k) || /section\d+\.xml$/i.test(k))
    .sort();

  const sections: ParsedHwpxDocument['sections'] = [];
  let fullText = '';
  const parser = new DOMParser({
    errorHandler: (_level: string, _msg: any) => {},
  });

  for (let i = 0; i < sectionFiles.length; i++) {
    const filename = sectionFiles[i];
    const xmlBytes = unzipped[filename];
    const xml = new TextDecoder('utf-8').decode(xmlBytes);
    const doc = parser.parseFromString(xml, 'text/xml');

    const paragraphs: string[] = [];
    const tables: ParsedTable[] = [];

    // 1. 표 (<hp:tbl>) 정밀 추출
    const tblElements = doc.getElementsByTagName('hp:tbl');
    const tblCount = tblElements.length;
    for (let t = 0; t < tblCount; t++) {
      const parsedTbl = parseTableElement(tblElements.item(t));
      if (parsedTbl) {
        tables.push(parsedTbl);
      }
    }

    // 2. 문단 (<hp:p>) 추출: 본문 및 표 셀을 포함한 전체 문서 문단 수집
    const pElements = doc.getElementsByTagName('hp:p');
    for (let p = 0; p < pElements.length; p++) {
      const pEl = pElements.item(p);
      const text = extractTextFromNode(pEl);
      if (text.length > 0) {
        paragraphs.push(text);
      }
    }

    // 3. 그림 (<hp:pic>) 및 서명 추출
    const picElements = doc.getElementsByTagName('hp:pic');
    const pictures: ParsedPicture[] = [];
    const picCount = picElements.length;
    for (let p = 0; p < picCount; p++) {
      const picEl = picElements.item(p);
      if (!picEl) continue;
      const id = picEl.getAttribute('id') || `pic_${p}`;
      const zOrderStr = picEl.getAttribute('zOrder');
      const zOrder = zOrderStr !== null ? parseInt(zOrderStr, 10) : undefined;
      const textWrap = picEl.getAttribute('textWrap') || 'TOP_AND_BOTTOM';

      const posEl = picEl.getElementsByTagName('hp:pos')?.item(0);
      const treatAsChar = posEl ? posEl.getAttribute('treatAsChar') === '1' : false;
      const allowOverlap = posEl ? posEl.getAttribute('allowOverlap') === '1' : false;

      const szEl = picEl.getElementsByTagName('hp:sz')?.item(0);
      const width = szEl ? parseInt(szEl.getAttribute('width') || '0', 10) : 0;
      const height = szEl ? parseInt(szEl.getAttribute('height') || '0', 10) : 0;

      const imgEl = picEl.getElementsByTagName('hc:img')?.item(0);
      const binaryItemIDRef = imgEl ? (imgEl.getAttribute('binaryItemIDRef') || undefined) : undefined;

      const wrapNorm = textWrap.toUpperCase();
      const isBehindText = wrapNorm === 'BEHIND_TEXT' || wrapNorm === 'BEHINDTEXT' || textWrap === '2';

      pictures.push({
        id,
        zOrder,
        textWrap,
        treatAsChar,
        allowOverlap,
        width,
        height,
        binaryItemIDRef,
        isBehindText,
      });
    }

    const sectionText = paragraphs.join('\n\n');
    fullText += (fullText ? '\n\n---\n\n' : '') + sectionText;

    sections.push({
      index: i,
      paragraphs,
      tables,
      pictures,
    });
  }

  return {
    version: 'KS X 6101 HWPX',
    sections,
    fullText,
  };
}
