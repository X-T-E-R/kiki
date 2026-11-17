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
if ($calls.Count -ne 2) { throw "Expected 2 Start-Process calls, saw $($calls.Count)." }
if ($calls[0].Arguments -ne '') { throw "Foreground launch passed unexpected arguments: $($calls[0].Arguments)" }
if ($calls[1].Arguments -ne '--background') { throw "Background launch did not pass --background: $($calls[1].Arguments)" }
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

$fnNames = @('Call-Local', 'Execution', 'Lifecycle', 'Stop-ProcessBounded', 'Close-DesktopShell', 'Await-Release', 'Release-OurPauses')
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

# 3. Await-Release explicitly verifies meta.build_id / instance.build_id against ExpectedCommit.
$runtime = Join-Path $ScratchRoot 'await-rt'
$state = [pscustomobject]@{
    oldServerId = 'old-srv'
    serverHomeId = 'home-1'
    spaceId = 'main'
    hadDesktop = $false
}
$launcherStub = [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
$expectedSha = 'c' * 40
$wrongSha = 'd' * 40
$script:mockServer = [pscustomobject]@{
    releaseId = 'rel-new'
    instance = [pscustomobject]@{ build_id = $wrongSha; port = 1; server_id = 'new-srv' }
    meta = [pscustomobject]@{ build_id = $wrongSha; server_id = 'new-srv'; server_home_id = 'home-1'; current_space_id = 'main' }
}
function Find-Server { return $script:mockServer }
function Find-Shells { return @() }
$mismatchCaught = $false
try {
    $null = Await-Release 'rel-new' $expectedSha $launcherStub
} catch {
    if ($_.Exception.Message -match "reported build_id '$wrongSha' instead of expected commit '$expectedSha'") {
        $mismatchCaught = $true
    } else {
        throw "Unexpected Await-Release error: $($_.Exception.Message)"
    }
}
if (-not $mismatchCaught) { throw 'Await-Release did not reject mismatched build_id.' }

$script:mockServer.instance.build_id = $expectedSha
$script:mockServer.meta.build_id = $expectedSha
$matched = Await-Release 'rel-new' $expectedSha $launcherStub
if ($matched.meta.build_id -cne $expectedSha) { throw 'Await-Release did not return matching build_id server.' }

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
'@, (New-Object Text.UTF8Encoding($false)))
    Invoke-Controller @('-HotSwitchPath', $hotSwitchPath, '-ControllerPath', $controller, '-ScratchRoot', (Join-Path $testRoot 'hs-unit')) 0 $hotSwitchRunner | Out-Null

    Write-Output 'desktop-release tests passed: initial, repeated, fail-closed, verification, cli-publish, installed-controller, production-default, shortcut, main-runtime-shortcut, receipt, legacy-launch, and hot-switch-guard cases.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
