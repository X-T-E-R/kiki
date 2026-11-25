Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$controller = Join-Path $PSScriptRoot 'desktop-release.ps1'
$powerShell = Join-Path $PSHOME 'powershell.exe'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$tempBase = Join-Path $repoRoot '.tmp\desktop-release-tests'
[IO.Directory]::CreateDirectory($tempBase) | Out-Null
$testRoot = Join-Path $tempBase ([guid]::NewGuid().ToString('N'))
# Named Kiki-Dev so the development runtime keeps its existing shortcut names; the
# main runtime case below installs into <testRoot>\Kiki.
$runtimeRoot = Join-Path $testRoot 'Kiki-Dev'
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
        $output = & $powerShell -NoProfile -ExecutionPolicy Bypass -File $ControllerPath @Arguments 2>&1 | Out-String -Width 4096
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
function Get-Sha256 { throw 'Ordinary launch must not hash executables.' }
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
    Assert-True ($missingReceipt -match 'build receipt is\s+missing') "Missing receipt was not rejected.`n$missingReceipt"
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
    $verifiedRunner = Join-Path $testRoot 'verified-promotion.ps1'
    [IO.File]::WriteAllText($verifiedRunner, @'
param([string]$Controller, [string]$Candidate, [string]$Runtime, [string]$Commit, [switch]$Mutate)
$ErrorActionPreference = 'Stop'
. $Controller -Action Launch
$originalHash = ${function:Get-Sha256}
$hashReads = @{}
function Get-Sha256([string]$Path) {
    $hashReads[$Path] = 1 + [int]$hashReads[$Path]
    & $originalHash $Path
}
$verified = Read-PromotionCandidate $Candidate $Commit
$desktop = $verified.Desktop.Path
$server = $verified.Sidecar.Path
if ($Mutate) {
    $saved = [IO.File]::ReadAllBytes($desktop)
    try {
        [IO.File]::WriteAllText($desktop, 'changed-after-verification')
        $rejected = $false
        try { Invoke-Promotion $Runtime $verified | Out-Null }
        catch {
            if ($_.Exception.Message -notmatch 'failed copy verification') { throw }
            $rejected = $true
        }
        if (!$rejected) { throw 'A changed candidate was promoted.' }
        if (Test-Path -LiteralPath (Join-Path $Runtime 'current.json')) { throw 'A changed candidate selected a release.' }
        if (Test-Path -LiteralPath (Join-Path $Runtime 'cli\kiki.exe')) { throw 'A changed candidate published a CLI.' }
    } finally { [IO.File]::WriteAllBytes($desktop, $saved) }
} else {
    Invoke-Promotion $Runtime $verified | Out-Null
    if ((Read-CurrentManifest $Runtime).releaseId -cne $verified.ReleaseId) { throw 'Verified promotion selected another release.' }
}
if ($hashReads[$desktop] -ne 1 -or $hashReads[$server] -ne 1) { throw 'Candidate executables were hashed more than once.' }
'@, (New-Object Text.UTF8Encoding($false)))
    Invoke-Controller @('-Controller', $controller, '-Candidate', $candidateRoot, '-Runtime', (Join-Path $testRoot 'verified-runtime'), '-Commit', $expectedCommit) 0 $verifiedRunner | Out-Null
    Invoke-Controller @('-Controller', $controller, '-Candidate', $candidateRoot, '-Runtime', (Join-Path $testRoot 'mutated-runtime'), '-Commit', $expectedCommit, '-Mutate') 0 $verifiedRunner | Out-Null
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

    $activeDir = Join-Path $runtimeRoot 'active'
    Assert-True (Test-Path -LiteralPath $activeDir -PathType Container) 'Initial promotion did not create active\ directory.'
    Assert-True ((([IO.File]::GetAttributes($activeDir)) -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'active\ must be a real directory, not a junction or symlink.'
    Assert-Equal 'main-build-a' ([IO.File]::ReadAllText((Join-Path $activeDir 'kiki-desktop.exe'))) 'Active GUI bytes differ from promoted release.'
    Assert-Equal 'sidecar-build-a' ([IO.File]::ReadAllText((Join-Path $activeDir 'kiki-server.exe'))) 'Active backend bytes differ from promoted release.'
    Assert-Equal "gitSha: $expectedCommit" ([IO.File]::ReadAllText((Join-Path $activeDir 'build-info.txt'))) 'Active build-info.txt did not match.'
    $activeManifest = Get-Content -LiteralPath (Join-Path $activeDir 'active-release.json') -Raw | ConvertFrom-Json
    Assert-Equal 1 ([int]$activeManifest.schemaVersion) 'active-release.json schemaVersion mismatch.'
    Assert-Equal ([string]$firstManifest.releaseId) ([string]$activeManifest.releaseId) 'active-release.json releaseId did not match current.json.'
    Assert-Equal $expectedCommit ([string]$activeManifest.gitSha) 'active-release.json gitSha mismatch.'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$activeManifest.syncedAtUtc)) 'active-release.json missing syncedAtUtc.'
    $resolvedActive = Invoke-LaunchResolve $runtimeRoot
    Assert-True ($resolvedActive.Contains((Join-Path $activeDir 'kiki-desktop.exe'))) 'Resolve-LaunchTarget did not prefer aligned active\kiki-desktop.exe without hashing.'
    Assert-True ($resolvedActive.Contains((Join-Path $activeDir 'kiki-server.exe'))) 'Resolve-LaunchTarget did not prefer aligned active\kiki-server.exe without hashing.'

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
    $installedConductor = Join-Path (Join-Path $runtimeRoot 'controller') 'kiki-ops-conductor.mjs'
    Assert-True (Test-Path -LiteralPath $installedConductor -PathType Leaf) 'Shortcut installation did not sync kiki-ops-conductor.mjs into controller/.'
    Assert-True (Test-Path -LiteralPath (Join-Path (Join-Path $runtimeRoot 'controller') 'desktop-receipt-contract.mjs') -PathType Leaf) 'Shortcut installation did not sync desktop-receipt-contract.mjs into controller/.'
    $conductorHelp = & node $installedConductor --help 2>&1 | Out-String
    Assert-Equal 0 $LASTEXITCODE "Installed kiki-ops-conductor.mjs failed to execute outside checkout: $conductorHelp"
    Assert-True ($conductorHelp -match 'kiki-ops-conductor') 'Installed kiki-ops-conductor.mjs did not print help output.'
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
    Assert-Equal 'Launch the current promoted Kiki development build' $launchShortcut.Description 'Kiki GUI (Dev).lnk lost its development description.'
    Assert-Equal 'Promote the last successful Kiki development build' $promoteShortcut.Description 'Promote Kiki GUI (Dev).lnk lost its development description.'
    Assert-Equal (Join-Path $runtimeRoot 'controller') $launchShortcut.WorkingDirectory 'Kiki GUI (Dev).lnk does not work from the controller directory.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $desktopRoot 'Kiki GUI.lnk'))) 'The development runtime installed the release launch shortcut name.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $desktopRoot 'Promote Kiki GUI.lnk'))) 'The development runtime installed the release promote shortcut name.'

    $mainRoot = Join-Path $testRoot 'Kiki'
    $mainDesktop = Join-Path $testRoot 'main-desktop'
    [IO.Directory]::CreateDirectory($mainDesktop) | Out-Null
    # The user's normal entry already exists and must be updated in place.
    $userEntry = $shell.CreateShortcut((Join-Path $mainDesktop 'Kiki GUI.lnk'))
    $userEntry.TargetPath = (Join-Path $testRoot 'old-kiki.exe')
    $userEntry.Arguments = '-old'
    $userEntry.Save()
    $otherEntryPath = Join-Path $mainDesktop 'Other App.lnk'
    $otherEntry = $shell.CreateShortcut($otherEntryPath)
    $otherEntry.TargetPath = (Join-Path $testRoot 'other.exe')
    $otherEntry.Arguments = '-keep'
    $otherEntry.Save()
    $otherEntryBytes = [IO.File]::ReadAllBytes($otherEntryPath)

    $mainOutput = Invoke-Controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $mainRoot,
        '-CandidateRoot', $candidateRoot,
        '-DesktopPath', $mainDesktop,
        '-ExpectedCommit', $expectedCommit
    )
    Assert-True ($mainOutput -match 'Installed Kiki shortcuts in') 'Main shortcut installation did not report the release runtime.'

    $mainController = Join-Path (Join-Path $mainRoot 'controller') 'desktop-release.ps1'
    Assert-True (Test-Path -LiteralPath $mainController -PathType Leaf) 'Main shortcut installation did not install the release controller.'
    $mainSettings = Get-Content -LiteralPath (Join-Path (Join-Path $mainRoot 'controller') 'settings.json') -Raw | ConvertFrom-Json
    Assert-Equal ([IO.Path]::GetFullPath($candidateRoot)) ([string]$mainSettings.candidateRoot) 'Main runtime settings did not point at the injected candidate.'
    Assert-Equal $expectedCommit ([string]$mainSettings.expectedCommit) 'Main runtime settings dropped ExpectedCommit.'

    $mainLaunch = $shell.CreateShortcut((Join-Path $mainDesktop 'Kiki GUI.lnk'))
    $mainPromote = $shell.CreateShortcut((Join-Path $mainDesktop 'Promote Kiki GUI.lnk'))
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $mainDesktop 'Kiki GUI (Dev).lnk'))) 'The main runtime created a development launch shortcut.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $mainDesktop 'Promote Kiki GUI (Dev).lnk'))) 'The main runtime created a development promote shortcut.'
    Assert-Equal 'Launch the current promoted Kiki build' $mainLaunch.Description 'Kiki GUI.lnk does not describe the release build.'
    Assert-Equal 'Promote the last successful Kiki build' $mainPromote.Description 'Promote Kiki GUI.lnk does not describe the release build.'
    Assert-True ($mainLaunch.TargetPath.EndsWith('powershell.exe', [StringComparison]::OrdinalIgnoreCase)) 'Kiki GUI.lnk does not target Windows PowerShell.'
    Assert-True ($mainLaunch.TargetPath -cne (Join-Path $testRoot 'old-kiki.exe')) 'Kiki GUI.lnk was not updated away from the previous target.'
    Assert-True ($mainLaunch.Arguments.Contains("-File `"$mainController`"")) 'Kiki GUI.lnk does not invoke the installed release controller.'
    Assert-True ($mainLaunch.Arguments.Contains("-RuntimeRoot `"$mainRoot`"")) 'Kiki GUI.lnk does not launch the main runtime.'
    Assert-True ($mainLaunch.Arguments -match '-Action Launch') 'Kiki GUI.lnk does not select the Launch action.'
    Assert-True ($mainLaunch.Arguments -match '-WindowStyle Hidden') 'Kiki GUI.lnk does not hide the controller window.'
    Assert-True (-not $mainLaunch.Arguments.Contains('-ExpectedCommit')) 'Kiki GUI.lnk requires an expected commit.'
    Assert-True (-not ($mainLaunch.Arguments -match 'target[\\/]debug')) 'Kiki GUI.lnk points into target/debug.'
    Assert-Equal (Join-Path $mainRoot 'controller') $mainLaunch.WorkingDirectory 'Kiki GUI.lnk does not work from the controller directory.'
    Assert-Equal (Join-Path $mainRoot 'controller') $mainPromote.WorkingDirectory 'Promote Kiki GUI.lnk does not work from the controller directory.'
    Assert-True ($mainPromote.Arguments.Contains("-File `"$mainController`"")) 'Promote Kiki GUI.lnk does not invoke the installed release controller.'
    Assert-True ($mainPromote.Arguments.Contains("-RuntimeRoot `"$mainRoot`"")) 'Promote Kiki GUI.lnk does not target the main runtime.'
    Assert-True ($mainPromote.Arguments -match '-Action Promote') 'Promote Kiki GUI.lnk does not select the Promote action.'
    Assert-True ($mainPromote.Arguments -match '-WaitForUser') 'Promote Kiki GUI.lnk does not keep its result visible.'
    Assert-True ($mainPromote.Arguments.Contains("-ExpectedCommit `"$expectedCommit`"")) 'Promote Kiki GUI.lnk does not pass ExpectedCommit.'

    Assert-True (Test-Path -LiteralPath $otherEntryPath -PathType Leaf) 'Shortcut installation removed an unrelated user shortcut.'
    Assert-BytesEqual $otherEntryBytes ([IO.File]::ReadAllBytes($otherEntryPath)) 'Shortcut installation changed an unrelated user shortcut.'
    $otherEntryAfter = $shell.CreateShortcut($otherEntryPath)
    Assert-Equal (Join-Path $testRoot 'other.exe') $otherEntryAfter.TargetPath 'Shortcut installation retargeted an unrelated user shortcut.'
    Assert-Equal '-keep' $otherEntryAfter.Arguments 'Shortcut installation rewrote an unrelated user shortcut.'

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
    # Simulate active\kiki-server.exe being locked while promoting a newer build:
    # Promote must stage releases\<id>\ and current.json without corrupting active\.
    $activeLockStream = [IO.File]::Open((Join-Path $activeDir 'kiki-server.exe'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $lockedPromoteOut = Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-ExpectedCommit', $expectedCommit) 0 $installedController
        Assert-True ($lockedPromoteOut -match 'staged for the next switch/relaunch') "Locked active Promote did not report staged state.`n$lockedPromoteOut"
        $configuredManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        Assert-Equal $secondReleaseId ([string]$configuredManifest.releaseId) 'The installed controller did not promote from its configured candidate path.'
        Assert-Equal $expectedCommit ([string]$configuredManifest.gitSha) 'The installed controller recorded a source other than the build receipt.'
        Assert-Equal 'sidecar-build-b' ([IO.File]::ReadAllText($cliPath)) 'Repromotion did not refresh cli\kiki.exe to the new backend.'
        $activeManifestWhileLocked = Get-Content -LiteralPath (Join-Path $activeDir 'active-release.json') -Raw | ConvertFrom-Json
        Assert-Equal ([string]$firstManifest.releaseId) ([string]$activeManifestWhileLocked.releaseId) 'Locked active-release.json was overwritten while locked.'
        $fallbackResolve = Invoke-LaunchResolve $runtimeRoot
        Assert-True ($fallbackResolve.Contains((Join-Path (Join-Path $runtimeRoot 'releases') (Join-Path $secondReleaseId 'kiki-desktop.exe')))) 'Launch fallback did not target releases\<newId>\ while active\ was locked on older release.'
    }
    finally {
        $activeLockStream.Dispose()
    }
    # Once unlocked, re-promoting syncs active\ cleanly without rewriting current.json.
    $syncAfterUnlockOut = Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-ExpectedCommit', $expectedCommit) 0 $installedController
    Assert-True ($syncAfterUnlockOut -match 'Synced active runtime') "Unlocked repromote did not sync active\.`n$syncAfterUnlockOut"
    $activeManifestAfterUnlock = Get-Content -LiteralPath (Join-Path $activeDir 'active-release.json') -Raw | ConvertFrom-Json
    Assert-Equal $secondReleaseId ([string]$activeManifestAfterUnlock.releaseId) 'active-release.json did not advance after lock release.'
    Assert-Equal 'main-build-b' ([IO.File]::ReadAllText((Join-Path $activeDir 'kiki-desktop.exe'))) 'Active GUI bytes did not update after lock release.'
    # Incomplete parseable active-release.json ({}) must not crash under StrictMode and must be repaired by Launch.
    [IO.File]::WriteAllText((Join-Path $activeDir 'active-release.json'), '{}', (New-Object Text.UTF8Encoding($false)))
    $brokenActiveResolve = Invoke-LaunchResolve $runtimeRoot
    Assert-True ($brokenActiveResolve.Contains((Join-Path (Join-Path $runtimeRoot 'releases') (Join-Path $secondReleaseId 'kiki-desktop.exe')))) 'Resolve-LaunchTarget did not fall back to releases\ on incomplete active-release.json.'
    $repairedSyncOut = Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-ExpectedCommit', $expectedCommit) 0 $installedController
    Assert-True ($repairedSyncOut -match 'Synced active runtime') "Promote did not repair incomplete active-release.json.`n$repairedSyncOut"
    $repairedManifest = Get-Content -LiteralPath (Join-Path $activeDir 'active-release.json') -Raw | ConvertFrom-Json
    Assert-Equal $secondReleaseId ([string]$repairedManifest.releaseId) 'Repaired active-release.json did not match current release.'

    # Locked build-info.txt during Promote must not leave partially replaced binaries in active\.
    $buildInfoLock = [IO.File]::Open((Join-Path $activeDir 'build-info.txt'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-desktop.exe'), 'main-build-c')
        [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-server.exe'), 'sidecar-build-c')
        Write-Receipt $candidateRoot $expectedCommit
        $lockedBuildInfoOut = Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-ExpectedCommit', $expectedCommit) 0 $installedController
        Assert-True ($lockedBuildInfoOut -match 'staged for the next switch/relaunch') "Locked build-info.txt did not defer active\ sync.`n$lockedBuildInfoOut"
        Assert-Equal 'main-build-b' ([IO.File]::ReadAllText((Join-Path $activeDir 'kiki-desktop.exe'))) 'Locked build-info.txt allowed partial overwrite of active kiki-desktop.exe.'
        Assert-Equal 'sidecar-build-b' ([IO.File]::ReadAllText((Join-Path $activeDir 'kiki-server.exe'))) 'Locked build-info.txt allowed partial overwrite of active kiki-server.exe.'
    }
    finally {
        $buildInfoLock.Dispose()
    }
    # Late publication failure AFTER both binaries and build-info.txt are replaced must roll back all replaced files via [NullString]::Value.
    $lateRollbackRunner = Join-Path $testRoot 'late-rollback.ps1'
    [IO.File]::WriteAllText($lateRollbackRunner, @'
param([string]$ControllerPath, [string]$RuntimePath, [string]$ReleaseId, [string]$Commit)
$ErrorActionPreference = 'Stop'
. $ControllerPath -Action Launch
function Write-AtomicUtf8Json([string]$Path, [object]$Value) {
    throw 'simulated manifest write failure after binary replacement'
}
$failed = $false
try {
    Sync-ActiveRelease $RuntimePath $ReleaseId $Commit | Out-Null
}
catch {
    if ($_.Exception.Message -match 'simulated manifest write failure') { $failed = $true }
    else { throw }
}
if (-not $failed) { throw 'Expected Sync-ActiveRelease to throw on simulated manifest write failure.' }
'@, (New-Object Text.UTF8Encoding($false)))
    Invoke-Controller @('-ControllerPath', $controller, '-RuntimePath', $runtimeRoot, '-ReleaseId', ([string]$firstManifest.releaseId), '-Commit', $expectedCommit) 0 $lateRollbackRunner | Out-Null
    Assert-Equal 'main-build-b' ([IO.File]::ReadAllText((Join-Path $activeDir 'kiki-desktop.exe'))) 'Late sync failure did not roll back active\kiki-desktop.exe.'
    Assert-Equal 'sidecar-build-b' ([IO.File]::ReadAllText((Join-Path $activeDir 'kiki-server.exe'))) 'Late sync failure did not roll back active\kiki-server.exe.'
    $manifestAfterLateRollback = Get-Content -LiteralPath (Join-Path $activeDir 'active-release.json') -Raw | ConvertFrom-Json
    Assert-Equal $secondReleaseId ([string]$manifestAfterLateRollback.releaseId) 'Late sync failure altered active-release.json.'

    # Restore candidate back to build-b and re-promote so downstream assertions remain consistent.
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-desktop.exe'), 'main-build-b')
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-server.exe'), 'sidecar-build-b')
    Write-Receipt $candidateRoot $expectedCommit
    Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-ExpectedCommit', $expectedCommit) 0 $installedController | Out-Null

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

    $backgroundRunner = Join-Path $testRoot 'background-launch.ps1'
    [IO.File]::WriteAllText($backgroundRunner, @'
param([string]$ControllerPath, [string]$RuntimePath)
$ErrorActionPreference = 'Stop'
. $ControllerPath -Action Launch
$calls = New-Object System.Collections.Generic.List[object]
function Start-Process {
    param(
        [string]$FilePath,
        [string]$WorkingDirectory,
        [string[]]$ArgumentList,
        [switch]$PassThru
    )
    $calls.Add([pscustomobject]@{
        FilePath = $FilePath
        WorkingDirectory = $WorkingDirectory
        Arguments = @($ArgumentList) -join ' '
        PassThru = [bool]$PassThru
    }) | Out-Null
}
Invoke-Launch $RuntimePath
Invoke-Launch $RuntimePath -Background
Invoke-Launch $RuntimePath -TrayOnly
Invoke-Launch $RuntimePath -Autostart
if ($calls.Count -ne 4) { throw "Expected 4 Start-Process calls, saw $($calls.Count)." }
if ($calls[0].Arguments -ne '') { throw "Foreground launch passed unexpected arguments: $($calls[0].Arguments)" }
if ($calls[1].Arguments -ne '--background') { throw "Background launch did not pass --background: $($calls[1].Arguments)" }
if ($calls[2].Arguments -ne '--tray-only') { throw "TrayOnly launch did not pass --tray-only: $($calls[2].Arguments)" }
if ($calls[3].Arguments -ne '--autostart') { throw "Autostart launch did not pass --autostart: $($calls[3].Arguments)" }
$expectedActiveDir = Join-Path ([IO.Path]::GetFullPath($RuntimePath)) 'active'
$expectedActiveExe = Join-Path $expectedActiveDir 'kiki-desktop.exe'
if ($calls[0].FilePath -ine $expectedActiveExe) { throw "Launch did not sync and run from active\: $($calls[0].FilePath)" }
if ($calls[0].WorkingDirectory -ine $expectedActiveDir) { throw "Launch did not set WorkingDirectory to active\: $($calls[0].WorkingDirectory)" }
'@, (New-Object Text.UTF8Encoding($false)))
    Invoke-Controller @('-ControllerPath', $controller, '-RuntimePath', $legacyRoot) 0 $backgroundRunner | Out-Null

    $hotSwitchPath = Join-Path $PSScriptRoot 'desktop-hot-switch.ps1'
    $hotSwitchRunner = Join-Path $testRoot 'hot-switch-units.ps1'
    [IO.File]::WriteAllText($hotSwitchRunner, @'
param([string]$HotSwitchPath, [string]$ControllerPath, [string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
. $ControllerPath -Action Launch

$ast = [Management.Automation.Language.Parser]::ParseFile($HotSwitchPath, [ref]$null, [ref]$null)
$paramAst = $ast.ParamBlock.Parameters
$settleParam = $paramAst | Where-Object { $_.Name.VariablePath.UserPath -eq 'SettleSeconds' }
if ($null -eq $settleParam -or $settleParam.DefaultValue.Extent.Text -ne '600') {
    throw "Expected default SettleSeconds = 600, saw '$($settleParam.DefaultValue.Extent.Text)'."
}
$interruptParam = $paramAst | Where-Object { $_.Name.VariablePath.UserPath -eq 'InterruptAfterSettle' }
if ($null -eq $interruptParam -or $interruptParam.DefaultValue.Extent.Text -ne '$true') {
    throw "Expected default InterruptAfterSettle = `$true, saw '$($interruptParam.DefaultValue.Extent.Text)'."
}
$noInterruptParam = $paramAst | Where-Object { $_.Name.VariablePath.UserPath -eq 'NoInterruptAfterSettle' }
if ($null -eq $noInterruptParam) {
    throw 'Expected switch parameter -NoInterruptAfterSettle.'
}

$fnNames = @('Call-Local', 'Execution', 'Lifecycle', 'Stop-ProcessBounded', 'Close-DesktopShell', 'Get-ExplicitPortFromCommandLine', 'Resolve-ExpectedHeadlessPort', 'Get-ExpectedHeadlessPort', 'Await-AllReleases', 'Release-OurPauses')
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $fnNames }, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}

# 1. Execution uses bounded timeouts (> 0) for resume/cancelPause as well as read/pause, and Lifecycle passes interrupt_work.
$ownerToken = 'a' * 43
$lastBody = $null
function Invoke-RestMethod {
    param($Uri, $Headers, $MaximumRedirection, $TimeoutSec, $Method, $ContentType, $Body)
    $script:lastBody = if ($Body) { $Body | ConvertFrom-Json } else { $null }
    return @{ code = 0; data = $TimeoutSec }
}
$server = @{ port = 1; server_id = 'srv-1' }
foreach ($method in @('resume', 'cancelPause')) {
    $t = Execution $server 'sess-1' $method
    if ($t -le 0) { throw "Expected bounded positive timeout for $method, saw $t." }
}
foreach ($method in @('read', 'pause')) {
    $t = Execution $server 'sess-1' $method
    if ($t -ne 60) { throw "Expected 60s timeout for $method, saw $t." }
}
$null = Lifecycle $server 'update'
if ($lastBody.interrupt_work -ne $false) { throw 'Expected Lifecycle default interrupt_work = $false.' }
$null = Lifecycle $server 'update' $true
if ($lastBody.interrupt_work -ne $true) { throw 'Expected Lifecycle interrupt_work = $true when requested.' }

# 2. Close-DesktopShell terminates tray/hidden shells where CloseMainWindow() returns $false and restores closeToTray.
$homePath = Join-Path $ScratchRoot 'tray-home'
[IO.Directory]::CreateDirectory($homePath) | Out-Null
$prefsFile = Join-Path $homePath 'desktop.json'
Write-AtomicUtf8Json $prefsFile ([ordered]@{ closeToTray = $true; theme = 'paper' })
$StartupSeconds = 2
$stoppedIds = New-Object System.Collections.Generic.List[int]
function Stop-Process {
    param([int]$Id, [switch]$Force, $ErrorAction)
    $stoppedIds.Add($Id) | Out-Null
    $script:trayShellExited = $true
}
$script:trayShellExited = $false
$trayShell = New-Object PSObject -Property @{ Id = 42420 }
$trayShell | Add-Member -MemberType ScriptProperty -Name HasExited -Value { return $script:trayShellExited }
$trayShell | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
$trayShell | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value { return $false }
$trayShell | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($ms) return $script:trayShellExited }

Close-DesktopShell $trayShell
if (-not $stoppedIds.Contains(42420)) { throw 'Close-DesktopShell did not terminate tray-hidden shell process.' }
$restoredPrefs = Get-Content -LiteralPath $prefsFile -Raw | ConvertFrom-Json
if ($restoredPrefs.closeToTray -ne $true -or $restoredPrefs.theme -ne 'paper') {
    throw 'Close-DesktopShell did not restore desktop.json closeToTray preference.'
}

# 3. Await-AllReleases explicitly verifies meta.build_id / instance.build_id against ExpectedCommit (including missing build_id under StrictMode).
$runtime = Join-Path $ScratchRoot 'await-rt'
$spaceKey = $homePath.ToLowerInvariant()
$spaceStateStub = [pscustomobject]@{
    kikiHome = $homePath
    oldServerId = 'old-srv'
    serverHomeId = 'home-1'
    spaceId = 'main'
    hadDesktop = $false
    expectedPort = $null
    headlessLaunchArgs = 'serve'
    headlessOriginalPort = $null
}
$launchersMap = @{ $spaceKey = [pscustomobject]@{ HasExited = $false; ExitCode = 0 } }
$tokensMap = @{ $spaceKey = 'tok-1' }
$expectedSha = 'c' * 40
$wrongSha = 'd' * 40
$script:mockServer = [pscustomobject]@{
    releaseId = 'rel-new'
    instance = [pscustomobject]@{ port = 1; server_id = 'new-srv' }
    meta = [pscustomobject]@{ server_id = 'new-srv'; server_home_id = 'home-1'; current_space_id = 'main' }
}
function Find-Server { return $script:mockServer }
function Find-ShellEntries { return @() }
function Test-ServerHealthz { return $true }
$missingBuildCaught = $false
try {
    $null = Await-AllReleases @($spaceStateStub) 'rel-new' $expectedSha $launchersMap $tokensMap
} catch {
    if ($_.Exception.Message -match "reported build_id '' instead of expected commit '$expectedSha'") {
        $missingBuildCaught = $true
    } else {
        throw "Unexpected missing-build_id Await-AllReleases error: $($_.Exception.Message)"
    }
}
if (-not $missingBuildCaught) { throw 'Await-AllReleases did not handle missing build_id safely under StrictMode.' }

$script:mockServer.instance | Add-Member -NotePropertyName build_id -NotePropertyValue $wrongSha -Force
$script:mockServer.meta | Add-Member -NotePropertyName build_id -NotePropertyValue $wrongSha -Force
$mismatchCaught = $false
try {
    $null = Await-AllReleases @($spaceStateStub) 'rel-new' $expectedSha $launchersMap $tokensMap
} catch {
    if ($_.Exception.Message -match "reported build_id '$wrongSha' instead of expected commit '$expectedSha'") {
        $mismatchCaught = $true
    } else {
        throw "Unexpected Await-AllReleases error: $($_.Exception.Message)"
    }
}
if (-not $mismatchCaught) { throw 'Await-AllReleases did not reject mismatched build_id.' }

$script:mockServer.instance.build_id = $expectedSha
$script:mockServer.meta.build_id = $expectedSha
$script:mockServer | Add-Member -NotePropertyName executablePath -NotePropertyValue (Join-Path (Join-Path $runtime 'releases\rel-new') 'kiki-server.exe') -Force
$nonActiveCaught = $false
try {
    $null = Await-AllReleases @($spaceStateStub) 'rel-new' $expectedSha $launchersMap $tokensMap
} catch {
    if ($_.Exception.Message -match 'instead of active path') { $nonActiveCaught = $true }
    else { throw "Unexpected non-active Await-AllReleases error: $($_.Exception.Message)" }
}
if (-not $nonActiveCaught) { throw 'Await-AllReleases did not reject a server running outside active\.' }

$script:mockServer.executablePath = Join-Path (Join-Path $runtime 'active') 'kiki-server.exe'
$matchedMap = Await-AllReleases @($spaceStateStub) 'rel-new' $expectedSha $launchersMap $tokensMap
$matched = $matchedMap[$spaceKey]
if ($matched.meta.build_id -cne $expectedSha) { throw 'Await-AllReleases did not return matching build_id server.' }

# 4. Release-OurPauses tolerates idle/pausing states when $AllowCancel = $true (post-InterruptAfterSettle).
$state = [pscustomobject]@{
    sessions = @(
        [pscustomobject]@{ id = 's-idle'; pauseId = 'p-1' },
        [pscustomobject]@{ id = 's-pausing'; pauseId = 'p-2' }
    )
}
$execCalls = New-Object System.Collections.Generic.List[string]
function Execution([object]$Server, [string]$Id, [string]$Method, [object[]]$Arguments = @()) {
    $execCalls.Add("$Id`:$Method") | Out-Null
    if ($Method -eq 'read') {
        if ($Id -eq 's-idle') { return [pscustomobject]@{ pauseOperationId = 'p-1'; phase = 'idle' } }
        return [pscustomobject]@{ pauseOperationId = 'p-2'; phase = 'pausing' }
    }
    return [pscustomobject]@{ phase = 'idle' }
}
Release-OurPauses ([pscustomobject]@{ instance = $server }) $true
if (-not $execCalls.Contains('s-pausing:cancelPause')) {
    throw "Expected Release-OurPauses with AllowCancel to cancel lingering pause; saw: $($execCalls -join ', ')"
}

# 5. -Recover branch reuses Close-DesktopShell to clean up lingering tray shells before throwing.
$recoverIfAst = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text -match '^\s*if\s*\(\$Recover\)'
}, $false) | Select-Object -First 1
if ($null -eq $recoverIfAst -or $recoverIfAst.Extent.Text -notmatch 'Close-DesktopShell') {
    throw 'Expected -Recover branch to reuse Close-DesktopShell for lingering tray desktop shells.'
}
# 6. Get-InferredHomeFromChildArgs extracts unregistered headless space homes from __search-indexer and __plugin_run_node.
$helperNames = @('Normalize-HomePath', 'Get-InferredHomeFromChildArgs')
foreach ($hName in $helperNames) {
    $fnAst = $ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $hName
    }, $false) | Select-Object -First 1
    if ($null -eq $fnAst) { throw "Missing expected helper function $hName in desktop-hot-switch.ps1" }
    Invoke-Expression $fnAst.Extent.Text
}
$inferredCtf = Get-InferredHomeFromChildArgs '__search-indexer D:\666\KikiSpaces\ctf\search-index-v2\index.sqlite'
if ($inferredCtf -ine 'D:\666\KikiSpaces\ctf') {
    throw "Expected D:\666\KikiSpaces\ctf from __search-indexer, saw '$inferredCtf'."
}
$inferredQuoted = Get-InferredHomeFromChildArgs '__search-indexer "D:\My Spaces\ctf\search-index-v2\index.sqlite"'
if ($inferredQuoted -ine 'D:\My Spaces\ctf') {
    throw "Expected quoted space home from __search-indexer, saw '$inferredQuoted'."
}
$inferredPlugin = Get-InferredHomeFromChildArgs '__plugin_run_node C:\runtime\hostRunner.mjs C:\Users\alice\.kiki\plugins\managed\foo\entry.mjs'
if ($inferredPlugin -ine 'C:\Users\alice\.kiki') {
    throw "Expected C:\Users\alice\.kiki from __plugin_run_node, saw '$inferredPlugin'."
}
'@, (New-Object Text.UTF8Encoding($false)))
    Invoke-Controller @('-HotSwitchPath', $hotSwitchPath, '-ControllerPath', $controller, '-ScratchRoot', (Join-Path $testRoot 'hs-unit')) 0 $hotSwitchRunner | Out-Null

    # 7. Sync-DesktopAutostart (isolated HKCU test key) covers EnsureAutostart, boot-daemon auto-heal, opt-out respect, stale-release upgrade, and DisableAutostart.
    $autostartRunner = Join-Path $testRoot 'autostart-unit.ps1'
    [IO.File]::WriteAllText($autostartRunner, @'
param([string]$ControllerPath, [string]$RuntimePath, [string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
. $ControllerPath -Action Launch
$testReg = "HKCU:\Software\EasyAgent\KikiAutostartPsTest_$([guid]::NewGuid().ToString('N'))"
$homeDir = Join-Path $ScratchRoot 'home'
[IO.Directory]::CreateDirectory($homeDir) | Out-Null
$expectedCmd = '"{0}" --autostart' -f (Join-Path (Join-Path ([IO.Path]::GetFullPath($RuntimePath)) 'active') 'kiki-desktop.exe')
try {
    # Without boot-daemon and without existing entry, automatic sync leaves registry untouched.
    $r0 = Sync-DesktopAutostart $RuntimePath $homeDir $testReg
    if ($r0.enabled -or $r0.changed) { throw 'Automatic sync unexpectedly enabled autostart without boot daemon.' }

    # With boot-daemon script present and no opt-out, automatic sync registers interactive tray autostart.
    $bootDir = Join-Path $RuntimePath 'backend-boot'
    [IO.Directory]::CreateDirectory($bootDir) | Out-Null
    [IO.File]::WriteAllText((Join-Path $bootDir 'Start-KikiBackend.ps1'), '# boot daemon')
    $r1 = Sync-DesktopAutostart $RuntimePath $homeDir $testReg
    if (-not $r1.enabled -or $r1.command -cne $expectedCmd) { throw "Boot-daemon auto-heal failed: $($r1.command)" }

    # Disable removes the key; explicit opt-out in desktop.json prevents re-adding on future promotes.
    $r2 = Sync-DesktopAutostart $RuntimePath $homeDir $testReg -Disable
    if ($r2.enabled) { throw 'Disable did not clear autostart.' }
    [IO.File]::WriteAllText((Join-Path $homeDir 'desktop.json'), '{"autostart":false}')
    $r3 = Sync-DesktopAutostart $RuntimePath $homeDir $testReg
    if ($r3.enabled) { throw 'Automatic sync ignored explicit autostart=false opt-out.' }

    # ForceEnable overrides opt-out; stale releases\<oldId> entry upgrades cleanly to active\kiki-desktop.exe --autostart.
    $r4 = Sync-DesktopAutostart $RuntimePath $homeDir $testReg -ForceEnable
    if (-not $r4.enabled -or $r4.command -cne $expectedCmd) { throw "ForceEnable failed: $($r4.command)" }
    Set-ItemProperty -LiteralPath $testReg -Name 'Kiki' -Value ('"{0}" --background' -f (Join-Path $RuntimePath 'releases\old-id\kiki-desktop.exe'))
    $r5 = Sync-DesktopAutostart $RuntimePath $homeDir $testReg
    if (-not $r5.changed -or $r5.command -cne $expectedCmd) { throw "Stale release path was not upgraded: $($r5.command)" }
}
finally {
    if (Test-Path -LiteralPath $testReg) { Remove-Item -LiteralPath $testReg -Recurse -Force -ErrorAction SilentlyContinue }
    $bootDir = Join-Path $RuntimePath 'backend-boot'
    if (Test-Path -LiteralPath $bootDir) { Remove-Item -LiteralPath $bootDir -Recurse -Force -ErrorAction SilentlyContinue }
}
'@, (New-Object Text.UTF8Encoding($false)))
    Invoke-Controller @('-ControllerPath', $controller, '-RuntimePath', $legacyRoot, '-ScratchRoot', (Join-Path $testRoot 'auto-unit')) 0 $autostartRunner | Out-Null

    # 8. Dual-manifest schemaVersion 2 (electron-single-binary) promotion, v1 -> v2 -> v1 lossless rollback, headless ELECTRON_RUN_AS_NODE launch, and hot-switch v2 helpers.
    $v2Candidate = Join-Path $testRoot 'v2-candidate'
    [IO.Directory]::CreateDirectory($v2Candidate) | Out-Null
    [IO.File]::WriteAllText((Join-Path $v2Candidate 'kiki-desktop.exe'), 'electron-single-binary-v2')
    [IO.File]::WriteAllText((Join-Path $v2Candidate 'server-entry.mjs'), 'export const server = "v2";')
    [IO.File]::WriteAllText((Join-Path $v2Candidate 'native-addons.json'), '{"addons":["node-pty"]}')
    $v2DesktopHash = Get-Sha256 (Join-Path $v2Candidate 'kiki-desktop.exe')
    $v2EntryHash = Get-Sha256 (Join-Path $v2Candidate 'server-entry.mjs')
    $v2AddonsHash = Get-Sha256 (Join-Path $v2Candidate 'native-addons.json')
    $v2DesktopBytes = (Get-Item -LiteralPath (Join-Path $v2Candidate 'kiki-desktop.exe')).Length
    $v2EntryBytes = (Get-Item -LiteralPath (Join-Path $v2Candidate 'server-entry.mjs')).Length
    $v2AddonsBytes = (Get-Item -LiteralPath (Join-Path $v2Candidate 'native-addons.json')).Length
    $v2ReleaseId = '{0}-{1}' -f $v2DesktopHash.Substring(0, 24), $v2EntryHash.Substring(0, 24)

    # Reject invalid v2 receipt without runtimeKind='electron-single-binary'.
    $badV2Receipt = @"
{
  "schemaVersion": 2,
  "sourceCommit": "$expectedCommit",
  "acceptanceRef": "tasks/task-0027-kiki/prd.md",
  "checkRef": "fixture://desktop-checks",
  "files": {
    "kiki-desktop.exe": { "sha256": "$v2DesktopHash", "bytes": $v2DesktopBytes },
    "server-entry.mjs": { "sha256": "$v2EntryHash", "bytes": $v2EntryBytes },
    "native-addons.json": { "sha256": "$v2AddonsHash", "bytes": $v2AddonsBytes }
  }
}
"@
    [IO.File]::WriteAllText((Join-Path $v2Candidate 'desktop-build-receipt.json'), $badV2Receipt.Trim() + "`n", (New-Object Text.UTF8Encoding($false)))
    $badV2Out = Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-CandidateRoot', $v2Candidate, '-ExpectedCommit', $expectedCommit) 1
    Assert-True ($badV2Out -match 'build receipt is invalid') "Invalid v2 receipt missing runtimeKind was not rejected.`n$badV2Out"

    # Valid v2 receipt promotes cleanly onto existing v1 runtimeRoot and cleans stale active\kiki-server.exe.
    $validV2Receipt = @"
{
  "schemaVersion": 2,
  "runtimeKind": "electron-single-binary",
  "sourceCommit": "$expectedCommit",
  "acceptanceRef": "tasks/task-0027-kiki/prd.md",
  "checkRef": "fixture://desktop-checks",
  "files": {
    "kiki-desktop.exe": { "sha256": "$v2DesktopHash", "bytes": $v2DesktopBytes },
    "server-entry.mjs": { "sha256": "$v2EntryHash", "bytes": $v2EntryBytes },
    "native-addons.json": { "sha256": "$v2AddonsHash", "bytes": $v2AddonsBytes }
  }
}
"@
    [IO.File]::WriteAllText((Join-Path $v2Candidate 'desktop-build-receipt.json'), $validV2Receipt.Trim() + "`n", (New-Object Text.UTF8Encoding($false)))
    $v2PromoteOut = Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-CandidateRoot', $v2Candidate, '-ExpectedCommit', $expectedCommit)
    Assert-True ($v2PromoteOut -match 'Promoted Kiki release') "v2 promotion did not succeed.`n$v2PromoteOut"
    $v2Current = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Assert-Equal 2 ([int]$v2Current.schemaVersion) 'v2 current.json schemaVersion mismatch.'
    Assert-Equal 'electron-single-binary' ([string]$v2Current.runtimeKind) 'v2 current.json runtimeKind mismatch.'
    Assert-Equal $v2ReleaseId ([string]$v2Current.releaseId) 'v2 current.json releaseId mismatch.'
    $v2ActiveManifest = Get-Content -LiteralPath (Join-Path $activeDir 'active-release.json') -Raw | ConvertFrom-Json
    Assert-Equal 2 ([int]$v2ActiveManifest.schemaVersion) 'v2 active-release.json schemaVersion mismatch.'
    Assert-Equal 'electron-single-binary' ([string]$v2ActiveManifest.runtimeKind) 'v2 active-release.json runtimeKind mismatch.'
    Assert-Equal $v2ReleaseId ([string]$v2ActiveManifest.releaseId) 'v2 active-release.json releaseId mismatch.'
    Assert-True (Test-Path -LiteralPath (Join-Path $activeDir 'kiki-desktop.exe') -PathType Leaf) 'v2 active\kiki-desktop.exe missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $activeDir 'server-entry.mjs') -PathType Leaf) 'v2 active\server-entry.mjs missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $activeDir 'native-addons.json') -PathType Leaf) 'v2 active\native-addons.json missing.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $activeDir 'kiki-server.exe'))) 'Stale v1 active\kiki-server.exe was not removed on v2 promotion.'

    # Verify v2 launch target resolution, headless ELECTRON_RUN_AS_NODE launch, and lossless v2 -> v1 -> v2 switching via hot-switch helpers.
    $v2SwitchRunner = Join-Path $testRoot 'v2-switch-unit.ps1'
    [IO.File]::WriteAllText($v2SwitchRunner, @'
param([string]$HotSwitchPath, [string]$ControllerPath, [string]$RuntimePath, [string]$V1ReleaseId, [string]$V2ReleaseId, [string]$Commit)
$ErrorActionPreference = 'Stop'
. $ControllerPath -Action Launch
$runtime = [IO.Path]::GetFullPath($RuntimePath)
$ast = [Management.Automation.Language.Parser]::ParseFile($HotSwitchPath, [ref]$null, [ref]$null)
$fnNames = @(
    'Test-IsElectronServerCommandLine',
    'Strip-LeadingServerEntryArgument',
    'Get-RuntimeServerBinaryInfo',
    'Test-InstalledRelease',
    'Select-InstalledRelease'
)
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $fnNames }, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}

$targetV2 = Resolve-LaunchTarget $runtime
if ($targetV2.SchemaVersion -ne 2 -or $targetV2.RuntimeKind -cne 'electron-single-binary') { throw 'Resolve-LaunchTarget did not detect v2 runtime.' }
if ($targetV2.MainPath -ine (Join-Path (Join-Path $runtime 'active') 'kiki-desktop.exe')) { throw "Unexpected v2 MainPath: $($targetV2.MainPath)" }
if ($targetV2.ServerEntryPath -ine (Join-Path (Join-Path $runtime 'active') 'server-entry.mjs')) { throw "Unexpected v2 ServerEntryPath: $($targetV2.ServerEntryPath)" }

$launchCalls = New-Object System.Collections.Generic.List[object]
function Start-Process {
    param([string]$FilePath, [string]$WorkingDirectory, [string]$ArgumentList, [string]$WindowStyle, [switch]$PassThru)
    $launchCalls.Add([pscustomobject]@{
        FilePath = $FilePath
        ArgumentList = $ArgumentList
        RunAsNode = $env:ELECTRON_RUN_AS_NODE
    }) | Out-Null
}
$env:ELECTRON_RUN_AS_NODE = '1'
Invoke-Launch $runtime -TrayOnly
if ($launchCalls[0].RunAsNode -ne $null) { throw "GUI Invoke-Launch leaked ELECTRON_RUN_AS_NODE=$($launchCalls[0].RunAsNode)" }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Invoke-HeadlessLaunch $runtime (Join-Path $runtime 'dummy-home') 'serve --port 0'
if ($launchCalls[1].RunAsNode -cne '1') { throw 'v2 Invoke-HeadlessLaunch did not set ELECTRON_RUN_AS_NODE=1.' }
if ($launchCalls[1].FilePath -ine $targetV2.MainPath) { throw "v2 Invoke-HeadlessLaunch used wrong binary: $($launchCalls[1].FilePath)" }
if (-not $launchCalls[1].ArgumentList.Contains('server-entry.mjs') -or -not $launchCalls[1].ArgumentList.Contains('serve --port 0')) {
    throw "v2 Invoke-HeadlessLaunch arguments missing server-entry.mjs or serve args: $($launchCalls[1].ArgumentList)"
}

if (-not (Test-InstalledRelease $V1ReleaseId)) { throw "v1 release $V1ReleaseId not recognized as installed." }
if (-not (Test-InstalledRelease $V2ReleaseId)) { throw "v2 release $V2ReleaseId not recognized as installed." }
if (-not (Test-IsElectronServerCommandLine '"C:\rt\active\kiki-desktop.exe" "C:\rt\active\server-entry.mjs" serve --port 0')) {
    throw 'Test-IsElectronServerCommandLine failed to match v2 server process.'
}
if (Test-IsElectronServerCommandLine '"C:\rt\active\kiki-desktop.exe" --tray-only') {
    throw 'Test-IsElectronServerCommandLine falsely matched GUI process.'
}
$stripped = Strip-LeadingServerEntryArgument '"C:\rt\active\server-entry.mjs" serve --port 19123'
if ($stripped -cne 'serve --port 19123') { throw "Strip-LeadingServerEntryArgument returned '$stripped'." }

$v2BinInfo = Get-RuntimeServerBinaryInfo (Join-Path (Join-Path $runtime 'active') 'kiki-desktop.exe') '"C:\rt\active\kiki-desktop.exe" "C:\rt\active\server-entry.mjs" serve'
if ($null -eq $v2BinInfo -or $v2BinInfo.schemaVersion -ne 2 -or $v2BinInfo.releaseId -cne $V2ReleaseId) {
    throw 'Get-RuntimeServerBinaryInfo did not classify active v2 Electron server binary.'
}

# Rollback v2 -> v1 cleanly.
Select-InstalledRelease $V1ReleaseId $Commit 'Original' -RequireActiveSync
$rolledBackCurrent = Read-CurrentManifest $runtime
if ($rolledBackCurrent.schemaVersion -ne 1 -or $rolledBackCurrent.releaseId -cne $V1ReleaseId) {
    throw 'Rollback v2 -> v1 did not restore schemaVersion 1 current.json.'
}
$activeDir = Join-Path $runtime 'active'
if (-not (Test-Path -LiteralPath (Join-Path $activeDir 'kiki-server.exe') -PathType Leaf)) {
    throw 'Rollback v2 -> v1 did not restore active\kiki-server.exe.'
}
if ((Test-Path -LiteralPath (Join-Path $activeDir 'server-entry.mjs')) -or (Test-Path -LiteralPath (Join-Path $activeDir 'native-addons.json'))) {
    throw 'Rollback v2 -> v1 left stale v2 files in active\.'
}

# Switch forward v1 -> v2 again cleanly.
Select-InstalledRelease $V2ReleaseId $Commit 'Target' -RequireActiveSync
$switchedBackCurrent = Read-CurrentManifest $runtime
if ($switchedBackCurrent.schemaVersion -ne 2 -or $switchedBackCurrent.runtimeKind -cne 'electron-single-binary' -or $switchedBackCurrent.releaseId -cne $V2ReleaseId) {
    throw 'Re-upgrade v1 -> v2 did not restore schemaVersion 2 current.json.'
}
if (Test-Path -LiteralPath (Join-Path $activeDir 'kiki-server.exe')) {
    throw 'Re-upgrade v1 -> v2 left stale active\kiki-server.exe.'
}
'@, (New-Object Text.UTF8Encoding($false)))
    Invoke-Controller @('-HotSwitchPath', $hotSwitchPath, '-ControllerPath', $controller, '-RuntimePath', $runtimeRoot, '-V1ReleaseId', $secondReleaseId, '-V2ReleaseId', $v2ReleaseId, '-Commit', $expectedCommit) 0 $v2SwitchRunner | Out-Null

    Write-Output 'desktop-release tests passed: initial, repeated, fail-closed, verification, cli-publish, installed-controller, production-default, shortcut, main-runtime-shortcut, receipt, legacy-launch, hot-switch-guard, child-home-inference, autostart-sync, and v1/v2 dual-manifest rollback cases.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
