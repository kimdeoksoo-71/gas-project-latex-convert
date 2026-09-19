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
  VERSION:    'latex-1.0.0',
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
      case 'status': return rapi_json_(rapi_status_());
      case 'stop':   return rapi_json_(pipeline_stopCore_('원격 중지 (RemoteApi)'));
      default:       return rapi_json_({ ok: false, reason: 'unknown cmd: ' + p.cmd });
    }
  } catch (err) {
    return rapi_json_({ ok: false, reason: String((err && err.message) || err) });
  }
}

function rapi_ping_() {
  return { ok: true, project: RAPI.PROJECT, version: RAPI.VERSION, at: new Date().toISOString() };
}

/**
 * 변환 시작.
 *   keywords : 쉼표/줄바꿈 구분 (필수)
 *   force    : 1이면 진행 중인 파이프라인을 중단하고 새로 시작
 *
 * ⚠️ audition과 달리 키워드를 NFC 정규화하지 않는다 — 이 프로젝트의
 *    `pipeline_start`가 원래 그렇게 동작했고, 동작을 바꾸지 않기 위함이다.
 */
function rapi_start_(p) {
  const keywords = Array.from(new Set(
    String(p.keywords || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)
  ));
  if (!keywords.length) return { ok: false, reason: 'keywords 파라미터가 비어 있습니다.' };
  return pipeline_startCore_(keywords, { force: p.force === '1', deferTick: true });
}

/** 상태 조회 — 러너가 폴링해 정체를 판정한다(§7). 원본을 가공 없이 싣는다. */
function rapi_status_() {
  return {
    ok: true,
    version: RAPI.VERSION,
    state:   pl_loadState_() || null,
    logTail: rapi_logTail_(RAPI.LOG_TAIL),
    hasTick: ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === PL.TICK_FN),
    at:      new Date().toISOString(),
  };
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
