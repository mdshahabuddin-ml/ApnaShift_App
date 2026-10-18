<#
ApnaShift - backups ki dusri copy (second copy, E: drive ke bahar).

Chalana (repo ya backend folder se):
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\copy-backups.ps1

- Source: backups\ (wahi folder jo deploy\backup-prod.ps1 likhta hai).
- Default destinations:
  1. C:\ApnaShift-Backups\                     - doosri physical disk
  2. %USERPROFILE%\OneDrive\ApnaShift-Backups\ - cloud sync (OneDrive maujood ho to)
- USB laga ho to usko bhi shamil karo:
  powershell ... -File deploy\copy-backups.ps1 -Dest 'F:\ApnaShift-Backups'
  (-Dest dene par sirf wahi destination use hoti hai; chahiye to array do)
- Har file ka SHA256 source se match hota hai - warna script fail.
- Source me 0 files ho to ruk jata hai (khaali folder ko galat jagah
  "mirror" karne se bachne ke liye).
- Idempotent: dobara chalao to sirf naye/changed files copy hote hain.
#>
param(
  [string]$Src = (Join-Path $PSScriptRoot '..\..\backups'),
  [string[]]$Dest
)

$ErrorActionPreference = 'Stop'

$srcFull = [System.IO.Path]::GetFullPath($Src)
if (-not (Test-Path $srcFull)) { throw "source nahi mila: $srcFull" }
$files = @(Get-ChildItem -Path $srcFull -File)
if ($files.Count -eq 0) { throw "source khaali hai: $srcFull - copy ruki (0 files)" }

if (-not $Dest -or $Dest.Count -eq 0) {
  $Dest = @('C:\ApnaShift-Backups')
  $oneDrive = Join-Path $env:USERPROFILE 'OneDrive'
  if (Test-Path $oneDrive) { $Dest += (Join-Path $oneDrive 'ApnaShift-Backups') }
}

# .NET SHA256 (Get-FileHash module har jagah autoload nahi hota - isliye direct)
function Get-Sha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-', '') }
    finally { $fs.Dispose() }
  } finally { $sha.Dispose() }
}

$srcHash = @{}
foreach ($f in $files) { $srcHash[$f.Name] = Get-Sha256 $f.FullName }

$failed = $false
foreach ($d in $Dest) {
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  foreach ($f in $files) {
    $target = Join-Path $d $f.Name
    if (-not (Test-Path $target) -or (Get-Item $target).Length -ne $f.Length) {
      Copy-Item -Path $f.FullName -Destination $target -Force
    }
    $h = Get-Sha256 $target
    if ($h -ne $srcHash[$f.Name]) {
      $failed = $true
      Write-Output "HASH-MISMATCH: $target"
    }
  }
  $n = @(Get-ChildItem -Path $d -File).Count
  $size = (Get-ChildItem -Path $d -File | Measure-Object Length -Sum).Sum
  Write-Output "COPIED -> $d ($n files, $size bytes)"
}

if ($failed) { throw 'verify fail: hash mismatch (upar dekho)' }
Write-Output "BACKUP COPY OK: $($files.Count) files -> $($Dest.Count) destinations"
foreach ($d in $Dest) { Write-Output "  - $d" }
