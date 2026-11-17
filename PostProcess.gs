/*************************************************
 * PostProcess.gs — Data_DS 후처리(postfix)  (2026-11-17 · latex-1.2.0 · Latex 변환 개선 계획 v4 실행판 P3)
 *
 * 원칙 (계획 v3 §2): Latex 변환은 원본의 표기와 구조를 충실히 옮긴다. 각 프로그램이 쓰는 표기(`\tag{n}`·`(n)` 등)는
 *   그 프로그램(Mathory) 안에서 만든다. 여기서는 Mathpix 가 잃거나 틀린 것만 되살린다.
 *
 * 단계 위치: send → normalize → answer → **postfix** → archive   (Pipeline.gs)
 *   - answer 뒤: 정답 추출이 C열 첫머리·맨 아랫줄을 읽으므로 그 뒤에 고친다
 *   - 정규화 뒤: 선지 창과 K(유형)가 이미 확정돼 있다
 *
 * 규칙 (모두 순수 함수 · 멱등).  ⚠ 실행 순서는 번호 순서가 아니다:  R4 → R5 → R1 → R2 → R3
 *   R4 pp_stripInvisibles_  보이지 않는 문자·옛한글(ᄀ→ㄱ)            문제·해설   (MathpixTagNormalize.gs 의 mpx_stripInvisibles_)
 *   R5 pp_unwrapSection_    `\section*{…}` 벗기기                       문제·해설
 *   R1 pp_labels_           식 번호(인용기호)를 원문자 정본으로          문제·해설을 함께 본다
 *        정의부  `\tag{…}`·리더 뒤 `(ㄱ)`·수식 뒤 행 끝 `(ㄱ)`  →  수식 안 `\quad \cdots \cdots \text{㉠}`
 *        인용    **괄호 있는** `(ㄱ)`                            →  `㉠`   (수식 안이면 `\text{㉠}`)
 *        무접촉  괄호 없는 자모(`ㄱ에서` — 합답형의 <보기> 인용) · <보기> 라벨 `ㄱ.` · 선지 창 · `(가)` · `(*)` · `①`
 *   R2 pp_caseLines_        경우 분류 `(i) …인 경우` 를 자기 행으로      해설만
 *   R3 pp_bogiLabels_       한 행에 붙은 <보기> 라벨 분리                문제만
 *
 * 쓰는 열: B(문제)·C(해설)·E(stem — 고친 B 에서 ds_classify_ 로 다시 만든다)·기록 열.
 *   F~J(선지)·K(유형)는 쓰지 않는다. 다시 만든 유형·선지가 시트 값과 다르면 **그 행은 쓰지 않고** REVIEW:RECLASSIFY.
 *   기록 열은 1행에서 머리글 `postfix` 를 찾고, 없으면 **Q열 이후**의 첫 빈 열에 만든다
 *   (M~P 는 Mathory 시트 가져오기가 위치로 읽는다 — M `get` 체크박스, O·P AI 정답·풀이).
 *
 * REVIEW 표시:  DEF_MISSING(인용한 글자의 정의부가 글에 없다) · DEF_DETACHED(리더+라벨만 있는 줄 — 어느 식의 번호인지 모름) · TAG_NUMERIC(숫자 태그를 그대로 둠) · TAG_EMPTY(라벨이 사라진 태그)
 *   · TAG_UNKNOWN(알 수 없는 태그) · TAG_BROKEN(KaTeX 가 못 그리는 태그) · MISREAD((7)·(L)·(¬) 오독 의심 — 자동 수정하지 않는다) · CASE_AFTER_BOGI · RECLASSIFY
 *
 * 시험: ~/CLUE/projects/문항검증자동화/patches/2026-11-17-latex-postfix/test  (node run.js · node dryrun.js)
 * 의존: MathpixTagNormalize.gs(자모 대응표·태그 판별·R4) · normalizeProblem.gs(ds_classify_·parseMcqFromRaw_·unwrapItemize_…)
 *************************************************/

const PP = {
  LOG_HEADER: 'postfix',
  LOG_MIN_COL: 17,                 // Q — A~P 는 Mathory(A1:P 위치 읽기)·문항검증(A~K)·문항장부(A~C·L)가 읽는다
  ROM: '(?:viii|vii|iii|ii|iv|ix|vi|v|i)',
  CASE_HEAD_MAX: 80                // `(i)` 와 `인 경우` 사이의 최대 길이 (그보다 멀면 경우 제목이 아니다)
};
const PP_J = MPX_TAG_JAMO;                         // 'ㄱ…ㅎ' 14자 — ㉠…㉭ 와 1:1
const PP_LEAD_SRC = '(?:\\\\(?:cdots|ldots|dots)(?![A-Za-z])|\\\\cdot(?![A-Za-z])|[⋯…]|\\.{3,}|·{3,})';

function pp_stripInvisibles_(s) { return mpx_stripInvisibles_(s); }
function pp_circ_(jamo) { return MPX_TAG_CIRCLED[PP_J.indexOf(jamo)]; }

/* =================================================
 * 수식·그림 영역
 * ================================================= */
/** `\[..\]`·`$$..$$`(display) · `$..$`·`\(..\)`(inline, 한 줄) · 그림 링크(skip). 문서 순. */
function pp_regions_(t) {
  const out = []; const n = t.length; let i = 0;
  while (i < n) {
    const ch = t[i];
    if (ch === '\\') {
      if (t[i + 1] === '[') { const j = t.indexOf('\\]', i + 2); if (j < 0) break; out.push({ from: i, to: j + 2, innerFrom: i + 2, innerTo: j, kind: 'display' }); i = j + 2; continue; }
      if (t[i + 1] === '(') { const j = t.indexOf('\\)', i + 2); if (j < 0) break; out.push({ from: i, to: j + 2, innerFrom: i + 2, innerTo: j, kind: 'inline' }); i = j + 2; continue; }
      i += 2; continue;
    }
    if (ch === '$') {
      if (t[i + 1] === '$') { const j = t.indexOf('$$', i + 2); if (j < 0) break; out.push({ from: i, to: j + 2, innerFrom: i + 2, innerTo: j, kind: 'display' }); i = j + 2; continue; }
      let j = i + 1;
      while (j < n && t[j] !== '$' && t[j] !== '\n') { if (t[j] === '\\') j++; j++; }
      if (j < n && t[j] === '$' && j > i + 1) { out.push({ from: i, to: j + 1, innerFrom: i + 1, innerTo: j, kind: 'inline' }); i = j + 1; continue; }
      i++; continue;
    }
    if (ch === '!' && t[i + 1] === '[') {
      const m = /^!\[[^\]\n]*\]\([^)\n]*\)/.exec(t.slice(i, i + 600));
      if (m) { out.push({ from: i, to: i + m[0].length, innerFrom: i, innerTo: i, kind: 'skip' }); i += m[0].length; continue; }
    }
    i++;
  }
  return out;
}
function pp_regionAt_(regs, p) { for (let k = 0; k < regs.length; k++) { if (p >= regs[k].from && p < regs[k].to) return regs[k]; if (regs[k].from > p) break; } return null; }

/** 리더로 볼 만한가 — `\cdots`류 1개 이상, 또는 `⋯`·`…`, 또는 점 3개 이상, 또는 `\cdot` 3개 이상 */
function pp_strongLeader_(s) {
  return /\\(?:cdots|ldots|dots)(?![A-Za-z])|[⋯…]|\.{3,}|·{3,}/.test(s) || (s.match(/\\cdot(?![A-Za-z])/g) || []).length >= 3;
}

/** 객관식 문제 원문에서 선지 창이 시작하는 위치. 없으면 -1 (그 뒤는 어떤 규칙도 건드리지 않는다) */
function pp_choiceStart_(b, type) {
  if (!/^mcq/.test(String(type || ''))) return -1;
  try {
    const r = parseMcqFromRaw_(b);
    if (!r || !r.chain || !r.chain.length) return -1;
    return Math.min.apply(null, r.chain.map(function (c) { return c.start; }));
  } catch (_) { return -1; }
}

/* =================================================
 * R5  \section*{…} 벗기기
 * ================================================= */
function pp_unwrapSection_(s) {
  let t = String(s == null ? '' : s);
  if (t.indexOf('section') < 0) return t;
  const regs = pp_regions_(t);
  const re = /\\(?:sub){0,2}section\*?(?![A-Za-z])/g;
  const edits = []; let m;
  while ((m = re.exec(t)) !== null) {
    if (m.index > 0 && t[m.index - 1] === '\\') continue;
    if (pp_regionAt_(regs, m.index)) continue;
    let j = m.index + m[0].length;
    while (t[j] === ' ' || t[j] === '\t') j++;
    if (t[j] === '[') { const c = t.indexOf(']', j + 1); if (c === -1 || t.slice(j, c).indexOf('\n') !== -1) continue; j = c + 1; }
    if (t[j] !== '{') continue;
    const close = mpx_readGroup_(t, j);
    if (close === -1) continue;
    // 벗긴 글은 자기 행으로
    let from = m.index, to = close + 1;
    const before = t.slice(0, from), after = t.slice(to);
    const pre = (before === '' || /\n[ \t]*$/.test(before)) ? '' : '\n';
    const post = (after === '' || /^[ \t]*\n/.test(after)) ? '' : '\n';
    edits.push({ from: from, to: to, insert: pre + t.slice(j + 1, close).trim() + post });
    re.lastIndex = close + 1;
  }
  for (let k = edits.length - 1; k >= 0; k--) t = t.slice(0, edits[k].from) + edits[k].insert + t.slice(edits[k].to);
  return t;
}

/** A5: 해설 첫 3줄 안의 `\section*{…}` 만 벗긴다 — `\section*{13.}` 이 첫 줄이면 answer 가 번호를 떼지 못한다 (정규화 단계가 부른다) */
function pp_unwrapSectionHead_(s) {
  const t = String(s == null ? '' : s);
  if (t.indexOf('section') < 0) return t;
  const lines = t.split('\n');
  const head = pp_unwrapSection_(lines.slice(0, 3).join('\n'));
  return lines.length > 3 ? head + '\n' + lines.slice(3).join('\n') : head;
}

/* =================================================
 * R1  식 번호(인용기호) → 원문자 정본
 * ================================================= */
/**
 * (b-0) 라벨만 홀로 있는 줄 → 앞 줄에 붙인다.
 *   Mathpix 는 행 끝의 식 번호를 다음 줄로 떼어 놓곤 한다 — `…아니다.⏎⏎⋯⋯⋯ (ㄴ),` · `⇒ 함수 f(x) 는 …⏎(ㄱ)` (439줄 + 리더가 붙은 263줄 실측).
 *   앞 줄(빈 줄은 건너뛴다)이
 *     `\]`·`$$` 로 끝나는 display → 그 수식의 마지막 줄 끝에 정본
 *     인라인 수식으로 끝남      → 그 수식 안 끝에 정본
 *     산문                      → `… ⋯⋯ ㉠` (텍스트 리더 + 원문자 — Mathory 가 행 끝 정의부로 읽는 모양)
 *   리더 없는 `(ㄱ)` 줄은 다음 줄이 조사로 시작하면(`(ㄱ)⏎에 대입하면`) 줄이 끊긴 인용이므로 붙이지 않는다.
 */
function pp_attachLabelLines_(t) {
  if (!new RegExp('[' + PP_J + ']').test(t)) return t;
  const lines = t.split('\n');
  const leadOnlyMath = '\\$(?:\\s|\\\\quad|\\\\qquad|' + PP_LEAD_SRC + ')+\\$';
  const re = new RegExp('^[ \\t]*((?:(?:[⋯…]+|\\.{3,}|·{3,}|' + leadOnlyMath + ')[ \\t]*)*)(?:[(（]\\s*([' + PP_J + '])\\s*[)）]|([' + PP_J + ']))[ \\t]*[,.]?[ \\t]*$');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const leader = pp_strongLeader_(m[1] || '');
    if (!leader && !m[2]) continue;                                   // 리더도 괄호도 없는 `ㄱ` 한 글자 줄
    let p = i - 1; while (p >= 0 && (lines[p] === null || !lines[p].trim())) p--;
    if (p < 0) continue;
    if (!leader) {
      let q = i + 1; while (q < lines.length && !lines[q].trim()) q++;
      if (q < lines.length && /^[ \t]*(?:에서|에게|에 |에$|을 |를 |과 |와 |의 |이 |가 |은 |는 |으로|로 |로부터|,|\))/.test(lines[q])) continue;   // 줄이 끊긴 인용
    }
    const n = PP_J.indexOf(m[2] || m[3]) + 1, canon = mpx_canonLabel_(n);
    const P = lines[p], Pt = P.replace(/\s+$/, '');
    if (Pt.trim() === '\\]' || Pt.trim() === '$$') {
      let k = p - 1; while (k >= 0 && (lines[k] === null || !lines[k].trim())) k--;
      if (k < 0 || /^\s*(?:\\\[|\$\$)\s*$/.test(lines[k])) continue;      // 빈 수식
      lines[k] = lines[k].replace(/\s+$/, '') + ' ' + canon;
    } else if (/\\\]$/.test(Pt)) {
      lines[p] = Pt.slice(0, -2).replace(/\s+$/, '') + ' ' + canon + '\\]';
    } else if (/[^$]\$$/.test(Pt) && (Pt.match(/(?:^|[^\\])\$/g) || []).length % 2 === 0) {
      lines[p] = Pt.slice(0, -1).replace(/\s+$/, '') + ' ' + canon + '$';
    } else {
      lines[p] = Pt + ' ⋯⋯ ' + MPX_TAG_CIRCLED[n - 1];
    }
    lines[i] = null; changed = true;
  }
  return changed ? lines.filter(function (l) { return l !== null; }).join('\n') : t;
}

/** 글 하나에 (b-0) 라벨만 있는 줄  (b-i) 수식 안 리더 + 라벨  (b-ii) 수식 뒤 행 끝 라벨 을 정본으로. 반환 고친 글 */
function pp_defsInText_(t) {
  t = pp_attachLabelLines_(t);
  // (b-i) 수식 영역 안: 행 끝(`\\`·`\end{`·영역 끝)의 [리더] + `\text{(ㄱ)}` | `(ㄱ)` | `ㄱ`
  const reIn = new RegExp('(?:\\s|\\\\quad|\\\\qquad|~)*((?:' + PP_LEAD_SRC + '\\s*)+)'
    + '(?:\\\\text\\s*\\{\\s*[(（]?\\s*([' + PP_J + '])\\s*[)）]?\\s*\\}|[(（]?\\s*([' + PP_J + '])\\s*[)）]?)'
    + '(?=\\s*(?:\\\\\\\\|\\\\end\\s*\\{|$))', 'g');
  let regs = pp_regions_(t);
  for (let k = regs.length - 1; k >= 0; k--) {
    const R = regs[k]; if (R.kind === 'skip') continue;
    const inner = t.slice(R.innerFrom, R.innerTo);
    if (!new RegExp('[' + PP_J + ']').test(inner)) continue;
    const fixed = inner.replace(reIn, function (all, lead, a, b) {
      if (!pp_strongLeader_(lead)) return all;
      return ' ' + mpx_canonLabel_(PP_J.indexOf(a || b) + 1);
    });
    if (fixed !== inner) t = t.slice(0, R.innerFrom) + fixed + t.slice(R.innerTo);
  }
  // (b-ii) 수식 뒤, 행 끝의 `(ㄱ)` (리더가 있으면 괄호 없는 `ㄱ` 도) → 앞 수식 안 끝으로 옮긴다
  const reEnd = new RegExp('([(（]\\s*([' + PP_J + '])\\s*[)）]|([' + PP_J + ']))([,.]?)[ \\t]*$', 'gm');
  const cands = []; let m;
  while ((m = reEnd.exec(t)) !== null) cands.push({ from: m.index, to: m.index + m[0].length, jamo: m[2] || m[3], paren: !!m[2], punct: m[4] });
  for (let k = cands.length - 1; k >= 0; k--) {
    const c = cands[k];
    regs = pp_regions_(t);
    if (pp_regionAt_(regs, c.from)) continue;
    let p = c.from, leader = false;
    const back = function () { while (p > 0 && (t[p - 1] === ' ' || t[p - 1] === '\t')) p--; };
    back();
    // 리더뿐인 인라인 수식 `$\cdots \cdots$`
    let R2 = p > 0 ? pp_regionAt_(regs, p - 1) : null;
    if (R2 && R2.kind === 'inline' && R2.to === p) {
      const in2 = t.slice(R2.innerFrom, R2.innerTo);
      if (new RegExp('^(?:\\s|\\\\quad|\\\\qquad|' + PP_LEAD_SRC + ')+$').test(in2) && pp_strongLeader_(in2)) { leader = true; p = R2.from; back(); }
    }
    // 텍스트 리더 `⋯⋯`·`……`·`...`
    const tl = /(?:[⋯…]+|\.{3,}|·{3,})$/.exec(t.slice(Math.max(0, p - 40), p));
    if (tl) { leader = true; p -= tl[0].length; back(); }
    // 그 행에 리더와 라벨뿐이면(`\]` 다음 줄의 `⋯⋯⋯ (ㄴ),`) 윗줄의 display 수식에 붙인다
    let lineOnly = false;
    if (leader && (p === 0 || t[p - 1] === '\n')) { let q = p; while (q > 0 && /\s/.test(t[q - 1])) q--; if (q < p) { p = q; lineOnly = true; } }
    const R1 = p > 0 ? pp_regionAt_(regs, p - 1) : null;
    if (!R1 || R1.to !== p || R1.kind === 'skip') continue;                 // 앞이 수식이 아니다 — 산문 끝 라벨은 그대로(인용 규칙이 ㉠ 로 바꾼다)
    if (lineOnly && R1.kind !== 'display') continue;
    let in1 = t.slice(R1.innerFrom, R1.innerTo);
    const tailLead = new RegExp('(?:\\s|\\\\quad|\\\\qquad|~)*((?:' + PP_LEAD_SRC + '\\s*)+)$').exec(in1);
    if (tailLead && pp_strongLeader_(tailLead[1])) { leader = true; in1 = in1.slice(0, tailLead.index); }
    if (!leader && !c.paren) continue;                                      // 리더도 괄호도 없는 `$x$ ㄱ` — <보기> 문장일 수 있다
    const canon = mpx_canonLabel_(PP_J.indexOf(c.jamo) + 1);
    const closeTok = t.slice(R1.innerTo, R1.to);
    let body;
    if (R1.kind === 'display') body = in1.replace(/\s+$/, '') + ' ' + canon + '\n';
    else body = in1.replace(/\s+$/, '') + ' ' + canon;
    t = t.slice(0, R1.innerFrom) + body + closeTok + (lineOnly ? '' : c.punct) + t.slice(c.to);
  }
  return t;
}

/** pos 가 `\text{…}` 그룹 안인가 */
function pp_insideTextGroup_(t, pos, lo) {
  const k = t.lastIndexOf('\\text', pos);
  if (k < 0 || k < lo) return false;
  const open = t.indexOf('{', k);
  if (open === -1 || open > pos || !/^\s*$/.test(t.slice(k + 5, open))) return false;
  const close = mpx_readGroup_(t, open);
  return close !== -1 && close >= pos;
}

/**
 * R1. 문제(B)와 해설(C)을 함께 판정한다 — 정의부는 문제에, 인용은 해설에 있을 수 있다.
 * @param {{type?:string}} opts type = K열(answer_type). 객관식이면 B 의 선지 창을 떼고 본다
 * @returns {{B:string, C:string, review:string[]}}
 */
function pp_labels_(B, C, opts) {
  opts = opts || {};
  let b = String(B == null ? '' : B), c = String(C == null ? '' : C);
  const review = [];
  const jre = new RegExp('[' + PP_J + ']');
  if (!jre.test(b + c) && (b + c).indexOf('\\tag') < 0 && !/[㉠-㉭]/.test(b + c)) return { B: b, C: c, review: review };

  let bTail = '';
  const win = pp_choiceStart_(b, opts.type);
  if (win >= 0) { bTail = b.slice(win); b = b.slice(0, win); }

  const citeRe = new RegExp('[(（]\\s*([' + PP_J + '])\\s*[)）]', 'g');
  const cited0 = {}; let m;
  const all0 = b + '\n' + c;
  while ((m = citeRe.exec(all0)) !== null) cited0[PP_J.indexOf(m[1]) + 1] = true;
  const tags0 = mpx_scanTags_(all0);
  const evidence = Object.keys(cited0).length > 0 || /[㉠-㉭]/.test(all0)
    || tags0.some(function (t) { return t.cls.kind === 'label' || t.cls.kind === 'because'; });

  // (a) \tag{…} → 정본.  숫자 태그는 "그 글자의 인용 (ㄱ) 이 같은 행에 있을 때" 자모에서 온 것으로 본다
  const fixTags = function (t) {
    const tags = mpx_scanTags_(t);
    for (let k = tags.length - 1; k >= 0; k--) {
      const g = tags[k], cls = g.cls; let ins = null;
      if (cls.kind === 'label') ins = ' ' + mpx_canonLabel_(cls.n);
      else if (cls.kind === 'because') ins = ' ' + mpx_canonBecause_(cls.n);
      else if (cls.kind === 'maybe') { if (evidence) ins = ' ' + mpx_canonLabel_(cls.n); else review.push('TAG_UNKNOWN:' + g.content.slice(0, 12)); }
      else if (cls.kind === 'num') {
        if (cls.value >= 1 && cls.value <= 14 && cited0[cls.value]) ins = ' ' + mpx_canonLabel_(cls.value);
        else if (cls.value === 7 && evidence) ins = ' ' + mpx_canonLabel_(1);          // ㄱ 을 7 로 읽은 것
        else review.push('TAG_NUMERIC:' + cls.value);
      }
      else if (cls.kind === 'empty') review.push('TAG_EMPTY');
      else if (/[$]|\\because|∵/.test(g.content)) review.push('TAG_BROKEN:' + g.content.slice(0, 12));          // `\tag{$가}` 처럼 KaTeX 가 못 그리는 태그
      else if (!/^[\s*★☆]+$|[가-힣]/.test(g.content)) review.push('TAG_UNKNOWN:' + g.content.slice(0, 12));
      if (ins !== null) {
        const nn = cls.kind === 'num' ? ((cls.value >= 1 && cls.value <= 14 && cited0[cls.value]) ? cls.value : 1) : cls.n;
        if (mpx_tagRepeatsBecause_(t, g.from, nn)) ins = '';                 // 앞의 `(∵ ㉠)` 을 되풀이한 태그 — 정의부가 아니다
        t = t.slice(0, g.from) + ins + t.slice(g.to);
      }
    }
    return t;
  };
  b = fixTags(b); c = fixTags(c);

  // (b) 글자로 남은 정의부
  b = pp_defsInText_(b); c = pp_defsInText_(c);

  // (c) 인용: 괄호 있는 (ㄱ) → ㉠
  const citedNow = {};
  const cite = function (t) {
    t = t.replace(new RegExp('\\\\text\\s*\\{\\s*[(（]\\s*([' + PP_J + '])\\s*[)）]\\s*\\}', 'g'),
      function (all, j) { citedNow[PP_J.indexOf(j) + 1] = true; return '\\text{' + pp_circ_(j) + '}'; });
    const hits = []; let x; const re = new RegExp(citeRe.source, 'g');
    while ((x = re.exec(t)) !== null) hits.push({ from: x.index, to: x.index + x[0].length, j: x[1] });
    if (!hits.length) return t;
    const regs = pp_regions_(t);
    for (let k = hits.length - 1; k >= 0; k--) {
      const h = hits[k], R = pp_regionAt_(regs, h.from);
      if (R && R.kind === 'skip') continue;
      citedNow[PP_J.indexOf(h.j) + 1] = true;
      const inMath = R && h.from >= R.innerFrom && h.to <= R.innerTo;
      const ins = (inMath && !pp_insideTextGroup_(t, h.from, R.innerFrom)) ? '\\text{' + pp_circ_(h.j) + '}' : pp_circ_(h.j);
      t = t.slice(0, h.from) + ins + t.slice(h.to);
    }
    return t;
  };
  b = cite(b); c = cite(c);

  // 정의부가 있는 글자: 리더 뒤의 ㉠ (수식 안 정본이든 텍스트 리더든)
  const all1 = b + '\n' + c; const defs = {};
  const dre = new RegExp(PP_LEAD_SRC + '[\\s$~]*(?:\\\\text\\s*\\{\\s*)?([㉠-㉭])', 'g');
  while ((m = dre.exec(all1)) !== null) defs[MPX_TAG_CIRCLED.indexOf(m[1]) + 1] = true;
  // 쓰인 글자 = 이번에 바꾼 인용 + 이미 원문자로 있던 것(다시 돌려도 같은 표시가 나오도록 — 기록 열이 실행마다 달라지면 안 된다)
  const used = {}; Object.keys(citedNow).forEach(function (k) { used[k] = true; });
  const ure = /[㉠-㉭]/g; while ((m = ure.exec(all1)) !== null) used[MPX_TAG_CIRCLED.indexOf(m[0]) + 1] = true;
  const missing = Object.keys(used).map(Number).filter(function (n) { return !defs[n]; }).sort(function (x, y) { return x - y; });
  if (missing.length) review.push('DEF_MISSING:' + missing.map(function (n) { return MPX_TAG_CIRCLED[n - 1]; }).join(''));

  // 줄에 리더와 라벨뿐인데 붙일 앞 줄이 없었다(글의 첫 줄 등)
  if (new RegExp('^[ \\t]*(?:' + PP_LEAD_SRC + '[ \\t]*)+[㉠-㉭][,.]?[ \\t]*$', 'm').test(all1)) review.push('DEF_DETACHED');

  // (d) 본문 오독 의심 — 자동으로 고치지 않는다 (계획 D6)
  if (evidence || Object.keys(used).length) {
    const mis = new RegExp(PP_LEAD_SRC + '[\\s$~]*[(（]\\s*(?:7|L|\\\\neg|¬)?\\s*[)）][ \\t]*[,.]?[ \\t]*$', 'm');
    if (mis.test(all1) || /[(（]\s*(?:\\neg|¬)\s*[)）]/.test(all1)) review.push('MISREAD');
    else if (/^[ \t]*[(（]\s*(?:7|L)?\s*[)）][ \t]*[,.]?[ \t]*$/m.test(all1)) review.push('MISREAD');   // `(7)`·`()`·`(L)` 만 있는 줄 — 떼어진 라벨의 오독
  }
  return { B: b + bTail, C: c, review: review };
}

/* =================================================
 * R2  경우 분류 행 분리 (해설)
 * ================================================= */
function pp_caseLines_(C) {
  const src = String(C == null ? '' : C);
  const review = [];
  if (src.indexOf('(') < 0) return { text: src, review: review };
  const ROM = PP.ROM;
  const TOK = '\\(' + ROM + '(?:-\\d+)?\\)(?:-\\d+)?';
  // display 수식(여러 줄) 안의 줄은 건드리지 않는다
  const regs = pp_regions_(src).filter(function (r) { return r.kind === 'display'; });
  const lines = src.split('\n'); const out = [];
  let pos = 0;
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    const start = pos; pos += line.length + 1;
    if (regs.some(function (r) { return start < r.to && start + line.length > r.from; })) { out.push(line); continue; }
    if (line.indexOf('(') < 0 && line.indexOf('\\text') < 0 && line.indexOf('\\mathrm') < 0) { out.push(line); continue; }

    // ① 표기 정규화 — 인라인 수식 밖에서만: `( i )` → `(i)` · `\text{(ii)}` · `$(\mathrm{ii})$`
    line = line.replace(new RegExp('\\$\\s*\\(\\s*\\\\mathrm\\s*\\{\\s*(' + ROM + ')\\s*\\}\\s*\\)\\s*\\$', 'g'), '($1)');
    {
      const rg = pp_regions_(line); let acc = '', last = 0;
      const fix = function (seg) {
        return seg.replace(new RegExp('\\(\\s+(' + ROM + '(?:\\s*-\\s*\\d+)?)\\s*\\)|\\((' + ROM + '(?:\\s*-\\s*\\d+)?)\\s+\\)', 'g'),
          function (all, a, b) { return '(' + (a || b).replace(/\s+/g, '') + ')'; });
      };
      for (let k = 0; k < rg.length; k++) { acc += fix(line.slice(last, rg[k].from)) + line.slice(rg[k].from, rg[k].to); last = rg[k].to; }
      line = acc + fix(line.slice(last));
    }

    // ② 행 중간의 `(i) … 인 경우` 앞에서 줄바꿈 (앞이 문장 끝이거나 <보기> 라벨일 때만 · 재인용은 끊지 않는다)
    const pieces = [];
    {
      const rg = pp_regions_(line);
      const re = new RegExp(TOK, 'g'); let m; let cut = -1; let bogi = false;
      while ((m = re.exec(line)) !== null) {
        if (m.index === 0 || pp_regionAt_(rg, m.index)) continue;
        const before = line.slice(0, m.index).replace(/\s+$/, '');
        if (before === '') continue;                                         // 들여쓰기뿐 — 행 머리로 본다
        const after = line.slice(m.index + m[0].length);
        if (/^\s*(?:,|에서|에 의|의 |과 |와 |로부터|이외|를 |을 |\))/.test(after)) continue;   // 재인용
        const k = after.indexOf('인 경우');
        if (k < 0 || k > PP.CASE_HEAD_MAX) continue;
        if (/^[ㄱ-ㅎ]\.$/.test(before)) { cut = m.index; bogi = true; break; }
        if (/[.。]$/.test(before)) { cut = m.index; break; }
      }
      if (cut >= 0) { pieces.push(line.slice(0, cut).replace(/\s+$/, '')); line = line.slice(cut); if (bogi) review.push('CASE_AFTER_BOGI'); }
    }

    // ③ 행 머리 `(i) … 인 경우[,:]` 뒤에 본문이 이어지면 줄바꿈
    {
      const head = new RegExp('^[ \\t]*' + TOK).exec(line);
      if (head) {
        const k = line.indexOf('인 경우', head[0].length);
        if (k >= 0 && k - head[0].length <= PP.CASE_HEAD_MAX && !/[.。]\s/.test(line.slice(head[0].length, k))) {
          let e = k + '인 경우'.length;
          const pm = /^[ \t]*[,:]/.exec(line.slice(e)); if (pm) e += pm[0].length;
          const rest = line.slice(e);
          // `인 경우에는` 처럼 낱말이 이어지면 제목이 아니다
          if (rest.replace(/\s+$/, '') !== '' && /^[ \t]/.test(rest) && !/^[ \t]*[.。]?[ \t]*$/.test(rest)) {
            pieces.push(line.slice(0, e)); line = rest.replace(/^[ \t]+/, '');
          }
        }
      }
    }
    pieces.push(line);
    for (let k = 0; k < pieces.length; k++) out.push(pieces[k]);
  }
  return { text: out.join('\n'), review: review };
}

/* =================================================
 * R3  <보기> 라벨 정리 (문제)
 * ================================================= */
function pp_bogiLabels_(B) {
  const src = String(B == null ? '' : B);
  const review = [];
  if (!/[<〈]\s*보\s*기\s*[>〉]/.test(src)) return { text: src, review: review };
  const lines = src.split('\n'); const out = [];
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    const h = /^[ \t]*([ㄱㄴㄷㄹㅁ])\.[ \t]/.exec(line);
    if (!h) { out.push(line); continue; }
    // 같은 행에 다음 차례의 라벨이 이어 붙어 있으면 거기서 나눈다 (수식 밖 · 공백 뒤)
    let cur = 'ㄱㄴㄷㄹㅁ'.indexOf(h[1]);
    for (;;) {
      const next = 'ㄱㄴㄷㄹㅁ'[cur + 1]; if (!next) break;
      const rg = pp_regions_(line);
      const re = new RegExp('[ \\t]+' + next + '\\.[ \\t]', 'g'); let m, cut = -1;
      while ((m = re.exec(line)) !== null) { if (!pp_regionAt_(rg, m.index)) { cut = m.index; break; } }
      if (cut < 0) break;
      out.push(line.slice(0, cut)); line = line.slice(cut).replace(/^[ \t]+/, ''); cur++;
    }
    out.push(line);
  }
  return { text: out.join('\n'), review: review };
}

/* =================================================
 * 한 행 전체 (순수)
 * ================================================= */
/**
 * @param {{key?:string, B:string, C:string, K?:string}} row
 * @returns {{B:string, C:string, rules:Object<string,number>, review:string[]}}  rules = 바뀐 규칙(1) · 바뀐 것이 없으면 빈 객체
 */
function pp_applyRow_(row) {
  let b = String(row.B == null ? '' : row.B), c = String(row.C == null ? '' : row.C);
  const type = String(row.K || '');
  const rules = {}, review = [];
  const step = function (id, nb, nc) { if (nb !== b || nc !== c) rules[id] = 1; b = nb; c = nc; };

  step('R4', pp_stripInvisibles_(b), pp_stripInvisibles_(c));

  // 문제는 선지 창 앞(본문)만 고친다
  const split = function (t) { const w = pp_choiceStart_(t, type); return w >= 0 ? [t.slice(0, w), t.slice(w)] : [t, '']; };
  { const p = split(b); step('R5', pp_unwrapSection_(p[0]) + p[1], pp_unwrapSection_(c)); }
  { const r = pp_labels_(b, c, { type: type }); step('R1', r.B, r.C); r.review.forEach(function (v) { review.push(v); }); }
  { const r = pp_caseLines_(c); step('R2', b, r.text); r.review.forEach(function (v) { review.push(v); }); }
  { const p = split(b); const r = pp_bogiLabels_(p[0]); step('R3', r.text + p[1], c); r.review.forEach(function (v) { review.push(v); }); }

  // 같은 표시는 한 번만
  const seen = {}; const rv = review.filter(function (v) { if (seen[v]) return false; seen[v] = true; return true; });
  return { B: b, C: c, rules: rules, review: rv };
}

/* =================================================
 * 시트 쓰기 (묶음) — 파이프라인 postfix 단계·메뉴 공용
 * ================================================= */
/** 기록 열 번호. 1행에서 머리글 `postfix` 를 찾고, 없으면(create=true 일 때) Q열 이후 첫 빈 머리글 열에 만든다. 없고 만들지 않으면 0 */
function pp_logCol_(sh, create) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  const i = head.indexOf(PP.LOG_HEADER);
  if (i >= 0) return i + 1;
  if (!create) return 0;
  let col = PP.LOG_MIN_COL;
  while (col <= lastCol && head[col - 1] !== '') col++;
  if (sh.getMaxColumns() < col) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  sh.getRange(1, col).setValue(PP.LOG_HEADER);
  return col;
}

/** 기록 문자열: `R1 R2 | REVIEW:DEF_MISSING:㉠ …` · 바뀐 것도 표시도 없으면 `-` */
function pp_logText_(rules, review) {
  const a = Object.keys(rules || {}).sort().join(' ');
  const b = (review || []).map(function (v) { return 'REVIEW:' + v; }).join(' ');
  return (a || b) ? [a, b].filter(Boolean).join(' | ') : '-';
}

/**
 * Data_DS 의 행 범위에 후처리를 적용한다 (묶음 읽기 1회 · 쓰기는 바뀐 열만 묶음으로).
 *  정규화(ds_normalizeRow_)와 같은 순서로 부수 효과를 재현한다(계획 v3 A4): C(정답 마커·itemize) → B(rawOut) → E.
 *  다시 만든 유형·선지가 시트 값과 다르면 그 행은 쓰지 않고 REVIEW:RECLASSIFY 만 기록한다.
 * @param {{dryRun?:boolean}} [opts] dryRun 이면 시트에 쓰지 않는다(기록 열도 만들지 않는다)
 * @returns {{rows:number, changed:number, rules:Object, review:Object<string,number[]>, reclassify:number[]}}
 */
function pp_processRows_(sh, startRow, endRow, opts) {
  opts = opts || {};
  const st = { rows: 0, changed: 0, rules: {}, review: {}, reclassify: [] };
  if (endRow < startRow) return st;
  const n = endRow - startRow + 1;
  const vals = sh.getRange(startRow, 1, n, DSN.OUT.type).getValues();          // A~K
  const logCol = opts.dryRun ? 0 : pp_logCol_(sh, true);
  const outBC = [], outE = [], outLog = []; let touched = false;
  for (let i = 0; i < n; i++) {
    const v = vals[i], row = startRow + i;
    const key = String(v[DSN.COL.key - 1] == null ? '' : v[DSN.COL.key - 1]).trim();
    const B0 = String(v[DSN.COL.raw - 1] == null ? '' : v[DSN.COL.raw - 1]);
    const C0 = String(v[DSN.COL.solution - 1] == null ? '' : v[DSN.COL.solution - 1]);
    const E0 = String(v[DSN.OUT.stem - 1] == null ? '' : v[DSN.OUT.stem - 1]);
    const K0 = String(v[DSN.OUT.type - 1] == null ? '' : v[DSN.OUT.type - 1]).trim();
    if (!key && !B0.trim()) { outBC.push([v[DSN.COL.raw - 1], v[DSN.COL.solution - 1]]); outE.push([v[DSN.OUT.stem - 1]]); outLog.push(['']); continue; }
    st.rows++;
    let r, B1 = B0, C1 = C0, E1 = E0, review = [], rules = {};
    try {
      r = pp_applyRow_({ key: key, B: B0, C: C0, K: K0 });
      rules = r.rules; review = r.review.slice();
      // 정규화와 같은 부수 효과
      let cOut = r.C;
      if (cOut) { cOut = normalizeSolutionAnswerMarker_(cOut); if (DSN.UNWRAP_ITEMIZE !== false) cOut = unwrapItemize_(cOut); }
      const cls = ds_classify_(key, String(r.B).trim(), DSN);
      const type = String(cls.ok ? (cls.type || '') : (cls.type || cls.reason || 'FAIL'));
      const ch = (cls.ok && Array.isArray(cls.choices)) ? cls.choices.map(function (x) { return String(x == null ? '' : x); }) : ['', '', '', '', ''];
      const ch0 = [v[DSN.OUT.c1 - 1], v[DSN.OUT.c2 - 1], v[DSN.OUT.c3 - 1], v[DSN.OUT.c4 - 1], v[DSN.OUT.c5 - 1]].map(function (x) { return String(x == null ? '' : x).trim(); });
      if (type !== K0 || ch.join('\u0001') !== ch0.join('\u0001')) {
        review = ['RECLASSIFY:' + (type !== K0 ? K0 + '→' + type : '선지')]; rules = {};
        st.reclassify.push(row);
      } else {
        B1 = (cls.ok && cls.rawOut != null) ? cls.rawOut : r.B;
        C1 = cOut;
        E1 = cls.ok ? String(cls.stem == null ? '' : cls.stem).trim() : String(cls.stem == null ? '' : cls.stem);
      }
    } catch (e) {
      review = ['EXCEPTION:' + String(e && e.message || e).slice(0, 80)]; rules = {};
    }
    const diff = (B1 !== B0 || C1 !== C0 || E1 !== E0);
    if (diff) { st.changed++; touched = true; }
    Object.keys(rules).forEach(function (k) { st.rules[k] = (st.rules[k] || 0) + 1; });
    review.forEach(function (x) { const k = String(x).split(':')[0]; (st.review[k] = st.review[k] || []).push(row); });
    outBC.push([B1, C1]); outE.push([E1]); outLog.push([pp_logText_(rules, review)]);
  }
  if (!opts.dryRun) {
    if (touched) {
      sh.getRange(startRow, DSN.COL.raw, n, 2).setValues(outBC);
      sh.getRange(startRow, DSN.OUT.stem, n, 1).setValues(outE);
    }
    sh.getRange(startRow, logCol, n, 1).setValues(outLog);
  }
  return st;
}

/* =================================================
 * 메뉴
 * ================================================= */
function pp_summaryText_(st, dry) {
  const lines = [`${dry ? '점검' : '후처리'} ${st.rows}행 — ${dry ? '바뀔' : '바뀐'} 행 ${st.changed}`,
    '규칙별: ' + (Object.keys(st.rules).sort().map(k => `${k} ${st.rules[k]}`).join(' · ') || '없음')];
  Object.keys(st.review).sort().forEach(k => {
    const rows = st.review[k];
    lines.push(`REVIEW ${k} ${rows.length}건` + (rows.length <= 40 ? `: ${rows.join(', ')}` : `: ${rows.slice(0, 40).join(', ')} …`));
  });
  return lines.join('\n');
}

function pp_menuRun_(dry) {
  const ui = SpreadsheetApp.getUi();
  if (!dry && typeof pl_isBusy_ === 'function' && pl_isBusy_()) { ui.alert('파이프라인이 실행 중입니다', pl_busyMessage_(), ui.ButtonSet.OK); return; }
  const res = ui.prompt(dry ? '후처리 점검 (쓰기 없음)' : '기존 행 후처리',
    '행 범위 (예: 4123-4500)' + (dry ? '. 비우면 전체' : '') + '\n한 번에 6분 안에 끝나는 만큼만 처리하고, 남으면 어디까지 했는지 알려 줍니다.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(DSN.SHEET);
  if (!sh) throw new Error(`시트 없음: ${DSN.SHEET}`);
  const last = dlds_lastDataRow_(sh, 1);
  let a = 2, b = last;
  const t = String(res.getResponseText() || '').trim();
  if (t) { const mm = t.match(/^(\d+)\s*[-~]\s*(\d+)$/) || t.match(/^(\d+)$/); if (!mm) { ui.alert('행 범위를 읽을 수 없습니다: ' + t); return; } a = Math.max(2, Number(mm[1])); b = Math.min(last, Number(mm[2] || mm[1])); }
  else if (!dry) { ui.alert('쓰기는 행 범위를 꼭 적어야 합니다.'); return; }
  if (b < a) { ui.alert('대상 행이 없습니다.'); return; }

  const t0 = Date.now(), LIMIT = 4.5 * 60 * 1000, CHUNK = 100;
  const tot = { rows: 0, changed: 0, rules: {}, review: {}, reclassify: [] };
  let cur = a;
  while (cur <= b && Date.now() - t0 < LIMIT) {
    const end = Math.min(cur + CHUNK - 1, b);
    const st = pp_processRows_(sh, cur, end, { dryRun: dry });
    tot.rows += st.rows; tot.changed += st.changed;
    Object.keys(st.rules).forEach(k => { tot.rules[k] = (tot.rules[k] || 0) + st.rules[k]; });
    Object.keys(st.review).forEach(k => { tot.review[k] = (tot.review[k] || []).concat(st.review[k]); });
    cur = end + 1;
  }
  let text = pp_summaryText_(tot, dry) + `\n\n처리한 범위 ${a}~${cur - 1}` + (cur <= b ? `  ⚠ 시간이 모자라 ${cur}~${b} 는 남았습니다. 이 범위로 다시 실행하세요.` : ' (끝)');
  Logger.log(text);
  ui.alert(dry ? '후처리 점검 결과 (시트 변경 없음)' : '기존 행 후처리 결과', text.length > 3500 ? text.slice(0, 3500) + '\n…(전체는 실행 로그)' : text, ui.ButtonSet.OK);
}
/** 메뉴 '🧹 기존 행 후처리 (행 범위)' */
function pp_runRange() { pp_menuRun_(false); }
/** 메뉴 '🔎 후처리 점검 (쓰기 없음)' */
function pp_auditRange() { pp_menuRun_(true); }
