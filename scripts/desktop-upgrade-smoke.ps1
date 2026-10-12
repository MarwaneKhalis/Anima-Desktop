if ($env:CI -ne "true") { throw "The installer upgrade check must run in an isolated CI runner." }

$installer = $env:ANIMA_DESKTOP_INSTALLER
if (!$installer -or !(Test-Path -LiteralPath $installer)) { throw "Current installer was not found: $installer" }

$previousVersion = "0.4.2"
$version = node -p "require('./package.json').version"
$previousInstaller = Join-Path $env:RUNNER_TEMP "Anima-Desktop-Setup-v$previousVersion.exe"
$previousUrl = "https://github.com/MarwaneKhalis/Anima-Desktop/releases/download/v$previousVersion/Anima-Desktop-Setup.exe"
Invoke-WebRequest -Uri $previousUrl -OutFile $previousInstaller
$previousHash = (Get-FileHash -LiteralPath $previousInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($previousHash -ne "c324e0d1fba7c3d523e79b6f9327739d2edfba87f0eafc18a1e12a9d0f32bf45") {
  throw "The downloaded v$previousVersion installer did not match its published SHA-256 digest."
}

$installDir = Join-Path $env:LOCALAPPDATA "Programs\Anima Desktop"
$previousExe = Join-Path $installDir "Anima Desktop.exe"
$previousProcess = Start-Process -FilePath $previousInstaller -ArgumentList @("/S") -Wait -PassThru
if ($previousProcess.ExitCode -ne 0) { throw "The v$previousVersion installer failed with exit code $($previousProcess.ExitCode)." }
if (!(Test-Path -LiteralPath $previousExe)) { throw "The v$previousVersion app was not installed at its expected default location: $previousExe" }

$userDataDir = Join-Path $env:APPDATA "Anima Connect"
New-Item -ItemType Directory -Path $userDataDir -Force | Out-Null
$sentinel = Join-Path $userDataDir "upgrade-preservation-sentinel.txt"
Set-Content -LiteralPath $sentinel -Value "preserve-v$previousVersion-user-data" -NoNewline

$env:TEMP = $env:RUNNER_TEMP
$installLog = Join-Path $env:TEMP "anima-desktop-installer.log"
$upgradeProcess = Start-Process -FilePath $installer -ArgumentList @("/S") -Wait -PassThru
if ($upgradeProcess.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $installLog) { Get-Content -LiteralPath $installLog }
  throw "The v$version upgrade from v$previousVersion failed with exit code $($upgradeProcess.ExitCode)."
}

if (!(Test-Path -LiteralPath $previousExe)) { throw "The v$version executable was not installed over the existing v$previousVersion location: $previousExe" }
if (!(Test-Path -LiteralPath $sentinel) -or (Get-Content -LiteralPath $sentinel -Raw) -ne "preserve-v$previousVersion-user-data") {
  throw "The v$previousVersion user-data directory was not preserved by the upgrade."
}

$env:ANIMA_DESKTOP_EXECUTABLE = $previousExe
pnpm desktop:smoke
if ($LASTEXITCODE -ne 0) { throw "The upgraded app smoke test failed with exit code $LASTEXITCODE." }
$remaining = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) }
if ($remaining) { throw "An upgraded Anima Desktop process remained after the smoke test: $($remaining.Name -join ', ')" }
