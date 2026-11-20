/**************************************************************
 * Classify.gs — 분류 프로세스(Meta 시트: 교과목·대단원·#태그)  renual P4 (2026-11-20)
 *
 * 계획: audit-pipeline-docs `renual/2026-11-19-renewal-plan-v3.md` §2.6 · §6(P4) · 부록 B-5.
 * 엔진은 「D조 문항장부」 `AiTagging.gs` v4(2026-11-07, 파일럿 대단원 99%)를 이 프로젝트로 옮기고 Meta 행 기준으로 일반화했다.
 *   - 배치 2단계(예열 → 본 배치) · 대단원 enum 구조화 출력 · 10분 수거 트리거 · 임대(lease) · 되돌리기 — v4 구조 그대로.
 *   - 대상: Data_DS 행 → Meta 행(키 단위, 없으면 만든다 — 키·jangbu_id·과목·교육과정·출처·인쇄번호). 소급 없음(A-4):
 *     러너 classify 단계(새 런의 세트) 또는 메뉴로 고른 행만.
 *   - enum(대단원 허용 목록, 「형식변화」 `표`):
 *       0통합 → 22 의 `0 통합` 9단원 / 1공통 → 15 의 11~23 / 3확통·4미적·5기하 → 15 의 각 3단원 /
 *       9순번·9기출 → 문항 교육과정(B-5)의 전체 15단원(2022 면 22 표, 그 밖 2015 표).
 *   - 교육과정(문항 단위, B-5): 과목코드 0 → 2022 · 1/3/4/5 → 2015 · 9기출 → 문제 OCR 첫머리 출처의 학년도(부록 A-3),
 *     못 읽으면 Sets → 상태 review · 9순번 → Sets.
 *   - (22) 꼬리표 규칙(§2.6): 과목 `0 통합` 또는 교육과정 2022 ⇔ 대단원·교과목 끝에 ` (22)`. 어기면 기록하지 않고 로그(rule_violation).
 *   - 태그 사전은 장부 `_태그사전`(사람이 관리) 그대로 읽는다. 22 단원은 `표`의 같은 행 15 단원으로 사전 키워드를 고른다.
 *   - 사람 값 보호: Meta G(대단원)가 이미 있거나 M(잠금)이 켜진 행은 쓰지 않는다(write_skipped).
 *
 * 메뉴(MainMenu.gs '분류(Meta)')  cl_setApiKey · cl_submitSelection · cl_submitPending · cl_pilotSubmit · cl_status · cl_stop · cl_undoRun
 * 원격(RemoteApi.gs)  cmd=classify&action=submit&keywords=…  (러너 classify 단계 — 제출만 하고 다음 단계로)
 *                     cmd=classify&action=pilot[&run=<장부 파일럿 실행ID>]  (P4-1, 쓰기 없음)
 *                     cmd=classify&action=status
 *
 * 절대 하지 않는 것: Data_DS·장부 쓰기(읽기만) · 트리거 실행 중 getUi() · 공용 ScriptLock 오래 잡기.
 * API 주의(Opus 5.5, anthropic-version 2026-10-21): temperature 등 샘플링 인자 금지(400) · thinking 은 max_tokens 에 포함 →
 *   16000 · effort 로만 조절 · 배치는 50% · 결과 29일 보관 · 배치 캐시는 best-effort 라 예열 1건을 먼저 보낸다.
 **************************************************************/

const CL = {
  // 참조
  FORMAT_SS_ID: '1ciEfliNvkDA3tna4DaobD5NGLCmmuwHO57oseldWORM',   // 「형식변화」
  UNITS_SHEET: '표',
  LEDGER_ID: '1hlnZEB-v6MQ7FpkaZigblmAYy5_LBH6kqH6mflQRrj0',      // 「D조 문항장부」 (읽기만)
  DICT_SHEET: '_태그사전',
  LEDGER_LOG: '_AI판정로그',                                       // 파일럿: 장부 v4 파일럿과 같은 행
  PILOT_RUN_DEFAULT: '261107-185349P',                             // 장부 v4 파일럿(100행 · 대단원 99%)

  // 이 파일
  DS_SHEET: 'Data_DS',
  DS_COL: { KEY: 1, PROBLEM: 2, SOLUTION: 3, JANGBU: 12 },
  MCOL: { key: 1, jb: 2, subj: 3, curr: 4, src: 5, course: 6, unit: 7, tags: 8, multi: 9, conf: 10, status: 11, by: 12, lock: 13, scope: 14, printed: 15, at: 16 },
  LOG_SHEET: 'Classify_Log',
  SUBJ_NAME: { '0통합': '0 통합', '1공통': '1 공통', '3확통': '3 확률과 통계', '4미적': '4 미적분', '5기하': '5 기하' },
  ST_WAIT: '대기',

  // 모델/API — 장부 v4 와 같은 값
  MODEL: 'claude-opus-5-5',
  EFFORT: 'medium',
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
  API_BASE: 'https://api.anthropic.com/v1',
  API_VERSION: '2026-10-21',
  API_KEY_PROP: 'ANTHROPIC_API_KEY',                               // UserProperties(이 프로젝트 · 내 계정) — P4-4
  MAX_TOKENS: 16000,
  CACHE_TTL: '1h',
  MAX_PROBLEM_CHARS: 4000,
  MAX_SOLUTION_CHARS: 12000,
  MAX_KEYWORDS: 3,

  // 배치/수거
  WARM_FIRST: true,
  BATCH_MAX: 300,
  BATCH_MAX_BYTES: 40 * 1024 * 1024,
  POLL_FIRST_MS: 3 * 60 * 1000,
  POLL_MS: 10 * 60 * 1000,                                         // 트리거 예산(하루 90분)을 Pipeline tick·Mathpix 와 나눠 씀 → 10분 유지
  LEASE_MS: 6 * 60 * 1000,
  LEASE_RETRY_MS: 2 * 60 * 1000,
  MAX_POLL_ERRORS: 3,
  RETRY_WAITS_MS: [2000, 5000, 12000],

  // 판정 정책
  REVIEW_BELOW: 0.6,
  SKIP_STATUSES: ['unit_invalid', 'write_error', 'refused', 'rule_violation', 'hold_curr'],
  SELECT_MAX: 2000,

  // 상태
  PROP_STATE: 'CL_STATE',
  PROP_LEASE: 'CL_LEASE',
  PROP_LAST: 'CL_LAST_SUMMARY',
  POLL_FN: 'cl_batchPoll',
};

/** Classify_Log 열 (1-based). 시트 전체 텍스트 서식('@') */
const CL_LOG = {
  HEADER: ['시각', '실행ID', '모드', '시트', '행', '키', '상태', '과목', '교육과정', '대단원(AI)', '키워드(AI)',
    '버린 키워드', '복수 대단원', 'confidence', '사유(AI)', '모델/effort', '입력자수', '그림/잘림/중복',
    '토큰 in/cacheR/cacheW/out', 'jangbu_id', '비고/오류', '대단원(사람)', '키워드(사람)', '대단원 일치', '키워드 겹침', 'Data_DS 행'],
  TIME: 1, RUN: 2, MODE: 3, SHEET: 4, ROW: 5, KEY: 6, STATUS: 7, SUBJ: 8, CURR: 9, UNIT: 10, TAGS: 11,
  DROPPED: 12, MULTI: 13, CONF: 14, REASON: 15, MODEL: 16, INCHARS: 17, FLAGS: 18, TOKENS: 19, JB: 20,
  NOTE: 21, H_UNIT: 22, H_TAGS: 23, M_UNIT: 24, M_OVL: 25, DSROW: 26,
};
const CL_PENDING = ['queued', 'submitted'];

/* =====================================================================
 * 1. 순수 함수 (시험 대상)
 * ===================================================================== */

function cl_nfc_(v) { return String(v === null || v === undefined ? '' : v).normalize('NFC'); }

/** 잠금 칸 값 → bool (Sets 와 같은 규칙) */
function cl_truthy_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== '0' && s !== 'n' && s !== 'no';
}

/**
 * 「형식변화」 `표` 2~16행 A:F → 대단원 표.
 *   { '2015': {list, bySubject, courseOf, subjectOf}, '2022': {...}, to15: {unit22: unit15}, errors: [] }
 *   검사: 15+15행 · 22 쪽 대단원·교과목은 모두 ` (22)` 로 끝남 · 15 쪽은 `(22)` 없음 · 이름 중복 없음
 */
function cl_unitsFromTable_(vals) {
  const mk = () => ({ list: [], bySubject: {}, courseOf: {}, subjectOf: {} });
  const u = { '2015': mk(), '2022': mk(), to15: {}, errors: [] };
  (vals || []).forEach((r, i) => {
    const c = (r || []).map(x => cl_nfc_(x).trim());
    if (!c.some(Boolean)) return;
    [['2015', c[0], c[1], c[2]], ['2022', c[3], c[4], c[5]]].forEach(([cur, unit, course, subj]) => {
      if (!unit || !course || !subj) { u.errors.push(`표 ${i + 2}행 ${cur} 빈칸`); return; }
      const t = u[cur];
      if (t.courseOf[unit]) { u.errors.push(`표 ${cur} 대단원 중복: ${unit}`); return; }
      t.list.push(unit); (t.bySubject[subj] = t.bySubject[subj] || []).push(unit);
      t.courseOf[unit] = course; t.subjectOf[unit] = subj;
    });
    if (c[0] && c[3]) u.to15[c[3]] = c[0];
  });
  ['2015', '2022'].forEach(cur => { if (u[cur].list.length !== 15) u.errors.push(`표 ${cur} 대단원이 15개가 아님: ${u[cur].list.length}`); });
  u['2022'].list.forEach(x => { if (!/ \(22\)$/.test(x) || !/ \(22\)$/.test(u['2022'].courseOf[x])) u.errors.push(`22 쪽 꼬리표 없음: ${x}`); });
  u['2015'].list.forEach(x => { if (/\(22\)/.test(x) || /\(22\)/.test(u['2015'].courseOf[x])) u.errors.push(`15 쪽에 (22): ${x}`); });
  if (!(u['2022'].bySubject['0 통합'] || []).length) u.errors.push('22 쪽 과목 `0 통합` 행이 없음');
  return u;
}

/** 교육과정 → enum 표('2022' | '2015'). 2009·2007 등 옛 교육과정 기출은 가장 가까운 2015 표로 분류한다. 모르면 '' */
function cl_tableOf_(curr) {
  const c = String(curr || '').trim();
  if (c === '2022') return '2022';
  if (/^(2015|2009|2007|7차)$/.test(c)) return '2015';
  return '';
}

/**
 * 키 + Sets 정보(sets_forKey_ 결과) + 문제 OCR → 분류 입력.
 *   { ok, code, num, subj(과목 이름 | ''), curr(문항 교육과정), table('2022'|'2015'|''), source, srcFail, printed, note }
 */
function cl_resolveItem_(key, sk, problem) {
  const kc = ds_keyCode_(key);
  if (!kc) return { ok: false, note: '키 형식 아님' };
  const out = { ok: true, code: kc.code, num: kc.num, subj: '', curr: '', table: '', source: '', srcFail: false, printed: '', note: '' };
  const setsCurr = sk && sk.profile ? String(sk.profile['교육과정'] || '') : '';
  if (kc.digit === '0') { out.subj = CL.SUBJ_NAME['0통합']; out.curr = '2022'; }
  else if (kc.digit === '9') {
    out.curr = setsCurr;
    if (kc.subject === '기출') {
      const s = meta_parseSource_(problem);
      if (s.ok && s.curriculum) { out.source = s.source; out.curr = s.curriculum; }
      else { out.srcFail = true; out.note = '출처 못 읽음 → Sets 교육과정'; }
    }
  } else {
    out.subj = CL.SUBJ_NAME[kc.code] || '';
    out.curr = '2015';
    if (!out.subj) return { ok: false, note: `과목코드 모름: ${kc.code}` };
  }
  out.table = cl_tableOf_(out.curr);
  const nb = sk && sk.rec && sk.rec.numbering;
  if (nb && sk.code && nb[sk.code] && nb[sk.code].printed !== undefined) out.printed = String(nb[sk.code].printed);
  return out;
}

/** 허용 대단원 목록 */
function cl_allowed_(units, table, subj) {
  const t = units[table];
  if (!t) return [];
  return subj ? (t.bySubject[subj] || []) : t.list;
}

/** (22) 꼬리표 규칙(§2.6). 어기면 이유 문자열, 맞으면 '' */
function cl_check22_(subj, curr, unit, course) {
  const need = subj === '0 통합' || String(curr) === '2022';
  const has22 = s => / \(22\)$/.test(String(s || ''));
  if (need && !(has22(unit) && has22(course))) return `과목 ${subj || '-'}·교육과정 ${curr || '-'} 인데 (22) 꼬리표 없음: ${unit} / ${course}`;
  if (!need && (has22(unit) || has22(course))) return `과목 ${subj || '-'}·교육과정 ${curr || '-'} 인데 (22) 꼬리표 있음: ${unit} / ${course}`;
  return '';
}

/** 2028 범위(Meta N): 22 표는 과목 `0 통합` 단원이면 안 · 15 표는 11~33 이면 안(scope2028) */
function cl_scope2028_(units, table, unit) {
  if (table === '2022') return units['2022'].subjectOf[unit] === '0 통합' ? '안' : '밖';
  const n = parseInt(unit, 10);
  return n >= 11 && n <= 33 ? '안' : '밖';
}

/** 그룹(시스템 프롬프트·스키마 캐시 단위) 키 */
function cl_groupKey_(table, subj) { return `${table}|${subj || '*'}`; }

/** 사전 키워드 목록: 허용 단원(22 면 같은 행 15 단원으로 바꿔)과 겹치거나 단원 기록이 없는 키워드. 결정적 정렬 */
function cl_dictFor_(dict, units, table, subj) {
  const allowed = cl_allowed_(units, table, subj).map(u => (table === '2022' ? units.to15[u] : u)).filter(Boolean);
  return Object.keys(dict.unitsOf).filter(c => {
    const us = Object.keys(dict.unitsOf[c]);
    return us.length === 0 || us.some(u => allowed.indexOf(u) >= 0);
  }).sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 사전 시트 값(A 키워드, B 빈도, C 대단원들, D 정규형, E 사용) → { canonOf, unitsOf } — 장부 ai_loadDict_ 와 같은 규칙 */
function cl_dictFromRows_(vals) {
  const out = { canonOf: {}, unitsOf: {} };
  (vals || []).forEach(r => {
    const kw = cl_cleanKw_(r[0]); if (!kw) return;
    const use = (r[4] === '' || r[4] === null || r[4] === undefined) ? true : (r[4] === true || String(r[4]).toUpperCase() === 'TRUE');
    if (!use) return;
    const canon = cl_cleanKw_(r[3]) || kw;
    out.canonOf[cl_norm_(kw)] = canon;
    out.canonOf[cl_norm_(canon)] = canon;
    const us = out.unitsOf[canon] = out.unitsOf[canon] || {};
    String(r[2] || '').split(',').map(x => x.trim()).filter(Boolean).forEach(u => { us[u] = true; });
  });
  return out;
}

/** 과목·교육과정 그룹별 system 블록 (규칙+허용 대단원, 사전 — 사전 블록에 1시간 캐시) */
function cl_systemBlocks_(ctx, table, subj) {
  const key = cl_groupKey_(table, subj);
  if (ctx.systemCache[key]) return ctx.systemCache[key];
  const allowed = cl_allowed_(ctx.units, table, subj);
  const kws = cl_dictFor_(ctx.dict, ctx.units, table, subj);
  const rules =
`당신은 한국 수능·모의고사 수학 문항을 교육과정 대단원과 핵심 개념 태그로 분류하는 전문가다.
입력으로 문제와 그 풀이(LaTeX 섞인 한국어)가 주어진다.

과제
(1) 이 문항이 속한 대단원 1개
(2) 풀이에 실제로 사용된 핵심 개념 키워드, 중요한 순서로 최대 ${CL.MAX_KEYWORDS}개

규칙
1. 대단원은 [허용 대단원] 목록의 문자열 중 하나를 숫자·띄어쓰기·괄호 꼬리표까지 글자 그대로 쓴다.
2. 판단 기준은 풀이에서 실제로 쓰인 개념이다. 문제의 소재나 겉모습보다 풀이 과정을 우선한다. 풀이가 비어 있으면 문제만으로 판단하고 confidence 를 낮춘다.
3. 둘 이상의 대단원 개념이 함께 쓰였으면 units_used 에 모두 적고, unit 에는 앞 두 자리 번호가 가장 큰 것을 적는다. (예: 13 수열과 22 미분이 함께 쓰이면 unit 은 22 미분)
4. 키워드는 [태그 사전]에 있는 문자열만 글자 그대로 쓴다. 사전에 없는 말을 새로 만들지 않는다. 적절한 것이 없으면 빈 배열로 둔다. 풀이의 핵심 발상을 담은 키워드를 앞에 둔다.
5. 풀이에 [그림] 표시가 있으면 그 자리에 있던 그림은 볼 수 없다. 본문 서술만으로 판단하고, 그림 없이 판단이 어려우면 confidence 를 낮춘다.
6. confidence 는 0~1 사이 실수. 대단원이 애매하거나 키워드가 사전과 잘 맞지 않으면 낮게 준다. reason 은 판정 근거 한 문장.
7. 경계 주의: 확률변수·확률분포(이산/연속, 이항분포, 정규분포)·통계적 추정은 "33 통계"다. "32 확률"은 사건의 확률(덧셈·곱셈정리, 조건부확률, 독립시행)까지다.
8. 교육과정: ${table === '2022' ? '2022 개정 교육과정 문항이다. 대단원 이름 끝의 (22)는 2022 개정 교육과정 표시다.' : '2015 개정 교육과정(또는 그 이전) 문항이다.'}

[허용 대단원]
${allowed.map(u => '- ' + u).join('\n')}`;
  const dict = `[태그 사전] (한 줄에 하나, 이 중에서만 고른다)\n${kws.join('\n')}`;
  const blocks = [{ type: 'text', text: rules }, { type: 'text', text: dict, cache_control: { type: 'ephemeral', ttl: CL.CACHE_TTL } }];
  ctx.systemCache[key] = blocks;
  return blocks;
}

function cl_schema_(ctx, table, subj) {
  const key = cl_groupKey_(table, subj);
  if (ctx.schemaCache[key]) return ctx.schemaCache[key];
  const allowed = cl_allowed_(ctx.units, table, subj);
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['unit', 'units_used', 'keywords', 'confidence', 'reason'],
    properties: {
      unit: { type: 'string', enum: allowed },
      units_used: { type: 'array', items: { type: 'string', enum: allowed } },
      keywords: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
  };
  ctx.schemaCache[key] = schema;
  return schema;
}

/** user 메시지: 그림 마크다운 → [그림], 길이 제한. {text, flags, inChars} */
function cl_userText_(it, src) {
  const figRe = /!\[[^\]]*\]\([^)]*\)/g, figTest = /!\[[^\]]*\]\([^)]*\)/;
  const p0 = String(src.problem || ''), s0 = String(src.solution || '');
  const hasFigure = figTest.test(p0) || figTest.test(s0);
  const p = cl_truncate_(p0.replace(figRe, '[그림]'), CL.MAX_PROBLEM_CHARS), s = cl_truncate_(s0.replace(figRe, '[그림]'), CL.MAX_SOLUTION_CHARS);
  const flags = [hasFigure ? '그림' : '', (p.truncated || s.truncated) ? '잘림' : '', !s0.trim() ? '해설없음' : ''].filter(Boolean).join('/');
  const subjLabel = it.subj || `문제집(${it.table === '2022' ? '2022' : '2015'} 전체)`;
  const text = `[문항] ${it.key}  (과목: ${subjLabel}, 번호: ${Number.isFinite(it.num) ? it.num : '?'})\n\n[문제]\n${p.text}\n\n[풀이]\n${s.text}`;
  return { text, flags, inChars: p0.length + s0.length };
}

function cl_params_(ctx, it, userText) {
  return {
    model: CL.MODEL,
    max_tokens: CL.MAX_TOKENS,
    output_config: { effort: ctx.effort || CL.EFFORT, format: { type: 'json_schema', schema: cl_schema_(ctx, it.table, it.subj) } },
    system: cl_systemBlocks_(ctx, it.table, it.subj),
    messages: [{ role: 'user', content: userText }],
  };
}

/** custom_id: 영문·숫자만(배치 규칙) — Meta 행은 M<행>, 파일럿(Data_DS 행)은 P<행> */
function cl_customId_(it) { return (it.sheet === CL.DS_SHEET ? 'P' : 'M') + it.row; }

/** Messages 응답 → {unit, unitsUsed, keywords, confidence, reason, tokens} | {error, raw, tokens} — 장부 v4 와 같다 */
function cl_parseMessage_(msg) {
  const u = (msg && msg.usage) || {};
  const tokens = `${u.input_tokens || 0}/${u.cache_read_input_tokens || 0}/${u.cache_creation_input_tokens || 0}/${u.output_tokens || 0}`;
  const stop = msg && msg.stop_reason;
  if (stop === 'refusal') return { error: 'refused', raw: (msg.stop_details && (msg.stop_details.category || msg.stop_details.reason)) || '', tokens };
  if (stop === 'max_tokens') return { error: 'max_tokens', raw: 'thinking+출력이 max_tokens 초과', tokens };
  const text = ((msg && msg.content) || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  if (!text) return { error: 'parse_error', raw: `stop=${stop}, 텍스트 없음`, tokens };
  try {
    const o = JSON.parse(text);
    return {
      unit: String(o.unit || '').trim(),
      unitsUsed: Array.isArray(o.units_used) ? o.units_used.map(String) : [],
      keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : [],
      confidence: Number(o.confidence), reason: String(o.reason || '').slice(0, 300), tokens,
    };
  } catch (e) { return { error: 'parse_error', raw: text.slice(0, 200), tokens }; }
}

/**
 * 검증·확정. it = {subj, curr, table, srcFail}, human = {unit, tags}(파일럿 비교용)
 * 반환 {status, unit, course, tags, dropped, multi, conf, reason, tokens, note, scope, write:bool, match}
 */
function cl_finalize_(ctx, mode, it, res, human) {
  const out = { status: 'api_error', unit: '', course: '', tags: '', dropped: '', multi: '', conf: '', reason: '', tokens: (res && res.tokens) || '', note: '', scope: '', write: false, match: null };
  if (!res || res.error) {
    const e = res ? res.error : 'no_result';
    out.status = (e === 'refused' || e === 'max_tokens' || e === 'parse_error') ? e : 'api_error';
    out.note = `${e}${res && res.raw ? ': ' + String(res.raw).slice(0, 200) : ''}`;
    return out;
  }
  out.conf = Number.isFinite(res.confidence) ? Math.round(Math.min(1, Math.max(0, res.confidence)) * 100) / 100 : '';
  out.reason = res.reason;
  const t = ctx.units[it.table];
  const allowed = cl_allowed_(ctx.units, it.table, it.subj);
  const fix = u => { const n = cl_norm_(u); return t.list.find(x => cl_norm_(x) === n) || ''; };
  const cands = [];
  res.unitsUsed.map(fix).forEach(u => { if (u && allowed.indexOf(u) >= 0 && cands.indexOf(u) < 0) cands.push(u); });
  const single = fix(res.unit);
  if (single && allowed.indexOf(single) >= 0 && cands.indexOf(single) < 0) cands.push(single);
  if (!cands.length) {
    out.status = 'unit_invalid';
    out.note = `AI unit="${res.unit}" units_used=${JSON.stringify(res.unitsUsed)} 허용=${it.table}/${it.subj || '전체'}`;
    return out;
  }
  const unit = cands.reduce((a, b) => (parseInt(b, 10) > parseInt(a, 10) ? b : a));
  out.unit = unit; out.course = t.courseOf[unit] || '';
  out.multi = cands.length > 1 ? cands.join(' | ') : '';
  out.scope = cl_scope2028_(ctx.units, it.table, unit);
  const notes = [];
  if (single && single !== unit) notes.push(`AI unit ${single}→규칙 ${unit}`);

  const kept = [], dropped = [];
  res.keywords.forEach(k => {
    const c = ctx.dict.canonOf[cl_norm_(k)];
    if (c) { if (kept.indexOf(c) < 0) kept.push(c); } else { const ck = cl_cleanKw_(k); if (ck) dropped.push(ck); }
  });
  const tags = kept.slice(0, CL.MAX_KEYWORDS);
  out.tags = tags.join(', ');
  out.dropped = dropped.join(', ');

  const hUnit = String((human && human.unit) || '').trim(), hTags = String((human && human.tags) || '').trim();
  if (hUnit || hTags) {
    const hk = hTags.split(',').map(cl_cleanKw_).filter(Boolean).map(cl_norm_);
    out.match = { unit: hUnit === unit ? 1 : 0, overlap: tags.filter(x => hk.indexOf(cl_norm_(x)) >= 0).length, humanN: hk.length };
  }
  const viol = cl_check22_(it.subj, it.curr, unit, out.course);
  if (viol) { out.status = 'rule_violation'; out.note = cl_join_([notes.join('; '), viol]); return out; }
  if (mode === 'pilot') { out.status = 'pilot'; out.note = notes.join('; '); return out; }

  const low = out.conf !== '' && out.conf < CL.REVIEW_BELOW;
  const review = low || cands.length > 1 || !tags.length || dropped.length > 0 || it.srcFail;
  out.write = true;
  out.status = review ? 'review' : 'ok';
  if (low) notes.push(`conf<${CL.REVIEW_BELOW}`);
  if (cands.length > 1) notes.push('복수 대단원');
  if (!tags.length) notes.push('키워드 없음');
  if (dropped.length) notes.push('버린 키워드 있음');
  if (it.srcFail) notes.push('출처 못 읽음');
  out.note = notes.join('; ');
  return out;
}

/** Meta 행 값(A~P)을 새로 만들거나 갱신 — 파생 칸(B·C·D·E·O)만. 분류 칸(F~L·N)·잠금(M)은 그대로 */
function cl_metaRowFor_(cur, key, jb, it, now) {
  const r = (cur && cur.length) ? cur.slice() : new Array(META.HEAD.length).fill('');
  while (r.length < META.HEAD.length) r.push('');
  const M = CL.MCOL;
  r[M.key - 1] = key;
  r[M.jb - 1] = jb || r[M.jb - 1] || '';
  r[M.subj - 1] = it.subj || '';
  r[M.curr - 1] = it.curr || '';
  r[M.src - 1] = it.source || '';
  r[M.printed - 1] = it.printed || r[M.printed - 1] || '';
  if (!String(r[M.unit - 1] || '').trim() && !String(r[M.status - 1] || '').trim()) r[M.status - 1] = CL.ST_WAIT;
  r[M.at - 1] = now;
  return r;
}

function cl_cleanKw_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f​﻿]/g, '').replace(/\s+/g, ' ').trim();
}
function cl_norm_(v) { return cl_cleanKw_(v).replace(/\s+/g, '').toLowerCase(); }
function cl_truncate_(s, max) {
  s = String(s || '');
  return s.length > max ? { text: s.slice(0, max) + '\n…(이하 생략)', truncated: true } : { text: s, truncated: false };
}
function cl_join_(arr) { return arr.map(x => String(x || '')).filter(Boolean).join('; '); }
function cl_clusters_(rows, gap) {
  const r = Array.from(new Set(rows.map(Number).filter(n => Number.isFinite(n) && n > 0))).sort((a, b) => a - b);
  const out = [];
  r.forEach(n => {
    const c = out[out.length - 1];
    if (c && n - (c.start + c.len - 1) <= gap) c.len = n - c.start + 1; else out.push({ start: n, len: 1 });
  });
  return out;
}

/* =====================================================================
 * 2. 컨텍스트·대상
 * ===================================================================== */

function cl_loadUnits_() {
  const vals = SpreadsheetApp.openById(CL.FORMAT_SS_ID).getSheetByName(CL.UNITS_SHEET).getRange(2, 1, 15, 6).getValues();
  return cl_unitsFromTable_(vals);
}
function cl_loadDict_() {
  const sh = SpreadsheetApp.openById(CL.LEDGER_ID).getSheetByName(CL.DICT_SHEET);
  if (!sh || sh.getLastRow() < 2) return { canonOf: {}, unitsOf: {} };
  return cl_dictFromRows_(sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues());
}
/** 단원 표 오류가 있으면 throw (분류 전 멈춤) */
function cl_loadContext_(effort) {
  const units = cl_loadUnits_();
  if (units.errors.length) throw new Error('「형식변화」 표 검사 실패: ' + units.errors.slice(0, 5).join(' · '));
  const dict = cl_loadDict_();
  if (!Object.keys(dict.unitsOf).length) throw new Error(`장부 '${CL.DICT_SHEET}' 사전이 비어 있음`);
  return { units, dict, effort: effort || CL.EFFORT, systemCache: {}, schemaCache: {} };
}

function cl_metaSheet_(ss) {
  let sh = ss.getSheetByName(META.SHEET);
  if (!sh) {
    sh = ss.insertSheet(META.SHEET);
    sh.getRange(1, 1, 1, META.HEAD.length).setValues([META.HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Data_DS 의 A(키)·L(jangbu_id) → { keys:[], jb:[], lastRowOfKey:{key→row} } */
function cl_readDsIndex_(ss) {
  const sh = ss.getSheetByName(CL.DS_SHEET);
  const last = sh.getLastRow();
  const out = { keys: [], jb: [], lastRowOfKey: {}, rowOfJb: {} };
  if (last < 2) return out;
  const a = sh.getRange(2, CL.DS_COL.KEY, last - 1, 1).getValues();
  const l = sh.getRange(2, CL.DS_COL.JANGBU, last - 1, 1).getValues();
  for (let i = 0; i < a.length; i++) {
    const k = cl_nfc_(a[i][0]).trim(), j = String(l[i][0] || '').trim();
    out.keys.push(k); out.jb.push(j);
    if (k) out.lastRowOfKey[k] = i + 2;
    if (j) out.rowOfJb[j] = i + 2;
  }
  return out;
}

/** 필요한 Data_DS 행의 B(문제)·C(풀이) → dsRow → {problem, solution} */
function cl_loadDsText_(ss, dsRows) {
  const sh = ss.getSheetByName(CL.DS_SHEET);
  const out = {};
  cl_clusters_(dsRows, 100).forEach(cl => {
    const vals = sh.getRange(cl.start, CL.DS_COL.PROBLEM, cl.len, 2).getValues();
    vals.forEach((r, k) => { out[cl.start + k] = { problem: String(r[0] || ''), solution: String(r[1] || '') }; });
  });
  return out;
}

/** 키워드(세트명 일부, 러너 런 키워드와 같은 규칙: 키에 들어 있으면) → 키 목록(중복 없이, Data_DS 순서) */
function cl_keysForKeywords_(ds, keywords) {
  const kws = (keywords || []).map(k => cl_nfc_(k).trim().toLowerCase()).filter(Boolean);
  const seen = {}, out = [];
  ds.keys.forEach(k => {
    if (!k || seen[k]) return;
    const lk = k.toLowerCase();
    if (kws.some(w => lk.indexOf(w) !== -1)) { seen[k] = true; out.push(k); }
  });
  return out;
}

/**
 * 키 목록 → Meta 행을 만들거나 파생 칸을 갱신(잠금 행은 그대로). 반환 { rowOfKey, created, updated, locked, bad:[{key, note}] }
 * 분류 대상 판단은 cl_pickTargets_ 가 한다.
 */
function cl_upsertMeta_(ss, ds, keys) {
  const sh = cl_metaSheet_(ss);
  const last = sh.getLastRow();
  const W = META.HEAD.length;
  const cur = last >= 2 ? sh.getRange(2, 1, last - 1, W).getValues() : [];
  const rowOfKey = {};
  cur.forEach((r, i) => { const k = cl_nfc_(r[0]).trim(); if (k) rowOfKey[k] = i + 2; });
  const setsMap = (typeof sets_readAll_ === 'function') ? (sets_readAll_(ss).byName || {}) : {};
  const dsText = cl_loadDsText_(ss, keys.map(k => ds.lastRowOfKey[k]).filter(Boolean));
  const now = cl_now_();
  const res = { rowOfKey, created: 0, updated: 0, locked: 0, bad: [], items: {} };
  const updates = {}, appends = [];
  keys.forEach(key => {
    const dsRow = ds.lastRowOfKey[key];
    if (!dsRow) { res.bad.push({ key, note: 'Data_DS 에 없음' }); return; }
    const sk = (typeof sets_forKey_ === 'function') ? sets_forKey_(setsMap, key) : null;
    const it = cl_resolveItem_(key, sk, (dsText[dsRow] || {}).problem);
    if (!it.ok) { res.bad.push({ key, note: it.note }); return; }
    res.items[key] = Object.assign({ key, dsRow, jb: ds.jb[dsRow - 2] || '' }, it);
    const row = rowOfKey[key];
    if (row) {
      const r = cur[row - 2];
      if (cl_truthy_(r[CL.MCOL.lock - 1])) { res.locked++; return; }
      updates[row] = cl_metaRowFor_(r, key, res.items[key].jb, it, now);
      res.updated++;
    } else {
      appends.push(cl_metaRowFor_(null, key, res.items[key].jb, it, now));
    }
  });
  Object.keys(updates).map(Number).sort((a, b) => a - b).forEach(row => sh.getRange(row, 1, 1, W).setValues([updates[row]]));
  if (appends.length) {
    const start = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(start, 1, appends.length, W).setValues(appends);
    appends.forEach((r, i) => { rowOfKey[r[0]] = start + i; });
    res.created = appends.length;
  }
  return res;
}

/** Classify_Log 에서 영구 보류 상태의 키 집합 (강제 아님일 때) */
function cl_loadSkipSet_(ss) {
  const sh = ss.getSheetByName(CL.LOG_SHEET);
  const set = {};
  if (!sh || sh.getLastRow() < 2) return set;
  sh.getRange(2, 1, sh.getLastRow() - 1, CL_LOG.STATUS).getValues().forEach(r => {
    if (String(r[CL_LOG.MODE - 1]) === 'pilot') return;
    const k = cl_nfc_(r[CL_LOG.KEY - 1]).trim(); if (!k) return;
    const st = String(r[CL_LOG.STATUS - 1]);
    if (CL.SKIP_STATUSES.indexOf(st) >= 0) set[k] = st;
    else if (st === 'ok' || st === 'review' || st === 'undone') delete set[k];
  });
  return set;
}

/**
 * 분류 대상 고르기: Meta 행 중 G(대단원) 빈칸 · 잠금 아님 · (강제 아니면) 영구 보류 아님 · 교육과정 표를 정할 수 있음
 * 반환 { items, skipped, filled, locked, hold:[it] }
 */
function cl_pickTargets_(ss, up, force) {
  const sh = cl_metaSheet_(ss);
  const skip = force ? {} : cl_loadSkipSet_(ss);
  const out = { items: [], skipped: 0, filled: 0, locked: 0, hold: [] };
  const keys = Object.keys(up.items);
  const rows = keys.map(k => up.rowOfKey[k]).filter(Boolean);
  const vals = {};
  cl_clusters_(rows, 1).forEach(cl => {
    sh.getRange(cl.start, 1, cl.len, META.HEAD.length).getValues().forEach((r, i) => { vals[cl.start + i] = r; });
  });
  keys.forEach(k => {
    const row = up.rowOfKey[k], r = vals[row];
    if (!r) return;
    if (cl_truthy_(r[CL.MCOL.lock - 1])) { out.locked++; return; }
    if (String(r[CL.MCOL.unit - 1] || '').trim()) { out.filled++; return; }
    if (skip[k]) { out.skipped++; return; }
    const it = Object.assign({ sheet: META.SHEET, row }, up.items[k]);
    if (!it.table) { out.hold.push(it); return; }
    out.items.push(it);
  });
  return out;
}

/* =====================================================================
 * 3. 제출 코어 (메뉴·원격 공용, UI 없음)
 * ===================================================================== */

/**
 * opts = { mode:'tag'|'pilot', keys?:[], keywords?:[], pilotRunId?, effort?, force?, by? }
 * 반환 { ok, reason?, runId?, submitted, warmN, queuedN, created, updated, filled, locked, skipped, hold, bad, busy? }
 */
function cl_submitCore_(opts) {
  const ss = SpreadsheetApp.getActive();
  const mode = opts.mode || 'tag';
  const effort = String(opts.effort || CL.EFFORT).toLowerCase();
  if (CL.EFFORT_LEVELS.indexOf(effort) < 0) return { ok: false, reason: `effort 는 ${CL.EFFORT_LEVELS.join(', ')} 중 하나` };
  const ds = cl_readDsIndex_(ss);
  let items = [], info = { created: 0, updated: 0, filled: 0, locked: 0, skipped: 0, hold: 0, bad: [] }, holdItems = [];

  if (mode === 'pilot') {
    const pr = cl_pilotItems_(ss, ds, opts.pilotRunId || CL.PILOT_RUN_DEFAULT);
    if (!pr.ok) return pr;
    items = pr.items; info.bad = pr.bad;
  } else {
    const keys = opts.keys ? opts.keys.map(k => cl_nfc_(k).trim()).filter(Boolean) : cl_keysForKeywords_(ds, opts.keywords);
    if (!keys.length) return { ok: false, reason: '대상 키가 없습니다(Data_DS 에서 못 찾음).' };
    const up = cl_upsertMeta_(ss, ds, keys);
    const pk = cl_pickTargets_(ss, up, !!opts.force);
    items = pk.items; holdItems = pk.hold;
    info = { created: up.created, updated: up.updated, filled: pk.filled, locked: pk.locked + up.locked, skipped: pk.skipped, hold: pk.hold.length, bad: up.bad };
  }
  const base = Object.assign({ ok: true, submitted: 0, warmN: 0, queuedN: 0 }, info, { bad: info.bad.slice(0, 20), badN: info.bad.length });
  if (cl_loadState_()) return Object.assign(base, { busy: true, reason: '진행 중인 분류 작업이 있습니다 — Meta 행은 만들었고(상태 대기), 끝난 뒤 "대기 행 분류"로 제출하세요.' });
  if (!cl_apiKey_()) return Object.assign(base, { ok: false, reason: 'API 키가 없습니다 — 「Latex 변환」 메뉴 "분류(Meta) · API 키 저장"(이 프로젝트, 내 계정). Meta 행은 만들었습니다(상태 대기).' });

  const runId = cl_runId_(mode);
  const logSh = cl_getLogSheet_(ss);
  if (!items.length) {
    if (holdItems.length) cl_appendLog_(logSh, holdItems.map(it => cl_logRow_(runId, mode, it, 'hold_curr', '교육과정을 정할 수 없음(Sets·출처 없음)', effort)));
    return Object.assign(base, { runId: holdItems.length ? runId : '', reason: '제출할 행이 없습니다.' });
  }
  const ctx = cl_loadContext_(effort);

  // 예열: 그룹(교육과정·과목)별 첫 행 1건. 대상이 그룹 수 이하면 예열 없이 전부 본 배치
  let warm = [], queued = items;
  if (CL.WARM_FIRST) {
    const seen = {};
    items.forEach(it => { const g = cl_groupKey_(it.table, it.subj); if (!seen[g]) { seen[g] = true; warm.push(it); } });
    if (warm.length < items.length) queued = items.filter(it => warm.indexOf(it) < 0); else { warm = []; queued = items; }
  }
  const first = warm.length ? warm : queued;
  const requests = cl_buildRequests_(ss, ctx, first);
  const batches = cl_submitBatches_(requests, warm.length ? 'warm' : 'main');   // 실패면 throw(만든 배치는 취소됨)
  try {
    const logStart = logSh.getLastRow() + 1;
    const rows = [];
    holdItems.forEach(it => rows.push(cl_logRow_(runId, mode, it, 'hold_curr', '교육과정을 정할 수 없음(Sets·출처 없음)', effort)));
    first.forEach(it => rows.push(cl_logRow_(runId, mode, it, 'submitted', '', effort)));
    if (warm.length) queued.forEach(it => rows.push(cl_logRow_(runId, mode, it, 'queued', '', effort)));
    logSh.getRange(logStart, 1, rows.length, CL_LOG.HEADER.length).setValues(rows);
    const state = {
      runId, mode, force: !!opts.force, model: CL.MODEL, effort, by: opts.by || '',
      phase: warm.length ? 'warm' : 'main', startedAt: cl_now_(), batches,
      total: items.length, warmN: first.length, queuedN: warm.length ? queued.length : 0,
      logStart, logCount: rows.length, counts: { ok: 0, review: 0, fail: 0 }, polls: 0, errors: 0, stopping: false,
      promptFp: cl_promptFp_(ctx),
    };
    cl_saveState_(state);
    cl_deleteTriggers_();
    ScriptApp.newTrigger(CL.POLL_FN).timeBased().after(warm.length ? CL.POLL_FIRST_MS : CL.POLL_MS).create();
  } catch (e) {
    batches.forEach(b => { try { cl_apiFetch_(`/messages/batches/${b.id}/cancel`, 'post', {}); } catch (e2) {} });
    PropertiesService.getScriptProperties().deleteProperty(CL.PROP_STATE);
    return Object.assign(base, { ok: false, reason: `배치는 만들었지만 로그/상태 저장에 실패해 취소했습니다: ${e.message}` });
  }
  return Object.assign(base, { runId, submitted: items.length, warmN: warm.length, queuedN: warm.length ? queued.length : 0,
    batches: batches.map(b => `${b.id}(${b.n})`) });
}

/** 파일럿: 장부 _AI판정로그 의 파일럿 실행 행(사람 L·M) → Data_DS 행 기준 item (Meta 에 쓰지 않음) */
function cl_pilotItems_(ss, ds, runId) {
  const log = SpreadsheetApp.openById(CL.LEDGER_ID).getSheetByName(CL.LEDGER_LOG);
  if (!log || log.getLastRow() < 2) return { ok: false, reason: '장부 _AI판정로그 없음' };
  const vals = log.getRange(2, 1, log.getLastRow() - 1, 23).getValues();   // A~W (V 대단원(사람), W 키워드(사람))
  const setsMap = (typeof sets_readAll_ === 'function') ? (sets_readAll_(ss).byName || {}) : {};
  const items = [], bad = [];
  const rows = vals.filter(r => String(r[1]) === runId && String(r[6]) === 'pilot');
  if (!rows.length) return { ok: false, reason: `장부 로그에 파일럿 실행 ${runId} 행이 없음` };
  const dsRows = rows.map(r => ds.rowOfJb[String(r[5]).trim()]).filter(Boolean);
  const text = cl_loadDsText_(ss, dsRows);
  rows.forEach(r => {
    const jb = String(r[5]).trim(), dsRow = ds.rowOfJb[jb];
    if (!dsRow) { bad.push({ key: jb, note: 'Data_DS L 에 없음' }); return; }
    const key = ds.keys[dsRow - 2];
    const sk = (typeof sets_forKey_ === 'function') ? sets_forKey_(setsMap, key) : null;
    const it = cl_resolveItem_(key, sk, (text[dsRow] || {}).problem);
    if (!it.ok || !it.table) { bad.push({ key, note: it.note || '교육과정 모름' }); return; }
    items.push(Object.assign({ sheet: CL.DS_SHEET, row: dsRow, key, dsRow, jb, unitHuman: String(r[21] || '').trim(), tagHuman: String(r[22] || '').trim() }, it));
  });
  return { ok: true, items, bad };
}

/** items → 배치 요청. it.flags/inChars 채움 */
function cl_buildRequests_(ss, ctx, items) {
  const text = cl_loadDsText_(ss, items.map(it => it.dsRow));
  return items.map(it => {
    const u = cl_userText_(it, text[it.dsRow] || { problem: '', solution: '' });
    it.flags = u.flags; it.inChars = u.inChars;
    return { custom_id: cl_customId_(it), params: cl_params_(ctx, it, u.text) };
  });
}

function cl_submitBatches_(requests, kind) {
  const batches = [];
  let chunk = [], bytes = 0;
  const flush = () => {
    if (!chunk.length) return;
    const r = cl_apiFetch_('/messages/batches', 'post', { requests: chunk }, { createOnly: true });
    if (!r.json || !r.json.id) throw new Error(`배치 제출 실패 (${r.code}): ${String(r.body || '').slice(0, 300)}`);
    batches.push({ id: r.json.id, n: chunk.length, kind, done: false });
    chunk = []; bytes = 0;
  };
  try {
    requests.forEach(q => {
      const len = JSON.stringify(q).length;
      if (chunk.length >= CL.BATCH_MAX || bytes + len > CL.BATCH_MAX_BYTES) flush();
      chunk.push(q); bytes += len;
    });
    flush();
  } catch (e) {
    batches.forEach(b => { try { cl_apiFetch_(`/messages/batches/${b.id}/cancel`, 'post', {}); } catch (e2) {} });
    throw e;
  }
  return batches;
}

/* =====================================================================
 * 4. 수거 (트리거 핸들러)  반환 'done' | 'ongoing' | 'busy' | 'error' | 'none'
 * ===================================================================== */

function cl_batchPoll() {
  cl_deleteTriggers_();
  const state = cl_loadState_();
  if (!state) return 'none';
  const ss = SpreadsheetApp.getActive();
  if (!cl_acquireLease_()) {
    ScriptApp.newTrigger(CL.POLL_FN).timeBased().after(CL.LEASE_RETRY_MS).create();
    return 'busy';
  }
  try {
    state.polls++;
    const logSh = cl_getLogSheet_(ss);
    let ctx = null, block = null;
    for (const b of state.batches) {
      if (b.done) continue;
      const r = cl_apiFetch_(`/messages/batches/${b.id}`, 'get', null);
      if (!r.json) throw new Error(`배치 상태 조회 실패 ${b.id} (${r.code})`);
      if (r.json.processing_status !== 'ended') continue;
      const jr = cl_apiFetch_(r.json.results_url, 'get', null, { raw: true });
      if (jr.code !== 200) throw new Error(`결과 다운로드 실패 ${b.id} (${jr.code})`);
      const lines = String(jr.body || '').split('\n').map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
      if (!ctx) { ctx = cl_loadContext_(state.effort); block = cl_readLogBlock_(logSh, state); }
      cl_processResults_(ss, state, ctx, block, lines);
      b.done = true;
      cl_writeLogBlock_(block);
      cl_recount_(state, block);
      if (!cl_stateAlive_(state.runId)) return 'done';
      cl_saveState_(state);
    }
    if (state.phase === 'warm' && !state.stopping && state.batches.every(b => b.done)) {
      if (!block) block = cl_readLogBlock_(logSh, state);
      cl_submitMain_(ss, state, block);
      cl_writeLogBlock_(block);
      state.phase = 'main';
      if (!cl_stateAlive_(state.runId)) return 'done';
      cl_saveState_(state);
    }
    state.errors = 0;
    const remaining = state.batches.filter(b => !b.done).length;
    if (remaining) {
      if (!cl_stateAlive_(state.runId)) return 'done';
      cl_saveState_(state);
      ScriptApp.newTrigger(CL.POLL_FN).timeBased().after(CL.POLL_MS).create();
      return 'ongoing';
    }
    if (!block) block = cl_readLogBlock_(logSh, state);
    cl_finishSummary_(ss, state, block);
    PropertiesService.getScriptProperties().deleteProperty(CL.PROP_STATE);
    return 'done';
  } catch (e) {
    Logger.log('분류 수거 오류: ' + (e && e.stack || e));
    if (!cl_stateAlive_(state.runId)) return 'done';
    state.errors = (state.errors || 0) + 1;
    state.lastError = String(e.message || e).slice(0, 200);
    cl_saveState_(state);
    if (state.errors < CL.MAX_POLL_ERRORS) ScriptApp.newTrigger(CL.POLL_FN).timeBased().after(CL.POLL_MS).create();
    return 'error';
  } finally {
    cl_releaseLease_();
  }
}

/** 예열 뒤 본 배치: 'queued' 행을 그 시점 Meta 값으로 다시 확인(사람이 G 를 적었거나 잠갔으면 건너뜀)해 제출 */
function cl_submitMain_(ss, state, block) {
  const idx = [];
  block.rows.forEach((r, i) => { if (r[CL_LOG.STATUS - 1] === 'queued') idx.push(i); });
  if (!idx.length) return [];
  const ctx = cl_loadContext_(state.effort);
  const ds = cl_readDsIndex_(ss);
  const setsMap = (typeof sets_readAll_ === 'function') ? (sets_readAll_(ss).byName || {}) : {};
  const meta = state.mode === 'pilot' ? null : cl_metaSheet_(ss);
  const metaCache = {};
  const items = [];
  const text = cl_loadDsText_(ss, idx.map(i => ds.lastRowOfKey[cl_nfc_(block.rows[i][CL_LOG.KEY - 1]).trim()]).filter(Boolean));
  idx.forEach(i => {
    const lr = block.rows[i];
    const key = cl_nfc_(lr[CL_LOG.KEY - 1]).trim();
    lr[CL_LOG.TIME - 1] = cl_now_();
    const dsRow = state.mode === 'pilot' ? Number(lr[CL_LOG.DSROW - 1]) : ds.lastRowOfKey[key];
    if (!dsRow) { lr[CL_LOG.STATUS - 1] = 'no_source'; lr[CL_LOG.NOTE - 1] = '제출 시점에 Data_DS 에서 사라짐'; return; }
    let row = Number(lr[CL_LOG.ROW - 1]);
    if (meta) {
      const f = cl_findMetaRow_(meta, key, row, metaCache);
      if (!f.row) { lr[CL_LOG.STATUS - 1] = 'id_moved'; lr[CL_LOG.NOTE - 1] = f.note; return; }
      if (f.row !== row) { lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], `Meta 행 이동 ${row}→${f.row}`]); lr[CL_LOG.ROW - 1] = f.row; row = f.row; }
      if (f.locked) { lr[CL_LOG.STATUS - 1] = 'write_skipped'; lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], '잠금']); return; }
      if (f.unit) { lr[CL_LOG.STATUS - 1] = 'write_skipped'; lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], `사람이 먼저 적음: G="${f.unit}"`]); return; }
    }
    const sk = (typeof sets_forKey_ === 'function') ? sets_forKey_(setsMap, key) : null;
    const it = cl_resolveItem_(key, sk, (text[dsRow] || {}).problem);
    if (!it.ok || !it.table) { lr[CL_LOG.STATUS - 1] = 'hold_curr'; lr[CL_LOG.NOTE - 1] = it.note || '교육과정 모름'; return; }
    items.push(Object.assign({ sheet: meta ? META.SHEET : CL.DS_SHEET, row, key, dsRow, jb: lr[CL_LOG.JB - 1], logIdx: i,
      unitHuman: lr[CL_LOG.H_UNIT - 1], tagHuman: lr[CL_LOG.H_TAGS - 1] }, it));
  });
  if (!items.length) return [];
  const requests = cl_buildRequests_(ss, ctx, items);
  const fpNow = cl_promptFp_(ctx), fpOld = state.promptFp || {};
  const changed = Object.keys(fpNow).filter(k => fpOld[k] !== undefined && fpOld[k] !== fpNow[k]);
  if (changed.length) state.cacheWarn = `예열 뒤 사전/대단원 표가 바뀜 (${changed.join(', ')}) → 본 배치는 캐시 미적중`;
  const batches = cl_submitBatches_(requests, 'main');
  items.forEach(it => {
    const lr = block.rows[it.logIdx];
    lr[CL_LOG.STATUS - 1] = 'submitted'; lr[CL_LOG.SUBJ - 1] = it.subj || ''; lr[CL_LOG.CURR - 1] = it.curr || '';
    lr[CL_LOG.INCHARS - 1] = it.inChars; lr[CL_LOG.FLAGS - 1] = it.flags || '';
  });
  batches.forEach(b => state.batches.push(b));
  return batches;
}

/** Meta 에서 키의 행 찾기: 기대 행에 그 키가 있으면 그 행, 아니면 A열 전체에서(중복이면 못 정함) */
function cl_findMetaRow_(sh, key, row, cache) {
  const W = META.HEAD.length;
  const look = r => { const v = sh.getRange(r, 1, 1, W).getValues()[0]; return { row: r, unit: String(v[CL.MCOL.unit - 1] || '').trim(), locked: cl_truthy_(v[CL.MCOL.lock - 1]), cur: v }; };
  if (row >= 2 && row <= sh.getLastRow() && cl_nfc_(sh.getRange(row, 1).getValue()).trim() === key) return look(row);
  if (!cache.colA) { const n = sh.getLastRow(); cache.colA = n >= 2 ? sh.getRange(2, 1, n - 1, 1).getValues().map(v => cl_nfc_(v[0]).trim()) : []; }
  const hits = []; cache.colA.forEach((v, i) => { if (v === key) hits.push(i + 2); });
  if (hits.length !== 1) return { row: 0, note: hits.length ? `Meta 에 ${key} 가 ${hits.length}개` : `Meta 에서 ${key} 를 찾지 못함` };
  return look(hits[0]);
}

/** 결과 JSONL 묶음 → 로그 블록 반영, tag 모드면 Meta 기록 */
function cl_processResults_(ss, state, ctx, block, lines) {
  const writes = [];
  lines.forEach(line => {
    const cid = String(line.custom_id || '');
    const m = cid.match(/^([MP])(\d+)$/);
    if (!m) { Logger.log('custom_id 해석 불가: ' + cid); return; }
    const i = block.index[`${m[1] === 'P' ? CL.DS_SHEET : META.SHEET}|${Number(m[2])}`];
    if (i === undefined) { Logger.log('로그 블록에 없는 결과: ' + cid); return; }
    const lr = block.rows[i];
    if (lr[CL_LOG.STATUS - 1] !== 'submitted') return;
    const it = { key: cl_nfc_(lr[CL_LOG.KEY - 1]).trim(), subj: String(lr[CL_LOG.SUBJ - 1] || ''), curr: String(lr[CL_LOG.CURR - 1] || ''),
      srcFail: /출처 못 읽음/.test(String(lr[CL_LOG.NOTE - 1] || '')) };
    it.table = cl_tableOf_(it.curr);
    const res = line.result || {};
    let fin;
    if (!it.table) fin = { status: 'hold_curr', note: '교육과정 모름' };
    else if (res.type === 'succeeded') fin = cl_finalize_(ctx, state.mode, it, cl_parseMessage_(res.message), { unit: lr[CL_LOG.H_UNIT - 1], tags: lr[CL_LOG.H_TAGS - 1] });
    else if (res.type === 'errored') {
      const err = res.error && res.error.error ? res.error.error : res.error || {};
      fin = { status: 'api_error', note: `${err.type || ''} ${String(err.message || '').slice(0, 200)}`.trim() };
    } else fin = { status: res.type === 'canceled' ? 'canceled' : res.type === 'expired' ? 'expired' : 'api_error', note: res.type || '' };
    cl_applyFinal_(lr, fin);
    if (state.mode === 'tag' && fin.write) writes.push({ lr, it, fin });
  });
  if (writes.length) cl_flushMeta_(ss, state, writes);
}

function cl_applyFinal_(lr, fin) {
  lr[CL_LOG.TIME - 1] = cl_now_();
  lr[CL_LOG.STATUS - 1] = fin.status;
  lr[CL_LOG.UNIT - 1] = fin.unit || '';
  lr[CL_LOG.TAGS - 1] = fin.tags || '';
  lr[CL_LOG.DROPPED - 1] = fin.dropped || '';
  lr[CL_LOG.MULTI - 1] = fin.multi || '';
  lr[CL_LOG.CONF - 1] = fin.conf === undefined ? '' : fin.conf;
  lr[CL_LOG.REASON - 1] = fin.reason || '';
  lr[CL_LOG.TOKENS - 1] = fin.tokens || '';
  lr[CL_LOG.NOTE - 1] = cl_join_([/출처 못 읽음/.test(String(lr[CL_LOG.NOTE - 1] || '')) && !/출처 못 읽음/.test(fin.note || '') ? '출처 못 읽음' : '', fin.note]);
  if (fin.match) { lr[CL_LOG.M_UNIT - 1] = fin.match.unit; lr[CL_LOG.M_OVL - 1] = `${fin.match.overlap}/${fin.match.humanN}`; }
}

/** Meta F~L·N·P 기록. 기록 직전 그 행을 다시 읽어 키·잠금·G 확인(사람 값 보호) */
function cl_flushMeta_(ss, state, writes) {
  const sh = cl_metaSheet_(ss);
  const cache = {};
  const M = CL.MCOL;
  writes.forEach(w => {
    const lr = w.lr;
    const f = cl_findMetaRow_(sh, w.it.key, Number(lr[CL_LOG.ROW - 1]), cache);
    if (!f.row) { lr[CL_LOG.STATUS - 1] = 'id_moved'; lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], f.note]); return; }
    if (f.locked) { lr[CL_LOG.STATUS - 1] = 'write_skipped'; lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], '잠금']); return; }
    if (f.unit) { lr[CL_LOG.STATUS - 1] = 'write_skipped'; lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], `사람이 먼저 적음: G="${f.unit}"`]); return; }
    if (f.row !== Number(lr[CL_LOG.ROW - 1])) { lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], `Meta 행 이동 ${lr[CL_LOG.ROW - 1]}→${f.row}`]); lr[CL_LOG.ROW - 1] = f.row; }
    const r = f.cur.slice();
    r[M.course - 1] = w.fin.course; r[M.unit - 1] = w.fin.unit; r[M.tags - 1] = w.fin.tags; r[M.multi - 1] = w.fin.multi;
    r[M.conf - 1] = w.fin.conf; r[M.status - 1] = w.fin.status; r[M.by - 1] = `AI ${state.model}/${state.effort} ${state.runId}`;
    r[M.scope - 1] = w.fin.scope; r[M.at - 1] = cl_now_();
    try { sh.getRange(f.row, M.course, 1, M.at - M.course + 1).setValues([r.slice(M.course - 1, M.at)]); }
    catch (e) { lr[CL_LOG.STATUS - 1] = 'write_error'; lr[CL_LOG.NOTE - 1] = cl_join_([lr[CL_LOG.NOTE - 1], String(e).slice(0, 200)]); }
  });
}

function cl_recount_(state, block) {
  const c = { ok: 0, review: 0, fail: 0 };
  block.rows.forEach(r => {
    const s = r[CL_LOG.STATUS - 1];
    if (s === 'ok' || s === 'pilot') c.ok++;
    else if (s === 'review') c.review++;
    else if (CL_PENDING.indexOf(s) < 0) c.fail++;
  });
  state.counts = c;
}

/* =====================================================================
 * 5. 로그 시트
 * ===================================================================== */

function cl_getLogSheet_(ss) {
  let sh = ss.getSheetByName(CL.LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CL.LOG_SHEET);
    sh.getRange(1, 1, 1, CL_LOG.HEADER.length).setValues([CL_LOG.HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const need = sh.getLastRow() + 2000;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(1, 1, sh.getMaxRows(), CL_LOG.HEADER.length).setNumberFormat('@');
  return sh;
}

function cl_logRow_(runId, mode, it, status, note, effort) {
  const r = new Array(CL_LOG.HEADER.length).fill('');
  r[CL_LOG.TIME - 1] = cl_now_(); r[CL_LOG.RUN - 1] = runId; r[CL_LOG.MODE - 1] = mode;
  r[CL_LOG.SHEET - 1] = it.sheet; r[CL_LOG.ROW - 1] = it.row; r[CL_LOG.KEY - 1] = it.key; r[CL_LOG.STATUS - 1] = status;
  r[CL_LOG.SUBJ - 1] = it.subj || ''; r[CL_LOG.CURR - 1] = it.curr || '';
  r[CL_LOG.MODEL - 1] = `${CL.MODEL}/${effort || CL.EFFORT}`;
  r[CL_LOG.INCHARS - 1] = it.inChars === undefined ? '' : it.inChars; r[CL_LOG.FLAGS - 1] = it.flags || '';
  r[CL_LOG.JB - 1] = it.jb || ''; r[CL_LOG.NOTE - 1] = cl_join_([it.srcFail ? '출처 못 읽음' : '', note]);
  r[CL_LOG.DSROW - 1] = it.dsRow || '';
  if (mode === 'pilot') { r[CL_LOG.H_UNIT - 1] = it.unitHuman || ''; r[CL_LOG.H_TAGS - 1] = it.tagHuman || ''; }
  return r;
}
function cl_appendLog_(sh, rows) { if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, CL_LOG.HEADER.length).setValues(rows); }

function cl_readLogBlock_(logSh, state) {
  const rows = logSh.getRange(state.logStart, 1, state.logCount, CL_LOG.HEADER.length).getValues();
  const bad = rows.findIndex(r => String(r[CL_LOG.RUN - 1]) !== state.runId);
  if (bad >= 0) throw new Error(`로그 구간이 어긋남: ${state.logStart + bad}행의 실행ID가 "${rows[bad][CL_LOG.RUN - 1]}" (기대 ${state.runId}). 로그 시트에 행을 넣거나 지우지 마세요.`);
  const index = {};
  rows.forEach((r, i) => { index[`${r[CL_LOG.SHEET - 1]}|${Number(r[CL_LOG.ROW - 1])}`] = i; });
  return { sh: logSh, start: state.logStart, rows, index };
}
function cl_writeLogBlock_(block) { block.sh.getRange(block.start, 1, block.rows.length, CL_LOG.HEADER.length).setValues(block.rows); }

/** 완료 요약(파일럿은 일치율). 로그 끝 summary 행 + ScriptProperties */
function cl_finishSummary_(ss, state, block) {
  const cnt = {};
  block.rows.forEach(r => { const s = r[CL_LOG.STATUS - 1]; cnt[s] = (cnt[s] || 0) + 1; });
  let s = `[${state.runId}] 모드 ${state.mode}, ${state.model}/${state.effort}\n대상 ${state.total}\n결과: ${Object.keys(cnt).sort().map(k => `${k} ${cnt[k]}`).join(', ')}`;
  let tin = 0, tcr = 0, tcw = 0, tout = 0;
  block.rows.forEach(r => { const m = String(r[CL_LOG.TOKENS - 1]).match(/^(\d+)\/(\d+)\/(\d+)\/(\d+)$/); if (m) { tin += +m[1]; tcr += +m[2]; tcw += +m[3]; tout += +m[4]; } });
  const usd = (tin * 4 + tcr * 0.2 + tcw * 8 + tout * 20) / 1e6 * 0.5;
  s += `\n토큰 in ${tin} / cacheR ${tcr} / cacheW ${tcw} / out ${tout} ≈ $${usd.toFixed(2)}`;
  if (state.cacheWarn) s += `\n⚠️ ${state.cacheWarn}`;
  if (state.mode === 'pilot') s += '\n' + cl_pilotStats_(block.rows);
  const row = new Array(CL_LOG.HEADER.length).fill('');
  row[CL_LOG.TIME - 1] = cl_now_(); row[CL_LOG.RUN - 1] = state.runId; row[CL_LOG.MODE - 1] = state.mode; row[CL_LOG.STATUS - 1] = 'summary';
  row[CL_LOG.NOTE - 1] = s.replace(/\n/g, ' | ');
  cl_appendLog_(cl_getLogSheet_(ss), [row]);
  PropertiesService.getScriptProperties().setProperty(CL.PROP_LAST, s);
  return s;
}

/** 파일럿 일치율 (과목: 표본 · 대단원 정확 · 키워드 겹침률 평균 · 1개 이상 겹침 · 그림 문항 대단원 정확) — 장부 v4 요약과 같은 꼴 */
function cl_pilotStats_(rows) {
  const by = {};
  rows.filter(r => r[CL_LOG.STATUS - 1] === 'pilot').forEach(r => {
    const subj = String(r[CL_LOG.SUBJ - 1] || '?');
    const b = by[subj] = by[subj] || { n: 0, unitOk: 0, ovl: 0, any: 0, fig: 0, figOk: 0 };
    b.n++; b.unitOk += Number(r[CL_LOG.M_UNIT - 1]) || 0;
    const mm = String(r[CL_LOG.M_OVL - 1]).match(/^(\d+)\/(\d+)$/);
    if (mm) { const o = +mm[1], h = +mm[2]; b.ovl += h ? o / h : 0; b.any += o > 0 ? 1 : 0; }
    if (/그림/.test(String(r[CL_LOG.FLAGS - 1]))) { b.fig++; b.figOk += Number(r[CL_LOG.M_UNIT - 1]) || 0; }
  });
  let s = '파일럿 일치율 (과목: 표본 · 대단원 정확 · 키워드 겹침률 평균 · 1개 이상 겹침 · 그림 문항 대단원 정확)';
  const tot = { n: 0, unitOk: 0, ovl: 0, any: 0, fig: 0, figOk: 0 };
  const pct = (a, b) => (100 * a / b).toFixed(0) + '%';
  Object.keys(by).sort().forEach(k => {
    const b = by[k]; Object.keys(tot).forEach(f => { tot[f] += b[f]; });
    s += `\n${k}: ${b.n} · ${pct(b.unitOk, b.n)} · ${pct(b.ovl, b.n)} · ${pct(b.any, b.n)} · ${b.fig ? `${pct(b.figOk, b.fig)} (${b.fig})` : '-'}`;
  });
  if (tot.n) s += `\n전체: ${tot.n} · ${pct(tot.unitOk, tot.n)} · ${pct(tot.ovl, tot.n)} · ${pct(tot.any, tot.n)} · ${tot.fig ? `${pct(tot.figOk, tot.fig)} (${tot.fig})` : '-'}`;
  return s;
}

/* =====================================================================
 * 6. 되돌리기 코어 — AI 가 쓴 값이 그대로인 Meta 행만 F~L·N 비우고 상태 '대기'
 * ===================================================================== */

function cl_undoCore_(runId) {
  const ss = SpreadsheetApp.getActive();
  if (cl_loadState_()) return { ok: false, reason: '분류 작업이 진행 중입니다.' };
  const logSh = ss.getSheetByName(CL.LOG_SHEET), sh = ss.getSheetByName(META.SHEET);
  if (!runId || !logSh || !sh || logSh.getLastRow() < 2) return { ok: false, reason: '실행ID 또는 로그/Meta 시트가 없습니다.' };
  const vals = logSh.getRange(2, 1, logSh.getLastRow() - 1, CL_LOG.HEADER.length).getValues();
  const M = CL.MCOL, cache = {};
  let undone = 0, kept = 0;
  vals.forEach((r, k) => {
    if (String(r[CL_LOG.RUN - 1]) !== runId || String(r[CL_LOG.MODE - 1]) !== 'tag') return;
    const st = String(r[CL_LOG.STATUS - 1]); if (st !== 'ok' && st !== 'review') return;
    const key = cl_nfc_(r[CL_LOG.KEY - 1]).trim();
    const f = cl_findMetaRow_(sh, key, Number(r[CL_LOG.ROW - 1]), cache);
    if (!f.row) { kept++; return; }
    const same = String(f.cur[M.unit - 1]).trim() === String(r[CL_LOG.UNIT - 1]).trim() && String(f.cur[M.tags - 1]).trim() === String(r[CL_LOG.TAGS - 1]).trim()
      && String(f.cur[M.by - 1]).indexOf(runId) >= 0 && !cl_truthy_(f.cur[M.lock - 1]);
    if (!same) { kept++; return; }
    const row = f.cur.slice();
    [M.course, M.unit, M.tags, M.multi, M.conf, M.by, M.scope].forEach(c => { row[c - 1] = ''; });
    row[M.status - 1] = CL.ST_WAIT; row[M.at - 1] = cl_now_();
    sh.getRange(f.row, 1, 1, META.HEAD.length).setValues([row]);
    logSh.getRange(k + 2, CL_LOG.STATUS).setValue('undone');
    undone++;
  });
  return { ok: true, undone, kept };
}

/* =====================================================================
 * 7. 메뉴
 * ===================================================================== */

function cl_setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Anthropic API 키 저장 (이 프로젝트 · 내 계정에만)',
    '키를 붙여넣으세요 (sk-ant-…). 러너 classify 단계(웹앱)와 수거 트리거가 이 키를 씁니다.\n비워 두고 확인하면 저장된 키를 지웁니다.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = String(res.getResponseText() || '').trim();
  const up = PropertiesService.getUserProperties();
  if (!key) { up.deleteProperty(CL.API_KEY_PROP); ui.alert('저장된 키를 지웠습니다.'); return; }
  if (!/^sk-ant-/.test(key)) { ui.alert('키 형식이 아닙니다 (sk-ant-… 로 시작해야 합니다).'); return; }
  up.setProperty(CL.API_KEY_PROP, key);
  ui.alert('키를 저장했습니다. Anthropic Console 에서 이 키의 워크스페이스에 지출 한도를 걸어 두세요.');
}

/** Data_DS 또는 Meta 에서 고른 행의 키 → 분류 제출 */
function cl_submitSelection() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getActiveSheet();
  if ([CL.DS_SHEET, META.SHEET].indexOf(sh.getName()) < 0) { ui.alert(`Data_DS 또는 Meta 시트에서 행을 고른 뒤 실행하세요. (지금 ${sh.getName()})`); return; }
  const rows = {};
  const rl = ss.getActiveRangeList();
  (rl ? rl.getRanges() : [ss.getActiveRange()]).filter(Boolean).forEach(rg => { for (let r = Math.max(2, rg.getRow()); r < rg.getRow() + rg.getNumRows(); r++) rows[r] = 1; });
  const list = Object.keys(rows).map(Number).sort((a, b) => a - b);
  if (!list.length) { ui.alert('행을 고른 뒤 실행하세요.'); return; }
  if (list.length > CL.SELECT_MAX) { ui.alert(`한 번에 ${CL.SELECT_MAX}행까지입니다. (선택 ${list.length}행)`); return; }
  const keys = [];
  cl_clusters_(list, 1).forEach(cl => sh.getRange(cl.start, 1, cl.len, 1).getValues().forEach(v => { const k = cl_nfc_(v[0]).trim(); if (k && keys.indexOf(k) < 0) keys.push(k); }));
  cl_submitMenu_(ui, { mode: 'tag', keys }, `선택 ${list.length}행(키 ${keys.length}개)`);
}

/** Meta 의 상태 '대기'(대단원 빈칸·잠금 아님) 행 전부 */
function cl_submitPending() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActive().getSheetByName(META.SHEET);
  if (!sh || sh.getLastRow() < 2) { ui.alert('Meta 행이 없습니다.'); return; }
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, META.HEAD.length).getValues();
  const keys = vals.filter(r => cl_nfc_(r[0]).trim() && !String(r[CL.MCOL.unit - 1] || '').trim() && !cl_truthy_(r[CL.MCOL.lock - 1])).map(r => cl_nfc_(r[0]).trim());
  if (!keys.length) { ui.alert('대단원이 빈 Meta 행이 없습니다.'); return; }
  cl_submitMenu_(ui, { mode: 'tag', keys }, `Meta 대기 행 ${keys.length}개`);
}

function cl_pilotSubmit() {
  const ui = SpreadsheetApp.getUi();
  const p = ui.prompt('파일럿 (Meta 경로 · 장부 v4 파일럿과 같은 행)', `장부 _AI판정로그 의 파일럿 실행ID (비우면 ${CL.PILOT_RUN_DEFAULT}). Meta·장부에는 쓰지 않습니다.`, ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  cl_submitMenu_(ui, { mode: 'pilot', pilotRunId: String(p.getResponseText() || '').trim() || CL.PILOT_RUN_DEFAULT }, '파일럿');
}

function cl_submitMenu_(ui, opts, label) {
  const ep = ui.prompt('effort', `${CL.EFFORT_LEVELS.join(' / ')} 중 하나 (비우면 ${CL.EFFORT})`, ui.ButtonSet.OK_CANCEL);
  if (ep.getSelectedButton() !== ui.Button.OK) return;
  opts.effort = String(ep.getResponseText() || '').trim().toLowerCase() || CL.EFFORT;
  opts.by = Session.getActiveUser ? String(Session.getActiveUser().getEmail() || '메뉴') : '메뉴';
  if (ui.alert('분류 제출', `${label}\n모델 ${CL.MODEL} / effort ${opts.effort}\n예상 비용: 행당 약 $0.005 (배치 단가, 장부 v4 실측)\n\n제출할까요? (결과는 10분마다 자동 수거해 Meta 에 씁니다${opts.mode === 'pilot' ? ' — 파일럿은 로그에만' : ''})`, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  let r;
  try { r = cl_submitCore_(opts); } catch (e) { ui.alert('제출 실패: ' + e.message); return; }
  ui.alert('분류 제출 결과', cl_resultText_(r), ui.ButtonSet.OK);
}

function cl_resultText_(r) {
  return `${r.ok ? '✅' : '⚠️'} ${r.reason || ''}\n실행ID ${r.runId || '-'} · 제출 ${r.submitted || 0} (예열 ${r.warmN || 0} · 대기 ${r.queuedN || 0})\n` +
    `Meta 새 행 ${r.created || 0} · 갱신 ${r.updated || 0} · 이미 분류 ${r.filled || 0} · 잠금 ${r.locked || 0} · 보류로 건너뜀 ${r.skipped || 0} · 교육과정 모름 ${r.hold || 0}` +
    (r.badN ? `\n제외 ${r.badN}: ${(r.bad || []).slice(0, 5).map(b => `${b.key}(${b.note})`).join(', ')}` : '');
}

function cl_status() {
  const ui = SpreadsheetApp.getUi();
  const st = cl_loadState_();
  if (!st) { ui.alert('진행 중인 분류 작업이 없습니다.' + ((PropertiesService.getScriptProperties().getProperty(CL.PROP_LAST) || '') ? '\n\n마지막 요약:\n' + PropertiesService.getScriptProperties().getProperty(CL.PROP_LAST) : '')); return; }
  const msg = `실행ID ${st.runId} · 모드 ${st.mode} · 단계 ${st.phase} · ${st.model}/${st.effort}\n시작 ${st.startedAt} · 대상 ${st.total}\n` +
    `수거 결과: 기록 ${st.counts.ok} / review ${st.counts.review} / 보류·실패 ${st.counts.fail}\n수거 ${st.polls}회 · 연속 오류 ${st.errors}회${st.lastError ? '\n마지막 오류: ' + st.lastError : ''}\n\n` +
    st.batches.map(b => `${b.id} [${b.kind}] ${b.done ? '수거 완료' : '대기'} (${b.n}건)`).join('\n') + '\n\n지금 수거할까요?';
  if (ui.alert('분류 상태', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  st.errors = 0; cl_saveState_(st);
  const outcome = cl_batchPoll();
  ui.alert(`수거: ${outcome}` + (cl_loadState_() ? '' : '\n\n' + (PropertiesService.getScriptProperties().getProperty(CL.PROP_LAST) || '')));
}

function cl_stop() {
  const ui = SpreadsheetApp.getUi();
  const st = cl_loadState_();
  if (!st) { cl_deleteTriggers_(); ui.alert('진행 중인 작업이 없습니다. (남은 트리거는 정리했습니다)'); return; }
  if (ui.alert('분류 중지', `실행ID ${st.runId}\n남은 배치를 취소하고 즉시 멈춥니다(끝난 결과도 받지 않음 — 로그는 aborted, Meta 는 대기 그대로).`, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  ui.alert(cl_stopCore_().text);
}

function cl_stopCore_() {
  const st = cl_loadState_();
  if (!st) { cl_deleteTriggers_(); return { ok: true, text: '진행 중인 작업 없음' }; }
  const failed = [];
  st.batches.filter(b => !b.done).forEach(b => { const res = cl_apiFetch_(`/messages/batches/${b.id}/cancel`, 'post', {}); if (!res.json) failed.push(b.id); });
  cl_deleteTriggers_();
  let warn = '';
  try {
    const block = cl_readLogBlock_(cl_getLogSheet_(SpreadsheetApp.getActive()), st);
    block.rows.forEach(r => { if (CL_PENDING.indexOf(r[CL_LOG.STATUS - 1]) >= 0) { r[CL_LOG.STATUS - 1] = 'aborted'; r[CL_LOG.TIME - 1] = cl_now_(); } });
    cl_writeLogBlock_(block);
  } catch (e) { warn = ` · 로그 상태는 못 바꿈: ${String(e.message || e).slice(0, 120)}`; }
  PropertiesService.getScriptProperties().deleteProperty(CL.PROP_STATE);
  return { ok: true, text: `중지했습니다.${failed.length ? ' 취소 실패: ' + failed.join(', ') : ''}${warn}` };
}

function cl_undoRun() {
  const ui = SpreadsheetApp.getUi();
  const p = ui.prompt('분류 되돌리기', '되돌릴 실행ID (Classify_Log B열, 예: 261120-153000T)', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  const r = cl_undoCore_(String(p.getResponseText() || '').trim());
  ui.alert(r.ok ? `되돌리기 완료: ${r.undone}행 비움(상태 대기), ${r.kept}행은 사람이 고쳤거나 찾지 못해 그대로.` : r.reason);
}

/* =====================================================================
 * 8. 원격 (RemoteApi.gs 에서 부름)
 * ===================================================================== */

/** p.action: submit(keywords 필수) | status | stop */
function rapi_classify_(p) {
  const action = String(p.action || 'submit');
  if (action === 'status') {
    const st = cl_loadState_();
    return { ok: true, running: !!st, state: st ? { runId: st.runId, mode: st.mode, phase: st.phase, total: st.total, counts: st.counts, polls: st.polls, errors: st.errors, lastError: st.lastError || '' } : null,
      last: PropertiesService.getScriptProperties().getProperty(CL.PROP_LAST) || '', apiKey: !!cl_apiKey_() };
  }
  if (action === 'stop') return cl_stopCore_();
  if (action === 'pilot') {                                  // P4-1: 장부 v4 파일럿과 같은 행(Meta·장부 쓰기 없음, 로그만)
    try { return cl_submitCore_({ mode: 'pilot', pilotRunId: String(p.run || CL.PILOT_RUN_DEFAULT), effort: p.effort || CL.EFFORT, by: '원격:' + String(p.by || 'clue') }); }
    catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }
  if (action !== 'submit') return { ok: false, reason: 'action 은 submit | pilot | status | stop' };
  const keywords = (typeof pl_parseKeywords_ === 'function') ? pl_parseKeywords_(p.keywords) : String(p.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!keywords.length) return { ok: false, reason: 'keywords 가 필요합니다.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, reason: '다른 작업이 잠금을 쥐고 있습니다 — 잠시 뒤 다시.' };
  try {
    return cl_submitCore_({ mode: 'tag', keywords, effort: p.effort || CL.EFFORT, by: '원격:' + String(p.by || 'runner') });
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  } finally { lock.releaseLock(); }
}

/* =====================================================================
 * 9. API·상태·임대·트리거·유틸
 * ===================================================================== */

function cl_apiKey_() { return PropertiesService.getUserProperties().getProperty(CL.API_KEY_PROP) || ''; }

function cl_apiFetch_(path, method, payload, opts) {
  const options = { method, muteHttpExceptions: true, headers: { 'x-api-key': cl_apiKey_(), 'anthropic-version': CL.API_VERSION } };
  if (payload !== null && payload !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(payload); }
  const url = /^https?:/.test(path) ? path : CL.API_BASE + path;
  let last = { code: 0, body: '', json: null };
  for (let attempt = 0; attempt <= CL.RETRY_WAITS_MS.length; attempt++) {
    if (attempt > 0) Utilities.sleep(CL.RETRY_WAITS_MS[attempt - 1]);
    let resp;
    try { resp = UrlFetchApp.fetch(url, options); } catch (e) { last = { code: 0, body: String(e), json: null }; continue; }
    const code = resp.getResponseCode(), body = resp.getContentText();
    last = { code, body, json: null };
    if (code >= 200 && code < 300) {
      if (!(opts && opts.raw)) { try { last.json = JSON.parse(body); } catch (e) { last.json = null; } }
      return last;
    }
    const retryable = (code === 429 || code === 529) || (code >= 500 && !(opts && opts.createOnly));
    if (!retryable) return last;
  }
  return last;
}

function cl_loadState_() { const s = PropertiesService.getScriptProperties().getProperty(CL.PROP_STATE); return s ? JSON.parse(s) : null; }
function cl_saveState_(st) { PropertiesService.getScriptProperties().setProperty(CL.PROP_STATE, JSON.stringify(st)); }
function cl_stateAlive_(runId) { const s = cl_loadState_(); return !!(s && s.runId === runId); }

/** 임대: 공용 ScriptLock 은 잠깐만, 실제 실행 중 표시는 ScriptProperties 만료시각(Pipeline tick 과 충돌 방지) */
function cl_acquireLease_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    const p = PropertiesService.getScriptProperties();
    const until = Number(p.getProperty(CL.PROP_LEASE) || 0);
    if (until > Date.now()) return false;
    p.setProperty(CL.PROP_LEASE, String(Date.now() + CL.LEASE_MS));
    return true;
  } finally { lock.releaseLock(); }
}
function cl_releaseLease_() { PropertiesService.getScriptProperties().deleteProperty(CL.PROP_LEASE); }
function cl_deleteTriggers_() { ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === CL.POLL_FN) ScriptApp.deleteTrigger(t); }); }

function cl_promptFp_(ctx) {
  const fp = {};
  Object.keys(ctx.systemCache).forEach(k => {
    const s = ctx.systemCache[k].map(b => b.text).join('\u0001');
    let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    fp[k] = `${s.length}:${h}`;
  });
  return fp;
}
function cl_runId_(mode) { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd-HHmmss') + ({ pilot: 'P', tag: 'T' }[mode] || 'X'); }
function cl_now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }
