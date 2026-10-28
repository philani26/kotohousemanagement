# Starts everything needed for LOCAL development in two windows:
#   1. the Firebase emulators (stop with Ctrl+C so your data is saved to emulator-data/)
#   2. the Angular dev server on http://localhost:4200
# Usage (from the project folder):  powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
$root = Split-Path -Parent $PSScriptRoot
$path = 'Set-Location ''' + $root + '''; $env:Path = [Environment]::GetEnvironmentVariable(''Path'',''Machine'') + '';'' + [Environment]::GetEnvironmentVariable(''Path'',''User''); '

$emulators = $path + '$env:FUNCTIONS_DISCOVERY_TIMEOUT=''60''; $host.UI.RawUI.WindowTitle=''Kota House emulators (Ctrl+C to stop and save)''; npm run build:functions; npm run emulators'
Start-Process powershell.exe -ArgumentList '-NoExit', '-Command', $emulators

# Only start the dev server if it isn't already running
$busy = Get-NetTCPConnection -LocalPort 4200 -State Listen -ErrorAction SilentlyContinue
if (-not $busy) {
  $web = $path + '$host.UI.RawUI.WindowTitle=''Kota House app (http://localhost:4200)''; npm start'
  Start-Process powershell.exe -ArgumentList '-NoExit', '-Command', $web
}
Write-Host 'Starting... open http://localhost:4200 once the emulator window says "All emulators ready".'
