/*************************************************
 * 해설 병합+Split → split_46!B48~B93
 * - A열 파일명에서 해설 행(_해 / _해설 / _풀이) 자동 탐색
 * - split_46!A1 텍스트로 특정 문제지만 필터링
 *************************************************/

function mergeSolutionAndSplit_to_split46() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();

  const src = ss.getSheetByName('Data_Latex');
  const dst = ss.getSheetByName('split_46');

  if (!src) throw new Error('Data_Latex 시트를 찾을 수 없습니다.');
  if (!dst) throw new Error('split_46 시트를 찾을 수 없습니다.');

  const keyword = String(dst.getRange('A1').getValue() || '').trim();
  const rows = findSolutionRows_(keyword);

  if (rows.length === 0) {
    ui.alert(keyword
      ? `Data_Latex A열에서 "${keyword}"를 포함한 해설 행을 찾을 수 없습니다.`
      : 'Data_Latex A열에서 해설 행(_해 또는 _해설 또는 _풀이)을 찾을 수 없습니다.');
    return;
  }

  const combined = readAndMergeCValues_(rows);
  safeCellWrite_(dst.getRange('E2'), combined);

  const re = /(?:^|\r?\n)(\d{1,2}\.?[ \t]*\r?\n[\s\S]*?)(?=\r?\n\d{1,2}\.?[ \t]*\r?\n|$)/g;
  const segments = [];
  let m;
  while ((m = re.exec(combined)) !== null) {
    const seg = (m[1] || '').trim();
    if (seg) segments.push(seg);
  }

  const START_ROW = 48;
  const MAX_ROWS  = 46;
  dst.getRange(START_ROW, 2, MAX_ROWS, 1).clearContent();

  const toWrite = segments.slice(0, MAX_ROWS).map(s => [s]);
  if (toWrite.length > 0) {
    dst.getRange(START_ROW, 2, toWrite.length, 1).setValues(toWrite);
  }

  const info =
    (keyword ? `필터: "${keyword}"\n` : '') +
    `대상 행: ${rows.length}개 (${rows[0]}~${rows[rows.length-1]}행)\n` +
    `병합 텍스트: ${combined.length.toLocaleString()}자\n` +
    `추출된 블록 개수: ${segments.length}\n` +
    (segments.length > MAX_ROWS
      ? `주의: 최대 ${MAX_ROWS}개까지만 B${START_ROW}~B${START_ROW + MAX_ROWS - 1}에 기록되었습니다.`
      : `기록 범위: B${START_ROW}~B${START_ROW + toWrite.length - 1}`);
  ui.alert('완료', info, ui.ButtonSet.OK);
}