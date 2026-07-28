function onOpen() {
  const ui = SpreadsheetApp.getUi();

  const mainMenu = ui.createMenu('🧅 앱메뉴');

  // 2. 단일 항목
 
  mainMenu.addItem('선택셀 사이드바 보기','showCellPreviewSidebar')
  mainMenu.addItem('첫번째 셀로 합치기','mergeSelectedCellsToTopAndClearRest');
  mainMenu.addItem('⏺️ 문항 정규화', 'ds_runNormalizeAndValidate_byRowInput');
  mainMenu.addSeparator();


  // 5. 서브메뉴 A
  const subMenuA = ui.createMenu('Latex 변환')
    .addItem('❇️ Latex 초기화', 'clear_Data1_and_Data_Latex_rows2down')
    .addSeparator()
    .addItem('✳️ 문항찾기 : 키워드', 'runSearchAndAppend')
    .addItem('🔄 Latex 변환 : 행범위(자동 이어하기)', 'mpr_runRangeAuto')
    .addItem('⏹️ 자동변환 중지', 'mpr_stopAuto')
    .addItem('➕ CRUX 홀짝행 번호추가','addQuestionNumberPrefixToColumnC_byOddEven_InRangeIndex');

  // 6. 서브메뉴 B
  const subMenuB = ui.createMenu('문항해설 분리/병합')
    .addItem('Split38 문제', 'mergeLatexAndSplit_to_split38')
    .addItem('Split38 해설', 'mergeSolutionAndSplit_to_split38')
    .addItem('Split38 을 Data_DS로','append_split38_to_DataDS')
    .addSeparator()
    .addItem('Split12 문제', 'mergeLatexAndSplit_to_split12')
    .addItem('Split12 해설', 'mergeSolutionAndSplit_to_split12')
    .addItem('Split12 을 Data_DS로','append_split12_to_DataDS')
    .addSeparator()
    .addItem('Split46 문제','mergeLatexAndSplit_to_split46')
    .addItem('Split46 해설','mergeSolutionAndSplit_to_split46')
    .addItem('Split46을 Data_DS로','append_split46_to_DataDS')
    .addSeparator()
    .addItem('SplitN 문제&해설','mergeAndSplitLatex');

  // 7. 메인 메뉴에 서브메뉴들 통합 + UI 반영
  mainMenu
    .addSubMenu(subMenuA)
    .addSubMenu(subMenuB)
    .addToUi();
} // ✅ onOpen은 여기서 끝!