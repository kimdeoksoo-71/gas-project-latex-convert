/*************************************************
 * Data_Latex A열 파일명 기반 — 문제/해설 행 자동 탐색
 *
 * keyword: split 시트 A1에 적힌 필터 텍스트
 *   - 비어있으면 필터 없이 _문/_해 조건만 적용
 *   - 값이 있으면 keyword와 _문/_해를 동시에 포함하는 행만 선택
 *
 * 반환: 행 번호 배열 (예: [2,3,4,5]) 또는 빈 배열
 *************************************************/

/** 문제 행 번호 배열 */
function findQuestionRows_(keyword) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Data_Latex');
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const kw = (keyword || '').trim();
  const aVals = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  const rows = [];

  for (let i = 0; i < aVals.length; i++) {
    const name = String(aVals[i][0] || '');
    if (/_문/.test(name) && (!kw || name.indexOf(kw) !== -1)) {
      rows.push(i + 2);
    }
  }

  return rows;
}

/** 해설 행 번호 배열 */
function findSolutionRows_(keyword) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Data_Latex');
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const kw = (keyword || '').trim();
  const aVals = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  const rows = [];

  for (let i = 0; i < aVals.length; i++) {
    const name = String(aVals[i][0] || '');
    if (/_해|_풀이/.test(name) && (!kw || name.indexOf(kw) !== -1)) {
      rows.push(i + 2);
    }
  }

  return rows;
}

/** 행 번호 배열로부터 Data_Latex C열 값을 순서대로 읽어 합치기 */
function readAndMergeCValues_(rows) {
  if (!rows.length) return '';
  const sh = SpreadsheetApp.getActive().getSheetByName('Data_Latex');
  if (!sh) return '';

  const values = rows.map(r => {
    const v = sh.getRange(r, 3).getValue();
    return v == null ? '' : String(v);
  });

  return values.join('\n');
}

/*************************************************
 * 셀 안전 쓰기 (50000자 제한 대응)
 *************************************************/
const CELL_CHAR_LIMIT_ = 49999;

function safeCellWrite_(cell, text) {
  if (text.length <= CELL_CHAR_LIMIT_) {
    cell.setValue(text);
  } else {
    cell.setValue(
      text.slice(0, CELL_CHAR_LIMIT_ - 100) +
      '\n\n… [총 ' + text.length.toLocaleString() + '자 중 셀 한도 초과로 잘림]'
    );
  }
}

/*************************************************
 * split 시트 초기화 / Data_DS 유틸 (공용)
 *************************************************/

/** split 시트 초기화: A1 지우기 + B/D/E열 2행 이하 지우기 (G/H열은 보존) */
function clearSplitSheet_(sheet) {
  const maxRows = sheet.getMaxRows();
  sheet.getRange('A1').clearContent();
  if (maxRows < 2) return;
  [2, 4, 5].forEach(col => {  // G(7), H(8)열은 제외하여 보존
    sheet.getRange(2, col, maxRows - 1, 1).clearContent();
  });
}

/** Data_DS의 A:C에서 마지막 데이터가 있는 행 번호를 반환 (없으면 1) */
function getLastDataRowInColsABC_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const rng = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (let i = rng.length - 1; i >= 0; i--) {
    if (rng[i].some(v => String(v).trim() !== '')) return i + 2;
  }
  return 1;
}