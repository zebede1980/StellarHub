<#
.SYNOPSIS
  Starts this fork of StellarHub from source, setting it up the first time.

.DESCRIPTION
  Creates the Python environment in .venv if it is missing, installs the packages in requirements.txt when that
  file has changed since the last run, and opens StellarHub with no console window.

  StellarHub is started with --no-elevate, so it stays in normal mode even if "Always open as administrator"
  is turned on in its settings. Pass -AllowElevate to let that setting apply.

.PARAMETER Shortcut
  Also create a StellarHub shortcut that opens the app directly, without going through this script.
  Run this script again (no switches needed) after pulling changes that touch requirements.txt.

.PARAMETER ShortcutFolder
  Where -Shortcut puts it. The Start menu by default; use "$HOME\Desktop" for the desktop.

.PARAMETER Tray
  Start hidden in the tray instead of opening the window.

.PARAMETER DevTools
  Run in this console with the developer tools open, so errors are visible. Blocks until StellarHub closes.

.PARAMETER NoLaunch
  Only set up (and create the shortcut, with -Shortcut); do not open StellarHub.

.PARAMETER AllowElevate
  Do not pass --no-elevate.

.EXAMPLE
  .\Start-StellarHub.ps1

.EXAMPLE
  .\Start-StellarHub.ps1 -Shortcut -NoLaunch
#>
[CmdletBinding()]
param(
    [switch]$Shortcut,
    [string]$ShortcutFolder = [Environment]::GetFolderPath('Programs'),
    [switch]$Tray,
    [switch]$DevTools,
    [switch]$NoLaunch,
    [switch]$AllowElevate
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
$pythonw = Join-Path $venv 'Scripts\pythonw.exe'
$requirements = Join-Path $root 'requirements.txt'
$stamp = Join-Path $venv '.requirements.sha256'
$runPy = Join-Path $root 'run.py'
$hasUv = [bool](Get-Command uv -ErrorAction SilentlyContinue)

function Assert-Ok([string]$what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

# 1. the environment, the first time
if (-not (Test-Path $python)) {
    Write-Host 'Creating the Python environment in .venv (first run only)...'
    if ($hasUv) { uv venv --python 3.12 $venv }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { py -3.12 -m venv $venv }
    else { python -m venv $venv }
    Assert-Ok 'Creating the environment'
}

# 2. the packages, only when requirements.txt is not the one that was installed
$wanted = (Get-FileHash $requirements -Algorithm SHA256).Hash
$installed = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' }
if ($installed -ne $wanted) {
    Write-Host 'Installing the packages in requirements.txt...'
    if ($hasUv) { uv pip install --python $python -r $requirements }
    else { & $python -m pip install -r $requirements }
    Assert-Ok 'Installing the packages'
    Set-Content -Path $stamp -Value $wanted -Encoding ascii
}

# what StellarHub is started with
$appArgs = @()
if (-not $AllowElevate) { $appArgs += '--no-elevate' }
if ($Tray) { $appArgs += '--tray' }

# 3. the shortcut
if ($Shortcut) {
    $icon = Join-Path $root 'build\assets\StellarHub.ico'
    if (-not (Test-Path $icon)) {
        Write-Host 'Drawing the icon...'
        & $python (Join-Path $root 'packaging\make_assets.py') | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning 'The icon could not be drawn: the shortcut gets the Python icon.' }
    }
    if (-not (Test-Path $ShortcutFolder)) { New-Item -ItemType Directory -Path $ShortcutFolder | Out-Null }
    $lnkPath = Join-Path $ShortcutFolder 'StellarHub.lnk'
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = (@("`"$runPy`"") + $appArgs) -join ' '
    $lnk.WorkingDirectory = $root
    $lnk.Description = 'StellarHub (running from source)'
    if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()
    Write-Host "Shortcut created: $lnkPath"
}

# 4. open it
if ($NoLaunch) { return }
if ($DevTools) {
    & $python $runPy @appArgs --debug
}
else {
    Start-Process -FilePath $pythonw -ArgumentList (@("`"$runPy`"") + $appArgs) -WorkingDirectory $root
}
