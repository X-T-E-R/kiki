Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$controller = Join-Path $PSScriptRoot 'desktop-release.ps1'
$powerShell = Join-Path $PSHOME 'powershell.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('kiki-desktop-release-{0}' -f [guid]::NewGuid().ToString('N'))
$runtimeRoot = Join-Path $testRoot 'runtime'
$candidateRoot = Join-Path $testRoot 'candidate'
$desktopRoot = Join-Path $testRoot 'desktop'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "$Message`nExpected: $Expected`nActual:   $Actual"
    }
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

try {
    [IO.Directory]::CreateDirectory($candidateRoot) | Out-Null
    [IO.Directory]::CreateDirectory($desktopRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki.exe'), 'main-build-a')
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-server.exe'), 'sidecar-build-a')

    $common = @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot, '-CandidateRoot', $candidateRoot)
    Invoke-Controller $common | Out-Null
    $manifestPath = Join-Path $runtimeRoot 'current.json'
    Assert-True (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'Initial promotion did not create current.json.'
    $firstManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Assert-True ($null -ne $firstManifest.gitSha -and $firstManifest.gitSha -match '^[0-9a-f]{40}$|^unknown$') 'current.json does not carry a git sha.'
    $firstRelease = Join-Path (Join-Path $runtimeRoot 'releases') $firstManifest.releaseId
    Assert-True (Test-Path -LiteralPath (Join-Path $firstRelease 'kiki.exe') -PathType Leaf) 'Initial promotion did not copy kiki.exe.'
    Assert-True (Test-Path -LiteralPath (Join-Path $firstRelease 'kiki-server.exe') -PathType Leaf) 'Initial promotion did not copy kiki-server.exe.'
    Assert-Equal 'main-build-a' ([IO.File]::ReadAllText((Join-Path $firstRelease 'kiki.exe'))) 'Promoted GUI bytes differ from the candidate.'
    Assert-Equal 'sidecar-build-a' ([IO.File]::ReadAllText((Join-Path $firstRelease 'kiki-server.exe'))) 'Promoted backend bytes differ from the candidate.'
    Assert-True (Test-Path -LiteralPath (Join-Path $firstRelease 'build-info.txt') -PathType Leaf) 'Initial promotion did not write build-info.txt.'
    $buildInfoText = [IO.File]::ReadAllText((Join-Path $firstRelease 'build-info.txt'))
    Assert-True ($buildInfoText -match 'gitSha: [0-9a-f]{40}|gitSha: unknown') 'build-info.txt does not carry a git sha.'

    $manifestBytesBeforeRepeat = [IO.File]::ReadAllBytes($manifestPath)
    Invoke-Controller $common | Out-Null
    $releaseDirectories = @(Get-ChildItem -LiteralPath (Join-Path $runtimeRoot 'releases') -Directory | Where-Object { -not $_.Name.StartsWith('.pending-') })
    Assert-Equal 1 $releaseDirectories.Count 'Repeated promotion created a duplicate release.'
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$manifestBytesBeforeRepeat, [byte[]][IO.File]::ReadAllBytes($manifestPath))) 'Repeated promotion rewrote the current pointer.'

    $manifestTextBeforeFailure = [IO.File]::ReadAllText($manifestPath)
    Remove-Item -LiteralPath (Join-Path $candidateRoot 'kiki-server.exe')
    $failureOutput = Invoke-Controller $common 1
    Assert-True ($failureOutput -match 'kiki-server\.exe') 'Missing-artifact failure did not identify kiki-server.exe.'
    Assert-Equal $manifestTextBeforeFailure ([IO.File]::ReadAllText($manifestPath)) 'Missing-artifact promotion changed current.json.'

    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki-server.exe'), 'sidecar-build-b')
    [IO.File]::WriteAllText((Join-Path $candidateRoot 'kiki.exe'), 'main-build-b')
    $secondReleaseId = Get-ReleaseId (Join-Path $candidateRoot 'kiki.exe') (Join-Path $candidateRoot 'kiki-server.exe')
    $invalidExistingRelease = Join-Path (Join-Path $runtimeRoot 'releases') $secondReleaseId
    [IO.Directory]::CreateDirectory($invalidExistingRelease) | Out-Null
    [IO.File]::WriteAllText((Join-Path $invalidExistingRelease 'kiki.exe'), 'corrupt-copy')
    [IO.File]::WriteAllText((Join-Path $invalidExistingRelease 'kiki-server.exe'), 'sidecar-build-b')
    $verificationOutput = Invoke-Controller $common 1
    Assert-True ($verificationOutput -match 'failed copy verification') 'Corrupt release failure did not report copy verification.'
    Assert-Equal $manifestTextBeforeFailure ([IO.File]::ReadAllText($manifestPath)) 'Copy-verification failure changed current.json.'

    Invoke-Controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $runtimeRoot,
        '-CandidateRoot', $candidateRoot,
        '-DesktopPath', $desktopRoot
    ) | Out-Null
    $installedController = Join-Path (Join-Path $runtimeRoot 'controller') 'desktop-release.ps1'
    Assert-True (Test-Path -LiteralPath $installedController -PathType Leaf) 'Shortcut installation did not install the stable release controller.'
    $settings = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $installedController) 'settings.json') -Raw | ConvertFrom-Json
    Assert-Equal ([IO.Path]::GetFullPath($candidateRoot)) ([string]$settings.candidateRoot) 'Installed controller did not retain the injected candidate path.'

    $shell = New-Object -ComObject WScript.Shell
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
    Assert-True ($promoteShortcut.Arguments -match '-Action Promote') 'Promote Kiki GUI (Dev).lnk does not select the Promote action.'
    Assert-True ($promoteShortcut.Arguments -match '-WaitForUser') 'Promote Kiki GUI (Dev).lnk does not keep its success or failure visible.'

    $defaultRuntime = Join-Path $testRoot 'default-candidate-runtime'
    Invoke-Controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $defaultRuntime,
        '-DesktopPath', (Join-Path $testRoot 'default-candidate-desktop')
    ) | Out-Null
    $defaultSettings = Get-Content -LiteralPath (Join-Path $defaultRuntime 'controller/settings.json') -Raw | ConvertFrom-Json
    $expectedDefaultCandidate = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release'))
    Assert-Equal $expectedDefaultCandidate ([string]$defaultSettings.candidateRoot) 'Default promotion did not select the self-contained Tauri production artifact.'
    Assert-True (-not ([string]$defaultSettings.candidateRoot -match 'target[\\/]debug')) 'Default promotion still accepts the Vite-dependent Cargo debug artifact.'

    Remove-Item -LiteralPath $invalidExistingRelease -Recurse -Force
    Invoke-Controller @('-Action', 'Promote', '-RuntimeRoot', $runtimeRoot) 0 $installedController | Out-Null
    $configuredManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Assert-Equal $secondReleaseId ([string]$configuredManifest.releaseId) 'The installed controller did not promote from its configured candidate path.'

    Write-Output 'desktop-release tests passed: initial, repeated, fail-closed, verification, installed-controller, production-default, and shortcut cases.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
