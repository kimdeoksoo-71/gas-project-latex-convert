/***********************
 * PBM: IMAGE_DS 폴더 PNG 검색 → Data1!A:B 기록
 * - 메뉴: PBM 도구 > 이미지 검색·기록 실행
 ***********************/

 /** 문자열을 완성형(NFC)으로 통일 */
function nfc_(s) {
  s = String(s == null ? '' : s);
  return s.normalize ? s.normalize('NFC') : s;
}

function runSearchAndAppend() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('PNG 파일명 검색', '파일명에 포함될 단어를 입력하세요 (예: 2021, 미적분 등)', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const keyword = (res.getResponseText() || '').trim();
  if (!keyword) { ui.alert('검색어가 비어 있습니다.'); return; }

  const folder = getFolderByPath('PBMAI/IMAGE_DS'); // \, / 모두 허용
  const pairs = collectPngNameUrlPairs(folder, keyword);
  if (pairs.length === 0) { ui.alert('조건에 맞는 PNG 파일이 없습니다.'); return; }

  // 한글 가나다 + 숫자 자연 정렬
  pairs.sort((a, b) => a[0].localeCompare(b[0], 'ko', { sensitivity: 'base', numeric: true }));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Data1'); if (!sh) sh = ss.insertSheet('Data1');
  const startRow = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(startRow, 1, pairs.length, 2).setValues(pairs);

  ui.alert(`총 ${pairs.length}건을 기록했습니다. (시작행: ${startRow})`);
}

/** 경로 기반 폴더 찾기: 'PBMAI/IMAGE_DS' 또는 'PBMAI\\IMAGE_DS' 모두 허용 */
function getFolderByPath(pathLike) {
  const path = pathLike.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = path.split('/');
  let cur = DriveApp.getRootFolder(); // 내 드라이브 루트
  for (const name of parts) {
    const it = cur.getFoldersByName(name);
    if (!it.hasNext()) throw new Error(`폴더를 찾을 수 없습니다: ${name} (경로: ${pathLike})`);
    cur = it.next(); // 동일 이름 여러 개면 첫 번째 사용
  }
  return cur;
}


/** 한글 유니코드 완성형(NFC) 정규화 — 비교 전용 (패치 6) */
function nfc_(s) {
  s = String(s == null ? '' : s);
  return s.normalize ? s.normalize('NFC') : s;
}
 
/** 폴더(1레벨) 내 PNG만, 파일명에 keyword 포함(NFC 로 비교) → [filename, url]
 *  패치 6: 한글 NFC/NFD 정규화 불일치 흡수 (비교만 NFC, 기록은 원본명 기준)
 *  패치 7: CroP 조각 파일 <이름>_c1.png, _c2.png … 는 한 항목으로 묶어
 *          [<이름>.png, "url1\nurl2\n…"] (번호순) 으로 반환.
 *          같은 기본 이름의 통짜 PNG(구버전 산출물)가 함께 있으면 조각을 우선한다. */
function collectPngNameUrlPairs(folder, keyword) {
  const kw = nfc_(keyword).toLowerCase();
  const PIECE_RE = /_c(\d+)\.png$/i;
  const singles = [];                 // [원본명, url]
  const groups = new Map();           // NFC 기본이름 → { name: 원본 기본이름, parts: [{n, url}] }
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const raw = f.getName(); if (!raw) continue;
    const name = nfc_(raw);
    const lower = name.toLowerCase();
    if (!lower.endsWith('.png') || lower.indexOf(kw) === -1) continue;
    const m = name.match(PIECE_RE);
    if (!m) { singles.push([raw, f.getUrl()]); continue; }
    const key = name.replace(PIECE_RE, '.png');
    if (!groups.has(key)) groups.set(key, { name: raw.replace(PIECE_RE, '.png'), parts: [] });
    groups.get(key).parts.push({ n: Number(m[1]), url: f.getUrl() });
  }
  const out = [];
  singles.forEach(p => { if (!groups.has(nfc_(p[0]))) out.push(p); });   // 통짜보다 조각 우선
  groups.forEach(g => {
    g.parts.sort((a, b) => a.n - b.n);
    out.push([g.name, g.parts.map(p => p.url).join('\n')]);
  });
  return out;
}
 
