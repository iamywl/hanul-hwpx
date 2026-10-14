import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { validateBytes } from '../dist/storage.mjs';
import { openDocument } from '../dist/core.mjs';

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const outputPath = '/Users/ywlee/sideproejct/K_startup/03_reports/submissions/2026_창업동아리_지원신청서_및_활동계획서.hwpx';
const outputMdPath = '/Users/ywlee/sideproejct/K_startup/03_reports/submissions/2026_창업동아리_지원신청서_및_활동계획서.md';

const templatePath = path.resolve('templates/report.hwpx');
const templateBuf = fs.readFileSync(templatePath);
const unzipped = unzipSync(templateBuf);

let secXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
secXml += `<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">\n`;

let pId = 0;
let tblId = 0;

function addPara(text, charPr = '9') {
  secXml += `  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
  secXml += `    <hp:run charPrIDRef="${charPr}"><hp:t>${escapeXml(text)}</hp:t></hp:run>\n`;
  secXml += `  </hp:p>\n`;
}

function addHeading(text) {
  secXml += `  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
  secXml += `    <hp:run charPrIDRef="8"><hp:t>${escapeXml(text)}</hp:t></hp:run>\n`;
  secXml += `  </hp:p>\n`;
}

function addSubheading(text) {
  secXml += `  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
  secXml += `    <hp:run charPrIDRef="7"><hp:t>${escapeXml(text)}</hp:t></hp:run>\n`;
  secXml += `  </hp:p>\n`;
}

function addTable(rows) {
  const rowCount = rows.length;
  const colCount = Math.max(...rows.map(r => r.length));
  const totalWidth = 42520;
  const cellWidth = Math.floor(totalWidth / colCount);

  secXml += `  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
  secXml += `    <hp:run charPrIDRef="9">\n`;
  secXml += `      <hp:tbl id="${tblId++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">\n`;
  secXml += `        <hp:sz width="${totalWidth}" widthRelTo="ABSOLUTE" height="${rowCount * 700}" heightRelTo="ABSOLUTE" protect="0"/>\n`;
  secXml += `        <hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>\n`;
  secXml += `        <hp:outMargin left="0" right="0" top="283" bottom="283"/>\n`;
  secXml += `        <hp:inMargin left="510" right="510" top="141" bottom="141"/>\n`;

  for (let r = 0; r < rowCount; r++) {
    secXml += `        <hp:tr>\n`;
    for (let c = 0; c < colCount; c++) {
      const cellText = rows[r]?.[c] || '';
      const charPr = r === 0 ? '7' : '9';
      secXml += `          <hp:tc name="" header="${r === 0 ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3">\n`;
      secXml += `            <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">\n`;
      secXml += `              <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
      secXml += `                <hp:run charPrIDRef="${charPr}"><hp:t>${escapeXml(cellText)}</hp:t></hp:run>\n`;
      secXml += `              </hp:p>\n`;
      secXml += `            </hp:subList>\n`;
      secXml += `            <hp:cellAddr colAddr="${c}" rowAddr="${r}"/>\n`;
      secXml += `            <hp:cellSpan colSpan="1" rowSpan="1"/>\n`;
      secXml += `            <hp:cellSz width="${cellWidth}" height="700"/>\n`;
      secXml += `            <hp:cellMargin left="510" right="510" top="141" bottom="141"/>\n`;
      secXml += `          </hp:tc>\n`;
    }
    secXml += `        </hp:tr>\n`;
  }

  secXml += `      </hp:tbl>\n`;
  secXml += `    </hp:run>\n`;
  secXml += `  </hp:p>\n`;
}

// 1. Title
addHeading('[2026년 창업중심대학 X RISE 사업단] 창업동아리 지원신청서 및 활동계획서');
addPara('');

// 2. [붙임 1] 창업동아리 지원 신청서
addSubheading('[붙임 1] 창업동아리 지원 신청서');
addSubheading('가. 창업동아리 개요');

addTable([
  ['항 목', '내 용'],
  ['동아리 명', '스터디브릿지 (StudyBridge)'],
  ['아이템 명', '대학생 전공 특화 P2P 과외·학습 매칭 플랫폼'],
  ['팀 구 성', '총 2명 (컴퓨터공학과 학부생)'],
  ['동아리 대표', '팀장 (풀스택 개발 및 사업 총괄)'],
  ['팀 원', '팀원 (프론트엔드 및 AI/ML 매칭 시스템 개발)'],
  ['활동 기간', '2026. 04. 13. ~ 2027. 01. 31.']
]);

addPara('');
addSubheading('나. 창업동아리 소개 및 활동 목표');
addPara('■ 동아리 소개');
addPara('스터디브릿지는 대학 전공 심화과목(자료구조, 알고리즘, 컴퓨터구조 등)의 학습 격차를 해소하기 위해 컴퓨터공학 전공 학부생 2명이 결성한 창업동아리입니다. 기존 입시 위주 과외 시장에서 소외된 대학생 전공 학습자들에게 같은 전공 A+ 선배 튜터를 실시간으로 매칭하고 지능형 학습 환경을 제공합니다.');
addPara('');
addPara('■ 활동 목표');
addPara('1) 2026년 8월까지 Next.js 15 및 NestJS 11 기반의 MVP 웹 서비스를 구축하고 교내 베타 테스트를 실시합니다.');
addPara('2) 오픈소스 로컬 LLM(Llama 3.1 8B)과 pgvector 임베딩 기술을 적용하여 과목·학점·시간대 기반 다차원 AI 튜터 매칭 엔진을 구현합니다.');
addPara('3) 베타 서비스 기간 동안 교내 튜터 30명, 학습자 100명을 유치하여 결제 및 매칭 유효성을 검증하고 실전 창업으로 승격합니다.');
addPara('');
addPara('■ 대표적인 활동 및 추진 실적');
addPara('- 팀 내부 기술 스터디를 통해 React 19/Next.js 기반 프론트엔드, NestJS 백엔드, WebRTC 화상 화이트보드 프로토타입 구현 완료');
addPara('- 교내 컴퓨터공학 캡스톤 디자인 프로젝트와 연계하여 전공 과외 시맨틱 벡터 검색 파이프라인(all-MiniLM-L6-v2) 선행 연구 수행');
addPara('');

// 3. [붙임 2] 활동계획서
addSubheading('[붙임 2] 창업동아리 활동계획서');
addSubheading('1. 창업아이템(아이디어) 설명');
addPara('■ 창업아이템의 특징');
addPara('- 대학 전공 심화과목 특화: 중고등 입시에 집중된 기존 과외 플랫폼(숨고, 김과외)과 달리, 공학·자연과학 전공 과외 시장에 집중하여 틈새시장을 선점합니다.');
addPara('- 고성능 AI 임베딩 매칭: 학생의 현재 수강 과목, 부족한 개념 키워드, 목표 학점을 다차원 벡터화하여 최적의 A0 이상 검증된 선배 튜터를 수 분 내 추천합니다.');
addPara('- 프라이버시 보호형 AI 학습 보조: 자체 GPU 인프라와 경량 LLM(Ollama)을 연동하여 학생의 과제 및 학습 데이터 외부 유출 없이 요약 및 Q&A 챗봇을 제공합니다.');
addPara('- 통합형 WebRTC 화상과외 환경: 수식 입력과 필기가 가능한 전용 디지털 화이트보드 및 수업 다시보기 녹화 기능을 하나의 브라우저 탭에서 원스톱으로 지원합니다.');
addPara('');

addTable([
  ['구분', '스터디브릿지 (StudyBridge)', '기존 과외 매칭 서비스', '일반 온라인 강의'],
  ['타깃 영역', '대학 전공 심화과목 (컴퓨터, 공학 등)', '초·중·고 입시 위주', '범용 자격증 및 어학'],
  ['매칭 방식', 'AI 벡터 임베딩 코사인 유사도 매칭', '단순 지역/과목 필터링', '매칭 없음 (단방향 동영상)'],
  ['튜터 검증', '대학 성적증명서 기반 A0 이상 과목별 검증', '대학 재학 여부만 확인', '강사 프로필 자체 검증'],
  ['학습 도구', 'WebRTC 화상 + 전공 수식 화이트보드 통합', '외부 Zoom 링크 수동 공유', '동영상 재생기']
]);

addPara('');
addSubheading('2. 창업아이템 사업화 및 마일스톤 계획');
addPara('■ 사업화 추진 전략');
addPara('- 1단계 (교내 실증): 컴퓨터공학과 학생회 및 소모임 연계 튜터/학생 100명 확보 및 무료 베타 운영');
addPara('- 2단계 (인접 대학 확산): 경북대, 영남대 등 대구·경북권 주요 대학 공과대학 중심으로 거점 확장');
addPara('- 3단계 (수익 모델): 수업료 매칭 수수료(10%), 선배 검증 학습자료 마켓플레이스 판매 수수료(15%)');
addPara('');

addTable([
  ['단계', '추진 기간', '주요 개발 및 사업화 과업', '목표 산출물'],
  ['1단계: 설계·프로토타입', '2026.04 ~ 2026.06', 'UI/UX 디자인, DB 스키마 설계, WebRTC 화상 통신 모듈 개발', '핵심 프로토타입'],
  ['2단계: MVP 구축 및 알파', '2026.07 ~ 2026.08', 'Llama 3.1 AI 매칭 엔진 결합, 결제 시스템 연동, 교내 알파 테스트', '베타 서비스 오픈'],
  ['3단계: 교내 베타 및 검증', '2026.09 ~ 2026.11', '튜터 30명 확보, 실전 튜터링 50건 달성, 피드백 기반 기능 고도화', '베타 운영 보고서'],
  ['4단계: 성과 발표 및 법인화', '2026.12 ~ 2027.01', '성과공유회 참가, 지식재산권(상표·BM특허) 출원, 실전창업 패키지 연계', '최종결과보고서']
]);

addPara('');
// 4. [붙임 3-1] 지원금 사용계획서
addSubheading('[붙임 3-1] 창업동아리 지원금 사용계획서 (실전창업)');
addPara('■ 총 지원금: 금 3,000,000원 (금 삼백만원)');
addPara('');

addTable([
  ['구 분', '항 목', '산 출 내 역', '금 액 (원)', '비 고'],
  ['아이템 개발비', '재료비 (클라우드/서버비)', 'AI 매칭 및 화상 튜터링용 GPU 클라우드 인프라 대여 (200,000원 × 5개월)', '1,000,000', '시제품 개발 인프라'],
  ['아이템 개발비', '외주 용역비', 'WebRTC 수식 렌더링 화이트보드 캔버스 컴포넌트 외주 개발', '800,000', '과업지시서 기반'],
  ['홍보비', '기타 마케팅비', '교내 홍보 포스터 인쇄(100매) 및 SNS 타깃 광고 집행', '400,000', '베타 테스터 모집'],
  ['홍보비', '도메인/호스팅비', '서비스 도메인(studybridge.kr) 등록 및 SSL 보안 인증서', '100,000', '1년 계약'],
  ['활동비', '회의비', '기술 개발 및 스프린트 기획 회의 (1인 15,000원 × 2명 × 10회)', '300,000', '식비/다과 (한도 준수)'],
  ['활동비', '사무용품비', '개발 및 회의용 연구노트, 파일철, 프린터 토너 등 문구류', '150,000', '행정 소모품'],
  ['지식재산권', '상표 출원비', '스터디브릿지 상표권(9류, 41류) 출원 관납료 및 대행 수수료', '250,000', '브랜드 권리 보호'],
  ['합 계', '', '총 7개 비목 실전창업 예산 집행 계획', '3,000,000', '지원금 100% 정합']
]);

secXml += `</hs:sec>`;

unzipped['Contents/section0.xml'] = strToU8(secXml);
const zipped = zipSync(unzipped);

validateBytes(new Uint8Array(zipped), 'hwpx');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, Buffer.from(zipped));
console.log('HWPX 재생성 완료:', outputPath, `(${zipped.length} bytes)`);

// Verify with openDocument
const doc = openDocument(outputPath);
console.log('재검증 성공: 문단', doc.paragraphs.length, '개, 표', doc.tables.length, '개');
