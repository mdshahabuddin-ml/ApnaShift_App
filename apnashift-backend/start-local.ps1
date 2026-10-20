# Start ApnaShift backend fully detached (won't hang opencode/VS Code terminal).
# Usage: powershell -ExecutionPolicy Bypass -File start-local.ps1
# Stop:  powershell -ExecutionPolicy Bypass -File start-local.ps1 -Stop

param(
    [switch]$Stop,
    [int]$Port = 3000
)

$log = Join-Path $env:TEMP 'apnashift-local.log'
$err = Join-Path $env:TEMP 'apnashift-local.err.log'
$here = $PSScriptRoot

function Get-ServerPid {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c) { return @($c)[0].OwningProcess }
    return $null
}

if ($Stop) {
    $pid2 = Get-ServerPid
    if ($pid2) {
        Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue
        Write-Host "stopped pid=$pid2"
    } else {
        Write-Host "no server listening on port $Port"
    }
    exit 0
}

$existing = Get-ServerPid
if ($existing) {
    Write-Host "already running pid=$existing on port $Port"
    exit 0
}

if (Test-Path $log) { Remove-Item $log, $err -Force -ErrorAction SilentlyContinue }

# Win32_Process.Create => NOT a child of this shell => terminal returns instantly.
$cmdLine = "cmd /c node src/server.js > `"$log`" 2> `"$err`""
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine     = $cmdLine
    CurrentDirectory = $here
}

if ($r.ReturnValue -ne 0) {
    Write-Error "failed to start (ReturnValue=$($r.ReturnValue))"
    exit 1
}

Write-Host "started detached pid=$($r.ProcessId)"
Start-Sleep -Seconds 3

try {
    $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/mssql/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "health: HTTP $($resp.StatusCode) $($resp.Content)"
} catch {
    Write-Warning "server not responding yet: $($_.Exception.Message)"
    if (Test-Path $err) { Get-Content $err -Tail 10 }
}
