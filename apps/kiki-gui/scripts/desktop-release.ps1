[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Promote', 'Launch', 'InstallShortcuts')]
    [string]$Action,

    [string]$RuntimeRoot,
    [string]$CandidateRoot,
    [string]$ExpectedCommit,
    [string]$DesktopPath,
    [switch]$WaitForUser
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-DefaultRuntimeRoot {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is not set. Pass -RuntimeRoot with a writable Kiki runtime directory.'
    }
    return [IO.Path]::Combine($env:LOCALAPPDATA, 'EasyAgent', 'Kiki-Dev')
}

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path)
}

function Write-AtomicUtf8Json([string]$Path, [object]$Value) {
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.{0}.{1}.tmp' -f ([IO.Path]::GetFileName($Path)), [guid]::NewGuid().ToString('N'))
    $backup = Join-Path $parent ('.{0}.{1}.bak' -f ([IO.Path]::GetFileName($Path)), [guid]::NewGuid().ToString('N'))
    $json = $Value | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [IO.File]::Replace($temporary, $Path, $backup)
            Remove-Item -LiteralPath $backup -Force
        }
        else {
            [IO.File]::Move($temporary, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
        if (Test-Path -LiteralPath $backup) {
            Remove-Item -LiteralPath $backup -Force
        }
    }
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-ArtifactInfo([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path. Build Kiki successfully so kiki-desktop.exe and kiki-server.exe are in the candidate directory, then retry."
    }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -le 0) {
        throw "$Label is empty: $Path. Rebuild Kiki, then retry promotion."
    }
    return [pscustomobject]@{
        Path = $item.FullName
        Length = [int64]$item.Length
        Hash = Get-Sha256 $item.FullName
    }
}

function Assert-ArtifactMatches([object]$Expected, [string]$ActualPath, [string]$Label) {
    $actual = Get-ArtifactInfo $ActualPath $Label
    if ($actual.Length -ne $Expected.Length -or $actual.Hash -ne $Expected.Hash) {
        throw "$Label failed copy verification at $ActualPath. The current Kiki release was not changed; remove the incomplete release directory and retry."
    }
}

function Read-CurrentManifest([string]$Root, [switch]$AllowMissing) {
    $path = Join-Path $Root 'current.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        throw "No promoted Kiki release is selected at $path. Run the Promote Kiki GUI shortcut first."
    }
    try {
        $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        throw "The Kiki release pointer is unreadable: $path. Promote a known-good build to repair it."
    }
    if ($manifest.schemaVersion -ne 1 -or $manifest.releaseId -notmatch '^[0-9a-f]{24}-[0-9a-f]{24}$') {
        throw "The Kiki release pointer is invalid: $path. Promote a known-good build to repair it."
    }
    return $manifest
}

function Get-ReleasePath([string]$Root, [string]$ReleaseId) {
    if ($ReleaseId -notmatch '^[0-9a-f]{24}-[0-9a-f]{24}$') {
        throw "Invalid Kiki release identifier: $ReleaseId"
    }
    return Join-Path (Join-Path $Root 'releases') $ReleaseId
}

function Get-GitSha([string]$Candidate) {
    # Diagnostic only. The published source is the build receipt, not the
    # commit this directory resolves to after the build.
    $previousLocks = $env:GIT_OPTIONAL_LOCKS
    try {
        $env:GIT_OPTIONAL_LOCKS = '0'
        $sha = & git --no-optional-locks -C $Candidate rev-parse HEAD 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) { return 'unknown' }
        return $sha.Trim()
    }
    catch {
        return 'unknown'
    }
    finally {
        $env:GIT_OPTIONAL_LOCKS = $previousLocks
    }
}

function Assert-FullCommit([string]$Commit) {
    if ($Commit -cnotmatch '^[0-9a-f]{40}$') {
        throw 'ExpectedCommit must be the full source commit selected for this promotion.'
    }
}

function Get-ObjectProperty([object]$Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Convert-ReceiptBytes($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        if ($Value -notmatch '^[0-9]+$') { return $null }
        $parsed = [int64]0
        if (-not [int64]::TryParse($Value, [ref]$parsed)) { return $null }
        return $parsed
    }
    if ($Value -is [double] -or $Value -is [float] -or $Value -is [decimal]) {
        if ([double]$Value -ne [math]::Truncate([double]$Value)) { return $null }
        return [int64]$Value
    }
    if ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64]) {
        return [int64]$Value
    }
    return $null
}

function Read-BuildReceipt([string]$Candidate) {
    # Name matches desktop-build-source.mjs RECEIPT_FILE_NAME.
    $path = Join-Path $Candidate 'desktop-build-receipt.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Kiki build receipt is missing: $path. The runtime was not changed."
    }
    try {
        $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        throw "Kiki build receipt is unreadable: $path. The runtime was not changed."
    }
    if ($null -eq $receipt -or $receipt -is [System.Array]) {
        throw "Kiki build receipt is invalid: $path. The runtime was not changed."
    }
    return $receipt
}

function Assert-ReceiptIdentity([object]$Receipt, [string]$ExpectedCommit) {
    $schema = Get-ObjectProperty $Receipt 'schemaVersion'
    $source = [string](Get-ObjectProperty $Receipt 'sourceCommit')
    $acceptance = [string](Get-ObjectProperty $Receipt 'acceptanceRef')
    $check = [string](Get-ObjectProperty $Receipt 'checkRef')
    if ($schema -ne 1 -or $source -cnotmatch '^[0-9a-f]{40}$') {
        throw 'Kiki build receipt is invalid. The runtime was not changed.'
    }
    if ($source -cne $ExpectedCommit) {
        throw "Build receipt source $source does not match the expected commit $ExpectedCommit. The runtime was not changed."
    }
    if ([string]::IsNullOrWhiteSpace($acceptance) -or [string]::IsNullOrWhiteSpace($check) -or $acceptance -match '[\r\n]' -or $check -match '[\r\n]') {
        throw 'Kiki build receipt is missing acceptance or check evidence references. The runtime was not changed.'
    }
    return $source
}

function Assert-ReceiptFile([object]$Record, [object]$Actual, [string]$Label) {
    $hash = [string](Get-ObjectProperty $Record 'sha256')
    $parsed = Convert-ReceiptBytes (Get-ObjectProperty $Record 'bytes')
    if ($hash -cnotmatch '^[0-9a-f]{64}$' -or $null -eq $parsed -or $parsed -le 0) {
        throw "$Label build receipt record is invalid. The runtime was not changed."
    }
    if ($parsed -ne [int64]$Actual.Length -or $hash -cne [string]$Actual.Hash) {
        throw "$Label does not match the build receipt. The runtime was not changed."
    }
}

function Assert-ReceiptFiles([object]$Receipt, [object]$Desktop, [object]$Server) {
    $files = Get-ObjectProperty $Receipt 'files'
    Assert-ReceiptFile (Get-ObjectProperty $files 'kiki-desktop.exe') $Desktop 'Kiki GUI'
    Assert-ReceiptFile (Get-ObjectProperty $files 'kiki-server.exe') $Server 'Kiki backend'
}

function Write-SourceDiagnostic([string]$Candidate, [string]$PublishedSha) {
    $directoryHead = Get-GitSha $Candidate
    if ($directoryHead -cne $PublishedSha) {
        Write-Output "Published source is build receipt $PublishedSha. Directory HEAD is $directoryHead."
    }
}

function Invoke-Promotion([string]$Root, [string]$Candidate, [string]$ExpectedCommit) {
    Assert-FullCommit $ExpectedCommit
    $rootPath = Get-FullPath $Root
    $candidatePath = Get-FullPath $Candidate
    $receipt = Read-BuildReceipt $candidatePath
    $gitSha = Assert-ReceiptIdentity $receipt $ExpectedCommit
    $mainSource = Get-ArtifactInfo (Join-Path $candidatePath 'kiki-desktop.exe') 'Kiki GUI build artifact'
    $sidecarSource = Get-ArtifactInfo (Join-Path $candidatePath 'kiki-server.exe') 'Kiki backend build artifact'
    Assert-ReceiptFiles $receipt $mainSource $sidecarSource

    [IO.Directory]::CreateDirectory($rootPath) | Out-Null
    $releasesPath = Join-Path $rootPath 'releases'
    [IO.Directory]::CreateDirectory($releasesPath) | Out-Null
    $releaseId = '{0}-{1}' -f $mainSource.Hash.Substring(0, 24), $sidecarSource.Hash.Substring(0, 24)
    $releasePath = Get-ReleasePath $rootPath $releaseId
    $mainDestination = Join-Path $releasePath 'kiki-desktop.exe'
    $sidecarDestination = Join-Path $releasePath 'kiki-server.exe'
    $buildInfoDestination = Join-Path $releasePath 'build-info.txt'

    if (Test-Path -LiteralPath $releasePath) {
        if (-not (Test-Path -LiteralPath $releasePath -PathType Container)) {
            throw "The Kiki release path is not a directory: $releasePath. Remove it and retry."
        }
        Assert-ArtifactMatches $mainSource $mainDestination 'Promoted Kiki GUI'
        Assert-ArtifactMatches $sidecarSource $sidecarDestination 'Promoted Kiki backend'
    }
    else {
        $stagingPath = Join-Path $releasesPath ('.pending-{0}' -f [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($stagingPath) | Out-Null
        try {
            $stagedMain = Join-Path $stagingPath 'kiki-desktop.exe'
            $stagedSidecar = Join-Path $stagingPath 'kiki-server.exe'
            Copy-Item -LiteralPath $mainSource.Path -Destination $stagedMain
            Copy-Item -LiteralPath $sidecarSource.Path -Destination $stagedSidecar
            Assert-ArtifactMatches $mainSource $stagedMain 'Promoted Kiki GUI'
            Assert-ArtifactMatches $sidecarSource $stagedSidecar 'Promoted Kiki backend'

            # A build that changes while it is being copied is not a successful candidate.
            Assert-ArtifactMatches $mainSource $mainSource.Path 'Kiki GUI source artifact'
            Assert-ArtifactMatches $sidecarSource $sidecarSource.Path 'Kiki backend source artifact'
            Write-BuildInfo (Join-Path $stagingPath 'build-info.txt') $gitSha
            [IO.Directory]::Move($stagingPath, $releasePath)
        }
        finally {
            if (Test-Path -LiteralPath $stagingPath) {
                Remove-Item -LiteralPath $stagingPath -Recurse -Force
            }
        }
    }

    Publish-CliExecutable $rootPath $sidecarSource

    $current = Read-CurrentManifest $rootPath -AllowMissing
    if ($null -ne $current -and $current.releaseId -eq $releaseId) {
        Write-SourceDiagnostic $candidatePath $gitSha
        Write-Output "Kiki release is already current: $releasePath"
        return
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        releaseId = $releaseId
        gitSha = $gitSha
        promotedAtUtc = [DateTime]::UtcNow.ToString('o')
        files = [ordered]@{
            'kiki-desktop.exe' = [ordered]@{ sha256 = $mainSource.Hash; bytes = $mainSource.Length }
            'kiki-server.exe' = [ordered]@{ sha256 = $sidecarSource.Hash; bytes = $sidecarSource.Length }
        }
    }
    Write-AtomicUtf8Json (Join-Path $rootPath 'current.json') $manifest
    Write-SourceDiagnostic $candidatePath $gitSha
    Write-Output "Promoted Kiki release: $releasePath"
}

function Write-BuildInfo([string]$Path, [string]$GitSha) {
    $text = 'gitSha: {0}' -f $GitSha
    [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding($false)))
}

function Publish-CliExecutable([string]$Root, [object]$Sidecar) {
    # Mirror the NSIS installer, which copies kiki-server.exe to
    # $INSTDIR\cli\kiki.exe. Placing the same layout at the runtime root makes
    # the packaged CLI reachable from the promoted build. Adding that directory
    # to the user PATH stays the installer's job; this only reports the hint.
    $cliDirectory = Join-Path $Root 'cli'
    $cliPath = Join-Path $cliDirectory 'kiki.exe'
    [IO.Directory]::CreateDirectory($cliDirectory) | Out-Null
    if (Test-Path -LiteralPath $cliPath -PathType Leaf) {
        $existing = Get-ArtifactInfo $cliPath 'Published Kiki CLI'
        if ($existing.Hash -eq $Sidecar.Hash -and $existing.Length -eq $Sidecar.Length) {
            Write-Output "Kiki CLI already current: $cliPath"
            return
        }
    }
    Copy-Item -LiteralPath $Sidecar.Path -Destination $cliPath -Force
    Assert-ArtifactMatches $Sidecar $cliPath 'Published Kiki CLI'
    Write-Output "Published Kiki CLI: $cliPath"
    Write-Output "Add '$cliDirectory' to PATH to run 'kiki' from any terminal (the Kiki installer does this automatically)."
}

function Resolve-LaunchTarget([string]$Root) {
    $rootPath = Get-FullPath $Root
    $manifest = Read-CurrentManifest $rootPath
    $releasePath = Get-ReleasePath $rootPath $manifest.releaseId
    $mainPath = Join-Path $releasePath 'kiki-desktop.exe'
    $sidecarPath = Join-Path $releasePath 'kiki-server.exe'
    Get-ArtifactInfo $mainPath 'Promoted Kiki GUI' | Out-Null
    Get-ArtifactInfo $sidecarPath 'Promoted Kiki backend' | Out-Null
    return [pscustomobject]@{
        Root = $rootPath
        ReleasePath = $releasePath
        MainPath = $mainPath
        SidecarPath = $sidecarPath
        ReleaseId = [string]$manifest.releaseId
    }
}

function Invoke-Launch([string]$Root) {
    $target = Resolve-LaunchTarget $Root

    # Tauri starts the adjacent kiki-server.exe through its external sidecar API.
    if ((Split-Path -Leaf $target.Root) -eq 'Kiki-Dev') {
        $previousHome = $env:KIKI_HOME
        try {
            $env:KIKI_HOME = $target.Root
            Start-Process -FilePath $target.MainPath -WorkingDirectory $target.ReleasePath
        }
        finally {
            $env:KIKI_HOME = $previousHome
        }
    }
    else {
        Start-Process -FilePath $target.MainPath -WorkingDirectory $target.ReleasePath
    }
}

function Assert-SafeShortcutPath([string]$Path, [string]$Label) {
    if ($Path.Contains('"')) {
        throw "$Label cannot contain a double quote: $Path"
    }
}

function New-KikiShortcut(
    [object]$Shell,
    [string]$Path,
    [string]$PowerShellPath,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$Description
) {
    $shortcut = $Shell.CreateShortcut($Path)
    $shortcut.TargetPath = $PowerShellPath
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.IconLocation = "$PowerShellPath,0"
    $shortcut.Save()
}

function Install-KikiShortcuts([string]$Root, [string]$Candidate, [string]$Desktop, [string]$ExpectedCommit) {
    Assert-FullCommit $ExpectedCommit
    $rootPath = Get-FullPath $Root
    $candidatePath = Get-FullPath $Candidate
    $desktopFullPath = Get-FullPath $Desktop
    $controllerDirectory = Join-Path $rootPath 'controller'
    $installedController = Join-Path $controllerDirectory 'desktop-release.ps1'
    [IO.Directory]::CreateDirectory($controllerDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($desktopFullPath) | Out-Null

    if ((Get-FullPath $PSCommandPath) -ne (Get-FullPath $installedController)) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $installedController -Force
    }
    Write-AtomicUtf8Json (Join-Path $controllerDirectory 'settings.json') ([ordered]@{
        schemaVersion = 1
        candidateRoot = $candidatePath
        expectedCommit = $ExpectedCommit
    })

    Assert-SafeShortcutPath $rootPath 'Runtime root'
    Assert-SafeShortcutPath $installedController 'Installed controller path'
    Assert-SafeShortcutPath $ExpectedCommit 'Expected commit'
    $powerShellPath = Join-Path $PSHOME 'powershell.exe'
    $shell = New-Object -ComObject WScript.Shell
    $common = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $installedController
    $launchArguments = '-WindowStyle Hidden {0} -Action Launch -RuntimeRoot "{1}"' -f $common, $rootPath
    $promoteArguments = '{0} -Action Promote -RuntimeRoot "{1}" -ExpectedCommit "{2}" -WaitForUser' -f $common, $rootPath, $ExpectedCommit
    New-KikiShortcut $shell (Join-Path $desktopFullPath 'Kiki GUI (Dev).lnk') $powerShellPath $launchArguments $controllerDirectory 'Launch the current promoted Kiki development build'
    New-KikiShortcut $shell (Join-Path $desktopFullPath 'Promote Kiki GUI (Dev).lnk') $powerShellPath $promoteArguments $controllerDirectory 'Promote the last successful Kiki development build'
    Write-Output "Installed Kiki development shortcuts in: $desktopFullPath"
}

function Resolve-CandidateRoot {
    if (-not [string]::IsNullOrWhiteSpace($CandidateRoot)) {
        return $CandidateRoot
    }
    $settingsPath = Join-Path $PSScriptRoot 'settings.json'
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        try {
            $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
            if ($settings.schemaVersion -eq 1 -and -not [string]::IsNullOrWhiteSpace($settings.candidateRoot)) {
                return [string]$settings.candidateRoot
            }
        }
        catch {
            throw "Kiki desktop settings are unreadable: $settingsPath. Reinstall the desktop shortcuts."
        }
        throw "Kiki desktop settings are invalid: $settingsPath. Reinstall the desktop shortcuts."
    }
    # Only Tauri's production build embeds frontendDist. A plain `cargo build`
    # under target/debug resolves build.devUrl instead, so promoting it would
    # launch an app that waits for the Vite development server and never calls
    # desktop_connection. Both desktop:build:artifacts and desktop:build emit
    # the self-contained executable and adjacent sidecar here.
    return Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release'
}

function Show-LaunchError([string]$Message) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show(
            $Message,
            'Kiki could not start',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
    catch {
        Write-Error $Message
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
        $RuntimeRoot = Get-DefaultRuntimeRoot
    }

    try {
        switch ($Action) {
            'Promote' {
                Invoke-Promotion $RuntimeRoot (Resolve-CandidateRoot) $ExpectedCommit
                if ($WaitForUser) { Read-Host 'Promotion succeeded. Press Enter to close' | Out-Null }
            }
            'Launch' {
                Invoke-Launch $RuntimeRoot
            }
            'InstallShortcuts' {
                if ([string]::IsNullOrWhiteSpace($DesktopPath)) {
                    $DesktopPath = [Environment]::GetFolderPath('Desktop')
                }
                Install-KikiShortcuts $RuntimeRoot (Resolve-CandidateRoot) $DesktopPath $ExpectedCommit
            }
        }
    }
    catch {
        $message = $_.Exception.Message
        if ($Action -eq 'Launch') {
            Show-LaunchError $message
        }
        else {
            Write-Error "Kiki desktop release failed: $message"
        }
        if ($WaitForUser) { Read-Host 'Press Enter to close' | Out-Null }
        exit 1
    }
}
