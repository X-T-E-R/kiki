[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Promote', 'Launch', 'InstallShortcuts', 'EnsureAutostart', 'DisableAutostart')]
    [string]$Action,

    [string]$RuntimeRoot,
    [string]$CandidateRoot,
    [string]$ExpectedCommit,
    [string]$DesktopPath,
    [string]$KikiHome,
    [string]$AutostartRegistryPath,
    [switch]$Background,
    [switch]$TrayOnly,
    [switch]$Autostart,
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

function Test-ManifestIdentity([object]$Manifest) {
    if ($null -eq $Manifest) { return $false }
    $schemaVersion = Get-ObjectProperty $Manifest 'schemaVersion'
    $releaseId = [string](Get-ObjectProperty $Manifest 'releaseId')
    if ($releaseId -notmatch '^[0-9a-f]{24}-[0-9a-f]{24}$') { return $false }
    if ($schemaVersion -eq 1) { return $true }
    if ($schemaVersion -eq 2) {
        $runtimeKind = [string](Get-ObjectProperty $Manifest 'runtimeKind')
        return ($runtimeKind -ceq 'electron-single-binary')
    }
    return $false
}

function Get-ManifestSchemaVersion([object]$Manifest) {
    if ($null -eq $Manifest) { return 1 }
    $schemaVersion = Get-ObjectProperty $Manifest 'schemaVersion'
    if ($schemaVersion -eq 2) { return 2 }
    return 1
}

function Assert-SafeRelativeReleasePath([string]$RelativePath, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        throw "$Label cannot be empty."
    }
    $normalized = $RelativePath.Trim().Replace('/', '\')
    if ([IO.Path]::IsPathRooted($normalized) -or $normalized.StartsWith('\') -or $normalized -match '^[a-zA-Z]:') {
        throw "$Label must be a relative path inside the release directory: $RelativePath"
    }
    foreach ($segment in $normalized.Split('\')) {
        if ([string]::IsNullOrEmpty($segment) -or $segment -eq '.' -or $segment -eq '..') {
            throw "$Label contains an invalid path segment: $RelativePath"
        }
    }
    return $normalized
}

function Resolve-V2Layout([string]$DirectoryPath = '', [object]$ManifestOrReceipt = $null) {
    $unpackedEntryRel = 'resources\app.asar.unpacked\dist\server\server-entry.mjs'
    $unpackedAddonsRel = 'resources\app.asar.unpacked\dist\server\native-addons.json'
    $unpackedAsarRel = 'resources\app.asar'

    $explicitEntry = [string](Get-ObjectProperty $ManifestOrReceipt 'serverEntry')
    $explicitAddons = [string](Get-ObjectProperty $ManifestOrReceipt 'nativeAddons')
    if (-not [string]::IsNullOrWhiteSpace($explicitEntry)) {
        $serverEntryRel = Assert-SafeRelativeReleasePath $explicitEntry 'V2 serverEntry'
        $parentRel = Split-Path -Parent $serverEntryRel
        $defaultAddonsRel = if ([string]::IsNullOrWhiteSpace($parentRel)) { 'native-addons.json' } else { Join-Path $parentRel 'native-addons.json' }
        $nativeAddonsRel = if (-not [string]::IsNullOrWhiteSpace($explicitAddons)) {
            Assert-SafeRelativeReleasePath $explicitAddons 'V2 nativeAddons'
        }
        else {
            $defaultAddonsRel
        }
        $isUnpacked = $serverEntryRel.StartsWith('resources\app.asar.unpacked\', [StringComparison]::OrdinalIgnoreCase)
        $appAsarRel = if ($isUnpacked) { $unpackedAsarRel } else { $null }
        return [pscustomobject]@{
            IsUnpacked = $isUnpacked
            ServerEntryRel = $serverEntryRel
            NativeAddonsRel = $nativeAddonsRel
            AppAsarRel = $appAsarRel
            ServerEntryPosix = $serverEntryRel.Replace('\', '/')
            NativeAddonsPosix = $nativeAddonsRel.Replace('\', '/')
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($DirectoryPath)) {
        if ((Test-Path -LiteralPath (Join-Path $DirectoryPath $unpackedEntryRel) -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $DirectoryPath $unpackedAddonsRel) -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $DirectoryPath $unpackedAsarRel) -PathType Leaf)) {
            return [pscustomobject]@{
                IsUnpacked = $true
                ServerEntryRel = $unpackedEntryRel
                NativeAddonsRel = $unpackedAddonsRel
                AppAsarRel = $unpackedAsarRel
                ServerEntryPosix = $unpackedEntryRel.Replace('\', '/')
                NativeAddonsPosix = $unpackedAddonsRel.Replace('\', '/')
            }
        }
        if ((Test-Path -LiteralPath (Join-Path $DirectoryPath 'server-entry.mjs') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $DirectoryPath 'native-addons.json') -PathType Leaf)) {
            return [pscustomobject]@{
                IsUnpacked = $false
                ServerEntryRel = 'server-entry.mjs'
                NativeAddonsRel = 'native-addons.json'
                AppAsarRel = $null
                ServerEntryPosix = 'server-entry.mjs'
                NativeAddonsPosix = 'native-addons.json'
            }
        }
    }
    return $null
}

function Get-DirectoryReleaseSchemaVersion([string]$DirectoryPath) {
    $serverExe = Join-Path $DirectoryPath 'kiki-server.exe'
    if ((-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) -and ($null -ne (Resolve-V2Layout $DirectoryPath))) {
        return 2
    }
    return 1
}

function Get-ReleaseRequiredFileNames([int]$SchemaVersion, [string]$DirectoryPath = '', [object]$Manifest = $null) {
    if ($SchemaVersion -eq 2) {
        $v2 = Resolve-V2Layout $DirectoryPath $Manifest
        if ($null -ne $v2 -and $v2.IsUnpacked) {
            return @('kiki-desktop.exe', $v2.AppAsarRel, $v2.ServerEntryRel, $v2.NativeAddonsRel)
        }
        if ($null -ne $v2) {
            return @('kiki-desktop.exe', $v2.ServerEntryRel, $v2.NativeAddonsRel)
        }
        return @('kiki-desktop.exe', 'server-entry.mjs', 'native-addons.json')
    }
    return @('kiki-desktop.exe', 'kiki-server.exe')
}

function Get-ReleaseStaleFileNames([int]$SchemaVersion) {
    if ($SchemaVersion -eq 2) {
        return @('kiki-server.exe')
    }
    return @('server-entry.mjs', 'native-addons.json', 'resources', 'locales', 'swiftshader', 'icudtl.dat', 'v8_context_snapshot.bin', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak')
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
    if (-not (Test-ManifestIdentity $manifest)) {
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
    if (-not (Test-ManifestIdentity $manifest)) {
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
    $activeManifest = Read-ActiveManifest $Root -AllowMissing
    $schema = if ($null -ne $activeManifest) { Get-ManifestSchemaVersion $activeManifest } else { Get-DirectoryReleaseSchemaVersion $activeDir }
    if ($schema -eq 2 -and (Test-Path -LiteralPath $desktopPath -PathType Leaf)) {
        $v2 = Resolve-V2Layout $activeDir $activeManifest
        if ($null -ne $v2) {
            $serverEntryPath = Join-Path $activeDir $v2.ServerEntryRel
            $nativeAddonsPath = Join-Path $activeDir $v2.NativeAddonsRel
            if ((Test-Path -LiteralPath $serverEntryPath -PathType Leaf) -and (Test-Path -LiteralPath $nativeAddonsPath -PathType Leaf)) {
                try {
                    $desktop = Get-ArtifactInfo $desktopPath 'Active Kiki GUI'
                    $serverEntry = Get-ArtifactInfo $serverEntryPath 'Active Kiki server entry'
                    return '{0}-{1}' -f $desktop.Hash.Substring(0, 24), $serverEntry.Hash.Substring(0, 24)
                }
                catch {
                }
            }
        }
    }
    if ((Test-Path -LiteralPath $desktopPath -PathType Leaf) -and (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        try {
            $desktop = Get-ArtifactInfo $desktopPath 'Active Kiki GUI'
            $server = Get-ArtifactInfo $serverPath 'Active Kiki backend'
            return '{0}-{1}' -f $desktop.Hash.Substring(0, 24), $server.Hash.Substring(0, 24)
        }
        catch {
        }
    }
    if ($null -ne $activeManifest) {
        return [string]$activeManifest.releaseId
    }
    return $null
}

function Test-IsTransientSyncEntryName([string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    return ($Name.StartsWith('.stage-') -or $Name.StartsWith('.backup-') -or $Name.StartsWith('.stale-') -or ($Name -match '^\..*\.(tmp|bak)$'))
}

function Test-ActiveReleaseAligned([string]$Root, [string]$ReleaseId, [int]$ExpectedSchema = 0) {
    $activeDir = Get-ActivePath $Root
    if (-not (Test-Path -LiteralPath $activeDir -PathType Container)) { return $false }
    if (Test-IsReparsePoint $activeDir) { return $false }
    $activeManifest = Read-ActiveManifest $Root -AllowMissing
    if ($null -eq $activeManifest -or ([string]$activeManifest.releaseId) -cne $ReleaseId) { return $false }
    $activeSchema = Get-ManifestSchemaVersion $activeManifest
    if ($ExpectedSchema -gt 0 -and $activeSchema -ne $ExpectedSchema) { return $false }
    foreach ($name in (Get-ReleaseRequiredFileNames $activeSchema $activeDir $activeManifest)) {
        $filePath = Join-Path $activeDir $name
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { return $false }
        if (Test-IsReparsePoint $filePath) { return $false }
        if ((Get-Item -LiteralPath $filePath).Length -le 0) { return $false }
    }
    foreach ($staleName in (Get-ReleaseStaleFileNames $activeSchema)) {
        $stalePath = Join-Path $activeDir $staleName
        if (Test-Path -LiteralPath $stalePath) { return $false }
    }
    if ($activeSchema -eq 1) {
        $allowedV1 = @('kiki-desktop.exe', 'kiki-server.exe', 'build-info.txt', 'active-release.json')
        foreach ($entry in @(Get-ChildItem -LiteralPath $activeDir -Force -ErrorAction SilentlyContinue)) {
            if (Test-IsTransientSyncEntryName $entry.Name) { continue }
            if ($entry.PSIsContainer -or ($entry.Name -notin $allowedV1)) { return $false }
        }
    }
    else {
        $releaseDir = Get-ReleasePath $Root $ReleaseId
        if (Test-Path -LiteralPath $releaseDir -PathType Container) {
            foreach ($relEntry in @(Get-ChildItem -LiteralPath $releaseDir -Force -ErrorAction SilentlyContinue)) {
                if (Test-IsTransientSyncEntryName $relEntry.Name) { continue }
                $expectedInActive = Join-Path $activeDir $relEntry.Name
                if (-not (Test-Path -LiteralPath $expectedInActive)) { return $false }
            }
        }
    }
    return $true
}

function ConvertTo-LongLiteralPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\?\')) { return $full }
    if ($full.StartsWith('\\')) { return ('\\?\UNC\' + $full.Substring(2)) }
    return ('\\?\' + $full)
}

function Remove-DirectoryTreeSafe([string]$DirPath) {
    $longDir = ConvertTo-LongLiteralPath $DirPath
    if (-not [IO.Directory]::Exists($longDir)) { return }
    try {
        [IO.Directory]::Delete($longDir, $true)
    }
    catch {
        Remove-Item -LiteralPath $DirPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-FileExclusiveWritable([string]$Path) {
    $longPath = ConvertTo-LongLiteralPath $Path
    if (-not [IO.File]::Exists($longPath)) { return $true }
    try {
        $stream = [IO.File]::Open($longPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $stream.Dispose()
        return $true
    }
    catch {
        return $false
    }
}

function Copy-DirectoryTreeStrict([string]$SourceDir, [string]$DestinationDir, [string[]]$ExcludeRootNames = @()) {
    $longSrcDir = ConvertTo-LongLiteralPath $SourceDir
    $longDstDir = ConvertTo-LongLiteralPath $DestinationDir
    if (([IO.File]::GetAttributes($longSrcDir) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to copy reparse point directory: $SourceDir"
    }
    [IO.Directory]::CreateDirectory($longDstDir) | Out-Null
    $excludeSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($ex in @($ExcludeRootNames)) {
        if (-not [string]::IsNullOrWhiteSpace($ex)) { $null = $excludeSet.Add($ex) }
    }
    foreach ($subDir in @([IO.Directory]::GetDirectories($longSrcDir))) {
        $name = [IO.Path]::GetFileName($subDir)
        if ($excludeSet.Contains($name)) { continue }
        if ($name.StartsWith('.pending-') -or (Test-IsTransientSyncEntryName $name)) { continue }
        if (([IO.File]::GetAttributes($subDir) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to copy symlink or junction inside release payload: $subDir"
        }
        Copy-DirectoryTreeStrict $subDir ([IO.Path]::Combine($longDstDir, $name)) @()
    }
    foreach ($file in @([IO.Directory]::GetFiles($longSrcDir))) {
        $name = [IO.Path]::GetFileName($file)
        if ($excludeSet.Contains($name)) { continue }
        if ($name.StartsWith('.pending-') -or (Test-IsTransientSyncEntryName $name)) { continue }
        if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to copy symlink or junction inside release payload: $file"
        }
        [IO.File]::Copy($file, [IO.Path]::Combine($longDstDir, $name), $true)
    }
}

function Sync-ActiveReleaseCore(
    [string]$RootPath,
    [string]$ReleaseId,
    [string]$GitSha,
    [object]$DesktopInfo,
    [object]$SidecarInfo,
    [switch]$SkipIfLocked,
    [int]$SchemaVersion = 1,
    [object]$ServerEntryInfo = $null,
    [object]$NativeAddonsInfo = $null,
    [object]$V2Layout = $null
) {
    $activePath = Get-ActivePath $RootPath
    $releasePath = Get-ReleasePath $RootPath $ReleaseId
    $releaseBuildInfo = Join-Path $releasePath 'build-info.txt'
    $activeBuildInfo = Join-Path $activePath 'build-info.txt'
    $activeManifestPath = Join-Path $activePath 'active-release.json'

    $resolvedV2 = if ($SchemaVersion -eq 2) {
        if ($null -ne $V2Layout) { $V2Layout } else { Resolve-V2Layout $releasePath }
    }
    else {
        $null
    }
    if ($SchemaVersion -eq 2 -and $null -eq $resolvedV2) {
        throw "Release directory at $releasePath is missing v2 server-entry.mjs or native-addons.json."
    }

    $requiredSpecs = if ($SchemaVersion -eq 2) {
        @(
            @{ RelPath = 'kiki-desktop.exe'; ManifestKey = 'kiki-desktop.exe'; Label = 'Active Kiki GUI'; Expected = $DesktopInfo },
            @{ RelPath = $resolvedV2.ServerEntryRel; ManifestKey = 'server-entry.mjs'; Label = 'Active Kiki server entry'; Expected = $ServerEntryInfo },
            @{ RelPath = $resolvedV2.NativeAddonsRel; ManifestKey = 'native-addons.json'; Label = 'Active Kiki native addon manifest'; Expected = $NativeAddonsInfo }
        )
    }
    else {
        @(
            @{ RelPath = 'kiki-desktop.exe'; ManifestKey = 'kiki-desktop.exe'; Label = 'Active Kiki GUI'; Expected = $DesktopInfo },
            @{ RelPath = 'kiki-server.exe'; ManifestKey = 'kiki-server.exe'; Label = 'Active Kiki backend'; Expected = $SidecarInfo }
        )
    }

    if (Test-ActiveReleaseAligned $RootPath $ReleaseId $SchemaVersion) {
        $allMatched = (Test-Path -LiteralPath $activeBuildInfo -PathType Leaf)
        if ($allMatched) {
            foreach ($spec in $requiredSpecs) {
                $existing = Get-ArtifactInfo (Join-Path $activePath $spec.RelPath) $spec.Label
                if ($existing.Hash -cne $spec.Expected.Hash -or $existing.Length -ne $spec.Expected.Length) {
                    $allMatched = $false
                    break
                }
            }
        }
        if ($allMatched) {
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

    $lockCheckPaths = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $activePath -PathType Container) {
        $longActive = ConvertTo-LongLiteralPath $activePath
        foreach ($topEntry in @(Get-ChildItem -LiteralPath $activePath -Force -ErrorAction SilentlyContinue)) {
            if (Test-IsTransientSyncEntryName $topEntry.Name) { continue }
            if ($topEntry.PSIsContainer) {
                $longSub = [IO.Path]::Combine($longActive, $topEntry.Name)
                foreach ($subFile in @([IO.Directory]::EnumerateFiles($longSub, '*', [IO.SearchOption]::AllDirectories))) {
                    $lockCheckPaths.Add($subFile)
                }
            }
            else {
                $lockCheckPaths.Add($topEntry.FullName)
            }
        }
    }
    foreach ($spec in $requiredSpecs) { $lockCheckPaths.Add((Join-Path $activePath $spec.RelPath)) }
    $lockCheckPaths.Add($activeBuildInfo)
    $lockCheckPaths.Add($activeManifestPath)
    $checkedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($checkPath in $lockCheckPaths) {
        if (-not $checkedSet.Add($checkPath)) { continue }
        if (-not (Test-FileExclusiveWritable $checkPath)) {
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
    }

    [IO.Directory]::CreateDirectory($activePath) | Out-Null
    $nonce = [guid]::NewGuid().ToString('N')

    if ($SchemaVersion -eq 2) {
        $stageDir = Join-Path $activePath ('.stage-{0}' -f $nonce)
        $backupDir = Join-Path $activePath ('.backup-{0}' -f $nonce)
        $rollbackMoves = New-Object System.Collections.Generic.List[object]
        $restoreFailed = $false
        try {
            Copy-DirectoryTreeStrict $releasePath $stageDir @('active-release.json', 'desktop-build-receipt.json')
            $stagedBuildInfo = Join-Path $stageDir 'build-info.txt'
            if (-not (Test-Path -LiteralPath $stagedBuildInfo -PathType Leaf)) {
                Write-BuildInfo $stagedBuildInfo $GitSha
            }
            foreach ($spec in $requiredSpecs) {
                Assert-ArtifactMatches $spec.Expected (Join-Path $stageDir $spec.RelPath) $spec.Label
            }
            if ($resolvedV2.IsUnpacked) {
                $stagedAsar = Join-Path $stageDir $resolvedV2.AppAsarRel
                if (-not (Test-Path -LiteralPath $stagedAsar -PathType Leaf) -or (Get-Item -LiteralPath $stagedAsar).Length -le 0) {
                    throw "Active Kiki app.asar is missing or empty after staging: $stagedAsar"
                }
            }

            [IO.Directory]::CreateDirectory($backupDir) | Out-Null
            try {
                foreach ($existingEntry in @(Get-ChildItem -LiteralPath $activePath -Force)) {
                    if ($existingEntry.Name -ceq (Split-Path -Leaf $stageDir) -or
                        $existingEntry.Name -ceq (Split-Path -Leaf $backupDir) -or
                        $existingEntry.Name -ieq 'active-release.json') {
                        continue
                    }
                    $backupTarget = Join-Path $backupDir $existingEntry.Name
                    if ($existingEntry.PSIsContainer) {
                        [IO.Directory]::Move($existingEntry.FullName, $backupTarget)
                        $rollbackMoves.Add(@{ Kind = 'dir-backup'; Original = $existingEntry.FullName; Backup = $backupTarget })
                    }
                    else {
                        [IO.File]::Move($existingEntry.FullName, $backupTarget)
                        $rollbackMoves.Add(@{ Kind = 'file-backup'; Original = $existingEntry.FullName; Backup = $backupTarget })
                    }
                }
                foreach ($stagedEntry in @(Get-ChildItem -LiteralPath $stageDir -Force)) {
                    $destTarget = Join-Path $activePath $stagedEntry.Name
                    if ($stagedEntry.PSIsContainer) {
                        [IO.Directory]::Move($stagedEntry.FullName, $destTarget)
                        $rollbackMoves.Add(@{ Kind = 'dir-installed'; Dest = $destTarget })
                    }
                    else {
                        [IO.File]::Move($stagedEntry.FullName, $destTarget)
                        $rollbackMoves.Add(@{ Kind = 'file-installed'; Dest = $destTarget })
                    }
                }

                $filesMap = [ordered]@{}
                foreach ($spec in $requiredSpecs) {
                    $filesMap[$spec.ManifestKey] = [ordered]@{ sha256 = $spec.Expected.Hash; bytes = $spec.Expected.Length }
                }
                $activeManifest = [ordered]@{
                    schemaVersion = 2
                    runtimeKind = 'electron-single-binary'
                    releaseId = $ReleaseId
                    gitSha = $GitSha
                    syncedAtUtc = [DateTime]::UtcNow.ToString('o')
                }
                if ($resolvedV2.IsUnpacked) {
                    $activeManifest['serverEntry'] = $resolvedV2.ServerEntryPosix
                    $activeManifest['nativeAddons'] = $resolvedV2.NativeAddonsPosix
                }
                $activeManifest['files'] = $filesMap
                Write-AtomicUtf8Json $activeManifestPath $activeManifest
            }
            catch {
                $syncFailure = $_
                for ($idx = $rollbackMoves.Count - 1; $idx -ge 0; $idx--) {
                    $mv = $rollbackMoves[$idx]
                    try {
                        switch ($mv.Kind) {
                            'dir-installed' {
                                Remove-DirectoryTreeSafe $mv.Dest
                            }
                            'file-installed' {
                                if (Test-Path -LiteralPath $mv.Dest -PathType Leaf) {
                                    Remove-Item -LiteralPath $mv.Dest -Force -ErrorAction Stop
                                }
                            }
                            'dir-backup' {
                                if (Test-Path -LiteralPath $mv.Backup -PathType Container) {
                                    [IO.Directory]::Move($mv.Backup, $mv.Original)
                                }
                            }
                            'file-backup' {
                                if (Test-Path -LiteralPath $mv.Backup -PathType Leaf) {
                                    [IO.File]::Move($mv.Backup, $mv.Original)
                                }
                            }
                        }
                    }
                    catch {
                        $restoreFailed = $true
                        Write-Warning ("Failed to roll back active v2 entry: {0}" -f $_.Exception.Message)
                    }
                }
                throw $syncFailure
            }
        }
        finally {
            Remove-DirectoryTreeSafe $stageDir
            if (-not $restoreFailed) {
                Remove-DirectoryTreeSafe $backupDir
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

    $stagedFiles = New-Object System.Collections.Generic.List[string]
    $backupFiles = New-Object System.Collections.Generic.List[string]
    $staleBackupDir = Join-Path $activePath ('.stale-{0}' -f $nonce)
    $rollbackItems = New-Object System.Collections.Generic.List[object]
    $restoreFailed = $false

    try {
        $replacePlan = New-Object System.Collections.Generic.List[object]
        foreach ($spec in $requiredSpecs) {
            $srcPath = Join-Path $releasePath $spec.RelPath
            $destPath = Join-Path $activePath $spec.RelPath
            $stagedPath = Join-Path $activePath ('.{0}.{1}.tmp' -f $spec.ManifestKey, $nonce)
            $backupPath = Join-Path $activePath ('.{0}.{1}.bak' -f $spec.ManifestKey, $nonce)
            $stagedFiles.Add($stagedPath)
            $backupFiles.Add($backupPath)
            Copy-Item -LiteralPath $srcPath -Destination $stagedPath -Force
            Assert-ArtifactMatches $spec.Expected $stagedPath $spec.Label
            $replacePlan.Add([pscustomobject]@{
                Dest = $destPath
                Staged = $stagedPath
                Backup = $backupPath
                Had = (Test-Path -LiteralPath $destPath -PathType Leaf)
            })
        }
        $stagedBuildInfo = Join-Path $activePath ('.build-info.txt.{0}.tmp' -f $nonce)
        $buildInfoBackup = Join-Path $activePath ('.build-info.txt.{0}.bak' -f $nonce)
        $stagedFiles.Add($stagedBuildInfo)
        $backupFiles.Add($buildInfoBackup)
        if (Test-Path -LiteralPath $releaseBuildInfo -PathType Leaf) {
            Copy-Item -LiteralPath $releaseBuildInfo -Destination $stagedBuildInfo -Force
        }
        else {
            Write-BuildInfo $stagedBuildInfo $GitSha
        }
        $replacePlan.Add([pscustomobject]@{
            Dest = $activeBuildInfo
            Staged = $stagedBuildInfo
            Backup = $buildInfoBackup
            Had = (Test-Path -LiteralPath $activeBuildInfo -PathType Leaf)
        })

        try {
            foreach ($step in $replacePlan) {
                if ($step.Had) { [IO.File]::Replace($step.Staged, $step.Dest, $step.Backup) }
                else { [IO.File]::Move($step.Staged, $step.Dest) }
                $rollbackItems.Add(@{ Kind = 'replace'; Had = $step.Had; Dest = $step.Dest; Backup = $step.Backup })
            }
            $allowedV1Names = @('kiki-desktop.exe', 'kiki-server.exe', 'build-info.txt', 'active-release.json')
            foreach ($entry in @(Get-ChildItem -LiteralPath $activePath -Force -ErrorAction SilentlyContinue)) {
                if (($entry.Name -in $allowedV1Names) -or (Test-IsTransientSyncEntryName $entry.Name)) { continue }
                [IO.Directory]::CreateDirectory($staleBackupDir) | Out-Null
                $staleBackup = Join-Path $staleBackupDir $entry.Name
                if ($entry.PSIsContainer) {
                    [IO.Directory]::Move($entry.FullName, $staleBackup)
                    $rollbackItems.Add(@{ Kind = 'removed-dir'; Had = $true; Dest = $entry.FullName; Backup = $staleBackup })
                }
                else {
                    [IO.File]::Move($entry.FullName, $staleBackup)
                    $rollbackItems.Add(@{ Kind = 'removed'; Had = $true; Dest = $entry.FullName; Backup = $staleBackup })
                }
            }

            $filesMap = [ordered]@{}
            foreach ($spec in $requiredSpecs) {
                $filesMap[$spec.ManifestKey] = [ordered]@{ sha256 = $spec.Expected.Hash; bytes = $spec.Expected.Length }
            }
            $activeManifest = [ordered]@{
                schemaVersion = 1
                releaseId = $ReleaseId
                gitSha = $GitSha
                syncedAtUtc = [DateTime]::UtcNow.ToString('o')
                files = $filesMap
            }
            Write-AtomicUtf8Json $activeManifestPath $activeManifest
        }
        catch {
            $syncFailure = $_
            for ($idx = $rollbackItems.Count - 1; $idx -ge 0; $idx--) {
                $rollbackItem = $rollbackItems[$idx]
                try {
                    if ($rollbackItem.Kind -eq 'removed') {
                        if (Test-Path -LiteralPath $rollbackItem.Backup -PathType Leaf) {
                            [IO.File]::Move($rollbackItem.Backup, $rollbackItem.Dest)
                        }
                    }
                    elseif ($rollbackItem.Kind -eq 'removed-dir') {
                        if (Test-Path -LiteralPath $rollbackItem.Backup -PathType Container) {
                            [IO.Directory]::Move($rollbackItem.Backup, $rollbackItem.Dest)
                        }
                    }
                    elseif ($rollbackItem.Had -and (Test-Path -LiteralPath $rollbackItem.Backup -PathType Leaf)) {
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
        foreach ($tempFile in $stagedFiles) {
            if (Test-Path -LiteralPath $tempFile) {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not $restoreFailed) {
            foreach ($backupFile in $backupFiles) {
                if (Test-Path -LiteralPath $backupFile) {
                    Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
                }
            }
            if (Test-Path -LiteralPath $staleBackupDir) {
                Remove-DirectoryTreeSafe $staleBackupDir
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
    [switch]$SkipIfLocked,
    [int]$SchemaVersion = 0,
    [object]$ExpectedServerEntry = $null,
    [object]$ExpectedNativeAddons = $null
) {
    $rootPath = Get-FullPath $Root
    $activePath = Get-ActivePath $rootPath
    $releasePath = Get-ReleasePath $rootPath $ReleaseId
    $releaseMain = Join-Path $releasePath 'kiki-desktop.exe'
    $releaseSidecar = Join-Path $releasePath 'kiki-server.exe'
    $releaseBuildInfo = Join-Path $releasePath 'build-info.txt'

    $resolvedSchema = if ($SchemaVersion -gt 0) { $SchemaVersion } else { Get-DirectoryReleaseSchemaVersion $releasePath }
    $desktopInfo = if ($null -ne $ExpectedDesktop) { $ExpectedDesktop } else { Get-ArtifactInfo $releaseMain 'Release Kiki GUI' }
    $sidecarInfo = $null
    $serverEntryInfo = $null
    $nativeAddonsInfo = $null
    $v2Layout = $null
    if ($resolvedSchema -eq 2) {
        $v2Layout = Resolve-V2Layout $releasePath
        if ($null -eq $v2Layout) {
            throw "Release directory at $releasePath is missing v2 server-entry.mjs or native-addons.json."
        }
        $releaseServerEntry = Join-Path $releasePath $v2Layout.ServerEntryRel
        $releaseNativeAddons = Join-Path $releasePath $v2Layout.NativeAddonsRel
        $serverEntryInfo = if ($null -ne $ExpectedServerEntry) { $ExpectedServerEntry } else { Get-ArtifactInfo $releaseServerEntry 'Release Kiki server entry' }
        $nativeAddonsInfo = if ($null -ne $ExpectedNativeAddons) { $ExpectedNativeAddons } else { Get-ArtifactInfo $releaseNativeAddons 'Release Kiki native addon manifest' }
        if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $serverEntryInfo.Hash.Substring(0, 24)) -cne $ReleaseId) {
            throw "Release binaries at $releasePath do not match releaseId $ReleaseId; active runtime was not modified."
        }
    }
    else {
        $sidecarInfo = if ($null -ne $ExpectedSidecar) { $ExpectedSidecar } else { Get-ArtifactInfo $releaseSidecar 'Release Kiki backend' }
        if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $sidecarInfo.Hash.Substring(0, 24)) -cne $ReleaseId) {
            throw "Release binaries at $releasePath do not match releaseId $ReleaseId; active runtime was not modified."
        }
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
        return Sync-ActiveReleaseCore $rootPath $ReleaseId $resolvedGitSha $desktopInfo $sidecarInfo -SkipIfLocked:$SkipIfLocked -SchemaVersion $resolvedSchema -ServerEntryInfo $serverEntryInfo -NativeAddonsInfo $nativeAddonsInfo -V2Layout $v2Layout
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
    $validSchema = ($schema -eq 1) -or ($schema -eq 2 -and ([string](Get-ObjectProperty $Receipt 'runtimeKind')) -ceq 'electron-single-binary')
    if ((-not $validSchema) -or $source -cnotmatch '^[0-9a-f]{40}$') {
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

function Assert-ReceiptFiles([object]$Receipt, [object]$Desktop, [object]$Server, [int]$SchemaVersion = 1, [object]$ServerEntry = $null, [object]$NativeAddons = $null, [object]$AppAsar = $null) {
    $files = Get-ObjectProperty $Receipt 'files'
    Assert-ReceiptFile (Get-ObjectProperty $files 'kiki-desktop.exe') $Desktop 'Kiki GUI'
    if ($SchemaVersion -eq 2) {
        $entryRecord = Get-ObjectProperty $files 'server-entry.mjs'
        if ($null -eq $entryRecord) {
            $entryRecord = Get-ObjectProperty $files 'resources/app.asar.unpacked/dist/server/server-entry.mjs'
        }
        $addonsRecord = Get-ObjectProperty $files 'native-addons.json'
        if ($null -eq $addonsRecord) {
            $addonsRecord = Get-ObjectProperty $files 'resources/app.asar.unpacked/dist/server/native-addons.json'
        }
        Assert-ReceiptFile $entryRecord $ServerEntry 'Kiki server entry'
        Assert-ReceiptFile $addonsRecord $NativeAddons 'Kiki native addon manifest'
        if ($null -ne $AppAsar) {
            $asarRecord = Get-ObjectProperty $files 'resources/app.asar'
            if ($null -ne $asarRecord) {
                Assert-ReceiptFile $asarRecord $AppAsar 'Kiki app.asar'
            }
        }
    }
    else {
        Assert-ReceiptFile (Get-ObjectProperty $files 'kiki-server.exe') $Server 'Kiki backend'
    }
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
    $schemaVersion = Get-ManifestSchemaVersion $receipt
    $desktop = Get-ArtifactInfo (Join-Path $path 'kiki-desktop.exe') 'Kiki GUI build artifact'
    if ($schemaVersion -eq 2) {
        $v2Layout = Resolve-V2Layout $path $receipt
        if ($null -eq $v2Layout) {
            throw "Kiki v2 server entry or native addon manifest is missing in candidate: $path. The runtime was not changed."
        }
        $serverEntry = Get-ArtifactInfo (Join-Path $path $v2Layout.ServerEntryRel) 'Kiki server entry build artifact'
        $nativeAddons = Get-ArtifactInfo (Join-Path $path $v2Layout.NativeAddonsRel) 'Kiki native addon manifest build artifact'
        $appAsar = if ($v2Layout.IsUnpacked) { Get-ArtifactInfo (Join-Path $path $v2Layout.AppAsarRel) 'Kiki app.asar build artifact' } else { $null }
        Assert-ReceiptFiles $receipt $desktop $null 2 $serverEntry $nativeAddons $appAsar
        return [pscustomobject]@{
            SchemaVersion = 2
            RuntimeKind = 'electron-single-binary'
            Path = $path
            GitSha = $gitSha
            Desktop = $desktop
            Sidecar = $null
            ServerEntry = $serverEntry
            NativeAddons = $nativeAddons
            AppAsar = $appAsar
            V2Layout = $v2Layout
            ReleaseId = '{0}-{1}' -f $desktop.Hash.Substring(0, 24), $serverEntry.Hash.Substring(0, 24)
        }
    }
    $sidecar = Get-ArtifactInfo (Join-Path $path 'kiki-server.exe') 'Kiki backend build artifact'
    Assert-ReceiptFiles $receipt $desktop $sidecar 1
    return [pscustomobject]@{
        SchemaVersion = 1
        RuntimeKind = $null
        Path = $path
        GitSha = $gitSha
        Desktop = $desktop
        Sidecar = $sidecar
        ServerEntry = $null
        NativeAddons = $null
        AppAsar = $null
        V2Layout = $null
        ReleaseId = '{0}-{1}' -f $desktop.Hash.Substring(0, 24), $sidecar.Hash.Substring(0, 24)
    }
}

function Invoke-Promotion([string]$Root, [object]$Verified) {
    $rootPath = Get-FullPath $Root
    $schemaVersion = if ($null -ne (Get-ObjectProperty $Verified 'SchemaVersion')) { [int]$Verified.SchemaVersion } else { 1 }
    $mainSource = $Verified.Desktop
    $sidecarSource = Get-ObjectProperty $Verified 'Sidecar'
    $serverEntrySource = Get-ObjectProperty $Verified 'ServerEntry'
    $nativeAddonsSource = Get-ObjectProperty $Verified 'NativeAddons'
    $appAsarSource = Get-ObjectProperty $Verified 'AppAsar'
    $v2Layout = if ($schemaVersion -eq 2) {
        $existingV2 = Get-ObjectProperty $Verified 'V2Layout'
        if ($null -ne $existingV2) { $existingV2 } else { Resolve-V2Layout $Verified.Path }
    }
    else {
        $null
    }
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
        if ($schemaVersion -eq 2) {
            Assert-ArtifactMatches $serverEntrySource (Join-Path $releasePath $v2Layout.ServerEntryRel) 'Promoted Kiki server entry'
            Assert-ArtifactMatches $nativeAddonsSource (Join-Path $releasePath $v2Layout.NativeAddonsRel) 'Promoted Kiki native addon manifest'
            if ($null -ne $appAsarSource) {
                Assert-ArtifactMatches $appAsarSource (Join-Path $releasePath $v2Layout.AppAsarRel) 'Promoted Kiki app.asar'
            }
        }
        else {
            Assert-ArtifactMatches $sidecarSource $sidecarDestination 'Promoted Kiki backend'
        }
    }
    else {
        $stagingPath = Join-Path $releasesPath ('.pending-{0}' -f [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($stagingPath) | Out-Null
        try {
            if ($schemaVersion -eq 2) {
                Copy-DirectoryTreeStrict $Verified.Path $stagingPath @('desktop-build-receipt.json')
                Assert-ArtifactMatches $mainSource (Join-Path $stagingPath 'kiki-desktop.exe') 'Promoted Kiki GUI'
                Assert-ArtifactMatches $serverEntrySource (Join-Path $stagingPath $v2Layout.ServerEntryRel) 'Promoted Kiki server entry'
                Assert-ArtifactMatches $nativeAddonsSource (Join-Path $stagingPath $v2Layout.NativeAddonsRel) 'Promoted Kiki native addon manifest'
                if ($null -ne $appAsarSource) {
                    Assert-ArtifactMatches $appAsarSource (Join-Path $stagingPath $v2Layout.AppAsarRel) 'Promoted Kiki app.asar'
                }
            }
            else {
                $stagedMain = Join-Path $stagingPath 'kiki-desktop.exe'
                Copy-Item -LiteralPath $mainSource.Path -Destination $stagedMain
                Assert-ArtifactMatches $mainSource $stagedMain 'Promoted Kiki GUI'
                $stagedSidecar = Join-Path $stagingPath 'kiki-server.exe'
                Copy-Item -LiteralPath $sidecarSource.Path -Destination $stagedSidecar
                Assert-ArtifactMatches $sidecarSource $stagedSidecar 'Promoted Kiki backend'
            }

            Write-BuildInfo (Join-Path $stagingPath 'build-info.txt') $gitSha
            [IO.Directory]::Move($stagingPath, $releasePath)
        }
        finally {
            Remove-DirectoryTreeSafe $stagingPath
        }
    }

    if ($schemaVersion -eq 1) {
        Publish-CliExecutable $rootPath $sidecarDestination $sidecarSource
    }

    $current = Read-CurrentManifest $rootPath -AllowMissing
    if ($null -ne $current -and $current.releaseId -ceq $releaseId -and (Get-ManifestSchemaVersion $current) -eq $schemaVersion) {
        $syncResult = Sync-ActiveRelease $rootPath $releaseId $gitSha $mainSource $sidecarSource -SkipIfLocked -SchemaVersion $schemaVersion -ExpectedServerEntry $serverEntrySource -ExpectedNativeAddons $nativeAddonsSource
        Write-SourceDiagnostic $Verified.Path $gitSha
        if ($syncResult.Locked) {
            Write-Output "Active runtime is in use; current.json is staged for the next switch/relaunch: $($syncResult.ActivePath)"
        }
        elseif (-not $syncResult.AlreadyCurrent) {
            Write-Output "Synced active runtime: $($syncResult.ActivePath)"
        }
        if ($env:KIKI_SKIP_AUTOSTART_SYNC -ne '1') {
            $effectiveHome = if (-not [string]::IsNullOrWhiteSpace($KikiHome)) { $KikiHome } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.kiki' }
            $regPath = if (-not [string]::IsNullOrWhiteSpace($AutostartRegistryPath)) { $AutostartRegistryPath } else { Get-DefaultAutostartRegistryPath }
            $autoSync = Sync-DesktopAutostart $rootPath $effectiveHome $regPath
            if ($autoSync.changed -and $autoSync.enabled) { Write-Output "Synced Kiki login autostart (tray resident): $($autoSync.command)" }
        }
        Write-Output "Kiki release is already current: $releasePath"
        return
    }

    $manifest = if ($schemaVersion -eq 2) {
        $m = [ordered]@{
            schemaVersion = 2
            runtimeKind = 'electron-single-binary'
            releaseId = $releaseId
            gitSha = $gitSha
            promotedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        if ($null -ne $v2Layout -and $v2Layout.IsUnpacked) {
            $m['serverEntry'] = $v2Layout.ServerEntryPosix
            $m['nativeAddons'] = $v2Layout.NativeAddonsPosix
        }
        $m['files'] = [ordered]@{
            'kiki-desktop.exe' = [ordered]@{ sha256 = $mainSource.Hash; bytes = $mainSource.Length }
            'server-entry.mjs' = [ordered]@{ sha256 = $serverEntrySource.Hash; bytes = $serverEntrySource.Length }
            'native-addons.json' = [ordered]@{ sha256 = $nativeAddonsSource.Hash; bytes = $nativeAddonsSource.Length }
        }
        $m
    }
    else {
        [ordered]@{
            schemaVersion = 1
            releaseId = $releaseId
            gitSha = $gitSha
            promotedAtUtc = [DateTime]::UtcNow.ToString('o')
            files = [ordered]@{
                'kiki-desktop.exe' = [ordered]@{ sha256 = $mainSource.Hash; bytes = $mainSource.Length }
                'kiki-server.exe' = [ordered]@{ sha256 = $sidecarSource.Hash; bytes = $sidecarSource.Length }
            }
        }
    }
    Write-AtomicUtf8Json (Join-Path $rootPath 'current.json') $manifest
    $syncResult = Sync-ActiveRelease $rootPath $releaseId $gitSha $mainSource $sidecarSource -SkipIfLocked -SchemaVersion $schemaVersion -ExpectedServerEntry $serverEntrySource -ExpectedNativeAddons $nativeAddonsSource
    Write-SourceDiagnostic $Verified.Path $gitSha
    if ($syncResult.Locked) {
        Write-Output "Active runtime is in use; current.json is staged for the next switch/relaunch: $($syncResult.ActivePath)"
    }
    else {
        Write-Output "Synced active runtime: $($syncResult.ActivePath)"
    }
    if ($env:KIKI_SKIP_AUTOSTART_SYNC -ne '1') {
        $effectiveHome = if (-not [string]::IsNullOrWhiteSpace($KikiHome)) { $KikiHome } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.kiki' }
        $regPath = if (-not [string]::IsNullOrWhiteSpace($AutostartRegistryPath)) { $AutostartRegistryPath } else { Get-DefaultAutostartRegistryPath }
        $autoSync = Sync-DesktopAutostart $rootPath $effectiveHome $regPath
        if ($autoSync.changed -and $autoSync.enabled) { Write-Output "Synced Kiki login autostart (tray resident): $($autoSync.command)" }
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
    $schemaVersion = Get-ManifestSchemaVersion $manifest
    $releaseId = [string]$manifest.releaseId
    $releasePath = Get-ReleasePath $rootPath $releaseId
    foreach ($name in (Get-ReleaseRequiredFileNames $schemaVersion $releasePath $manifest)) {
        $path = Join-Path $releasePath $name
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) {
            throw "The selected Kiki executable is missing or empty: $path"
        }
    }
    $usingActive = Test-ActiveReleaseAligned $rootPath $releaseId $schemaVersion
    $launchDirectory = if ($usingActive) { Get-ActivePath $rootPath } else { $releasePath }
    $mainPath = Join-Path $launchDirectory 'kiki-desktop.exe'
    $sidecarPath = if ($schemaVersion -eq 2) { $mainPath } else { Join-Path $launchDirectory 'kiki-server.exe' }
    $serverEntryPath = if ($schemaVersion -eq 2) {
        $v2 = Resolve-V2Layout $launchDirectory $manifest
        $entryRel = if ($null -ne $v2) { $v2.ServerEntryRel } else { 'server-entry.mjs' }
        Join-Path $launchDirectory $entryRel
    }
    else {
        $null
    }
    return [pscustomobject]@{
        SchemaVersion = $schemaVersion
        RuntimeKind = if ($schemaVersion -eq 2) { 'electron-single-binary' } else { $null }
        Root = $rootPath
        ReleasePath = $releasePath
        LaunchDirectory = $launchDirectory
        MainPath = $mainPath
        SidecarPath = $sidecarPath
        ServerEntryPath = $serverEntryPath
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

function Get-DefaultAutostartRegistryPath {
    return 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
}

function Get-AutostartCommand([string]$Root) {
    $rootPath = Get-FullPath $Root
    $activeExe = Join-Path (Get-ActivePath $rootPath) 'kiki-desktop.exe'
    $exePath = if ((Test-Path -LiteralPath $activeExe -PathType Leaf) -and (Get-Item -LiteralPath $activeExe).Length -gt 0) {
        $activeExe
    }
    else {
        (Resolve-LaunchTarget $rootPath).MainPath
    }
    if ($exePath.Contains('"')) {
        throw "Autostart executable path cannot contain double quotes: $exePath"
    }
    return ('"{0}" --autostart' -f $exePath)
}

function Read-DesktopAutostartOptOut([string]$HomeDir) {
    if ([string]::IsNullOrWhiteSpace($HomeDir)) { return $false }
    $prefsPath = Join-Path $HomeDir 'desktop.json'
    if (-not (Test-Path -LiteralPath $prefsPath -PathType Leaf)) { return $false }
    try {
        $prefs = Get-Content -LiteralPath $prefsPath -Raw | ConvertFrom-Json
        $val = Get-ObjectProperty $prefs 'autostart'
        if ($null -ne $val -and ([bool]$val -eq $false)) { return $true }
    }
    catch {}
    return $false
}

function Sync-DesktopAutostart(
    [string]$Root,
    [string]$HomeDir = '',
    [string]$RegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    [switch]$ForceEnable,
    [switch]$Disable
) {
    $rootPath = Get-FullPath $Root
    $valueName = 'Kiki'
    if ($Disable) {
        if (Test-Path -LiteralPath $RegistryPath) {
            $existing = Get-ItemProperty -LiteralPath $RegistryPath -Name $valueName -ErrorAction SilentlyContinue
            if ($null -ne $existing) {
                Remove-ItemProperty -LiteralPath $RegistryPath -Name $valueName -Force
            }
        }
        return [pscustomobject]@{ changed = $true; enabled = $false; command = $null }
    }

    $isDevRoot = (Split-Path -Leaf $rootPath) -eq 'Kiki-Dev'
    if ($isDevRoot -and (-not $ForceEnable)) {
        return [pscustomobject]@{ changed = $false; enabled = $false; command = $null }
    }

    $currentValue = $null
    if (Test-Path -LiteralPath $RegistryPath) {
        $item = Get-ItemProperty -LiteralPath $RegistryPath -Name $valueName -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            $currentValue = [string](Get-ObjectProperty $item $valueName)
        }
    }

    $hasExistingInRoot = (-not [string]::IsNullOrWhiteSpace($currentValue)) -and ($currentValue.IndexOf($rootPath, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $bootDaemonScript = Join-Path (Join-Path $rootPath 'backend-boot') 'Start-KikiBackend.ps1'
    $hasBootDaemon = Test-Path -LiteralPath $bootDaemonScript -PathType Leaf
    $optedOut = Read-DesktopAutostartOptOut $HomeDir

    $shouldWrite = $ForceEnable -or $hasExistingInRoot -or ($hasBootDaemon -and [string]::IsNullOrWhiteSpace($currentValue) -and (-not $optedOut))
    if (-not $shouldWrite) {
        return [pscustomobject]@{ changed = $false; enabled = (-not [string]::IsNullOrWhiteSpace($currentValue)); command = $currentValue }
    }

    $desiredCommand = Get-AutostartCommand $rootPath
    if ($currentValue -ceq $desiredCommand) {
        return [pscustomobject]@{ changed = $false; enabled = $true; command = $desiredCommand }
    }
    if (-not (Test-Path -LiteralPath $RegistryPath)) {
        New-Item -Path $RegistryPath -Force | Out-Null
    }
    Set-ItemProperty -LiteralPath $RegistryPath -Name $valueName -Value $desiredCommand -Type String
    return [pscustomobject]@{ changed = $true; enabled = $true; command = $desiredCommand }
}

function Invoke-Launch([string]$Root, [string]$LaunchHome, [switch]$PassThru, [switch]$Background, [switch]$TrayOnly, [switch]$Autostart, [switch]$PassHomeArg) {
    $rootPath = Get-FullPath $Root
    $manifest = Read-CurrentManifest $rootPath
    $schemaVersion = Get-ManifestSchemaVersion $manifest
    $releaseId = [string]$manifest.releaseId
    $launchLock = Open-ActiveLock $rootPath 15
    $previousHome = $env:KIKI_HOME
    $previousNoRedirect = $env:KIKI_NO_RELEASE_REDIRECT
    $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
    try {
        if ($null -ne $launchLock -and (-not (Test-ActiveReleaseAligned $rootPath $releaseId $schemaVersion))) {
            $releasePath = Get-ReleasePath $rootPath $releaseId
            $desktopInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-desktop.exe') 'Release Kiki GUI'
            $sidecarInfo = $null
            $serverEntryInfo = $null
            $nativeAddonsInfo = $null
            $v2Layout = $null
            if ($schemaVersion -eq 2) {
                $v2Layout = Resolve-V2Layout $releasePath $manifest
                if ($null -eq $v2Layout) {
                    throw "Release directory at $releasePath is missing v2 server-entry.mjs or native-addons.json; launch aborted."
                }
                $serverEntryInfo = Get-ArtifactInfo (Join-Path $releasePath $v2Layout.ServerEntryRel) 'Release Kiki server entry'
                $nativeAddonsInfo = Get-ArtifactInfo (Join-Path $releasePath $v2Layout.NativeAddonsRel) 'Release Kiki native addon manifest'
                if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $serverEntryInfo.Hash.Substring(0, 24)) -cne $releaseId) {
                    throw "Release binaries at $releasePath do not match releaseId $releaseId; launch aborted."
                }
            }
            else {
                $sidecarInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-server.exe') 'Release Kiki backend'
                if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $sidecarInfo.Hash.Substring(0, 24)) -cne $releaseId) {
                    throw "Release binaries at $releasePath do not match releaseId $releaseId; launch aborted."
                }
            }
            $gitSha = [string](Get-ObjectProperty $manifest 'gitSha')
            if ([string]::IsNullOrWhiteSpace($gitSha)) { $gitSha = 'unknown' }
            $syncResult = Sync-ActiveReleaseCore $rootPath $releaseId $gitSha $desktopInfo $sidecarInfo -SkipIfLocked -SchemaVersion $schemaVersion -ServerEntryInfo $serverEntryInfo -NativeAddonsInfo $nativeAddonsInfo -V2Layout $v2Layout
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
        if ($null -ne $previousRunAsNode) {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
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
        if ($TrayOnly) {
            $argList.Add('--tray-only')
        }
        elseif ($Autostart) {
            $argList.Add('--autostart')
        }
        elseif ($Background) {
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
        if ($null -eq $previousRunAsNode) {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        else {
            $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
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
    $schemaVersion = Get-ManifestSchemaVersion $manifest
    $releaseId = [string]$manifest.releaseId
    $launchLock = Open-ActiveLock $rootPath 15
    $previousHome = $env:KIKI_HOME
    $previousNoRedirect = $env:KIKI_NO_RELEASE_REDIRECT
    $previousDesktopBundled = $env:KIKI_DESKTOP_BUNDLED
    $previousRuntimeManaged = $env:KIKI_RUNTIME_MANAGED
    $previousBuildId = $env:KIKI_BUILD_ID
    $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
    try {
        if ($null -ne $launchLock -and (-not (Test-ActiveReleaseAligned $rootPath $releaseId $schemaVersion))) {
            $releasePath = Get-ReleasePath $rootPath $releaseId
            $desktopInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-desktop.exe') 'Release Kiki GUI'
            $sidecarInfo = $null
            $serverEntryInfo = $null
            $nativeAddonsInfo = $null
            $v2Layout = $null
            if ($schemaVersion -eq 2) {
                $v2Layout = Resolve-V2Layout $releasePath $manifest
                if ($null -eq $v2Layout) {
                    throw "Release directory at $releasePath is missing v2 server-entry.mjs or native-addons.json; headless launch aborted."
                }
                $serverEntryInfo = Get-ArtifactInfo (Join-Path $releasePath $v2Layout.ServerEntryRel) 'Release Kiki server entry'
                $nativeAddonsInfo = Get-ArtifactInfo (Join-Path $releasePath $v2Layout.NativeAddonsRel) 'Release Kiki native addon manifest'
                if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $serverEntryInfo.Hash.Substring(0, 24)) -cne $releaseId) {
                    throw "Release binaries at $releasePath do not match releaseId $releaseId; headless launch aborted."
                }
            }
            else {
                $sidecarInfo = Get-ArtifactInfo (Join-Path $releasePath 'kiki-server.exe') 'Release Kiki backend'
                if (('{0}-{1}' -f $desktopInfo.Hash.Substring(0, 24), $sidecarInfo.Hash.Substring(0, 24)) -cne $releaseId) {
                    throw "Release binaries at $releasePath do not match releaseId $releaseId; headless launch aborted."
                }
            }
            $gitSha = [string](Get-ObjectProperty $manifest 'gitSha')
            if ([string]::IsNullOrWhiteSpace($gitSha)) { $gitSha = 'unknown' }
            $syncResult = Sync-ActiveReleaseCore $rootPath $releaseId $gitSha $desktopInfo $sidecarInfo -SkipIfLocked -SchemaVersion $schemaVersion -ServerEntryInfo $serverEntryInfo -NativeAddonsInfo $nativeAddonsInfo -V2Layout $v2Layout
            if ($syncResult.Locked) {
                Write-Warning ("Active runtime at {0} is locked by running process(es); launching headless server {1} from releases directory without modifying active." -f $syncResult.ActivePath, $releaseId)
            }
        }
        $target = Resolve-LaunchTarget $rootPath
        $launchBuildId = $null
        if ($target.UsingActive) {
            $activeManifestForLaunch = Read-ActiveManifest $rootPath -AllowMissing
            if ($null -ne $activeManifestForLaunch) {
                $launchBuildId = [string](Get-ObjectProperty $activeManifestForLaunch 'gitSha')
            }
        }
        if ([string]::IsNullOrWhiteSpace($launchBuildId) -or $launchBuildId -ceq 'unknown') {
            $launchBuildId = [string](Get-ObjectProperty $manifest 'gitSha')
        }
        if ([string]::IsNullOrWhiteSpace($launchBuildId) -or $launchBuildId -ceq 'unknown') {
            $buildInfoCandidate = Join-Path $target.LaunchDirectory 'build-info.txt'
            if (Test-Path -LiteralPath $buildInfoCandidate -PathType Leaf) {
                $rawBuildInfo = ([IO.File]::ReadAllText($buildInfoCandidate)).Trim()
                if ($rawBuildInfo -match '^gitSha:\s*(\S+)') { $launchBuildId = $Matches[1] }
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($LaunchHome)) {
            $env:KIKI_HOME = $LaunchHome
        }
        Remove-Item Env:KIKI_NO_RELEASE_REDIRECT -ErrorAction SilentlyContinue
        Remove-Item Env:KIKI_DESKTOP_BUNDLED -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrWhiteSpace($launchBuildId) -and $launchBuildId -cne 'unknown') {
            $env:KIKI_BUILD_ID = $launchBuildId
        }
        else {
            Remove-Item Env:KIKI_BUILD_ID -ErrorAction SilentlyContinue
        }
        if ($RuntimeManaged) {
            $env:KIKI_RUNTIME_MANAGED = '1'
        }
        else {
            Remove-Item Env:KIKI_RUNTIME_MANAGED -ErrorAction SilentlyContinue
        }
        $effectiveArgs = if ([string]::IsNullOrWhiteSpace($LaunchArguments)) { 'serve' } else { $LaunchArguments.Trim() }
        if ($target.SchemaVersion -eq 2) {
            $env:ELECTRON_RUN_AS_NODE = '1'
            $totalMemBytes = [int64]0
            try {
                $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
                if ($null -ne $cs -and $cs.TotalPhysicalMemory -gt 0) { $totalMemBytes = [int64]$cs.TotalPhysicalMemory }
            } catch {}
            $heapMb = [Math]::Max(8192, [int][Math]::Floor([double]$totalMemBytes / 1048576.0 / 4.0))
            $effectiveArgs = ('--max-old-space-size={0} {1} {2}' -f $heapMb, (Format-WindowsProcessArgument $target.ServerEntryPath), $effectiveArgs)
        }
        else {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
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
        if ($null -eq $previousBuildId) {
            Remove-Item Env:KIKI_BUILD_ID -ErrorAction SilentlyContinue
        }
        else {
            $env:KIKI_BUILD_ID = $previousBuildId
        }
        if ($null -eq $previousRunAsNode) {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        else {
            $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
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
                Invoke-Launch $RuntimeRoot -Background:$Background -TrayOnly:$TrayOnly -Autostart:$Autostart
            }
            'InstallShortcuts' {
                if ([string]::IsNullOrWhiteSpace($DesktopPath)) {
                    $DesktopPath = [Environment]::GetFolderPath('Desktop')
                }
                Install-KikiShortcuts $RuntimeRoot (Resolve-CandidateRoot) $DesktopPath $ExpectedCommit
            }
            'EnsureAutostart' {
                $effectiveHome = if (-not [string]::IsNullOrWhiteSpace($KikiHome)) { $KikiHome } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.kiki' }
                $regPath = if (-not [string]::IsNullOrWhiteSpace($AutostartRegistryPath)) { $AutostartRegistryPath } else { Get-DefaultAutostartRegistryPath }
                Sync-DesktopAutostart $RuntimeRoot $effectiveHome $regPath -ForceEnable | Out-Null
            }
            'DisableAutostart' {
                $effectiveHome = if (-not [string]::IsNullOrWhiteSpace($KikiHome)) { $KikiHome } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.kiki' }
                $regPath = if (-not [string]::IsNullOrWhiteSpace($AutostartRegistryPath)) { $AutostartRegistryPath } else { Get-DefaultAutostartRegistryPath }
                Sync-DesktopAutostart $RuntimeRoot $effectiveHome $regPath -Disable | Out-Null
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
