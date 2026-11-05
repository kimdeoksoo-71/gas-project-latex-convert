/**
 * Phase 72 (Mathory) — Data_DS L열 `jangbu_id` 백필.
 *
 * 문항장부(D조 문항장부)의 `_CroP색인` 시트(파일키 ↔ 문항ID, CroP 이미지 삽입 산출물)를 **읽어**
 * 이 파일 Data_DS의 A열(파일키)과 **표준 파일키**로 짝짓고, L열에 문항장부 A열 ID(`D####`·`S####`)를 쓴다.
 * Mathory 시트 가져오기가 L열을 읽어 `ImportSource.jangbu_id`로 남긴다(Phase 72 D4·D8).
 *
 *   - 문항장부는 읽기만 한다(openById → getValues). 쓰는 곳은 이 파일 Data_DS L열뿐.
 *   - 표준 파일키 규칙은 gas-project-problem-ledger `crop-image-insert.gs`(90c88cf)의
 *     `cropParseExam_`·`cropMakeCanon_`·`cropKeyAliases_`를 이식한 것 — 양쪽 키에 같은 함수를 걸어
 *     `24X모의06_…`(색인 표기) ↔ `24모의X06_…`(CroP 파일명 표기)를 맞춘다.
 *   - 멱등: L이 이미 있는 행은 건너뛴다(스크립트 속성 `JB_OVERWRITE=true`일 때만 덮어쓴다).
 *   - 가드: 파이프라인 진행 중(`pl_isBusy_`)이면 거부 · `getScriptLock` 실패면 거부(레포 락 관례).
 *   - 2~4489행(옛 Split 경로, 비-CroP 키)은 "형식 아님"으로 셀 뿐 — 정상이다.
 *
 * 실행: 메뉴 '🔗 문항장부 ID 채우기 (Data_DS L열)' (MainMenu.gs). 보고문은 알림 1장 + Logger.
 */

const JB = {
  LEDGER_ID: '1hlnZEB-v6MQ7FpkaZigblmAYy5_LBH6kqH6mflQRrj0',   // D조 문항장부
  INDEX_SHEET: '_CroP색인',
  IDX_COLS: 10, IDX_KEY: 1, IDX_ID: 2, IDX_STATUS: 10,         // = crop-image-insert.gs CROP_IDX (KEY·ITEM_ID·STATUS)
  DST_SHEET: 'Data_DS', COL_KEY: 1, COL_JANGBU: 12 /* L */, HEADER: 'jangbu_id',
  OVERWRITE_PROP: 'JB_OVERWRITE',                               // 'true'일 때만 기존 L을 덮어쓴다 (Q6)
  ID_RE: /^[DS]\d{4,5}$/,                                       // D#### · S#### (Q1)
  LOCK_MS: 10000, HEAD_N: 10,
};

/** NFC 정규화. 레포의 `nfc_`는 두 파일에 중복 정의라 쓰지 않는다. */
function jb_nfc_(s) {
  s = (s == null) ? '' : String(s);
  try { return s.normalize('NFC'); } catch (e) { return s; }
}

/** 시험지명 → 표준 세트명 (이식: crop-image-insert.gs cropParseExam_ · 90c88cf)
 *   새 이름 24X모의02 · 25X서킷03 / 구 이름(CroP 파일명) 26모의X14 · 26서킷X04 */
function jb_parseExam_(exam) {
  const s = jb_nfc_(exam).replace(/\s+/g, '');
  let m = s.match(/^(\d{2})X(모의|서킷|써킷)(\d{1,3})$/i);
  if (!m) {
    const o = s.match(/^(\d{2})(모의|서킷|써킷)X(\d{1,3})$/i);
    if (o) m = [o[0], o[1], o[2], o[3]];
  }
  if (!m) return null;
  return jb_makeCanon_(m[1], m[2], m[3]);
}

/** (이식: cropMakeCanon_) */
function jb_makeCanon_(yy, kind, nn) {
  const k = /^(써킷|서킷)$/.test(kind) ? '서킷' : '모의';
  const n2 = String(parseInt(nn, 10)).padStart(2, '0');
  return { canon: `${yy}X${k}${n2}`, yy: String(yy), kind: k, nn: n2 };
}

/**
 * 파일키 → 표준 파일키. `cropKeyAliases_(key)[0]` + 뒤 부분(`1공통05`) 번호 2자리 패딩(안전망).
 * X 규칙이 아니거나 뒤 부분이 `<코드><과목><번호>`가 아니면 null("형식 아님").
 */
function jb_canonKey_(key) {
  const k = jb_nfc_(key).trim();
  const i = k.indexOf('_'); if (i < 0) return null;
  const p = jb_parseExam_(k.slice(0, i)); if (!p) return null;
  const m = k.slice(i + 1).match(/^(\d)(공통|확통|미적|기하)(\d{1,2})$/);
  if (!m) return null;
  return `${p.canon}_${m[1]}${m[2]}${String(parseInt(m[3], 10)).padStart(2, '0')}`;
}

/** 알림: 메뉴 실행이면 alert, 편집기 실행이면 UI가 없어 예외 → 조용히. Logger는 항상. */
function jb_notify_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* UI 없음(편집기 실행) */ }
}

/** 메뉴: 문항장부 `_CroP색인` → Data_DS L열 백필 */
function jb_backfillFromLedger() {
  if (pl_isBusy_()) { jb_notify_(pl_busyMessage_()); return; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(JB.LOCK_MS)) { jb_notify_('다른 작업이 잠금을 쥐고 있습니다 — 잠시 뒤 다시 시도하세요.'); return; }
  try {
    const t0 = Date.now();
    const overwrite = PropertiesService.getScriptProperties().getProperty(JB.OVERWRITE_PROP) === 'true';

    // ② 색인 읽기 → Map<표준키, Set<ID>> (✅만 · ID 정규화 · 형식 불량은 세기만)
    const ledger = SpreadsheetApp.openById(JB.LEDGER_ID);
    const idx = ledger.getSheetByName(JB.INDEX_SHEET);
    if (!idx) throw new Error(`문항장부에 '${JB.INDEX_SHEET}' 시트가 없습니다.`);
    const nIdx = idx.getLastRow() - 1;
    const idxVals = nIdx > 0 ? idx.getRange(2, 1, nIdx, JB.IDX_COLS).getValues() : [];
    const map = new Map();
    const idBad = [];
    let idxOk = 0;
    for (const r of idxVals) {
      if (!/^✅/.test(String(r[JB.IDX_STATUS - 1] || ''))) continue;
      const canon = jb_canonKey_(r[JB.IDX_KEY - 1]);
      const id = jb_nfc_(r[JB.IDX_ID - 1]).trim().toUpperCase();
      if (!canon) continue;
      if (!JB.ID_RE.test(id)) { idBad.push(`${r[JB.IDX_KEY - 1]} → ${id}`); continue; }
      idxOk++;
      if (!map.has(canon)) map.set(canon, new Set());
      map.get(canon).add(id);
    }

    // ③ Data_DS A·L 1회 읽기 (전 행 — R5)
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(JB.DST_SHEET);
    if (!sh) throw new Error(`'${JB.DST_SHEET}' 시트가 없습니다.`);
    const lastRow = dlds_lastDataRow_(sh, 1);
    const n = lastRow - 1;
    const keys = n > 0 ? sh.getRange(2, JB.COL_KEY, n, 1).getValues() : [];
    const lcol = n > 0 ? sh.getRange(2, JB.COL_JANGBU, n, 1).getValues() : [];

    // ④ 행마다 판정
    const stat = { filled: 0, already: 0, notCrop: 0, noIndex: 0, ambiguous: 0 };
    const noIndexBySet = new Map();     // 세트별 집계 (R4)
    const noIndexHead = [], ambiguousHead = [];
    const used = new Set();             // 색인 ✅ 중 실제로 쓰인 표준키
    const out = lcol.map((r) => [r[0]]);
    for (let i = 0; i < n; i++) {
      const key = keys[i][0];
      if (String(key == null ? '' : key).trim() === '') continue;
      const cur = String(lcol[i][0] == null ? '' : lcol[i][0]).trim();
      if (cur && !overwrite) { stat.already++; continue; }
      const canon = jb_canonKey_(key);
      if (!canon) { stat.notCrop++; continue; }
      const ids = map.get(canon);
      if (!ids) {
        stat.noIndex++;
        const set = canon.slice(0, canon.indexOf('_'));
        noIndexBySet.set(set, (noIndexBySet.get(set) || 0) + 1);
        if (noIndexHead.length < JB.HEAD_N) noIndexHead.push(String(key));
        continue;
      }
      if (ids.size >= 2) {
        stat.ambiguous++;
        if (ambiguousHead.length < JB.HEAD_N) ambiguousHead.push(`${key} → ${Array.from(ids).join('/')}`);
        continue;
      }
      out[i][0] = Array.from(ids)[0];
      used.add(canon);
      stat.filled++;
    }

    // ⑤ L 범위 1회 쓰기 + 머리글
    if (n > 0) sh.getRange(2, JB.COL_JANGBU, n, 1).setValues(out);
    const h = sh.getRange(1, JB.COL_JANGBU);
    if (String(h.getValue() == null ? '' : h.getValue()).trim() === '') h.setValue(JB.HEADER);

    // ⑥ 보고
    const unused = [];
    for (const [canon] of map) if (!used.has(canon)) unused.push(canon);
    const setLines = Array.from(noIndexBySet.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([s, c]) => `${s} ${c}`).join(' · ');
    const msg = [
      `🔗 문항장부 ID 채우기 — Data_DS L열 (${((Date.now() - t0) / 1000).toFixed(1)}초, 대상 ${n}행, 색인 ✅ ${idxOk}건${overwrite ? ', 덮어쓰기 모드' : ''})`,
      `채움 ${stat.filled} · 이미 있음 ${stat.already} · 형식 아님 ${stat.notCrop}(옛 경로 행 — 정상)`,
      `색인에 없음 ${stat.noIndex}${setLines ? `(세트별: ${setLines})` : ''}`,
      noIndexHead.length ? `  앞 ${noIndexHead.length}개: ${noIndexHead.join(', ')}` : '',
      `모호 ${stat.ambiguous}${ambiguousHead.length ? ` (${ambiguousHead.join(' · ')})` : ''}`,
      `색인 ID 형식 불량 ${idBad.length}${idBad.length ? ` (${idBad.slice(0, JB.HEAD_N).join(' · ')})` : ''}`,
      `색인 ✅ 미사용 ${unused.length}${unused.length ? ` (앞 ${Math.min(unused.length, JB.HEAD_N)}개: ${unused.slice(0, JB.HEAD_N).join(', ')})` : ''}`,
    ].filter(Boolean).join('\n');
    jb_notify_(msg);
  } catch (e) {
    jb_notify_(`❌ 문항장부 ID 채우기 실패: ${e && e.message ? e.message : e}`);
  } finally {
    lock.releaseLock();
  }
}
