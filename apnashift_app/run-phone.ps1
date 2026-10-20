# ApnaShift — flutter run for a REAL phone (auto-fills laptop LAN IP).
# Plain `flutter run` uses the emulator default 10.0.2.2:3000, which a real
# phone cannot reach. This script detects the current Wi-Fi IPv4 and passes
# the correct --dart-define, so the app always finds the local backend.
# Usage: powershell -ExecutionPolicy Bypass -File run-phone.ps1 [-DeviceId <id>]
param([string]$DeviceId = "")
$ErrorActionPreference = 'Stop'
$wlan = Get-NetAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'Wi-Fi|Wireless|802.11' } |
  Select-Object -First 1
if (-not $wlan) { throw 'No active Wi-Fi adapter — LAN IP detect nahi hua (laptop Wi-Fi on karo).' }
$ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $wlan.ifIndex -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
if (-not $ip) { throw "No usable IPv4 on adapter '$($wlan.Name)'." }
$args = @('run', "--dart-define=API_BASE_URL=http://${ip}:3000")
if ($DeviceId) { $args += @('-d', $DeviceId) }
Write-Output "API_BASE_URL=http://${ip}:3000  (adapter: $($wlan.InterfaceDescription))"
Set-Location $PSScriptRoot
& flutter @args
