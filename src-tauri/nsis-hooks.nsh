; Keep the login shortcut during updates. On uninstall remove only a shortcut
; targeting this installation, preserving a user's separate portable copy.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    !insertmacro IsShortcutTarget "$SMSTARTUP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$SMSTARTUP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend
