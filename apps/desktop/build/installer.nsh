; Custom NSIS hooks for the Aurum installer (electron-builder `nsis.include`).

!macro customUnInstall
  ; Not during an in-place update: the updater runs the old uninstaller silently and the user's data must stay.
  ${ifNot} ${isUpdated}
    ; /SD IDNO: a silent uninstall (/S) keeps the data. Default button is "No".
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Aurum data (drawings, chat history, settings and local backups)?$\r$\n$\r$\nFolder: $APPDATA\Aurum$\r$\n$\r$\nChoose No to keep it for a later reinstall. Saved AI keys (encrypted for your Windows user) are in this folder too." /SD IDNO IDNO aurumKeepData
      RMDir /r "$APPDATA\Aurum"
    aurumKeepData:
  ${endIf}
!macroend
