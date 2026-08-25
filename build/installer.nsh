; Retitles the notice page.
;
; electron-builder shows a licence file on NSIS's licence page, which is
; labelled "License Agreement" and asks the user to accept legal terms. This
; page is not a licence — it is a plain statement of what the browser does,
; what it does not do, and why Windows warned about it. Labelling it as a
; contract teaches people to click past it, which is the opposite of the point.

!define MUI_PAGE_HEADER_TEXT "Before you install"
!define MUI_PAGE_HEADER_SUBTEXT "What Redlynx does, what it does not do, and why Windows warned you"
!define MUI_LICENSEPAGE_TEXT_TOP "Worth two minutes. This is not a legal agreement."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "Press Continue to install Redlynx."
!define MUI_LICENSEPAGE_BUTTON "Continue"
