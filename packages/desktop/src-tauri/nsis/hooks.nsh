; Kill running processes before install/uninstall to prevent conflicts

!macro _KillYepProcesses
  nsis_tauri_utils::FindProcess "Yep Anywhere.exe" $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcess "Yep Anywhere.exe" $R0
  ${EndIf}

  nsis_tauri_utils::FindProcess "bun.exe" $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcess "bun.exe" $R0
  ${EndIf}

  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _KillYepProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _KillYepProcesses
!macroend
