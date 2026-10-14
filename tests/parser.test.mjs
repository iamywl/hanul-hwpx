import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openDocument } from '../dist/core.mjs';

test('실전 대용량 공모전 공고문 (notice.hwpx) 파싱 검증', () => {
  const filePath = path.resolve('tests/fixtures/contests/notice.hwpx');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwpx');
  assert.ok(doc.paragraphs.length > 10, `문단 수가 너무 적습니다: ${doc.paragraphs.length}`);
  assert.ok(doc.fullText.length > 1000, '본문 텍스트가 정상 추출되어야 합니다.');
});

test('HWP 5.x 배포용 문서 (ViewText AES-128 복호화) 파싱 및 표 복원 검증', () => {
  const filePath = path.resolve('tests/fixtures/[공고] 2022년 예비창업패키지 예비창업자 모집공고.hwp');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwp');
  assert.ok(doc.paragraphs.length >= 1000, '배포용 문서 ViewText 복호화로 1,000개 이상의 문단이 복원되어야 합니다.');
  assert.ok(doc.tables.length >= 40, '배포용 문서 ViewText 복호화로 40개 이상의 표가 복원되어야 합니다.');
  assert.ok(doc.fullText.includes('중소벤처기업부') && doc.fullText.includes('예비창업패키지'), '본문 키워드가 온전히 포함되어야 합니다.');
});

test('HWP 5.x 표준 샘플 문서 (sample-5017.hwp) 파싱 검증', () => {
  const filePath = path.resolve('tests/fixtures/samples/sample-5017.hwp');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwp');
  assert.ok(doc.tables.length >= 2, '표가 파싱되어야 합니다.');
  assert.ok(doc.fullText.includes('글 워드 프로세서'), '본문 텍스트가 정상 추출되어야 합니다.');
});

test('HWPX 표준 문서 (fsc_fund_report.hwpx) 파싱 및 마크다운 변환 검증', () => {
  const filePath = path.resolve('tests/fixtures/samples/fsc_fund_report.hwpx');
  const doc = openDocument(filePath);

  assert.equal(doc.format, 'hwpx');
  assert.equal(doc.version, 'KS X 6101 HWPX');
  assert.ok(doc.paragraphs.length >= 50, '문단이 파싱되어야 합니다.');
  assert.ok(doc.tables.length >= 5, '표가 파싱되어야 합니다.');
  assert.ok(doc.fullText.includes('국민성장펀드'), '본문 키워드가 포함되어야 합니다.');

  const md = doc.toMarkdown();
  assert.ok(md.includes('# HWPX 문서'), '마크다운 헤더가 포함되어야 합니다.');
  assert.ok(md.includes('|'), '마크다운 표 문법이 포함되어야 합니다.');
});

test('tests/fixtures 내 모든 실무 공문서/공모전 파일 전수 호환성 검증', () => {
  const fixturesDir = path.resolve('tests/fixtures');
  const files = fs.readdirSync(fixturesDir).filter((f) => (f.endsWith('.hwp') || f.endsWith('.hwpx')) && !f.startsWith('.'));

  assert.ok(files.length >= 10, '최소 10개 이상의 실무 테스트 파일이 존재해야 합니다.');

  for (const file of files) {
    const fullPath = path.join(fixturesDir, file);
    const doc = openDocument(fullPath);
    assert.ok(doc.format === 'hwp' || doc.format === 'hwpx');
    assert.ok(doc.paragraphs.length > 0, `${file}에서 1개 이상의 문단이 추출되어야 합니다.`);
    assert.ok(doc.fullText.length > 0, `${file}에서 본문 텍스트가 추출되어야 합니다.`);
  }
});
