/*************************************************
 * Mathpix 그림 추출 — has_diagram 행의 문항 PDF 를 v3/pdf 로 보내 잘린 그림을 Drive 에 저장
 *
 * 전제
 *   - 패치 1: Data_Latex I열 has_diagram(TRUE/FALSE), J열 diagram_boxes 가 채워져 있음
 *   - 패치 2: CroP 가 문항별 PDF 를 만들고, 그 PDF 가 PNG 와 같은 폴더(PBMAI/IMAGE_DS)에
 *             같은 이름(.pdf)으로 올라가 있음   예) S팀모의6회(260722)_문제_1공통14.pdf
 *
 * 동작 (메뉴 "🖼 그림 추출 : 행범위" → 범위 입력, 비우면 전체)
 *   1) has_diagram=TRUE 이고 fig_status 가 비었거나 no_pdf 인 행 → PDF 를 찾아 v3/pdf 에 업로드, pdf_id 기록 (fig_status=submitted)
 *   2) submitted 행을 폴링 → completed 되면 .mmd 를 받아 그림 URL 을 모두 내려받아 Drive 폴더(PBMAI/IMAGE_FIG)에 저장
 *        파일명: <문항파일명 stem>_fig1.jpg, _fig2.jpg …  (같은 이름이 있으면 교체)
 *   3) 시간 예산(5분)이 다 되면 1분 뒤 트리거로 자동 재개, 전부 끝나면 트리거 정리
 *
 * Data_Latex 에 기록되는 열 (헤더 비어 있으면 자동 생성)
 *   K pdf_id      : Mathpix 문서 id
 *   L fig_status  : submitted | done n/m | error: … | no_pdf
 *                   (n = 저장한 그림 수, m = 패치 1 이 감지한 그림 수. error 는 L 을 지우면 재시도)
 *   M fig_files   : 저장한 파일명 (쉼표 구분)
 *   N fig_links   : 저장한 파일의 Drive 링크 (줄바꿈 구분)
 *   O latex_fig   : v3/pdf 가 만든 본문(mmd). 그림 자리는 \includegraphics{파일명} 으로 치환됨
 *   (CFG.INTO_LATEX=true 기본: 그림이 1개 이상 저장되면 C열 latex 를 O열 내용으로 바꾸고, 원래 v3/text 결과는 D열 text 에 보관)
 *
 * 패치 4: 'Latex 변환 : 행범위(자동 이어하기)' 와 Pipeline 은 _MPR 이 OCR 직후 has_diagram 행에 대해
 *   _MPF.processRowSync_ 를 호출해 여기까지 한 번에 처리한다. 이 파일의 메뉴는 no_pdf/error 행 재시도용.
 *
 * 스크립트 속성 (선택)
 *   MPF_FIG_FOLDER_PATH : 그림 저장 폴더 경로 (기본 PBMAI/IMAGE_FIG, 없으면 만듦)
 *
 * MainMenu.gs 의 'Latex 변환' 서브메뉴에 추가:
 *   .addItem('🖼 그림 추출 : 행범위 (has_diagram 행만)', 'mpf_runRange')
 *   .addItem('⏹️ 그림 추출 중지', 'mpf_stop')
 *************************************************/
const _MPF = (function () {
  const CFG = {
    SHEET_NAME: 'Data_Latex',
    COLS: { filename:1, drive_link:2, latex:3, text:4, has_diagram:9, diagram_boxes:10,
            pdf_id:11, fig_status:12, fig_files:13, fig_links:14, latex_fig:15 },
    HEADERS: ['pdf_id', 'fig_status', 'fig_files', 'fig_links', 'latex_fig'],   // K1~O1
    INTO_LATEX: true,   // 그림이 1개 이상 저장되면 C열(latex) ← O열(latex_fig), 원래 v3/text 결과는 D열(text)에 보관
    FIG_FOLDER_PROP: 'MPF_FIG_FOLDER_PATH',
    FIG_FOLDER_DEFAULT: 'PBMAI/IMAGE_FIG',
    PROP_START: 'MPF_RANGE_START',
    PROP_END:   'MPF_RANGE_END',
    PROP_STOP:  'MPF_STOP_FLAG',
    HANDLER: 'mpf__continue',
    TIME_BUDGET_MS: 5 * 60 * 1000,
    SAFETY_GAP_MS: 40 * 1000,
    POLL_MS: 6000,                 // submitted 행 상태 확인 간격
    SUBMIT_GAP_MS: 400,
    API: 'https://api.mathpix.com/v3/pdf',
    FIG_TAG: name => '\\includegraphics{' + name + '}',   // mmd 의 이미지 링크를 이렇게 치환
    // v3/pdf 옵션 (문서에 있는 것만)
    OPTIONS: {
      conversion_formats: {},
      math_inline_delimiters: ['$', '$'],
      math_block_delimiters: ['$$', '$$'],
      rm_spaces: true
    }
  };

  // ===== 공통 유틸 =====
  function getSheet_() { return SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_NAME); }

  function ensureHeader_(sh) {
    const rng = sh.getRange(1, CFG.COLS.pdf_id, 1, CFG.HEADERS.length);
    const cur = rng.getValues()[0];
    if (cur.every(v => !String(v || '').trim())) rng.setValues([CFG.HEADERS]);
  }

  function getCreds_() {
    const sp = PropertiesService.getScriptProperties();
    const app_id  = (sp.getProperty('MATHPIX_APP_ID')  || '').trim();
    const app_key = (sp.getProperty('MATHPIX_APP_KEY') || '').trim();
    if (!app_id || !app_key) throw new Error('Mathpix 키가 비어 있습니다.');
    return { app_id, app_key };
  }

  function extractFileId_(s) {
    const m = (s || '').match(/[-\w]{25,}/);
    if (!m) throw new Error('fileId parse failed: ' + s);
    return m[0];
  }

  function stemOf_(filename) { return String(filename || '').replace(/\.[^.]+$/, ''); }

  /** 'PBMAI/IMAGE_FIG' 같은 경로의 폴더. 없으면 만든다. */
  function getOrCreateFolderByPath_(pathLike) {
    const parts = pathLike.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/');
    let cur = DriveApp.getRootFolder();
    for (const name of parts) {
      const it = cur.getFoldersByName(name);
      cur = it.hasNext() ? it.next() : cur.createFolder(name);
    }
    return cur;
  }

  function figFolder_() {
    const p = (PropertiesService.getScriptProperties().getProperty(CFG.FIG_FOLDER_PROP) || '').trim();
    return getOrCreateFolderByPath_(p || CFG.FIG_FOLDER_DEFAULT);
  }

  /** PNG 와 같은 폴더에서 <stem>.pdf 찾기 → 없으면 Drive 전체 이름 검색 */
  function findPdf_(pngLinkOrId, stem) {
    const pdfName = stem + '.pdf';
    try {
      const png = DriveApp.getFileById(extractFileId_(pngLinkOrId));
      const parents = png.getParents();
      while (parents.hasNext()) {
        const it = parents.next().getFilesByName(pdfName);
        if (it.hasNext()) return it.next();
      }
    } catch (_) { /* PNG 링크가 이상해도 전체 검색으로 넘어감 */ }
    const it = DriveApp.getFilesByName(pdfName);
    return it.hasNext() ? it.next() : null;
  }

  // ===== Mathpix v3/pdf =====
  function fetchWithRetry_(url, opt, tries) {
    tries = tries || 5;
    for (let i = 0; i < tries; i++) {
      const res = UrlFetchApp.fetch(url, opt);
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) return res;
      if (code === 401) throw new Error('401 Unauthorized: ' + res.getContentText());
      if (code === 404) return res;                       // 결과 미완성(404)은 호출자가 판단
      if ([429, 500, 502, 503, 504].includes(code) && i < tries - 1) {
        Utilities.sleep(Math.min(700 * Math.pow(2, i) + Math.random() * 400, 15000));
        continue;
      }
      throw new Error('HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
    }
    throw new Error('retry exhausted: ' + url);
  }

  function submitPdf_(creds, pdfFile) {
    const opt = {
      method: 'post',
      headers: { app_id: creds.app_id, app_key: creds.app_key },
      payload: { file: pdfFile.getBlob(), options_json: JSON.stringify(CFG.OPTIONS) },  // multipart/form-data
      muteHttpExceptions: true
    };
    const res = fetchWithRetry_(CFG.API, opt);
    const j = JSON.parse(res.getContentText());
    if (!j.pdf_id) throw new Error('pdf_id 없음: ' + res.getContentText().slice(0, 300));
    return j.pdf_id;
  }

  function getStatus_(creds, pdfId) {
    const opt = { method: 'get', headers: { app_id: creds.app_id, app_key: creds.app_key }, muteHttpExceptions: true };
    const res = fetchWithRetry_(CFG.API + '/' + pdfId, opt);
    return JSON.parse(res.getContentText());   // { status: 'received'|'loaded'|'split'|'completed'|'error', ... }
  }

  function getMmd_(creds, pdfId) {
    const opt = { method: 'get', headers: { app_id: creds.app_id, app_key: creds.app_key }, muteHttpExceptions: true };
    const res = fetchWithRetry_(CFG.API + '/' + pdfId + '.mmd', opt);
    if (res.getResponseCode() === 404) return null;      // 아직 조립 중
    return res.getContentText();
  }

  /** mmd 안의 이미지 링크를 순서대로 뽑는다 → [{alt, url}] (중복 URL 은 한 번만) */
  function parseImageLinks_(mmd) {
    const out = [], seen = {};
    const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = re.exec(mmd)) !== null) {
      if (seen[m[2]]) continue;
      seen[m[2]] = true;
      out.push({ alt: m[1], url: m[2] });
    }
    return out;
  }

  function extFromUrl_(url, contentType) {
    const m = url.match(/\.(jpe?g|png|gif|webp|svg)(?:[?#]|$)/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    if (/png/i.test(contentType || '')) return 'png';
    return 'jpg';
  }

  /** 같은 이름의 파일이 폴더에 있으면 휴지통으로 보내고 새로 만든다 */
  function saveBlob_(folder, name, blob) {
    const it = folder.getFilesByName(name);
    while (it.hasNext()) it.next().setTrashed(true);
    blob.setName(name);
    return folder.createFile(blob);
  }

  /** 그림 내려받아 저장 + mmd 치환. 반환 { names:[], links:[], mmd } */
  function collectFigures_(mmd, stem, folder) {
    const links = parseImageLinks_(mmd);
    const names = [], urls = [];
    let text = mmd;
    links.forEach((L, i) => {
      const res = fetchWithRetry_(L.url, { method: 'get', muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('그림 다운로드 실패 ' + res.getResponseCode() + ': ' + L.url);
      const blob = res.getBlob();
      const name = `${stem}_fig${i + 1}.${extFromUrl_(L.url, blob.getContentType())}`;
      const f = saveBlob_(folder, name, blob);
      names.push(name);
      urls.push(f.getUrl());
      // 같은 URL 이 여러 번 쓰였어도 전부 치환: ![alt](url) → \includegraphics{name}
      const esc = L.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp('!\\[[^\\]]*\\]\\(' + esc + '\\)', 'g'), () => CFG.FIG_TAG(name));
    });
    return { names, links: urls, mmd: text };
  }

  // ===== 행 단위 처리 =====
  function writeStatus_(sh, row, status) { sh.getRange(row, CFG.COLS.fig_status).setValue(status); }

  function diagramCount_(json) {
    try { const j = JSON.parse(json || ''); return Number(j.n || (j.boxes || []).length || 0); } catch (_) { return 0; }
  }

  /** 제출 단계: 성공하면 true */
  function submitRow_(sh, row, creds, vals) {
    const stem = stemOf_(vals[CFG.COLS.filename - 1]);
    const pdf = findPdf_(String(vals[CFG.COLS.drive_link - 1] || ''), stem);
    if (!pdf) { writeStatus_(sh, row, 'no_pdf'); return false; }
    const pdfId = submitPdf_(creds, pdf);
    sh.getRange(row, CFG.COLS.pdf_id).setValue(pdfId);
    writeStatus_(sh, row, 'submitted');
    return true;
  }

  /** 수집 단계: 'done' | 'pending' | 'error' */
  function collectRow_(sh, row, creds, vals, folder) {
    const pdfId = String(vals[CFG.COLS.pdf_id - 1] || '').trim();
    if (!pdfId) { writeStatus_(sh, row, 'error: pdf_id 없음'); return 'error'; }
    const st = getStatus_(creds, pdfId);
    if (st.status === 'error') {
      const why = st.error || (st.error_info && st.error_info.message) || 'mathpix error';
      writeStatus_(sh, row, 'error: ' + String(why).slice(0, 300)); return 'error';
    }
    if (st.status !== 'completed') return 'pending';
    const mmd = getMmd_(creds, pdfId);
    if (mmd === null) return 'pending';

    const stem = stemOf_(vals[CFG.COLS.filename - 1]);
    const r = collectFigures_(mmd, stem, folder);
    const expected = diagramCount_(vals[CFG.COLS.diagram_boxes - 1]);
    sh.getRange(row, CFG.COLS.fig_status, 1, 4).setValues([[
      `done ${r.names.length}/${expected}`,
      r.names.join(', '),
      r.links.join('\n'),
      r.mmd
    ]]);
    if (CFG.INTO_LATEX && r.names.length > 0) applyIntoLatex_(sh, row, r.mmd);
    return 'done';
  }

  /** C열(latex) ← latex_fig. 원래 값은 D열(text)에 보관 (D 가 이미 차 있으면 덮어쓰지 않음) */
  function applyIntoLatex_(sh, row, figText) {
    const cur = String(sh.getRange(row, CFG.COLS.latex).getValue() || '');
    const bak = String(sh.getRange(row, CFG.COLS.text).getValue() || '');
    if (cur === figText) return;
    if (!bak) sh.getRange(row, CFG.COLS.text).setValue(cur);
    sh.getRange(row, CFG.COLS.latex).setValue(figText);
  }

  /** ===== 패치 4: _MPR 이 행 단위로 호출하는 동기 처리 =====
   *  제출(필요 시) → deadlineMs 까지 폴링·수집.  반환 'done' | 'pending' | 'error' | 'no_pdf'
   *  (예외는 그대로 던지므로 호출자가 fig_status 에 기록)
   */
  function processRowSync_(sh, row, deadlineMs) {
    ensureHeader_(sh);
    const creds = getCreds_();
    const vals = sh.getRange(row, 1, 1, CFG.COLS.latex_fig).getValues()[0];
    const status = String(vals[CFG.COLS.fig_status - 1] || '').trim();
    if (status.startsWith('done')) return 'done';
    if (status.startsWith('error')) return 'error';
    if (status !== 'submitted') {
      if (!submitRow_(sh, row, creds, vals)) return 'no_pdf';
      vals[CFG.COLS.pdf_id - 1] = sh.getRange(row, CFG.COLS.pdf_id).getValue();
    }
    const folder = figFolder_();
    while (true) {
      const r = collectRow_(sh, row, creds, vals, folder);
      if (r !== 'pending') return r;
      if (Date.now() + CFG.POLL_MS > deadlineMs) return 'pending';
      Utilities.sleep(CFG.POLL_MS);
    }
  }

  // ===== 배치 (수동 시작 + 트리거 재개 공용) =====
  function deleteMyTriggers_() {
    ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === CFG.HANDLER) ScriptApp.deleteTrigger(t); });
  }
  function scheduleContinue_() {
    deleteMyTriggers_();
    ScriptApp.newTrigger(CFG.HANDLER).timeBased().after(60 * 1000).create();
  }

  function processBatch_() {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return;
    try {
      const sp = PropertiesService.getScriptProperties();
      if (sp.getProperty(CFG.PROP_STOP) === '1') { deleteMyTriggers_(); return; }
      const sh = getSheet_();
      if (!sh) { deleteMyTriggers_(); return; }
      ensureHeader_(sh);

      const s = Math.max(2, Number(sp.getProperty(CFG.PROP_START) || 2));
      const e = Math.min(sh.getLastRow(), Number(sp.getProperty(CFG.PROP_END) || sh.getLastRow()));
      if (e < s) { finish_(sp, '대상 행 없음'); return; }

      const deadline = Date.now() + CFG.TIME_BUDGET_MS - CFG.SAFETY_GAP_MS;
      const creds = getCreds_();
      const folder = figFolder_();
      const readRow = row => sh.getRange(row, 1, 1, CFG.COLS.latex_fig).getValues()[0];

      // 1) 제출
      const data = sh.getRange(s, 1, e - s + 1, CFG.COLS.latex_fig).getValues();
      let unsubmitted = 0, submitted = 0, done = 0, errors = 0;
      for (let i = 0; i < data.length; i++) {
        const row = s + i, vals = data[i];
        if (vals[CFG.COLS.has_diagram - 1] !== true) continue;
        const status = String(vals[CFG.COLS.fig_status - 1] || '').trim();
        if (status.startsWith('done')) { done++; continue; }
        if (status.startsWith('error')) { errors++; continue; }        // L 을 지우면 재시도
        if (status === 'submitted') { submitted++; continue; }
        // '' 또는 no_pdf
        if (Date.now() > deadline) { unsubmitted++; continue; }
        try {
          if (submitRow_(sh, row, creds, vals)) submitted++;
        } catch (err) {
          writeStatus_(sh, row, 'error: ' + String(err).slice(0, 300)); errors++;
        }
        Utilities.sleep(CFG.SUBMIT_GAP_MS);
      }

      // 2) 폴링·수집
      let pending = submitted;
      while (pending > 0 && Date.now() < deadline) {
        pending = 0;
        const cur = sh.getRange(s, 1, e - s + 1, CFG.COLS.latex_fig).getValues();
        for (let i = 0; i < cur.length; i++) {
          if (Date.now() > deadline) { pending++; continue; }
          const row = s + i, vals = cur[i];
          if (String(vals[CFG.COLS.fig_status - 1] || '').trim() !== 'submitted') continue;
          try {
            const r = collectRow_(sh, row, creds, vals, folder);
            if (r === 'pending') pending++;
            else if (r === 'done') done++;
            else errors++;
          } catch (err) {
            writeStatus_(sh, row, 'error: ' + String(err).slice(0, 300)); errors++;
          }
        }
        if (pending > 0 && Date.now() + CFG.POLL_MS < deadline) Utilities.sleep(CFG.POLL_MS);
        else if (pending > 0) break;
      }

      if (unsubmitted + pending > 0) {
        scheduleContinue_();
      } else {
        finish_(sp, `그림 추출 완료 (${s}~${e}행) — done ${done}, error ${errors}`);
      }
    } finally {
      try { lock.releaseLock(); } catch (_) {}
    }
  }

  function finish_(sp, msg) {
    deleteMyTriggers_();
    sp.deleteProperty(CFG.PROP_START);
    sp.deleteProperty(CFG.PROP_END);
    try { SpreadsheetApp.getActive().toast(msg, 'Mathpix 그림', 10); } catch (_) {}
  }

  // ===== 메뉴 진입 =====
  function runRange_() {
    const ui = SpreadsheetApp.getUi();
    const sh = getSheet_();
    if (!sh) { ui.alert(`시트 "${CFG.SHEET_NAME}" 없음`); return; }
    ensureHeader_(sh);

    const resp = ui.prompt('그림 추출 범위', '예: 2-200 (단일 행이면 5, 비우면 전체)\nhas_diagram=TRUE 인 행만 처리합니다.', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    const input = (resp.getResponseText() || '').trim();
    let s = 2, e = sh.getLastRow(), m;
    if ((m = input.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/))) { s = +m[1]; e = +m[2]; }
    else if (/^\d+$/.test(input)) { s = e = +input; }
    else if (input) { ui.alert('형식 오류. 예: 2-200 또는 5 또는 빈칸'); return; }
    if (e < s) [s, e] = [e, s];
    s = Math.max(2, s); e = Math.min(sh.getLastRow(), e);

    // 대상 수 미리 세기
    const col = sh.getRange(s, CFG.COLS.has_diagram, e - s + 1, 4).getValues();
    const targets = col.filter(r => r[0] === true && !String(r[3] || '').trim().startsWith('done')).length;
    if (!targets) { ui.alert('해당 구간에 처리할 has_diagram=TRUE 행이 없습니다 (이미 done 인 행 제외).'); return; }

    const sp = PropertiesService.getScriptProperties();
    sp.setProperty(CFG.PROP_START, String(s));
    sp.setProperty(CFG.PROP_END, String(e));
    sp.deleteProperty(CFG.PROP_STOP);
    ui.alert(`그림 추출 시작: ${s}~${e}행, 대상 ${targets}행\n그림은 Drive "${(sp.getProperty(CFG.FIG_FOLDER_PROP) || CFG.FIG_FOLDER_DEFAULT)}" 폴더에 저장됩니다.\n시간이 초과되면 1분 뒤 자동으로 이어서 실행됩니다.`);
    processBatch_();
  }

  function stop_() {
    const sp = PropertiesService.getScriptProperties();
    sp.setProperty(CFG.PROP_STOP, '1');
    deleteMyTriggers_();
    sp.deleteProperty(CFG.PROP_START);
    sp.deleteProperty(CFG.PROP_END);
    try { SpreadsheetApp.getUi().alert('그림 추출을 중지했습니다. (submitted 상태인 행은 다음 실행 때 이어서 수집됩니다)'); } catch (_) {}
  }

  return { CFG, COLS: CFG.COLS, runRange_, stop_, processBatch_, processRowSync_, parseImageLinks_, collectFigures_ };
})();

/** ===== 전역 래퍼 (메뉴/트리거용) ===== */
function mpf_runRange()  { _MPF.runRange_(); }
function mpf_stop()      { _MPF.stop_(); }
function mpf__continue() { _MPF.processBatch_(); }   // 트리거가 호출