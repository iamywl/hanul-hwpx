/**
 * Hanul HWPX Document Builder
 * KS X 6101 / OWPML 표준을 준수하여 표, 셀 병합(rowSpan/colSpan), 배경색(음영),
 * 폰트 스타일, 문단 정렬, 페이지 구분선, 이미지 삽입을 지원하는 고품질 HWPX 생성기입니다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

export interface TableCellDef {
  text: string | string[];
  colSpan?: number;
  rowSpan?: number;
  header?: boolean;
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  bold?: boolean;
}

export interface TableRowDef {
  cells: TableCellDef[];
}

export interface TableDef {
  colWidths: number[]; // 컬럼별 너비 합계 = 42520 (HWPUNIT, A4 150mm 기준)
  rows: TableRowDef[];
}

export interface ImageDef {
  imagePath: string;
  width?: number;  // HWPUNIT (기본: 38000)
  height?: number; // HWPUNIT (기본: 22000)
  caption?: string;
}

function escapeXml(unsafe: string): string {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class HwpxDocumentBuilder {
  private pId = 0;
  private tblId = 0;
  private imgId = 0;
  private bodyXml = '';
  private embeddedImages: { id: string; filename: string; mime: string; bytes: Uint8Array }[] = [];
  private baseTemplatePath: string;

  constructor(templatePath?: string) {
    this.baseTemplatePath = templatePath || path.resolve(process.cwd(), 'templates/report.hwpx');
  }

  /**
   * 문서 최상단 대제목 추가 (20pt Bold, 중앙 정렬)
   */
  public addTitle(title: string, subtitle?: string): this {
    this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="20" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    this.bodyXml += `    <hp:run charPrIDRef="8"><hp:t>${escapeXml(title)}</hp:t></hp:run>\n`;
    this.bodyXml += `  </hp:p>\n`;

    if (subtitle) {
      this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="20" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
      this.bodyXml += `    <hp:run charPrIDRef="5"><hp:t>${escapeXml(subtitle)}</hp:t></hp:run>\n`;
      this.bodyXml += `  </hp:p>\n`;
    }

    this.addSpacing();
    return this;
  }

  /**
   * 섹션 헤딩 추가 (14pt/12pt Bold)
   */
  public addHeading(text: string, level: 1 | 2 | 3 = 1): this {
    const charPr = level === 1 ? '5' : level === 2 ? '4' : '7';
    const paraPr = '11'; // LEFT
    this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    this.bodyXml += `    <hp:run charPrIDRef="${charPr}"><hp:t>${escapeXml(text)}</hp:t></hp:run>\n`;
    this.bodyXml += `  </hp:p>\n`;
    return this;
  }

  /**
   * 일반 문단 추가 (10pt Regular / 160% 줄간격)
   */
  public addParagraph(
    text: string,
    options?: {
      align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
      bold?: boolean;
      size?: 'NORMAL' | 'SMALL' | 'HEADING';
    }
  ): this {
    let charPr = '0';
    if (options?.size === 'SMALL') charPr = options.bold ? '3' : '2';
    else if (options?.size === 'HEADING') charPr = '5';
    else if (options?.bold) charPr = '7';

    let paraPr = '0'; // JUSTIFY
    if (options?.align === 'LEFT') paraPr = '11';
    else if (options?.align === 'CENTER') paraPr = '20';
    else if (options?.align === 'RIGHT') paraPr = '21';

    this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    this.bodyXml += `    <hp:run charPrIDRef="${charPr}"><hp:t>${escapeXml(text)}</hp:t></hp:run>\n`;
    this.bodyXml += `  </hp:p>\n`;
    return this;
  }

  /**
   * 빈 줄(여백) 추가
   */
  public addSpacing(): this {
    this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    this.bodyXml += `    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>\n`;
    this.bodyXml += `  </hp:p>\n`;
    return this;
  }

  /**
   * 페이지 나누기 (다음 쪽으로 넘김)
   */
  public addPageBreak(): this {
    this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="1" columnBreak="0" merged="0">\n`;
    this.bodyXml += `    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>\n`;
    this.bodyXml += `  </hp:p>\n`;
    return this;
  }

  /**
   * 안내 상자 / 콜아웃 박스 (외곽선 및 배경 음영 처리된 1칸 표)
   */
  public addCalloutBox(lines: string[]): this {
    return this.addTable({
      colWidths: [42520],
      rows: [
        {
          cells: [
            {
              text: lines,
              header: false,
              align: 'LEFT',
            },
          ],
        },
      ],
    });
  }

  /**
   * 정교한 표 생성 (컬럼별 너비 지정, 헤더 음영, 셀 병합 완벽 지원)
   */
  public addTable(tableDef: TableDef): this {
    const totalWidth = 42520;
    const colCount = tableDef.colWidths.length;
    const rowCount = tableDef.rows.length;
    if (rowCount === 0 || colCount === 0) return this;

    const tblIdNum = this.tblId++;
    const totalHeight = rowCount * 750;

    this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    this.bodyXml += `    <hp:run charPrIDRef="0">\n`;
    this.bodyXml += `      <hp:tbl id="${tblIdNum}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">\n`;
    this.bodyXml += `        <hp:sz width="${totalWidth}" widthRelTo="ABSOLUTE" height="${totalHeight}" heightRelTo="ABSOLUTE" protect="0"/>\n`;
    this.bodyXml += `        <hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>\n`;
    this.bodyXml += `        <hp:outMargin left="0" right="0" top="283" bottom="283"/>\n`;
    this.bodyXml += `        <hp:inMargin left="510" right="510" top="141" bottom="141"/>\n`;

    // 행별 가상 2D 그리드 추적 (span 계산용)
    const grid: boolean[][] = Array.from({ length: rowCount }, () => Array(colCount).fill(false));

    for (let r = 0; r < rowCount; r++) {
      this.bodyXml += `        <hp:tr>\n`;
      const rowDef = tableDef.rows[r];
      let cellDefIdx = 0;

      for (let c = 0; c < colCount; c++) {
        // 이전 셀의 span으로 인해 이미 채워진 칸이면 스킵
        if (grid[r][c]) {
          continue;
        }

        const cellDef = rowDef?.cells?.[cellDefIdx++] || { text: '' };
        const colSpan = Math.max(1, cellDef.colSpan || 1);
        const rowSpan = Math.max(1, cellDef.rowSpan || 1);

        // 점유 영역 그리드에 마킹
        for (let dr = 0; dr < rowSpan && r + dr < rowCount; dr++) {
          for (let dc = 0; dc < colSpan && c + dc < colCount; dc++) {
            grid[r + dr][c + dc] = true;
          }
        }

        // 해당 셀의 실제 합산 너비 계산
        let cellWidth = 0;
        for (let dc = 0; dc < colSpan && c + dc < colCount; dc++) {
          cellWidth += tableDef.colWidths[c + dc];
        }
        const cellHeight = rowSpan * 750;

        const isHeader = Boolean(cellDef.header);
        const borderFillID = isHeader ? '4' : '3';
        const defaultAlign = isHeader ? 'CENTER' : 'LEFT';
        const align = cellDef.align || defaultAlign;
        const paraPr = align === 'CENTER' ? '20' : align === 'RIGHT' ? '21' : '11';
        const charPr = isHeader ? '7' : cellDef.bold ? '7' : '0';

        const lines = Array.isArray(cellDef.text)
          ? cellDef.text
          : String(cellDef.text || '').split('\n');

        this.bodyXml += `          <hp:tc name="" header="${isHeader ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${borderFillID}">\n`;
        this.bodyXml += `            <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">\n`;

        for (const line of lines) {
          this.bodyXml += `              <hp:p id="${this.pId++}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
          this.bodyXml += `                <hp:run charPrIDRef="${charPr}"><hp:t>${escapeXml(line)}</hp:t></hp:run>\n`;
          this.bodyXml += `              </hp:p>\n`;
        }

        this.bodyXml += `            </hp:subList>\n`;
        this.bodyXml += `            <hp:cellAddr colAddr="${c}" rowAddr="${r}"/>\n`;
        this.bodyXml += `            <hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>\n`;
        this.bodyXml += `            <hp:cellSz width="${cellWidth}" height="${cellHeight}"/>\n`;
        this.bodyXml += `            <hp:cellMargin left="510" right="510" top="141" bottom="141"/>\n`;
        this.bodyXml += `          </hp:tc>\n`;
      }

      this.bodyXml += `        </hp:tr>\n`;
    }

    this.bodyXml += `      </hp:tbl>\n`;
    this.bodyXml += `    </hp:run>\n`;
    this.bodyXml += `  </hp:p>\n`;
    return this;
  }

  /**
   * 이미지 삽입 (스크린샷 증빙)
   */
  public addImage(imageDef: ImageDef): this {
    if (!fs.existsSync(imageDef.imagePath)) {
      this.addParagraph(`[이미지 파일 없음: ${path.basename(imageDef.imagePath)}]`, { bold: true });
      return this;
    }

    const imgBytes = fs.readFileSync(imageDef.imagePath);
    const ext = path.extname(imageDef.imagePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const imgIndex = this.embeddedImages.length + 1;
    const binItemId = `image_${imgIndex}`;
    const filename = `BinData/image_${imgIndex}${ext || '.png'}`;

    this.embeddedImages.push({
      id: binItemId,
      filename,
      mime,
      bytes: new Uint8Array(imgBytes),
    });

    const width = imageDef.width || 38000;
    const height = imageDef.height || 22000;
    const instId = 1000000000 + (this.imgId++);

    this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="20" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    this.bodyXml += `    <hp:run charPrIDRef="0">\n`;
    this.bodyXml += `      <hp:pic id="${this.imgId}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="1" instid="${instId}" reverse="0">\n`;
    this.bodyXml += `        <hp:offset x="0" y="0"/>\n`;
    this.bodyXml += `        <hp:orgSz width="${width}" height="${height}"/>\n`;
    this.bodyXml += `        <hp:curSz width="${width}" height="${height}"/>\n`;
    this.bodyXml += `        <hp:flip horizontal="0" vertical="0"/>\n`;
    this.bodyXml += `        <hp:rotationInfo angle="0" centerX="${Math.floor(width / 2)}" centerY="${Math.floor(height / 2)}" rotateimage="1"/>\n`;
    this.bodyXml += `        <hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>\n`;
    this.bodyXml += `        <hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${width}" y="0"/><hc:pt2 x="${width}" y="${height}"/><hc:pt3 x="0" y="${height}"/></hp:imgRect>\n`;
    this.bodyXml += `        <hp:imgClip left="0" right="${width}" top="0" bottom="${height}"/>\n`;
    this.bodyXml += `        <hp:inMargin left="0" right="0" top="0" bottom="0"/>\n`;
    this.bodyXml += `        <hp:imgDim dimwidth="${width}" dimheight="${height}"/>\n`;
    this.bodyXml += `        <hc:img binaryItemIDRef="${binItemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>\n`;
    this.bodyXml += `        <hp:effects/>\n`;
    this.bodyXml += `      </hp:pic>\n`;
    this.bodyXml += `    </hp:run>\n`;
    this.bodyXml += `  </hp:p>\n`;

    if (imageDef.caption) {
      this.bodyXml += `  <hp:p id="${this.pId++}" paraPrIDRef="20" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
      this.bodyXml += `    <hp:run charPrIDRef="2"><hp:t>${escapeXml(imageDef.caption)}</hp:t></hp:run>\n`;
      this.bodyXml += `  </hp:p>\n`;
    }

    this.addSpacing();
    return this;
  }

  /**
   * 최종 HWPX 버퍼 패키징 및 생성
   */
  public build(): Uint8Array {
    const templateBuf = fs.readFileSync(this.baseTemplatePath);
    const unzipped = unzipSync(new Uint8Array(templateBuf));

    // 1. Contents/header.xml 보강 (paraPr 20=CENTER, 21=RIGHT, borderFill 4=헤더 음영)
    let headerXml = strFromU8(unzipped['Contents/header.xml']);

    // borderFill 4 추가 (없으면 삽입)
    if (!headerXml.includes('id="4"')) {
      const borderFillShaded = `<hh:borderFill id="4" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="#F2F4F7" hatchColor="#999999" alpha="0"/></hc:fillBrush></hh:borderFill>`;
      headerXml = headerXml.replace('</hh:borderFills>', `${borderFillShaded}</hh:borderFills>`);
      headerXml = headerXml.replace(/itemCnt="3"/, 'itemCnt="4"');
    }

    // paraPr 20 (CENTER), 21 (RIGHT) 추가
    if (!headerXml.includes('id="20"')) {
      const paraPrCenter = `<hh:paraPr id="20" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="CENTER" vertical="BASELINE"/></hh:paraPr>`;
      const paraPrRight = `<hh:paraPr id="21" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="RIGHT" vertical="BASELINE"/></hh:paraPr>`;
      headerXml = headerXml.replace('</hh:paraProperties>', `${paraPrCenter}${paraPrRight}</hh:paraProperties>`);
      headerXml = headerXml.replace(/itemCnt="20"/, 'itemCnt="22"');
    }

    unzipped['Contents/header.xml'] = strToU8(headerXml);

    // 2. Contents/section0.xml 조립
    const secPrChunk = `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="12280" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="224"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`;

    let fullSecXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n`;
    fullSecXml += `<hs:sec xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">\n`;

    // 필수 첫 문단에 secPr 주입
    fullSecXml += `  <hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    fullSecXml += `    <hp:run charPrIDRef="0">\n`;
    fullSecXml += `      ${secPrChunk}\n`;
    fullSecXml += `    </hp:run>\n`;
    fullSecXml += `  </hp:p>\n`;

    fullSecXml += this.bodyXml;
    fullSecXml += `</hs:sec>`;

    unzipped['Contents/section0.xml'] = strToU8(fullSecXml);

    // 3. 이미지 파일들을 BinData에 넣고 content.hpf 매니페스트에 등록
    if (this.embeddedImages.length > 0) {
      let hpfXml = strFromU8(unzipped['Contents/content.hpf']);
      let manifestAdditions = '';

      for (const img of this.embeddedImages) {
        (unzipped as Record<string, Uint8Array>)[img.filename] = img.bytes;
        manifestAdditions += `    <opf:item id="${img.id}" href="${img.filename}" media-type="${img.mime}" isEmbeded="1"/>\n`;
      }

      hpfXml = hpfXml.replace('</opf:manifest>', `${manifestAdditions}  </opf:manifest>`);
      unzipped['Contents/content.hpf'] = strToU8(hpfXml);
    }

    return zipSync(unzipped);
  }

  /**
   * 파일로 저장
   */
  public saveToFile(targetPath: string): void {
    const bytes = this.build();
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(targetPath, Buffer.from(bytes));
  }
}
