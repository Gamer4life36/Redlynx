; Retitles the notice page, and makes it readable.
;
; electron-builder shows a licence file on NSIS's licence page, which is
; labelled "License Agreement" and asks the user to accept legal terms. This
; page is not a licence - it is a plain statement of what the browser does,
; what it does not do, and why Windows warned about it. Labelling it as a
; contract teaches people to click past it, which is the opposite of the point.

!define MUI_PAGE_HEADER_TEXT "Before you install"
!define MUI_PAGE_HEADER_SUBTEXT "What Redlynx does, what it does not do, and why Windows warned you"
!define MUI_LICENSEPAGE_TEXT_TOP "Worth two minutes. This is not a legal agreement."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "Press Continue to install Redlynx."
!define MUI_LICENSEPAGE_BUTTON "Continue"

; NSIS defaults to 8pt MS Shell Dlg. At that size Windows renders text with
; subpixel antialiasing that shows as colour fringing, and a page of prose is
; hard going. Segoe UI at 10pt is what the rest of Windows uses.
;
; Set as an installer attribute rather than a page hook: a page-level define
; is consumed by whichever page macro comes next, and here that turned out to
; be the *uninstaller's* welcome page, which failed the build outright.
!macro customHeader
  SetFont "Segoe UI" 11
!macroend
