/*************************************************
 * Data_Latex!C → split_38!D2 병합 + B2~B39 분할
 * - A열 파일명에서 문제 행(_문 / _문제) 자동 탐색
 * - split_38!A1 텍스트로 특정 문제지만 필터링
 *************************************************/

function mergeLatexAndSplit_to_split38() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();

  const src = ss.getSheetByName('Data_Latex');
  const dst = ss.getSheetByName('split_38');

  if (!src) throw new Error('Data_Latex 시트를 찾을 수 없습니다.');
  if (!dst) throw new Error('split_38 시트를 찾을 수 없습니다.');

  // A1 셀의 필터 키워드 읽기
  const keyword = String(dst.getRange('A1').getValue() || '').trim();
  const rows = findQuestionRows_(keyword);

  if (rows.length === 0) {
    ui.alert(keyword
      ? `Data_Latex A열에서 "${keyword}"를 포함한 문제 행을 찾을 수 없습니다.`
      : 'Data_Latex A열에서 문제 행(_문 또는 _문제)을 찾을 수 없습니다.');
    return;
  }

  const combined = readAndMergeCValues_(rows);
  safeCellWrite_(dst.getRange('D2'), combined);

  const re = /(?:^|\r?\n)(\d{1,2}\s*\.\s*[\s\S]*?)(?=(?:\r?\n)\d{1,2}\s*\.\s*|$)/g;
  const segments = [];
  let m;
  while ((m = re.exec(combined)) !== null) {
    const seg = (m[1] || '').trim();
    if (seg) segments.push(seg);
  }

  const MAX_ROWS = 38;
  dst.getRange(2, 2, MAX_ROWS, 1).clearContent();

  const toWrite = segments.slice(0, MAX_ROWS).map(s => [s]);
  if (toWrite.length > 0) {
    dst.getRange(2, 2, toWrite.length, 1).setValues(toWrite);
  }

  const info =
    (keyword ? `필터: "${keyword}"\n` : '') +
    `대상 행: ${rows.length}개 (${rows[0]}~${rows[rows.length-1]}행)\n` +
    `병합 텍스트: ${combined.length.toLocaleString()}자\n` +
    `추출된 블록 개수: ${segments.length}\n` +
    (segments.length > MAX_ROWS
      ? `주의: 최대 ${MAX_ROWS}개까지만 기록되었습니다.`
      : `기록 범위: B2~B${toWrite.length + 1}`);
  ui.alert('완료', info, ui.ButtonSet.OK);
}