/*************************************************
 * MathpixTagNormalize.gs — Mathpix 식 번호(\tag) → 원본 표기 정본  (2026-09-19 도입 · **2026-11-17 반대 방향으로 개정**)
 *
 * ⚠ 2026-11-17 (Latex 변환 개선 계획 v4): 식 번호는 **원본대로 원문자**로 쓴다. 아래 "이 파일이 하는 일 1)"의 `→ \tag{1}` 은
 *   옛 동작이다. 지금은 `\tag{ㄱ}` 를 그 자리에서 정본 `\quad \cdots \cdots \text{㉠}` 으로 바꾼다. `\tag{n}`·`(n)` 표기는 Mathory 가
 *   시트 가져오기 정돈에서 만든다. 2)·3) 은 그대로다. 보이지 않는 문자·옛한글 정리(R4)도 여기서 한다.
 *   이 파일은 latex-convert 원본·KICE 사본·문항검증(audition) 세 곳이 같은 내용으로 쓴다.
 *
 * 배경
 *  - 해설 원문의 식 번호 `⋯⋯ ㉠`(행 끝 리더 + 원문자 자음)는 Mathpix 기본 요청에서 text 에서 **제외**된다
 *    (line_data 에 equation_number 줄로 잡히지만 included:false — mathory scripts/ocrProbe.mjs 실측).
 *  - 요청에 `include_equation_tags: true` 를 주면 그 번호가 수식 안 `\tag{ㄱ}` 로 실려 온다. 대신
 *    display 수식이 `\begin{equation*} … \end{equation*}` / `\begin{align*} … \end{align*}` 로 감싸져 오고
 *    (옵션이 idiomatic_eqn_arrays 를 함께 켠다 → 다행 수식이 array 대신 aligned 로 온다),
 *    가끔 리더 잔재가 태그 **안**에 섞여 온다: `\tag{$\cdots \cdots \cdot($ ㄱ}` (실측).
 *
 * 이 파일이 하는 일 (mathory lib/ocr.ts normalizeMathpixEquationTags + lib/proofread.ts normalizeTagLabels 와 동일 규칙)
 *  1) 태그 라벨 정규화  `\tag{ㄱ}` · `\tag{(ㄱ)}` · `\tag{㉠}` · `\tag{$\cdots … ($ ㄱ}` → `\tag{1}`  (㉠=ㄱ=1 … ㉭=ㅎ=14 고정 매핑)
 *     - 내용에서 `$`·리더(\cdots \ldots \dots \cdot ⋯ … · .)·괄호·\text{} 껍질·공백을 걷어낸 뒤
 *       남는 것이 자모 하나/원문자 하나면 번호로, 숫자면 잔재만 걷은 숫자로. 그 밖(`\tag{1.2}`·`\tag{A}`)은 무접촉.
 *     - 인자는 중괄호 균형 스캔(정규식으로 `{…}` 를 잡지 않는다). 멱등.
 *  2) `\begin{equation*} … \end{equation*}` 한 겹 벗기기 (별표 유무 모두)
 *  3) `\begin{align*}` → `\begin{aligned}` (별표 유무 모두)
 *     - 2)·3) 에서 환경이 수식 구분자(`\[ \]` / `$$ $$`) **밖**에 맨몸으로 있으면 `\[ … \]` 로 감싼다
 *       (이 프로젝트의 v3/text 요청은 display 구분자를 따로 주지 않아 기본값 `\[ \]` 로 온다 — `math_block_delimiters` 는
 *        Mathpix 문서에 없는 이름이라 무시된다).
 *
 * 호출처: OcrConvert.gs · Mathpix 범위 자동변환.gs (v3/text 결과) · Mathpix 그림 추출.gs (v3/pdf mmd)
 *  — 시트에 쓰기 **직전** 한 번. 결과가 mathory 정본(`\tag{n}`)과 같아지므로 mathory 쪽 정돈(규칙 ⑤)과 충돌하지 않는다.
 *
 * 점검: 스크립트 편집기에서 mpx_selfTest 실행 → 로그에 PASS/FAIL.
 *************************************************/

const MPX_TAG_JAMO    = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const MPX_TAG_CIRCLED = '㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭';

/** s[open] === '{' 일 때 짝이 되는 '}' 의 인덱스. 없으면 -1. `\{`·`\}` 는 건너뛴다. */
function mpx_readGroup_(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/* ─── 보이지 않는 문자·옛한글 정리 (R4 — mathory lib/invisibles.ts stripInvisibles 이식) ───
 * 순서가 규칙이다: ① 조합형 음절(초성+중성[+종성])을 먼저 NFC 로 합친다 — 초성을 먼저 바꾸면 `가`가 `ㄱ`+`ᅡ`로 깨진다
 * ② 폭 없는 문자·채움 문자 제거 ③ 행 머리의 비ASCII 공백 ④ 홀로 선 초성 → 호환 자모(ᄀ→ㄱ) ⑤ 자모 뒤 전각·리더 마침표 → `.`
 * 전역 normalize('NFC') 는 쓰지 않는다(Ω·호환 한자가 바뀐다). 멱등. */
const MPX_CHOSEONG_TO_COMPAT = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function mpx_stripInvisibles_(s) {
  s = String(s == null ? '' : s);
  if (!s) return s;
  return s
    .replace(/[\u1100-\u115F][\u1160-\u11A7][\u11A8-\u11FF]?/g, function (m) { return m.normalize('NFC'); })
    .replace(/[\u200B\u200C\u2060\uFEFF\u00AD\u034F\u3164\u115F\u1160]/g, '')
    .replace(/^([ \t]*)[\u00A0\u3000\u2000-\u200A\u202F]+/gm, '$1')
    .replace(/[\u1100-\u1112](?![\u1160-\u11A7])/g, function (c) { return MPX_CHOSEONG_TO_COMPAT[c.charCodeAt(0) - 0x1100] || c; })
    .replace(/([\u3131-\u314E])[\uFF0E\u2024]/g, '$1.');
}

/** 식 번호 정본 — 수식 안, 그 식(행)의 끝. n = 1(㉠) … 14(㉭) */
function mpx_canonLabel_(n) { return '\\quad \\cdots \\cdots \\text{' + MPX_TAG_CIRCLED[n - 1] + '}'; }
function mpx_canonBecause_(n) { return '\\quad(\\because \\text{' + MPX_TAG_CIRCLED[n - 1] + '})'; }

/**
 * `\tag{…}` 의 내용이 무엇인지 판별한다 (MathpixTagNormalize 와 PostProcess 가 함께 쓴다 — 계획 v4 §3 G1·G2).
 * 반환 kind
 *   'label'   자모·원문자 하나(옛한글·리더 잔재·괄호·\text 껍질·`\neg`(ㄱ의 오독)·®(㉣)·©(㉢) 포함) → n
 *   'because' 행 끝 근거 표시 `∵ㄴ`·`\because$ㄷs` → n   (정의부가 아니다)
 *   'num'     숫자만 → value (원고의 숫자 식 번호이거나, 2026-09-19~11월 변환분에서 자모가 숫자로 바뀐 것)
 *   'maybe'   자모로 읽힐 수 있는 영문 한 글자 L(ㄴ)·C(ㄷ) → n   (같은 글에 자모 근거가 있을 때만 쓴다)
 *   'empty'   빈 태그·`()` — 라벨이 사라졌다
 *   'other'   그 밖(원고의 `*`·`가`·`참고 1`, 알 수 없는 글자)
 */
function mpx_tagClass_(content) {
  const raw = mpx_stripInvisibles_(String(content == null ? '' : content));
  if (/\d\.\d/.test(raw)) return { kind: 'other' };                        // 1.2 같은 절 번호
  const because = /\\because|∵/.test(raw);
  const core = raw
    .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:textregistered|circledR)/g, '®').replace(/\\copyright/g, '©')
    .replace(/\\neg|¬/g, 'ㄱ')
    .replace(/\\because|∵/g, '')
    .replace(/\\(?:cdots|ldots|dots|cdot|qquad|quad|[,;: ])/g, ' ')
    .replace(/[$⋯…·.()（）[\]~\s]/g, '');
  const one = function (ch) {
    const j = MPX_TAG_JAMO.indexOf(ch); if (ch.length === 1 && j !== -1) return j + 1;
    const c = MPX_TAG_CIRCLED.indexOf(ch); if (ch.length === 1 && c !== -1) return c + 1;
    if (ch === '®') return 4;                                               // 동그라미 안 ㄹ 이 R 처럼 보인 오독
    if (ch === '©') return 3;                                               // 동그라미 안 ㄷ 이 C 처럼 보인 오독
    return 0;
  };
  if (because) {
    const n = one(core.replace(/s$/, ''));                                  // `∵ㄹs` 의 s 는 닫는 괄호 잔재
    return n ? { kind: 'because', n: n } : { kind: 'other' };
  }
  if (core === '') return { kind: 'empty' };
  const n = one(core);
  if (n) return { kind: 'label', n: n };
  if (/^\d{1,3}$/.test(core)) return { kind: 'num', value: Number(core) };
  if (core === 'L') return { kind: 'maybe', n: 2 };
  if (core === 'C') return { kind: 'maybe', n: 3 };
  return { kind: 'other' };
}

/**
 * 태그가 바로 앞의 근거 표시를 되풀이한 것인가.
 *   Mathpix 는 행 끝의 `(∵ ㉠)` 을 본문에 한 번 쓰고 **같은 것을 `\tag` 로 한 번 더** 붙이곤 한다
 *   — `… =1 \quad(\because \text { (ㄱ) })  \tag{1}\\` · `…(\because \text { (ㄷ) })  \tag{\because$ㄷs}` (4131·4222·5967행 실측).
 *   이런 태그는 정의부가 아니므로 지운다. n = 태그가 가리키는 글자 번호(1=ㄱ…).
 */
function mpx_tagRepeatsBecause_(text, tagFrom, n) {
  const before = text.slice(Math.max(0, tagFrom - 80), tagFrom).replace(/\s+$/, '');
  const m = /\(\s*\\because\s*(?:\\text\s*\{\s*)?[(（]?\s*([ㄱ-ㅎ㉠-㉭ᄀ-ᄒ])\s*[)）]?\s*\}?\s*\)$/.exec(before);
  if (!m) return false;
  const ch = mpx_stripInvisibles_(m[1]);
  const k = MPX_TAG_JAMO.indexOf(ch) !== -1 ? MPX_TAG_JAMO.indexOf(ch) + 1 : MPX_TAG_CIRCLED.indexOf(ch) + 1;
  return k === n;
}

/** 글 안의 모든 `\tag{…}` 위치와 판별 결과. from = `\tag` 앞 공백의 시작(치환 범위) */
function mpx_scanTags_(text) {
  const out = [];
  const re = /[ \t]*\\tag(\*?)\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = mpx_readGroup_(text, open);
    if (close === -1) continue;
    re.lastIndex = close + 1;
    out.push({ from: m.index, to: close + 1, content: text.slice(open + 1, close), cls: mpx_tagClass_(text.slice(open + 1, close)) });
  }
  return out;
}

/**
 * 1) 식 번호 태그 → 원본 표기 정본 (2026-11-17 반대 방향 — 계획 v4 P3 G2).
 *   Mathpix(`include_equation_tags`)가 `⋯⋯ ㉠` 를 수식 안 `\tag{ㄱ}` 로 준다. 원본대로 **그 자리에** 정본
 *   `\quad \cdots \cdots \text{㉠}` 을 넣는다(Mathpix 는 `\tag` 를 식·행의 끝에 붙인다). `\tag{n}`·`(n)` 표기는 Mathory 가 만든다.
 *   - 자모·원문자·옛한글·`\neg`·®·© → 정본.  `∵ㄴ` → `\quad(\because \text{㉡})`
 *   - `\tag{7}`·`\tag{L}`·`\tag{C}` 는 **같은 글에 자모 라벨이 하나라도 있을 때만** ㄱ·ㄴ·ㄷ 의 오독으로 본다
 *   - 숫자(원고의 숫자 식 번호)·`*`·`가`·빈 태그는 그대로 둔다(빈 태그의 REVIEW 는 postfix 가 낸다)
 *   - 바로 앞의 `(\because …㉠)` 을 되풀이한 태그는 지운다(mpx_tagRepeatsBecause_)
 *   opts.jamoEvidence = true 면 글 밖의 근거(같은 문항의 인용 `(ㄱ)` 등)가 있다는 뜻 — PostProcess 가 넘긴다.
 * 반환 { fixed, count }. 멱등.
 */
function mpx_normalizeTagLabels_(text, opts) {
  text = String(text || '');
  if (text.indexOf('\\tag') < 0) return { fixed: text, count: 0 };
  const tags = mpx_scanTags_(text);
  const evidence = !!(opts && opts.jamoEvidence) || tags.some(function (t) { return t.cls.kind === 'label' || t.cls.kind === 'because'; });
  let fixed = text, count = 0;
  for (let k = tags.length - 1; k >= 0; k--) {
    const t = tags[k], c = t.cls;
    let insert = null;
    if (c.kind === 'label') insert = ' ' + mpx_canonLabel_(c.n);
    else if (c.kind === 'because') insert = ' ' + mpx_canonBecause_(c.n);
    else if (c.kind === 'maybe' && evidence) insert = ' ' + mpx_canonLabel_(c.n);
    else if (c.kind === 'num' && c.value === 7 && evidence) insert = ' ' + mpx_canonLabel_(1);
    if (insert === null) continue;
    const nn = c.kind === 'num' ? 1 : c.n;
    if (mpx_tagRepeatsBecause_(fixed, t.from, nn)) insert = '';              // 앞의 `(∵ ㉠)` 을 되풀이한 태그 — 지운다
    fixed = fixed.slice(0, t.from) + insert + fixed.slice(t.to);
    count++;
  }
  return { fixed, count };
}

/** 환경 앞뒤(공백 무시)에 display 구분자가 있는지 */
function mpx_insideDisplay_(text, from, to) {
  const before = text.slice(0, from).replace(/\s+$/, '');
  const after  = text.slice(to).replace(/^\s+/, '');
  const openOk  = /(\\\[|\$\$)$/.test(before);
  const closeOk = /^(\\\]|\$\$)/.test(after);
  return openOk && closeOk;
}

/** 2)·3) equation* 벗기기 · align* → aligned. 반환 { fixed, count } */
function mpx_unwrapEquationEnvs_(text) {
  text = String(text || '');
  let count = 0;
  // 2) equation / equation*
  const eqRe = /\\begin\{equation\*?\}[ \t]*\n?([\s\S]*?)\n?[ \t]*\\end\{equation\*?\}/g;
  let out = '';
  let last = 0, m;
  while ((m = eqRe.exec(text)) !== null) {
    const inner = m[1];
    const wrapped = mpx_insideDisplay_(text, m.index, m.index + m[0].length);
    out += text.slice(last, m.index) + (wrapped ? inner : '\\[\n' + inner + '\n\\]');
    last = m.index + m[0].length;
    count++;
  }
  text = out + text.slice(last);
  // 3) align / align* → aligned (수식 구분자 밖에 맨몸이면 \[ \] 로 감싼다)
  const alRe = /\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g;
  out = ''; last = 0;
  while ((m = alRe.exec(text)) !== null) {
    const body = '\\begin{aligned}' + m[1] + '\\end{aligned}';
    const wrapped = mpx_insideDisplay_(text, m.index, m.index + m[0].length);
    out += text.slice(last, m.index) + (wrapped ? body : '\\[\n' + body + '\n\\]');
    last = m.index + m[0].length;
    count++;
  }
  text = out + text.slice(last);
  return { fixed: text, count };
}

/** 진입점: Mathpix 결과(text / mmd) → 앱 정본. 문자열을 돌려준다. */
function mpx_normalizeEquationTags_(text) {
  const a = mpx_normalizeTagLabels_(mpx_stripInvisibles_(text));
  const b = mpx_unwrapEquationEnvs_(a.fixed);
  return b.fixed;
}

/** 점검용 — 스크립트 편집기에서 실행. mathory tests/ocr.test.mjs 의 케이스를 그대로 옮겼다. */
function mpx_selfTest() {
  const N = mpx_normalizeEquationTags_;
  const cases = [
    // equation* 한 겹 벗기고 \tag{ㄱ} → 정본  ($$ 구분자)
    ['$$\\begin{equation*}\n=\\frac{2}{(t+1)^{2}} \\tag{ㄱ}\n\\end{equation*}$$', '$$=\\frac{2}{(t+1)^{2}} \\quad \\cdots \\cdots \\text{㉠}$$'],
    // 같은 것, \[ \] 구분자 (이 프로젝트 기본)
    ['\\[\\begin{equation*}\n=\\frac{2}{(t+1)^{2}} \\tag{ㄱ}\n\\end{equation*}\\]', '\\[=\\frac{2}{(t+1)^{2}} \\quad \\cdots \\cdots \\text{㉠}\\]'],
    // 맨몸 equation* → \[ \] 로 감싼다
    ['앞\n\\begin{equation*}\nx=1 \\tag{ㄴ}\n\\end{equation*}\n뒤', '앞\n\\[\nx=1 \\quad \\cdots \\cdots \\text{㉡}\n\\]\n뒤'],
    // align* → aligned · 행의 \tag{ㄴ} → 정본
    ['$$\\begin{align*}\n& f=1 \\\\\n& g=2 \\tag{ㄴ}\n\\end{align*}$$', '$$\\begin{aligned}\n& f=1 \\\\\n& g=2 \\quad \\cdots \\cdots \\text{㉡}\n\\end{aligned}$$'],
    ['\\[\\begin{align*}\n& f=1 \\\\\n& g=2 \\tag{ㄴ}\n\\end{align*}\\]', '\\[\\begin{aligned}\n& f=1 \\\\\n& g=2 \\quad \\cdots \\cdots \\text{㉡}\n\\end{aligned}\\]'],
    // 라벨 표기 변형
    ['x \\tag{(ㄷ)}', 'x \\quad \\cdots \\cdots \\text{㉢}'],
    ['x \\tag{㉡}', 'x \\quad \\cdots \\cdots \\text{㉡}'],
    ['\\tag{3}', '\\tag{3}'],
    // 리더 잔재가 태그 안에 섞인 형태 (덕수 실측 2026-09-19)
    ['& \\Rightarrow \\frac{d t}{d s}=\\frac{2 s}{s^{2}+1} \\tag{$\\cdots \\cdots \\cdots \\cdots \\cdots \\cdot($ ㄱ}',
     '& \\Rightarrow \\frac{d t}{d s}=\\frac{2 s}{s^{2}+1} \\quad \\cdots \\cdots \\text{㉠}'],
    ['x \\tag{\\cdots \\cdots (ㄴ)}', 'x \\quad \\cdots \\cdots \\text{㉡}'],
    ['x \\tag{ ( ㄷ ) }', 'x \\quad \\cdots \\cdots \\text{㉢}'],
    ['x \\tag{ㄱ)}', 'x \\quad \\cdots \\cdots \\text{㉠}'],
    ['x \\tag{\\text{(ㄹ)}}', 'x \\quad \\cdots \\cdots \\text{㉣}'],
    ['x \\tag{……… ㉡}', 'x \\quad \\cdots \\cdots \\text{㉡}'],
    ['x \\tag{$\\cdots$ (3)}', 'x \\tag{$\\cdots$ (3)}'],   // 숫자는 그대로(원고의 숫자 식 번호)
    ['x \\tag{ᄀ}', 'x \\quad \\cdots \\cdots \\text{㉠}'], ['x \\tag{$\\neg$}', 'x \\quad \\cdots \\cdots \\text{㉠}'], ['x \\tag{∵ㄴ}', 'x \\quad(\\because \\text{㉡})'],   // 옛한글·오독·근거 표시 (2026-11-17)
    ['a \\tag{7}\nb \\tag{ㄴ}', 'a \\quad \\cdots \\cdots \\text{㉠}\nb \\quad \\cdots \\cdots \\text{㉡}'], ['a \\tag{7}', 'a \\tag{7}'],
    ['x \\tag*{(ㄱ)}', 'x \\quad \\cdots \\cdots \\text{㉠}'],
    // 판단할 수 없는 태그는 무접촉
    ['\\tag{1}', '\\tag{1}'], ['\\tag{1.2}', '\\tag{1.2}'], ['\\tag{A}', '\\tag{A}'], ['\\tag{ㄱㄴ}', '\\tag{ㄱㄴ}'], ['\\tag{12}', '\\tag{12}'],
    // 태그 없는 본문은 그대로
    ['$f(t)$ 는 부채꼴의 넓이이므로', '$f(t)$ 는 부채꼴의 넓이이므로'],
  ];
  let pass = 0, fail = 0;
  cases.forEach(function (c, i) {
    const got = N(c[0]);
    if (got === c[1]) { pass++; }
    else { fail++; Logger.log('FAIL #' + i + '\n  in : ' + JSON.stringify(c[0]) + '\n  exp: ' + JSON.stringify(c[1]) + '\n  got: ' + JSON.stringify(got)); }
  });
  // 멱등성
  cases.forEach(function (c, i) {
    const once = N(c[0]);
    if (N(once) !== once) { fail++; Logger.log('IDEMPOTENT FAIL #' + i + ': ' + JSON.stringify(once)); }
  });
  Logger.log('mpx_selfTest: PASS ' + pass + ' / FAIL ' + fail);
  return fail === 0;
}