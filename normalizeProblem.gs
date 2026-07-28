/*************************************************
 * Data_DS: 원본 문제(B열) → stem(E) + choices(F~J) + answer_type(K)
 *
 * - mcq 판정: (1)~(5) 5개가 "각각 별도 행"으로 존재하면 mcq
 *    - 선지 번호는 괄호문자 (1)~(5) 와 원문자 ①~⑤ 를 모두 인정(한 문항 내 혼용 허용)
 *    - Mathpix OCR이 (1)/① 를 섞어 내보내도 정상 판별
 * - answer_type(K) 최종 3분류:
 *    - mcq_combo : choices에 ㄱ/ㄴ/ㄷ 또는 ᄀ/ᄂ/ᄃ 포함(합답형)
 *    - mcq_math  : mcq이면서 합답형이 아닌 경우(정답형/완성형)
 *    - short_int : mcq가 아닌 경우(단답형으로 취급)
 *
 * - 선택지 정규화:
 *    - 번호(마커)는 항상 원문자 ①~⑤ 로 통일하여 각 선지 앞에 부착
 *    - mcq_math: 수식은 $...$로 감싼다(이미 $...$ / $$...$$면 유지) → 예: "① $2x+1$"
 *    - mcq_combo: ᄀᄂᄃ를 ㄱㄴㄷ로 통일하고 "ㄱ, ㄴ" 형식으로 정리 → 예: "① ㄱ, ㄴ"
 *************************************************/

const DSN = {
  SHEET: 'Data_DS',

  // 입력
  COL: {
    raw: 2,      // B 원본 문제
    solution: 3  // C 해설
  },

  // 출력 (K까지만 사용)
  OUT: {
    stem: 5,      // E
    c1: 6, c2: 7, c3: 8, c4: 9, c5: 10, // F~J
    type: 11      // K  mcq_math | mcq_combo | short_int | (fail reason)
  },

  OVERWRITE_NORMALIZE: true
};

/*************************************************
 * 선지 번호(원문자) 관련 상수/헬퍼
 *  - Mathpix OCR이 (1)~(5)를 원문자 ①~⑤로 바꾸거나 그대로 두거나,
 *    한 문항 안에서 뒤섞어 내보내는 문제를 흡수한다.
 *  - 선지 판별/저장 시 번호는 항상 원문자 ①~⑤로 통일한다.
 *************************************************/
const CIRCLED_NUMS = ['①', '②', '③', '④', '⑤'];      // idx 0~4 → 선지 1~5
const CIRCLED_TO_INT = { '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5 };

/**
 * 정규화된 선지 내용 앞에 원문자 마커(①~⑤)를 붙인다.
 * @param {string} content 번호가 제거된 선지 내용(이미 $…$/합답형 정규화 완료)
 * @param {number} idx     0-based 선지 인덱스(0→①, 4→⑤)
 */
function attachCircledMarker_(content, idx) {
  const marker = CIRCLED_NUMS[idx] || '';
  const c = String(content ?? '').trim();
  return c ? (marker + ' ' + c) : marker;
}

/**
 * B열(원본 문제) 텍스트의 "행 시작 선지 번호"를 원문자로 통일한다.
 *  - (1)~(5), 전각 （1）~（5） → ①~⑤
 *  - 발문 중간에 우연히 들어간 (1) 같은 표현은 건드리지 않도록,
 *    반드시 "행 시작(앞쪽 공백 허용)" 위치의 마커만 변환한다.
 *  - 이미 원문자면 그대로 유지(멱등).
 * @param {string} text 원본 문제 텍스트
 * @returns {string} 선지 번호가 원문자로 통일된 텍스트
 */
function normalizeChoiceMarkersInText_(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = lines.map(line =>
    line.replace(/^(\s*)[\(（]([1-5])[\)）]/, (whole, sp, d) => sp + CIRCLED_NUMS[Number(d) - 1])
  );
  return out.join('\n');
}

/**
 * C열(해설) 첫머리의 "정답 (n)"을 원문자로 통일한다.
 *  - 조건: 첫머리가 문항번호(숫자 + . 또는 ))로 시작하고, 그 문항번호와
 *    "정답" 사이에 '공백/줄바꿈/빈 행'만 있는 경우(=곧바로 정답이 오는 경우)에만 변환.
 *  - 문항번호와 정답 사이의 공백류는 개수·종류·순서에 규칙이 없어도 된다.
 *    (공백만 / 행바뀜 / 빈 행 1개 이상 / 이들의 임의 조합 모두 허용)
 *  - 예) "15. 정답 (3)"        → "15. 정답 ③"
 *       "15)\n정답 (1)"        → "15)\n정답 ①"
 *       "15.\n\n   정답 (2)"   → "15.\n\n   정답 ②"
 *  - 주의: 문항번호 뒤에 정답이 곧바로 오지 않으면(사이에 다른 '문자'가 있거나
 *    해설 본문뿐이면) 변환하지 않는다. 본문 중간의 "정답은 (2)"도 대상 아님.
 * @param {string} text 해설 텍스트
 * @returns {string} 정답 선지번호가 원문자로 통일된 텍스트(해당 없으면 원본 그대로)
 */
function normalizeSolutionAnswerMarker_(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');

  // 첫머리(선행 공백/빈행 허용) 문항번호 토큰: "15." / "15)" / "15 )"
  const qHead = src.match(/^(\s*\d+\s*[.)])/);
  if (!qHead) return text; // 문항번호 없음 → 변환 안 함

  const headLen = qHead[1].length;
  const before = src.slice(0, headLen);   // 문항번호 토큰(그대로 보존)
  const after = src.slice(headLen);       // 그 뒤 전체

  // 문항번호 뒤 ~ 정답 사이에는 공백류만 허용(\s 는 개행 포함 → 공백·행바뀜·빈행의 임의 조합 흡수).
  // 정답이 아닌 다른 문자가 끼면 매치되지 않아 변환하지 않는다.
  const ANS_RE = /^(\s*정답\s*[:：]?\s*)[\(（]([1-5])[\)）]/;
  const m = after.match(ANS_RE);
  if (!m) return text;

  const convertedHead = m[1] + CIRCLED_NUMS[Number(m[2]) - 1];
  return before + convertedHead + after.slice(m[0].length);
}

/*************************************************
 * 행 입력 파서: "15, 17, 123, 10-15"
 *************************************************/
function parseRowInput_(text) {
  const set = new Set();
  String(text ?? '').split(',').forEach(part => {
    const s = part.trim();
    if (!s) return;
    if (s.includes('-')) {
      const [a, b] = s.split('-').map(v => Number(String(v).trim()));
      if (Number.isInteger(a) && Number.isInteger(b)) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
      }
    } else {
      const n = Number(s);
      if (Number.isInteger(n)) set.add(n);
    }
  });
  return Array.from(set).sort((x, y) => x - y);
}

/*************************************************
 * 시트 기록
 *************************************************/
function writeNormResult_(sh, row, r) {
  if (!r.ok) {
    // 실패면 K에 reason만 남기고 E~J는 비움
    sh.getRange(row, DSN.OUT.stem, 1, 6).setValues([[ '', '', '', '', '', '' ]]); // E~J
    sh.getRange(row, DSN.OUT.type).setValue(String(r.reason || 'FAIL'));
    return;
  }

  const stem = String(r.stem ?? '').trim();
  const choices = Array.isArray(r.choices) ? r.choices : ['', '', '', '', ''];

  sh.getRange(row, DSN.OUT.stem, 1, 6).setValues([[
    stem,
    String(choices[0] ?? ''),
    String(choices[1] ?? ''),
    String(choices[2] ?? ''),
    String(choices[3] ?? ''),
    String(choices[4] ?? '')
  ]]);

  sh.getRange(row, DSN.OUT.type).setValue(String(r.type || ''));
}

/*************************************************
 * 파서: (1)~(5) 5개 선택지가 "각각 별도 행"으로 있어야 mcq로 인정
 *************************************************/
function parseMcqFromRaw_(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  const stemLines = [];
  const choiceMap = {};
  // 앞쪽 공백 허용: 행 시작부터 공백 가능
  // 선지 마커는 다음을 모두 인정한다(한 문항 내 혼용 허용):
  //   - 괄호문자: (1)~(5)  (전각 괄호 （1） 포함)
  //   - 원문자  : ①~⑤
  const re = /^\s*(?:[\(（](\d)[\)）]|([①②③④⑤]))\s*(.+)$/;

  let inChoices = false;

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;

    const m = s.match(re);
    if (m) {
      inChoices = true;
      // 괄호문자면 m[1], 원문자면 m[2] → 항상 정수 k(1~5)로 통일
      const k = (m[1] != null) ? Number(m[1]) : CIRCLED_TO_INT[m[2]];
      const content = m[3].trim();
      if (k >= 1 && k <= 5) choiceMap[k] = content;
      continue;
    }

    // 선택지 구간에 들어간 후 (n) 패턴이 아닌 라인 처리
    if (inChoices) {
      // 숫자만 있거나 의미없는 텍스트는 무시 (정답 번호나 메타데이터)
      // 한글/영문이 섞인 실제 내용이 있으면 포맷 오류로 간주
      if (/^[\d\s]+$/.test(s) || s.length <= 3) {
        // 무시하고 계속 진행
        continue;
      }
      // 그 외는 포맷 오류
      return { ok: false, reason: 'CHOICE_BLOCK_FORMAT_BREAK' };
    }

    stemLines.push(line);
  }

  // 5개 선택지 모두 존재 확인
  for (let k = 1; k <= 5; k++) {
    if (!choiceMap[k]) return { ok: false, reason: 'CHOICE_MISSING_' + k };
  }

  return {
    ok: true,
    stem: stemLines.join('\n').trim(),
    choices: [1, 2, 3, 4, 5].map(k => choiceMap[k])
  };
}

/*************************************************
 * answer_type 판정: ㄱ/ㄴ/ㄷ 또는 ᄀ/ᄂ/ᄃ 포함되면 mcq_combo, 아니면 mcq_math
 *************************************************/
function detectAnswerTypeFromChoices_(choices) {
  const joined = (choices || []).join(' ');
  return /[ㄱㄴㄷᄀᄂᄃ]/.test(joined) ? 'mcq_combo' : 'mcq_math';
}

/*************************************************
 * 수식 선택지 정규화: $...$ 강제(이미 $...$ 또는 $$...$$면 유지)
 *************************************************/
function normalizeChoiceToLatex_(s) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  // 이미 $...$ 또는 $$...$$면 그대로
  if ((t.startsWith('$$') && t.endsWith('$$')) || (t.startsWith('$') && t.endsWith('$'))) return t;
  // 합답형 문자가 섞이면 감싸지 않음(안전장치)
  if (/[ㄱㄴㄷᄀᄂᄃ]/.test(t)) return t;
  // 그 외는 $...$
  return '$' + t + '$';
}

/*************************************************
 * 합답형 선택지 정규화: ᄀᄂᄃ(호환 자모) → ㄱㄴㄷ로 통일 + "ㄱ, ㄴ" 형식
 *************************************************/
function normalizeComboChoice_(s) {
  const t0 = String(s ?? '').trim()
    .replace(/ᄀ/g, 'ㄱ')
    .replace(/ᄂ/g, 'ㄴ')
    .replace(/ᄃ/g, 'ㄷ');

  const hasG = t0.includes('ㄱ');
  const hasN = t0.includes('ㄴ');
  const hasD = t0.includes('ㄷ');

  const arr = [];
  if (hasG) arr.push('ㄱ');
  if (hasN) arr.push('ㄴ');
  if (hasD) arr.push('ㄷ');

  return arr.join(', ');
}

/**
 * 메인메뉴에서 호출: 행번호 입력(예: 15, 17, 123, 10-15)
 */
function ds_runNormalizeAndValidate_byRowInput() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('정규화+검증(문제) 행 번호 입력', '예: 15, 17, 123, 10-15', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const rows = parseRowInput_(res.getResponseText());
  if (!rows.length) return;

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(DSN.SHEET);
  if (!sh) throw new Error(`시트 없음: ${DSN.SHEET}`);

  let ok = 0, fail = 0;

  for (const row of rows) {
    try {
      // C열(해설): 문항번호 바로 뒤에 오는 '정답 (n)'을 원문자로 통일
      //  - 문제(B) 정규화와 독립적으로 처리하며, 실패해도 문제 정규화에 영향 없음
      try {
        const solCell = sh.getRange(row, DSN.COL.solution);
        const solRaw = String(solCell.getDisplayValue() || '');
        if (solRaw) {
          const solNorm = normalizeSolutionAnswerMarker_(solRaw);
          if (solNorm !== solRaw) solCell.setValue(solNorm);
        }
      } catch (eSol) { /* 해설 정규화 오류는 무시 */ }

      const raw = String(sh.getRange(row, DSN.COL.raw).getDisplayValue() || '').trim();
      if (!raw) {
        writeNormResult_(sh, row, { ok: false, reason: 'RAW_EMPTY' });
        fail++;
        continue;
      }

      // overwrite=false면 이미 stem(E)이 있으면 skip
      if (!DSN.OVERWRITE_NORMALIZE) {
        const existingStem = String(sh.getRange(row, DSN.OUT.stem).getDisplayValue() || '').trim();
        if (existingStem) continue;
      }

      // 1) MCQ 파싱 시도
      const mcq = parseMcqFromRaw_(raw);

      if (mcq.ok) {
        const answer_type = detectAnswerTypeFromChoices_(mcq.choices);

        // type에 따라 choice 정규화 후, 번호는 항상 원문자 ①~⑤ 마커로 부착
        let choicesOut = mcq.choices.slice();
        if (answer_type === 'mcq_math') {
          choicesOut = choicesOut.map((x, i) => attachCircledMarker_(normalizeChoiceToLatex_(x), i));
        } else {
          // mcq_combo
          choicesOut = choicesOut.map((x, i) => attachCircledMarker_(normalizeComboChoice_(x), i));
        }

        // B열 원본의 선지 번호도 원문자 ①~⑤로 통일하여 덮어쓰기(5지선다 확정 행만)
        const rawNorm = normalizeChoiceMarkersInText_(raw);
        if (rawNorm !== raw) sh.getRange(row, DSN.COL.raw).setValue(rawNorm);

        writeNormResult_(sh, row, {
          ok: true,
          stem: mcq.stem,
          choices: choicesOut,
          type: answer_type
        });
        ok++;
        continue;
      }

      // 2) MCQ 아니면 단답형으로 분류
      writeNormResult_(sh, row, {
        ok: true,
        stem: raw,
        choices: ['', '', '', '', ''],
        type: 'short_int'
      });
      ok++;

    } catch (e) {
      writeNormResult_(sh, row, { ok: false, reason: 'EXCEPTION: ' + (e?.message || String(e)) });
      fail++;
    }
  }

  SpreadsheetApp.getActive().toast(`정규화 완료: 성공 ${ok}, 실패 ${fail}`, 'Data_DS', 5);
}