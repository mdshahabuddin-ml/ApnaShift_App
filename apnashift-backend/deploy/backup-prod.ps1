<#
ApnaShift — production Postgres dump (Windows/local; Linux cron = deploy/backup.sh).

Chalana (script path apne aap resolve karti hai, repo ya backend folder se):
  railway run --environment production --service ApnaShift_App -- `
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\backup-prod.ps1

- DATABASE_URL railway run se env me milta hai — kabhi command line pe nahi jata
  (password history/logs me nahi aata).
- Output: backups\apnashift-prod-<timestamp>.dump.zip — restore ke liye pehle
  Expand-Archive se kholo, phir pg_restore --list / pg_restore.
- Server 18.x hai to pg_dump >= 18 chahiye (17 wala "server version mismatch"
  dekar ruk jata hai).
#>
param([string]$OutDir = (Join-Path $PSScriptRoot '..\..\backups'))

$ErrorActionPreference = 'Stop'

function Find-PgTool([string]$name) {
  foreach ($c in @(
    "C:\Program Files\PostgreSQL\18\bin\$name.exe",
    "C:\Program Files\PostgreSQL\17\bin\$name.exe"
  )) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$pgDump = Find-PgTool 'pg_dump'
if (-not $pgDump) { throw 'pg_dump nahi mila — winget install PostgreSQL.PostgreSQL.18 chalao' }

$url = $env:DATABASE_URL
if ([string]::IsNullOrWhiteSpace($url)) { throw 'DATABASE_URL khaali hai — railway run ke saath chalana zaroori hai' }

$outDirFull = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $outDirFull -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $outDirFull "apnashift-prod-$stamp.dump"

& $pgDump --no-owner --no-privileges -Fc -f $out $url
if ($LASTEXITCODE -ne 0) { throw "pg_dump fail (exit $LASTEXITCODE)" }
if (-not (Test-Path $out) -or (Get-Item $out).Length -eq 0) { throw 'dump file khaali/missing' }

# Verify: pg_restore --list TOC de de to dump valid hai.
$pgRestore = Find-PgTool 'pg_restore'
$toc = -1
if ($pgRestore) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $toc = (& $pgRestore --list $out 2>$null | Measure-Object).Count
  $ErrorActionPreference = $prev
  if ($toc -lt 1) { throw 'verify fail: pg_restore --list ne kuch nahi diya' }
} else {
  Write-Warning 'pg_restore nahi mila — dump ban gaya, verify skip.'
}

Compress-Archive -Path $out -DestinationPath "$out.zip" -Force
Remove-Item $out -Force
$zip = "$out.zip"
$size = (Get-Item $zip).Length
if ($toc -ge 0) { Write-Output "BACKUP OK: $zip ($size bytes, TOC=$toc)" }
else { Write-Output "BACKUP OK: $zip ($size bytes, verify skipped)" }
