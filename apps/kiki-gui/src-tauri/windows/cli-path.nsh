!include "StrFunc.nsh"
!include "WinMessages.nsh"
${StrStr}
${UnStrRep}

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\cli"
  CopyFiles /SILENT "$INSTDIR\kiki-server.exe" "$INSTDIR\cli\kiki.exe"
  IfErrors 0 +2
    Abort "Could not install the Kiki CLI executable."
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 ";$0;" ";$INSTDIR\cli;"
  StrCmp $1 "" 0 kiki_path_done
  StrCmp $0 "" 0 +3
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\cli"
    Goto kiki_path_done
  WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR\cli"
  kiki_path_done:
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrRep} $1 ";$0;" ";$INSTDIR\cli;" ";"
  StrCpy $1 $1 -1 1
  StrCmp $1 $0 kiki_unpath_done
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
  kiki_unpath_done:
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
