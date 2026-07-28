function replaceRowHeadersInSelection() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  
  // 1. 사용자가 현재 마우스로 선택(드래그)한 범위를 가져옵니다.
  var range = sheet.getActiveRange();
  if (!range) {
    SpreadsheetApp.getUi().alert("선택된 범위가 없습니다. 범위를 선택한 후 실행해주세요.");
    return;
  }
  
  var values = range.getValues();
  
  // 각 줄의 시작 부분에서 '숫자 + 반각/전각 괄호'를 찾는 정규표현식
  var leadingRegex = /^\s*(\d+)\s*[)）]\s*/;
  var updated = false;
  
  // 2. 선택 영역의 모든 셀을 하나씩 순회합니다.
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (values[r][c] === null || values[r][c] === undefined) continue;
      
      var cellContent = values[r][c].toString();
      
      // 엔터(줄바꿈)를 기준으로 셀 안의 내용을 여러 줄로 쪼갭니다.
      var lines = cellContent.split('\n');
      var cellUpdated = false;
      
      // 3. 쪼개진 각각의 줄마다 첫머리를 검사합니다.
      for (var i = 0; i < lines.length; i++) {
        if (leadingRegex.test(lines[i])) {
          // 해당 줄의 맨 앞 번호 양식을 '숫자. ' 형태로 변경합니다.
          lines[i] = lines[i].replace(leadingRegex, "$1. ");
          cellUpdated = true;
          updated = true;
        }
      }
      
      // 셀 내부에서 변경된 줄이 있다면, 다시 줄바꿈으로 합쳐서 저장합니다.
      if (cellUpdated) {
        values[r][c] = lines.join('\n');
      }
    }
  }
  
  // 4. 최종 변경 사항을 시트에 적용합니다.
  if (updated) {
    range.setValues(values);
    SpreadsheetApp.getUi().alert("선택한 모든 셀의 모든 줄(행) 서식 변경이 완료되었습니다!");
  } else {
    SpreadsheetApp.getUi().alert("선택한 범위 내에 변경할 항목이 없습니다.");
  }
}
