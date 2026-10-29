/*************************************************
 * Pipeline.gs — 키워드 입력 한 번으로 자동 실행 (패치 13 · latex-1.1.0 · 대량 변환 계획서 v4 §3)
 *
 *  [메뉴] ▶ 원클릭 파이프라인 : pipeline_start          (첫 tick 만 직접 실행, 트리거 없음)
 *  [메뉴] ⏭ 이어하기            : pipeline_resume_menu    (멈춘 단계에서 다음 단계 선택 → tick 1회)
 *  [메뉴] ⏹ 파이프라인 중지     : pipeline_stop
 *  [메뉴] 📋 파이프라인 상태     : pipeline_status
 *  [메뉴] 🔍 시트 점검          : pipeline_sheetcheck_menu
 *  [웹앱] RemoteApi.gs 가 start/tick/resume/status/stop/sheetcheck 로 같은 코어를 부른다.
 *
 *  단계(stage) — 계획서 v4 §3.1
 *   clear → search → latex → latex_done⏸ → fig → fig_done⏸ → send → normalize → answer → archive → done
 *   · ⏸ 단계에서는 tick 이 {result:'paused'} 를 돌려주고 아무것도 하지 않는다. resume(from) 으로 다음 단계를 고른다.
 *   · opts.until = 'latex'(기본) | 'fig' | 'done'. 'done' 이면 ⏸ 없이 끝까지(메뉴 기본).
 *   · 실행 주체는 맥미니 펌프(tick 연속 호출). 시간 트리거는 만들지 않는다(옛 트리거가 남아 있으면 지운다).
 *
 *  상태 PL_STATE (v4 §3.2) — 목록은 개수+앞 20개만, 전체는 Pipeline_Report 시트 (R-03)
 *  정체·공백 (v4 §3.3) — lastTickAt / lastChangeAt / progress
 *  스크립트 속성 — PL_TICK_BUDGET_MS(240000) · PL_OCR_GAP_MS(15000) · LATEX_ARCH_SSID · PL_MPX_RATE_PER_MIN(50)
 *
 *  의존(기존 파일의 전역 함수):
 *   clearBelowHeader_            (Data1, Data_Latex 초기화.gs)
 *   getFolderByPath, collectPngNameUrlPairs, nfc_ (링크&파일명 추출(키워드).gs)
 *   mpr_convertRows, mpr_errorRows (Mathpix 범위 자동변환.gs)
 *   mpf_processBatchBudget       (Mathpix 그림 추출.gs)
 *   dlds_parseFilename_, dlds_lastDataRow_, dlds_embedFigLinks_, ds_fillGivenAnswerRows_, DLDS (Datalatex_To_Data_DS.gs)
 *   ds_normalizeRows_, ds_statSummary_, DSN (normalizeProblem.gs)
 *************************************************/

const PL = {
  STATE_PROP: 'PL_STATE',
  TICK_FN: 'pipeline_tick',                 // 옛 트리거 정리용 (새 트리거는 만들지 않는다)
  TICK_BUDGET_PROP: 'PL_TICK_BUDGET_MS', TICK_BUDGET_DEFAULT: 240 * 1000,   // D13
  OCR_GAP_PROP: 'PL_OCR_GAP_MS',         OCR_GAP_DEFAULT: 15 * 1000,         // D13 (옛 40초 여유는 그림 동기 대기용)
  ARCH_SSID_PROP: 'LATEX_ARCH_SSID',     ARCH_NAME: 'Latex_arch_2026-10',    // C-13
  LOCK_WAIT_MS: 3000,                       // C-16
  SEARCH_FOLDER: 'PBMAI/IMAGE_DS',
  DATA1_SHEET: 'Data1',
  SRC_SHEET: 'Data_Latex',
  DST_SHEET: 'Data_DS',
  LOG_SHEET: 'Pipeline_Log',
  REPORT_SHEET: 'Pipeline_Report',
  MAX_ATTEMPTS: 3,                          // Latex 변환 재시도 상한 (_MPR.CFG.MAX_ATTEMPTS 와 동일하게)
  EMAIL_ON_FINISH: true,
  SEND_CHUNK: 100, NORM_CHUNK: 25, ARCH_CHUNK: 200,    // D14 · R-02 · C-13
  ARCH_COLS: 16,                            // Data_Latex A:P
  HEAD_N: 20,
  STALL_MS: 20 * 60 * 1000, STALL_FIG_MS: 40 * 60 * 1000, GAP_RESET_MS: 5 * 60 * 1000,   // §3.3
  REPORT_CELL_MAX: 49000,
  FINISHED: ['done', 'error', 'stopped'],
  PAUSED: ['latex_done', 'fig_done'],
  RESUME: {                                 // C-17 · D20 전이표
    latex_done: ['latex', 'fig', 'send'],
    fig_done:   ['fig', 'send'],
    error:      ['archive'],
    stopped:    ['archive']
  }
};

/* =================================================
 * 메뉴 진입점
 * ================================================= */
function pipeline_start() {
  const ui = SpreadsheetApp.getUi();
  const cur = pl_loadState_();
  let force = false;
  if (cur && !PL.FINISHED.includes(cur.stage)) {
    const r = ui.alert('진행 중인 파이프라인이 있습니다',
      `현재 단계: ${cur.stage}\n키워드: ${cur.keywords.join(', ')}\n\n중단하고 새로 시작할까요?\n` +
      `⚠️ 새로 시작하면 Data_Latex 가 초기화되어 지금까지의 Mathpix 변환 결과(비용)를 다시 씁니다.`,
      ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
    force = true;
  } else if (cur && !pl_archivedOk_(cur)) {
    const r = ui.alert('직전 런이 보관(archive) 전에 끝났습니다',
      `직전 런: ${cur.keywords.join(', ')} (${cur.stage})\n\n` +
      `새로 시작하면 Data_Latex 가 지워집니다. 먼저 '⏭ 이어하기 → archive' 로 보관하는 것을 권합니다.\n그래도 새로 시작할까요?`,
      ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
    force = true;
  }

  const res = ui.prompt('원클릭 파이프라인',
    '키워드를 입력하세요. 여러 개면 쉼표(,) 또는 줄바꿈으로 구분\n예: 24서킷X05',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const keywords = pl_parseKeywords_(res.getResponseText());
  if (!keywords.length) { ui.alert('키워드가 비어 있습니다.'); return; }

  const ok = ui.alert('확인',
    `키워드 ${keywords.length}개: ${keywords.join(' | ')}\n\n` +
    `${PL.DATA1_SHEET}, ${PL.SRC_SHEET}(B열~)의 2행 이하를 초기화한 뒤\n` +
    `검색 → Latex 변환 → 그림 추출 → Data_DS 전송 → 정규화 → 정답 채우기 → 보관 을 실행합니다.\n` +
    `한 번에 ${Math.round(pl_budget_() / 1000)}초씩 진행되며, 시간이 더 필요하면 '⏭ 이어하기' 를 누르세요.\n` +
    `(맥미니 펌프가 돌고 있으면 자동으로 이어집니다)\n계속할까요?`,
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const r = pipeline_startCore_(keywords, { force: force, until: 'done', fig: true, skipExisting: true });
  if (!r.ok) { ui.alert('시작 실패', r.reason, ui.ButtonSet.OK); return; }
  const t = pipeline_tick();
  pl_toast_(`첫 회차 끝: ${t.result} / 단계 ${t.stage}`);
}

/** 메뉴 '⏭ 이어하기': 멈춘 단계면 다음 단계를 묻고, 아니면 tick 1회 */
function pipeline_resume_menu() {
  const ui = SpreadsheetApp.getUi();
  const st = pl_loadState_();
  if (!st) { ui.alert('실행 이력이 없습니다.'); return; }
  const allowed = PL.RESUME[st.stage];
  if (allowed) {
    const res = ui.prompt('이어하기', `현재 단계: ${st.stage}\n다음 단계를 입력하세요 (${allowed.join(' / ')})`, ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return;
    const r = pipeline_resumeCore_(String(res.getResponseText() || '').trim());
    if (!r.ok) { ui.alert('이어하기 실패', r.reason, ui.ButtonSet.OK); return; }
  } else if (PL.FINISHED.includes(st.stage)) {
    ui.alert(`끝난 런입니다 (${st.stage}). 새로 시작하려면 ▶ 원클릭 파이프라인.`); return;
  }
  const t = pipeline_tick();
  ui.alert('이어하기', `결과: ${t.result}\n단계: ${t.stage}\n` + pl_summary_(pl_loadState_()), ui.ButtonSet.OK);
}

function pipeline_stop() {
  pipeline_stopCore_('사용자 중지');
  try { SpreadsheetApp.getUi().alert('파이프라인을 중지했습니다.'); } catch (_) {}
}

function pipeline_status() {
  const st = pl_loadState_();
  const ui = SpreadsheetApp.getUi();
  if (!st) { ui.alert('실행 이력이 없습니다.'); return; }
  ui.alert('파이프라인 상태', pl_summary_(st), ui.ButtonSet.OK);
}

function pipeline_sheetcheck_menu() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('시트 점검', '키워드(선택, 쉼표 구분) — Data_DS 기존 key 수를 셉니다', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const r = pl_sheetcheck_(pl_parseKeywords_(res.getResponseText()));
  ui.alert('시트 점검', JSON.stringify(r, null, 1), ui.ButtonSet.OK);
}

/* =================================================
 * 헤드리스 코어 — UI를 절대 부르지 않는다
 * ================================================= */
function pl_parseKeywords_(raw) {
  return Array.from(new Set(String(raw || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)));
}

/** 끝난 런이 보관됐는가 (D20). 변환 결과가 없던 런(latex.ok 0, ds 0)은 보관할 것이 없으니 true */
function pl_archivedOk_(st) {
  if (!st) return true;
  if (st.archive && st.archive.done) return true;
  const hadWork = (st.latex && st.latex.ok > 0) || (st.ds && st.ds.count > 0);
  return !hadWork;
}

/**
 * 파이프라인 시작 코어. 메뉴(`pipeline_start`)와 원격 API(`RemoteApi.gs`)가 공유한다.
 * @param {string[]} keywords
 * @param {Object} opts  force · until('latex'|'fig'|'done', 기본 'latex') · fig(기본 true) · skipExisting(기본 true)
 * @return {{ok:boolean, reason?:string, runId?:string, stage?:string}}
 */
function pipeline_startCore_(keywords, opts) {
  opts = opts || {};
  keywords = (keywords || []).filter(Boolean);
  if (!keywords.length) return { ok: false, reason: '키워드가 비어 있습니다.' };
  const until = ['latex', 'fig', 'done'].includes(opts.until) ? opts.until : 'latex';

  const cur = pl_loadState_();
  if (cur && !PL.FINISHED.includes(cur.stage)) {
    if (!opts.force) {
      return { ok: false, reason: `이미 실행 중입니다 (단계: ${cur.stage}, 키워드: ${(cur.keywords || []).join(', ')}). force=1로 중단 후 시작할 수 있습니다.` };
    }
    pl_log_(cur, 'stopped', 'force 재시작으로 중단');
  } else if (cur && !pl_archivedOk_(cur) && !opts.force) {
    return { ok: false, reason: `직전 런(${(cur.keywords || []).join(', ')}, ${cur.stage})이 보관(archive) 전에 끝났습니다 — resume from=archive 로 먼저 보관하거나 force=1` };
  }
  pl_clearTriggers_();

  const now = Date.now();
  const st = {
    stage: 'clear', keywords: keywords, startedAt: new Date(now).toISOString(), runId: '',
    opts: { until: until, fig: opts.fig !== false, skipExisting: opts.skipExisting !== false },
    ticks: 0, lastTickAt: 0, lastChangeAt: now, progress: 0,
    search: { n: {}, skipped: {}, data1Rows: 0 },
    latex: { ok: 0, err: 0, left: 0 },
    fig: { done: 0, err: 0, noPdf: 0, submitted: 0, left: 0, submittedTotal: 0 },
    ds: { count: 0, writeStart: 0, writeEnd: 0, cursor: 0, total: 0, skippedDup: { n: 0, head: [] }, incomplete: { n: 0, head: [] } },
    norm: { cursor: 0, end: 0, ok: 0, fail: 0, review: { n: 0, head: [] }, warn: {} },
    ans: { ok: 0, miss: { n: 0, head: [] }, conflict: { n: 0, head: [] }, skipped: 0 },
    archive: { ssId: '', sheet: '', cursor: 0, done: false },
    error: ''
  };
  st.runId = st.startedAt;
  pl_saveState_(st);
  pl_log_(st, 'start', `키워드: ${keywords.join(' | ')} / until=${until} fig=${st.opts.fig} skipExisting=${st.opts.skipExisting}`);
  return { ok: true, runId: st.runId, stage: st.stage };
}

/** 중지 코어 (UI 없음) — 메뉴와 원격 API가 공유 */
function pipeline_stopCore_(by) {
  const st = pl_loadState_();
  pl_clearTriggers_();
  let stoppedFrom = '';
  if (st && !PL.FINISHED.includes(st.stage)) {
    stoppedFrom = st.stage;
    st.stage = 'stopped'; pl_saveState_(st); pl_log_(st, 'stopped', by || '중지');
  }
  return { ok: true, stoppedFrom: stoppedFrom };
}

/** resume 코어 (C-17 · D20). 허용 전이표 PL.RESUME 밖이면 거부 */
function pipeline_resumeCore_(from) {
  const st = pl_loadState_();
  if (!st) return { ok: false, reason: '실행 이력이 없습니다.' };
  const allowed = PL.RESUME[st.stage];
  if (!allowed) return { ok: false, reason: `단계 ${st.stage} 에서는 resume 할 수 없습니다.` };
  if (!allowed.includes(from)) return { ok: false, reason: `단계 ${st.stage} → ${from} 전이는 허용되지 않습니다 (가능: ${allowed.join(', ')})` };
  const prev = st.stage;
  st.stage = from;
  st.error = '';
  st.lastChangeAt = Date.now();                 // 사람이 개입했으니 정체 시계도 새로
  if (from === 'fig') { st.fig.submitted = 0; st.fig.left = 0; }
  pl_saveState_(st);
  pl_log_(st, 'resume', `${prev} → ${from}`);
  return { ok: true, stage: st.stage };
}

/* =================================================
 * 실행 엔진 — 메뉴·웹앱 tick 이 부른다. 트리거 없음.
 * ================================================= */
function pl_prop_(name, def) {
  const v = Number(PropertiesService.getScriptProperties().getProperty(name));
  return (isFinite(v) && v > 0) ? v : def;
}
function pl_budget_() { return pl_prop_(PL.TICK_BUDGET_PROP, PL.TICK_BUDGET_DEFAULT); }
function pl_ocrGap_() { return pl_prop_(PL.OCR_GAP_PROP, PL.OCR_GAP_DEFAULT); }

/** 메뉴·레거시 호환 래퍼 */
function pipeline_tick() { return pl_runSlice_(pl_budget_()); }

/**
 * tick 한 번. 반환 {ok, runId, result, stage, progress, elapsedMs}
 *   result: yield(예산 소진) | paused | done | error | locked | idle
 */
function pl_runSlice_(budgetMs) {
  const t0 = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PL.LOCK_WAIT_MS)) {
    const s0 = pl_loadState_();
    return pl_tickResp_(s0, 'locked', t0);
  }
  let st = pl_loadState_();
  try {
    pl_clearTriggers_();
    if (!st || PL.FINISHED.includes(st.stage)) return pl_tickResp_(st, 'idle', t0);
    if (PL.PAUSED.includes(st.stage)) return pl_tickResp_(st, 'paused', t0);

    // §3.3 공백 리셋: 펌프가 오래 멈췄다 돌아온 첫 tick 은 정체가 아니다
    const now = Date.now();
    if (st.lastTickAt && now - st.lastTickAt > PL.GAP_RESET_MS) st.lastChangeAt = now;
    st.lastTickAt = now; st.ticks = (st.ticks || 0) + 1;
    const deadline = now + Number(budgetMs || pl_budget_());

    let result = 'yield';
    try {
      while (Date.now() < deadline) {
        const r = pl_runStage_(st, deadline);
        pl_saveState_(st);
        if (PL.FINISHED.includes(st.stage)) { result = st.stage === 'done' ? 'done' : 'error'; break; }
        if (PL.PAUSED.includes(st.stage)) { result = 'paused'; break; }
        if (r === 'yield') { result = 'yield'; break; }
      }
    } catch (e) {
      st.stage = 'error'; st.error = String(e && e.stack || e).slice(0, 1500);
      pl_log_(st, 'error', st.error);
      result = 'error';
    }

    // §3.3 정체 감지 (단계 안에서 진행이 전혀 없는 채로 tick 이 계속 돌 때)
    if (!PL.FINISHED.includes(st.stage)) {
      const p = pl_progressValue_(st);
      const t = Date.now();
      if (p !== st.progress) { st.progress = p; st.lastChangeAt = t; }
      else {
        const limit = (st.stage === 'fig' && st.fig.submitted > 0) ? PL.STALL_FIG_MS : PL.STALL_MS;
        if (t - st.lastChangeAt > limit) {
          st.stage = 'error'; st.error = `${Math.round(limit / 60000)}분 무진행 (단계 ${pl_prevStage_(st)})`;
          pl_log_(st, 'error', st.error); result = 'error';
        }
      }
    }
    pl_saveState_(st);
    if (PL.FINISHED.includes(st.stage) && result !== 'idle') pl_finish_(st);
    return pl_tickResp_(st, result, t0);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function pl_prevStage_(st) { return st._lastStage || st.stage; }

function pl_tickResp_(st, result, t0) {
  return {
    ok: true,
    runId: st ? st.runId : null,
    result: result,
    stage: st ? st.stage : null,
    progress: pl_progress_(st),
    elapsedMs: Date.now() - t0
  };
}

/** 단계별 진행 지표 (§3.2) */
function pl_progressValue_(st) {
  switch (st.stage) {
    case 'latex': return st.latex.ok + st.latex.err;
    case 'fig': return st.fig.done + st.fig.err + st.fig.noPdf + st.fig.submittedTotal;
    case 'send': return st.ds.cursor;
    case 'normalize': return st.norm.cursor;
    case 'archive': return st.archive.cursor;
    default: return -1;                        // clear·search·answer 는 한 tick 안에 끝난다
  }
}

/** status·tick 공용 progress 객체 (A-06) */
function pl_progress_(st) {
  if (!st) return null;
  const f = st.fig || {}, l = st.latex || {}, n = st.norm || {};
  return {
    progress: st.progress, ticks: st.ticks,
    latexOk: l.ok || 0, latexErr: l.err || 0, latexLeft: l.left || 0,
    figDone: f.done || 0, figErr: f.err || 0, figNoPdf: f.noPdf || 0, figSubmitted: f.submitted || 0, figLeft: f.left || 0,
    normCursor: n.cursor || 0, normEnd: n.end || 0,
    sendCursor: st.ds ? st.ds.cursor : 0, sendTotal: st.ds ? st.ds.total : 0,
    lastChangeAt: st.lastChangeAt || 0, lastTickAt: st.lastTickAt || 0
  };
}

/** 한 단계 실행. 'next' | 'yield'(시간 부족, 같은 단계 재개) 반환 */
function pl_runStage_(st, deadline) {
  const ss = SpreadsheetApp.getActive();
  st._lastStage = st.stage;
  switch (st.stage) {

    case 'clear': {
      clearBelowHeader_(ss, PL.DATA1_SHEET);
      clearBelowHeader_(ss, PL.SRC_SHEET, { excludeFirstCol: true });
      SpreadsheetApp.flush();
      pl_log_(st, 'clear', 'Data1, Data_Latex 초기화 완료');
      st.stage = 'search'; return 'next';
    }

    case 'search': return pl_stageSearch_(st, ss, deadline);

    case 'latex': {
      const rows = pl_latexTargetRows_(ss);
      st.latex.left = rows.length;
      if (!rows.length) {
        const errRows = mpr_errorRows();
        st.latex.err = errRows.length;
        pl_report_(st, 'latex.error_rows', errRows.length, errRows.join(', '));
        pl_log_(st, 'latex', `변환 완료 — 성공 ${st.latex.ok}, error 행 ${errRows.length}`);
        if (st.opts.until === 'latex') st.stage = 'latex_done';
        else st.stage = st.opts.fig ? 'fig' : 'send';
        return 'next';
      }
      const r = mpr_convertRows(rows, deadline - pl_ocrGap_(), { fig: false });
      st.latex.ok += r.ok; st.latex.err += r.err; st.latex.left = rows.length - r.attempted;
      pl_log_(st, 'latex', `이번 회차 ${r.attempted}행 시도 (성공 ${r.ok}, 실패 ${r.err}) / 남은 대상 ${rows.length - r.attempted}`);
      return r.stoppedByTime ? 'yield' : 'next';
    }

    case 'latex_done':
    case 'fig_done':
      return 'yield';                           // pl_runSlice_ 가 먼저 걸러낸다

    case 'fig': {
      const src = ss.getSheetByName(PL.SRC_SHEET);
      const last = pl_lastNonEmptyRowInColA_(src);
      if (last < 2) { st.stage = (st.opts.until === 'done') ? 'send' : 'fig_done'; return 'next'; }
      const r = mpf_processBatchBudget(2, last, deadline, { rate: pl_prop_('PL_MPX_RATE_PER_MIN', 50) });
      st.fig.done = r.done; st.fig.err = r.err; st.fig.noPdf = r.noPdf;
      st.fig.submitted = r.submitted; st.fig.left = r.left; st.fig.submittedTotal += r.submittedNow;
      if (r.submitted + r.left > 0) return 'yield';
      pl_report_(st, 'fig.no_pdf', r.noPdfRows.length, r.noPdfRows.join(', '));
      pl_report_(st, 'fig.error', r.errRows.length, r.errRows.join(', '));
      pl_log_(st, 'fig', `그림 추출 끝 — done ${r.done}, error ${r.err}, no_pdf ${r.noPdf}`);
      st.stage = (st.opts.until === 'done') ? 'send' : 'fig_done';
      return 'next';
    }

    case 'send': return pl_stageSend_(st, ss, deadline);

    case 'normalize': {
      const sh = ss.getSheetByName(DSN.SHEET);
      if (!sh) throw new Error(`${DSN.SHEET} 시트를 찾을 수 없습니다.`);
      if (!st.norm.cursor) { st.norm.cursor = st.ds.writeStart; st.norm.end = st.ds.writeEnd; }
      while (st.norm.cursor <= st.norm.end && Date.now() < deadline - 15000) {
        const end = Math.min(st.norm.cursor + PL.NORM_CHUNK - 1, st.norm.end);
        const r = ds_normalizeRows_(sh, pl_range_(st.norm.cursor, end));
        pl_accumNorm_(st, r);
        st.norm.cursor = end + 1;
        pl_saveState_(st);
      }
      if (st.norm.cursor <= st.norm.end) return 'yield';
      pl_log_(st, 'normalize', `성공 ${st.norm.ok}, 실패 ${st.norm.fail}, 검토 ${st.norm.review.n}`);
      st.stage = 'answer'; return 'next';
    }

    case 'answer': {
      const dst = ss.getSheetByName(PL.DST_SHEET);
      const rows = pl_range_(st.ds.writeStart, st.ds.writeEnd);
      const s = ds_fillGivenAnswerRows_(dst, rows);
      st.ans = { ok: s.ok, miss: pl_slim_(st, 'ans.miss', s.miss), conflict: pl_slim_(st, 'ans.conflict', s.conflict), skipped: s.skipped };
      pl_log_(st, 'answer', `정답 성공 ${s.ok}, 미검출 ${s.miss.length}, 유형 불일치 ${s.conflict.length}`);
      st.stage = 'archive'; return 'next';
    }

    case 'archive': return pl_stageArchive_(st, ss, deadline);

    default:
      throw new Error('알 수 없는 단계: ' + st.stage);
  }
}

/* =================================================
 * search (P-10 skipExisting · C-18 행 수 대조)
 * ================================================= */
function pl_stageSearch_(st, ss, deadline) {
  const folder = getFolderByPath(PL.SEARCH_FOLDER);
  let sh = ss.getSheetByName(PL.DATA1_SHEET); if (!sh) sh = ss.insertSheet(PL.DATA1_SHEET);
  const seen = new Set();
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(r => { const v = String(r[0] || '').trim(); if (v) seen.add(v); });

  const existing = st.opts.skipExisting ? pl_dsKeySet_(ss) : null;
  const skippedAll = [];
  let written = 0;
  for (const kw of st.keywords) {
    if (st.search.n[kw] !== undefined) continue;   // 재개 시 중복 방지
    let skipped = 0;
    const pairs = collectPngNameUrlPairs(folder, kw).filter(p => {
      if (seen.has(p[0])) return false;
      if (existing) {
        const parsed = dlds_parseFilename_(p[0]);
        if (parsed && existing.has(nfc_(parsed.key))) { skipped++; skippedAll.push(nfc_(p[0])); return false; }
      }
      seen.add(p[0]); return true;
    });
    pairs.sort((a, b) => a[0].localeCompare(b[0], 'ko', { sensitivity: 'base', numeric: true }));
    if (pairs.length) {
      const startRow = Math.max(2, sh.getLastRow() + 1);
      sh.getRange(startRow, 1, pairs.length, 2).setValues(pairs);
    }
    st.search.n[kw] = pairs.length; st.search.skipped[kw] = skipped; written += pairs.length;
    pl_log_(st, 'search', `"${kw}" → ${pairs.length}건` + (skipped ? ` (Data_DS 기존 ${skipped}건 제외)` : ''));
    pl_saveState_(st);
    if (Date.now() > deadline) pl_log_(st, 'search', '예산 초과 — 순회는 중단할 수 없어 계속 진행');
  }
  SpreadsheetApp.flush();   // Data_Latex!A 가 Data1 을 참조하는 수식이면 여기서 반영
  if (skippedAll.length) pl_report_(st, 'search.skipped', skippedAll.length, skippedAll.join(', '));
  st.search.data1Rows = written;
  const all = Object.values(st.search.n).reduce((a, b) => a + b, 0);
  if (all === 0) throw new Error('키워드에 해당하는 PNG 파일이 없습니다.' + (skippedAll.length ? ` (Data_DS 기존 ${skippedAll.length}건은 제외됨)` : ''));

  // C-18: Data_Latex A열 비어있지 않은 행 수 == Data1 기록 행 수
  const src = ss.getSheetByName(PL.SRC_SHEET);
  if (!src) throw new Error(`${PL.SRC_SHEET} 시트를 찾을 수 없습니다.`);
  const srcRows = pl_countNonEmptyColA_(src);
  if (srcRows !== written) {
    pl_report_(st, 'search.mismatch', 1, `Data_Latex A열 ${srcRows}행 ≠ Data1 ${written}행`);
    throw new Error(`Data_Latex A열 행 수(${srcRows})가 Data1 기록 행 수(${written})와 다릅니다 — 시트 최대 행·A2 수식 확인 (sheetcheck)`);
  }
  st.stage = 'latex'; return 'next';
}

/** Data_DS A열 key 집합 (NFC) */
function pl_dsKeySet_(ss) {
  const dst = ss.getSheetByName(PL.DST_SHEET);
  const set = new Set();
  if (!dst) return set;
  const last = dlds_lastDataRow_(dst, 1);
  if (last >= 2) dst.getRange(2, DLDS.DST.key, last - 1, 1).getValues()
    .forEach(r => { const k = nfc_(String(r[0] || '')).trim(); if (k) set.add(k); });
  return set;
}

/* =================================================
 * Data_Latex 읽기 (C-06a)
 * ================================================= */
/** Data_Latex: A열 비어있지 않고, status≠done, attempts<MAX 인 행 목록 — A열 + E:F 만 읽는다 */
function pl_latexTargetRows_(ss) {
  const sh = ss.getSheetByName(PL.SRC_SHEET);
  if (!sh) throw new Error(`${PL.SRC_SHEET} 시트를 찾을 수 없습니다.`);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const a = sh.getRange(2, 1, last - 1, 1).getValues();          // A filename
  const ef = sh.getRange(2, 5, last - 1, 2).getValues();         // E status · F attempts
  const rows = [];
  a.forEach((r, i) => {
    const fname = String(r[0] || '').trim();
    if (!fname) return;
    const status = String(ef[i][0] || '').trim();
    const attempts = Number(ef[i][1] || 0);
    if (status === 'done') return;
    if (attempts >= PL.MAX_ATTEMPTS) return;
    rows.push(i + 2);
  });
  return rows;
}

function pl_lastNonEmptyRowInColA_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const v = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0] || '').trim()) return i + 2;
  return 1;
}
function pl_countNonEmptyColA_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  return sh.getRange(2, 1, last - 1, 1).getValues().filter(r => String(r[0] || '').trim()).length;
}

/* =================================================
 * send (D14 분할 읽기·100행 쓰기 · D19 완전 짝만 · C-06c)
 * ================================================= */
function pl_stageSend_(st, ss, deadline) {
  const src = ss.getSheetByName(DLDS.SRC_SHEET);
  const dst = ss.getSheetByName(DLDS.DST_SHEET);
  if (!src || !dst) throw new Error('Data_Latex 또는 Data_DS 시트를 찾을 수 없습니다.');
  const endRow = pl_lastNonEmptyRowInColA_(src);
  if (endRow < 2) { st.stage = 'archive'; return 'next'; }
  const n = endRow - 1;
  // D·J 를 빼고 세 범위로 읽는다 (C-05)
  const abc = src.getRange(2, 1, n, 3).getValues();                           // A filename · B · C latex
  const e   = src.getRange(2, DLDS.SRC.status, n, 1).getValues();             // E status
  const mn  = src.getRange(2, DLDS.SRC.fig_files, n, 2).getValues();          // M fig_files · N fig_links

  const pairs = new Map(); let order = 0;
  for (let i = 0; i < n; i++) {
    const fname = String(abc[i][0] || '').trim();
    if (!fname) continue;
    const status = String(e[i][0] || '').trim();
    if (DLDS.SEND_ONLY_DONE && status !== 'done') continue;
    const parsed = dlds_parseFilename_(fname);
    if (!parsed) continue;
    const latex = dlds_embedFigLinks_(String(abc[i][2] || ''), mn[i][0], mn[i][1]);
    if (!pairs.has(parsed.key)) pairs.set(parsed.key, { problem: null, solution: null, order: order++ });
    const p = pairs.get(parsed.key);
    if (parsed.kind === 'problem') p.problem = latex; else p.solution = latex;
  }

  const existing = pl_dsKeySet_(ss);                                           // 이미 쓴 묶음도 여기서 걸러진다 (재개)
  const rowsOut = [], skippedDup = [], incomplete = [];
  Array.from(pairs.entries()).sort((a, b) => a[1].order - b[1].order).forEach(([key, p]) => {
    if (existing.has(nfc_(key))) { skippedDup.push(key); return; }
    if (p.problem === null || p.solution === null) { incomplete.push(key + (p.problem === null ? '(문제 없음)' : '(해설 없음)')); return; }   // D19
    rowsOut.push([key, p.problem, p.solution]);
  });

  if (!st.ds.cursor) {                                                         // 첫 회차: 집계 기록
    st.ds.total = rowsOut.length + st.ds.count;
    st.ds.skippedDup = pl_slim_(st, 'send.skippedDup', skippedDup);
    st.ds.incomplete = pl_slim_(st, 'send.incomplete', incomplete);
  }
  if (!rowsOut.length) return pl_sendFinish_(st);

  let dstLast = dlds_lastDataRow_(dst, 1);                                     // C-06c: A열만으로 판정
  if (!st.ds.writeStart) { st.ds.writeStart = (dstLast >= 2) ? dstLast + 1 : 2; pl_saveState_(st); }   // writeStart 선저장
  let i = 0;
  while (i < rowsOut.length) {
    if (Date.now() > deadline - 20000) return 'yield';
    const chunk = rowsOut.slice(i, i + PL.SEND_CHUNK);
    const at = (dstLast >= 2) ? dstLast + 1 : 2;
    dst.getRange(at, DLDS.DST.key, chunk.length, 3).setValues(chunk);
    SpreadsheetApp.flush();
    dstLast = at + chunk.length - 1;
    st.ds.writeEnd = dstLast; st.ds.count += chunk.length; st.ds.cursor += chunk.length;
    pl_saveState_(st);
    i += chunk.length;
  }
  return pl_sendFinish_(st);
}

function pl_sendFinish_(st) {
  if (st.ds.writeStart) {                                                      // 강제 종료로 상태에 안 잡힌 묶음까지 시트 기준으로 확정
    const dst = SpreadsheetApp.getActive().getSheetByName(PL.DST_SHEET);
    const lastNow = dlds_lastDataRow_(dst, 1);
    if (lastNow >= st.ds.writeStart) { st.ds.writeEnd = lastNow; st.ds.count = lastNow - st.ds.writeStart + 1; st.ds.cursor = st.ds.count; }
  }
  pl_log_(st, 'send', `Data_DS 추가 ${st.ds.count}행` + (st.ds.count ? ` (행 ${st.ds.writeStart}~${st.ds.writeEnd})` : '') +
    ` / 기존 ${st.ds.skippedDup.n}건 건너뜀 / 불완전 짝 ${st.ds.incomplete.n}건 미전송`);
  if (st.ds.count) pl_report_(st, 'send.range', st.ds.count, `${st.ds.writeStart}~${st.ds.writeEnd}`);
  st.stage = st.ds.count ? 'normalize' : 'archive';
  return 'next';
}

/* =================================================
 * normalize 누적 · archive (C-13)
 * ================================================= */
function pl_accumNorm_(st, r) {
  st.norm.ok += r.ok; st.norm.fail += r.fail;
  if (r.failRows && r.failRows.length) pl_report_(st, 'norm.fail', r.failRows.length, r.failRows.join(', '));
  if (r.review && r.review.length) {
    pl_report_(st, 'norm.review', r.review.length, r.review.join(', '));
    st.norm.review.n += r.review.length;
    r.review.forEach(x => { if (st.norm.review.head.length < PL.HEAD_N) st.norm.review.head.push(x); });
  }
  Object.keys(r.warnCount || {}).forEach(k => {
    st.norm.warn[k] = (st.norm.warn[k] || 0) + r.warnCount[k];
    const rows = (r.warnRows && r.warnRows[k]) || [];
    if (rows.length) pl_report_(st, 'norm.warn', rows.length, k + ': ' + rows.join(', '));
  });
}

function pl_archiveSs_(st) {
  const sp = PropertiesService.getScriptProperties();
  let id = st.archive.ssId || sp.getProperty(PL.ARCH_SSID_PROP) || '';
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (_) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create(PL.ARCH_NAME); id = ss.getId(); sp.setProperty(PL.ARCH_SSID_PROP, id); }
  st.archive.ssId = id;
  return ss;
}

function pl_stageArchive_(st, ss, deadline) {
  const src = ss.getSheetByName(PL.SRC_SHEET);
  const last = src ? pl_lastNonEmptyRowInColA_(src) : 1;
  if (last < 2) { st.archive.done = true; pl_log_(st, 'archive', '보관할 행 없음'); st.stage = 'done'; return 'next'; }
  const arch = pl_archiveSs_(st);
  let sh;
  if (!st.archive.sheet) {
    const base = `${st.keywords.join('+')}_${Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd')}`.slice(0, 90);
    let name = base, k = 2;
    while (arch.getSheetByName(name)) name = `${base}_${k++}`;
    sh = arch.insertSheet(name);
    sh.getRange(1, 1, 1, PL.ARCH_COLS).setValues(src.getRange(1, 1, 1, PL.ARCH_COLS).getValues());
    st.archive.sheet = name; st.archive.cursor = 2; pl_saveState_(st);
  } else {
    sh = arch.getSheetByName(st.archive.sheet);
    if (!sh) throw new Error('아카이브 시트가 사라졌습니다: ' + st.archive.sheet);
  }
  while (st.archive.cursor <= last) {
    if (Date.now() > deadline - 20000) return 'yield';
    const n = Math.min(PL.ARCH_CHUNK, last - st.archive.cursor + 1);
    const vals = src.getRange(st.archive.cursor, 1, n, PL.ARCH_COLS).getValues();
    sh.getRange(st.archive.cursor, 1, n, PL.ARCH_COLS).setValues(vals);
    st.archive.cursor += n; pl_saveState_(st);
  }
  st.archive.done = true;
  pl_report_(st, 'archive.sheet', last - 1, `${st.archive.ssId} / ${st.archive.sheet}`);
  pl_log_(st, 'archive', `Data_Latex ${last - 1}행 → ${PL.ARCH_NAME} / ${st.archive.sheet}`);
  st.stage = 'done'; return 'next';
}

/* =================================================
 * sheetcheck (P-06′, 읽기 전용)
 * ================================================= */
function pl_sheetcheck_(keywords) {
  const ss = SpreadsheetApp.getActive();
  const info = name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return { missing: true };
    return { maxRows: sh.getMaxRows(), lastRow: sh.getLastRow(), maxCols: sh.getMaxColumns() };
  };
  const sp = PropertiesService.getScriptProperties();
  const out = { dataLatex: info(PL.SRC_SHEET), data1: info(PL.DATA1_SHEET), dataDs: info(PL.DST_SHEET), at: new Date().toISOString(),
                // 비밀 아님: 어느 Mathpix 키(앱 ID)를 쓰는지·속도 제한 속성 (R13). 키 값(APP_KEY)은 절대 싣지 않는다
                mathpixAppId: String(sp.getProperty('MATHPIX_APP_ID') || ''),
                mpxRatePerMin: Number(sp.getProperty('PL_MPX_RATE_PER_MIN') || 0) || null };
  const src = ss.getSheetByName(PL.SRC_SHEET);
  if (src) { try { out.dataLatex.a2Formula = String(src.getRange('A2').getFormula() || ''); } catch (_) { out.dataLatex.a2Formula = ''; } }
  const dst = ss.getSheetByName(PL.DST_SHEET);
  if (dst) {
    const last = dlds_lastDataRow_(dst, 1);
    out.dataDs.lastRow = last;
    const keys = (last >= 2) ? dst.getRange(2, 1, last - 1, 1).getValues().map(r => nfc_(String(r[0] || '')).toLowerCase()) : [];
    const ex = {};
    (keywords || []).forEach(kw => { const k = nfc_(kw).toLowerCase(); ex[kw] = keys.filter(x => x.indexOf(k) !== -1).length; });
    out.dataDs.existingKeys = ex;
    const sample = Math.min(100, Math.max(0, last - 1));
    if (sample > 0) {
      const bc = dst.getRange(last - sample + 1, 2, sample, 2).getValues();
      let tot = 0; bc.forEach(r => { tot += String(r[0] || '').length + String(r[1] || '').length; });
      out.dataDs.avgLenBC = Math.round(tot / sample / 2);
    } else out.dataDs.avgLenBC = 0;
  }
  return out;
}

/* =================================================
 * 상태 / 로그 / 보고 / 알림
 * ================================================= */
function pl_loadState_() {
  const s = PropertiesService.getScriptProperties().getProperty(PL.STATE_PROP);
  try { return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
function pl_saveState_(st) {
  const copy = Object.assign({}, st); delete copy._lastStage;
  PropertiesService.getScriptProperties().setProperty(PL.STATE_PROP, JSON.stringify(copy));
}
function pl_clearTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === PL.TICK_FN) ScriptApp.deleteTrigger(t);
  });
}
function pl_range_(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

/** 진행 중인 런이 있는가 (메뉴 가드 E-05). ⏸ 도 진행 중으로 본다 */
function pl_isBusy_() {
  const st = pl_loadState_();
  return !!(st && !PL.FINISHED.includes(st.stage));
}
function pl_busyMessage_() {
  const st = pl_loadState_();
  return `파이프라인이 진행 중입니다 (단계 ${st ? st.stage : '?'}, 키워드 ${st ? (st.keywords || []).join(', ') : ''}). 끝나거나 중지한 뒤에 쓰세요.`;
}

/** 목록 → {n, head} 로 줄이고 전체는 Pipeline_Report 에 (R-03) */
function pl_slim_(st, label, arr) {
  arr = arr || [];
  if (arr.length) pl_report_(st, label, arr.length, arr.join(', '));
  return { n: arr.length, head: arr.slice(0, PL.HEAD_N) };
}

function pl_report_(st, label, n, detail) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(PL.REPORT_SHEET);
    if (!sh) { sh = ss.insertSheet(PL.REPORT_SHEET); sh.appendRow(['time', 'runId', 'stage', 'label', 'n', 'detail']); }
    const text = String(detail == null ? '' : detail);
    const parts = [];
    for (let i = 0; i < Math.max(text.length, 1); i += PL.REPORT_CELL_MAX) parts.push(text.slice(i, i + PL.REPORT_CELL_MAX));
    parts.forEach((p, i) => sh.appendRow([new Date(), st ? st.runId : '', st ? st.stage : '', label + (i ? `(${i + 1})` : ''), n, p]));
  } catch (_) {}
}

function pl_log_(st, stage, msg) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(PL.LOG_SHEET);
    if (!sh) { sh = ss.insertSheet(PL.LOG_SHEET); sh.appendRow(['time', 'run', 'stage', 'message']); }
    sh.appendRow([new Date(), st ? st.startedAt : '', stage, String(msg).slice(0, PL.REPORT_CELL_MAX)]);
  } catch (_) {}
}
function pl_toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, '파이프라인', 8); } catch (_) {}
}
function pl_hasUi_() {
  try { SpreadsheetApp.getUi(); return true; } catch (_) { return false; }
}

function pl_summary_(st) {
  const lines = [
    `단계: ${st.stage}`,
    `키워드: ${st.keywords.join(' | ')}`,
    `시작: ${st.startedAt}   tick: ${st.ticks || 0}회   until=${st.opts ? st.opts.until : '?'}`
  ];
  const s = Object.entries((st.search && st.search.n) || {});
  if (s.length) lines.push(`검색: ` + s.map(([k, n]) => `${k}=${n}` + (st.search.skipped[k] ? `(기존 ${st.search.skipped[k]} 제외)` : '')).join(', '));
  if (st.latex) lines.push(`Latex 변환: 성공 ${st.latex.ok}, 실패 ${st.latex.err}, 남음 ${st.latex.left}`);
  if (st.fig && (st.fig.done || st.fig.err || st.fig.noPdf)) lines.push(`그림: done ${st.fig.done}, error ${st.fig.err}, no_pdf ${st.fig.noPdf}`);
  if (st.ds && st.ds.count) lines.push(`Data_DS: ${st.ds.count}행 추가 (행 ${st.ds.writeStart}~${st.ds.writeEnd})` +
    (st.ds.skippedDup.n ? ` / 기존 ${st.ds.skippedDup.n}건 건너뜀` : '') + (st.ds.incomplete.n ? ` / 불완전 짝 ${st.ds.incomplete.n}건 미전송` : ''));
  if (st.norm && (st.norm.ok || st.norm.fail)) lines.push(`정규화: 성공 ${st.norm.ok}, 실패 ${st.norm.fail}, 검토 필요 ${st.norm.review.n}` +
    (Object.keys(st.norm.warn).length ? ` / 경고 ` + Object.entries(st.norm.warn).map(([k, v]) => `${k} ${v}`).join(', ') : ''));
  if (st.ans && (st.ans.ok || st.ans.miss.n)) lines.push(`정답: 성공 ${st.ans.ok}, 미검출 ${st.ans.miss.n}` +
    (st.ans.miss.n ? ` (행 ${st.ans.miss.head.join(', ')}${st.ans.miss.n > PL.HEAD_N ? ' …' : ''})` : '') +
    (st.ans.conflict.n ? `, 유형 불일치 ${st.ans.conflict.n}` : ''));
  if (st.archive && st.archive.done) lines.push(`보관: ${st.archive.sheet}`);
  if (st.error) lines.push(`오류: ${st.error}`);
  lines.push(`전체 목록은 ${PL.REPORT_SHEET} 시트 참고`);
  return lines.join('\n');
}

function pl_finish_(st) {
  const title = st.stage === 'done' ? '파이프라인 완료' : '파이프라인 오류';
  const body = pl_summary_(st);
  pl_log_(st, st.stage, '종료');
  if (pl_hasUi_()) {
    try { SpreadsheetApp.getUi().alert(title, body, SpreadsheetApp.getUi().ButtonSet.OK); return; } catch (_) {}
  }
  if (PL.EMAIL_ON_FINISH) {
    try {
      const email = Session.getEffectiveUser().getEmail();
      if (email) MailApp.sendEmail(email, `[${SpreadsheetApp.getActive().getName()}] ${title}`, body);
    } catch (_) {}
  }
}
