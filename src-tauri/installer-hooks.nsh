; The `buzz` command line client is in the install's bin folder: add it to the
; user's PATH on install and remove it on uninstall. PowerShell edits the
; registry value, so a PATH longer than NSIS's string limit is never cut, keeps
; its unexpanded entries, and gets no duplicate. The folder comes in through
; BUZZ_BIN, so no install path is quoted into the script.
!define BUZZ_PATH_READ "$$k = Get-Item HKCU:\Environment; $$p = $$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$d = $$env:BUZZ_BIN; $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d })"
!define BUZZ_PATH_WRITE "Set-ItemProperty HKCU:\Environment Path ($$parts -join ';') -Type ExpandString"

!macro BuzzUserPath operation
  System::Call 'Kernel32::SetEnvironmentVariable(t "BUZZ_BIN", t "$INSTDIR\bin")'
  !if ${operation} == add
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "${BUZZ_PATH_READ}; if (-not (@($$p -split ';') -contains $$d)) { $$parts += $$d; ${BUZZ_PATH_WRITE} }"`
  !else
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "${BUZZ_PATH_READ}; if (@($$p -split ';') -contains $$d) { ${BUZZ_PATH_WRITE} }"`
  !endif
  Pop $R9
  ; HWND_BROADCAST, WM_SETTINGCHANGE: running programs see the new PATH.
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
!macroend

; An update keeps existing shortcuts, and with them the AppUserModelID that
; Windows shows notifications under. Give them this build's identifier, which
; changed in 1.0, as a fresh install does.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
  !insertmacro BuzzUserPath add
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro BuzzUserPath remove
!macroend
