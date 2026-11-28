!include "WinMessages.nsh"

!ifndef KIKI_PATH_REG_SUBKEY
  !define KIKI_PATH_REG_SUBKEY "Environment"
!endif

!ifndef KIKI_URL_REG_SUBKEY
  !define KIKI_URL_REG_SUBKEY "Software\Classes\kiki"
!endif

!macro KIKI_UPDATE_USER_PATH ACTION
  Push $0
  Push $1
  Push $2
  Push $3
  ClearErrors
  InitPluginsDir

  StrCpy $1 "$PLUGINSDIR\kiki-cli-path.ps1"
  FileOpen $0 $1 w
  IfErrors kiki_path_done_${ACTION}
  FileWrite $0 "param([string]$$Action, [string]$$RegSubKey = 'Environment')$\r$\n"
  FileWrite $0 "$$ErrorActionPreference = 'Stop'$\r$\n"
  FileWrite $0 "$$target = $$env:KIKI_CLI_PATH_TARGET$\r$\n"
  FileWrite $0 "if ([string]::IsNullOrWhiteSpace($$target)) { exit 2 }$\r$\n"
  FileWrite $0 "if ($$Action -ne 'add' -and $$Action -ne 'remove') { exit 3 }$\r$\n"
  FileWrite $0 "function Normalize-PathEntry([string]$$entry) {$\r$\n"
  FileWrite $0 "  $$s = $$entry.Trim()$\r$\n"
  FileWrite $0 "  if ($$s.Length -ge 2 -and $$s[0] -eq [char]34 -and $$s[$$s.Length - 1] -eq [char]34) {$\r$\n"
  FileWrite $0 "    $$s = $$s.Substring(1, $$s.Length - 2).Trim()$\r$\n"
  FileWrite $0 "  }$\r$\n"
  FileWrite $0 "  $$s = $$s.Replace('/', '\')$\r$\n"
  FileWrite $0 "  while ($$s.Length -gt 3 -and $$s.EndsWith('\')) { $$s = $$s.Substring(0, $$s.Length - 1) }$\r$\n"
  FileWrite $0 "  return $$s$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileWrite $0 "$$cleanTarget = $$target.Trim()$\r$\n"
  FileWrite $0 "while ($$cleanTarget.Length -gt 3 -and ($$cleanTarget.EndsWith('\') -or $$cleanTarget.EndsWith('/'))) {$\r$\n"
  FileWrite $0 "  $$cleanTarget = $$cleanTarget.Substring(0, $$cleanTarget.Length - 1)$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileWrite $0 "$$normTarget = Normalize-PathEntry $$cleanTarget$\r$\n"
  FileWrite $0 "if ([string]::IsNullOrWhiteSpace($$normTarget)) { exit 4 }$\r$\n"
  FileWrite $0 "$$regKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($$RegSubKey, $$true)$\r$\n"
  FileWrite $0 "if ($$null -eq $$regKey) { exit 5 }$\r$\n"
  FileWrite $0 "try {$\r$\n"
  FileWrite $0 "  $$pathName = $$null$\r$\n"
  FileWrite $0 "  foreach ($$n in $$regKey.GetValueNames()) {$\r$\n"
  FileWrite $0 "    if ($$n.Equals('Path', [System.StringComparison]::OrdinalIgnoreCase)) { $$pathName = $$n; break }$\r$\n"
  FileWrite $0 "  }$\r$\n"
  FileWrite $0 "  if ($$null -eq $$pathName) {$\r$\n"
  FileWrite $0 "    if ($$Action -eq 'add') {$\r$\n"
  FileWrite $0 "      $$regKey.SetValue('Path', $$cleanTarget, [Microsoft.Win32.RegistryValueKind]::ExpandString)$\r$\n"
  FileWrite $0 "    }$\r$\n"
  FileWrite $0 "    exit 0$\r$\n"
  FileWrite $0 "  }$\r$\n"
  FileWrite $0 "  $$raw = $$regKey.GetValue($$pathName, $$null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)$\r$\n"
  FileWrite $0 "  if ($$raw -isnot [string]) { exit 6 }$\r$\n"
  FileWrite $0 "  $$parts = $$raw.Split(';')$\r$\n"
  FileWrite $0 "  if ($$Action -eq 'add') {$\r$\n"
  FileWrite $0 "    $$hasNonEmpty = $$false$\r$\n"
  FileWrite $0 "    foreach ($$p in $$parts) {$\r$\n"
  FileWrite $0 "      $$norm = Normalize-PathEntry $$p$\r$\n"
  FileWrite $0 "      if ($$norm.Length -gt 0) { $$hasNonEmpty = $$true }$\r$\n"
  FileWrite $0 "      if ($$norm.Equals($$normTarget, [System.StringComparison]::OrdinalIgnoreCase)) { exit 0 }$\r$\n"
  FileWrite $0 "    }$\r$\n"
  FileWrite $0 "    if (-not $$hasNonEmpty) { $$next = $$cleanTarget }$\r$\n"
  FileWrite $0 "    elseif ($$raw.EndsWith(';')) { $$next = $$raw + $$cleanTarget }$\r$\n"
  FileWrite $0 "    else { $$next = $$raw + ';' + $$cleanTarget }$\r$\n"
  FileWrite $0 "    $$regKey.SetValue($$pathName, $$next, [Microsoft.Win32.RegistryValueKind]::ExpandString)$\r$\n"
  FileWrite $0 "  } else {$\r$\n"
  FileWrite $0 "    $$kept = New-Object System.Collections.Generic.List[string]$\r$\n"
  FileWrite $0 "    $$removed = $$false$\r$\n"
  FileWrite $0 "    foreach ($$p in $$parts) {$\r$\n"
  FileWrite $0 "      $$norm = Normalize-PathEntry $$p$\r$\n"
  FileWrite $0 "      if ($$norm.Equals($$normTarget, [System.StringComparison]::OrdinalIgnoreCase)) { $$removed = $$true }$\r$\n"
  FileWrite $0 "      else { [void]$$kept.Add($$p) }$\r$\n"
  FileWrite $0 "    }$\r$\n"
  FileWrite $0 "    if (-not $$removed) { exit 0 }$\r$\n"
  FileWrite $0 "    $$hasKeptNonEmpty = $$false$\r$\n"
  FileWrite $0 "    foreach ($$k in $$kept) { if ((Normalize-PathEntry $$k).Length -gt 0) { $$hasKeptNonEmpty = $$true; break } }$\r$\n"
  FileWrite $0 "    if ($$hasKeptNonEmpty) { $$next = [string]::Join(';', $$kept) } else { $$next = '' }$\r$\n"
  FileWrite $0 "    $$regKey.SetValue($$pathName, $$next, [Microsoft.Win32.RegistryValueKind]::ExpandString)$\r$\n"
  FileWrite $0 "  }$\r$\n"
  FileWrite $0 "} finally { $$regKey.Dispose() }$\r$\n"
  FileClose $0
  IfErrors kiki_path_cleanup_${ACTION}

  StrCpy $3 "$INSTDIR\cli"
  System::Call 'kernel32::SetEnvironmentVariable(t "KIKI_CLI_PATH_TARGET", t r3) i .r0'
  StrCmp $0 "0" kiki_path_cleanup_${ACTION}

  StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$2" kiki_path_ps_ok_${ACTION}
  StrCpy $2 "powershell.exe"
  kiki_path_ps_ok_${ACTION}:

  nsExec::ExecToStack "$\"$2$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$1$\" -Action ${ACTION} -RegSubKey $\"${KIKI_PATH_REG_SUBKEY}$\""
  Pop $0
  Pop $3
  System::Call 'kernel32::SetEnvironmentVariable(t "KIKI_CLI_PATH_TARGET", p 0) i .r3'
  Delete "$1"
  StrCmp $0 "0" 0 kiki_path_done_${ACTION}
!ifndef KIKI_SKIP_WM_BROADCAST
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i ${WM_SETTINGCHANGE}, p 0, w "Environment", i 2, i 1000, *p .r3)'
!endif
  Goto kiki_path_done_${ACTION}

  kiki_path_cleanup_${ACTION}:
  Delete "$1"

  kiki_path_done_${ACTION}:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro KIKI_WRITE_CLI_SHIMS
  Push $0
  ClearErrors
  CreateDirectory "$INSTDIR\cli"
  Delete "$INSTDIR\cli\kiki.exe"

  FileOpen $0 "$INSTDIR\cli\kiki.cmd" w
  IfErrors kiki_shims_abort
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "setlocal$\r$\n"
  FileWrite $0 "set $\"ELECTRON_RUN_AS_NODE=1$\"$\r$\n"
  FileWrite $0 "$\"%~dp0..\kiki-desktop.exe$\" --max-old-space-size=2560 $\"%~dp0..\resources\app.asar.unpacked\dist\server\server-entry.mjs$\" %*$\r$\n"
  FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
  FileClose $0
  IfErrors kiki_shims_abort

  FileOpen $0 "$INSTDIR\cli\kiki" w
  IfErrors kiki_shims_abort
  FileWrite $0 "#!/usr/bin/env sh$\n"
  FileWrite $0 "DIR=$\"$$(CDPATH= cd -- $\"$$(dirname -- $\"$$0$\")/..$\" && pwd)$\"$\n"
  FileWrite $0 "ELECTRON_RUN_AS_NODE=1 exec $\"$$DIR/kiki-desktop.exe$\" --max-old-space-size=2560 $\"$$DIR/resources/app.asar.unpacked/dist/server/server-entry.mjs$\" $\"$$@$\"$\n"
  FileClose $0
  IfErrors kiki_shims_abort
  Pop $0
  Goto kiki_shims_done

  kiki_shims_abort:
  Pop $0
  Abort "Could not install the Kiki CLI shims."

  kiki_shims_done:
!macroend

!macro KIKI_REGISTER_URL_PROTOCOL
  WriteRegStr HKCU "${KIKI_URL_REG_SUBKEY}" "" "URL:Kiki Protocol"
  WriteRegStr HKCU "${KIKI_URL_REG_SUBKEY}" "URL Protocol" ""
  WriteRegStr HKCU "${KIKI_URL_REG_SUBKEY}\DefaultIcon" "" "$\"$INSTDIR\kiki-desktop.exe$\",0"
  WriteRegStr HKCU "${KIKI_URL_REG_SUBKEY}\shell\open\command" "" "$\"$INSTDIR\kiki-desktop.exe$\" $\"%1$\""
!macroend

!macro KIKI_UNREGISTER_URL_PROTOCOL
  DeleteRegKey HKCU "${KIKI_URL_REG_SUBKEY}"
!macroend

!macro customInstall
  !insertmacro KIKI_WRITE_CLI_SHIMS
  !insertmacro KIKI_UPDATE_USER_PATH "add"
  !insertmacro KIKI_REGISTER_URL_PROTOCOL
!macroend

!macro customUnInstall
!ifdef isUpdated
  ${ifNot} ${isUpdated}
    !insertmacro KIKI_UNREGISTER_URL_PROTOCOL
    !insertmacro KIKI_UPDATE_USER_PATH "remove"
  ${endIf}
!else
  !insertmacro KIKI_UNREGISTER_URL_PROTOCOL
  !insertmacro KIKI_UPDATE_USER_PATH "remove"
!endif
  Delete "$INSTDIR\cli\kiki.cmd"
  Delete "$INSTDIR\cli\kiki"
  Delete "$INSTDIR\cli\kiki.exe"
  RMDir "$INSTDIR\cli"
!macroend
