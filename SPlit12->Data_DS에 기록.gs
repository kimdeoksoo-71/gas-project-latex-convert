/*************************************************
 * split_12!F2:H13 → Data_DS!A:C 로 이어붙이기
 * - 완료 후 split_12의 A1 + B/D/E/G/H열 2행 이하 초기화
 *************************************************/

function append_split12_to_DataDS() {
  const ss  = SpreadsheetApp.getActive();
  const src = ss.getSheetByName('split_12');
  const dst = ss.getSheetByName('Data_DS');
  if (!src) throw new Error('split_12 시트를 찾을 수 없습니다.');
  if (!dst) throw new Error('Data_DS 시트를 찾을 수 없습니다.');

  // 1) 소스 범위: split_12!F2:H13 (12행, 3열)
  const rawValues = src.getRange(2, 6, 12, 3).getValues();

  // 2) 완전히 빈 행 제거
  const values = rawValues.filter(r => r.some(v => String(v).trim() !== ''));
  if (values.length === 0) {
    SpreadsheetApp.getUi().alert('붙여넣을 데이터가 없습니다. (F2~H13이 모두 비어있음)');
    return;
  }

  // 3) Data_DS 마지막 데이터 행 다음에 쓰기
  const lastDataRow = getLastDataRowInColsABC_(dst);
  const startRow = (lastDataRow >= 2) ? lastDataRow + 1 : 2;
  dst.getRange(startRow, 1, values.length, 3).setValues(values);

  // 4) split_12 초기화: A1 + B/D/E/G/H열
  clearSplitSheet_(src);

  // 5) 안내
  SpreadsheetApp.getUi().alert(
    `총 ${values.length}개 행을 Data_DS!A:C에 추가했습니다.\n` +
    `시작행: ${startRow}  / 종료행: ${startRow + values.length - 1}\n` +
    `split_12 시트의 A1 및 B/D/E/G/H열을 초기화했습니다.`
  );
}