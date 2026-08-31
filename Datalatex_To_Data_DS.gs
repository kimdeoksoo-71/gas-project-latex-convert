/*************************************************
 * Data_Latex → Data_DS 직송 + given_answer(D) 자동 추출
 *
 * [명령 1] dl_sendPairsToDataDS
 *   - Data_Latex!A(filename)에서 "_문제" / "_해설" 부분만 다르고 나머지가 같은
 *     두 행을 짝지어, C(latex)를 Data_DS!B(문제), C(해설)에 넣는다.
 *   - Data_DS!A에는 짝의 공통 이름(확장자·_문제/_해설 제거)을 넣는다.
 *   - Data_DS의 마지막 데이터 행 다음부터 이어붙인다. (이미 같은 A값이 있으면 건너뜀)
 *   - 추가된 행에 대해 곧바로 [명령 2]를 실행하여 D(given_answer)를 채운다.
 *
 * [명령 2] ds_fillGivenAnswer_byRowInput
 *   - Data_DS!C(해설)에서 정답을 찾아 D(given_answer)에 기록한다.
 *   - 행 범위를 입력받는다. (예: 15, 17, 123, 10-15 / 비우면 C가 있고 D가 빈 모든 행)
 *   - K(answer_type)가 있으면 그에 맞춰 표기한다.
 *       mcq_math / mcq_combo → ①~⑤ (원문자)
 *       short_int            → 3자리 이하 자연수
 *     K가 비어 있으면(정규화 전) 해설에서 발견된 형태 그대로 기록한다.
 *
 * 정답 인식 규칙 (해설 C열)
 *   - 문제번호 토큰: 첫 줄의 "7." / "7)" / "7 ." 형태 (1~2자리)
 *   - 정답 위치: ① 문제번호와 같은 줄 → ② (빈 줄 제외) 바로 다음 줄
 *               → ③ 해설이 모두 끝난 제일 아랫줄 (키워드 있거나, 그 줄이 정답 하나뿐일 때)
 *   - 형태:
 *       (1) '정답'/'답' 키워드 사용:  정답 : ②, 정답: 32, 정답) ②, [정답] ②, 답 ②
 *       (2) 키워드 없음:              ②, 32
 *   - 원문자(①~⑤), \textcircled{n}, (n) [n=1~5] → 객관식 정답
 *   - 3자리 이하 정수(뒤에 글자·숫자가 붙지 않는 것) → 주관식 정답
 *   - 위치에서 못 찾으면 해설 전체에서 '정답 …' 키워드 패턴을 마지막으로 한 번 더 찾는다.
 *************************************************/

const DLDS = {
  SRC_SHEET: 'Data_Latex',
  DST_SHEET: 'Data_DS',

  // Data_Latex 열
  SRC: { filename: 1, latex: 3, status: 5 },

  // Data_DS 열
  DST: { key: 1, problem: 2, solution: 3, answer: 4, type: 11 }, // A, B, C, D, K

  // 파일명에서 문제/해설을 구분하는 표지
  TAG_PROBLEM:  '_문제',
  TAG_SOLUTION: '_해설',

  // status 가 'done'이 아닌 행도 보낼지 (false면 done만)
  SEND_ONLY_DONE: false,

  // "(2)" 괄호숫자를 원문자 ②로 인정 (Mathpix가 원문자를 (n)으로 뽑는 경우)
  ACCEPT_PAREN_AS_CIRCLED: true,

  // D열에 이미 값이 있으면 덮어쓸지
  OVERWRITE_ANSWER: false
};

const DLDS_CIRCLED = ['①', '②', '③', '④', '⑤'];

/* =================================================
 * [명령 1] Data_Latex → Data_DS
 * ================================================= */
function dl_sendPairsToDataDS() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const src = ss.getSheetByName(DLDS.SRC_SHEET);
  const dst = ss.getSheetByName(DLDS.DST_SHEET);
  if (!src) throw new Error(`${DLDS.SRC_SHEET} 시트를 찾을 수 없습니다.`);
  if (!dst) throw new Error(`${DLDS.DST_SHEET} 시트를 찾을 수 없습니다.`);

  // 1) 범위 입력 (비우면 전체)
  const res = ui.prompt(
    'Data_Latex → Data_DS',
    `${DLDS.SRC_SHEET}의 행 범위를 입력하세요 (예: 2-93). 비우면 2행부터 끝까지.`,
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const lastRow = src.getLastRow();
  if (lastRow < 2) { ui.alert('Data_Latex에 데이터가 없습니다.'); return; }

  let startRow = 2, endRow = lastRow;
  const txt = (res.getResponseText() || '').trim();
  if (txt) {
    const nums = txt.split(/[\s,;:~\-]+/).filter(Boolean).map(v => parseInt(v, 10));
    if (nums.length === 1 && Number.isFinite(nums[0])) { startRow = endRow = nums[0]; }
    else if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
      startRow = Math.min(nums[0], nums[1]); endRow = Math.max(nums[0], nums[1]);
    } else { ui.alert('형식 오류. 예: 2-93 / 2,93 / 비움'); return; }
    startRow = Math.max(2, startRow);
    endRow = Math.min(lastRow, endRow);
  }

  // 2) Data_Latex 읽기 → 짝 만들기
  const n = endRow - startRow + 1;
  const rows = src.getRange(startRow, 1, n, DLDS.SRC.status).getValues();

  const pairs = new Map(); // key → { problem, solution, order, pRow, sRow }
  let order = 0;
  rows.forEach((r, i) => {
    const fname = String(r[DLDS.SRC.filename - 1] || '').trim();
    if (!fname) return;
    const status = String(r[DLDS.SRC.status - 1] || '').trim();
    if (DLDS.SEND_ONLY_DONE && status !== 'done') return;

    const parsed = dlds_parseFilename_(fname);
    if (!parsed) return; // _문제/_해설 표지가 없는 파일명은 무시

    const latex = String(r[DLDS.SRC.latex - 1] || '');
    if (!pairs.has(parsed.key)) pairs.set(parsed.key, { problem: null, solution: null, order: order++, pRow: 0, sRow: 0 });
    const p = pairs.get(parsed.key);
    if (parsed.kind === 'problem')  { p.problem  = latex; p.pRow = startRow + i; }
    else                            { p.solution = latex; p.sRow = startRow + i; }
  });

  if (pairs.size === 0) {
    ui.alert(`"${DLDS.TAG_PROBLEM}" / "${DLDS.TAG_SOLUTION}" 표지가 있는 파일명을 찾지 못했습니다.`);
    return;
  }

  // 3) 이미 Data_DS에 있는 key는 건너뜀
  const existing = new Set();
  const dstLast = dlds_lastDataRow_(dst, 3);
  if (dstLast >= 2) {
    dst.getRange(2, DLDS.DST.key, dstLast - 1, 1).getValues()
      .forEach(r => { const k = String(r[0] || '').trim(); if (k) existing.add(k); });
  }

  const out = [];       // [key, problem, solution]
  const skippedDup = [], onlyProblem = [], onlySolution = [];
  Array.from(pairs.entries())
    .sort((a, b) => a[1].order - b[1].order)
    .forEach(([key, p]) => {
      if (existing.has(key)) { skippedDup.push(key); return; }
      if (p.problem === null && p.solution !== null) { onlySolution.push(key); return; } // 해설만 있으면 보내지 않음
      if (p.solution === null) onlyProblem.push(key);
      out.push([key, p.problem || '', p.solution || '']);
    });

  if (out.length === 0) {
    ui.alert(
      '추가할 행이 없습니다.\n' +
      (skippedDup.length ? `이미 존재: ${skippedDup.length}건\n` : '') +
      (onlySolution.length ? `해설만 있음(문제 없음): ${onlySolution.join(', ')}` : '')
    );
    return;
  }

  // 4) Data_DS에 이어붙이기
  const writeStart = (dstLast >= 2) ? dstLast + 1 : 2;
  dst.getRange(writeStart, DLDS.DST.key, out.length, 3).setValues(out);
  const writeEnd = writeStart + out.length - 1;

  // 5) 추가된 행의 D(given_answer) 채우기
  const rowsToFill = [];
  for (let r = writeStart; r <= writeEnd; r++) rowsToFill.push(r);
  const stat = ds_fillGivenAnswerRows_(dst, rowsToFill);

  // 6) 안내
  let msg =
    `Data_DS!A:C에 ${out.length}개 행을 추가했습니다. (행 ${writeStart}~${writeEnd})\n` +
    `given_answer(D): 성공 ${stat.ok}, 미검출 ${stat.miss.length}` +
    (stat.miss.length ? ` → 행 ${stat.miss.join(', ')}` : '') + '\n';
  if (stat.conflict.length) msg += `유형 불일치(D 비움): 행 ${stat.conflict.join(', ')}\n`;
  if (onlyProblem.length)  msg += `해설 없음(C 비움): ${onlyProblem.join(', ')}\n`;
  if (onlySolution.length) msg += `문제 없음(건너뜀): ${onlySolution.join(', ')}\n`;
  if (skippedDup.length)   msg += `이미 존재하여 건너뜀: ${skippedDup.length}건\n`;
  ui.alert('완료', msg, ui.ButtonSet.OK);
}

/** 파일명 → { key, kind } / 표지가 없으면 null */
function dlds_parseFilename_(fname) {
  let name = nfc_(fname).trim().replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const iP = name.indexOf(DLDS.TAG_PROBLEM);
  const iS = name.indexOf(DLDS.TAG_SOLUTION);
  if (iP < 0 && iS < 0) return null;
  const kind = (iP >= 0 && (iS < 0 || iP < iS)) ? 'problem' : 'solution';
  const tag  = kind === 'problem' ? DLDS.TAG_PROBLEM : DLDS.TAG_SOLUTION;
  const key  = name.replace(tag, '').replace(/__+/g, '_').replace(/^_|_$/g, '');
  return { key, kind };
}

/** 시트의 1~numCols 열 기준 마지막 데이터 행 (없으면 1) */
function dlds_lastDataRow_(sheet, numCols) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const v = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i].some(x => String(x).trim() !== '')) return i + 2;
  }
  return 1;
}

/* =================================================
 * [명령 2] Data_DS!C → D(given_answer)
 * ================================================= */
function ds_fillGivenAnswer_byRowInput() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(DLDS.DST_SHEET);
  if (!sh) throw new Error(`${DLDS.DST_SHEET} 시트를 찾을 수 없습니다.`);

  const res = ui.prompt(
    'given_answer(D) 채우기',
    '행 번호 입력 (예: 15, 17, 123, 10-15)\n비우면: C(해설)가 있고 D가 빈 모든 행',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  let rows = dlds_parseRowInput_(res.getResponseText());
  if (!rows.length) {
    const last = dlds_lastDataRow_(sh, 3);
    if (last < 2) { ui.alert('Data_DS에 데이터가 없습니다.'); return; }
    const v = sh.getRange(2, 1, last - 1, DLDS.DST.answer).getValues();
    v.forEach((r, i) => {
      const c = String(r[DLDS.DST.solution - 1] || '').trim();
      const d = String(r[DLDS.DST.answer - 1] || '').trim();
      if (c && (!d || DLDS.OVERWRITE_ANSWER)) rows.push(i + 2);
    });
    if (!rows.length) { ui.alert('채울 행이 없습니다. (C가 있고 D가 빈 행 없음)'); return; }
  }

  const stat = ds_fillGivenAnswerRows_(sh, rows);
  let msg = `대상 ${rows.length}행 → 성공 ${stat.ok}, 미검출 ${stat.miss.length}, 건너뜀 ${stat.skipped}\n`;
  if (stat.miss.length)     msg += `미검출 행: ${stat.miss.join(', ')}\n`;
  if (stat.conflict.length) msg += `유형 불일치(D 비움): 행 ${stat.conflict.join(', ')}\n`;
  ui.alert('완료', msg, ui.ButtonSet.OK);
}

/** 여러 행에 대해 D를 채우고 통계 반환 */
function ds_fillGivenAnswerRows_(sh, rows) {
  const stat = { ok: 0, miss: [], conflict: [], skipped: 0 };
  if (!rows.length) return stat;

  const minR = Math.min(...rows), maxR = Math.max(...rows);
  const block = sh.getRange(minR, 1, maxR - minR + 1, DLDS.DST.type).getValues();
  const dOut = sh.getRange(minR, DLDS.DST.answer, maxR - minR + 1, 1).getValues();
  const rowSet = new Set(rows);

  for (let r = minR; r <= maxR; r++) {
    if (!rowSet.has(r)) continue;
    const i = r - minR;
    const solution = String(block[i][DLDS.DST.solution - 1] || '');
    const current  = String(block[i][DLDS.DST.answer - 1] || '').trim();
    const type     = String(block[i][DLDS.DST.type - 1] || '').trim();

    if (current && !DLDS.OVERWRITE_ANSWER) { stat.skipped++; continue; }
    if (!solution.trim()) { stat.miss.push(r); continue; }

    const found = ds_extractAnswer_(solution); // { kind:'circled'|'int', value:number } | null
    if (!found) { dOut[i][0] = current; stat.miss.push(r); continue; }

    const formatted = ds_formatAnswer_(found, type);
    if (formatted === null) { dOut[i][0] = ''; stat.conflict.push(r); continue; }

    dOut[i][0] = formatted;
    stat.ok++;
  }

  sh.getRange(minR, DLDS.DST.answer, maxR - minR + 1, 1).setValues(dOut);
  return stat;
}

/** 발견된 정답을 K(answer_type)에 맞게 표기. 불가능하면 null */
function ds_formatAnswer_(found, type) {
  const isMcq = /^mcq/.test(type);
  const isShort = type === 'short_int';

  if (isMcq) {
    if (found.kind === 'circled') return DLDS_CIRCLED[found.value - 1];
    if (found.kind === 'int' && found.value >= 1 && found.value <= 5) return DLDS_CIRCLED[found.value - 1];
    return null;
  }
  if (isShort) {
    if (found.kind === 'int') return found.value;
    return null; // 주관식인데 원문자 → 불일치
  }
  // K 미정: 발견된 형태 그대로
  return found.kind === 'circled' ? DLDS_CIRCLED[found.value - 1] : found.value;
}

/* -------------------------------------------------
 * 정답 추출
 * ------------------------------------------------- */

/** 해설 텍스트에서 정답 찾기 → { kind, value } | null */
function ds_extractAnswer_(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
    .map(s => s.trim()).filter(s => s !== '');
  if (!lines.length) return null;

  // 1) 첫 줄에서 문제번호 토큰 제거
  const numRe = /^(\d{1,2})\s*[.)]\s*/;
  let first = lines[0];
  let tailIdx = 0;
  if (numRe.test(first)) {
    first = first.replace(numRe, '').trim();
  }

  // 같은 줄
  let ans = ds_matchAnswerAtStart_(first, true);
  if (ans) return ans;

  // 같은 줄이 비어 있거나(번호만) 정답이 없으면 → 바로 다음 줄
  if (lines.length > 1) {
    ans = ds_matchAnswerAtStart_(lines[1], first === '');
    if (ans) return ans;
    // "정답" 키워드가 있으면 그 다음 줄까지 허용 (예: "정답\n②")
    if (/^[\[【(]?\s*(?:정답|답)\s*[\]】)]?\s*[:：]?\s*$/.test(first) || /^[\[【(]?\s*(?:정답|답)\s*[\]】)]?\s*[:：]?\s*$/.test(lines[1])) {
      const nxt = /^[\[【(]?\s*(?:정답|답)/.test(first) ? lines[1] : (lines[2] || '');
      ans = ds_matchToken_(nxt, true);
      if (ans) return ans;
    }
  }

  // 2) 해설 제일 아랫줄 (빈 줄 제외)
  //    - '정답 : ②' 처럼 키워드가 있으면 그대로 인정
  //    - 키워드 없이 ②, (2), 32 처럼 "그 줄 전체가 정답 하나뿐"이면 인정
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1];
    ans = ds_matchAnswerAtStart_(lastLine, false);
    if (ans) return ans;
    const bare = lastLine.replace(/^\$+\s*|\s*\$+$/g, '').replace(/^\\\(\s*|\s*\\\)$/g, '').trim();
    if (/^(?:[①②③④⑤]|\\textcircled\s*\{\s*[1-5]\s*\}|\(\s*[1-5]\s*\)|\d{1,3})\s*[.]?$/.test(bare)) {
      ans = ds_matchToken_(bare, true);
      if (ans) return ans;
    }
  }

  // 3) 전체에서 '정답' 키워드 패턴 마지막 검색 (fallback)
  const kwRe = /(?:정답|답)(?:은|는|이)?\s*[)\]】]?\s*[:：]?\s*(\$?(?:[①②③④⑤]|\\textcircled\s*\{\s*[1-5]\s*\}|\([1-5]\)|\d{1,3})\$?)(?![\d\w가-힣%]|\.\d)/g;
  let m, last = null;
  const whole = lines.join('\n');
  while ((m = kwRe.exec(whole)) !== null) last = m[1];
  if (last) {
    const t = ds_matchToken_(last, true);
    if (t) return t;
  }
  return null;
}

/** 줄 시작에서 정답 찾기. allowBare=true 이면 키워드 없는 ②/32 도 인정 */
function ds_matchAnswerAtStart_(line, allowBare) {
  if (!line) return null;
  // 키워드 제거: 정답 : / 정답) / [정답] / 【정답】 / 답 :
  const kw = /^[\[【(]?\s*(?:정답|답)\s*[\]】)]?\s*[:：)]?\s*/;
  if (kw.test(line)) {
    return ds_matchToken_(line.replace(kw, ''), true);
  }
  return allowBare ? ds_matchToken_(line, false) : null;
}

/**
 * 토큰 인식 (문자열 맨 앞)
 *  - ①~⑤ / \textcircled{n} → circled
 *  - (n) n=1~5 → circled (afterKeyword 또는 ACCEPT_PAREN_AS_CIRCLED 일 때)
 *  - 1~3자리 정수(뒤에 글자·숫자 없음) → int
 */
function ds_matchToken_(s, afterKeyword) {
  if (!s) return null;
  let t = s.trim().replace(/^\$+\s*/, '').replace(/^\\\(\s*/, ''); // 앞의 $ / \( 제거

  let m = t.match(/^([①②③④⑤])/);
  if (m) return { kind: 'circled', value: DLDS_CIRCLED.indexOf(m[1]) + 1 };

  m = t.match(/^\\textcircled\s*\{\s*([1-5])\s*\}/);
  if (m) return { kind: 'circled', value: Number(m[1]) };

  if (afterKeyword || DLDS.ACCEPT_PAREN_AS_CIRCLED) {
    m = t.match(/^\(\s*([1-5])\s*\)(?![\d\w가-힣])/);
    if (m) return { kind: 'circled', value: Number(m[1]) };
  }

  m = t.match(/^(\d{1,3})\s*\$?(?![\d\w가-힣%]|\.\d)/);
  if (m) {
    return { kind: 'int', value: Number(m[1]) };
  }
  return null;
}

/** "15, 17, 123, 10-15" → [15,17,123,10,11,...] */
function dlds_parseRowInput_(text) {
  const set = new Set();
  String(text ?? '').split(',').forEach(part => {
    const s = part.trim();
    if (!s) return;
    if (s.includes('-')) {
      const [a, b] = s.split('-').map(v => Number(String(v).trim()));
      if (Number.isInteger(a) && Number.isInteger(b)) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 2) set.add(i);
      }
    } else {
      const n = Number(s);
      if (Number.isInteger(n) && n >= 2) set.add(n);
    }
  });
  return Array.from(set).sort((x, y) => x - y);
}