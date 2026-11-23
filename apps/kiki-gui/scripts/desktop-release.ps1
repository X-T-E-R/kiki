[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Promote', 'Launch', 'InstallShortcuts')]
    [string]$Action,

    [string]$RuntimeRoot,
    [string]$CandidateRoot,
    [string]$ExpectedCommit,
    [string]$DesktopPath,
    [switch]$Background,
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
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
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
    $schemaVersion = Get-ObjectProperty $manifest 'schemaVersion'
    $releaseId = [string](Get-ObjectProperty $manifest 'releaseId')
    if ($schemaVersion -ne 1 -or $releaseId -notmatch '^[0-9a-f]{24}-[0-9a-f]{24}$') {
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

function Get-ActivePath([string]$Root) {
    return Join-Path (Get-FullPath $Root) 'active'
}

function Test-IsReparsePoint([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $attrs = [IO.File]::GetAttributes($Path)
    return (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-ProcessPathSafe([object]$Proc) {
    if ($null -eq $Proc) { return $null }
    try { return $Proc.Path } catch { return $null }
}

function Read-ActiveManifest([string]$Root, [switch]$AllowMissing) {
    $path = Join-Path (Get-ActivePath $Root) 'active-release.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        throw "Active Kiki release manifest is missing: $path"
    }
    try {
        $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        if ($AllowMissing) { return $null }
        throw "Active Kiki release manifest is unreadable: $path"
    }
    $schemaVersion = Get-ObjectProperty $manifest 'schemaVersion'
    $releaseId = [string](Get-ObjectProperty $manifest 'releaseId')
    if ($null -eq $manifest -or $schemaVersion -ne 1 -or $releaseId -notmatch '^[0-9a-f]{24}-[0-9a-f]{24}$') {
        if ($AllowMissing) { return $null }
        throw "Active Kiki release manifest is invalid: $path"
    }
    return $manifest
}

function Get-ActiveRuntimeProcesses([string]$Root) {
    $activeDir = Get-ActivePath $Root
    $prefix = $activeDir.TrimEnd('\') + '\'
    $found = @()
    foreach ($proc in @(Get-Process -Name 'kiki-desktop', 'kiki-server' -ErrorAction SilentlyContinue)) {
        try {
            if ($proc.HasExited) { continue }
            $procPath = Get-ProcessPathSafe $proc
            if ($procPath -and $procPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                $found += $proc
            }
        }
        catch {
        }
    }
    return $found
}

function Resolve-ActiveReleaseId([string]$Root) {
    $activeDir = Get-ActivePath $Root
    $desktopPath = Join-Path $activeDir 'kiki-desktop.exe'
    $serverPath = Join-Path $activeDir 'kiki-server.exe'
    if ((Test-Path -LiteralPath $desktopPath -PathType Leaf) -and (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        try {
            $desktop = Get-ArtifactInfo $desktopPath 'Active Kiki GUI'
            $server = Get-ArtifactInfo $serverPath 'Active Kiki backend'
            return '{0}-{1}' -f $desktop.Hash.Substring(0, 24), $server.Hash.Substring(0, 24)
        }
        catch {
        }
    }
    $activeManifest = Read-ActiveManifest $Root -AllowMissing
    if ($null -ne $activeManifest) {
        return [string]$activeManifest.releaseId
    }
    return $null
}

function Test-ActiveReleaseAligned([string]$Root, [string]$ReleaseId) {
    $activeDir = Get-ActivePath $Root
    if (-not (Test-Path -LiteralPath $activeDir -PathType Container)) { return $false }
    if (Test-IsReparsePoint $activeDir) { return $false }
    $activeManifest = Read-ActiveManifest $Root -AllowMissing
    if ($null -eq $activeManifest -or ([string]$activeManifest.releaseId) -cne $ReleaseId) { return $false }
    foreach ($name in @('kiki-desktop.exe', 'kiki-server.exe')) {
        $filePath = Join-Path $activeDir $name
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { return $false }
        if (Test-IsReparsePoint $filePath) { return $false }
        if ((Get-Item -LiteralPath $filePath).Length -le 0) { return $false }
    }
    return $true
}

function Test-FileExclusiveWritable([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $stream.Dispose()
        return $true
    }
    catch {
        return $false
    }
}

function Sync-ActiveReleaseCore(
    [string]$RootPath,
    [string]$ReleaseId,
    [string]$GitSha,
    [object]$DesktopInfo,
    [object]$SidecarInfo,
    [switch]$SkipIfLocked
) {
    $activePath = Get-ActivePath $RootPath
    $releasePath = Get-ReleasePath $RootPath $ReleaseId
    $releaseMain = Join-Path $releasePath 'kiki-desktop.exe'
    $releaseSidecar = Join-Path $releasePath 'kiki-server.exe'
    $releaseBuildInfo = Join-Path $releasePath 'build-info.txt'
    $activeMain = Join-Path $activePath 'kiki-desktop.exe'
    $activeSidecar = Join-Path $activePath 'kiki-server.exe'
    $activeBuildInfo = Join-Path $activePath 'build-info.txt'
    $activeManifestPath = Join-Path $activePath 'active-release.json'

    if (Test-ActiveReleaseAligned $RootPath $ReleaseId) {
        $existingMain = Get-ArtifactInfo $activeMain 'Active Kiki GUI'
        $existingSidecar = Get-ArtifactInfo $activeSidecar 'Active Kiki backend'
        if ($existingMain.Hash -ceq $DesktopInfo.Hash -and $existingMain.Length -eq $DesktopInfo.Length `
            -and $existingSidecar.Hash -ceq $SidecarInfo.Hash -and $existingSidecar.Length -eq $SidecarInfo.Length `
            -and (Test-Path -LiteralPath $activeBuildInfo -PathType Leaf)) {
            return [pscustomobject]@{
                Synced = $true
                AlreadyCurrent = $true
                Locked = $false
                ActivePath = $activePath
                ReleaseId = $ReleaseId
                LockingPids = @()
            }
        }
    }

    $running = @(Get-ActiveRuntimeProcesses $RootPath)
    if ($running.Count -gt 0) {
        $pids = @($running | ForEach-Object { [int]$_.Id })
        if ($SkipIfLocked) {
            return [pscustomobject]@{
                Synced = $false
                AlreadyCurrent = $false
                Locked = $true
                ActivePath = $activePath
                ReleaseId = $ReleaseId
                LockingPids = $pids
            }
        }
        throw ("Cannot sync active runtime at {0} while process(es) are running from it (PIDs: {1})." -f $activePath, ($pids -join ', '))
    }

    if ((-not (Test-FileExclusiveWritable $activeMain)) -or (-not (Test-FileExclusiveWritable $activeSidecar)) -or (-not (Test-FileExclusiveWritable $activeBuildInfo)) -or (-not (Test-FileExclusiveWritable $activeManifestPath))) {
        if ($SkipIfLocked) {
            return [pscustomobject]@{
                Synced = $false
                AlreadyCurrent = $false
                Locked = $true
                ActivePath = $activePath
                ReleaseId = $ReleaseId
                LockingPids = @()
            }
        }
        throw "Cannot sync active runtime at $activePath because an active runtime file is locked."
    }

    [IO.Directory]::CreateDirectory($activePath) | Out-Null
    $nonce = [guid]::NewGuid().ToString('N')
    $stagedMain = Join-Path $activePath ('.kiki-desktop.exe.{0}.tmp' -f $nonce)
    $stagedSidecar = Join-Path $activePath ('.kiki-server.exe.{0}.tmp' -f $nonce)
    $stagedBuildInfo = Join-Path $activePath ('.build-info.txt.{0}.tmp' -f $nonce)
    $mainBackup = Join-Path $activePath ('.kiki-desktop.exe.{0}.bak' -f $nonce)
    $sidecarBackup = Join-Path $activePath ('.kiki-server.exe.{0}.bak' -f $nonce)
    $buildInfoBackup = Join-Path $activePath ('.build-info.txt.{0}.bak' -f $nonce)
    $hadExistingMain = Test-Path -LiteralPath $activeMain -PathType Leaf
    $hadExistingSidecar = Test-Path -LiteralPath $activeSidecar -PathType Leaf
    $hadExistingBuildInfo = Test-Path -LiteralPath $activeBuildInfo -PathType Leaf
    $mainReplaced = $false
    $sidecarReplaced = $false
    $buildInfoReplaced = $false
    $restoreFailed = $false

    try {
        Copy-Item -LiteralPath $releaseMain -Destination $stagedMain -Force
        Copy-Item -LiteralPath $releaseSidecar -Destination $stagedSidecar -Force
        if (Test-Path -LiteralPath $releaseBuildInfo -PathType Leaf) {
            Copy-Item -LiteralPath $releaseBuildInfo -Destination $stagedBuildInfo -Force
        }
        else {
            Write-BuildInfo $stagedBuildInfo $GitSha
        }

        Assert-ArtifactMatches $DesktopInfo $stagedMain 'Active Kiki GUI'
        Assert-ArtifactMatches $SidecarInfo $stagedSidecar 'Active Kiki backend'

        try {
            if ($hadExistingMain) { [IO.File]::Replace($stagedMain, $activeMain, $mainBackup) }
            else { [IO.File]::Move($stagedMain, $activeMain) }
            $mainReplaced = $true

            if ($hadExistingSidecar) { [IO.File]::Replace($stagedSidecar, $activeSidecar, $sidecarBackup) }
            else { [IO.File]::Move($stagedSidecar, $activeSidecar) }
            $sidecarReplaced = $true

            if ($hadExistingBuildInfo) { [IO.File]::Replace($stagedBuildInfo, $activeBuildInfo, $buildInfoBackup) }
            else { [IO.File]::Move($stagedBuildInfo, $activeBuildInfo) }
            $buildInfoReplaced = $true

            $activeManifest = [ordered]@{
                schemaVersion = 1
                releaseId = $ReleaseId
                gitSha = $GitSha
                syncedAtUtc = [DateTime]::UtcNow.ToString('o')
                files = [ordered]@{
                    'kiki-desktop.exe' = [ordered]@{ sha256 = $DesktopInfo.Hash; bytes = $DesktopInfo.Length }
                    'kiki-server.exe' = [ordered]@{ sha256 = $SidecarInfo.Hash; bytes = $SidecarInfo.Length }
                }
            }
            Write-AtomicUtf8Json $activeManifestPath $activeManifest
        }
        catch {
            $syncFailure = $_
            foreach ($rollbackItem in @(
                @{ Replaced = $buildInfoReplaced; Had = $hadExistingBuildInfo; Dest = $activeBuildInfo; Backup = $buildInfoBackup },
                @{ Replaced = $sidecarReplaced; Had = $hadExistingSidecar; Dest = $activeSidecar; Backup = $sidecarBackup },
                @{ Replaced = $mainReplaced; Had = $hadExistingMain; Dest = $activeMain; Backup = $mainBackup }
            )) {
                if (-not $rollbackItem.Replaced) { continue }
                try {
                    if ($rollbackItem.Had -and (Test-Path -LiteralPath $rollbackItem.Backup -PathType Leaf)) {
                        # PowerShell 5.1 coerces $null to "" for string overloads; use [NullString]::Value so File.Replace accepts null destinationBackupFileName.
                        [IO.File]::Replace($rollbackItem.Backup, $rollbackItem.Dest, [NullString]::Value)
                    }
                    elseif (-not $rollbackItem.Had -and (Test-Path -LiteralPath $rollbackItem.Dest -PathType Leaf)) {
                        Remove-Item -LiteralPath $rollbackItem.Dest -Force -ErrorAction Stop
                    }
                }
                catch {
                    $restoreFailed = $true
                    Write-Warning ("Failed to restore active file {0} from backup {1}: {2}" -f $rollbackItem.Dest, $rollbackItem.Backup, $_.Exception.Message)
                }
            }
            throw $syncFailure
        }
    }
    finally {
        foreach ($tempFile in @($stagedMain, $stagedSidecar, $stagedBuildInfo)) {
            if (Test-Path -LiteralPath $tempFile) {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not $restoreFailed) {
            foreach ($backupFile in @($mainBackup, $sidecarBackup, $buildInfoBackup)) {
                if (Test-Path -LiteralPath $backupFile) {
                    Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }

    return [pscustomobject]@{
        Synced = $true
        AlreadyCurrent = $false
        Locked = $false
        ActivePath = $activePath
        ReleaseId = $ReleaseId
        LockingPids = @()
    }
}

function Open-ActiveLock([string]$RootPath, [int]$WaitSeconds = 15) {
    [IO.Directory]::CreateDirectory($RootPath) | Out-Null
    $activeLockPath = Join-Path $RootPath 'active.lock'
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    do {
        try {
            return [IO.File]::Open($activeLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        }
        catch {
            if ([DateTime]::UtcNow -ge $deadline) {
                return $null
            }
            Start-Sleep -Milliseconds 100
        }
    } while ($true)
}

function Sync-ActiveRelease(
    [string]$Root,
    [string]$ReleaseId,
    [string]$GitSha = '',
    [object]$ExpectedDesktop = $null,
    [object]$ExpectedSidecar = $null,
    [switch]$SkipIfLocked
) {
    $rootPath = Get-FullPath $Root
    $activePath = Get-ActivePath $rootPath
    $releasePath = Get-ReleasePath $rootPath $ReleaseId
    $releaseMain = Join-Path $releasePath 'kiki-desktop.exe'
    $releaseSidecar = Join-Path $releasePath 'kiki-server.exe'
    $releaseBuildInfo = Join-Path $releasePath 'build-info.txt'

    $desktopInfo = if ($null -ne $ExpectedDesktop) { $ExpectedDesktop } else { Get-ArtifactInfo $releaseMain 'Release Kiki GUI' }
    $sidecarInfo = if ($null -ne $ExpectedSidecar) { $ExpectedSidecar } else { Get-ArtifactInfo $releaseSidecar 'Release Kiki backend' }
    if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $sidecarInfo.Hash.Substring(0, 24)) -cne $ReleaseId) {
        throw "Release binaries at $releasePath do not match releaseId $ReleaseId; active runtime was not modified."
    }

    $resolvedGitSha = $GitSha
    if ([string]::IsNullOrWhiteSpace($resolvedGitSha)) {
        $currentManifest = Read-CurrentManifest $rootPath -AllowMissing
        if ($null -ne $currentManifest -and ([string]$currentManifest.releaseId) -ceq $ReleaseId -and -not [string]::IsNullOrWhiteSpace([string](Get-ObjectProperty $currentManifest 'gitSha'))) {
            $resolvedGitSha = [string]$currentManifest.gitSha
        }
        elseif (Test-Path -LiteralPath $releaseBuildInfo -PathType Leaf) {
            $rawInfo = ([IO.File]::ReadAllText($releaseBuildInfo)).Trim()
            if ($rawInfo -match '^gitSha:\s*(\S+)') { $resolvedGitSha = $Matches[1] }
        }
        if ([string]::IsNullOrWhiteSpace($resolvedGitSha)) { $resolvedGitSha = 'unknown' }
    }

    if (Test-Path -LiteralPath $activePath) {
        if ((Test-IsReparsePoint $activePath) -or (-not (Test-Path -LiteralPath $activePath -PathType Container))) {
            throw "Active runtime path must be a regular directory (not a symlink or junction): $activePath"
        }
    }

    $activeLock = Open-ActiveLock $rootPath ($(if ($SkipIfLocked) { 2 } else { 15 }))
    if ($null -eq $activeLock) {
        if ($SkipIfLocked) {
            return [pscustomobject]@{
                Synced = $false
                AlreadyCurrent = $false
                Locked = $true
                ActivePath = $activePath
                ReleaseId = $ReleaseId
                LockingPids = @()
            }
        }
        throw "Cannot acquire active publication lock under $rootPath."
    }
    try {
        return Sync-ActiveReleaseCore $rootPath $ReleaseId $resolvedGitSha $desktopInfo $sidecarInfo -SkipIfLocked:$SkipIfLocked
    }
    finally {
        $activeLock.Dispose()
    }
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

function Read-PromotionCandidate([string]$Candidate, [string]$ExpectedCommit) {
    Assert-FullCommit $ExpectedCommit
    $path = Get-FullPath $Candidate
    $receipt = Read-BuildReceipt $path
    $gitSha = Assert-ReceiptIdentity $receipt $ExpectedCommit
    $desktop = Get-ArtifactInfo (Join-Path $path 'kiki-desktop.exe') 'Kiki GUI build artifact'
    $sidecar = Get-ArtifactInfo (Join-Path $path 'kiki-server.exe') 'Kiki backend build artifact'
    Assert-ReceiptFiles $receipt $desktop $sidecar
    return [pscustomobject]@{
        Path = $path; GitSha = $gitSha; Desktop = $desktop; Sidecar = $sidecar
        ReleaseId = '{0}-{1}' -f $desktop.Hash.Substring(0, 24), $sidecar.Hash.Substring(0, 24)
    }
}

function Invoke-Promotion([string]$Root, [object]$Verified) {
    $rootPath = Get-FullPath $Root
    $mainSource = $Verified.Desktop
    $sidecarSource = $Verified.Sidecar
    $gitSha = $Verified.GitSha
    $releaseId = $Verified.ReleaseId
    [IO.Directory]::CreateDirectory($rootPath) | Out-Null
    $releasesPath = Join-Path $rootPath 'releases'
    [IO.Directory]::CreateDirectory($releasesPath) | Out-Null
    $releasePath = Get-ReleasePath $rootPath $releaseId
    $mainDestination = Join-Path $releasePath 'kiki-desktop.exe'
    $sidecarDestination = Join-Path $releasePath 'kiki-server.exe'

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

            Write-BuildInfo (Join-Path $stagingPath 'build-info.txt') $gitSha
            [IO.Directory]::Move($stagingPath, $releasePath)
        }
        finally {
            if (Test-Path -LiteralPath $stagingPath) {
                Remove-Item -LiteralPath $stagingPath -Recurse -Force
            }
        }
    }

    Publish-CliExecutable $rootPath $sidecarDestination $sidecarSource

    $current = Read-CurrentManifest $rootPath -AllowMissing
    if ($null -ne $current -and $current.releaseId -eq $releaseId) {
        $syncResult = Sync-ActiveRelease $rootPath $releaseId $gitSha $mainSource $sidecarSource -SkipIfLocked
        Write-SourceDiagnostic $Verified.Path $gitSha
        if ($syncResult.Locked) {
            Write-Output "Active runtime is in use; current.json is staged for the next switch/relaunch: $($syncResult.ActivePath)"
        }
        elseif (-not $syncResult.AlreadyCurrent) {
            Write-Output "Synced active runtime: $($syncResult.ActivePath)"
        }
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
    $syncResult = Sync-ActiveRelease $rootPath $releaseId $gitSha $mainSource $sidecarSource -SkipIfLocked
    Write-SourceDiagnostic $Verified.Path $gitSha
    if ($syncResult.Locked) {
        Write-Output "Active runtime is in use; current.json is staged for the next switch/relaunch: $($syncResult.ActivePath)"
    }
    else {
        Write-Output "Synced active runtime: $($syncResult.ActivePath)"
    }
    Write-Output "Promoted Kiki release: $releasePath"
}

function Write-BuildInfo([string]$Path, [string]$GitSha) {
    $text = 'gitSha: {0}' -f $GitSha
    [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding($false)))
}

function Publish-CliExecutable([string]$Root, [string]$SourcePath, [object]$Sidecar) {
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
    Copy-Item -LiteralPath $SourcePath -Destination $cliPath -Force
    Assert-ArtifactMatches $Sidecar $cliPath 'Published Kiki CLI'
    Write-Output "Published Kiki CLI: $cliPath"
    Write-Output "Add '$cliDirectory' to PATH to run 'kiki' from any terminal (the Kiki installer does this automatically)."
}

function Resolve-LaunchTarget([string]$Root) {
    $rootPath = Get-FullPath $Root
    $manifest = Read-CurrentManifest $rootPath
    $releaseId = [string]$manifest.releaseId
    $releasePath = Get-ReleasePath $rootPath $releaseId
    $releaseMainPath = Join-Path $releasePath 'kiki-desktop.exe'
    $releaseSidecarPath = Join-Path $releasePath 'kiki-server.exe'
    foreach ($path in @($releaseMainPath, $releaseSidecarPath)) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) {
            throw "The selected Kiki executable is missing or empty: $path"
        }
    }
    $usingActive = Test-ActiveReleaseAligned $rootPath $releaseId
    if ($usingActive) {
        $activePath = Get-ActivePath $rootPath
        $launchDirectory = $activePath
        $mainPath = Join-Path $activePath 'kiki-desktop.exe'
        $sidecarPath = Join-Path $activePath 'kiki-server.exe'
    }
    else {
        $launchDirectory = $releasePath
        $mainPath = $releaseMainPath
        $sidecarPath = $releaseSidecarPath
    }
    return [pscustomobject]@{
        Root = $rootPath
        ReleasePath = $releasePath
        LaunchDirectory = $launchDirectory
        MainPath = $mainPath
        SidecarPath = $sidecarPath
        ReleaseId = $releaseId
        UsingActive = $usingActive
    }
}

function Format-WindowsProcessArgument([string]$Value) {
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append('"')
    $backslashes = 0
    for ($i = 0; $i -lt $Value.Length; $i++) {
        $ch = $Value[$i]
        if ($ch -eq '\') {
            $backslashes++
        } elseif ($ch -eq '"') {
            $null = $sb.Append('\', $backslashes * 2 + 1)
            $null = $sb.Append('"')
            $backslashes = 0
        } else {
            if ($backslashes -gt 0) {
                $null = $sb.Append('\', $backslashes)
                $backslashes = 0
            }
            $null = $sb.Append($ch)
        }
    }
    if ($backslashes -gt 0) {
        $null = $sb.Append('\', $backslashes * 2)
    }
    $null = $sb.Append('"')
    return $sb.ToString()
}

function Invoke-Launch([string]$Root, [string]$LaunchHome, [switch]$PassThru, [switch]$Background, [switch]$PassHomeArg) {
    $rootPath = Get-FullPath $Root
    $manifest = Read-CurrentManifest $rootPath
    $releaseId = [string]$manifest.releaseId
    $launchLock = Open-ActiveLock $rootPath 15
    $previousHome = $env:KIKI_HOME
    $previousNoRedirect = $env:KIKI_NO_RELEASE_REDIRECT
    try {
        if ($null -ne $launchLock -and (-not (Test-ActiveReleaseAligned $rootPath $releaseId))) {
            $releasePath = Get-ReleasePath $rootPath $releaseId
            $desktopInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-desktop.exe') 'Release Kiki GUI'
            $sidecarInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-server.exe') 'Release Kiki backend'
            if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $sidecarInfo.Hash.Substring(0, 24)) -cne $releaseId) {
                throw "Release binaries at $releasePath do not match releaseId $releaseId; launch aborted."
            }
            $gitSha = [string](Get-ObjectProperty $manifest 'gitSha')
            if ([string]::IsNullOrWhiteSpace($gitSha)) { $gitSha = 'unknown' }
            $syncResult = Sync-ActiveReleaseCore $rootPath $releaseId $gitSha $desktopInfo $sidecarInfo -SkipIfLocked
            if ($syncResult.Locked) {
                Write-Warning ("Active runtime at {0} is locked by running process(es); launching release {1} from releases directory without modifying active." -f $syncResult.ActivePath, $releaseId)
            }
        }
        $target = Resolve-LaunchTarget $rootPath
        if ($LaunchHome) { $env:KIKI_HOME = $LaunchHome }
        elseif ((Split-Path -Leaf $target.Root) -eq 'Kiki-Dev') { $env:KIKI_HOME = $target.Root }
        if ($null -ne $previousNoRedirect) {
            Remove-Item Env:KIKI_NO_RELEASE_REDIRECT -ErrorAction SilentlyContinue
        }
        $startParams = @{
            FilePath = $target.MainPath
            WorkingDirectory = $target.LaunchDirectory
            PassThru = [bool]$PassThru
        }
        $argList = New-Object System.Collections.Generic.List[string]
        if ($PassHomeArg -and -not [string]::IsNullOrWhiteSpace($LaunchHome)) {
            $argList.Add('--home')
            $argList.Add((Format-WindowsProcessArgument $LaunchHome))
        }
        if ($Background) {
            $argList.Add('--background')
        }
        if ($argList.Count -gt 0) {
            $startParams['ArgumentList'] = ($argList.ToArray() -join ' ')
        }
        Start-Process @startParams
    }
    finally {
        $env:KIKI_HOME = $previousHome
        if ($null -eq $previousNoRedirect) {
            Remove-Item Env:KIKI_NO_RELEASE_REDIRECT -ErrorAction SilentlyContinue
        }
        else {
            $env:KIKI_NO_RELEASE_REDIRECT = $previousNoRedirect
        }
        if ($null -ne $launchLock) { $launchLock.Dispose() }
    }
}

function Invoke-HeadlessLaunch(
    [string]$Root,
    [string]$LaunchHome,
    [string]$LaunchArguments = 'serve',
    [switch]$PassThru,
    [switch]$RuntimeManaged
) {
    $rootPath = Get-FullPath $Root
    $manifest = Read-CurrentManifest $rootPath
    $releaseId = [string]$manifest.releaseId
    $launchLock = Open-ActiveLock $rootPath 15
    $previousHome = $env:KIKI_HOME
    $previousNoRedirect = $env:KIKI_NO_RELEASE_REDIRECT
    $previousDesktopBundled = $env:KIKI_DESKTOP_BUNDLED
    $previousRuntimeManaged = $env:KIKI_RUNTIME_MANAGED
    try {
        if ($null -ne $launchLock -and (-not (Test-ActiveReleaseAligned $rootPath $releaseId))) {
            $releasePath = Get-ReleasePath $rootPath $releaseId
            $desktopInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-desktop.exe') 'Release Kiki GUI'
            $sidecarInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-server.exe') 'Release Kiki backend'
            if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $sidecarInfo.Hash.Substring(0, 24)) -cne $releaseId) {
                throw "Release binaries at $releasePath do not match releaseId $releaseId; headless launch aborted."
            }
            $gitSha = [string](Get-ObjectProperty $manifest 'gitSha')
            if ([string]::IsNullOrWhiteSpace($gitSha)) { $gitSha = 'unknown' }
            $syncResult = Sync-ActiveReleaseCore $rootPath $releaseId $gitSha $desktopInfo $sidecarInfo -SkipIfLocked
            if ($syncResult.Locked) {
                Write-Warning ("Active runtime at {0} is locked by running process(es); launching headless server {1} from releases directory without modifying active." -f $syncResult.ActivePath, $releaseId)
            }
        }
        $target = Resolve-LaunchTarget $rootPath
        if (-not [string]::IsNullOrWhiteSpace($LaunchHome)) {
            $env:KIKI_HOME = $LaunchHome
        }
        Remove-Item Env:KIKI_NO_RELEASE_REDIRECT -ErrorAction SilentlyContinue
        Remove-Item Env:KIKI_DESKTOP_BUNDLED -ErrorAction SilentlyContinue
        if ($RuntimeManaged) {
            $env:KIKI_RUNTIME_MANAGED = '1'
        }
        else {
            Remove-Item Env:KIKI_RUNTIME_MANAGED -ErrorAction SilentlyContinue
        }
        $effectiveArgs = if ([string]::IsNullOrWhiteSpace($LaunchArguments)) { 'serve' } else { $LaunchArguments.Trim() }
        $startParams = @{
            FilePath = $target.SidecarPath
            WorkingDirectory = $target.LaunchDirectory
            ArgumentList = $effectiveArgs
            WindowStyle = 'Hidden'
            PassThru = [bool]$PassThru
        }
        Start-Process @startParams
    }
    finally {
        $env:KIKI_HOME = $previousHome
        if ($null -eq $previousNoRedirect) {
            Remove-Item Env:KIKI_NO_RELEASE_REDIRECT -ErrorAction SilentlyContinue
        }
        else {
            $env:KIKI_NO_RELEASE_REDIRECT = $previousNoRedirect
        }
        if ($null -eq $previousDesktopBundled) {
            Remove-Item Env:KIKI_DESKTOP_BUNDLED -ErrorAction SilentlyContinue
        }
        else {
            $env:KIKI_DESKTOP_BUNDLED = $previousDesktopBundled
        }
        if ($null -eq $previousRuntimeManaged) {
            Remove-Item Env:KIKI_RUNTIME_MANAGED -ErrorAction SilentlyContinue
        }
        else {
            $env:KIKI_RUNTIME_MANAGED = $previousRuntimeManaged
        }
        if ($null -ne $launchLock) { $launchLock.Dispose() }
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

function Get-ShortcutProfile([string]$Root) {
    # Same runtime-name convention as Invoke-Launch: only a Kiki-Dev root is the
    # development runtime. Anything else (the EasyAgent\Kiki runtime) is the
    # normal one, so its desktop entry keeps the plain Kiki GUI name.
    if ((Split-Path -Leaf $Root) -eq 'Kiki-Dev') {
        return [pscustomobject]@{
            LaunchFile = 'Kiki GUI (Dev).lnk'
            PromoteFile = 'Promote Kiki GUI (Dev).lnk'
            LaunchDescription = 'Launch the current promoted Kiki development build'
            PromoteDescription = 'Promote the last successful Kiki development build'
            Output = 'Installed Kiki development shortcuts in: {0}'
        }
    }
    return [pscustomobject]@{
        LaunchFile = 'Kiki GUI.lnk'
        PromoteFile = 'Promote Kiki GUI.lnk'
        LaunchDescription = 'Launch the current promoted Kiki build'
        PromoteDescription = 'Promote the last successful Kiki build'
        Output = 'Installed Kiki shortcuts in: {0}'
    }
}

function Install-KikiShortcuts([string]$Root, [string]$Candidate, [string]$Desktop, [string]$ExpectedCommit) {
    Assert-FullCommit $ExpectedCommit
    $rootPath = Get-FullPath $Root
    $candidatePath = Get-FullPath $Candidate
    $desktopFullPath = Get-FullPath $Desktop
    $controllerDirectory = Join-Path $rootPath 'controller'
    $installedController = Join-Path $controllerDirectory 'desktop-release.ps1'
    $sourceHotSwitch = Join-Path $PSScriptRoot 'desktop-hot-switch.ps1'
    $installedHotSwitch = Join-Path $controllerDirectory 'desktop-hot-switch.ps1'
    $sourceConductor = Join-Path $PSScriptRoot 'kiki-ops-conductor.mjs'
    $installedConductor = Join-Path $controllerDirectory 'kiki-ops-conductor.mjs'
    $sourceReceiptContract = Join-Path $PSScriptRoot 'desktop-receipt-contract.mjs'
    $installedReceiptContract = Join-Path $controllerDirectory 'desktop-receipt-contract.mjs'
    [IO.Directory]::CreateDirectory($controllerDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($desktopFullPath) | Out-Null

    if ((Get-FullPath $PSCommandPath) -ne (Get-FullPath $installedController)) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $installedController -Force
    }
    if ((Test-Path -LiteralPath $sourceHotSwitch -PathType Leaf) -and ((Get-FullPath $sourceHotSwitch) -ne (Get-FullPath $installedHotSwitch))) {
        Copy-Item -LiteralPath $sourceHotSwitch -Destination $installedHotSwitch -Force
    }
    if ((Test-Path -LiteralPath $sourceConductor -PathType Leaf) -and ((Get-FullPath $sourceConductor) -ne (Get-FullPath $installedConductor))) {
        Copy-Item -LiteralPath $sourceConductor -Destination $installedConductor -Force
    }
    if ((Test-Path -LiteralPath $sourceReceiptContract -PathType Leaf) -and ((Get-FullPath $sourceReceiptContract) -ne (Get-FullPath $installedReceiptContract))) {
        Copy-Item -LiteralPath $sourceReceiptContract -Destination $installedReceiptContract -Force
    }
    Write-AtomicUtf8Json (Join-Path $controllerDirectory 'settings.json') ([ordered]@{
        schemaVersion = 1
        candidateRoot = $candidatePath
        expectedCommit = $ExpectedCommit
    })

    Assert-SafeShortcutPath $rootPath 'Runtime root'
    Assert-SafeShortcutPath $installedController 'Installed controller path'
    Assert-SafeShortcutPath $ExpectedCommit 'Expected commit'
    $profile = Get-ShortcutProfile $rootPath
    $powerShellPath = Join-Path $PSHOME 'powershell.exe'
    $shell = New-Object -ComObject WScript.Shell
    $common = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $installedController
    $launchArguments = '-WindowStyle Hidden {0} -Action Launch -RuntimeRoot "{1}"' -f $common, $rootPath
    $promoteArguments = '{0} -Action Promote -RuntimeRoot "{1}" -ExpectedCommit "{2}" -WaitForUser' -f $common, $rootPath, $ExpectedCommit
    New-KikiShortcut $shell (Join-Path $desktopFullPath $profile.LaunchFile) $powerShellPath $launchArguments $controllerDirectory $profile.LaunchDescription
    New-KikiShortcut $shell (Join-Path $desktopFullPath $profile.PromoteFile) $powerShellPath $promoteArguments $controllerDirectory $profile.PromoteDescription
    Write-Output ($profile.Output -f $desktopFullPath)
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
                $verified = Read-PromotionCandidate (Resolve-CandidateRoot) $ExpectedCommit
                Invoke-Promotion $RuntimeRoot $verified
                if ($WaitForUser) { Read-Host 'Promotion succeeded. Press Enter to close' | Out-Null }
            }
            'Launch' {
                Invoke-Launch $RuntimeRoot -Background:$Background
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
            [Console]::Error.WriteLine("Kiki desktop release failed: $message")
        }
        if ($WaitForUser) { Read-Host 'Press Enter to close' | Out-Null }
        exit 1
    }
}
