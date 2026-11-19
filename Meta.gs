/*************************************************
 * Meta.gs — 분류(Meta 시트) 보조 순수 함수 (renual P3, 2026-11-19)
 *
 * 계획: audit-pipeline-docs `renual/2026-11-19-renewal-plan-v3.md` §2.6 · §5(출처 파싱) · 부록 A-3 · 부록 B-1·B-5.
 *   - 기출CHECK(`9기출NNN`) 행은 Data_DS B(문제 OCR) 첫머리에서 출처(`2023학년도 평가원 9월 공통 11번`)를 뽑아
 *     Meta `출처`·`교육과정`에 넣는다 — CroP 텍스트 층으로는 읽을 수 없어서(재인쇄로 글자가 빠짐, 부록 B-1).
 *   - 이 파일은 순수 함수만 둔다. Meta 시트 기록·분류 배치는 P4(분류 프로세스)에서 붙인다.
 *************************************************/

const META = {
  SHEET: 'Meta',
  HEAD: ['키', 'jangbu_id', '과목', '교육과정', '출처', '교과목', '대단원', '#태그', '복수 대단원', 'confidence', '상태', '분류출처', '잠금', '2028범위', '인쇄번호', '갱신시각'],
  SOURCE_LINES: 3,                 // 출처는 크롭 위 끝(라벨 줄)에 있다 → 첫 몇 줄만 본다
};

/** 학년도 → 교육과정 (부록 A-3). 모르면 '' */
function meta_currOfYear_(y) {
  y = Number(y);
  if (!Number.isFinite(y) || y < 1990 || y > 2100) return '';
  if (y >= 2028) return '2022';
  if (y >= 2022) return '2015';
  if (y >= 2014) return '2009';
  if (y >= 2012) return '2007';
  return '7차';
}

/**
 * 문제 OCR 첫머리 → { ok, source, year(학년도), curriculum } | { ok:false }.
 *   ① `2023학년도 평가원 9월 공통 11번` (수능·모평 표기 — 학년도 그대로)
 *   ② `2024년 3월 교육청 고3 공통 12번` (학평 표기 — 시행 연도 + 학년 보정: 고3 +1 · 고2 +2 · 고1 +3)
 *   LaTeX·공백이 섞여 있어도(`2023 학년도`, `\text{…}`) 받는다. 번호(`N번`)가 있어야 출처로 본다.
 */
function meta_parseSource_(text) {
  const head = String(text == null ? '' : text).replace(/\r/g, '').split('\n').slice(0, META.SOURCE_LINES).join(' ')
    .replace(/\\(?:text|mathrm|textbf)\s*\{([^}]*)\}/g, '$1').replace(/[$]/g, ' ').replace(/\s+/g, ' ').trim();
  let m = head.match(/((\d{4})\s*학년도\s*[^0-9\n]{0,40}?(?:\d{1,2}\s*월\s*)?[^0-9\n]{0,20}?(\d{1,2})\s*번)/);
  if (m) {
    const year = Number(m[2]);
    return { ok: true, source: m[1].replace(/\s+/g, ' ').trim(), year: year, curriculum: meta_currOfYear_(year) };
  }
  m = head.match(/((\d{4})\s*년\s*(\d{1,2})\s*월[^0-9\n]{0,30}?고\s*([123])[^0-9\n]{0,20}?(\d{1,2})\s*번)/);
  if (m) {
    const year = Number(m[2]) + ({ '3': 1, '2': 2, '1': 3 })[m[4]];
    return { ok: true, source: m[1].replace(/\s+/g, ' ').trim(), year: year, curriculum: meta_currOfYear_(year) };
  }
  return { ok: false };
}
