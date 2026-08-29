/*************************************************
 * Mathpix 범위 변환 — 자동 이어하기 버전
 * - 한 번만 범위 입력 (예: 2-200)
 * - 실행시간 한도(6분) 도달 전에 스스로 중단하고
 *   1분 뒤 트리거로 자동 재개 → 전체 완료까지 무인 진행
 * - status='done' 행은 건너뛰므로 중복 처리 없음
 *************************************************/
const _MPR = (function () {
  const CFG = {
    SHEET_NAME: 'Data_Latex',
    COLS: { filename:1, drive_link:2, latex:3, text:4, status:5, attempts:6, last_error:7, processed_at:8 },
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
        if (attempts >= CFG.MAX_ATTEMPTS) continue; // 반복 실패 행은 포기(last_error 참고)

        if (Date.now() > deadline) { remaining++; continue; } // 시간 소진 → 남은 것으로 집계만

        try {
          sh.getRange(row, CFG.COLS.attempts).setValue(attempts + 1);
          sh.getRange(row, CFG.COLS.status).setValue('in_progress');

          if (!linkOrId) {
            sh.getRange(row, CFG.COLS.status).setValue('error');
            sh.getRange(row, CFG.COLS.last_error).setValue('missing_drive_link');
            sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
            continue;
          }

          const fileId = extractFileId_(linkOrId);
          const blob = DriveApp.getFileById(fileId).getBlob();
          const dataUrl = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());

          const result = callMathpix_(creds, {
            src: dataUrl,
            formats: ['text'],
            rm_spaces: true,
            math_inline_delimiters: ['$', '$'],
            math_block_delimiters: ['$$', '$$'],
            enable_tables: true,
            confidence_threshold: 0.0
          });

          sh.getRange(row, CFG.COLS.latex).setValue(result.text || '');
          sh.getRange(row, CFG.COLS.status).setValue('done');
          sh.getRange(row, CFG.COLS.last_error).setValue('');
          sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());

        } catch (err) {
          sh.getRange(row, CFG.COLS.status).setValue('error');
          sh.getRange(row, CFG.COLS.last_error).setValue(String(err).slice(0, 500));
          sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
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
   *  반환: { attempted, ok, err, stoppedByTime }
   */
  function convertRows_(rows, deadlineMs) {
    const sh = getSheet_();
    if (!sh) throw new Error(`시트 "${CFG.SHEET_NAME}" 없음`);
    const creds = getMathpixCreds_();
    const out = { attempted: 0, ok: 0, err: 0, stoppedByTime: false };

    for (const row of rows) {
      if (Date.now() > deadlineMs) { out.stoppedByTime = true; break; }
      out.attempted++;

      const vals = sh.getRange(row, 1, 1, 8).getValues()[0];
      const attempts = Number(vals[CFG.COLS.attempts - 1] || 0);
      const linkOrId = String(vals[CFG.COLS.drive_link - 1] || '').trim();

      try {
        sh.getRange(row, CFG.COLS.attempts).setValue(attempts + 1);
        sh.getRange(row, CFG.COLS.status).setValue('in_progress');

        if (!linkOrId) {
          sh.getRange(row, CFG.COLS.status).setValue('error');
          sh.getRange(row, CFG.COLS.last_error).setValue('missing_drive_link');
          sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
          out.err++; continue;
        }

        const fileId = extractFileId_(linkOrId);
        const blob = DriveApp.getFileById(fileId).getBlob();
        const dataUrl = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());

        const result = callMathpix_(creds, {
          src: dataUrl,
          formats: ['text'],
          rm_spaces: true,
          math_inline_delimiters: ['$', '$'],
          math_block_delimiters: ['$$', '$$'],
          enable_tables: true,
          confidence_threshold: 0.0
        });

        sh.getRange(row, CFG.COLS.latex).setValue(result.text || '');
        sh.getRange(row, CFG.COLS.status).setValue('done');
        sh.getRange(row, CFG.COLS.last_error).setValue('');
        sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
        out.ok++;

      } catch (err) {
        sh.getRange(row, CFG.COLS.status).setValue('error');
        sh.getRange(row, CFG.COLS.last_error).setValue(String(err).slice(0, 500));
        sh.getRange(row, CFG.COLS.processed_at).setValue(new Date());
        out.err++;
      }
      Utilities.sleep(200);
    }
    return out;
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

  return { start_, stop_, processBatch_, convertRows_ };
})();

/** ===== 전역 래퍼 (메뉴/트리거용) ===== */
function mpr_runRangeAuto() { _MPR.start_(); }
function mpr_stopAuto()     { _MPR.stop_(); }
function mpr__continueRange() { _MPR.processBatch_(); } // 트리거가 호출
function mpr_convertRows(rows, deadlineMs) { return _MPR.convertRows_(rows, deadlineMs); } // 파이프라인용