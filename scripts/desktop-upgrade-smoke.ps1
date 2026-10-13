if ($env:CI -ne "true") { throw "The installer upgrade check must run in an isolated CI runner." }

$installer = $env:ANIMA_DESKTOP_INSTALLER
if (!$installer -or !(Test-Path -LiteralPath $installer)) { throw "Current installer was not found: $installer" }

$version = node -p "require('./package.json').version"
$currentVersion = [version]$version
$releasesJson = gh api "repos/MarwaneKhalis/Anima-Desktop/releases?per_page=100"
if ($LASTEXITCODE -ne 0) { throw "Could not list published Anima Desktop releases through the authenticated GitHub CLI." }
$releases = $releasesJson | ConvertFrom-Json
$previousRelease = @($releases | Where-Object {
  !$_.prerelease -and !$_.draft -and $_.tag_name -match '^v\d+\.\d+\.\d+$' -and
  ([version]($_.tag_name -replace '^v', '')) -lt $currentVersion
} | Sort-Object { [version]($_.tag_name -replace '^v', '') } -Descending) | Select-Object -First 1
if (!$previousRelease) { throw "No published Anima Desktop release older than v$version could be found." }
$previousVersion = [string]$previousRelease.tag_name -replace '^v', ''
$previousAsset = @($previousRelease.assets | Where-Object { $_.name -eq "Anima-Desktop-Setup.exe" }) | Select-Object -First 1
if (!$previousAsset) { throw "The published v$previousVersion installer could not be identified." }
$previousInstaller = Join-Path $env:RUNNER_TEMP "Anima-Desktop-Setup-v$previousVersion.exe"
Invoke-WebRequest -Uri $previousAsset.browser_download_url -OutFile $previousInstaller -Headers @{ "User-Agent" = "Anima-Desktop-CI" }
$previousHash = (Get-FileHash -LiteralPath $previousInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($previousAsset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$' -or $previousHash -ne $Matches[1].ToLowerInvariant()) {
  throw "The downloaded v$previousVersion installer did not match its published SHA-256 digest."
}

$installDir = Join-Path $env:LOCALAPPDATA "Programs\Anima Desktop"
$previousExe = Join-Path $installDir "Anima Desktop.exe"
$previousProcess = Start-Process -FilePath $previousInstaller -ArgumentList @("/S") -Wait -PassThru
if ($previousProcess.ExitCode -ne 0) { throw "The v$previousVersion installer failed with exit code $($previousProcess.ExitCode)." }
if (!(Test-Path -LiteralPath $previousExe)) { throw "The v$previousVersion app was not installed at its expected default location: $previousExe" }

$userDataDir = Join-Path $env:APPDATA "Anima Connect"
if (Test-Path -LiteralPath $userDataDir) {
  $existingEntries = @(Get-ChildItem -LiteralPath $userDataDir -Force)
  if ($existingEntries.Count -gt 0) { throw "The CI user-data profile is not isolated; upgrade preservation refuses to overwrite existing data: $userDataDir" }
}
$env:ANIMA_UPGRADE_PROFILE = $userDataDir
$env:ANIMA_UPGRADE_FIXTURE_MODE = "seed"
$env:ANIMA_DESKTOP_EXECUTABLE = $previousExe
node scripts/desktop-upgrade-fixture.mjs
if ($LASTEXITCODE -ne 0) { throw "Could not seed representative data in the published v$previousVersion profile." }
$dataKey = Join-Path $userDataDir "data\local-data-key.dpapi"
$seededDataKeyHash = (Get-FileHash -LiteralPath $dataKey -Algorithm SHA256).Hash

$env:TEMP = $env:RUNNER_TEMP
$installLog = Join-Path $env:TEMP "anima-desktop-installer.log"
$upgradeProcess = Start-Process -FilePath $installer -ArgumentList @("/S") -Wait -PassThru
if ($upgradeProcess.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $installLog) { Get-Content -LiteralPath $installLog }
  throw "The v$version upgrade from v$previousVersion failed with exit code $($upgradeProcess.ExitCode)."
}

if (!(Test-Path -LiteralPath $previousExe)) { throw "The v$version executable was not installed over the existing v$previousVersion location: $previousExe" }

$env:ANIMA_UPGRADE_FIXTURE_MODE = "verify"
$env:ANIMA_DESKTOP_EXECUTABLE = $previousExe
node scripts/desktop-upgrade-fixture.mjs
if ($LASTEXITCODE -ne 0) { throw "The v$version upgrade did not preserve the previous version's encrypted profile, CV, application and vault data." }
if ((Get-FileHash -LiteralPath $dataKey -Algorithm SHA256).Hash -ne $seededDataKeyHash) {
  throw "The Windows-protected local data key changed during upgrade."
}
$env:ANIMA_UPGRADE_FIXTURE_MODE = $null
$env:ANIMA_UPGRADE_PROFILE = $null
pnpm desktop:smoke
if ($LASTEXITCODE -ne 0) { throw "The upgraded app smoke test failed with exit code $LASTEXITCODE." }
$remaining = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) }
if ($remaining) { throw "An upgraded Anima Desktop process remained after the smoke test: $($remaining.Name -join ', ')" }
