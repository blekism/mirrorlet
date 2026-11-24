; Extra NSIS steps run by electron-builder's installer.
; The installer already runs as administrator (perMachine), so it can add a
; Windows Firewall rule for the bundled uxplay.exe. Without it, Windows blocks
; the incoming AirPlay connections and the iPhone never sees this PC.
; Scope is Private + Domain networks only, so the PC isn't exposed on public Wi-Fi.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Mirrorlet (UxPlay AirPlay receiver)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Mirrorlet (UxPlay AirPlay receiver)" dir=in action=allow program="$INSTDIR\resources\uxplay\bin\uxplay.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Mirrorlet (UxPlay AirPlay receiver)"'
!macroend
