!macro customInstall
  SetRegView 64
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  SetRegView 32

  ${If} $0 != 1
    MessageBox MB_ICONINFORMATION|MB_OKCANCEL "OpenRoughCut needs the Microsoft Visual C++ runtime for private, on-device transcription. Windows may ask for permission to install this Microsoft component." IDOK +2
    Abort
    DetailPrint "Installing the Microsoft Visual C++ runtime required by transcription..."
    File /oname=$PLUGINSDIR\vc_redist.x64.exe "${PROJECT_DIR}\installer-prerequisites\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0

    ${If} $0 != 0
    ${AndIf} $0 != 1638
    ${AndIf} $0 != 3010
      MessageBox MB_ICONSTOP|MB_OK "OpenRoughCut could not install the Microsoft Visual C++ runtime (exit code $0). Setup cannot continue."
      Abort
    ${EndIf}
  ${EndIf}
!macroend
