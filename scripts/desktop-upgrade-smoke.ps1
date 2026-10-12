if ($env:CI -ne "true") { throw "The installer upgrade check must run in an isolated CI runner." }

$installer = $env:ANIMA_DESKTOP_INSTALLER
if (!$installer -or !(Test-Path -LiteralPath $installer)) { throw "Current installer was not found: $installer" }

$previousInstaller = Join-Path $env:RUNNER_TEMP "Anima-Desktop-Setup-v0.3.0.exe"
$previousUrl = "https://github.com/MarwaneKhalis/Anima-Desktop/releases/download/v0.3.0/Anima-Desktop-Setup.exe"
Invoke-WebRequest -Uri $previousUrl -OutFile $previousInstaller
$previousHash = (Get-FileHash -LiteralPath $previousInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($previousHash -ne "795260c05737ff2bb05a7abb3b6c1d391911df88d6aad640fd21f178b1120ffe") {
  throw "The downloaded v0.3.0 installer did not match its published SHA-256 digest."
}

$legacyInstallDir = Join-Path $env:LOCALAPPDATA "Programs\Anima Connect"
$legacyExe = Join-Path $legacyInstallDir "Anima Connect.exe"
$previousProcess = Start-Process -FilePath $previousInstaller -ArgumentList @("/S") -Wait -PassThru
if ($previousProcess.ExitCode -ne 0) { throw "The v0.3.0 installer failed with exit code $($previousProcess.ExitCode)." }
if (!(Test-Path -LiteralPath $legacyExe)) { throw "The v0.3.0 app was not installed at its expected default location: $legacyExe" }

$userDataDir = Join-Path $env:APPDATA "Anima Connect"
New-Item -ItemType Directory -Path $userDataDir -Force | Out-Null
$sentinel = Join-Path $userDataDir "upgrade-preservation-sentinel.txt"
Set-Content -LiteralPath $sentinel -Value "preserve-v0.3-user-data" -NoNewline

$env:TEMP = $env:RUNNER_TEMP
$installLog = Join-Path $env:TEMP "anima-desktop-installer.log"
$upgradeProcess = Start-Process -FilePath $installer -ArgumentList @("/S") -Wait -PassThru
if ($upgradeProcess.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $installLog) { Get-Content -LiteralPath $installLog }
  throw "The v0.4.0 upgrade from v0.3.0 failed with exit code $($upgradeProcess.ExitCode)."
}

$upgradedExe = Join-Path $legacyInstallDir "Anima Desktop.exe"
if (!(Test-Path -LiteralPath $upgradedExe)) { throw "The v0.4.0 executable was not installed over the existing v0.3.0 location: $upgradedExe" }
if (!(Test-Path -LiteralPath $sentinel) -or (Get-Content -LiteralPath $sentinel -Raw) -ne "preserve-v0.3-user-data") {
  throw "The v0.3.0 user-data directory was not preserved by the upgrade."
}

$env:ANIMA_DESKTOP_EXECUTABLE = $upgradedExe
pnpm desktop:smoke
if ($LASTEXITCODE -ne 0) { throw "The upgraded app smoke test failed with exit code $LASTEXITCODE." }
$remaining = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($legacyInstallDir, [StringComparison]::OrdinalIgnoreCase) }
if ($remaining) { throw "An upgraded Anima Desktop process remained after the smoke test: $($remaining.Name -join ', ')" }
