/**
 * RemoteApi.gs — 헤드리스 원격 제어 API (Phase 1)
 * 프로젝트: gas-project-latex-convert (Latex 변환)
 *
 * audition 쪽과 같은 형태다. 다른 점은 이 프로젝트에 `quality`/`resume`/`result`가
 * 없다는 것뿐 — 파이프라인 단계가 `clear → search → latex → ds → norm → ans`이고
 * 사람이 답하던 질문이 키워드 하나뿐이다.
 *
 * ── 배포 ─────────────────────────────────────────────────────────────
 *   웹앱 / 실행: 나(kimdeoksoo@gmail.com) / 액세스: 모든 사용자
 *
 * ⚠️⚠️ 코드를 고친 뒤에는 반드시 **배포 관리 → 연필(수정) → 버전: 새 버전 → 배포**.
 *      "새 배포"는 URL이 바뀌고 옛 배포가 살아남아, 러너가 에러 없이 옛 코드를
 *      계속 부르게 된다. `VERSION`을 러너가 대조해 막는다.
 */

const RAPI = {
  VERSION:    'latex-1.4.1',   // 1.4.1 = classify action=pilot(원격 파일럿) / 1.4.0 = renual P4 분류(Classify.gs): Meta 시트 · classify 명령(배치 제출) · 메뉴 '분류(Meta)' / 1.3.2 = 이관 도구: 배열 수식이 펼친 영역(Data_Latex A:B)은 안 씀 / 1.3.1 = X-06 27 계열 키 이관(Migrate27.gs · migrate27 명령 · 메뉴) / 1.3.0 = renual P3(2026-11-19): 키 규칙 0통합·9순번·9기출 · Sets 시트(_set.json·start profile) · 정답표 우선 · 해설 없음 세트 문제만 행 · status sets · imagecheck sets / 1.2.3 = 정답 추출: 키워드와 다른 줄의 값은 그 줄이 정답 하나뿐일 때만(7406 "정답⏎2 이상의…") / 1.2.2 = 2028 서킷 틀(세트 구성: 공통 14~20 · 확통 26~28)도 통합형 번호 규칙 / 1.2.1 = 2028 통합형(27~) 번호 규칙·renorm 명령 / 1.2.0 = postfix 단계(PostProcess.gs)·식 번호 원문자 정본(MathpixTagNormalize 반대 방향)·정규화 첫 줄 \section* · 이하 이력 — 패치 14: 그림 URL \& 복원(2026-11-08) · 패치 13 (대량 변환 v4): tick / resume / sheetcheck 추가, start 는 트리거를 걸지 않는다
  PROJECT:    'latex-convert',
  TOKEN_PROP: 'REMOTE_TOKEN',
  LOG_TAIL:   20,
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!rapi_auth_(p.token)) return ContentService.createTextOutput('');   // C7: 빈 200

  try {
    switch (p.cmd) {
      case 'ping':   return rapi_json_(rapi_ping_());
      case 'start':  return rapi_json_(rapi_start_(p));
      case 'tick':   return rapi_json_(pl_runSlice_(pl_budget_()));
      case 'resume': return rapi_json_(pipeline_resumeCore_(String(p.from || '').trim()));
      case 'status': return rapi_json_(rapi_status_());
      case 'stop':   return rapi_json_(pipeline_stopCore_('원격 중지 (RemoteApi)'));
      case 'sheetcheck': return rapi_json_(Object.assign({ ok: true }, pl_sheetcheck_(rapi_keywords_(p.keywords))));
      case 'imagecheck': return rapi_json_(rapi_imagecheck_(p));
      case 'postfix':    return rapi_json_(rapi_postfix_(p));          // 2026-11-17: 기존 행 후처리·점검 (PostProcess.gs)
      case 'renorm':     return rapi_json_(rapi_renorm_(p));           // 2026-11-17: 기존 행 재정규화 → 정답 → 후처리
      case 'migrate27':  return rapi_json_(rapi_migrate27_(p));        // 2026-11-20 renual 3단계 X-06 (Migrate27.gs)
      case 'classify':   return rapi_json_(rapi_classify_(p));         // 2026-11-20 renual P4 분류(Meta) — Classify.gs
      default:       return rapi_json_({ ok: false, reason: 'unknown cmd: ' + p.cmd });
    }
  } catch (err) {
    return rapi_json_({ ok: false, reason: String((err && err.message) || err) });
  }
}

/**
 * 기존 행 후처리 / 점검 (2026-11-17 · 메뉴 '기존 행 후처리'·'후처리 점검'과 같은 코어 pp_processRows_).
 *   start · end : Data_DS 행 번호 (필수, start ≥ 2)
 *   write       : 1 이면 시트에 쓴다. 없으면 **점검만**(쓰기 없음 — 기록 열도 만들지 않는다)
 * 한 번 호출에 tick 예산 안에서 되는 만큼만 하고 `next`(남은 첫 행, 다 했으면 null)를 돌려준다 → 부르는 쪽이 next 부터 다시 부른다.
 * 쓰기는 파이프라인이 실행 중이면 거부한다. 규칙이 멱등이라 같은 범위를 다시 불러도 결과는 같다.
 */
function rapi_postfix_(p) {
  const write = p.write === '1';
  const a = parseInt(p.start, 10), bRaw = parseInt(p.end, 10);
  if (!(a >= 2) || !(bRaw >= a)) return { ok: false, reason: 'start·end(행 번호, start ≥ 2, end ≥ start)가 필요합니다.' };
  if (write && pl_isBusy_()) return { ok: false, reason: '파이프라인이 실행 중입니다 — 끝난 뒤에 쓰세요.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PL.LOCK_WAIT_MS)) return { ok: false, reason: 'locked' };
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(PL.DST_SHEET);
    if (!sh) return { ok: false, reason: PL.DST_SHEET + ' 시트 없음' };
    const t0 = Date.now(), deadline = t0 + pl_budget_() - 30000;
    const last = dlds_lastDataRow_(sh, 1), b = Math.min(bRaw, last);
    const tot = { rows: 0, changed: 0, rules: {}, review: {}, reclassify: { n: 0, head: [] } };
    let cur = a;
    while (cur <= b && Date.now() < deadline) {
      const end = Math.min(cur + PL.POST_CHUNK - 1, b);
      const st = pp_processRows_(sh, cur, end, { dryRun: !write });
      tot.rows += st.rows; tot.changed += st.changed;
      Object.keys(st.rules).forEach(k => { tot.rules[k] = (tot.rules[k] || 0) + st.rules[k]; });
      Object.keys(st.review).forEach(k => { const o = (tot.review[k] = tot.review[k] || { n: 0, head: [] }); o.n += st.review[k].length; st.review[k].forEach(r => { if (o.head.length < 50) o.head.push(r); }); });
      tot.reclassify.n += st.reclassify.length; st.reclassify.forEach(r => { if (tot.reclassify.head.length < 50) tot.reclassify.head.push(r); });
      cur = end + 1;
    }
    return Object.assign({ ok: true, write: write, start: a, end: b, lastRow: last, doneTo: cur - 1, next: cur <= b ? cur : null, elapsedMs: Date.now() - t0 }, tot);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/**
 * 기존 행 재정규화 (2026-11-17): 행 범위에 normalize → answer → postfix 를 다시 돌린다.
 *   쓰임 ① 정규화 규칙이 바뀐 뒤 이미 들어간 행 고치기(27CXTB07회: 통합형 번호 규칙)  ② 옛 정규화 행(계획 v4 E2)
 *   start · end : Data_DS 행 번호 (필수, start ≥ 2)
 *   write       : 1 이면 쓴다. 없으면 점검만 — 유형(K)이 달라질 행 목록을 돌려준다
 *   정답(D)은 **빈 칸만** 채운다(기존 값은 건드리지 않는다 — ds_fillGivenAnswerRows_ 의 기본 동작).
 * 범위가 직전 런이 쓴 행(ds.writeStart~writeEnd)과 같고 그 런이 done 이면 PL_STATE 의 norm·ans·post 집계도 새 값으로 바꾼다
 *   → 러너가 그 런에 다시 붙었을 때(/retry) 고친 결과를 본다.
 * 한 번에 tick 예산 안에서 되는 만큼만 하고 next 를 돌려준다.
 */
function rapi_renorm_(p) {
  const write = p.write === '1';
  const a = parseInt(p.start, 10), bRaw = parseInt(p.end, 10);
  if (!(a >= 2) || !(bRaw >= a)) return { ok: false, reason: 'start·end(행 번호, start ≥ 2, end ≥ start)가 필요합니다.' };
  if (write && pl_isBusy_()) return { ok: false, reason: '파이프라인이 실행 중입니다 — 끝난 뒤에 쓰세요.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PL.LOCK_WAIT_MS)) return { ok: false, reason: 'locked' };
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(PL.DST_SHEET);
    if (!sh) return { ok: false, reason: PL.DST_SHEET + ' 시트 없음' };
    const t0 = Date.now(), deadline = t0 + pl_budget_() - 30000;
    const last = dlds_lastDataRow_(sh, 1), b = Math.min(bRaw, last);
    const out = { ok: true, write: write, start: a, end: b, lastRow: last, rows: 0, typeChanges: [], norm: { ok: 0, fail: 0, review: [] },
                  ans: { ok: 0, miss: [], conflict: [], skipped: 0 }, post: { rows: 0, changed: 0, rules: {}, review: {}, reclassify: [] } };
    let cur = a;
    while (cur <= b && Date.now() < deadline) {
      const end = Math.min(cur + PL.NORM_CHUNK - 1, b), rows = pl_range_(cur, end);
      const before = sh.getRange(cur, DSN.OUT.type, end - cur + 1, 1).getValues().map(r => String(r[0] || '').trim());
      const n = ds_normalizeRows_(sh, rows, { dryRun: !write });
      out.rows += rows.length; out.norm.ok += n.ok; out.norm.fail += n.fail; n.review.forEach(x => out.norm.review.push(x));
      if (write) {
        const after = sh.getRange(cur, DSN.OUT.type, end - cur + 1, 1).getValues().map(r => String(r[0] || '').trim());
        after.forEach((t, i) => { if (t !== before[i] && out.typeChanges.length < 200) out.typeChanges.push((cur + i) + ':' + before[i] + '→' + t); });
        const s = ds_fillGivenAnswerRows_(sh, rows);
        out.ans.ok += s.ok; out.ans.skipped += s.skipped; s.miss.forEach(x => out.ans.miss.push(x)); s.conflict.forEach(x => out.ans.conflict.push(x));
        const q = pp_processRows_(sh, cur, end);
        out.post.rows += q.rows; out.post.changed += q.changed;
        Object.keys(q.rules).forEach(k => { out.post.rules[k] = (out.post.rules[k] || 0) + q.rules[k]; });
        Object.keys(q.review).forEach(k => { out.post.review[k] = (out.post.review[k] || 0) + q.review[k].length; });
        q.reclassify.forEach(x => out.post.reclassify.push(x));
      } else {
        const blk = sh.getRange(cur, 1, end - cur + 1, DSN.COL.raw).getValues();
        blk.forEach((v, i) => {
          const key = String(v[DSN.COL.key - 1] || '').trim(), raw = String(v[DSN.COL.raw - 1] || '').trim();
          if (!key && !raw) return;
          const c = ds_classify_(key, raw, DSN);
          if (c.type !== before[i] && out.typeChanges.length < 200) out.typeChanges.push((cur + i) + ':' + before[i] + '→' + c.type);
        });
      }
      cur = end + 1;
    }
    out.doneTo = cur - 1; out.next = cur <= b ? cur : null; out.elapsedMs = Date.now() - t0;
    // 직전 런의 범위 전체를 다시 한 것이면 그 런의 집계를 새 값으로
    const st = pl_loadState_();
    if (write && out.next === null && st && st.stage === 'done' && st.ds && st.ds.writeStart === a && st.ds.writeEnd === b) {
      st.norm.ok = out.norm.ok; st.norm.fail = out.norm.fail; st.norm.review = pl_slim_(st, 'norm.review', out.norm.review);
      st.ans = { ok: out.ans.ok + out.ans.skipped, miss: pl_slim_(st, 'ans.miss', out.ans.miss), conflict: pl_slim_(st, 'ans.conflict', out.ans.conflict), skipped: out.ans.skipped };
      st.post = { cursor: b + 1, end: b, rows: out.post.rows, changed: out.post.changed, rules: out.post.rules, review: out.post.review, reclassify: pl_slim_(st, 'post.reclassify', out.post.reclassify) };
      pl_saveState_(st);
      pl_log_(st, 'renorm', `재정규화 ${a}~${b}: 정규화 성공 ${out.norm.ok}·실패 ${out.norm.fail} / 정답 채움 ${out.ans.ok}·그대로 ${out.ans.skipped}·미검출 ${out.ans.miss.length}·불일치 ${out.ans.conflict.length} / 유형 변경 ${out.typeChanges.length}`);
      out.stateUpdated = true;
    }
    return out;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/**
 * X-06 27 계열 키 이관 (2026-11-20, Migrate27.gs). action:
 *   survey — 조사(쓰기는 Migrate_27 표만). sets(선택): JSON 배열 — 없으면 Data_DS 후보 전부
 *   apply  — sets(필수, JSON 배열)를 승인 칸 체크 후 적용(덕수 세트 단위 승인을 받은 것만 부른다). by: 기록용 이름
 *   undo   — set(세트명 하나)의 로그를 거꾸로 돌린다
 */
function rapi_migrate27_(p) {
  const act = String(p.action || '');
  let sets = null;
  if (p.sets) { try { sets = JSON.parse(p.sets); } catch (_) { return { ok: false, reason: 'sets 는 JSON 배열' }; } if (!Array.isArray(sets)) return { ok: false, reason: 'sets 는 JSON 배열' }; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PL.LOCK_WAIT_MS)) return { ok: false, reason: 'locked' };
  try {
    if (act === 'survey') return m27_surveyCore_(sets);
    if (act === 'apply') { if (!sets || !sets.length) return { ok: false, reason: 'apply 는 sets 가 필요합니다' }; const by = '원격:' + String(p.by || '').slice(0, 40); return m27_applyCore_(sets, by, by); }
    if (act === 'undo') { if (!p.set) return { ok: false, reason: 'undo 는 set 이 필요합니다' }; return m27_undoCore_(String(p.set), '원격:' + String(p.by || '').slice(0, 40)); }
    return { ok: false, reason: 'action 은 survey · apply · undo' };
  } finally { lock.releaseLock(); }
}

function rapi_ping_() {
  return { ok: true, project: RAPI.PROJECT, version: RAPI.VERSION, at: new Date().toISOString() };
}

/**
 * 변환 시작 (패치 13: 상태만 만든다. 진행은 tick).
 *   keywords     : 쉼표/줄바꿈 구분 (필수, 대량 변환은 1개)
 *   force        : 1이면 진행 중인 파이프라인을 중단하고 새로 시작 (미보관 런도 덮어씀)
 *   driver       : trigger(기본 — 러너·메뉴, 1분 트리거로 스스로 이어감) | pump(맥미니 펌프가 tick 호출, 트리거 없음)  R1 #1
 *   until        : latex | fig | done (기본: trigger→done, pump→latex)
 *   fig          : 0이면 그림 단계 없이 send 로 (기본 1)
 *   skipExisting : 0이면 Data_DS 기존 key 도 변환 (기본 1)
 *
 * ⚠️ audition과 달리 키워드를 NFC 정규화하지 않는다 — 이 프로젝트의
 *    `pipeline_start`가 원래 그렇게 동작했고, 동작을 바꾸지 않기 위함이다.
 */
function rapi_keywords_(raw) {
  return Array.from(new Set(
    String(raw || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)
  ));
}

function rapi_start_(p) {
  const keywords = rapi_keywords_(p.keywords);
  if (!keywords.length) return { ok: false, reason: 'keywords 파라미터가 비어 있습니다.' };
  const driver = p.driver === 'pump' ? 'pump' : 'trigger';
  // renual P3(§5): profile = "형식,구성,교육과정,양식,해설,정답출처" 또는 JSON. Sets 행이 없는 세트만 이 값으로 만든다(있으면 Sets 우선)
  const prof = sets_parseProfileArg_(p.profile);
  if (prof && !prof.ok) return { ok: false, reason: 'profile 오류: ' + prof.errors.join(' / ') };
  return pipeline_startCore_(keywords, {
    profile: prof ? prof.profile : null,
    force: p.force === '1',
    driver: driver,
    until: p.until || (driver === 'pump' ? 'latex' : 'done'),
    fig: p.fig !== '0',
    skipExisting: p.skipExisting !== '0'
  });
}

/**
 * IMAGE_DS 사전 점검 (읽기 전용, 1.0.1). 러너의 `from_latex` 모드가 Latex를 시작하기 전에 부른다.
 * `search` 단계와 **같은 방식**으로 폴더를 찾고(getFolderByPath) 키워드를 맞춘다(NFC·소문자·부분일치).
 *
 * 2026-09-19 첫 실전에서 IMAGE_DS에 **해설만** 있어 Mathpix 46건을 쓰고도 Data_DS 0행이 됐다.
 * 같은 이름 파일 중복(94개)도 있었는데, 조각(_c1)이 겹치면 같은 조각이 Mathpix에 두 번 들어간다.
 * 이런 상태를 비용을 쓰기 전에 잡는다.
 *
 * 응답: { ok, folderId, scanned, newestCreated(ISO), now(ISO),
 *         byKeyword: { kw: { problem:[문항], solution:[문항], png, pdf, other:[이름…≤5], sets:[_set.json 이름] } },   (sets: renual P3)
 *         duplicates: n, dupSamples:[이름…≤10] }
 *   folderId는 러너가 설정의 고정 ID와 대조한다 — 동명 폴더가 생기면 search가 엉뚱한 폴더를 쓰기 때문.
 */
function rapi_imagecheck_(p) {
  const keywords = rapi_keywords_(p.keywords);
  if (!keywords.length) return { ok: false, reason: 'keywords 파라미터가 비어 있습니다.' };
  const folder = getFolderByPath(PL.SEARCH_FOLDER);
  const kws = keywords.map(k => ({ k: k, l: nfc_(k).toLowerCase(), prob: {}, sol: {}, png: 0, pdf: 0, other: [], sets: [] }));
  const ITEM_RE = /_(문제|해설)_(.+?)(?:_c\d+)?\.(png|pdf)$/i;
  const seen = {}, dupSamples = [];
  let duplicates = 0, scanned = 0, newest = 0;
  const t0 = Date.now();
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const name = nfc_(f.getName() || '');
    const lower = name.toLowerCase();
    const hits = kws.filter(o => lower.indexOf(o.l) !== -1);
    if (!hits.length) continue;
    scanned++;
    newest = Math.max(newest, f.getDateCreated().getTime());
    if (seen[name]) { duplicates++; if (dupSamples.length < 10) dupSamples.push(name); } else seen[name] = true;
    const m = name.match(ITEM_RE);
    const isSet = /_set\.json$/i.test(name);                // renual P3: 세트 사이드카는 '이름 형식 밖'이 아니다
    hits.forEach(o => {
      if (isSet) { o.sets.push(name); return; }
      if (!m) { if (o.other.length < 5) o.other.push(name); return; }
      if (m[3].toLowerCase() === 'png') o.png++; else o.pdf++;
      (m[1] === '문제' ? o.prob : o.sol)[m[2]] = true;
    });
  }
  const byKeyword = {};
  kws.forEach(o => {
    byKeyword[o.k] = { problem: Object.keys(o.prob).sort(), solution: Object.keys(o.sol).sort(),
                       png: o.png, pdf: o.pdf, other: o.other, sets: o.sets };
  });
  return { ok: true, folderId: folder.getId(), scanned: scanned,
           newestCreated: newest ? new Date(newest).toISOString() : null, now: new Date().toISOString(),
           byKeyword: byKeyword, duplicates: duplicates, dupSamples: dupSamples, elapsedMs: Date.now() - t0 };
}

/** 상태 조회 — 러너가 폴링해 정체를 판정한다(§7). 원본을 가공 없이 싣는다. */
function rapi_status_() {
  const st = pl_loadState_() || null;
  return {
    ok: true,
    version: RAPI.VERSION,
    state:   st,
    progress: pl_progress_(st),                 // 패치 13 A-06 (tick 과 같은 객체)
    archived: pl_archivedOk_(st),               // 패치 13 D20
    logTail: rapi_logTail_(RAPI.LOG_TAIL),
    sets:    rapi_setsSummary_(st),                // renual P3: 이번 런 키워드의 Sets 행 (러너가 런 프로파일과 대조)
    hasTick: ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === PL.TICK_FN),   // driver=trigger 면 true 가 정상, pump 면 false
    at:      new Date().toISOString(),
  };
}

/**
 * renual P3: 런 키워드(부분 일치, NFC·소문자)에 드는 Sets 행 요약 — [{ name, profile:"신,30,2022,-,있음,해설본문", answers:n, lock }]
 * 실패해도 status 는 돌려준다(null).
 */
function rapi_setsSummary_(st) {
  try {
    if (!st || !st.keywords) return null;
    const kws = st.keywords.map(k => nfc_(k).toLowerCase());
    const all = sets_readAll_(SpreadsheetApp.getActive()).byName;
    return Object.keys(all).filter(n => kws.some(k => n.toLowerCase().indexOf(k) !== -1)).slice(0, 30).map(n => {
      const r = all[n];
      return { name: n, profile: SETS.FIELDS.map(f => r.profile[f] || '').join(','), answers: Object.keys(r.answers || {}).length, lock: r.lock };
    });
  } catch (_) { return null; }
}

/* =================================================
 * 내부 유틸 (audition의 RemoteApi.gs와 동일)
 * ================================================= */

/** 토큰 비교. 상수시간. */
function rapi_auth_(given) {
  const want = PropertiesService.getScriptProperties().getProperty(RAPI.TOKEN_PROP);
  if (!want || !given) return false;
  if (want.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function rapi_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function rapi_logTail_(n) {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(PL.LOG_SHEET);
    if (!sh) return [];
    const last = sh.getLastRow();
    if (last < 2) return [];
    const from = Math.max(2, last - n + 1);
    return sh.getRange(from, 1, last - from + 1, 4).getValues().map(r => ({
      time: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
      run: String(r[1] || ''), stage: String(r[2] || ''), message: String(r[3] || ''),
    }));
  } catch (_) { return []; }
}

/**
 * `REMOTE_TOKEN` 설정 확인 (편집기에서 1회 실행). **토큰을 만들지도, 로그에 찍지도 않는다.**
 * 토큰은 맥미니에서 암호용 난수로 생성한다(`~/audit_runner/secrets/remote_tokens.json`의 "latex").
 *   → 프로젝트 설정 → 스크립트 속성 → `REMOTE_TOKEN`에 그 값을 붙여 넣은 뒤 이 함수로 확인.
 * ⚠️ 프로젝트별로 다른 토큰을 쓴다 — 하나가 새어도 나머지가 버틴다.
 * (2026-09-19 변경: 옛 버전은 Math.random()으로 생성하고 실행 로그에 토큰을 남겼다. 로그는 지울 수 없다.)
 */
function rapi_setupToken() {
  const tok = PropertiesService.getScriptProperties().getProperty(RAPI.TOKEN_PROP);
  if (!tok) { console.log('REMOTE_TOKEN 미설정 — 스크립트 속성에 추가하세요.'); return; }
  const ok = tok.length >= 32 && /^[A-Za-z0-9]+$/.test(tok);
  console.log('REMOTE_TOKEN 설정됨: 길이 %s, 형식 %s', tok.length, ok ? '정상' : '⚠️ 비정상(공백·줄바꿈 섞임?)');
}