<#
  Builds StellarHub.exe and the installer, from a clean environment, in one go:

      powershell -ExecutionPolicy Bypass -File packaging\build.ps1

  Result: dist\StellarHub-Setup-<version>.exe and dist\StellarHub-Portable-<version>.zip (each with its .sha256)
  Needs Python 3.12+ and Inno Setup 6.6+ (winget install JRSoftware.InnoSetup). Nothing is installed system-wide:
  the Python packages go into .buildenv, with the exact versions below.
#>
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$pins = "pywebview==6.2.1", "pythonnet==3.2.1", "psutil==7.2.2", "pystray==0.19.5", "pillow==12.3.0",
        "pyinstaller==6.22.3", "pyinstaller-hooks-contrib==2026.9"
$version = (Select-String -Path stellarhub\__init__.py -Pattern 'VERSION = "(.+)"').Matches[0].Groups[1].Value
Write-Host "StellarHub $version" -ForegroundColor Cyan
New-Item -ItemType Directory -Force build\logs | Out-Null

# Runs a program with its output in build\logs\<step>.log. Not through a pipe on purpose: a process left running by
# a test (the uninstaller tests start a "ping" on purpose) would keep the pipe open and the build would never end.
function Step([string]$name, [string]$exe, [string[]]$argv) {
    Write-Host "  $name..."
    $log = "build\logs\$name.log"
    $p = Start-Process -FilePath $exe -ArgumentList $argv -NoNewWindow -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $null = $p.Handle  # Windows PowerShell only keeps the exit code if the handle was read
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) {
        Get-Content $log, "$log.err" -Tail 25 -ErrorAction SilentlyContinue
        throw "$name failed (exit code $($p.ExitCode)); see $log"
    }
}

# 1. clean build environment (only what StellarHub needs, so only that ends up in the exe)
$py = "$root\.buildenv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "Creating .buildenv..."
    Step "venv" "python" @("-m", "venv", ".buildenv")
}
Step "pip" $py (@("-m", "pip", "install", "--disable-pip-version-check") + $pins)

# 2. tests first: never package a broken engine
Step "tests" $py @("-m", "unittest", "discover", "-s", "tests", "-t", ".")
Get-Content "build\logs\tests.log.err" -Tail 1

# 3. icon, installer artwork, version resource, code statistics
Step "assets" $py @("packaging\make_assets.py")

# 4. StellarHub.exe (one folder, no UPX: see the notes in StellarHub.spec)
Step "pyinstaller" $py @("-m", "PyInstaller", "packaging\StellarHub.spec", "--noconfirm", "--clean", "--log-level", "WARN",
                         "--distpath", "build\dist", "--workpath", "build\work")

# 5. the installer (it downloads the WebView2 bootstrapper from Microsoft itself, only on PCs that lack WebView2)
$iscc = @($env:STELLARHUB_ISCC, "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
          "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup not found: winget install JRSoftware.InnoSetup" }
Step "installer" $iscc @("/Q", "/DAppVersion=$version", "packaging\StellarHub.iss")

# 6. the portable version: the same program in a .zip, with the marker that keeps its data next to it
Step "portable" $py @("packaging\make_portable.py")
Get-Content "build\logs\portable.log" -Tail 2

$out = Get-Item "dist\StellarHub-Setup-$version.exe"
$hash = (Get-FileHash $out -Algorithm SHA256).Hash
Set-Content "dist\StellarHub-Setup-$version.exe.sha256" "$hash  $($out.Name)" -Encoding ascii
Write-Host ("Done: {0} ({1:N1} MB)`nSHA-256 {2}" -f $out.FullName, ($out.Length / 1MB), $hash) -ForegroundColor Green
