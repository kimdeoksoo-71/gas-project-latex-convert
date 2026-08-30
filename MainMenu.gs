function onOpen() {
  const ui = SpreadsheetApp.getUi();

  const mainMenu = ui.createMenu('🧅 앱메뉴');

  // 2. 단일 항목
 
  mainMenu.addItem('선택셀 사이드바 보기','showCellPreviewSidebar')
  mainMenu.addItem('첫번째 셀로 합치기','mergeSelectedCellsToTopAndClearRest');
  mainMenu.addItem('⏺️ 문항 정규화', 'ds_runNormalizeAndValidate_byRowInput');
  mainMenu.addItem('🔎 정규화 점검 (쓰기 없음)', 'ds_auditNormalize_byRowInput');
  mainMenu.addSeparator();
  mainMenu.addItem('▶ 원클릭 파이프라인 (키워드 → Data_DS)', 'pipeline_start');
  mainMenu.addItem('⏹ 파이프라인 중지', 'pipeline_stop');
  mainMenu.addItem('📋 파이프라인 상태', 'pipeline_status');
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
    .addItem('🚀 Data_Latex → Data_DS (문제·해설 짝 전송 + 정답 추출)', 'dl_sendPairsToDataDS')
    .addItem('🎯 Data_DS 정답(D) 채우기 : 행범위', 'ds_fillGivenAnswer_byRowInput')
    .addSeparator()
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