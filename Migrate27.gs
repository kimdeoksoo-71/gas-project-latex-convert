/*************************************************
 * Migrate27.gs — 27 계열 키 이관 (X-06, renual 3단계, 2026-11-20)
 *
 * 계획: audit-pipeline-docs `renual/2026-11-19-renewal-plan-v3.md` §2.8 · P0 보고 §3 · DECISIONS X-06(11/19).
 *   2028 체제 세트인데 키가 구 코드(`1공통`·`3확통`·`4미적`·`5기하`)로 들어간 데이터를 **번호는 그대로, 과목코드만 `0통합`**으로 바꾼다.
 *     `27CXTB07회 (261116)_1공통14` → `…_0통합14` · 그림 `…_해설_1공통17_fig1.jpg` → `…_해설_0통합17_fig1.jpg`
 *
 * 흐름 (메뉴 `27 계열 키 이관` · 원격 `cmd=migrate27`):
 *   ① 조사(읽기만) — 「Latex 변환」 Data_DS A열에서 후보 세트(세트명 두 자리 ≥27 또는 2028 서킷 틀)를 찾고,
 *      저장소별 바꿀 셀·파일 수와 충돌을 `Migrate_27` 에 적는다.
 *   ② 승인 — `Migrate_27` 승인 칸 체크(세트 단위). 자동 일괄 적용 금지(§2.8).
 *   ③ 적용 — 승인됐고 충돌 0 인 세트만. 바로 앞에서 다시 조사한 결과대로 셀 값·파일 이름을 바꾸고,
 *      **바꾸기 전에** `Migrate_27_Log` 에 원래 값과 새 값을 적는다 → ④ 되돌리기가 그 로그로 원래대로 돌린다.
 *
 * 저장소: 「Latex 변환」(이 파일) · 「문제 검토」 · 「KICE 윤문」 · 사본 「KICE_latex」 — 전 탭(로그·보고 탭 제외)에서
 *   세트명이 든 셀을 찾아(TextFinder) 그 안의 `<세트명>_(문제_|해설_)?<구 코드>NN` 만 바꾼다.
 *   「문제 검토」 Stack AE(문항그룹)는 세트명 없이 `1공통14` 만 있어 AD(세트명)가 같은 행만 따로 바꾼다.
 *   「D조 문항장부」는 **세기만** 한다(장부는 세트 표기가 달라 이 규칙으로 못 바꾼다) — 1 이상이면 그 세트는 충돌로 멈춘다.
 *   Drive `PBMAI/IMAGE_FIG`(그림)·`PBMAI/IMAGE_DS`(크롭 — 장부 삽입도 이 폴더를 읽는다)는 파일 이름을 바꾼다(링크는 파일 ID 라 그대로).
 * 로그·보고 탭(Pipeline_Log·Pipeline_Report·KICE_Log·Migrate_27*)은 이력이라 손대지 않는다.
 * 같은 세트 안에서 바뀐 번호가 겹치거나(`1공통14`+`3확통14`) 이미 `0통합NN` 이 있으면 충돌 → 사람 확인.
 *************************************************/

const M27 = {
  SHEET: 'Migrate_27',
  LOG: 'Migrate_27_Log',
  HEAD: ['세트명', '근거', 'Data_DS 키', 'Latex', '검토', 'KICE', 'KICE_latex', '장부', 'Drive', '충돌', '승인', '상태', '조사시각', '적용시각', '메모'],
  COL: { set: 1, reason: 2, keys: 3, latex: 4, audition: 5, kice: 6, kicelatex: 7, ledger: 8, drive: 9, conflict: 10, ok: 11, state: 12, surveyed: 13, applied: 14, note: 15 },
  LOG_HEAD: ['시각', '세트명', '저장소', '파일 ID', '시트·폴더', '행', '열', '원래 값', '새 값', '상태', '실행자'],
  OLD_CODES: ['1공통', '3확통', '4미적', '5기하'],
  NEW_CODE: '0통합',
  STORES: [
    { key: 'latex',     id: '' },                                               // 활성 파일(「Latex 변환」)
    { key: 'audition',  id: '1hrvhHVRCqWHdoCUu6ECBoAWNmoDwDKbGMrpyeOa6XDk', groups: [{ sheet: 'Stack', setCol: 30, groupCol: 31 }] },
    { key: 'kice',      id: '111416IlyMrtxt_P2diRI4VKoUzr960iBe0iF5mwsDkE' },   // 「KICE 윤문」
    { key: 'kicelatex', id: '1JolZ53GmcwVNzxgfQJU2pNlZ3w5QW9uJoymTSMLnXcQ' },   // 사본 「KICE_latex」
    { key: 'ledger',    id: '1hlnZEB-v6MQ7FpkaZigblmAYy5_LBH6kqH6mflQRrj0', countOnly: true },   // 「D조 문항장부」
  ],
  FOLDERS: ['PBMAI/IMAGE_FIG', 'PBMAI/IMAGE_DS'],
  SKIP_SHEET_RE: /Log|Report|^Migrate_27/i,
  BULK_MAX: 20000,           // 셀 수가 이보다 작으면 한 번에 읽는다(행·열 범위)
  STATE_DONE: '적용됨',
};

/* ───── 순수 함수 ───── */

function m27_nfc_(s) { s = String(s == null ? '' : s); return s.normalize ? s.normalize('NFC') : s; }
function m27_nfd_(s) { s = String(s == null ? '' : s); return s.normalize ? s.normalize('NFD') : s; }
function m27_forms_(s) { const a = m27_nfc_(s), b = m27_nfd_(a); return a === b ? [a] : [a, b]; }
function m27_esc_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function m27_alt_(arr) { return arr.map(x => m27_forms_(x).map(m27_esc_).join('|')).join('|'); }

/** 세트 하나의 치환 정규식: `<세트명>_(문제_|해설_)?<구 코드>NN` (NFC·NFD 둘 다, 뒤에 숫자가 이어지면 안 됨) */
function m27_re_(set) {
  return new RegExp('(' + m27_forms_(set).map(m27_esc_).join('|') + ')_((?:' + m27_alt_(['문제', '해설']) + ')_)?(' + m27_alt_(M27.OLD_CODES) + ')(\\d{2})(?!\\d)', 'g');
}
/** 바꾼 문자열과 찾은 구 코드 목록(NFC, `1공통14`) — 원문이 NFD 면 새 코드도 NFD 로 쓴다 */
function m27_replace_(text, set) {
  const hits = [];
  const out = String(text == null ? '' : text).replace(m27_re_(set), (all, s, kind, code, nn) => {
    hits.push(m27_nfc_(code) + nn);
    return s + '_' + (kind || '') + (code === m27_nfc_(code) ? M27.NEW_CODE : m27_nfd_(M27.NEW_CODE)) + nn;
  });
  return { text: out, hits };
}
/** Stack AE 같은 '구 코드만' 칸: `1공통14` → `0통합14` | null */
function m27_bareGroup_(v) {
  const s = String(v == null ? '' : v), n = m27_nfc_(s).trim();
  const m = n.match(new RegExp('^(' + M27.OLD_CODES.map(m27_esc_).join('|') + ')(\\d{2})$'));
  if (!m) return null;
  return { hit: m[1] + m[2], text: (s === m27_nfc_(s) ? M27.NEW_CODE : m27_nfd_(M27.NEW_CODE)) + m[2] };
}
/** 되돌리기(셀 값이 로그의 새 값과 다를 때 — 같은 셀에 다른 세트 키도 있어 뒤에 또 바뀐 경우):
 *  원래 값에서 찾은 이 세트의 번호만 `0통합NN` → 원래 코드로 되돌린다. 바뀐 게 없으면 원문 그대로 */
function m27_revert_(cur, set, oldText) {
  const map = {};
  m27_replace_(oldText, set).hits.forEach(h => { map[h.slice(3)] = h.slice(0, 3); });
  const re = new RegExp('(' + m27_forms_(set).map(m27_esc_).join('|') + ')_((?:' + m27_alt_(['문제', '해설']) + ')_)?(' + m27_alt_([M27.NEW_CODE]) + ')(\\d{2})(?!\\d)', 'g');
  return String(cur == null ? '' : cur).replace(re, (all, s, kind, code, nn) =>
    map[nn] ? s + '_' + (kind || '') + (code === m27_nfc_(code) ? map[nn] : m27_nfd_(map[nn])) + nn : all);
}
/** Data_DS A열 키 목록 → 후보 세트 [{ set, reason, oldKeys, newKeys:[NN…] }] — 구 코드 키가 있는 2028 체제 세트만 */
function m27_candidatesFromKeys_(keys) {
  const bySet = {};
  (keys || []).forEach(k => {
    const s = ds_splitKey_(m27_nfc_(k)); if (!s) return;
    (bySet[s.set] || (bySet[s.set] = [])).push(s.code);
  });
  const frame = ds_sets2028FromKeys_((keys || []).map(m27_nfc_));
  const out = [];
  Object.keys(bySet).forEach(set => {
    const codes = bySet[set], old = codes.filter(c => M27.OLD_CODES.indexOf(c.slice(0, 3)) >= 0);
    if (!old.length) return;
    const m = set.match(KEY_2028_RE);
    const reason = (m && Number(m[1]) >= 27) ? '세트명 ≥27' : (frame[set] ? '2028 서킷 틀' : '');
    if (!reason) return;
    out.push({ set, reason, oldKeys: old.length, newKeys: codes.filter(c => c.indexOf(M27.NEW_CODE) === 0).map(c => c.slice(3)) });
  });
  return out.sort((a, b) => a.set < b.set ? -1 : 1);
}
/** 구 코드 목록(`1공통14`…) + 이미 있는 0통합 번호 → 충돌 문구 목록 */
function m27_conflicts_(hits, existingNew) {
  const byNo = {};
  hits.forEach(h => { const nn = h.slice(3); (byNo[nn] || (byNo[nn] = {}))[h.slice(0, 3)] = true; });
  const out = [];
  Object.keys(byNo).sort().forEach(nn => {
    const codes = Object.keys(byNo[nn]);
    if (codes.length > 1) out.push(`번호 겹침 ${nn}: ${codes.join('·')}`);
    if ((existingNew || []).indexOf(nn) >= 0) out.push(`이미 ${M27.NEW_CODE}${nn} 있음`);
  });
  return out;
}

/* ───── 조사 ───── */

function m27_openStore_(store) {
  return store.id ? SpreadsheetApp.openById(store.id) : SpreadsheetApp.getActiveSpreadsheet();
}

/** 한 저장소에서 세트의 바꿀 셀 목록. [{ store, ssId, sheet, row, col, old, neu, hits }] · formulas(건너뛴 수식 셀 수) */
function m27_scanStore_(ss, store, set) {
  const found = {};          // sheet → { 'r,c': true }
  m27_forms_(set).forEach(f => {
    ss.createTextFinder(f).matchCase(true).findAll().forEach(rg => {
      const sh = rg.getSheet(), name = sh.getName();
      if (M27.SKIP_SHEET_RE.test(name)) return;
      (found[name] || (found[name] = { sh, cells: {} })).cells[rg.getRow() + ',' + rg.getColumn()] = true;
    });
  });
  const out = [];
  let formulas = 0;
  const ssId = store.id || ss.getId();
  Object.keys(found).forEach(name => {
    const { sh, cells } = found[name];
    const rc = Object.keys(cells).map(k => k.split(',').map(Number));
    const grp = (store.groups || []).find(g => g.sheet === name);
    const rows = rc.map(x => x[0]), cols = rc.map(x => x[1]).concat(grp ? [grp.setCol, grp.groupCol] : []);
    const r0 = Math.min.apply(null, rows), r1 = Math.max.apply(null, rows), c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
    let vals = null, fx = null;
    if ((r1 - r0 + 1) * (c1 - c0 + 1) <= M27.BULK_MAX) {
      const rg = sh.getRange(r0, c0, r1 - r0 + 1, c1 - c0 + 1);
      vals = rg.getValues(); fx = rg.getFormulas();
    }
    const valAt = (r, c) => vals ? vals[r - r0][c - c0] : sh.getRange(r, c).getValue();
    const fxAt = (r, c) => fx ? fx[r - r0][c - c0] : sh.getRange(r, c).getFormula();
    const seen = {};
    rc.forEach(([r, c]) => {
      seen[r + ',' + c] = true;
      const v = valAt(r, c);
      if (typeof v !== 'string') return;
      if (fxAt(r, c)) { if (m27_replace_(v, set).hits.length) formulas++; return; }
      const res = m27_replace_(v, set);
      if (res.hits.length && res.text !== v) out.push({ store: store.key, ssId, sheet: name, row: r, col: c, old: v, neu: res.text, hits: res.hits });
    });
    if (grp) {                      // 세트명 칸(AD)이 이 세트인 행의 문항그룹 칸(AE)
      rc.filter(([r, c]) => c === grp.setCol && m27_nfc_(valAt(r, c)).trim() === m27_nfc_(set)).forEach(([r]) => {
        if (seen[r + ',' + grp.groupCol]) return;
        const v = valAt(r, grp.groupCol), b = m27_bareGroup_(v);
        if (!b) return;
        if (fxAt(r, grp.groupCol)) { formulas++; return; }
        out.push({ store: store.key, ssId, sheet: name, row: r, col: grp.groupCol, old: v, neu: b.text, hits: [b.hit] });
      });
    }
  });
  return { cells: out.sort((a, b) => a.sheet < b.sheet ? -1 : a.sheet > b.sheet ? 1 : a.row - b.row || a.col - b.col), formulas };
}

function m27_folder_(path) {
  try { return getFolderByPath(path); } catch (_) { return null; }
}
/** Drive 폴더들에서 세트의 바꿀 파일 [{ folder, id, file, old, neu, hits }] */
function m27_scanDrive_(set, folders) {
  const out = [], seen = {};
  folders.forEach(({ path, folder }) => {
    if (!folder) return;
    m27_forms_(set).forEach(f => {
      const q = "title contains '" + f.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
      const it = folder.searchFiles(q);
      while (it.hasNext()) {
        const file = it.next(), id = file.getId();
        if (seen[id]) continue;
        seen[id] = true;
        const name = file.getName(), res = m27_replace_(name, set);
        if (res.hits.length && res.text !== name) out.push({ folder: path, id, file, old: name, neu: res.text, hits: res.hits });
      }
    });
  });
  return out;
}

/** 세트 하나 전수 조사 → { set, cells, files, counts{store…, drive}, formulas, conflicts[] } */
function m27_scanSet_(set, ctx, existingNew) {
  const counts = {}, cells = [], allHits = [];
  let formulas = 0;
  M27.STORES.forEach(store => {
    const ss = ctx.ss[store.key];
    if (!ss) { counts[store.key] = null; return; }
    const r = m27_scanStore_(ss, store, set);
    counts[store.key] = r.cells.length;
    formulas += r.formulas;
    r.cells.forEach(c => c.hits.forEach(h => allHits.push(h)));
    if (!store.countOnly) r.cells.forEach(c => cells.push(c));
  });
  const files = m27_scanDrive_(set, ctx.folders);
  counts.drive = files.length;
  files.forEach(f => f.hits.forEach(h => allHits.push(h)));
  const conflicts = m27_conflicts_(allHits, existingNew);
  M27.STORES.forEach(s => { if (s.countOnly && counts[s.key]) conflicts.push(`${s.key} ${counts[s.key]}셀 — 이 도구로 못 바꿈(장부 메뉴 필요)`); });
  if (formulas) conflicts.push(`수식 셀 ${formulas}개(건너뜀)`);
  return { set, cells, files, counts, formulas, conflicts };
}

function m27_context_() {
  const ss = {}, errors = [];
  M27.STORES.forEach(store => {
    try { ss[store.key] = m27_openStore_(store); } catch (e) { ss[store.key] = null; errors.push(`${store.key} 열기 실패: ${e.message || e}`); }
  });
  const folders = M27.FOLDERS.map(path => ({ path, folder: m27_folder_(path) }));
  folders.filter(f => !f.folder).forEach(f => errors.push(`폴더 없음: ${f.path}`));
  return { ss, folders, errors };
}

function m27_dsKeys_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DSN.SHEET);
  const last = sh ? sh.getLastRow() : 0;
  return last >= 2 ? sh.getRange(2, DSN.COL.key, last - 1, 1).getValues().map(r => String(r[0] || '')) : [];
}

/* ───── Migrate_27 시트 ───── */

function m27_sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(M27.SHEET);
  if (!sh) { sh = ss.insertSheet(M27.SHEET); sh.getRange(1, 1, 1, M27.HEAD.length).setValues([M27.HEAD]); try { sh.setFrozenRows(1); } catch (_) {} }
  return sh;
}
function m27_logSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(M27.LOG);
  if (!sh) { sh = ss.insertSheet(M27.LOG); sh.getRange(1, 1, 1, M27.LOG_HEAD.length).setValues([M27.LOG_HEAD]); try { sh.setFrozenRows(1); } catch (_) {} }
  return sh;
}
/** { 세트명: { row, values[] } } */
function m27_readTable_(sh) {
  const last = sh.getLastRow(), out = {};
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, M27.HEAD.length).getValues().forEach((v, i) => { const s = m27_nfc_(v[0]).trim(); if (s) out[s] = { row: i + 2, values: v }; });
  return out;
}
function m27_isOk_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

/* ───── ① 조사 ───── */

/** sets(선택): 조사할 세트명 목록 — 없으면 Data_DS 후보 전부. 반환 { ok, sets:[{set, reason, counts, conflicts}], errors } */
function m27_surveyCore_(sets) {
  const keys = m27_dsKeys_();
  let cands = m27_candidatesFromKeys_(keys);
  if (sets && sets.length) {
    const want = sets.map(m27_nfc_);
    const extra = want.filter(s => !cands.some(c => c.set === s)).map(s => ({ set: s, reason: '지정', oldKeys: 0, newKeys: [] }));
    cands = cands.filter(c => want.indexOf(c.set) >= 0).concat(extra);
  }
  const ctx = m27_context_();
  const sh = m27_sheet_(), table = m27_readTable_(sh), now = new Date();
  const res = cands.map(c => {
    const r = m27_scanSet_(c.set, ctx, c.newKeys);
    const prev = table[c.set];
    const C = M27.COL;
    const row = prev ? prev.values.slice() : new Array(M27.HEAD.length).fill('');
    row[C.set - 1] = c.set; row[C.reason - 1] = c.reason; row[C.keys - 1] = c.oldKeys;
    ['latex', 'audition', 'kice', 'kicelatex', 'ledger', 'drive'].forEach(k => { row[C[k] - 1] = r.counts[k] == null ? '열기 실패' : r.counts[k]; });
    row[C.conflict - 1] = r.conflicts.length ? r.conflicts.join(' / ') : 0;
    if (!prev) row[C.ok - 1] = false;
    if (String(row[C.state - 1]) !== M27.STATE_DONE) row[C.state - 1] = '조사됨';
    row[C.surveyed - 1] = now;
    if (prev) sh.getRange(prev.row, 1, 1, row.length).setValues([row]);
    else { sh.appendRow(row); table[c.set] = { row: sh.getLastRow(), values: row }; }
    return { set: c.set, reason: c.reason, oldKeys: c.oldKeys, counts: r.counts, conflicts: r.conflicts, state: row[C.state - 1] };
  });
  try { const last = sh.getLastRow(); if (last >= 2) sh.getRange(2, M27.COL.ok, last - 1, 1).insertCheckboxes(); } catch (_) {}
  return { ok: ctx.errors.length === 0, sets: res, errors: ctx.errors };
}

/* ───── ③ 적용 ───── */

/**
 * 승인된 세트를 적용. sets: 세트명 목록(없으면 승인 칸이 체크된 세트 전부). approveBy: 주면 그 세트의 승인 칸을 체크하고 적용(원격).
 * 세트마다: 다시 조사 → 충돌 있으면 멈춤 → 로그('예정') → 셀·파일 바꿈 → 로그('적용') → Migrate_27 '적용됨'.
 */
function m27_applyCore_(sets, by, approveBy) {
  if (typeof pl_isBusy_ === 'function' && pl_isBusy_()) return { ok: false, reason: '파이프라인이 실행 중입니다 — 끝난 뒤에 적용하세요.' };
  const sh = m27_sheet_(), table = m27_readTable_(sh), C = M27.COL;
  let targets = sets && sets.length ? sets.map(m27_nfc_) : Object.keys(table).filter(s => m27_isOk_(table[s].values[C.ok - 1]));
  const results = [];
  const ctx = m27_context_();
  if (ctx.errors.length) return { ok: false, reason: '저장소 열기 실패', errors: ctx.errors };
  const cands = m27_candidatesFromKeys_(m27_dsKeys_());
  targets.forEach(set => {
    const t = table[set];
    if (!t) { results.push({ set, ok: false, reason: '조사 기록 없음 — 먼저 ① 조사' }); return; }
    if (String(t.values[C.state - 1]) === M27.STATE_DONE) { results.push({ set, ok: false, reason: '이미 적용됨' }); return; }
    if (approveBy) { sh.getRange(t.row, C.ok).setValue(true); t.values[C.ok - 1] = true; }
    if (!m27_isOk_(t.values[C.ok - 1])) { results.push({ set, ok: false, reason: '승인 안 됨' }); return; }
    const cand = cands.find(c => c.set === set);
    const r = m27_scanSet_(set, ctx, cand ? cand.newKeys : []);
    if (r.conflicts.length) {
      sh.getRange(t.row, C.conflict).setValue(r.conflicts.join(' / ')); sh.getRange(t.row, C.state).setValue('멈춤(충돌)');
      results.push({ set, ok: false, reason: '충돌', conflicts: r.conflicts }); return;
    }
    results.push(m27_applySet_(set, r, by || '메뉴', t.row, sh));
  });
  return { ok: results.every(x => x.ok), sets: results };
}

function m27_applySet_(set, r, by, tableRow, tsh) {
  const log = m27_logSheet_(), now = new Date(), C = M27.COL;
  const rows = r.cells.map(c => [now, set, c.store, c.ssId, c.sheet, c.row, c.col, c.old, c.neu, '예정', by])
    .concat(r.files.map(f => [now, set, 'drive', f.id, f.folder, '', '', f.old, f.neu, '예정', by]));
  if (!rows.length) { tsh.getRange(tableRow, C.state).setValue('대상 없음'); return { set, ok: true, cells: 0, files: 0 }; }
  const logStart = log.getLastRow() + 1;
  log.getRange(logStart, 1, rows.length, M27.LOG_HEAD.length).setValues(rows);
  const status = rows.map(() => ['적용']);
  const ssCache = {};
  const errs = [];
  r.cells.forEach((c, i) => {
    try {
      const ss = ssCache[c.ssId] || (ssCache[c.ssId] = SpreadsheetApp.openById(c.ssId));
      const rg = ss.getSheetByName(c.sheet).getRange(c.row, c.col);
      const cur = rg.getValue();
      if (cur !== c.old) { status[i] = ['건너뜀(값 바뀜)']; errs.push(`${c.sheet} R${c.row}C${c.col} 값 바뀜`); return; }
      rg.setValue(c.neu);
    } catch (e) { status[i] = ['실패']; errs.push(`${c.sheet} R${c.row}C${c.col}: ${e.message || e}`); }
  });
  r.files.forEach((f, j) => {
    const i = r.cells.length + j;
    try {
      if (f.file.getName() !== f.old) { status[i] = ['건너뜀(이름 바뀜)']; errs.push(`파일 ${f.old} 이름 바뀜`); return; }
      f.file.setName(f.neu);
    } catch (e) { status[i] = ['실패']; errs.push(`파일 ${f.old}: ${e.message || e}`); }
  });
  log.getRange(logStart, 10, status.length, 1).setValues(status);
  try { SpreadsheetApp.flush(); } catch (_) {}
  const nCells = status.slice(0, r.cells.length).filter(s => s[0] === '적용').length;
  const nFiles = status.slice(r.cells.length).filter(s => s[0] === '적용').length;
  tsh.getRange(tableRow, C.state).setValue(errs.length ? '일부 실패' : M27.STATE_DONE);
  tsh.getRange(tableRow, C.applied).setValue(now);
  tsh.getRange(tableRow, C.note).setValue(`셀 ${nCells} · 파일 ${nFiles} · 로그 ${logStart}~${logStart + rows.length - 1}행` + (errs.length ? ' · ' + errs.slice(0, 3).join(' / ') : ''));
  return { set, ok: errs.length === 0, cells: nCells, files: nFiles, logRows: [logStart, logStart + rows.length - 1], errors: errs };
}

/* ───── ④ 되돌리기 ───── */

/** 세트의 로그('적용'·'예정')를 거꾸로 돌린다. 지금 값이 새 값이면 원래 값으로, 이미 원래 값이면 건너뛴다, 그 밖이면 남겨 두고 알린다. */
function m27_undoCore_(set, by) {
  if (typeof pl_isBusy_ === 'function' && pl_isBusy_()) return { ok: false, reason: '파이프라인이 실행 중입니다.' };
  set = m27_nfc_(set);
  const log = m27_logSheet_(), last = log.getLastRow();
  if (last < 2) return { ok: false, reason: '로그 없음' };
  const vals = log.getRange(2, 1, last - 1, M27.LOG_HEAD.length).getValues();
  const idx = [];
  vals.forEach((v, i) => { if (m27_nfc_(v[1]) === set && (v[9] === '적용' || v[9] === '예정')) idx.push(i); });
  if (!idx.length) return { ok: false, reason: '되돌릴 로그 없음' };
  const ssCache = {}, errs = [];
  let nCells = 0, nFiles = 0;
  idx.reverse().forEach(i => {
    const v = vals[i];
    let st = '되돌림';
    try {
      if (v[2] === 'drive') {
        const f = DriveApp.getFileById(v[3]), cur = f.getName();
        if (cur === v[8]) { f.setName(v[7]); nFiles++; } else if (cur !== v[7]) { st = '되돌림 실패(이름 다름)'; errs.push(`파일 ${cur}`); }
      } else {
        const ss = ssCache[v[3]] || (ssCache[v[3]] = SpreadsheetApp.openById(v[3]));
        const rg = ss.getSheetByName(v[4]).getRange(Number(v[5]), Number(v[6])), cur = rg.getValue();
        if (cur === v[8]) { rg.setValue(v[7]); nCells++; }
        else if (cur !== v[7]) {
          const rv = typeof cur === 'string' ? m27_revert_(cur, set, v[7]) : cur;
          if (rv !== cur) { rg.setValue(rv); nCells++; st = '되돌림(이 세트 키만)'; }
          else { st = '되돌림 실패(값 다름)'; errs.push(`${v[4]} R${v[5]}C${v[6]}`); }
        }
      }
    } catch (e) { st = '되돌림 실패'; errs.push(String(e.message || e)); }
    log.getRange(i + 2, 10).setValue(st);
  });
  const sh = m27_sheet_(), t = m27_readTable_(sh)[set];
  if (t) {
    sh.getRange(t.row, M27.COL.state).setValue(errs.length ? '되돌림 일부 실패' : '되돌림');
    sh.getRange(t.row, M27.COL.ok).setValue(false);
    sh.getRange(t.row, M27.COL.note).setValue(`되돌림 ${new Date().toISOString()} · 셀 ${nCells} · 파일 ${nFiles} · ${by || '메뉴'}`);
  }
  return { ok: errs.length === 0, set, cells: nCells, files: nFiles, errors: errs };
}

/* ───── 메뉴 ───── */

function m27_alert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (_) { Logger.log(msg); } }
function m27_fmt_(r) {
  if (!r.ok && r.reason) return '실패: ' + r.reason + (r.errors ? '\n' + r.errors.join('\n') : '');
  return (r.sets || []).map(s => s.counts
    ? `${s.set} [${s.reason}] 키 ${s.oldKeys} · Latex ${s.counts.latex} · 검토 ${s.counts.audition} · KICE ${s.counts.kice} · KICE_latex ${s.counts.kicelatex} · 장부 ${s.counts.ledger} · Drive ${s.counts.drive}` + (s.conflicts.length ? `\n   ⚠ ${s.conflicts.join(' / ')}` : '')
    : `${s.set}: ${s.ok ? `셀 ${s.cells} · 파일 ${s.files}` : '✗ ' + s.reason + (s.conflicts ? ' ' + s.conflicts.join(' / ') : '')}`).join('\n') + (r.errors && r.errors.length ? '\n⚠ ' + r.errors.join('\n⚠ ') : '');
}
function m27_surveyMenu() {
  const r = m27_surveyCore_(null);
  m27_alert_('① 조사 결과 (쓰기 없음 — Migrate_27 에 기록)\n\n' + (r.sets.length ? m27_fmt_(r) : '후보 세트 없음') + '\n\n승인할 세트의 "승인" 칸을 체크한 뒤 ③ 적용을 누르세요.');
}
function m27_applyMenu() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('③ 적용', '승인 칸이 체크된 세트의 키를 0통합으로 바꿉니다(로그로 되돌릴 수 있음). 진행할까요?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return m27_alert_('다른 작업이 실행 중입니다.');
  try { m27_alert_('③ 적용 결과\n\n' + m27_fmt_(m27_applyCore_(null, '메뉴'))); } finally { lock.releaseLock(); }
}
function m27_undoMenu() {
  const ui = SpreadsheetApp.getUi();
  const p = ui.prompt('④ 되돌리기', '되돌릴 세트명(Migrate_27 A열 그대로):', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return m27_alert_('다른 작업이 실행 중입니다.');
  try { const r = m27_undoCore_(p.getResponseText().trim(), '메뉴'); m27_alert_(r.ok ? `되돌림: 셀 ${r.cells} · 파일 ${r.files}` : '실패: ' + (r.reason || r.errors.join('\n'))); } finally { lock.releaseLock(); }
}
