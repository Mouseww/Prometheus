; Runs before files are copied. The bundled node.exe (the agent backend) can still be running from the
; previous version and Windows will not let it be overwritten, which fails the install with
; "Error opening file for writing". Stop every process that runs from the install folder first.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "$$d='$INSTDIR'.TrimEnd('\'); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d + '\', [StringComparison]::OrdinalIgnoreCase) -and $$_.ProcessId -ne $$PID } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800"`
  Pop $0
!macroend
