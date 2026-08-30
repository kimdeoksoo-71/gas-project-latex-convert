/*************************************************
 * Pipeline.gs — 키워드 입력 한 번으로 7단계 자동 실행
 *
 *  [메뉴] ▶ 원클릭 파이프라인 : pipeline_start
 *  [메뉴] ⏹ 파이프라인 중지   : pipeline_stop
 *  [메뉴] 📋 파이프라인 상태   : pipeline_status
 *
 *  단계(stage)
 *   1. clear     : Data1 전체 + Data_Latex(B열~) 2행 이하 초기화   (= Latex 초기화)
 *   2. search    : 키워드마다 PBMAI/IMAGE_DS 검색 → Data1!A:B 이어붙이기 (= 문항찾기 : 키워드)
 *   3. latex     : Data_Latex 에서 A열이 비어있지 않고 status≠done 인 행을 Mathpix 변환
 *                  → 6분 제한에 걸리면 상태를 저장하고 1분 뒤 시간 트리거로 자동 이어하기
 *   4. send      : Data_Latex → Data_DS (짝 맞추기, 이어붙이기)
 *   5. normalize : 넘어온 행 문항 정규화 (E~K)
 *   6. answer    : 넘어온 행 given_answer(D) 채우기
 *   7. done
 *
 *  ※ normalize 를 answer 보다 먼저 두는 이유:
 *     K(answer_type)가 먼저 채워져야 정답을 ①~⑤ / 정수로 맞춰 쓰고, 유형 불일치도 잡힙니다.
 *     원래 순서(정답 → 정규화)를 원하면 PL.NORMALIZE_BEFORE_ANSWER = false 로 바꾸세요.
 *
 *  의존(기존 파일의 전역 함수):
 *   clearBelowHeader_            (Data1, Data_Latex 초기화.gs)
 *   getFolderByPath, collectPngNameUrlPairs (링크&파일명 추출(키워드).gs)
 *   mpr_convertRows              (Mathpix 범위 자동변환.gs — _MPR 에 패치 필요)
 *   dlds_parseFilename_, dlds_lastDataRow_, ds_fillGivenAnswerRows_, DLDS (DataLatex_to_DataDS.gs)
 *   ds_normalizeRows_, ds_statSummary_, DSN (normalizeProblem.gs 2026-08-30 보완판 — 메뉴 '문항 정규화'와 같은 코어)
 *************************************************/

const PL = {
  STATE_PROP: 'PL_STATE',
  TICK_FN: 'pipeline_tick',
  TIME_BUDGET_MS: 4 * 60 * 1000,   // 한 번의 실행에서 쓰는 시간 (6분 제한 대비 여유)
  RESUME_AFTER_MS: 60 * 1000,      // 이어하기 트리거 지연 (최소 1분)
  MAX_RESUMES: 60,                 // 무한 이어하기 방지
  SEARCH_FOLDER: 'PBMAI/IMAGE_DS',
  DATA1_SHEET: 'Data1',
  SRC_SHEET: 'Data_Latex',
  DST_SHEET: 'Data_DS',
  LOG_SHEET: 'Pipeline_Log',
  MAX_ATTEMPTS: 3,                 // Latex 변환 재시도 상한 (_MPR.CFG.MAX_ATTEMPTS 와 동일하게)
  NORMALIZE_BEFORE_ANSWER: true,
  EMAIL_ON_FINISH: true            // 트리거로 끝났을 때(알림창 불가) 메일로 결과 통지
};

/* =================================================
 * 메뉴 진입점
 * ================================================= */
function pipeline_start() {
  const ui = SpreadsheetApp.getUi();

  const cur = pl_loadState_();
  if (cur && !['done', 'error', 'stopped'].includes(cur.stage)) {
    const r = ui.alert('진행 중인 파이프라인이 있습니다',
      `현재 단계: ${cur.stage}\n키워드: ${cur.keywords.join(', ')}\n\n중단하고 새로 시작할까요?`,
      ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
    pl_clearTriggers_();
  }

  const res = ui.prompt('원클릭 파이프라인',
    '키워드를 입력하세요. 여러 개면 쉼표(,) 또는 줄바꿈으로 구분\n예: 2021 미적분, 2022 확통',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const keywords = Array.from(new Set(
    String(res.getResponseText() || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)
  ));
  if (!keywords.length) { ui.alert('키워드가 비어 있습니다.'); return; }

  const ok = ui.alert('확인',
    `키워드 ${keywords.length}개: ${keywords.join(' | ')}\n\n` +
    `${PL.DATA1_SHEET}, ${PL.SRC_SHEET}(B열~)의 2행 이하를 초기화한 뒤\n` +
    `검색 → Latex 변환 → Data_DS 전송 → 정규화 → 정답 채우기 를 자동 실행합니다.\n` +
    `Latex 변환이 길면 백그라운드에서 자동으로 이어집니다. 계속할까요?`,
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const st = {
    stage: 'clear', keywords, startedAt: new Date().toISOString(),
    resumes: 0, search: {}, latex: { ok: 0, err: 0 }, ds: null, norm: null, ans: null, error: ''
  };
  pl_saveState_(st);
  pl_log_(st, 'start', `키워드: ${keywords.join(' | ')}`);
  pipeline_tick();
}

function pipeline_stop() {
  const st = pl_loadState_();
  pl_clearTriggers_();
  if (st && !['done', 'error', 'stopped'].includes(st.stage)) {
    st.stage = 'stopped'; pl_saveState_(st); pl_log_(st, 'stopped', '사용자 중지');
  }
  try { SpreadsheetApp.getUi().alert('파이프라인을 중지했습니다. (예약된 이어하기 트리거 삭제)'); } catch (_) {}
}

function pipeline_status() {
  const st = pl_loadState_();
  const ui = SpreadsheetApp.getUi();
  if (!st) { ui.alert('실행 이력이 없습니다.'); return; }
  ui.alert('파이프라인 상태', pl_summary_(st), ui.ButtonSet.OK);
}

/* =================================================
 * 실행 엔진 — 메뉴에서 직접, 또는 시간 트리거에서 호출
 * ================================================= */
function pipeline_tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;           // 동시 실행 방지

  const deadline = Date.now() + PL.TIME_BUDGET_MS;
  let st = pl_loadState_();
  try {
    pl_clearTriggers_();                            // 1회용 트리거 정리
    if (!st || ['done', 'error', 'stopped'].includes(st.stage)) return;

    let needResume = false;
    while (Date.now() < deadline) {
      const r = pl_runStage_(st, deadline);         // st.stage 를 진행시킴
      pl_saveState_(st);
      if (['done', 'error'].includes(st.stage)) break;
      if (r === 'yield') { needResume = true; break; }
    }
    if (!['done', 'error'].includes(st.stage) && (needResume || Date.now() >= deadline)) {
      if (st.resumes >= PL.MAX_RESUMES) throw new Error(`이어하기 횟수 초과 (${PL.MAX_RESUMES})`);
      st.resumes++; pl_saveState_(st);
      ScriptApp.newTrigger(PL.TICK_FN).timeBased().after(PL.RESUME_AFTER_MS).create();
      pl_log_(st, st.stage, `시간 예산 소진 → ${Math.round(PL.RESUME_AFTER_MS / 1000)}초 뒤 자동 이어하기 (#${st.resumes})`);
      pl_toast_(`Latex 변환 진행 중… 백그라운드에서 자동으로 이어집니다 (이어하기 #${st.resumes})`);
      return;
    }
  } catch (e) {
    if (st) { st.stage = 'error'; st.error = String(e && e.stack || e); pl_saveState_(st); pl_log_(st, 'error', st.error); }
    pl_clearTriggers_();
  } finally {
    lock.releaseLock();
  }
  if (st && ['done', 'error'].includes(st.stage)) pl_finish_(st);
}

/** 한 단계 실행. 'next' | 'yield'(시간 부족, 같은 단계 재개) 반환 */
function pl_runStage_(st, deadline) {
  const ss = SpreadsheetApp.getActive();
  switch (st.stage) {

    case 'clear': {
      clearBelowHeader_(ss, PL.DATA1_SHEET);
      clearBelowHeader_(ss, PL.SRC_SHEET, { excludeFirstCol: true });
      SpreadsheetApp.flush();
      pl_log_(st, 'clear', 'Data1, Data_Latex 초기화 완료');
      st.stage = 'search'; return 'next';
    }

    case 'search': {
      const folder = getFolderByPath(PL.SEARCH_FOLDER);
      let sh = ss.getSheetByName(PL.DATA1_SHEET); if (!sh) sh = ss.insertSheet(PL.DATA1_SHEET);
      const seen = new Set();
      const last = sh.getLastRow();
      if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(r => { const v = String(r[0] || '').trim(); if (v) seen.add(v); });

      let total = 0;
      for (const kw of st.keywords) {
        if (st.search[kw] !== undefined) continue;   // 재개 시 중복 방지
        const pairs = collectPngNameUrlPairs(folder, kw).filter(p => {
          if (seen.has(p[0])) return false; seen.add(p[0]); return true;
        });
        pairs.sort((a, b) => a[0].localeCompare(b[0], 'ko', { sensitivity: 'base', numeric: true }));
        if (pairs.length) {
          const startRow = Math.max(2, sh.getLastRow() + 1);
          sh.getRange(startRow, 1, pairs.length, 2).setValues(pairs);
        }
        st.search[kw] = pairs.length; total += pairs.length;
        pl_log_(st, 'search', `"${kw}" → ${pairs.length}건`);
        pl_saveState_(st);
      }
      SpreadsheetApp.flush();   // Data_Latex!A 가 Data1 을 참조하는 수식이면 여기서 반영
      const all = Object.values(st.search).reduce((a, b) => a + b, 0);
      if (all === 0) throw new Error('키워드에 해당하는 PNG 파일이 없습니다.');
      st.stage = 'latex'; return 'next';
    }

    case 'latex': {
      const rows = pl_latexTargetRows_(ss);
      if (!rows.length) {
        pl_log_(st, 'latex', `변환 완료 — 성공 ${st.latex.ok}, 실패 ${st.latex.err}`);
        st.stage = 'send'; return 'next';
      }
      // 마지막 행 처리 중 6분 초과 방지: 재시도 포함 최대 대기를 감안해 여유를 둔다
      const r = mpr_convertRows(rows, deadline - 40 * 1000);
      st.latex.ok += r.ok; st.latex.err += r.err;
      pl_log_(st, 'latex', `이번 회차 ${r.attempted}행 시도 (성공 ${r.ok}, 실패 ${r.err}) / 남은 대상 ${rows.length - r.attempted}`);
      return r.stoppedByTime ? 'yield' : 'next';   // 'next' 면 다시 latex 로 들어와 남은 행(재시도 포함) 확인
    }

    case 'send': {
      const src = ss.getSheetByName(PL.SRC_SHEET);
      const endRow = pl_lastNonEmptyRowInColA_(src);
      const r = pl_sendPairs_(ss, 2, endRow);
      st.ds = r;
      pl_log_(st, 'send',
        `Data_DS 추가 ${r.count}행 (행 ${r.writeStart}~${r.writeEnd})` +
        (r.skippedDup.length ? ` / 기존 ${r.skippedDup.length}건 건너뜀` : '') +
        (r.onlyProblem.length ? ` / 해설 없음: ${r.onlyProblem.join(', ')}` : '') +
        (r.onlySolution.length ? ` / 문제 없음: ${r.onlySolution.join(', ')}` : ''));
      if (r.count === 0) { st.stage = 'done'; return 'next'; }
      st.stage = PL.NORMALIZE_BEFORE_ANSWER ? 'normalize' : 'answer'; return 'next';
    }

    case 'normalize': {
      const rows = pl_range_(st.ds.writeStart, st.ds.writeEnd);
      st.norm = pl_normalizeRows_(ss, rows);
      pl_log_(st, 'normalize', ds_statSummary_(st.norm).replace(/\n/g, ' / '));
      st.stage = (PL.NORMALIZE_BEFORE_ANSWER && !st.ans) ? 'answer' : 'done'; return 'next';
    }

    case 'answer': {
      const dst = ss.getSheetByName(PL.DST_SHEET);
      const rows = pl_range_(st.ds.writeStart, st.ds.writeEnd);
      const s = ds_fillGivenAnswerRows_(dst, rows);
      st.ans = { ok: s.ok, miss: s.miss, conflict: s.conflict, skipped: s.skipped };
      pl_log_(st, 'answer', `정답 성공 ${s.ok}, 미검출 ${s.miss.length}` +
        (s.miss.length ? ` (행 ${s.miss.join(', ')})` : '') +
        (s.conflict.length ? ` / 유형 불일치 행 ${s.conflict.join(', ')}` : ''));
      st.stage = (!PL.NORMALIZE_BEFORE_ANSWER && !st.norm) ? 'normalize' : 'done'; return 'next';
    }

    default:
      throw new Error('알 수 없는 단계: ' + st.stage);
  }
}

/* =================================================
 * 단계별 코어 (UI 없음)
 * ================================================= */

/** Data_Latex: A열 비어있지 않고, status≠done, attempts<MAX 인 행 목록 */
function pl_latexTargetRows_(ss) {
  const sh = ss.getSheetByName(PL.SRC_SHEET);
  if (!sh) throw new Error(`${PL.SRC_SHEET} 시트를 찾을 수 없습니다.`);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const v = sh.getRange(2, 1, last - 1, 6).getValues(); // A~F (filename..attempts)
  const rows = [];
  v.forEach((r, i) => {
    const fname = String(r[0] || '').trim();
    if (!fname) return;
    const status = String(r[4] || '').trim();
    const attempts = Number(r[5] || 0);
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

/** dl_sendPairsToDataDS 의 UI 없는 버전 (정답 채우기는 별도 단계에서) */
function pl_sendPairs_(ss, startRow, endRow) {
  const src = ss.getSheetByName(DLDS.SRC_SHEET);
  const dst = ss.getSheetByName(DLDS.DST_SHEET);
  const out = { count: 0, writeStart: 0, writeEnd: 0, skippedDup: [], onlyProblem: [], onlySolution: [] };
  if (endRow < startRow) return out;

  const rows = src.getRange(startRow, 1, endRow - startRow + 1, DLDS.SRC.status).getValues();
  const pairs = new Map(); let order = 0;
  rows.forEach(r => {
    const fname = String(r[DLDS.SRC.filename - 1] || '').trim();
    if (!fname) return;
    const status = String(r[DLDS.SRC.status - 1] || '').trim();
    if (DLDS.SEND_ONLY_DONE && status !== 'done') return;
    const parsed = dlds_parseFilename_(fname);
    if (!parsed) return;
    const latex = String(r[DLDS.SRC.latex - 1] || '');
    if (!pairs.has(parsed.key)) pairs.set(parsed.key, { problem: null, solution: null, order: order++ });
    const p = pairs.get(parsed.key);
    if (parsed.kind === 'problem') p.problem = latex; else p.solution = latex;
  });

  const existing = new Set();
  const dstLast = dlds_lastDataRow_(dst, 3);
  if (dstLast >= 2) dst.getRange(2, DLDS.DST.key, dstLast - 1, 1).getValues()
    .forEach(r => { const k = String(r[0] || '').trim(); if (k) existing.add(k); });

  const rowsOut = [];
  Array.from(pairs.entries()).sort((a, b) => a[1].order - b[1].order).forEach(([key, p]) => {
    if (existing.has(key)) { out.skippedDup.push(key); return; }
    if (p.problem === null && p.solution !== null) { out.onlySolution.push(key); return; }
    if (p.solution === null) out.onlyProblem.push(key);
    rowsOut.push([key, p.problem || '', p.solution || '']);
  });
  if (!rowsOut.length) return out;

  out.writeStart = (dstLast >= 2) ? dstLast + 1 : 2;
  dst.getRange(out.writeStart, DLDS.DST.key, rowsOut.length, 3).setValues(rowsOut);
  out.writeEnd = out.writeStart + rowsOut.length - 1;
  out.count = rowsOut.length;
  return out;
}

/** 문항 정규화 (메뉴 '⏺️ 문항 정규화' 와 동일한 코어 ds_normalizeRows_ 사용)
 *  반환: { ok, fail, failRows, review[], warnCount{}, warnRows{} }
 *   - review  : K=NEED_REVIEW:… 로 남긴 행 (객관식 번호인데 선지 5개를 못 찾음)
 *   - warnCount: TRAILER_DROPPED / NUM_MISMATCH / CHOICE_ORDER_… 등 경고 집계
 */
function pl_normalizeRows_(ss, rows) {
  const sh = ss.getSheetByName(DSN.SHEET);
  if (!sh) throw new Error(`${DSN.SHEET} 시트를 찾을 수 없습니다.`);
  return ds_normalizeRows_(sh, rows);
}

/* =================================================
 * 상태 / 로그 / 알림
 * ================================================= */
function pl_loadState_() {
  const s = PropertiesService.getScriptProperties().getProperty(PL.STATE_PROP);
  try { return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
function pl_saveState_(st) {
  PropertiesService.getScriptProperties().setProperty(PL.STATE_PROP, JSON.stringify(st));
}
function pl_clearTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === PL.TICK_FN) ScriptApp.deleteTrigger(t);
  });
}
function pl_range_(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

function pl_log_(st, stage, msg) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(PL.LOG_SHEET);
    if (!sh) { sh = ss.insertSheet(PL.LOG_SHEET); sh.appendRow(['time', 'run', 'stage', 'message']); }
    sh.appendRow([new Date(), st ? st.startedAt : '', stage, msg]);
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
    `시작: ${st.startedAt}   이어하기: ${st.resumes}회`
  ];
  const s = Object.entries(st.search || {});
  if (s.length) lines.push(`검색: ` + s.map(([k, n]) => `${k}=${n}`).join(', '));
  if (st.latex) lines.push(`Latex 변환: 성공 ${st.latex.ok}, 실패 ${st.latex.err}`);
  if (st.ds) lines.push(`Data_DS: ${st.ds.count}행 추가 (행 ${st.ds.writeStart}~${st.ds.writeEnd})`);
  if (st.norm) lines.push(`정규화: ` + ds_statSummary_(st.norm).replace(/\n/g, '\n        '));
  if (st.ans) lines.push(`정답: 성공 ${st.ans.ok}, 미검출 ${st.ans.miss.length}` +
    (st.ans.miss.length ? ` (행 ${st.ans.miss.join(', ')})` : '') +
    (st.ans.conflict.length ? `, 유형 불일치 행 ${st.ans.conflict.join(', ')}` : ''));
  if (st.error) lines.push(`오류: ${st.error}`);
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