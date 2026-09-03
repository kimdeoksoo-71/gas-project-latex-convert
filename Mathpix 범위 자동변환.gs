/*************************************************
 * Mathpix 범위 변환 — 자동 이어하기 버전
 * - 한 번만 범위 입력 (예: 2-200)
 * - 실행시간 한도(6분) 도달 전에 스스로 중단하고
 *   1분 뒤 트리거로 자동 재개 → 전체 완료까지 무인 진행
 * - status='done' 행은 건너뛰므로 중복 처리 없음
 *
 * [패치 1 · diagram 감지]
 * - Mathpix 호출에 include_line_data:true 를 추가하고,
 *   응답 line_data 중 type 이 diagram/chart 인 항목의 윤곽(cnt)을
 *   바운딩 박스로 환산해 Data_Latex 에 기록한다.
 *     I열 has_diagram   : TRUE / FALSE
 *     J열 diagram_boxes : JSON  {"w":이미지폭,"h":이미지높이,"n":개수,
 *                               "boxes":[{"type":"diagram","subtype":"","x":..,"y":..,"w":..,"h":..},...]}
 *   (x,y,w,h 는 원본 이미지 기준 픽셀. 자르기 단계에서 여백을 더해 사용)
 * - 헤더(I1/J1)가 비어 있으면 자동으로 채운다.
 * - 디버그용 mpr_debugLineData(): 행 하나를 골라 line_data 타입 요약을 로그/알림으로 확인
 *
 * [패치 4 · 그림 추출 통합]  (Mathpix 그림 추출.gs 의 _MPF 가 있어야 동작, 없으면 조용히 건너뜀)
 * - OCR 후 has_diagram=TRUE 이면 같은 자리에서 _MPF 로 문항 PDF 를 v3/pdf 에 보내 그림을 받아온다.
 * - 그림까지 끝나야 status='done'. Mathpix 가 아직 처리 중이면 status='fig_pending' 으로 두고
 *   다음 배치(트리거 재개 / Pipeline 의 다음 회차)에서 OCR 없이 그림 수집만 이어서 한다.
 *   → Pipeline 은 status≠done 행을 다시 넘겨주므로 Pipeline.gs 수정 없이 그림까지 완료된 뒤 send 단계로 넘어간다.
 * - PDF 가 없거나(no_pdf) 그림 단계가 실패(error)하면 파이프라인을 막지 않도록 status='done' 으로 두고
 *   L열 fig_status 에만 사유를 남긴다 (나중에 메뉴 "그림 추출"로 따로 재시도).
 * - _MPF.CFG.INTO_LATEX=true(기본) 이면 그림이 1개 이상 저장된 행은 C열(latex)을 O열(latex_fig,
 *   \includegraphics 포함)로 바꾸고, 원래 v3/text 결과는 D열(text)에 보관한다.
 *
 * [패치 10 · LaTeX 정합성 검사]
 * - 변환 직후 결과 LaTeX 의 괄호·구분자 정합성을 검사해 P열 latex_warn 에 기록한다.
 *   검사 항목:
 *     ① \right. / \left.  잔존  — Mathpix 가 닫는(여는) 괄호를 찾지 못했다는 신호
 *     ② \left ↔ \right 짝 불일치
 *     ③ ( ) 개수 불일치   ④ { } 개수 불일치(이스케이프 \{ \} 제외)   ⑤ [ ] 개수 불일치
 *     ⑥ $ 구분자 홀수 개
 *   예) 지수 분수가 닫는 괄호 위에 걸친 (2^3×3)^{1/3} 을 3^{1/3} 로 잘못 붙이고
 *       닫는 괄호를 \right. 로 처리한 오인식 → ①·③ 에 걸림.
 * - 걸린 행은 P열에 사유가 적히고 셀이 붉게 표시된다. 비면 정상.
 * - 그림 추출(INTO_LATEX)로 C열이 latex_fig 로 교체된 뒤에는 교체본을 다시 검사한다.
 *************************************************/
const _MPR = (function () {
  const CFG = {
    SHEET_NAME: 'Data_Latex',
    COLS: { filename:1, drive_link:2, latex:3, text:4, status:5, attempts:6, last_error:7, processed_at:8,
            has_diagram:9, diagram_boxes:10, latex_warn:16 },        // P열 (K~O 는 그림 추출이 사용)
    WARN_HEADER: 'latex_warn',                                       // P1
    WARN_BG: '#fce8e6',                                              // 경고 셀 배경(연붉음)
    FIG: {
      ENABLED: true,            // OCR 직후 그림 추출까지 한 번에 (C열 교체 여부는 _MPF.CFG.INTO_LATEX)
      MAX_WAIT_MS: 150 * 1000   // 한 행의 그림 처리를 기다리는 최대 시간 (배치 deadline 이 더 가까우면 그쪽 우선)
    },
    DIAGRAM_HEADERS: ['has_diagram', 'diagram_boxes'],   // I1, J1
    DIAGRAM_TYPES: ['diagram', 'chart'],                 // line_data.type 중 그림으로 취급할 값
    PROP_START: 'MPR_RANGE_START',
    PROP_END:   'MPR_RANGE_END',
    PROP_STOP:  'MPR_STOP_FLAG',
    HANDLER: 'mpr__continueRange',       // 트리거 핸들러 이름
    TIME_BUDGET_MS: 5 * 60 * 1000,       // 5분 예산
    SAFETY_GAP_MS: 40 * 1000,            // 40초 여유
    MAX_ATTEMPTS: 3
  };

  function getSheet_() {
    return SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_NAME);
  }

  /** I1/J1 헤더가 비어 있으면 채움 (기존 헤더는 건드리지 않음) */
  function ensureDiagramHeader_(sh) {
    const rng = sh.getRange(1, CFG.COLS.has_diagram, 1, 2);
    const cur = rng.getValues()[0];
    if (!String(cur[0] || '').trim() && !String(cur[1] || '').trim()) {
      rng.setValues([CFG.DIAGRAM_HEADERS]);
    }
    const wr = sh.getRange(1, CFG.COLS.latex_warn);                  // 패치 10: P1 헤더
    if (!String(wr.getValue() || '').trim()) wr.setValue(CFG.WARN_HEADER);
  }

  /** ===== 패치 10: LaTeX 정합성 검사. 이상 없으면 '' ===== */
  function lintLatex_(text) {
    const t = String(text || '');
    if (!t) return '';
    const n = function (re) { return (t.match(re) || []).length; };
    const warns = [];
    const rdot = n(/\\right\s*\./g), ldot = n(/\\left\s*\./g);
    if (rdot) warns.push('\\right. ' + rdot + '개(닫는 괄호 소실 의심)');
    // \left. 는 정적분 계산막대 \left. … \right| 에서 정상적으로 쓰이므로 그만큼은 눈감아 준다
    const evalBar = n(/\\right\s*\|/g);
    if (ldot > evalBar) warns.push('\\left. ' + ldot + '개(여는 괄호 소실 의심)');
    const nl = n(/\\left(?![a-zA-Z])/g), nr = n(/\\right(?![a-zA-Z])/g);   // \leftarrow 등 제외
    if (nl !== nr) warns.push('\\left ' + nl + ' ≠ \\right ' + nr);
    const po = n(/\(/g), pc = n(/\)/g);
    if (po !== pc) warns.push('( ' + po + ' ≠ ) ' + pc);
    const bo = n(/(?<!\\)\{/g), bc = n(/(?<!\\)\}/g);
    if (bo !== bc) warns.push('{ ' + bo + ' ≠ } ' + bc);
    const so = n(/\[/g), sc = n(/\]/g);
    if (so !== sc) warns.push('[ ' + so + ' ≠ ] ' + sc);
    if (n(/\$/g) % 2 === 1) warns.push('$ 홀수 개');
    return warns.join(' / ');
  }

  /** 패치 10: 현재 C열 내용을 검사해 P열에 기록 (경고면 붉은 배경) */
  function writeLint_(sh, row) {
    const warn = lintLatex_(sh.getRange(row, CFG.COLS.latex).getValue());
    const cell = sh.getRange(row, CFG.COLS.latex_warn);
    cell.setValue(warn);
    cell.setBackground(warn ? CFG.WARN_BG : null);
    return warn;
  }

  function getMathpixCreds_() {
    const sp = PropertiesService.getScriptProperties();
    const app_id  = (sp.getProperty('MATHPIX_APP_ID')  || '').trim();
    const app_key = (sp.getProperty('MATHPIX_APP_KEY') || '').trim();
    if (!app_id || !app_key) throw new Error('Mathpix 키가 비어 있습니다.');
    return { app_id, app_key };
  }

  function extractFileId_(s){
    const m = (s || '').match(/[-\w]{25,}/);
    if (!m) throw new Error('fileId parse failed: ' + s);
    return m[0];
  }

  /** Drive 파일 → data URL */
  function driveFileToDataUrl_(linkOrId) {
    const fileId = extractFileId_(linkOrId);
    const blob = DriveApp.getFileById(fileId).getBlob();
    return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  }

  /** Mathpix v3/text 요청 본문 (한 곳에서만 관리) */
  function buildPayload_(dataUrl) {
    return {
      src: dataUrl,
      formats: ['text'],
      rm_spaces: true,
      math_inline_delimiters: ['$', '$'],
      math_block_delimiters: ['$$', '$$'],
      enable_tables: true,
      confidence_threshold: 0.0,
      include_line_data: true          // ← 패치 1: 줄 단위 정보(그림 좌표 포함) 요청
    };
  }

  function callMathpix_(creds, payload) {
    const opt = {
      method:'post', contentType:'application/json',
      headers:{ 'app_id':creds.app_id, 'app_key':creds.app_key },
      payload: JSON.stringify(payload), muteHttpExceptions:true
    };
    for (let i = 0; i < 6; i++) {
      const res = UrlFetchApp.fetch('https://api.mathpix.com/v3/text', opt);
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) return JSON.parse(res.getContentText());
      if (code === 401) throw new Error('401 Unauthorized: ' + res.getContentText());
      if ([429,500,502,503,504].includes(code) && i < 5) {
        Utilities.sleep(Math.min(700 * Math.pow(2, i) + Math.random() * 400, 15000));
        continue;
      }
      throw new Error('Mathpix error ' + code + ': ' + res.getContentText());
    }
    throw new Error('Mathpix retry exhausted');
  }

  /** ===== 패치 1: line_data → 그림 바운딩 박스 =====
   *  반환: { w, h, n, boxes:[{type, subtype, x, y, w, h}] }
   */
  function extractDiagrams_(result) {
    const out = {
      w: Number(result.image_width  || 0),
      h: Number(result.image_height || 0),
      n: 0,
      boxes: []
    };
    const lines = Array.isArray(result.line_data) ? result.line_data : [];
    for (const ln of lines) {
      const type = String(ln.type || '');
      if (CFG.DIAGRAM_TYPES.indexOf(type) < 0) continue;
      const cnt = Array.isArray(ln.cnt) ? ln.cnt : [];
      if (cnt.length < 2) continue;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of cnt) {
        const x = Number(p[0]), y = Number(p[1]);
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (!isFinite(minX) || !isFinite(minY)) continue;

      out.boxes.push({
        type,
        subtype: String(ln.subtype || ''),
        x: Math.round(minX),
        y: Math.round(minY),
        w: Math.round(maxX - minX),
        h: Math.round(maxY - minY)
      });
    }
    out.n = out.boxes.length;
    return out;
  }

 /** drive_link 셀에 줄바꿈(또는 |)으로 구분된 여러 링크 지원 (패치 7) */
  function splitLinks_(s) {
    return String(s || '').split(/[\n|]+/).map(t => t.trim()).filter(Boolean);
  }
 
  /** OCR 성공 결과를 행에 기록 (latex + diagram 정보). status 는 호출자가 정한다.
   *  패치 7: (text, dg) 를 직접 받는다 — 조각 병합본을 기록할 수 있도록. */
  function writeSuccess_(sh, row, text, dg) {
    sh.getRange(row, CFG.COLS.latex).setValue(text || '');
    sh.getRange(row, CFG.COLS.last_error).setValue('');
    sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
    sh.getRange(row, CFG.COLS.has_diagram, 1, 2).setValues([[
      dg.n > 0,
      dg.n > 0 ? JSON.stringify(dg) : ''
    ]]);
    writeLint_(sh, row);                                   // 패치 10
    return dg;
  }
 

  function writeError_(sh, row, err) {
    sh.getRange(row, CFG.COLS.status).setValue('error');
    sh.getRange(row, CFG.COLS.last_error).setValue(String(err).slice(0, 500));
    sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
  }

  function figAvailable_() {
    return CFG.FIG.ENABLED && typeof _MPF !== 'undefined' && _MPF && typeof _MPF.processRowSync_ === 'function';
  }

  /** ===== 패치 4: 그림 단계. 최종 status 를 정해 기록하고 'done' | 'fig_pending' 반환 ===== */
  function finishFigures_(sh, row, deadlineMs) {
    const until = Math.min(deadlineMs, Date.now() + CFG.FIG.MAX_WAIT_MS);
    let r;
    try {
      r = _MPF.processRowSync_(sh, row, until);      // 'done' | 'pending' | 'error' | 'no_pdf'
    } catch (err) {
      sh.getRange(row, _MPF.COLS.fig_status).setValue('error: ' + String(err).slice(0, 300));
      r = 'error';
    }
    if (r === 'pending') {
      sh.getRange(row, CFG.COLS.status).setValue('fig_pending');
      return 'fig_pending';
    }
    // r === 'done' 이면 _MPF 가 (INTO_LATEX 설정에 따라) C열 교체까지 끝낸 상태
    writeLint_(sh, row);                                   // 패치 10: 교체본 재검사
    sh.getRange(row, CFG.COLS.status).setValue('done');
    sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
    return 'done';
  }

/** 한 행 변환. 반환: 'done' | 'fig_pending' | false(링크 없음). 실패 시 throw
   *  status 가 fig_pending 이면 OCR 은 건너뛰고 그림 수집만 이어서 한다.
   *  패치 7: drive_link 에 조각 링크가 여러 개면 조각별로 OCR 해 순서대로 이어붙인다.
   */
  function convertOneRow_(sh, row, creds, attempts, linkOrId, deadlineMs, status) {
    const resume = status === 'fig_pending';
    if (!resume) {
      sh.getRange(row, CFG.COLS.attempts).setValue(attempts + 1);
      sh.getRange(row, CFG.COLS.status).setValue('in_progress');
 
      const links = splitLinks_(linkOrId);
      if (!links.length) {
        sh.getRange(row, CFG.COLS.status).setValue('error');
        sh.getRange(row, CFG.COLS.last_error).setValue('missing_drive_link');
        sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
        return false;
      }
 
      const texts = [];
      const multi = { w: 0, h: 0, n: 0, boxes: [], pieces: [] };
      for (let i = 0; i < links.length; i++) {
        const result = callMathpix_(creds, buildPayload_(driveFileToDataUrl_(links[i])));
        texts.push(String(result.text || '').trim());
        const d = extractDiagrams_(result);
        multi.n += d.n;
        multi.pieces.push(d);
        if (i < links.length - 1) Utilities.sleep(150);
      }
      const dg = (links.length === 1) ? multi.pieces[0] : multi;
      writeSuccess_(sh, row, texts.filter(function (t) { return t; }).join('\n\n'), dg);
 
      if (!(dg.n > 0 && figAvailable_())) {
        sh.getRange(row, CFG.COLS.status).setValue('done');
        return 'done';
      }
    } else if (!figAvailable_()) {
      sh.getRange(row, CFG.COLS.status).setValue('done');   // 그림 기능이 꺼졌으면 그대로 마감
      return 'done';
    }
    return finishFigures_(sh, row, deadlineMs || (Date.now() + CFG.FIG.MAX_WAIT_MS));
  }

  function deleteMyTriggers_() {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === CFG.HANDLER) ScriptApp.deleteTrigger(t);
    });
  }

  function scheduleContinue_() {
    deleteMyTriggers_(); // 중복 방지
    ScriptApp.newTrigger(CFG.HANDLER).timeBased().after(60 * 1000).create(); // 1분 뒤 재개
  }

  /** ===== 시작: 범위 입력 후 첫 배치 실행 ===== */
  function start_() {
    const ui = SpreadsheetApp.getUi();
    const sh = getSheet_();
    if (!sh) { ui.alert(`시트 "${CFG.SHEET_NAME}" 없음`); return; }

    const resp = ui.prompt('변환 범위 (자동 이어하기)', '예: 2-200 (단일 행이면 5)', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    const input = (resp.getResponseText() || '').trim();
    let s, e, m = input.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (m) { s = +m[1]; e = +m[2]; }
    else if (/^\d+$/.test(input)) { s = +input; e = s; }
    else { ui.alert('형식 오류. 예: 2-200 또는 5'); return; }
    if (e < s) [s, e] = [e, s];

    s = Math.max(2, s);
    e = Math.min(sh.getLastRow(), e);
    if (e < s) { ui.alert('해당 구간에 데이터가 없습니다.'); return; }

    const sp = PropertiesService.getScriptProperties();
    sp.setProperty(CFG.PROP_START, String(s));
    sp.setProperty(CFG.PROP_END, String(e));
    sp.deleteProperty(CFG.PROP_STOP);

    ui.alert(`변환 시작: ${s}~${e}행\n시간이 초과되면 1분 뒤 자동으로 이어서 실행됩니다.\n중지하려면 메뉴의 "자동변환 중지"를 누르세요.`);

    processBatch_(); // 즉시 첫 배치 실행
  }

  /** ===== 배치 처리 (수동 시작 + 트리거 재개 공용) ===== */
  function processBatch_() {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return;

    try {
      const sp = PropertiesService.getScriptProperties();
      if (sp.getProperty(CFG.PROP_STOP) === '1') { deleteMyTriggers_(); return; }

      const s = Number(sp.getProperty(CFG.PROP_START) || 0);
      const e = Number(sp.getProperty(CFG.PROP_END) || 0);
      if (!s || !e) { deleteMyTriggers_(); return; }

      const sh = getSheet_();
      if (!sh) { deleteMyTriggers_(); return; }
      ensureDiagramHeader_(sh);

      const deadline = Date.now() + CFG.TIME_BUDGET_MS - CFG.SAFETY_GAP_MS;
      const creds = getMathpixCreds_();

      // 범위 전체를 한 번에 읽어 미처리 행만 선별
      const numRows = e - s + 1;
      const data = sh.getRange(s, 1, numRows, 8).getValues();

      let remaining = 0;

      for (let i = 0; i < data.length; i++) {
        const row = s + i;
        const status   = String(data[i][CFG.COLS.status - 1] || '').trim();
        const attempts = Number(data[i][CFG.COLS.attempts - 1] || 0);
        const linkOrId = String(data[i][CFG.COLS.drive_link - 1] || '').trim();

        if (status === 'done') continue;
        if (status !== 'fig_pending' && attempts >= CFG.MAX_ATTEMPTS) continue; // 반복 실패 행은 포기(last_error 참고)

        if (Date.now() > deadline) { remaining++; continue; } // 시간 소진 → 남은 것으로 집계만

        try {
          const r = convertOneRow_(sh, row, creds, attempts, linkOrId, deadline, status);
          if (r === 'fig_pending') remaining++;            // 그림 대기 → 다음 회차에 이어서
        } catch (err) {
          writeError_(sh, row, err);
          if (attempts + 1 < CFG.MAX_ATTEMPTS) remaining++; // 재시도 대상
        }

        Utilities.sleep(200);
      }

      if (remaining > 0) {
        scheduleContinue_(); // 1분 뒤 자동 재개
      } else {
        // 전부 완료 → 정리
        deleteMyTriggers_();
        sp.deleteProperty(CFG.PROP_START);
        sp.deleteProperty(CFG.PROP_END);
        try { SpreadsheetApp.getActive().toast(`범위 변환 완료 (${s}~${e}행)`, 'Mathpix', 10); } catch (_) {}
      }

    } finally {
      try { lock.releaseLock(); } catch (_) {}
    }
  }

  /** ===== 파이프라인용: 지정 행들을 deadline 까지 변환 (UI·트리거 없음) =====
   *  rows: 행 번호 배열 / deadlineMs: Date.now() 기준 절대시각
   *  반환: { attempted, ok, err, stoppedByTime, withDiagram, figPending }
   *  - fig_pending 행이 남으면 stoppedByTime=true 로 돌려 Pipeline 이 'yield' 하고 다음 회차에 다시 넘겨주게 한다.
   */
  function convertRows_(rows, deadlineMs) {
    const sh = getSheet_();
    if (!sh) throw new Error(`시트 "${CFG.SHEET_NAME}" 없음`);
    ensureDiagramHeader_(sh);
    const creds = getMathpixCreds_();
    const out = { attempted: 0, ok: 0, err: 0, stoppedByTime: false, withDiagram: 0, figPending: 0 };

    for (const row of rows) {
      if (Date.now() > deadlineMs) { out.stoppedByTime = true; break; }
      out.attempted++;

      const vals = sh.getRange(row, 1, 1, 8).getValues()[0];
      const attempts = Number(vals[CFG.COLS.attempts - 1] || 0);
      const linkOrId = String(vals[CFG.COLS.drive_link - 1] || '').trim();
      const status = String(vals[CFG.COLS.status - 1] || '').trim();

      try {
        const r = convertOneRow_(sh, row, creds, attempts, linkOrId, deadlineMs, status);
        if (r === 'done') {
          out.ok++;
          if (sh.getRange(row, CFG.COLS.has_diagram).getValue() === true) out.withDiagram++;
        } else if (r === 'fig_pending') {
          out.figPending++;
          out.stoppedByTime = true;      // 다음 회차에 이어서 수집
        } else {
          out.err++;
        }
      } catch (err) {
        writeError_(sh, row, err);
        out.err++;
      }
      Utilities.sleep(200);
    }
    return out;
  }

  /** ===== 디버그: 행 하나의 line_data 타입 요약 확인 (시트는 건드리지 않음) ===== */
  function debugLineData_() {
    const ui = SpreadsheetApp.getUi();
    const sh = getSheet_();
    if (!sh) { ui.alert(`시트 "${CFG.SHEET_NAME}" 없음`); return; }

    const resp = ui.prompt('line_data 확인', '확인할 행 번호 (예: 5)', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    const row = Number((resp.getResponseText() || '').trim());
    if (!row || row < 2) { ui.alert('행 번호 오류'); return; }

    const linkOrId = String(sh.getRange(row, CFG.COLS.drive_link).getValue() || '').trim();
    if (!linkOrId) { ui.alert(`${row}행 drive_link 없음`); return; }

    const result = callMathpix_(getMathpixCreds_(), buildPayload_(driveFileToDataUrl_(linkOrId)));
    const lines = Array.isArray(result.line_data) ? result.line_data : [];

    // 타입별 개수
    const counts = {};
    lines.forEach(ln => { const t = String(ln.type || '?'); counts[t] = (counts[t] || 0) + 1; });

    const dg = extractDiagrams_(result);
    const summary = [
      `${row}행: ${String(sh.getRange(row, CFG.COLS.filename).getValue() || '')}`,
      `이미지 크기: ${dg.w} x ${dg.h}`,
      `line_data ${lines.length}줄 — ` + Object.keys(counts).map(k => `${k}:${counts[k]}`).join(', '),
      `그림(${CFG.DIAGRAM_TYPES.join('/')}) ${dg.n}개`,
      ...dg.boxes.map((b, i) => `  [${i+1}] ${b.type}${b.subtype ? '/'+b.subtype : ''}  x=${b.x} y=${b.y} w=${b.w} h=${b.h}`)
    ].join('\n');

    Logger.log(summary);
    Logger.log(JSON.stringify(lines.map(ln => ({ type: ln.type, subtype: ln.subtype, cnt: ln.cnt, text: (ln.text || '').slice(0, 40) })), null, 1));
    ui.alert('line_data 요약', summary + '\n\n(전체 line_data 는 실행 로그에서 확인)', ui.ButtonSet.OK);
  }

  /** ===== 중지 ===== */
  function stop_() {
    const sp = PropertiesService.getScriptProperties();
    sp.setProperty(CFG.PROP_STOP, '1');
    deleteMyTriggers_();
    sp.deleteProperty(CFG.PROP_START);
    sp.deleteProperty(CFG.PROP_END);
    try { SpreadsheetApp.getUi().alert('자동변환을 중지했습니다.'); } catch (_) {}
  }

  return { start_, stop_, processBatch_, convertRows_, debugLineData_ };
})();

/** ===== 전역 래퍼 (메뉴/트리거용) ===== */
function mpr_runRangeAuto() { _MPR.start_(); }
function mpr_stopAuto()     { _MPR.stop_(); }
function mpr__continueRange() { _MPR.processBatch_(); } // 트리거가 호출
function mpr_convertRows(rows, deadlineMs) { return _MPR.convertRows_(rows, deadlineMs); } // 파이프라인용
function mpr_debugLineData() { _MPR.debugLineData_(); } // 패치 1 확인용 (메뉴에 추가하거나 편집기에서 직접 실행)