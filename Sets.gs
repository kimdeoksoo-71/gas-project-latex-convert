/*************************************************
 * Sets.gs — 세트 프로파일 · `Sets` 시트 (renual P3, 2026-11-19)
 *
 * 계획: audit-pipeline-docs `renual/2026-11-19-renewal-plan-v3.md` §2.1~2.3 · §5 (X-01).
 *   - `Sets` 시트 = 세트 프로파일·정답(answers)·번호 대응(numbering)의 **유일한 영구 원본**(세트당 한 행).
 *     CroP 가 크롭과 함께 IMAGE_DS 에 올린 `<시험지명>_set.json`(전달용)을 search 단계가 통째로 옮긴다(Pipeline.gs).
 *     러너 replace 가 런마다 IMAGE_DS 를 비우므로 그 뒤로는 이 행이 원본이다.
 *   - 행이 없는 세트는 **키로 추론**한다(구 데이터 호환): 과목코드가 우선 — `0` → 신·2022 / `9`(순번·기출) → 문제집 /
 *     `1·3·4·5` → 구·2015. 추론값은 지금 동작과 같다(해설 있음 · 정답출처 해설본문).
 *   - 위의 순수 함수(sets_*Profile_·sets_parseSidecar_·sets_rowOf_ 등)는 시트를 쓰지 않는다(Node 시험).
 *************************************************/

const SETS = {
  SHEET: 'Sets',
  HEAD: ['세트명', '형식', '구성', '교육과정', '양식', '해설', '정답출처', '감지 경고', 'answers', 'numbering', '정답 개수', '잠금', '갱신시각', '갱신자'],
  COL: { name: 1, form: 2, comp: 3, curr: 4, preset: 5, sol: 6, ansSrc: 7, warn: 8, answers: 9, numbering: 10, nAns: 11, lock: 12, at: 13, by: 14 },
  CELL_MAX: 50000,                         // 구글 시트 셀 한도 — 넘으면 잘라 적지 않고 실패로 알린다(P3-6)
  FIELDS: ['형식', '구성', '교육과정', '양식', '해설', '정답출처'],
  DEFAULT: { '형식': '신', '구성': '30', '교육과정': '2022', '양식': '-', '해설': '있음', '정답출처': '해설본문' },
  COMP: { '신': ['30', '10', '11'], '구': ['46', '38', '12', '14G', '14'], '문제집': ['가변'] },
  CURR: { '신': ['2022'], '구': ['2015'], '문제집': ['2022', '2015'] },
  SOL: ['있음', '없음'],
  ANS_SRC: ['해설본문', '해설정답표', '문제지정답표', '없음'],
  ANS_SRC_NO_SOL: ['문제지정답표', '없음'],
  ANS_FROM_TABLE: ['해설정답표', '문제지정답표'],   // 정답 채우기에서 answers 열을 먼저 보는 정답출처
};

/* =================================================
 * 1. 순수 함수
 * ================================================= */
function sets_nfc_(s) {
  s = (s == null) ? '' : String(s);
  try { return s.normalize('NFC'); } catch (_) { return s; }
}

/**
 * 프로파일 검사·정리 → { ok, profile, errors:[…] }. 빠진 칸은 채우지 않는다(호출 쪽이 기본값을 고른다).
 *   연동 규칙(§2.1): 형식 → 구성·교육과정 선택지 / 신·구의 양식 = '-' · 문제집은 양식 필수 / 해설 없음 → 정답출처 문제지정답표|없음
 */
function sets_checkProfile_(p) {
  const errors = [], out = {};
  p = p || {};
  SETS.FIELDS.forEach(f => { out[f] = sets_nfc_(p[f]).trim(); });
  const form = out['형식'];
  if (!SETS.COMP[form]) errors.push(`형식 '${form}' (신|구|문제집)`);
  else {
    if (SETS.COMP[form].indexOf(out['구성']) < 0) errors.push(`구성 '${out['구성']}' (${form}: ${SETS.COMP[form].join('|')})`);
    if (SETS.CURR[form].indexOf(out['교육과정']) < 0) errors.push(`교육과정 '${out['교육과정']}' (${form}: ${SETS.CURR[form].join('|')})`);
    if (form === '문제집') { if (!out['양식'] || out['양식'] === '-') errors.push('양식 — 문제집은 양식 이름이 필요'); }
    else if (out['양식'] !== '-') errors.push(`양식 '${out['양식']}' (${form}: -)`);
  }
  if (SETS.SOL.indexOf(out['해설']) < 0) errors.push(`해설 '${out['해설']}' (있음|없음)`);
  if (SETS.ANS_SRC.indexOf(out['정답출처']) < 0) errors.push(`정답출처 '${out['정답출처']}' (${SETS.ANS_SRC.join('|')})`);
  else if (out['해설'] === '없음' && SETS.ANS_SRC_NO_SOL.indexOf(out['정답출처']) < 0)
    errors.push(`정답출처 '${out['정답출처']}' — 해설 없음이면 ${SETS.ANS_SRC_NO_SOL.join('|')}`);
  return { ok: errors.length === 0, profile: out, errors: errors };
}

/**
 * 러너 인자 → 프로파일. "신,30,2022,-,있음,해설본문"(순서: 형식·구성·교육과정·양식·해설·정답출처) 또는 JSON 문자열.
 * 빈 값이면 null(프로파일 없음 = 키 추론). 형식이 틀리면 { ok:false, errors }.
 */
function sets_parseProfileArg_(raw) {
  const s = sets_nfc_(raw).trim();
  if (!s) return null;
  let obj;
  if (s.charAt(0) === '{') {
    try { obj = JSON.parse(s); } catch (e) { return { ok: false, errors: ['profile JSON 해석 실패: ' + e.message] }; }
  } else {
    const parts = s.split(',').map(x => x.trim());
    if (parts.length !== SETS.FIELDS.length) return { ok: false, errors: [`profile 칸 수 ${parts.length} (${SETS.FIELDS.length}칸: ${SETS.FIELDS.join(',')})`] };
    obj = {}; SETS.FIELDS.forEach((f, i) => { obj[f] = parts[i]; });
  }
  return sets_checkProfile_(obj);
}

/** 키(또는 세트의 과목코드)로 프로파일 추론 — Sets 행이 없을 때. 지금 동작과 같은 값(해설 있음 · 해설본문) */
function sets_inferProfile_(key) {
  const kc = (typeof ds_keyCode_ === 'function') ? ds_keyCode_(key) : null;
  const base = { '양식': '-', '해설': '있음', '정답출처': '해설본문', inferred: true };
  if (!kc) return Object.assign({ '형식': '', '구성': '', '교육과정': '' }, base);
  if (kc.digit === '0') return Object.assign({ '형식': '신', '구성': '', '교육과정': '2022' }, base);
  if (kc.digit === '9') return Object.assign({ '형식': '문제집', '구성': '가변', '교육과정': '' }, base, { '양식': '' });
  return Object.assign({ '형식': '구', '구성': '', '교육과정': '2015' }, base);
}

/** answers 값 → ds_formatAnswer_ 가 받는 { kind, value } | null.  '③'·'3'·3·'20' (P3-3 혼용 흡수) */
function sets_answerToFound_(v) {
  if (v === null || v === undefined) return null;
  const s = sets_nfc_(v).trim().replace(/^\$+|\$+$/g, '').trim();
  const ci = ['①', '②', '③', '④', '⑤'].indexOf(s);
  if (ci >= 0) return { kind: 'circled', value: ci + 1 };
  if (/^\d{1,3}$/.test(s)) return { kind: 'int', value: Number(s) };
  return null;                              // 분수·음수 등은 추측하지 않는다 → 해설 본문 추출로 넘긴다
}

/**
 * `_set.json` 본문 → { ok, exam, profile, warnings:[…], answers:{}, numbering:{}|null, errors:[…] }
 *   answers 의 키는 과목코드+번호(`0통합07`·`9순번001`)만 받는다. 모르는 키는 errors.
 */
function sets_parseSidecar_(text) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch (e) { return { ok: false, errors: ['JSON 해석 실패: ' + e.message] }; }
  const errors = [];
  if (!j || typeof j !== 'object') return { ok: false, errors: ['JSON 객체가 아님'] };
  if (j.schema !== 1) errors.push('schema ' + j.schema + ' (1 만 받음)');
  const exam = sets_nfc_(j.exam).trim();
  if (!exam) errors.push('exam 비어 있음');
  const chk = sets_checkProfile_(j.profile);
  if (!chk.ok) errors.push.apply(errors, chk.errors.map(x => 'profile ' + x));
  const codeRe = new RegExp('^(?:' + KEY_CODE_SRC + ')$');
  const answers = {};
  if (j.answers != null) {
    if (typeof j.answers !== 'object' || Array.isArray(j.answers)) errors.push('answers 가 객체가 아님');
    else Object.keys(j.answers).forEach(k => {
      const kk = sets_nfc_(k).trim();
      if (!codeRe.test(kk)) { errors.push('answers 키 형식 밖: ' + k); return; }
      answers[kk] = j.answers[k];
    });
  }
  let numbering = null;
  if (j.numbering != null) {
    if (typeof j.numbering !== 'object' || Array.isArray(j.numbering)) errors.push('numbering 이 객체가 아님');
    else numbering = j.numbering;
  }
  const det = (j.detected && typeof j.detected === 'object') ? j.detected : {};
  const warnings = Array.isArray(det.warnings) ? det.warnings.map(w => sets_nfc_(typeof w === 'string' ? w : JSON.stringify(w))) : [];
  return { ok: errors.length === 0, exam: exam, profile: chk.profile, warnings: warnings, answers: answers, numbering: numbering,
           engine: sets_nfc_(j.engine), errors: errors };
}

/** 레코드 → Sets 행(14칸). 셀 한도 초과면 { ok:false, reason } */
function sets_rowOf_(rec, by, now) {
  const p = rec.profile || {};
  const ans = rec.answers && Object.keys(rec.answers).length ? JSON.stringify(rec.answers) : '';
  const num = rec.numbering && Object.keys(rec.numbering).length ? JSON.stringify(rec.numbering) : '';
  const warn = (rec.warnings || []).join(' · ');
  const big = [['answers', ans], ['numbering', num], ['감지 경고', warn]].filter(x => x[1].length > SETS.CELL_MAX);
  if (big.length) return { ok: false, reason: big.map(x => `${x[0]} ${x[1].length}자 > ${SETS.CELL_MAX}`).join(', ') };
  const row = new Array(SETS.HEAD.length).fill('');
  row[SETS.COL.name - 1] = sets_nfc_(rec.exam).trim();
  SETS.FIELDS.forEach((f, i) => { row[SETS.COL.form - 1 + i] = p[f] || ''; });
  row[SETS.COL.warn - 1] = warn;
  row[SETS.COL.answers - 1] = ans;
  row[SETS.COL.numbering - 1] = num;
  row[SETS.COL.nAns - 1] = rec.answers ? Object.keys(rec.answers).length : 0;
  row[SETS.COL.at - 1] = now || new Date();
  row[SETS.COL.by - 1] = by || '';
  return { ok: true, row: row };
}

/** Sets 행(시트 값) → 레코드. answers·numbering JSON 이 깨져 있으면 bad 에 이유 */
function sets_recOfRow_(r) {
  const rec = { exam: sets_nfc_(r[SETS.COL.name - 1]).trim(), profile: {}, answers: {}, numbering: null, lock: false, bad: [] };
  SETS.FIELDS.forEach((f, i) => { rec.profile[f] = sets_nfc_(r[SETS.COL.form - 1 + i]).trim(); });
  const lk = String(r[SETS.COL.lock - 1] == null ? '' : r[SETS.COL.lock - 1]).trim().toLowerCase();
  rec.lock = lk !== '' && lk !== 'false' && lk !== '0' && lk !== 'n' && lk !== 'no';
  const ja = String(r[SETS.COL.answers - 1] || '').trim(), jn = String(r[SETS.COL.numbering - 1] || '').trim();
  if (ja) { try { rec.answers = JSON.parse(ja) || {}; } catch (e) { rec.bad.push('answers JSON'); } }
  if (jn) { try { rec.numbering = JSON.parse(jn); } catch (e) { rec.bad.push('numbering JSON'); } }
  return rec;
}

/**
 * 키 → { set, code, profile, answers, rec|null, inferred }.  map = sets_readAll_ 의 byName (없으면 추론만)
 *   세트명은 키에서 `_과목코드NN` 을 뗀 앞부분(ds_splitKey_). Sets 행의 빈 칸은 추론값으로 메운다.
 */
function sets_forKey_(map, key) {
  const sp = (typeof ds_splitKey_ === 'function') ? ds_splitKey_(key) : null;
  const set = sp ? sets_nfc_(sp.set) : '', code = sp ? sp.code : '';
  const inf = sets_inferProfile_(key);
  const rec = (map && set && map[set]) || null;
  if (!rec) return { set: set, code: code, profile: inf, answers: {}, rec: null, inferred: true };
  const prof = {};
  SETS.FIELDS.forEach(f => { prof[f] = rec.profile[f] || inf[f] || ''; });
  return { set: set, code: code, profile: prof, answers: rec.answers || {}, rec: rec, inferred: false };
}

/* =================================================
 * 2. 시트 읽기·쓰기
 * ================================================= */
/** Sets 시트 (없으면 create=true 일 때 머리와 함께 만든다) */
function sets_sheet_(ss, create) {
  ss = ss || SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SETS.SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(SETS.SHEET);
    sh.getRange(1, 1, 1, SETS.HEAD.length).setValues([SETS.HEAD]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 전 행 읽기 → { byName:{세트명: rec(+row)}, n } */
function sets_readAll_(ss) {
  const sh = sets_sheet_(ss, false);
  const out = { byName: {}, n: 0 };
  if (!sh) return out;
  const last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, SETS.HEAD.length).getValues().forEach((r, i) => {
    const rec = sets_recOfRow_(r);
    if (!rec.exam) return;
    rec.row = i + 2; out.byName[rec.exam] = rec; out.n++;
  });
  return out;
}

/** 한 세트 조회 (없으면 null) */
function sets_get_(exam, ss) {
  return sets_readAll_(ss).byName[sets_nfc_(exam).trim()] || null;
}

/**
 * upsert → 'inserted' | 'updated' | 'locked' | 'error:<사유>'.  잠금 행은 건드리지 않는다. 잠금 칸은 덮어쓰지 않는다.
 *   all = sets_readAll_ 결과(여러 번 부를 때 넘기면 다시 읽지 않는다 — 넣은 행은 all 에도 반영)
 */
function sets_upsert_(ss, rec, by, all) {
  const sh = sets_sheet_(ss, true);
  all = all || sets_readAll_(ss);
  const name = sets_nfc_(rec.exam).trim();
  if (!name) return 'error:세트명 없음';
  const built = sets_rowOf_(rec, by, new Date());
  if (!built.ok) return 'error:' + built.reason;
  const cur = all.byName[name];
  if (cur && cur.lock) return 'locked';
  if (cur) {
    built.row[SETS.COL.lock - 1] = sh.getRange(cur.row, SETS.COL.lock).getValue();
    sh.getRange(cur.row, 1, 1, SETS.HEAD.length).setValues([built.row]);
    Object.assign(cur, sets_recOfRow_(built.row), { row: cur.row });
    return 'updated';
  }
  const at = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(at, 1, 1, SETS.HEAD.length).setValues([built.row]);
  all.byName[name] = Object.assign(sets_recOfRow_(built.row), { row: at }); all.n++;
  return 'inserted';
}
