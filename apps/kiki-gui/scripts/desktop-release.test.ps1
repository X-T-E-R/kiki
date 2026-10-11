Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$controller = Join-Path $PSScriptRoot 'desktop-release.ps1'
$powerShell = Join-Path $PSHOME 'powershell.exe'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$tempBase = Join-Path $repoRoot '.tmp\desktop-release-tests'
[IO.Directory]::CreateDirectory($tempBase) | Out-Null
$testRoot = Join-Path $tempBase ([guid]::NewGuid().ToString('N'))
$runtimeRoot = Join-Path $testRoot 'runtime'
$candidateRoot = Join-Path $testRoot 'candidate'
$desktopRoot = Join-Path $testRoot 'desktop'
$expectedCommit = 'a' * 40
$otherCommit = 'b' * 40

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "$Message`nExpected: $Expected`nActual:   $Actual"
    }
}

function Assert-BytesEqual([byte[]]$Expected, [byte[]]$Actual, [string]$Message) {
    if (-not [Linq.Enumerable]::SequenceEqual($Expected, $Actual)) { throw $Message }
}

function Invoke-Controller(
    [string[]]$Arguments,
    [int]$ExpectedExitCode = 0,
    [string]$ControllerPath = $controller
) {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $powerShell -NoProfile -ExecutionPolicy Bypass -File $ControllerPath @Arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne $ExpectedExitCode) {
        throw "desktop-release.ps1 exited with $exitCode instead of $ExpectedExitCode.`n$output"
    }
    return $output
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-ReleaseId([string]$MainPath, [string]$SidecarPath) {
    $mainHash = Get-Sha256 $MainPath
    $sidecarHash = Get-Sha256 $SidecarPath
    return '{0}-{1}' -f $mainHash.Substring(0, 24), $sidecarHash.Substring(0, 24)
}

function Write-Receipt([string]$Candidate, [string]$Commit) {
    $desktopPath = Join-Path $Candidate 'kiki-desktop.exe'
    $serverPath = Join-Path $Candidate 'kiki-server.exe'
    $desktop = Get-Item -LiteralPath $desktopPath
    $server = Get-Item -LiteralPath $serverPath
    $json = @"
{
  "schemaVersion": 1,
  "sourceCommit": "$Commit",
  "acceptanceRef": "tasks/task-0027-kiki/prd.md",
  "checkRef": "fixture://desktop-checks",
  "files": {
    "kiki-desktop.exe": { "sha256": "$(Get-Sha256 $desktopPath)", "bytes": $($desktop.Length) },
    "kiki-server.exe": { "sha256": "$(Get-Sha256 $serverPath)", "bytes": $($server.Length) }
  }
}
"@
    [IO.File]::WriteAllText((Join-Path $Candidate 'desktop-build-receipt.json'), $json.Trim() + "`n", (New-Object Text.UTF8Encoding($false)))
}

function Invoke-LaunchResolve([string]$Root) {
    $resolver = Join-Path $testRoot 'resolve-launch.ps1'
    [IO.File]::WriteAllText($resolver, @'
param(
    [Parameter(Mandatory = $true)][string]$ControllerPath,
    [Parameter(Mandatory = $true)][string]$RuntimePath
)
$ErrorActionPreference = 'Stop'
. $ControllerPath -Action Launch
$target = Resolve-LaunchTarget $RuntimePath
Write-Output $target.MainPath
Write-Output $target.SidecarPath
Write-Output $target.ReleaseId
'@, (New-Object Text.UTF8Encoding($false)))
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $powerShell -NoProfile -ExecutionPolicy Bypass -File $resolver -ControllerPath $controller -RuntimePath $Root 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "Launch resolve exited $exitCode.`n$output"
    }
    return $output
}

try {
    $repoHead = (& git --no-optional-locks -C $repoRoot rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoHead)) {
        throw 'Unable to read the worktree HEAD for the receipt-source assertion.'
    }
    $repoHead = $repoHead.Trim()
    Assert-True ($repoHead -cne $expectedCommit) 'Fixture expected commit matches directory HEAD, so the test would not prove the receipt source.'

    [IO.Directory]::CreateDirectory($candidateRoot) | Out-Null
    [IO.Directory]::CreateDirectory($desktopRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-desktop.exe'), 'main-build-a')
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-server.exe'), 'sidecar-build-a')

    $neverRoot = Join-Path $testRoot 'never-runtime'
    $neverCandidate = Join-Path $testRoot 'never-candidate'
    [IO.Directory]::CreateDirectory($neverCandidate) | Out-Null
    [IO.File]::WriteAllText((Join-Path $neverCandidate 'kiki-desktop.exe'), 'main-build-a')
    [IO.File]::WriteAllText((Join-Path $neverCandidate 'kiki-server.exe'), 'sidecar-build-a')
    $neverArgs = @('-Action', 'Promote', '-RuntimeRoot', $neverRoot, '-CandidateRoot', $neverCandidate, '-ExpectedCommit', $expectedCommit)
    $missingReceipt = Invoke-Controller $neverArgs 1
    Assert-True ($missingReceipt -match 'build receipt is missing') 'Missing receipt was not rejected.'
    Assert-True (-not (Test-Path -LiteralPath $neverRoot)) 'Missing receipt created a runtime root.'

    Write-Receipt $neverCandidate $otherCommit
    $staleReceipt = Invoke-Controller $neverArgs 1
    Assert-True ($staleReceipt -match 'does not match the expected commit') 'An old receipt was accepted for a new expected commit.'
    Assert-True (-not (Test-Path -LiteralPath $neverRoot)) 'Mismatched receipt created a runtime root.'

    Write-Receipt $neverCandidate $expectedCommit
    [IO.File]::WriteAllText((Join-Path $neverCandidate 'kiki-desktop.exe'), 'main-build-swapped')
    $swappedAbsent = Invoke-Controller $neverArgs 1
    Assert-True ($swappedAbsent -match 'does not match the build receipt') 'A swapped executable was accepted.'
    Assert-True (-not (Test-Path -LiteralPath $neverRoot)) 'Swapped executable created a runtime root.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $neverRoot 'current.json'))) 'Swapped executable created current.json.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $neverRoot 'cli\kiki.exe'))) 'Swapped executable published a CLI.'

    $shortcutAbsent = Join-Path $testRoot 'shortcut-absent'
    $shortcutDesktop = Join-Path $testRoot 'shortcut-absent-desktop'
    Invoke-Controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $shortcutAbsent,
        '-CandidateRoot', $candidateRoot,
        '-DesktopPath', $shortcutDesktop
    ) 1 | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $shortcutAbsent)) 'Shortcut installation without ExpectedCommit created a runtime root.'
    Assert-True (-not (Test-Path -LiteralPath $shortcutDesktop)) 'Shortcut installation without ExpectedCommit created a desktop directory.'

    Write-Receipt $candidateRoot $expectedCommit
    $common = @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-CandidateRoot', $candidateRoot, '-ExpectedCommit', $expectedCommit)
    $initialOutput = Invoke-Controller $common
    Assert-True ($initialOutput -match 'cli\\kiki\.exe') 'Promotion output did not report the published CLI path.'
    Assert-True ($initialOutput -match 'PATH') 'Promotion output did not hint at adding the CLI directory to PATH.'
    Assert-True ($initialOutput -match [regex]::Escape($expectedCommit)) 'Promotion output did not report the receipt source.'
    $manifestPath = Join-Path $runtimeRoot 'current.json'
    Assert-True (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'Initial promotion did not create current.json.'
    $firstManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Assert-Equal $expectedCommit ([string]$firstManifest.gitSha) 'current.json gitSha was not taken from the build receipt.'
    Assert-True (([string]$firstManifest.gitSha) -cne $repoHead) 'current.json gitSha followed directory HEAD instead of the build receipt.'
    $firstRelease = Join-Path (Join-Path $runtimeRoot 'releases') $firstManifest.releaseId
    Assert-True (Test-Path -LiteralPath (Join-Path $firstRelease 'kiki-desktop.exe') -PathType Leaf) 'Initial promotion did not copy kiki-desktop.exe.'
    Assert-True (Test-Path -LiteralPath (Join-Path $firstRelease 'kiki-server.exe') -PathType Leaf) 'Initial promotion did not copy kiki-server.exe.'
    Assert-Equal 'main-build-a' ([IO.File]::ReadAllText((Join-Path $firstRelease 'kiki-desktop.exe'))) 'Promoted GUI bytes differ from the candidate.'
    Assert-Equal 'sidecar-build-a' ([IO.File]::ReadAllText((Join-Path $firstRelease 'kiki-server.exe'))) 'Promoted backend bytes differ from the candidate.'
    Assert-True (Test-Path -LiteralPath (Join-Path $firstRelease 'build-info.txt') -PathType Leaf) 'Initial promotion did not write build-info.txt.'
    $buildInfoText = [IO.File]::ReadAllText((Join-Path $firstRelease 'build-info.txt'))
    Assert-Equal "gitSha: $expectedCommit" $buildInfoText 'build-info.txt did not record the build receipt source.'
    $cliPath = Join-Path $runtimeRoot 'cli\kiki.exe'
    Assert-True (Test-Path -LiteralPath $cliPath -PathType Leaf) 'Initial promotion did not publish cli\kiki.exe.'
    Assert-Equal 'sidecar-build-a' ([IO.File]::ReadAllText($cliPath)) 'Published CLI bytes differ from the promoted backend.'

    $manifestBytesBeforeRepeat = [IO.File]::ReadAllBytes($manifestPath)
    Invoke-Controller $common | Out-Null
    $releaseDirectories = @(Get-ChildItem -LiteralPath (Join-Path $runtimeRoot 'releases') -Directory | Where-Object { -not $_.Name.StartsWith('.pending-') })
    Assert-Equal 1 $releaseDirectories.Count 'Repeated promotion created a duplicate release.'
    Assert-BytesEqual $manifestBytesBeforeRepeat ([IO.File]::ReadAllBytes($manifestPath)) 'Repeated promotion rewrote the current pointer.'
    Assert-Equal 'sidecar-build-a' ([IO.File]::ReadAllText($cliPath)) 'Repeated promotion rewrote an unchanged cli\kiki.exe.'

    $manifestBytesBeforeRejection = [IO.File]::ReadAllBytes($manifestPath)
    $cliBytesBeforeRejection = [IO.File]::ReadAllBytes($cliPath)
    $wrongExpected = @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-CandidateRoot', $candidateRoot, '-ExpectedCommit', $otherCommit)
    $wrongOutput = Invoke-Controller $wrongExpected 1
    Assert-True ($wrongOutput -match 'does not match the expected commit') 'A newer expected commit reused the old receipt.'
    $desktopFile = Join-Path $candidateRoot 'kiki-desktop.exe'
    $savedDesktop = [IO.File]::ReadAllBytes($desktopFile)
    [IO.File]::WriteAllText($desktopFile, 'main-build-a-swapped')
    $swapOutput = Invoke-Controller $common 1
    Assert-True ($swapOutput -match 'does not match the build receipt') 'Replacing one executable was not rejected.'
    $receiptFile = Join-Path $candidateRoot 'desktop-build-receipt.json'
    $savedReceipt = [IO.File]::ReadAllBytes($receiptFile)
    Remove-Item -LiteralPath $receiptFile
    $removedReceipt = Invoke-Controller $common 1
    Assert-True ($removedReceipt -match 'build receipt is missing') 'A missing receipt was promoted onto an existing runtime.'
    [IO.File]::WriteAllBytes($receiptFile, $savedReceipt)
    [IO.File]::WriteAllBytes($desktopFile, $savedDesktop)
    Assert-BytesEqual $manifestBytesBeforeRejection ([IO.File]::ReadAllBytes($manifestPath)) 'A rejected promotion changed current.json.'
    Assert-BytesEqual $cliBytesBeforeRejection ([IO.File]::ReadAllBytes($cliPath)) 'A rejected promotion changed cli\kiki.exe.'
    $releaseDirectories = @(Get-ChildItem -LiteralPath (Join-Path $runtimeRoot 'releases') -Directory | Where-Object { -not $_.Name.StartsWith('.pending-') })
    Assert-Equal 1 $releaseDirectories.Count 'A rejected promotion created a release directory.'

    $manifestTextBeforeFailure = [IO.File]::ReadAllText($manifestPath)
    Remove-Item -LiteralPath (Join-Path $candidateRoot 'kiki-server.exe')
    $failureOutput = Invoke-Controller $common 1
    Assert-True ($failureOutput -match 'kiki-server\.exe') 'Missing-artifact failure did not identify kiki-server.exe.'
    Assert-Equal $manifestTextBeforeFailure ([IO.File]::ReadAllText($manifestPath)) 'Missing-artifact promotion changed current.json.'

    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-server.exe'), 'sidecar-build-b')
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-desktop.exe'), 'main-build-b')
    Write-Receipt $candidateRoot $expectedCommit
    $secondReleaseId = Get-ReleaseId (Join-Path $candidateRoot 'kiki-desktop.exe') (Join-Path $candidateRoot 'kiki-server.exe')
    $invalidExistingRelease = Join-Path (Join-Path $runtimeRoot 'releases') $secondReleaseId
    [IO.Directory]::CreateDirectory($invalidExistingRelease) | Out-Null
    [IO.File]::WriteAllText((Join-Path $invalidExistingRelease 'kiki-desktop.exe'), 'corrupt-copy')
    [IO.File]::WriteAllText((Join-Path $invalidExistingRelease 'kiki-server.exe'), 'sidecar-build-b')
    $verificationOutput = Invoke-Controller $common 1
    Assert-True ($verificationOutput -match 'failed copy verification') 'Corrupt release failure did not report copy verification.'
    Assert-Equal $manifestTextBeforeFailure ([IO.File]::ReadAllText($manifestPath)) 'Copy-verification failure changed current.json.'
    Assert-Equal 'sidecar-build-a' ([IO.File]::ReadAllText($cliPath)) 'A failed promotion changed cli\kiki.exe.'

    $proofDesktop = Join-Path $testRoot 'proof-desktop'
    Invoke-Controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $runtimeRoot,
        '-CandidateRoot', $candidateRoot,
        '-DesktopPath', $proofDesktop,
        '-ExpectedCommit', $otherCommit
    ) | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $proofShortcut = $shell.CreateShortcut((Join-Path $proofDesktop 'Promote Kiki GUI (Dev).lnk'))
    Assert-True ($proofShortcut.Arguments.Contains("-ExpectedCommit `"$otherCommit`"")) 'Promote shortcut did not keep the commit passed to InstallShortcuts.'
    Assert-True (-not $proofShortcut.Arguments.Contains($expectedCommit)) 'Promote shortcut took the expected commit from the build receipt.'

    Invoke-Controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $runtimeRoot,
        '-CandidateRoot', $candidateRoot,
        '-DesktopPath', $desktopRoot,
        '-ExpectedCommit', $expectedCommit
    ) | Out-Null
    $installedController = Join-Path (Join-Path $runtimeRoot 'controller') 'desktop-release.ps1'
    Assert-True (Test-Path -LiteralPath $installedController -PathType Leaf) 'Shortcut installation did not install the stable release controller.'
    $settings = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $installedController) 'settings.json') -Raw | ConvertFrom-Json
    Assert-Equal ([IO.Path]::GetFullPath($candidateRoot)) ([string]$settings.candidateRoot) 'Installed controller did not retain the injected candidate path.'
    Assert-Equal $expectedCommit ([string]$settings.expectedCommit) 'Installed settings did not retain the commit passed to InstallShortcuts.'

    $launchShortcut = $shell.CreateShortcut((Join-Path $desktopRoot 'Kiki GUI (Dev).lnk'))
    $promoteShortcut = $shell.CreateShortcut((Join-Path $desktopRoot 'Promote Kiki GUI (Dev).lnk'))
    foreach ($shortcut in @($launchShortcut, $promoteShortcut)) {
        Assert-True ($shortcut.TargetPath.EndsWith('powershell.exe', [StringComparison]::OrdinalIgnoreCase)) 'A shortcut does not target Windows PowerShell.'
        Assert-True ($shortcut.Arguments.Contains($installedController)) 'A shortcut does not invoke the installed release controller.'
        Assert-True (-not ($shortcut.TargetPath -match 'target[\\/]debug')) 'A shortcut target points into target/debug.'
        Assert-True (-not ($shortcut.Arguments -match 'target[\\/]debug')) 'Shortcut arguments point into target/debug.'
    }
    Assert-True ($launchShortcut.Arguments -match '-Action Launch') 'Kiki GUI (Dev).lnk does not select the Launch action.'
    Assert-True ($launchShortcut.Arguments -match '-WindowStyle Hidden') 'Kiki GUI (Dev).lnk does not hide the controller window.'
    Assert-True (-not $launchShortcut.Arguments.Contains('-ExpectedCommit')) 'Launch shortcut requires an expected commit.'
    Assert-True ($promoteShortcut.Arguments -match '-Action Promote') 'Promote Kiki GUI (Dev).lnk does not select the Promote action.'
    Assert-True ($promoteShortcut.Arguments -match '-WaitForUser') 'Promote Kiki GUI (Dev).lnk does not keep its success or failure visible.'
    Assert-True ($promoteShortcut.Arguments.Contains("-ExpectedCommit `"$expectedCommit`"")) 'Promote shortcut does not pass ExpectedCommit.'

    $defaultRuntime = Join-Path $testRoot 'default-candidate-runtime'
    Invoke-Controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $defaultRuntime,
        '-DesktopPath', (Join-Path $testRoot 'default-candidate-desktop'),
        '-ExpectedCommit', $expectedCommit
    ) | Out-Null
    $defaultSettings = Get-Content -LiteralPath (Join-Path $defaultRuntime 'controller/settings.json') -Raw | ConvertFrom-Json
    $expectedDefaultCandidate = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release'))
    Assert-Equal $expectedDefaultCandidate ([string]$defaultSettings.candidateRoot) 'Default promotion did not select the self-contained Tauri production artifact.'
    Assert-True (-not ([string]$defaultSettings.candidateRoot -match 'target[\\/]debug')) 'Default promotion still accepts the Vite-dependent Cargo debug artifact.'
    Assert-Equal $expectedCommit ([string]$defaultSettings.expectedCommit) 'Default shortcut installation dropped ExpectedCommit.'

    $manifestBytesBeforeOmitted = [IO.File]::ReadAllBytes($manifestPath)
    $omitted = Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot) 1 $installedController
    Assert-True ($omitted -match 'ExpectedCommit') 'Promote without ExpectedCommit was not rejected.'
    Assert-True ($omitted -notmatch 'failed copy verification') 'Promote without ExpectedCommit reached release copy verification.'
    Assert-BytesEqual $manifestBytesBeforeOmitted ([IO.File]::ReadAllBytes($manifestPath)) 'Promote without ExpectedCommit changed current.json.'

    Remove-Item -LiteralPath $invalidExistingRelease -Recurse -Force
    Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-ExpectedCommit', $expectedCommit) 0 $installedController | Out-Null
    $configuredManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Assert-Equal $secondReleaseId ([string]$configuredManifest.releaseId) 'The installed controller did not promote from its configured candidate path.'
    Assert-Equal $expectedCommit ([string]$configuredManifest.gitSha) 'The installed controller recorded a source other than the build receipt.'
    Assert-Equal 'sidecar-build-b' ([IO.File]::ReadAllText($cliPath)) 'Repromotion did not refresh cli\kiki.exe to the new backend.'

    $legacyRoot = Join-Path $testRoot 'legacy-runtime'
    $legacyCandidate = Join-Path $testRoot 'legacy-candidate'
    [IO.Directory]::CreateDirectory($legacyCandidate) | Out-Null
    [IO.File]::WriteAllText((Join-Path $legacyCandidate 'kiki-desktop.exe'), 'legacy-desktop')
    [IO.File]::WriteAllText((Join-Path $legacyCandidate 'kiki-server.exe'), 'legacy-server')
    $legacyReleaseId = Get-ReleaseId (Join-Path $legacyCandidate 'kiki-desktop.exe') (Join-Path $legacyCandidate 'kiki-server.exe')
    $legacyRelease = Join-Path (Join-Path $legacyRoot 'releases') $legacyReleaseId
    [IO.Directory]::CreateDirectory($legacyRelease) | Out-Null
    Copy-Item -LiteralPath (Join-Path $legacyCandidate 'kiki-desktop.exe') -Destination (Join-Path $legacyRelease 'kiki-desktop.exe')
    Copy-Item -LiteralPath (Join-Path $legacyCandidate 'kiki-server.exe') -Destination (Join-Path $legacyRelease 'kiki-server.exe')
    [IO.File]::WriteAllText((Join-Path $legacyRelease 'build-info.txt'), 'gitSha: unknown', (New-Object Text.UTF8Encoding($false)))
    $legacyPointer = @"
{
  "schemaVersion": 1,
  "releaseId": "$legacyReleaseId",
  "gitSha": "unknown",
  "promotedAtUtc": "2020-01-01T00:00:00.0000000Z"
}
"@
    [IO.File]::WriteAllText((Join-Path $legacyRoot 'current.json'), $legacyPointer.Trim() + "`n", (New-Object Text.UTF8Encoding($false)))
    $resolved = Invoke-LaunchResolve $legacyRoot
    Assert-True ($resolved.Contains((Join-Path $legacyRelease 'kiki-desktop.exe'))) 'Launch did not read the existing desktop executable.'
    Assert-True ($resolved.Contains((Join-Path $legacyRelease 'kiki-server.exe'))) 'Launch did not read the existing backend executable.'
    Assert-True ($resolved.Contains($legacyReleaseId)) 'Launch did not read the existing release id.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $legacyRoot 'desktop-build-receipt.json'))) 'Launch required a build receipt for an existing release.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $legacyRelease 'desktop-build-receipt.json'))) 'Launch required a build receipt inside an existing release.'

    Write-Output 'desktop-release tests passed: initial, repeated, fail-closed, verification, cli-publish, installed-controller, production-default, shortcut, receipt, and legacy-launch cases.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
