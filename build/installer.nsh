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
; Match the browser's own theme: --bg 0f1115, --txt e6e9ef, --accent e63946.
; MUI can colour the pages it draws itself and the notice box; the grey frame
; around them belongs to the Windows dialog resource and is not ours to paint
; without shipping a custom UI, which is not worth the weight.
!define MUI_BGCOLOR "0f1115"
!define MUI_TEXTCOLOR "e6e9ef"
!define MUI_LICENSEPAGE_BGCOLOR "0f1115"

!macro customHeader
  SetFont "Segoe UI" 11
!macroend

; Paint the page itself, not just the notice box.
;
; The grey around the text is the MUI page dialog, and SetCtlColors can colour
; it. The first attempt at this hook failed the build: NSIS compiles the
; uninstaller in a second pass with BUILD_UNINSTALLER defined, and in that pass
; the installer's licence page never runs, so a page-level define survives all
; the way to the uninstaller's welcome page - which demands an "un." function.
; Guarding on BUILD_UNINSTALLER keeps the define in the pass that consumes it.
; The function has to sit inside the same guard. Left outside it, the
; uninstaller pass compiles a function nothing calls, and NSIS warns - which
; electron-builder treats as a build failure.
!ifndef BUILD_UNINSTALLER
!define MUI_PAGE_CUSTOMFUNCTION_SHOW RedlynxDarkNoticePage

Function RedlynxDarkNoticePage
  ; The page's own dialog, which is the grey the eye actually notices.
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 e6e9ef 0f1115

  ; The label above the box and the one below it. MUI numbers them 1040 and
  ; 1041; colouring a control that is not there is harmless.
  GetDlgItem $1 $0 1040
  SetCtlColors $1 e6e9ef 0f1115
  GetDlgItem $1 $0 1041
  SetCtlColors $1 e6e9ef 0f1115
  GetDlgItem $1 $0 1006
  SetCtlColors $1 e6e9ef 0f1115

  ; The strip along the bottom of the window, behind the version line.
  SetCtlColors $HWNDPARENT e6e9ef 0f1115
  GetDlgItem $1 $HWNDPARENT 1256
  SetCtlColors $1 8b93a3 0f1115
  GetDlgItem $1 $HWNDPARENT 1028
  SetCtlColors $1 8b93a3 0f1115
  GetDlgItem $1 $HWNDPARENT 1035
  SetCtlColors $1 8b93a3 0f1115
  GetDlgItem $1 $HWNDPARENT 1259
  SetCtlColors $1 8b93a3 0f1115
FunctionEnd
!endif
