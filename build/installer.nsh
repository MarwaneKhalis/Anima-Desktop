!macro customInit
  ; Keep installs per-user; require a machine-scope copy to be removed first
  ; instead of silently leaving a duplicate or changing installation scope.
  StrCmp $hasPerMachineInstallation "1" machine_install_blocked
  !insertmacro setInstallModePerUser
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"

  ; Only permit a dedicated product folder, so AppContainer read access cannot
  ; accidentally expose an unrelated directory selected with NSIS /D.
  ${GetFileName} "$INSTDIR" $0
  StrCmp $0 "${APP_FILENAME}" install_path_ok
    Abort "Le dossier d’installation doit se terminer par ${APP_FILENAME}."
  install_path_ok:

  ; Electron checks that sandboxed child processes can read icudtl.dat.
  ; Prepare the app-only folder before payload installation so new files inherit this read-only ACE.
  CreateDirectory "$INSTDIR"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /Q'
  Pop $0
  StrCmp $0 "0" acl_granted
    DetailPrint "Impossible d’autoriser la lecture sandboxée du dossier Anima Connect (code $0)."
    Abort "L’installation n’a pas pu configurer les droits requis pour Anima Connect."
  acl_granted:
  Goto install_ready

  machine_install_blocked:
    Abort "Une installation Anima Connect pour tous les utilisateurs est déjà présente. Désinstallez-la avant de continuer."
  install_ready:
!macroend

!macro customInstallmode
  ; This is a per-user desktop app; avoid an elevation/install-scope choice.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ; Electron checks icudtl.dat with its restricted sandbox token.
  ; Apply the AppContainer ACE and the installing user's ACE after all files
  ; have been extracted, including files with restrictive packaged ACLs.
  ClearErrors
  UserInfo::GetName
  IfErrors user_name_unavailable
  Pop $1
  StrCmp $1 "" user_name_unavailable
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)" "$1:(OI)(CI)(RX)" /T /Q'
  Pop $0
  StrCmp $0 "0" installed_acl_granted
    DetailPrint "Impossible d’autoriser la lecture sandboxée des fichiers installés (code $0)."
    Abort "L’installation n’a pas pu configurer les droits requis pour Anima Connect."
  user_name_unavailable:
    Abort "Impossible d’identifier le compte qui installe Anima Connect."
  installed_acl_granted:
!macroend
