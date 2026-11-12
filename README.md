> **이 브랜치 `kice-copy`는 KICE 윤문 코퍼스용 사본 「KICE_latex」(Drive `KICE윤문/`)의 코드다.**
> 배포 대상이 원본 「Latex 변환」과 다르다. 이 브랜치의 `.clasp.json`은 사본의 바운드 프로젝트만 가리킨다.
> - 작업 폴더는 `~/CLUE/repos/gas-project-latex-convert-kice`(git worktree)다. **원본 레포 폴더(`main`)에서 사본으로 push하지 않고, 이 폴더에서 원본으로 push하지 않는다.**
> - 2026-11-12 현재 코드는 `main`(`latex-1.1.1`)과 같다. 사본 전용 수정 4곳(입력 폴더 속성화, `findPdf_` 전체 검색 끔, `problemOnly`, 아카이브 이름 접두)을 넣기 전에는 **`clasp push`를 하지 않는다**(수정 전 코드는 원본의 `PBMAI/IMAGE_DS`를 읽는다).
> - 계획: 문서 레포 `kice-proofread-docs`의 `plans/2026-11-12-kice-rebuild-plan-v5.md` §6-4.

# gas-project-latex-convert
Latex 변환 
