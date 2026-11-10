; Ao desinstalar, remove também o registro de início automático que o próprio player faz no Windows.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Reprodutor Player"
!macroend
