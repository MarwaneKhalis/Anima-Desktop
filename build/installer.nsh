!macro customInit
  ; Keep installs per-user; require a machine-scope copy to be removed first
  ; instead of silently leaving a duplicate or changing installation scope.
  StrCmp $hasPerMachineInstallation "1" machine_install_blocked
  !insertmacro setInstallModePerUser
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"

  FileOpen $9 "$TEMP\anima-desktop-installer.log" w
  FileWrite $9 "customInit: expected=${APP_FILENAME}; installDir=$INSTDIR$\r$\n"
  FileClose $9

  ; Only permit a dedicated product folder, so AppContainer read access cannot
  ; accidentally expose an unrelated directory selected with NSIS /D. Preserve
  ; the v0.3.0 install folder when electron-builder reuses it during upgrade.
  ${GetFileName} "$INSTDIR" $0
  StrCmp $0 "${APP_FILENAME}" install_path_ok
  StrCmp $0 "Anima Connect" install_path_ok
    FileOpen $9 "$TEMP\anima-desktop-installer.log" a
    FileWrite $9 "customInit aborted: invalid install directory leaf=$0$\r$\n"
    FileClose $9
    Abort "Le dossier d’installation doit se terminer par ${APP_FILENAME}."
  install_path_ok:

  ; Electron checks that sandboxed child processes can read icudtl.dat.
  ; Prepare the app-only folder before payload installation so new files inherit this read-only ACE.
  CreateDirectory "$INSTDIR"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /Q'
  Pop $0
  FileOpen $9 "$TEMP\anima-desktop-installer.log" a
  FileWrite $9 "customInit icacls exit=$0$\r$\n"
  FileClose $9
  StrCmp $0 "0" acl_granted
    DetailPrint "Impossible d’autoriser la lecture sandboxée du dossier Anima Desktop (code $0)."
    Abort "L’installation n’a pas pu configurer les droits requis pour Anima Desktop."
  acl_granted:
  Goto install_ready

  machine_install_blocked:
    FileOpen $9 "$TEMP\anima-desktop-installer.log" w
    FileWrite $9 "customInit aborted: machine-wide installation exists$\r$\n"
    FileClose $9
    Abort "Une installation Anima Connect pour tous les utilisateurs est déjà présente. Désinstallez-la avant de continuer."
  install_ready:
!macroend

!macro customInstallmode
  ; This is a per-user desktop app; avoid an elevation/install-scope choice.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ; The app folder's inheritable ACE is set in customInit before extraction.
  ; Reapplying it after extraction can fail on Chromium's transient files, which
  ; makes NSIS report an aborted install even though the payload was extracted.
  ClearErrors
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /Q'
  Pop $0
  FileOpen $9 "$TEMP\anima-desktop-installer.log" a
  FileWrite $9 "customInstall icacls exit=$0$\r$\n"
  FileClose $9
  StrCmp $0 "0" installed_acl_granted
    DetailPrint "Impossible d’autoriser la lecture sandboxée des fichiers installés (code $0)."
    Abort "L’installation n’a pas pu configurer les droits requis pour Anima Desktop."
  installed_acl_granted:
!macroend
