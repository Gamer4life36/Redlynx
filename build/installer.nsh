; Redlynx installer: wording, type and colour.
;
; The notice page is not a licence - it is a plain statement of what the
; browser does, what it does not, and why Windows warned about it. NSIS labels
; its licence page "License Agreement" and asks you to accept legal terms,
; which teaches people to click past exactly the thing they should read.

!define MUI_PAGE_HEADER_TEXT "Before you install"
!define MUI_PAGE_HEADER_SUBTEXT "What Redlynx does, what it does not do, and why Windows warned you"
!define MUI_LICENSEPAGE_TEXT_TOP "Worth two minutes. This is not a legal agreement."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "Press Continue to install Redlynx."
!define MUI_LICENSEPAGE_BUTTON "Continue"

; Colours come from the browser's own light theme: --bg #e9edf2, --txt #161b22,
; --mut #5d6b7a. Light rather than dark, so a page of prose is not read as pale
; text on black.
!define RLX_BG   "e9edf2"
!define RLX_TXT  "161b22"
!define RLX_MUT  "5d6b7a"

!define MUI_BGCOLOR "${RLX_BG}"
!define MUI_TEXTCOLOR "${RLX_TXT}"
!define MUI_LICENSEPAGE_BGCOLOR "${RLX_BG}"

; NSIS defaults to 8pt MS Shell Dlg. At that size Windows renders text with
; subpixel antialiasing that shows as colour fringing, and a page of prose is
; hard going. Segoe UI at 11pt is legible and matches the rest of Windows.
;
; Set as an installer attribute rather than a page define: a page define is
; consumed by whichever page macro comes next, and that turned out to be the
; *uninstaller's* welcome page, which failed the build outright.
!macro customHeader
  SetFont "Segoe UI" 11
!macroend

; ── which pages exist ─────────────────────────────────────────────
;
; A MUI page define themes exactly one page - the next one declared - and this
; file is included before any of them. electron-builder offers hooks before the
; licence page, before the progress page, and in place of the finish page, but
; none before the "who is this for" page or the folder-choice page. Rather than
; leave half the installer a different colour, those two are removed:
;
;   * customInstallMode forces a per-user install, so nothing asks who it is
;     for and nothing asks for admin rights, which a per-user browser does not
;     need in the first place.
;   * allowToChangeInstallationDirectory is off in package.json, which drops
;     the folder-choice page. Chrome and VS Code install per-user the same way.
;
; What remains - notice, progress, finish - is reachable and consistent.

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER

; Inserted immediately before MUI_PAGE_INSTFILES, so this lands on it.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RedlynxPaintPage
!macroend

; Replaces the default finish page so it can be painted, keeping the
; run-on-finish behaviour the default one provides.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RedlynxPaintPage
  !insertmacro MUI_PAGE_FINISH
!macroend

; Paints one page. Control ids differ from page to page, so rather than listing
; them this walks the range MUI uses and colours whatever is actually there.
; Asking for an id that does not exist costs nothing.
;
; Written with plain labels rather than LogicLib's ${Do}: this file is included
; before LogicLib is available, and using it here failed the build.
Function RedlynxPaintPage
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ${RLX_TXT} ${RLX_BG}

  ; Control 1000 is the rich edit holding the notice. It colours itself from
  ; MUI_LICENSEPAGE_BGCOLOR and the RTF's own colour table; forcing SetCtlColors
  ; on top of that stopped it drawing anything past the first paragraph.
  StrCpy $2 1001
  rlx_paint_loop:
    GetDlgItem $1 $0 $2
    StrCmp $1 0 rlx_paint_next
    SetCtlColors $1 ${RLX_TXT} ${RLX_BG}
  rlx_paint_next:
    IntOp $2 $2 + 1
    IntCmp $2 1060 rlx_paint_done rlx_paint_loop rlx_paint_done
  rlx_paint_done:

  SetCtlColors $HWNDPARENT ${RLX_TXT} ${RLX_BG}
  GetDlgItem $1 $HWNDPARENT 1256
  SetCtlColors $1 ${RLX_MUT} ${RLX_BG}
  ; The branding line exists twice, as 1028 and 1256, one on top of the other.
  ; Restyling one leaves the other showing through at the old size, which reads
  ; as a doubled, blurry label.
  GetDlgItem $1 $HWNDPARENT 1028
  System::Call 'user32::ShowWindow(p $1, i 0)'

  ; InvalidateRect only marks an area dirty. Without an erase the window keeps
  ; whatever pixels were behind it, which on a freshly shown page is the desktop
  ; - that is what showed as a stray band of wallpaper along the edge.
  ; RDW_INVALIDATE|RDW_ERASE|RDW_ALLCHILDREN|RDW_UPDATENOW
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x0185)'
  System::Call 'user32::RedrawWindow(p $0, p 0, p 0, i 0x0185)'
FunctionEnd

; The notice page: painted like the rest, plus the branding line, which NSIS
; draws in a small fixed font of its own - that is where the pixelation came
; from.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW RedlynxNoticePage

Function RedlynxNoticePage
  Call RedlynxPaintPage

  GetDlgItem $1 $HWNDPARENT 1256
  System::Call 'gdi32::CreateFont(i -21, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, t "Segoe UI") p .r2'
  SendMessage $1 0x0030 $2 1   ; WM_SETFONT, by value so no extra include is needed
  System::Call 'user32::GetWindowRect(p $1, @ r3)'
  System::Call '*$3(i .r4, i .r5, i .r6, i .r7)'
  IntOp $8 $6 - $4
  IntOp $8 $8 + 60
  IntOp $9 $7 - $5
  IntOp $9 $9 + 8
  ; SWP_NOMOVE|SWP_NOZORDER
  System::Call 'user32::SetWindowPos(p $1, p 0, i 0, i 0, i r8, i r9, i 6)'
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x0185)'
FunctionEnd

!endif
