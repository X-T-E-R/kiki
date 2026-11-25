[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$KikiHome,
    [string]$CandidateRoot,
    [string]$ExpectedCommit,
    [switch]$Recover,
    [switch]$Rollback,
    [switch]$Background,
    [switch]$Detach,
    [switch]$InspectOnly,
    [switch]$AppScopeOnly,
    [switch]$CanaryCheck,
    [ValidateRange(0, 86400)][int]$CanaryTimeoutSeconds = 0,
    [ValidateRange(0, 300)][int]$DetachDelaySeconds = 5,
    [ValidateRange(1, 86400)][int]$SettleSeconds = 600,
    [ValidateRange(1, 3600)][int]$StartupSeconds = 90,
    [ValidateRange(1, 300)][int]$StopGraceSeconds = 30,
    [bool]$InterruptAfterSettle = $true,
    [switch]$NoInterruptAfterSettle,
    [switch]$AllowUnfencedHeadless,
    [switch]$SkipTrayHost
)

if ($Rollback -and -not $Recover) {
    throw '-Rollback can only be used together with -Recover.'
}
if ($InspectOnly -and ($Recover -or $Detach)) {
    throw '-InspectOnly cannot be combined with -Recover or -Detach.'
}

$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$homePath = [IO.Path]::GetFullPath($KikiHome)
$candidate = $CandidateRoot
$commit = $ExpectedCommit
$allowInterruptAfterSettle = $InterruptAfterSettle -and (-not $NoInterruptAfterSettle)
$entryScript = $PSCommandPath
. (Join-Path $PSScriptRoot 'desktop-release.ps1') -Action Launch

$statePath = Join-Path $runtime 'hot-switch.json'
$reportPath = Join-Path $runtime 'hot-switch-report.json'
$instances = Join-Path $homePath 'server\instances'
$releases = Join-Path $runtime 'releases'
$activeDir = Get-ActivePath $runtime
$activeDesktopExe = Join-Path $activeDir 'kiki-desktop.exe'
$activeServerExe = Join-Path $activeDir 'kiki-server.exe'
[System.Net.WebRequest]::DefaultWebProxy = $null

function Read-OwnerToken([string]$SpaceHome, [switch]$AllowMissing) {
    $ownerPath = Join-Path $SpaceHome 'server.local-owner'
    if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        throw ("The selected home ({0}) has no local-owner capability. Start its managed desktop normally and verify the home before switching." -f $SpaceHome)
    }
    $rawToken = [IO.File]::ReadAllText($ownerPath).Trim()
    if ($rawToken -notmatch '^[A-Za-z0-9_-]{43}$') {
        if ($AllowMissing) { return $null }
        throw ("The local-owner capability for {0} is invalid." -f $SpaceHome)
    }
    return $rawToken
}

function Call-Local([object]$Server, [string]$Path, [object]$Body = $null, [int]$TimeoutSeconds = 60, [string]$Token = $null) {
    $effectiveToken = $Token
    if ([string]::IsNullOrWhiteSpace($effectiveToken) -and $null -ne $Server) {
        $tokProp = $Server.PSObject.Properties['ownerToken']
        if ($null -ne $tokProp -and -not [string]::IsNullOrWhiteSpace([string]$tokProp.Value)) {
            $effectiveToken = [string]$tokProp.Value
        }
    }
    if ([string]::IsNullOrWhiteSpace($effectiveToken)) { $effectiveToken = $ownerToken }
    $headers = @{ Authorization = 'Bearer ' + $effectiveToken }
    $url = 'http://127.0.0.1:{0}/api/{1}' -f $Server.port, $Path
    if ($null -eq $Body) {
        $reply = Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec 10
    } else {
        $reply = Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec $TimeoutSeconds -Method Post `
            -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 6 -Compress)
    }
    if ($reply.code -ne 0) { throw ('{0}: {1} ({2})' -f $Path, $reply.msg, $reply.code) }
    return $reply.data
}

function Execution([object]$Server, [string]$Id, [string]$Method, [object[]]$Arguments = @()) {
    $timeout = if ($Method -in @('resume', 'cancelPause')) { 120 } else { 60 }
    Call-Local $Server 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $Id; service = 'sessionExecutionControl'; method = $Method }
        params = $Arguments
    } $timeout
}

function Lifecycle([object]$Server, [string]$Action, [bool]$InterruptWork = $false) {
    $body = if ($Action) { @{ action = $Action; server_id = $Server.server_id; consent = $true; interrupt_work = $InterruptWork } } else { $null }
    Call-Local $Server 'desktop-lifecycle' $body
}

function Test-ServerHealthz([object]$Server, [string]$SpaceToken = $null) {
    $effectiveToken = if (-not [string]::IsNullOrWhiteSpace($SpaceToken)) {
        $SpaceToken
    } elseif ($null -ne $Server -and ($Server.PSObject.Properties.Name -contains 'ownerToken') -and -not [string]::IsNullOrWhiteSpace([string]$Server.ownerToken)) {
        [string]$Server.ownerToken
    } else {
        $ownerToken
    }
    $headers = @{}
    if (-not [string]::IsNullOrWhiteSpace($effectiveToken)) {
        $headers['Authorization'] = 'Bearer ' + $effectiveToken
    }
    $url = 'http://127.0.0.1:{0}/api/healthz' -f $Server.port
    try {
        $reply = Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec 5
        if ($null -eq $reply) { return $false }
        if ($reply.PSObject.Properties.Name -contains 'code') {
            return ($reply.code -eq 0 -and $null -ne $reply.data -and ($reply.data.PSObject.Properties.Name -contains 'ok') -and $reply.data.ok -eq $true)
        }
        return (($reply.PSObject.Properties.Name -contains 'ok') -and $reply.ok -eq $true)
    } catch {
        return $false
    }
}

function Try-RuntimeSwitch([object]$Server, [string]$OperationId, [string]$Action, [hashtable]$Result = $null) {
    if ($null -ne $Result) {
        $Result.confirmed = $false
        $Result.released = $false
        $Result.unsupported = $false
        $Result.statusCode = 0
        $Result.error = $null
    }
    if (!$OperationId) {
        if ($null -ne $Result -and $Action -eq 'cancel') { $Result.released = $true }
        return
    }
    try {
        Call-Local $Server 'runtime-switch' @{ operationId = $OperationId; serverId = $Server.server_id; action = $Action } | Out-Null
        if ($null -ne $Result) {
            $Result.confirmed = $true
            $Result.released = $true
        }
    } catch {
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        $response = if ($null -ne $responseProperty) { $responseProperty.Value } else { $null }
        $statusCode = if ($null -ne $response) {
            try { [int]$response.StatusCode } catch {
                try { [int]$response.StatusCode.value__ } catch { 0 }
            }
        } else {
            0
        }
        if ($null -ne $Result) {
            $Result.statusCode = $statusCode
            $Result.error = $_.Exception.Message
        }
        if ($statusCode -eq 404) {
            if ($null -ne $Result) {
                $Result.unsupported = $true
                if ($Action -eq 'cancel') { $Result.released = $true }
            }
            return
        }
        if ($Action -eq 'cancel') {
            try {
                $status = Call-Local $Server 'runtime-switch'
                $writerObj = Get-ObjectProperty $status 'writer'
                $admissionObj = Get-ObjectProperty $status 'admission'
                $writerOp = [string](Get-ObjectProperty $writerObj 'operationId')
                $admissionOp = [string](Get-ObjectProperty $admissionObj 'operationId')
                if ($writerOp -cne $OperationId -and $admissionOp -cne $OperationId) {
                    if ($null -ne $Result) {
                        $Result.confirmed = $true
                        $Result.released = $true
                        $Result.error = $null
                    }
                    return
                }
            } catch {
                if ($null -ne $Result -and [string]::IsNullOrWhiteSpace([string]$Result.error)) {
                    $Result.error = $_.Exception.Message
                }
            }
        }
        Write-Verbose "runtime-switch ($Action) skipped: $($_.Exception.Message)"
    }
}

function Get-ExplicitPortFromCommandLine([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    $matches = [regex]::Matches($CommandLine, '(?i)(?:^|\s)(?:--port|-p)(?:=|\s+)(?:"(\d+)"|''(\d+)''|(\d+))(?=\s|$)')
    if ($matches.Count -eq 0) { return $null }
    $last = $matches[$matches.Count - 1]
    $raw = if ($last.Groups[1].Success) { $last.Groups[1].Value } elseif ($last.Groups[2].Success) { $last.Groups[2].Value } else { $last.Groups[3].Value }
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -ge 0 -and $parsed -le 65535) {
        return $parsed
    }
    return $null
}

function Resolve-ExpectedHeadlessPort([bool]$HadDesktop, [string]$HeadlessLaunchArgs, $OriginalPort) {
    if ($HadDesktop) { return $null }
    $explicit = Get-ExplicitPortFromCommandLine $HeadlessLaunchArgs
    if ($null -ne $explicit) {
        if ($explicit -eq 0) { return $null }
        return [int]$explicit
    }
    if ($null -ne $OriginalPort) {
        $parsed = 0
        if ([int]::TryParse([string]$OriginalPort, [ref]$parsed) -and $parsed -gt 0 -and $parsed -le 65535) {
            return [int]$parsed
        }
    }
    return $null
}

function Get-ExpectedHeadlessPort([object]$SpaceState) {
    if ($null -eq $SpaceState -or [bool](Get-ObjectProperty $SpaceState 'hadDesktop')) { return $null }
    $recordedExpected = Get-ObjectProperty $SpaceState 'expectedPort'
    if ($null -ne $recordedExpected) {
        $parsed = 0
        if ([int]::TryParse([string]$recordedExpected, [ref]$parsed) -and $parsed -gt 0 -and $parsed -le 65535) {
            return [int]$parsed
        }
    }
    $launchArgs = [string](Get-ObjectProperty $SpaceState 'headlessLaunchArgs')
    $origPort = Get-ObjectProperty $SpaceState 'headlessOriginalPort'
    if ($null -eq $origPort) { $origPort = Get-ObjectProperty $SpaceState 'originalPort' }
    return Resolve-ExpectedHeadlessPort $false $launchArgs $origPort
}

function Test-RecordedHeadlessPortMatch([object]$SpaceState, [object]$ServerInfo) {
    if ($null -eq $SpaceState -or [bool](Get-ObjectProperty $SpaceState 'hadDesktop')) { return $true }
    $expPort = Get-ExpectedHeadlessPort $SpaceState
    if ($null -eq $expPort -or $expPort -le 0) { return $true }
    if ($null -eq $ServerInfo -or $null -eq $ServerInfo.instance) { return $false }
    return ([int]$ServerInfo.instance.port -eq $expPort)
}

function Test-RecoverUniformFastPath(
    [object[]]$RecordedSpaces,
    [hashtable]$RunningByHome,
    [hashtable]$UnhealthyByHome,
    [bool]$ShouldRollback,
    [object[]]$MissingSpaces,
    [string[]]$UniqueRunningReleases,
    [hashtable]$TokensByHome
) {
    if ($MissingSpaces.Count -ne 0 -or $UnhealthyByHome.Count -ne 0 -or $ShouldRollback -or $UniqueRunningReleases.Count -ne 1) {
        return $false
    }
    foreach ($spState in @($RecordedSpaces)) {
        $k = ([string]$spState.kikiHome).ToLowerInvariant()
        if (-not $RunningByHome.ContainsKey($k)) { return $false }
        $srv = $RunningByHome[$k]
        if (-not (Test-RecordedHeadlessPortMatch $spState $srv)) { return $false }
        if ($srv.layout -ne 'active') { return $false }
        if (-not (Test-ServerHealthz $srv.instance $TokensByHome[$k])) { return $false }
    }
    return $true
}

function Test-TcpPortListening([int]$Port) {
    if ($Port -le 0 -or $Port -gt 65535) { return $false }
    try {
        $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        foreach ($ep in $listeners) {
            if ($null -ne $ep -and [int]$ep.Port -eq $Port) { return $true }
        }
    } catch {}
    return $false
}

function Wait-ForPortsReleased([int[]]$Ports, [int]$TimeoutSeconds = 15) {
    $uniquePorts = @($Ports | Where-Object { $_ -gt 0 -and $_ -le 65535 } | Select-Object -Unique)
    if ($uniquePorts.Count -eq 0) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $stillBound = @($uniquePorts | Where-Object { Test-TcpPortListening $_ })
        if ($stillBound.Count -eq 0) { return }
        Start-Sleep -Milliseconds 150
    }
    $stillBound = @($uniquePorts | Where-Object { Test-TcpPortListening $_ })
    if ($stillBound.Count -gt 0) {
        throw ("Fixed headless port(s) did not release within {0}s before relaunch: {1}" -f $TimeoutSeconds, ($stillBound -join ', '))
    }
}

function Get-ProcessTreePids([int[]]$RootPids) {
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    foreach ($rootPid in @($RootPids)) {
        if ($rootPid -gt 0 -and $seen.Add($rootPid)) {
            $queue.Enqueue($rootPid)
        }
    }
    if ($queue.Count -eq 0) { return @() }
    $childrenByParent = @{}
    try {
        foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
            $parentId = [int]$proc.ParentProcessId
            $childId = [int]$proc.ProcessId
            if (-not $childrenByParent.ContainsKey($parentId)) {
                $childrenByParent[$parentId] = New-Object 'System.Collections.Generic.List[int]'
            }
            $childrenByParent[$parentId].Add($childId)
        }
    } catch {
        return @($seen)
    }
    while ($queue.Count -gt 0) {
        $currentPid = $queue.Dequeue()
        if ($childrenByParent.ContainsKey($currentPid)) {
            foreach ($childPid in $childrenByParent[$currentPid]) {
                if ($seen.Add($childPid)) {
                    $queue.Enqueue($childPid)
                }
            }
        }
    }
    return @($seen)
}

function Get-HomeRegisteredServerPids([string]$SpaceHome = $homePath) {
    $spaceInstances = Join-Path $SpaceHome 'server\instances'
    $pids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($file in @(Get-ChildItem -LiteralPath $spaceInstances -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        try {
            $inst = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            if ($file.BaseName -cne [string](Get-ObjectProperty $inst 'server_id')) { continue }
            $instPid = [int](Get-ObjectProperty $inst 'pid')
            if ($instPid -le 0) { continue }
            $proc = Get-Process -Id $instPid -ErrorAction SilentlyContinue
            if ($null -eq $proc -or $proc.HasExited) { continue }
            # Verify process identity (start time + runtime server executable path) so stale registrations
            # whose PID was reused by an unrelated process can never authorize termination.
            $startedAt = ([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds()
            $registeredStartedAt = [long](Get-ObjectProperty $inst 'started_at')
            if ([Math]::Abs($startedAt - $registeredStartedAt) -gt 60000) { continue }
            $procPath = Get-ProcessPathSafe $proc
            if ($null -eq (Get-RuntimeServerBinaryInfo $procPath)) { continue }
            $null = $pids.Add($instPid)
        } catch {}
    }
    return @($pids)
}

function Test-IsElectronServerCommandLine([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    return ($CommandLine -match '(?i)(?:^|[\s"''\\\/])server-entry\.mjs(?:["''\s]|$)')
}

function Test-IsChromiumSubprocessCommandLine([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    return ($CommandLine -match '(?i)(?:^|\s)--type=')
}

function Test-IsElectronBackendHelperCommandLine([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    return ($CommandLine -match '(?i)(?:^|[\s"''\\\/])(?:sqlite-indexer\.mjs|hostRunner\.mjs)(?:["''\s]|$)|(?:^|\s)__(?:search-indexer|plugin_run_node)(?:\s|$)')
}

function Strip-LeadingServerEntryArgument([string]$LaunchArgs) {
    if ([string]::IsNullOrWhiteSpace($LaunchArgs)) { return '' }
    $trimmed = $LaunchArgs.Trim()
    if ($trimmed -match '^(?i)(?:--max[-_]old[-_]space[-_]size=\d+\s+)*(?:"[^"]*server-entry\.mjs"|''[^'']*server-entry\.mjs''|\S*server-entry\.mjs)(?:\s+(.*))?$') {
        if ($Matches.ContainsKey(1) -and $null -ne $Matches[1]) { return ([string]$Matches[1]).Trim() }
        return ''
    }
    return $trimmed
}

function Get-OtherActiveServerPids([int[]]$OwnedPids = @()) {
    $ownedSet = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($pidVal in @($OwnedPids)) {
        if ($pidVal -gt 0) { $null = $ownedSet.Add($pidVal) }
    }
    $activePath = Get-ActivePath $runtime
    $expectedActiveServer = Join-Path $activePath 'kiki-server.exe'
    $expectedActiveDesktop = Join-Path $activePath 'kiki-desktop.exe'
    $desktopCmdByPid = @{}
    try {
        foreach ($wmiProc in @(Get-CimInstance Win32_Process -Filter "Name='kiki-desktop.exe'" -ErrorAction SilentlyContinue)) {
            $desktopCmdByPid[[int]$wmiProc.ProcessId] = [string]$wmiProc.CommandLine
        }
    } catch {}
    $otherPids = @()
    foreach ($proc in @(Get-Process -Name 'kiki-server' -ErrorAction SilentlyContinue)) {
        try {
            if ($proc.HasExited) { continue }
            $procPath = Get-ProcessPathSafe $proc
            if ($procPath -and ($procPath -ieq $expectedActiveServer) -and (-not $ownedSet.Contains([int]$proc.Id))) {
                $otherPids += [int]$proc.Id
            }
        } catch {}
    }
    foreach ($proc in @(Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue)) {
        try {
            if ($proc.HasExited) { continue }
            $procPath = Get-ProcessPathSafe $proc
            $cmdLine = if ($desktopCmdByPid.ContainsKey([int]$proc.Id)) { $desktopCmdByPid[[int]$proc.Id] } else { '' }
            if ($procPath -and ($procPath -ieq $expectedActiveDesktop) -and ((Test-IsElectronServerCommandLine $cmdLine) -or (Test-IsElectronBackendHelperCommandLine $cmdLine)) -and (-not $ownedSet.Contains([int]$proc.Id))) {
                $otherPids += [int]$proc.Id
            }
        } catch {}
    }
    return @($otherPids)
}

function Get-RuntimeServerBinaryInfo([string]$BinaryPath, [string]$CommandLine = '') {
    if ([string]::IsNullOrWhiteSpace($BinaryPath)) { return $null }
    $activePath = Get-ActivePath $runtime
    $expectedActiveServer = Join-Path $activePath 'kiki-server.exe'
    $expectedActiveDesktop = Join-Path $activePath 'kiki-desktop.exe'
    if ($BinaryPath -ieq $expectedActiveServer) {
        $activeReleaseId = Resolve-ActiveReleaseId $runtime
        if ([string]::IsNullOrWhiteSpace($activeReleaseId)) { return $null }
        return [pscustomobject]@{ layout = 'active'; releaseId = $activeReleaseId; executablePath = $BinaryPath; schemaVersion = 1 }
    }
    if ($BinaryPath -ieq $expectedActiveDesktop) {
        $activeManifest = Read-ActiveManifest $runtime -AllowMissing
        $activeSchema = if ($null -ne $activeManifest) { Get-ManifestSchemaVersion $activeManifest } else { Get-DirectoryReleaseSchemaVersion $activePath }
        if ($activeSchema -eq 2 -and ([string]::IsNullOrWhiteSpace($CommandLine) -or (Test-IsElectronServerCommandLine $CommandLine) -or (Test-IsElectronBackendHelperCommandLine $CommandLine))) {
            $activeReleaseId = Resolve-ActiveReleaseId $runtime
            if ([string]::IsNullOrWhiteSpace($activeReleaseId)) { return $null }
            return [pscustomobject]@{ layout = 'active'; releaseId = $activeReleaseId; executablePath = $BinaryPath; schemaVersion = 2 }
        }
    }
    $releasesPrefix = (Join-Path $runtime 'releases') + '\'
    if ($BinaryPath.StartsWith($releasesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $releaseId = Split-Path -Leaf (Split-Path -Parent $BinaryPath)
        if ($releaseId -match '^[0-9a-f]{24}-[0-9a-f]{24}$') {
            $releaseDir = Get-ReleasePath $runtime $releaseId
            if ($BinaryPath -ieq (Join-Path $releaseDir 'kiki-server.exe')) {
                return [pscustomobject]@{ layout = 'releases'; releaseId = $releaseId; executablePath = $BinaryPath; schemaVersion = 1 }
            }
            if ($BinaryPath -ieq (Join-Path $releaseDir 'kiki-desktop.exe') -and (Get-DirectoryReleaseSchemaVersion $releaseDir) -eq 2 -and ([string]::IsNullOrWhiteSpace($CommandLine) -or (Test-IsElectronServerCommandLine $CommandLine) -or (Test-IsElectronBackendHelperCommandLine $CommandLine))) {
                return [pscustomobject]@{ layout = 'releases'; releaseId = $releaseId; executablePath = $BinaryPath; schemaVersion = 2 }
            }
        }
    }
    return $null
}

function Find-Server([string]$SpaceHome = $homePath, [string]$SpaceToken = $null, [switch]$AllowHeadless) {
    $spaceInstances = Join-Path $SpaceHome 'server\instances'
    $effectiveToken = if (-not [string]::IsNullOrWhiteSpace($SpaceToken)) { $SpaceToken } else { $ownerToken }
    if ([string]::IsNullOrWhiteSpace($effectiveToken)) { return $null }
    $matches = @(
        foreach ($file in Get-ChildItem -LiteralPath $spaceInstances -Filter '*.json' -File -ErrorAction SilentlyContinue) {
            $instance = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $instHost = [string](Get-ObjectProperty $instance 'host')
            $instPort = [int](Get-ObjectProperty $instance 'port')
            if ($instHost -notin @('127.0.0.1', 'localhost') -or $instPort -le 0) { continue }
            $instPid = [int](Get-ObjectProperty $instance 'pid')
            $instServerId = [string](Get-ObjectProperty $instance 'server_id')
            $process = Get-Process -Id $instPid -ErrorAction SilentlyContinue
            if ($null -eq $process -or $file.BaseName -cne $instServerId) { continue }
            $startedAt = ([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()
            if ([Math]::Abs($startedAt - [long](Get-ObjectProperty $instance 'started_at')) -gt 60000) { continue }
            $binary = Get-ProcessPathSafe $process
            $binaryInfo = Get-RuntimeServerBinaryInfo $binary
            if ($null -eq $binaryInfo) { continue }
            $instance | Add-Member -NotePropertyName ownerToken -NotePropertyValue $effectiveToken -Force
            $meta = Call-Local $instance 'meta' $null 10 $effectiveToken
            $metaServerId = [string](Get-ObjectProperty $meta 'server_id')
            $metaDesktopManaged = [bool](Get-ObjectProperty $meta 'desktop_managed')
            $metaBypassAuth = [bool](Get-ObjectProperty $meta 'dangerous_bypass_auth')
            $metaBuildId = [string](Get-ObjectProperty $meta 'build_id')
            $instBuildId = [string](Get-ObjectProperty $instance 'build_id')
            if ($metaServerId -cne $instServerId -or ((-not $AllowHeadless) -and (-not $metaDesktopManaged)) -or $metaBypassAuth `
                -or $metaBuildId -cne $instBuildId) { throw 'The local service identity does not match its registration.' }
            $process.EnableRaisingEvents = $true
            $null = $process.Handle
            [pscustomobject]@{
                kikiHome = $SpaceHome
                ownerToken = $effectiveToken
                instance = $instance
                process = $process
                meta = $meta
                releaseId = $binaryInfo.releaseId
                executablePath = $binaryInfo.executablePath
                layout = $binaryInfo.layout
            }
        }
    )
    if ($matches.Count -gt 1) { throw ("More than one managed service is active in home {0}. Close the extra instance before switching." -f $SpaceHome) }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Normalize-HomePath([string]$RawPath) {
    $full = [IO.Path]::GetFullPath($RawPath.Trim())
    if ($full.Length -gt 3 -and $full.EndsWith('\')) { $full = $full.TrimEnd('\') }
    return $full
}

function Get-ExplicitHomeFromCommandLine([string]$CommandLine) {
    if (-not [string]::IsNullOrWhiteSpace($CommandLine)) {
        if ($CommandLine -match '(?i)(?:^|\s)--home(?:=|\s+)(?:"([^"]+)"|''([^'']+)''|(\S+))') {
            $rawHome = if ($Matches[1]) { $Matches[1] } elseif ($Matches[2]) { $Matches[2] } else { $Matches[3] }
            if (-not [string]::IsNullOrWhiteSpace($rawHome)) {
                return Normalize-HomePath $rawHome
            }
        }
    }
    return $null
}

function Get-ShellHomeFromCommandLine([string]$CommandLine, [string]$DefaultHome) {
    $explicit = Get-ExplicitHomeFromCommandLine $CommandLine
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        return $explicit
    }
    return Normalize-HomePath $DefaultHome
}

function Split-ExecutableAndArguments([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return '' }
    $trimmed = $CommandLine.Trim()
    if ($trimmed.StartsWith('"')) {
        $endQuote = $trimmed.IndexOf('"', 1)
        if ($endQuote -lt 0) { return '' }
        return $trimmed.Substring($endQuote + 1).Trim()
    }
    $firstSpace = $trimmed.IndexOf(' ')
    if ($firstSpace -lt 0) { return '' }
    return $trimmed.Substring($firstSpace + 1).Trim()
}

function Get-RegisteredSpaceHomes([string]$PrimaryHome) {
    $homesFile = Join-Path $PrimaryHome 'homes.json'
    if (-not (Test-Path -LiteralPath $homesFile -PathType Leaf)) { return @() }
    $homes = New-Object System.Collections.Generic.List[string]
    try {
        $records = @(Get-Content -LiteralPath $homesFile -Raw | ConvertFrom-Json)
        foreach ($record in $records) {
            if ($null -eq $record) { continue }
            $rawPath = [string](Get-ObjectProperty $record 'path')
            if ([string]::IsNullOrWhiteSpace($rawPath)) { continue }
            if (-not [IO.Path]::IsPathRooted($rawPath)) { continue }
            $homes.Add((Normalize-HomePath $rawPath))
        }
    } catch {}
    return @($homes)
}

function Resolve-ServerHomeByPid([int]$ServerPid, [object]$Proc, [string[]]$CandidateHomes) {
    if ($ServerPid -le 0 -or $null -eq $Proc) { return $null }
    $startedAt = $null
    try { $startedAt = ([DateTimeOffset]$Proc.StartTime).ToUnixTimeMilliseconds() } catch { return $null }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($candidate in @($CandidateHomes)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $norm = Normalize-HomePath $candidate
        if (-not $seen.Add($norm.ToLowerInvariant())) { continue }
        $spaceInstances = Join-Path $norm 'server\instances'
        if (-not (Test-Path -LiteralPath $spaceInstances -PathType Container)) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $spaceInstances -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
            try {
                $inst = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
                if ($file.BaseName -cne [string](Get-ObjectProperty $inst 'server_id')) { continue }
                if ([int](Get-ObjectProperty $inst 'pid') -ne $ServerPid) { continue }
                $regStartedAt = [long](Get-ObjectProperty $inst 'started_at')
                if ([Math]::Abs($startedAt - $regStartedAt) -gt 60000) { continue }
                return $norm
            } catch {}
        }
    }
    return $null
}

function Get-InferredHomeFromChildArgs([string]$LaunchArgs) {
    if ([string]::IsNullOrWhiteSpace($LaunchArgs)) { return $null }
    if ($LaunchArgs -match '(?i)(?:(?:^|\s)__search-indexer|(?:^|[\s"''\\\/])sqlite-indexer\.mjs["'']?)\s+(?:"([^"]+)"|''([^'']+)''|(\S+))') {
        $dbPath = if ($Matches[1]) { $Matches[1] } elseif ($Matches[2]) { $Matches[2] } else { $Matches[3] }
        if (-not [string]::IsNullOrWhiteSpace($dbPath) -and [IO.Path]::IsPathRooted($dbPath)) {
            $indexDir = Split-Path -Parent $dbPath
            $leaf = Split-Path -Leaf $indexDir
            if ($leaf -ieq 'search-index-v2' -or $leaf -ieq 'search-index') {
                $candidateHome = Split-Path -Parent $indexDir
                if (-not [string]::IsNullOrWhiteSpace($candidateHome) -and [IO.Path]::IsPathRooted($candidateHome)) {
                    return Normalize-HomePath $candidateHome
                }
            }
        }
    }
    if ($LaunchArgs -match '(?i)(?:(?:^|\s)__plugin_run_node|(?:^|[\s"''\\\/])hostRunner\.mjs["'']?)\s+') {
        foreach ($m in [regex]::Matches($LaunchArgs, '(?:"([^"]+)"|''([^'']+)''|(\S+))')) {
            $tok = if ($m.Groups[1].Success) { $m.Groups[1].Value } elseif ($m.Groups[2].Success) { $m.Groups[2].Value } else { $m.Groups[3].Value }
            if ([string]::IsNullOrWhiteSpace($tok) -or (-not [IO.Path]::IsPathRooted($tok))) { continue }
            $normTok = $tok.Replace('/', '\')
            $idx = $normTok.IndexOf('\plugins\', [StringComparison]::OrdinalIgnoreCase)
            if ($idx -gt 2) {
                return Normalize-HomePath ($normTok.Substring(0, $idx))
            }
        }
    }
    return $null
}

function Find-RuntimeServerEntries([string[]]$KnownHomes = @()) {
    $wmiByPid = @{}
    try {
        foreach ($wmiProc in @(Get-CimInstance Win32_Process -Filter "Name='kiki-server.exe' OR Name='kiki-desktop.exe'" -ErrorAction SilentlyContinue)) {
            $wmiByPid[[int]$wmiProc.ProcessId] = $wmiProc
        }
    } catch {}
    $candidates = @()
    $matchedPids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($proc in @(Get-Process -Name 'kiki-server', 'kiki-desktop' -ErrorAction SilentlyContinue)) {
        try {
            if ($proc.HasExited) { continue }
            $procPid = [int]$proc.Id
            $procPath = Get-ProcessPathSafe $proc
            $wmi = if ($wmiByPid.ContainsKey($procPid)) { $wmiByPid[$procPid] } else { $null }
            $cmdLine = if ($null -ne $wmi) { [string]$wmi.CommandLine } else { '' }
            if ($proc.ProcessName -ieq 'kiki-desktop' -and (-not ((Test-IsElectronServerCommandLine $cmdLine) -or (Test-IsElectronBackendHelperCommandLine $cmdLine)))) { continue }
            $binaryInfo = Get-RuntimeServerBinaryInfo $procPath $cmdLine
            if ($null -eq $binaryInfo) { continue }
            $null = $matchedPids.Add($procPid)
            $parentPid = if ($null -ne $wmi) { [int]$wmi.ParentProcessId } else { 0 }
            $rawLaunchArgs = Split-ExecutableAndArguments $cmdLine
            $launchArgs = if ($binaryInfo.schemaVersion -eq 2) { Strip-LeadingServerEntryArgument $rawLaunchArgs } else { $rawLaunchArgs }
            $candidates += [pscustomobject]@{
                process = $proc
                pid = $procPid
                parentPid = $parentPid
                executablePath = $procPath
                commandLine = $cmdLine
                launchArgs = $launchArgs
                isHelper = (Test-IsElectronBackendHelperCommandLine $cmdLine)
                binaryInfo = $binaryInfo
            }
        } catch {}
    }
    $candidateByPid = @{}
    foreach ($item in $candidates) {
        $candidateByPid[[int]$item.pid] = $item
    }
    $inferredHomeByServerPid = @{}
    foreach ($item in $candidates) {
        if (-not ($item.isHelper -or ($item.launchArgs -match '^__'))) { continue }
        $inferred = Get-InferredHomeFromChildArgs $item.launchArgs
        if (-not [string]::IsNullOrWhiteSpace($inferred) -and $item.parentPid -gt 0) {
            if (-not $inferredHomeByServerPid.ContainsKey([int]$item.parentPid)) {
                $inferredHomeByServerPid[[int]$item.parentPid] = $inferred
            }
        }
    }
    $heapLauncherParentPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $heapLauncherByChildPid = @{}
    foreach ($item in $candidates) {
        if ($item.isHelper -or ($item.launchArgs -match '^__')) { continue }
        if ($item.parentPid -gt 0 -and $candidateByPid.ContainsKey($item.parentPid)) {
            $parentItem = $candidateByPid[$item.parentPid]
            if (($parentItem.executablePath -ieq $item.executablePath) -and (-not [string]::IsNullOrWhiteSpace($item.launchArgs)) -and ($parentItem.launchArgs -ceq $item.launchArgs)) {
                $null = $heapLauncherParentPids.Add([int]$parentItem.pid)
                $heapLauncherByChildPid[[int]$item.pid] = $parentItem
            }
        }
    }
    $entries = @()
    foreach ($item in $candidates) {
        if ($item.isHelper -or ($item.launchArgs -match '^__')) { continue }
        if ($heapLauncherParentPids.Contains([int]$item.pid)) { continue }
        $launcherItem = if ($heapLauncherByChildPid.ContainsKey([int]$item.pid)) { $heapLauncherByChildPid[[int]$item.pid] } else { $null }
        if ($null -eq $launcherItem -and $item.parentPid -gt 0 -and $matchedPids.Contains($item.parentPid)) { continue }
        $explicitHome = Get-ExplicitHomeFromCommandLine $item.commandLine
        $candidateHomes = New-Object System.Collections.Generic.List[string]
        if ($inferredHomeByServerPid.ContainsKey([int]$item.pid)) {
            $candidateHomes.Add([string]$inferredHomeByServerPid[[int]$item.pid])
        }
        foreach ($kh in @($KnownHomes)) {
            if (-not [string]::IsNullOrWhiteSpace($kh)) { $candidateHomes.Add($kh) }
        }
        $resolvedHome = if (-not [string]::IsNullOrWhiteSpace($explicitHome)) {
            $explicitHome
        } else {
            Resolve-ServerHomeByPid $item.pid $item.process ($candidateHomes.ToArray())
        }
        $entries += [pscustomobject]@{
            process = $item.process
            pid = $item.pid
            parentPid = $item.parentPid
            launcherPid = if ($null -ne $launcherItem) { [int]$launcherItem.pid } else { 0 }
            launcherProcess = if ($null -ne $launcherItem) { $launcherItem.process } else { $null }
            executablePath = $item.executablePath
            commandLine = $item.commandLine
            launchArgs = $item.launchArgs
            kikiHome = $resolvedHome
            hasExplicitHomeArg = (-not [string]::IsNullOrWhiteSpace($explicitHome))
            binaryInfo = $item.binaryInfo
        }
    }
    return @($entries)
}

function Find-ShellEntries {
    $expectedActiveDesktop = Join-Path (Get-ActivePath $runtime) 'kiki-desktop.exe'
    $releasesPrefix = (Join-Path $runtime 'releases') + '\'
    $cmdByPid = @{}
    try {
        foreach ($wmiProc in @(Get-CimInstance Win32_Process -Filter "Name='kiki-desktop.exe'" -ErrorAction SilentlyContinue)) {
            $cmdByPid[[int]$wmiProc.ProcessId] = [string]$wmiProc.CommandLine
        }
    } catch {}
    $entries = @()
    foreach ($proc in @(Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue)) {
        $procPath = Get-ProcessPathSafe $proc
        if (-not $procPath) { continue }
        if (($procPath -ine $expectedActiveDesktop) -and (-not $procPath.StartsWith($releasesPrefix, [StringComparison]::OrdinalIgnoreCase))) { continue }
        $cmdLine = if ($cmdByPid.ContainsKey([int]$proc.Id)) { $cmdByPid[[int]$proc.Id] } else { '' }
        if ((Test-IsElectronServerCommandLine $cmdLine) -or (Test-IsChromiumSubprocessCommandLine $cmdLine) -or (Test-IsElectronBackendHelperCommandLine $cmdLine)) { continue }
        $shellHome = Get-ShellHomeFromCommandLine $cmdLine $homePath
        $entries += [pscustomobject]@{
            process = $proc
            pid = [int]$proc.Id
            executablePath = $procPath
            commandLine = $cmdLine
            kikiHome = $shellHome
            hasExplicitHomeArg = ($cmdLine -match '(?i)(?:^|\s)--home(?:=|\s+)')
        }
    }
    return @($entries)
}

function Find-Shells {
    return @(Find-ShellEntries | ForEach-Object { $_.process })
}

function Discover-RuntimeSpaces([switch]$AllowMissingTokens) {
    $shellEntries = @(Find-ShellEntries)
    $shellsByKey = @{}
    $headlessByKey = @{}
    $orderedHomes = New-Object System.Collections.Generic.List[string]
    $seenKeys = New-Object 'System.Collections.Generic.HashSet[string]'
    $primaryKey = $homePath.ToLowerInvariant()
    $null = $seenKeys.Add($primaryKey)
    $orderedHomes.Add($homePath)
    foreach ($entry in $shellEntries) {
        $key = $entry.kikiHome.ToLowerInvariant()
        if ($seenKeys.Add($key)) {
            $orderedHomes.Add($entry.kikiHome)
        }
        if (-not $shellsByKey.ContainsKey($key)) {
            $shellsByKey[$key] = @()
        }
        $shellsByKey[$key] = @($shellsByKey[$key]) + @($entry)
    }
    $knownHomes = @($orderedHomes.ToArray()) + @(Get-RegisteredSpaceHomes $homePath)
    $serverEntries = @(Find-RuntimeServerEntries $knownHomes)
    $serverEntryByPid = @{}
    foreach ($srvEntry in $serverEntries) {
        $serverEntryByPid[[int]$srvEntry.pid] = $srvEntry
        if ([string]::IsNullOrWhiteSpace($srvEntry.kikiHome)) { continue }
        $key = $srvEntry.kikiHome.ToLowerInvariant()
        if ($shellsByKey.ContainsKey($key)) { continue }
        if ($seenKeys.Add($key)) {
            $orderedHomes.Add($srvEntry.kikiHome)
        }
        if (-not $headlessByKey.ContainsKey($key)) {
            $headlessByKey[$key] = $srvEntry
        }
    }
    $spaces = @()
    foreach ($spaceHome in $orderedHomes) {
        $key = $spaceHome.ToLowerInvariant()
        $isPrimary = ($key -ceq $primaryKey)
        $entries = @(if ($shellsByKey.ContainsKey($key)) { $shellsByKey[$key] })
        $headlessEntry = if ($entries.Count -eq 0 -and $headlessByKey.ContainsKey($key)) { $headlessByKey[$key] } else { $null }
        $hadDesktop = ($entries.Count -gt 0)
        $spaceShells = @($entries | ForEach-Object { $_.process })
        $passHomeArg = (-not $isPrimary) -or (@($entries | Where-Object { $_.hasExplicitHomeArg }).Count -gt 0)
        $tokenError = $null
        $spaceToken = $null
        try {
            $spaceToken = Read-OwnerToken $spaceHome -AllowMissing:$AllowMissingTokens
            if ($null -eq $spaceToken -and $AllowMissingTokens) {
                $ownerPath = Join-Path $spaceHome 'server.local-owner'
                $tokenError = if (Test-Path -LiteralPath $ownerPath -PathType Leaf) { 'The local-owner capability is invalid.' } else { 'No local-owner capability file found.' }
            }
        } catch {
            if ($AllowMissingTokens) {
                $tokenError = $_.Exception.Message
            } else {
                throw
            }
        }
        $allowHeadless = (-not $hadDesktop)
        $server = if ($null -ne $spaceToken) { Find-Server $spaceHome $spaceToken -AllowHeadless:$allowHeadless } else { $null }
        $servingEntry = if ($null -ne $server -and $serverEntryByPid.ContainsKey([int]$server.process.Id)) {
            $serverEntryByPid[[int]$server.process.Id]
        } else {
            $headlessEntry
        }
        $launcherProcess = if ($null -ne $servingEntry) { $servingEntry.launcherProcess } else { $null }
        $launcherPid = if ($null -ne $servingEntry) { [int]$servingEntry.launcherPid } else { 0 }
        if ($null -ne $launcherProcess) {
            try { $launcherProcess.EnableRaisingEvents = $true; $null = $launcherProcess.Handle } catch {}
        }
        $headlessLaunchArgs = if (-not $hadDesktop -and $null -ne $servingEntry -and -not [string]::IsNullOrWhiteSpace($servingEntry.launchArgs)) {
            [string]$servingEntry.launchArgs
        } else {
            $null
        }
        $headlessOriginalPort = if (-not $hadDesktop -and $null -ne $server -and [int]$server.instance.port -gt 0) {
            [int]$server.instance.port
        } else {
            $null
        }
        $headlessExplicitPort = if (-not $hadDesktop) { Get-ExplicitPortFromCommandLine $headlessLaunchArgs } else { $null }
        $expectedPort = Resolve-ExpectedHeadlessPort $hadDesktop $headlessLaunchArgs $headlessOriginalPort
        $effectiveManaged = if ($null -ne $server) { [bool](Get-ObjectProperty $server.meta 'desktop_managed') } else { $false }
        if ((-not $effectiveManaged) -and (-not $hadDesktop) -and $null -ne $server) {
            try {
                $effectiveManaged = [bool](Get-ObjectProperty (Lifecycle $server.instance '') 'managed')
            } catch {
                $effectiveManaged = $false
            }
        }
        $spaces += [pscustomobject]@{
            kikiHome = $spaceHome
            isPrimary = $isPrimary
            passHomeArg = $passHomeArg
            hadDesktop = $hadDesktop
            isHeadless = (-not $hadDesktop)
            headlessLaunchArgs = $headlessLaunchArgs
            headlessOriginalPort = $headlessOriginalPort
            headlessExplicitPort = $headlessExplicitPort
            expectedPort = $expectedPort
            headlessPid = if ($null -ne $servingEntry) { [int]$servingEntry.pid } else { 0 }
            launcherPid = $launcherPid
            launcherProcess = $launcherProcess
            desktopManaged = $effectiveManaged
            ownerToken = $spaceToken
            tokenError = $tokenError
            server = $server
            shells = $spaceShells
            shellEntries = $entries
        }
    }
    return @($spaces)
}

function Get-RecordedSpaces([object]$StateObj) {
    $rawSpaces = Get-ObjectProperty $StateObj 'spaces'
    $recorded = @(if ($null -ne $rawSpaces) { @($rawSpaces) | Where-Object { $null -ne $_ } })
    if ($recorded.Count -gt 0) { return $recorded }
    $rawSessions = Get-ObjectProperty $StateObj 'sessions'
    $sessionItems = @(if ($null -ne $rawSessions) { @($rawSessions) | Where-Object { $null -ne $_ } })
    return @(
        [pscustomobject]@{
            kikiHome = [string]$StateObj.kikiHome
            isPrimary = $true
            passHomeArg = $false
            oldReleaseId = [string]$StateObj.oldReleaseId
            oldBuildId = [string]$StateObj.oldBuildId
            oldServerId = [string]$StateObj.oldServerId
            serverHomeId = [string]$StateObj.serverHomeId
            spaceId = [string]$StateObj.spaceId
            hadDesktop = [bool]$StateObj.hadDesktop
            headlessLaunchArgs = [string](Get-ObjectProperty $StateObj 'headlessLaunchArgs')
            headlessOriginalPort = Get-ObjectProperty $StateObj 'headlessOriginalPort'
            headlessExplicitPort = Get-ObjectProperty $StateObj 'headlessExplicitPort'
            expectedPort = Get-ObjectProperty $StateObj 'expectedPort'
            desktopManaged = [bool](Get-ObjectProperty $StateObj 'desktopManaged')
            fenceOperationId = [string](Get-ObjectProperty $StateObj 'fenceOperationId')
            sessions = $sessionItems
        }
    )
}

function Stop-SpaceServerGracefully([object]$ServerInfo, [bool]$InterruptWork = $false, [object]$LastLifecycle = $null) {
    $isLifecycleManaged = [bool](Get-ObjectProperty $ServerInfo.meta 'desktop_managed') -or [bool](Get-ObjectProperty $LastLifecycle 'managed')
    if ($isLifecycleManaged) {
        if ($InterruptWork) {
            if ((Get-ObjectProperty $LastLifecycle 'hot_switch_prepared') -eq $true) {
                try { Lifecycle $ServerInfo.instance 'cancel-update' | Out-Null } catch { Write-Warning "cancel-update failed ($($ServerInfo.kikiHome)): $($_.Exception.Message)" }
            }
            try {
                Lifecycle $ServerInfo.instance 'update' $true | Out-Null
            } catch {
                Write-Warning ("Lifecycle 'update' (interrupt_work=true) failed ({0}): {1}. Proceeding to bounded shutdown." -f $ServerInfo.kikiHome, $_.Exception.Message)
            }
        } else {
            Lifecycle $ServerInfo.instance 'update' | Out-Null
        }
        return
    }
    try {
        Call-Local $ServerInfo.instance 'shutdown' @{} 15 $ServerInfo.ownerToken | Out-Null
    } catch {
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        $response = if ($null -ne $responseProperty) { $responseProperty.Value } else { $null }
        $statusCode = if ($null -ne $response) { try { [int]$response.StatusCode } catch { 0 } } else { 0 }
        if ($statusCode -eq 404) {
            Lifecycle $ServerInfo.instance 'update' $InterruptWork | Out-Null
            return
        }
        if ($InterruptWork) {
            Write-Warning ("Headless shutdown failed ({0}): {1}. Proceeding to bounded shutdown." -f $ServerInfo.kikiHome, $_.Exception.Message)
            return
        }
        throw
    }
}

function Get-ExpectedDesktopPathForServer([object]$ServerInfo) {
    $exePath = Get-ObjectProperty $ServerInfo 'executablePath'
    if (-not [string]::IsNullOrWhiteSpace([string]$exePath)) {
        return Join-Path (Split-Path -Parent ([string]$exePath)) 'kiki-desktop.exe'
    }
    return Join-Path (Get-ReleasePath $runtime $ServerInfo.releaseId) 'kiki-desktop.exe'
}

function Save-State { Write-AtomicUtf8Json $statePath $state }

function Save-Report {
    $reportVar = Get-Variable -Name 'report' -Scope Script -ErrorAction SilentlyContinue
    if ($null -ne $reportVar -and $null -ne $reportVar.Value) {
        try {
            Write-AtomicUtf8Json $reportPath $reportVar.Value
        } catch {
            Write-Warning "Failed to write hot-switch report to ${reportPath}: $($_.Exception.Message)"
        }
    }
}

function Get-SessionActiveTaskCount([object]$Instance, [string]$SessionId, [object]$Control) {
    $encodedSid = [Uri]::EscapeDataString($SessionId)
    # Prefer cross-owner /agent-tasks (covers main + every child subagent without opening cold agents).
    try {
        $total = 0
        $pageToken = $null
        for ($page = 0; $page -lt 10; $page++) {
            $path = "sessions/$encodedSid/agent-tasks?page_size=100"
            if (-not [string]::IsNullOrWhiteSpace($pageToken)) {
                $path += "&page_token=$([Uri]::EscapeDataString($pageToken))"
            }
            $data = Call-Local $Instance $path
            $items = @(Get-ObjectProperty $data 'items')
            foreach ($item in $items) {
                if ($null -eq $item) { continue }
                $status = [string](Get-ObjectProperty $item 'status')
                $source = [string](Get-ObjectProperty $item 'source')
                if ($status -eq 'running' -and ([string]::IsNullOrWhiteSpace($source) -or $source -eq 'live')) {
                    $total += 1
                }
            }
            $hasMore = [bool](Get-ObjectProperty $data 'has_more')
            $nextToken = [string](Get-ObjectProperty $data 'next_page_token')
            if (-not $hasMore -or [string]::IsNullOrWhiteSpace($nextToken)) { break }
            $pageToken = $nextToken
        }
        return $total
    } catch {
    }
    # Fall back to main-owner /tasks for older servers/fixtures.
    try {
        $total = 0
        $offset = 0
        for ($page = 0; $page -lt 10; $page++) {
            $tasksData = Call-Local $Instance ("sessions/{0}/tasks?status=running&page_size=100&offset={1}" -f $encodedSid, $offset)
            $items = @(Get-ObjectProperty $tasksData 'items')
            $total += $items.Count
            $hasMore = [bool](Get-ObjectProperty $tasksData 'has_more')
            if (-not $hasMore -or $items.Count -eq 0) { break }
            $nextOffset = Get-ObjectProperty $tasksData 'next_offset'
            $offset = if ($null -ne $nextOffset) { [int]$nextOffset } else { $offset + $items.Count }
        }
        return $total
    } catch {
        $agents = @(Get-ObjectProperty $Control 'agents')
        $activeAgents = @($agents | Where-Object { $null -ne $_ -and (Get-ObjectProperty $_ 'state') -in @('settling', 'running') })
        if ($activeAgents.Count -gt 0) { return $activeAgents.Count }
        $taskId = Get-ObjectProperty $Control 'taskId'
        $receiptId = Get-ObjectProperty $Control 'terminalReceiptId'
        if (-not [string]::IsNullOrWhiteSpace([string]$taskId) -and [string]::IsNullOrWhiteSpace([string]$receiptId)) { return 1 }
        return 0
    }
}

function Get-LiveInspectionSnapshot([object]$ServerInfo, [object[]]$Shells = @(), [switch]$AppScopeOnly) {
    if ($null -eq $ServerInfo) {
        return [ordered]@{
            server = $null
            shells = @($Shells | ForEach-Object { [ordered]@{ pid = [int]$_.Id; executablePath = (Get-ProcessPathSafe $_) } })
            lifecycle = $null
            workPendingSessions = @()
            appScopeOnly = [bool]$AppScopeOnly
        }
    }
    $lifecycle = Lifecycle $ServerInfo.instance ''
    $pendingDetails = New-Object System.Collections.Generic.List[object]
    if (-not $AppScopeOnly) {
        foreach ($sid in @($lifecycle.work_pending)) {
            $control = $null
            $readError = $null
            try { $control = Execution $ServerInfo.instance $sid 'read' }
            catch { $readError = $_.Exception.Message }
            $agents = @(Get-ObjectProperty $control 'agents')
            $activeTaskCount = if ($null -ne $control) { Get-SessionActiveTaskCount $ServerInfo.instance $sid $control } else { 0 }
            $pendingDetails.Add([ordered]@{
                sessionId = $sid
                phase = if ($null -ne $control) { [string](Get-ObjectProperty $control 'phase') } else { 'unknown' }
                pauseOperationId = if ($null -ne $control) { Get-ObjectProperty $control 'pauseOperationId' } else { $null }
                activeTaskCount = $activeTaskCount
                agentCount = $agents.Count
                agents = @($agents | ForEach-Object {
                    [ordered]@{
                        agentId = Get-ObjectProperty $_ 'agentId'
                        state = Get-ObjectProperty $_ 'state'
                        resumable = Get-ObjectProperty $_ 'resumable'
                    }
                })
                error = $readError
            })
        }
    }
    return [ordered]@{
        server = [ordered]@{
            server_id = [string](Get-ObjectProperty $ServerInfo.meta 'server_id')
            pid = [int]$ServerInfo.process.Id
            port = [int](Get-ObjectProperty $ServerInfo.instance 'port')
            executablePath = [string]$ServerInfo.executablePath
            layout = [string]$ServerInfo.layout
            releaseId = [string]$ServerInfo.releaseId
            build_id = Get-ObjectProperty $ServerInfo.meta 'build_id'
            server_version = Get-ObjectProperty $ServerInfo.meta 'server_version'
            server_home_id = [string](Get-ObjectProperty $ServerInfo.meta 'server_home_id')
            current_space_id = [string](Get-ObjectProperty $ServerInfo.meta 'current_space_id')
            desktop_managed = [bool](Get-ObjectProperty $ServerInfo.meta 'desktop_managed')
        }
        shells = @($Shells | ForEach-Object { [ordered]@{ pid = [int]$_.Id; executablePath = (Get-ProcessPathSafe $_) } })
        lifecycle = [ordered]@{
            managed = [bool](Get-ObjectProperty $lifecycle 'managed')
            draining = [bool](Get-ObjectProperty $lifecycle 'draining')
            hot_switch_prepared = [bool](Get-ObjectProperty $lifecycle 'hot_switch_prepared')
            work_pending = @($lifecycle.work_pending)
        }
        workPendingSessions = $pendingDetails.ToArray()
        appScopeOnly = [bool]$AppScopeOnly
    }
}

function New-CanaryOwnerToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Invoke-CanaryCheck([string]$ServerExePath, [string]$ExpectedBuildId = '', [int]$TimeoutSeconds = 0, [string]$ServerEntryPath = '') {
    if (-not (Test-Path -LiteralPath $ServerExePath -PathType Leaf)) {
        throw "Canary server executable is missing: $ServerExePath"
    }
    if (-not [string]::IsNullOrWhiteSpace($ServerEntryPath) -and (-not (Test-Path -LiteralPath $ServerEntryPath -PathType Leaf))) {
        throw "Canary server entry is missing: $ServerEntryPath"
    }
    $artifactSha256 = Get-Sha256 $ServerExePath
    $canaryHome = Join-Path ([IO.Path]::GetTempPath()) ('kiki-canary-' + [guid]::NewGuid().ToString('N'))
    $canaryInstances = Join-Path $canaryHome 'server\instances'
    $canaryToken = New-CanaryOwnerToken
    $proc = $null
    $canaryPort = 0
    $canaryServerId = $null
    $canaryServerPid = 0
    $canaryManaged = $false
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        [IO.Directory]::CreateDirectory($canaryInstances) | Out-Null
        [IO.File]::WriteAllText((Join-Path $canaryHome 'server.local-owner'), $canaryToken + "`n", (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText((Join-Path $canaryHome 'config.toml'), "[search]`nenabled = false`n", (New-Object Text.UTF8Encoding($false)))

        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $ServerExePath
        $psi.Arguments = if (-not [string]::IsNullOrWhiteSpace($ServerEntryPath)) {
            ('{0} serve --port 0 --idle-exit 2m' -f (Format-WindowsProcessArgument $ServerEntryPath))
        } else {
            'serve --port 0 --idle-exit 2m'
        }
        $psi.WorkingDirectory = Split-Path -Parent $ServerExePath
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.EnvironmentVariables['KIKI_HOME'] = $canaryHome
        $psi.EnvironmentVariables['KIKI_SEARCH_DISABLED'] = '1'
        if (-not [string]::IsNullOrWhiteSpace($ServerEntryPath)) {
            $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
        } elseif ($psi.EnvironmentVariables.ContainsKey('ELECTRON_RUN_AS_NODE')) {
            $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
        }
        # Match desktop sidecar heap injection so production SEA serve does not re-exec into a second PID.
        $existingNodeOpts = if ($psi.EnvironmentVariables.ContainsKey('NODE_OPTIONS')) { [string]$psi.EnvironmentVariables['NODE_OPTIONS'] } else { '' }
        if ($existingNodeOpts -notmatch '--max[-_]old[-_]space[-_]size') {
            $heapFlag = '--max-old-space-size=8192'
            $psi.EnvironmentVariables['NODE_OPTIONS'] = ($existingNodeOpts + ' ' + $heapFlag).Trim()
            $psi.EnvironmentVariables['KIKI_INJECTED_HEAP_OPTION'] = $heapFlag
        }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedBuildId)) {
            $psi.EnvironmentVariables['KIKI_BUILD_ID'] = $ExpectedBuildId
        }
        foreach ($removeKey in @('KIKI_DESKTOP_BUNDLED', 'KIKI_RUNTIME_MANAGED', 'KIKI_NO_RELEASE_REDIRECT')) {
            if ($psi.EnvironmentVariables.ContainsKey($removeKey)) {
                $psi.EnvironmentVariables.Remove($removeKey)
            }
        }
        $proc = [Diagnostics.Process]::Start($psi)
        if ($null -eq $proc) { throw "Failed to start canary process: $ServerExePath" }

        $deadline = if ($TimeoutSeconds -gt 0) { [DateTime]::UtcNow.AddSeconds($TimeoutSeconds) } else { $null }
        $meta = $null
        $lastProbeError = $null
        do {
            if ($proc.HasExited) {
                $detail = if (-not [string]::IsNullOrWhiteSpace($lastProbeError)) { " Last probe error: $lastProbeError" } else { '' }
                throw "Canary server exited prematurely with code $($proc.ExitCode).$detail"
            }
            $ownedPids = @(Get-ProcessTreePids @([int]$proc.Id))
            if ($ownedPids.Count -eq 0) {
                $detail = if (-not [string]::IsNullOrWhiteSpace($lastProbeError)) { " Last probe error: $lastProbeError" } else { '' }
                throw "Canary server lost process liveness before reporting readiness.$detail"
            }
            foreach ($file in @(Get-ChildItem -LiteralPath $canaryInstances -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
                $inst = $null
                $liveToken = $null
                try {
                    $rawInst = Get-Content -LiteralPath $file.FullName -Raw
                    if ([string]::IsNullOrWhiteSpace($rawInst)) { continue }
                    $inst = $rawInst | ConvertFrom-Json
                    $instPid = [int]$inst.pid
                    if ($instPid -le 0 -or [int]$inst.port -le 0) { continue }
                    if ($ownedPids -notcontains $instPid) { continue }
                    if ($inst.host -notin @('127.0.0.1', 'localhost')) { continue }
                    $liveToken = [IO.File]::ReadAllText((Join-Path $canaryHome 'server.local-owner')).Trim()
                } catch {
                    $lastProbeError = $_.Exception.Message
                    continue
                }
                $probeUrl = 'http://127.0.0.1:{0}/api/meta' -f $inst.port
                $headers = @{ Authorization = 'Bearer ' + $liveToken }
                $reply = $null
                try {
                    $reply = Invoke-RestMethod -Uri $probeUrl -Headers $headers -MaximumRedirection 0 -TimeoutSec 5
                } catch {
                    $lastProbeError = $_.Exception.Message
                    $responseProperty = $_.Exception.PSObject.Properties['Response']
                    $response = if ($null -ne $responseProperty) { $responseProperty.Value } else { $null }
                    if ($null -ne $response) {
                        $statusCode = 0
                        try { $statusCode = [int]$response.StatusCode } catch {}
                        throw ("Canary readiness probe returned HTTP {0} from {1}: {2}" -f $statusCode, $probeUrl, $lastProbeError)
                    }
                    $webStatusProp = $_.Exception.PSObject.Properties['Status']
                    $webStatus = if ($null -ne $webStatusProp) { [string]$webStatusProp.Value } else { '' }
                    if ($webStatus -eq 'Timeout') {
                        throw ("Canary readiness probe timed out waiting for HTTP response from {0}: {1}" -f $probeUrl, $lastProbeError)
                    }
                    continue
                }
                if ($null -eq $reply -or ($reply -is [string]) -or $null -eq $reply.PSObject.Properties['code']) {
                    throw ("Canary readiness probe returned invalid response contract from {0}." -f $probeUrl)
                }
                if ($reply.code -ne 0) {
                    throw ("Canary readiness probe API error from {0}: code={1} msg={2}" -f $probeUrl, $reply.code, (Get-ObjectProperty $reply 'msg'))
                }
                $replyData = Get-ObjectProperty $reply 'data'
                if ($null -eq $replyData -or ([string](Get-ObjectProperty $replyData 'server_id')) -cne ([string]$inst.server_id)) {
                    throw ("Canary server_id mismatch from {0}: expected '{1}', got '{2}'." -f $probeUrl, $inst.server_id, (Get-ObjectProperty $replyData 'server_id'))
                }
                $canaryPort = [int]$inst.port
                $canaryServerId = [string]$inst.server_id
                $canaryServerPid = [int]$inst.pid
                $canaryManaged = [bool](Get-ObjectProperty $replyData 'desktop_managed')
                $canaryToken = $liveToken
                $meta = $replyData
                break
            }
            if ($null -ne $meta) { break }
            Start-Sleep -Milliseconds 150
        } while ($null -eq $deadline -or [DateTime]::UtcNow -lt $deadline)

        if ($null -eq $meta) {
            $detail = if (-not [string]::IsNullOrWhiteSpace($lastProbeError)) { " Last probe error: $lastProbeError" } else { '' }
            throw "Canary server did not report /api/meta readiness within ${TimeoutSeconds}s.$detail"
        }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedBuildId) -and ([string](Get-ObjectProperty $meta 'build_id')) -cne $ExpectedBuildId) {
            throw ("Canary server reported build_id '{0}' instead of expected '{1}'." -f (Get-ObjectProperty $meta 'build_id'), $ExpectedBuildId)
        }
        $sw.Stop()
        return [ordered]@{
            passed = $true
            server_id = [string]$meta.server_id
            pid = $canaryServerPid
            build_id = [string](Get-ObjectProperty $meta 'build_id')
            server_version = Get-ObjectProperty $meta 'server_version'
            artifactSha256 = $artifactSha256
            elapsedMs = [int]$sw.ElapsedMilliseconds
            lastProbeError = $lastProbeError
            error = $null
        }
    } finally {
        if ($null -ne $proc) {
            $treePids = @()
            try { $treePids = @(Get-ProcessTreePids @([int]$proc.Id)) } catch {}
            if ($canaryServerPid -gt 0 -and ($treePids -notcontains $canaryServerPid)) {
                $treePids += $canaryServerPid
            }
            try {
                if ($canaryPort -gt 0) {
                    $headers = @{ Authorization = 'Bearer ' + $canaryToken }
                    try {
                        Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/api/shutdown' -f $canaryPort) -Headers $headers -Method Post -MaximumRedirection 0 -TimeoutSec 3 | Out-Null
                    } catch {
                        if ($canaryManaged -and $canaryServerId) {
                            try {
                                $quitBody = @{ action = 'quit'; server_id = $canaryServerId; consent = $true; interrupt_work = $true } | ConvertTo-Json -Compress
                                Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/api/desktop-lifecycle' -f $canaryPort) -Headers $headers -Method Post -ContentType 'application/json' -Body $quitBody -MaximumRedirection 0 -TimeoutSec 3 | Out-Null
                            } catch {}
                        }
                    }
                    try { $null = $proc.WaitForExit(2000) } catch {}
                }
                Stop-ProcessBounded $proc 5000
                foreach ($childPid in @($treePids | Where-Object { $_ -ne $proc.Id })) {
                    $childProc = Get-Process -Id $childPid -ErrorAction SilentlyContinue
                    if ($null -ne $childProc) { Stop-ProcessBounded $childProc 5000 }
                }
            } catch {}
            try { $proc.Dispose() } catch {}
        }
        for ($attempt = 0; $attempt -lt 8; $attempt++) {
            if (-not (Test-Path -LiteralPath $canaryHome)) { break }
            try {
                Remove-Item -LiteralPath $canaryHome -Recurse -Force -ErrorAction Stop
                break
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }
    }
}

function Stop-ProcessBounded([object]$Proc, [int]$WaitMilliseconds = 5000) {
    if ($null -eq $Proc) { return }
    try { $Proc.Refresh() } catch {}
    if ($Proc.HasExited) { return }
    Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue
    try { $null = $Proc.WaitForExit($WaitMilliseconds) } catch {}
    try { $Proc.Refresh() } catch {}
}

function Close-DesktopShell([object]$Shell, [string]$SpaceHome = $homePath) {
    if ($Shell.HasExited) { return }
    $prefsPath = Join-Path $SpaceHome 'desktop.json'
    $hadPrefs = Test-Path -LiteralPath $prefsPath -PathType Leaf
    $prefs = if ($hadPrefs) { Get-Content -LiteralPath $prefsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    $original = $prefs.PSObject.Properties['closeToTray']
    $previous = if ($null -ne $original) { $original.Value } else { $null }
    if ($previous -ne $false) {
        $prefs | Add-Member -NotePropertyName closeToTray -NotePropertyValue $false -Force
        Write-AtomicUtf8Json $prefsPath $prefs
    }
    try {
        $Shell.Refresh()
        if (!$Shell.HasExited) {
            $gracefulWaitMs = [Math]::Max(1000, [Math]::Min($StartupSeconds * 1000, 10000))
            $closedGracefully = $Shell.CloseMainWindow() -and $Shell.WaitForExit($gracefulWaitMs)
            if (-not $closedGracefully) {
                $Shell.Refresh()
                if (!$Shell.HasExited) {
                    Write-Verbose "Desktop shell $($Shell.Id) did not close via MainWindow (tray or hidden); terminating process."
                    Stop-ProcessBounded $Shell 5000
                }
            }
            if (!$Shell.HasExited) {
                throw 'The desktop did not exit after window-close and process termination.'
            }
        }
    } finally {
        if ($previous -ne $false) {
            $prefs = Get-Content -LiteralPath $prefsPath -Raw | ConvertFrom-Json
            if ((Get-ObjectProperty $prefs 'closeToTray') -eq $false) {
                if ($null -eq $original) { $prefs.PSObject.Properties.Remove('closeToTray') } else { $prefs.closeToTray = $previous }
                if (!$hadPrefs -and @($prefs.PSObject.Properties).Count -eq 0) { Remove-Item -LiteralPath $prefsPath }
                else { Write-AtomicUtf8Json $prefsPath $prefs }
            }
        }
    }
}

function Assert-NoUnplannedRuntimeProcesses([object[]]$SpacePlans) {
    $plannedHomeKeys = New-Object 'System.Collections.Generic.HashSet[string]'
    $ownedRootPids = New-Object 'System.Collections.Generic.List[int]'
    foreach ($plan in @($SpacePlans)) {
        $null = $plannedHomeKeys.Add(([string]$plan.kikiHome).ToLowerInvariant())
        if ($null -ne $plan.server -and $null -ne $plan.server.process) {
            $ownedRootPids.Add([int]$plan.server.process.Id)
        }
        $planLauncherPid = [int](Get-ObjectProperty $plan 'launcherPid')
        if ($planLauncherPid -gt 0) {
            $ownedRootPids.Add($planLauncherPid)
        }
        foreach ($sh in @($plan.shells)) {
            if ($null -ne $sh) { $ownedRootPids.Add([int]$sh.Id) }
        }
    }
    $unplannedShells = @(Find-ShellEntries | Where-Object {
        -not $plannedHomeKeys.Contains(([string]$_.kikiHome).ToLowerInvariant())
    })
    if ($unplannedShells.Count -gt 0) {
        $unplannedDesc = ($unplannedShells | ForEach-Object { '{0} (pid {1})' -f $_.kikiHome, $_.pid }) -join ', '
        throw ("Another Kiki desktop space appeared outside the switch plan: {0}. Retry hot-switch so all spaces are fenced and relaunched together." -f $unplannedDesc)
    }
    $ownedTreePids = @(Get-ProcessTreePids $ownedRootPids.ToArray())
    $otherActive = @(Get-OtherActiveServerPids $ownedTreePids)
    if ($otherActive.Count -gt 0) {
        throw ("Another Kiki home/instance is running from active\kiki-server.exe (PIDs: {0}). Close other spaces sharing this runtime before hot-switching." -f ($otherActive -join ', '))
    }
}

function Wait-ForAllExits([object[]]$SpacePlans) {
    $graceSeconds = [Math]::Min($StartupSeconds, $StopGraceSeconds)
    $plannedHomeKeys = New-Object 'System.Collections.Generic.HashSet[string]'
    $plannedShellPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $ownedWorkerPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $serverPidSet = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($plan in $SpacePlans) {
        $null = $plannedHomeKeys.Add(([string]$plan.kikiHome).ToLowerInvariant())
        foreach ($sh in @($plan.shells)) {
            if ($null -ne $sh) { $null = $plannedShellPids.Add([int]$sh.Id) }
        }
        $oldServer = $plan.server
        $null = $serverPidSet.Add([int]$oldServer.process.Id)
        $planLauncherPid = [int](Get-ObjectProperty $plan 'launcherPid')
        if ($planLauncherPid -gt 0) {
            $null = $serverPidSet.Add($planLauncherPid)
        }
        foreach ($treePid in @(Get-ProcessTreePids @([int]$oldServer.process.Id))) {
            if ($treePid -ne [int]$oldServer.process.Id) { $null = $ownedWorkerPids.Add($treePid) }
        }
    }

    # Close all planned desktop shells immediately alongside server update shutdown so Tauri never holds --idle-exit 0ms sidecars open.
    foreach ($plan in $SpacePlans) {
        foreach ($shell in @($plan.shells)) {
            Close-DesktopShell $shell $plan.kikiHome
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($graceSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $allExited = $true
        foreach ($plan in $SpacePlans) {
            try { $plan.server.process.Refresh() } catch {}
            if (-not $plan.server.process.HasExited) {
                $allExited = $false
                break
            }
            $launcherProc = Get-ObjectProperty $plan 'launcherProcess'
            if ($null -ne $launcherProc) {
                try { $launcherProc.Refresh() } catch {}
                if (-not $launcherProc.HasExited) {
                    $allExited = $false
                    break
                }
            }
        }
        if ($allExited) { break }
        Start-Sleep -Milliseconds 150
    }

    foreach ($plan in $SpacePlans) {
        $oldServer = $plan.server
        try { $oldServer.process.Refresh() } catch {}
        if (-not $oldServer.process.HasExited) {
            Write-Warning ("Original service {0} ({1}, pid {2}) did not exit within {3}s; force-stopping original service." -f $oldServer.meta.server_id, $plan.kikiHome, $oldServer.process.Id, $graceSeconds)
            foreach ($treePid in @(Get-ProcessTreePids @([int]$oldServer.process.Id))) {
                if ($treePid -ne [int]$oldServer.process.Id) { $null = $ownedWorkerPids.Add($treePid) }
            }
            Stop-ProcessBounded $oldServer.process 5000
            if (-not $oldServer.process.HasExited) {
                throw ("Original service {0} (pid {1}) could not be terminated." -f $oldServer.meta.server_id, $oldServer.process.Id)
            }
        } else {
            $exitCode = $oldServer.process.ExitCode
            if ($exitCode -ne 0) {
                Write-Warning ("Original service {0} ({1}, pid {2}) exited with code {3} (interrupted={4}); continuing hot switch." -f $oldServer.meta.server_id, $plan.kikiHome, $oldServer.process.Id, $exitCode, [bool]$plan.interruptedAfterSettle)
            }
        }
        $launcherProc = Get-ObjectProperty $plan 'launcherProcess'
        if ($null -ne $launcherProc) {
            try { $launcherProc.Refresh() } catch {}
            if (-not $launcherProc.HasExited) {
                Write-Warning ("Original heap launcher (pid {0}) for {1} did not exit within {2}s; force-stopping launcher." -f $launcherProc.Id, $plan.kikiHome, $graceSeconds)
                Stop-ProcessBounded $launcherProc 5000
                if (-not $launcherProc.HasExited) {
                    throw ("Original heap launcher (pid {0}) for {1} could not be terminated." -f $launcherProc.Id, $plan.kikiHome)
                }
            }
        }
        $oldInstancePath = Join-Path (Join-Path $plan.kikiHome 'server\instances') ($oldServer.meta.server_id + '.json')
        if (Test-Path -LiteralPath $oldInstancePath -PathType Leaf) {
            Write-Warning ("Removing leftover instance registration after old service exit: {0}" -f $oldInstancePath)
            Remove-Item -LiteralPath $oldInstancePath -Force -ErrorAction SilentlyContinue
        }
        foreach ($regPid in @(Get-HomeRegisteredServerPids $plan.kikiHome)) {
            if (-not $serverPidSet.Contains($regPid)) { $null = $ownedWorkerPids.Add($regPid) }
        }
    }

    foreach ($workerPid in @($ownedWorkerPids)) {
        $lingeringWorker = Get-Process -Id $workerPid -ErrorAction SilentlyContinue
        if ($null -ne $lingeringWorker -and (-not $lingeringWorker.HasExited)) {
            Write-Warning ("Stopping lingering worker process {0} owned by old service." -f $lingeringWorker.Id)
            Stop-ProcessBounded $lingeringWorker 5000
        }
    }
    # Close ONLY leftover shells belonging to planned homes (never touch an unplanned space opened mid-switch).
    foreach ($entry in @(Find-ShellEntries | Where-Object {
        $plannedHomeKeys.Contains(([string]$_.kikiHome).ToLowerInvariant()) -or $plannedShellPids.Contains([int]$_.pid)
    })) {
        try { $entry.process.EnableRaisingEvents = $true; $null = $entry.process.Handle } catch {}
        Close-DesktopShell $entry.process $entry.kikiHome
    }
    $otherActive = @(Get-OtherActiveServerPids @())
    if ($otherActive.Count -gt 0) {
        throw ("Another Kiki home/instance is holding active\kiki-server.exe (PIDs: {0}); cannot sync active runtime." -f ($otherActive -join ', '))
    }
    foreach ($plan in $SpacePlans) {
        $allowHeadlessCheck = -not [bool](Get-ObjectProperty $plan 'hadDesktop')
        if ($null -ne (Find-Server $plan.kikiHome $plan.ownerToken -AllowHeadless:$allowHeadlessCheck)) {
            throw ("Another managed service appeared in {0} before launch." -f $plan.kikiHome)
        }
    }
    $remainingShells = @(Find-ShellEntries)
    if ($remainingShells.Count -gt 0) {
        $remainingDesc = ($remainingShells | ForEach-Object { '{0} (pid {1})' -f $_.kikiHome, $_.pid }) -join ', '
        throw ("Another desktop shell appeared outside the switch plan before launch: {0}" -f $remainingDesc)
    }
    $fixedHeadlessPorts = @(
        foreach ($plan in $SpacePlans) {
            if ([bool](Get-ObjectProperty $plan 'hadDesktop')) { continue }
            $ep = Get-ExpectedHeadlessPort $plan
            if ($null -eq $ep -and $null -ne $plan.server -and [int]$plan.server.instance.port -gt 0) {
                $ep = Resolve-ExpectedHeadlessPort $false ([string](Get-ObjectProperty $plan 'headlessLaunchArgs')) $plan.server.instance.port
            }
            if ($null -ne $ep -and $ep -gt 0) { [int]$ep }
        }
    )
    if ($fixedHeadlessPorts.Count -gt 0) {
        Wait-ForPortsReleased $fixedHeadlessPorts 15
    }
}

function Await-AllReleases([object[]]$SpaceStates, [string]$ReleaseId, [string]$ExpectedBuildId, [hashtable]$LaunchersByHome, [hashtable]$TokensByHome) {
    if ([string]::IsNullOrWhiteSpace($ExpectedBuildId)) {
        throw 'Expected build commit is required when awaiting a switched release.'
    }
    $targetReleaseDir = if ($ReleaseId -match '^[0-9a-f]{24}-[0-9a-f]{24}$') { Get-ReleasePath $runtime $ReleaseId } else { $null }
    $targetSchema = if ($null -ne $targetReleaseDir -and (Test-Path -LiteralPath $targetReleaseDir -PathType Container)) {
        Get-DirectoryReleaseSchemaVersion $targetReleaseDir
    } else {
        $activeMan = Read-ActiveManifest $runtime -AllowMissing
        if ($null -ne $activeMan) { Get-ManifestSchemaVersion $activeMan } else { 1 }
    }
    $expectedActiveDesktop = Join-Path (Get-ActivePath $runtime) 'kiki-desktop.exe'
    $expectedActiveServer = if ($targetSchema -eq 2) { $expectedActiveDesktop } else { Join-Path (Get-ActivePath $runtime) 'kiki-server.exe' }
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupSeconds)
    $readyByKey = @{}
    do {
        $shellEntries = @(Find-ShellEntries)
        foreach ($spaceState in $SpaceStates) {
            $key = ([string]$spaceState.kikiHome).ToLowerInvariant()
            if ($readyByKey.ContainsKey($key)) { continue }
            $spaceToken = $TokensByHome[$key]
            $isHeadlessSpace = -not [bool]$spaceState.hadDesktop
            $new = Find-Server $spaceState.kikiHome $spaceToken -AllowHeadless:$isHeadlessSpace
            if ($null -ne $new) {
                $newServerId = [string](Get-ObjectProperty $new.meta 'server_id')
                $newHomeId = [string](Get-ObjectProperty $new.meta 'server_home_id')
                $newSpaceId = [string](Get-ObjectProperty $new.meta 'current_space_id')
                if ($new.releaseId -cne $ReleaseId -or $newServerId -ceq $spaceState.oldServerId `
                    -or $newHomeId -cne $spaceState.serverHomeId -or $newSpaceId -cne $spaceState.spaceId) {
                    throw ("The service that started for {0} does not match the selected release and home." -f $spaceState.kikiHome)
                }
                $newMetaBuildId = [string](Get-ObjectProperty $new.meta 'build_id')
                $newInstBuildId = [string](Get-ObjectProperty $new.instance 'build_id')
                if ($newMetaBuildId -cne $ExpectedBuildId -or $newInstBuildId -cne $ExpectedBuildId) {
                    throw ("The started service for {0} reported build_id '{1}' instead of expected commit '{2}'." -f $spaceState.kikiHome, $newMetaBuildId, $ExpectedBuildId)
                }
                $newExePath = Get-ObjectProperty $new 'executablePath'
                if (-not [string]::IsNullOrWhiteSpace([string]$newExePath) -and ([string]$newExePath) -ine $expectedActiveServer) {
                    throw ("The started service for {0} is running from '{1}' instead of active path '{2}'." -f $spaceState.kikiHome, $newExePath, $expectedActiveServer)
                }
                if ([bool]$spaceState.hadDesktop) {
                    $matchingActiveShells = @($shellEntries | Where-Object {
                        $_.kikiHome.ToLowerInvariant() -ceq $key -and $_.executablePath -ieq $expectedActiveDesktop
                    })
                    if ($matchingActiveShells.Count -lt 1) {
                        continue
                    }
                } else {
                    $expectedPort = Get-ExpectedHeadlessPort $spaceState
                    if ($null -ne $expectedPort -and $expectedPort -gt 0 -and [int]$new.instance.port -ne $expectedPort) {
                        throw ("The started headless service for {0} bound port {1} instead of required fixed port {2}." -f $spaceState.kikiHome, $new.instance.port, $expectedPort)
                    }
                }
                if (-not (Test-ServerHealthz $new.instance $spaceToken)) {
                    continue
                }
                $readyByKey[$key] = $new
                continue
            }
            $launcher = $LaunchersByHome[$key]
            if ($null -ne $launcher -and $launcher.HasExited -and $launcher.ExitCode -ne 0) {
                throw ("The selected desktop for {0} exited with code {1} before its service was ready." -f $spaceState.kikiHome, $launcher.ExitCode)
            }
        }
        if ($readyByKey.Count -eq $SpaceStates.Count) {
            return $readyByKey
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $missing = @($SpaceStates | Where-Object { -not $readyByKey.ContainsKey(([string]$_.kikiHome).ToLowerInvariant()) } | ForEach-Object { $_.kikiHome })
    throw ("The selected release did not start its local service before the startup deadline for: {0}" -f ($missing -join ', '))
}

function Test-InstalledRelease([string]$ReleaseId) {
    if ([string]::IsNullOrWhiteSpace($ReleaseId) -or $ReleaseId -notmatch '^[0-9a-f]{24}-[0-9a-f]{24}$') { return $false }
    try {
        $path = Get-ReleasePath $runtime $ReleaseId
        $desktopPath = Join-Path $path 'kiki-desktop.exe'
        if (-not (Test-Path -LiteralPath $desktopPath -PathType Leaf)) { return $false }
        $schema = Get-DirectoryReleaseSchemaVersion $path
        if ($schema -eq 2) {
            $v2 = Resolve-V2Layout $path
            if ($null -eq $v2) { return $false }
            $serverEntryPath = Join-Path $path $v2.ServerEntryRel
            $nativeAddonsPath = Join-Path $path $v2.NativeAddonsRel
            if (-not (Test-Path -LiteralPath $serverEntryPath -PathType Leaf) -or -not (Test-Path -LiteralPath $nativeAddonsPath -PathType Leaf)) {
                return $false
            }
            if ($v2.IsUnpacked -and (-not (Test-Path -LiteralPath (Join-Path $path $v2.AppAsarRel) -PathType Leaf))) {
                return $false
            }
            $desktop = Get-ArtifactInfo $desktopPath 'Installed Kiki GUI'
            $serverEntry = Get-ArtifactInfo $serverEntryPath 'Installed Kiki server entry'
            $null = Get-ArtifactInfo $nativeAddonsPath 'Installed Kiki native addon manifest'
            return (('{0}-{1}' -f $desktop.Hash.Substring(0,24), $serverEntry.Hash.Substring(0,24)) -ceq $ReleaseId)
        }
        $serverPath = Join-Path $path 'kiki-server.exe'
        if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
            return $false
        }
        $desktop = Get-ArtifactInfo $desktopPath 'Installed Kiki GUI'
        $server = Get-ArtifactInfo $serverPath 'Installed Kiki backend'
        return (('{0}-{1}' -f $desktop.Hash.Substring(0,24), $server.Hash.Substring(0,24)) -ceq $ReleaseId)
    } catch {
        return $false
    }
}

function Select-InstalledRelease([string]$ReleaseId, [string]$BuildId, [string]$Label = 'Selected', [switch]$RequireActiveSync) {
    $path = Get-ReleasePath $runtime $ReleaseId
    $schema = Get-DirectoryReleaseSchemaVersion $path
    $desktop = Get-ArtifactInfo (Join-Path $path 'kiki-desktop.exe') "$Label Kiki GUI"
    if ($schema -eq 2) {
        $v2 = Resolve-V2Layout $path
        if ($null -eq $v2) {
            throw "The $($Label.ToLowerInvariant()) release directory is missing v2 server-entry.mjs or native-addons.json."
        }
        $serverEntry = Get-ArtifactInfo (Join-Path $path $v2.ServerEntryRel) "$Label Kiki server entry"
        $nativeAddons = Get-ArtifactInfo (Join-Path $path $v2.NativeAddonsRel) "$Label Kiki native addon manifest"
        if (('{0}-{1}' -f $desktop.Hash.Substring(0,24), $serverEntry.Hash.Substring(0,24)) -cne $ReleaseId) {
            throw "The $($Label.ToLowerInvariant()) binaries no longer match their installed release. Restore the release files before continuing."
        }
        $manifestObj = [ordered]@{
            schemaVersion = 2; runtimeKind = 'electron-single-binary'; releaseId = $ReleaseId; gitSha = $BuildId; promotedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        if ($v2.IsUnpacked) {
            $manifestObj['serverEntry'] = $v2.ServerEntryPosix
            $manifestObj['nativeAddons'] = $v2.NativeAddonsPosix
        }
        $manifestObj['files'] = [ordered]@{
            'kiki-desktop.exe' = @{ sha256 = $desktop.Hash; bytes = $desktop.Length }
            'server-entry.mjs' = @{ sha256 = $serverEntry.Hash; bytes = $serverEntry.Length }
            'native-addons.json' = @{ sha256 = $nativeAddons.Hash; bytes = $nativeAddons.Length }
        }
        Write-AtomicUtf8Json (Join-Path $runtime 'current.json') $manifestObj
        if ($RequireActiveSync) {
            Sync-ActiveRelease $runtime $ReleaseId $BuildId $desktop $null -SchemaVersion 2 -ExpectedServerEntry $serverEntry -ExpectedNativeAddons $nativeAddons | Out-Null
        } else {
            Sync-ActiveRelease $runtime $ReleaseId $BuildId $desktop $null -SkipIfLocked -SchemaVersion 2 -ExpectedServerEntry $serverEntry -ExpectedNativeAddons $nativeAddons | Out-Null
        }
        return
    }
    $server = Get-ArtifactInfo (Join-Path $path 'kiki-server.exe') "$Label Kiki backend"
    if (('{0}-{1}' -f $desktop.Hash.Substring(0,24), $server.Hash.Substring(0,24)) -cne $ReleaseId) {
        throw "The $($Label.ToLowerInvariant()) binaries no longer match their installed release. Restore the release files before continuing."
    }
    Publish-CliExecutable $runtime $server.Path $server | Out-Host
    Write-AtomicUtf8Json (Join-Path $runtime 'current.json') ([ordered]@{
        schemaVersion = 1; releaseId = $ReleaseId; gitSha = $BuildId; promotedAtUtc = [DateTime]::UtcNow.ToString('o')
        files = @{ 'kiki-desktop.exe' = @{ sha256 = $desktop.Hash; bytes = $desktop.Length }; 'kiki-server.exe' = @{ sha256 = $server.Hash; bytes = $server.Length } }
    })
    if ($RequireActiveSync) {
        Sync-ActiveRelease $runtime $ReleaseId $BuildId $desktop $server -SchemaVersion 1 | Out-Null
    } else {
        Sync-ActiveRelease $runtime $ReleaseId $BuildId $desktop $server -SkipIfLocked -SchemaVersion 1 | Out-Null
    }
}

function Restore-OriginalRelease([switch]$RequireActiveSync) {
    Select-InstalledRelease $state.oldReleaseId $state.oldBuildId 'Original' -RequireActiveSync:$RequireActiveSync
}

function Stop-ReleaseProcesses([string]$ReleaseId, [object[]]$Launchers = @(), [string[]]$SpaceHomes = @($homePath)) {
    # Bind cleanup strictly to launcher process trees and instances registered in our managed spaces.
    $ownedPids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($launcher in @($Launchers)) {
        if ($null -eq $launcher) { continue }
        foreach ($treePid in @(Get-ProcessTreePids @([int]$launcher.Id))) {
            $null = $ownedPids.Add($treePid)
        }
        Stop-ProcessBounded $launcher 5000
    }
    $serverEntriesForStop = @(Find-RuntimeServerEntries $SpaceHomes)
    $serverEntryByPidForStop = @{}
    foreach ($srvEnt in $serverEntriesForStop) {
        $serverEntryByPidForStop[[int]$srvEnt.pid] = $srvEnt
    }
    foreach ($spaceHome in @($SpaceHomes)) {
        if ([string]::IsNullOrWhiteSpace($spaceHome)) { continue }
        foreach ($regPid in @(Get-HomeRegisteredServerPids $spaceHome)) {
            foreach ($treePid in @(Get-ProcessTreePids @($regPid))) {
                $null = $ownedPids.Add($treePid)
            }
            if ($serverEntryByPidForStop.ContainsKey($regPid) -and $serverEntryByPidForStop[$regPid].launcherPid -gt 0) {
                $null = $ownedPids.Add([int]$serverEntryByPidForStop[$regPid].launcherPid)
            }
        }
        $homeKeyStop = $spaceHome.ToLowerInvariant()
        foreach ($srvEnt in $serverEntriesForStop) {
            if (-not [string]::IsNullOrWhiteSpace($srvEnt.kikiHome) -and $srvEnt.kikiHome.ToLowerInvariant() -ceq $homeKeyStop) {
                if ([string]::IsNullOrWhiteSpace($ReleaseId) -or $srvEnt.binaryInfo.releaseId -ceq $ReleaseId) {
                    foreach ($treePid in @(Get-ProcessTreePids @([int]$srvEnt.pid))) {
                        $null = $ownedPids.Add($treePid)
                    }
                    if ($srvEnt.launcherPid -gt 0) {
                        $null = $ownedPids.Add([int]$srvEnt.launcherPid)
                    }
                }
            }
        }
    }
    $shellHomeByPid = @{}
    foreach ($entry in @(Find-ShellEntries)) {
        $shellHomeByPid[[int]$entry.pid] = [string]$entry.kikiHome
    }
    foreach ($ownedPid in @($ownedPids)) {
        $proc = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
        if ($null -eq $proc -or $proc.HasExited) { continue }
        if ($proc.ProcessName -ieq 'kiki-desktop') {
            try { $proc.EnableRaisingEvents = $true; $null = $proc.Handle } catch {}
            $shellHome = if ($shellHomeByPid.ContainsKey($ownedPid)) { $shellHomeByPid[$ownedPid] } else { $homePath }
            Close-DesktopShell $proc $shellHome
        } else {
            Stop-ProcessBounded $proc 5000
        }
    }
    foreach ($spaceHome in @($SpaceHomes)) {
        if ([string]::IsNullOrWhiteSpace($spaceHome)) { continue }
        $spaceInstances = Join-Path $spaceHome 'server\instances'
        foreach ($file in Get-ChildItem -LiteralPath $spaceInstances -Filter '*.json' -File -ErrorAction SilentlyContinue) {
            try {
                $instance = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
                if ($null -eq (Get-Process -Id $instance.pid -ErrorAction SilentlyContinue)) {
                    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
                }
            } catch {}
        }
    }
}

function Format-ServerMetaReport([object]$ServerInfo) {
    if ($null -eq $ServerInfo) { return $null }
    return [ordered]@{
        server_id = [string](Get-ObjectProperty $ServerInfo.meta 'server_id')
        pid = [int]$ServerInfo.process.Id
        executablePath = [string]$ServerInfo.executablePath
        layout = [string]$ServerInfo.layout
        releaseId = [string]$ServerInfo.releaseId
        build_id = Get-ObjectProperty $ServerInfo.meta 'build_id'
        server_version = Get-ObjectProperty $ServerInfo.meta 'server_version'
        server_home_id = [string](Get-ObjectProperty $ServerInfo.meta 'server_home_id')
        current_space_id = [string](Get-ObjectProperty $ServerInfo.meta 'current_space_id')
    }
}

function Release-OurPauses([object]$Target, [bool]$AllowCancel, [object[]]$Sessions = $null, [switch]$ReturnResult) {
    $rawSessions = if ($null -ne $Sessions) { $Sessions } else { Get-ObjectProperty $state 'sessions' }
    $sessionList = @(if ($null -ne $rawSessions) { @($rawSessions) | Where-Object { $null -ne $_ } })
    $failures = @()
    $resumed = @()
    $failureRecords = @()
    foreach ($item in $sessionList) {
        if ($null -eq $item) { continue }
        try {
            $actual = Execution $Target.instance $item.id 'read'
            if ((Get-ObjectProperty $actual 'pauseOperationId') -cne $item.pauseId) { continue }
            $action = switch ($actual.phase) {
                'running' { continue }
                'idle' { if ($AllowCancel) { continue } else { throw "Session $($item.id) needs inspection: $($actual.phase)." } }
                'paused' { 'resume' }
                'pausing' { if ($AllowCancel) { 'cancelPause' } else { throw "Session $($item.id) is still pausing." } }
                'failed' {
                    if ($null -ne (Get-ObjectProperty $actual 'pausedAt')) { 'resume' }
                    elseif ($AllowCancel) { 'cancelPause' }
                    else { throw "Session $($item.id) needs inspection: $($actual.phase)." }
                }
                default { throw "Session $($item.id) needs inspection: $($actual.phase)." }
            }
            if (!$action) { continue }
            $result = Execution $Target.instance $item.id $action @(@{ operationId = "$($item.pauseId):$action"; pauseOperationId = $item.pauseId })
            if ($result.phase -ne 'running' -and (-not ($AllowCancel -and $result.phase -eq 'idle'))) {
                throw "Session $($item.id) did not return to running."
            }
            $resumed += [string]$item.id
            Write-Host "Continued $($item.id)"
        } catch {
            $msg = $_.Exception.Message
            Write-Warning "Failed to release pause on $($item.id): $msg"
            $failures += "$($item.id): $msg"
            $spaceHomeVal = Get-ObjectProperty $Target 'kikiHome'
            $failureRecords += [ordered]@{ sessionId = [string]$item.id; kikiHome = $spaceHomeVal; error = $msg }
        }
    }
    if ($ReturnResult) {
        return [pscustomobject]@{
            resumed = @($resumed)
            failures = @($failures)
            failureRecords = @($failureRecords)
        }
    }
    $reportVar = Get-Variable -Name 'report' -Scope Script -ErrorAction SilentlyContinue
    if ($null -ne $reportVar -and $null -ne $reportVar.Value) {
        $reportVar.Value.resumedSessions = @($resumed)
        $reportVar.Value.resumeFailures = @($failureRecords)
    }
    if ($failures.Count -gt 0) {
        throw ("Failed to release $($failures.Count) paused session(s): " + ($failures -join '; '))
    }
}

function Release-OurPausesForAllSpaces([hashtable]$TargetsByHome, [object[]]$SpaceStates, [bool]$AllowCancel) {
    $allResumed = @()
    $allFailures = @()
    $allFailureRecords = @()
    foreach ($spaceState in @($SpaceStates)) {
        $key = ([string]$spaceState.kikiHome).ToLowerInvariant()
        $target = $TargetsByHome[$key]
        if ($null -eq $target) { continue }
        $spaceAllowCancel = $AllowCancel -or [bool](Get-ObjectProperty $spaceState 'interruptedAfterSettle')
        $res = Release-OurPauses $target $spaceAllowCancel @(Get-ObjectProperty $spaceState 'sessions') -ReturnResult
        $allResumed += $res.resumed
        $allFailures += $res.failures
        $allFailureRecords += $res.failureRecords
    }
    $reportVar = Get-Variable -Name 'report' -Scope Script -ErrorAction SilentlyContinue
    if ($null -ne $reportVar -and $null -ne $reportVar.Value) {
        $reportVar.Value.resumedSessions = @($allResumed)
        $reportVar.Value.resumeFailures = @($allFailureRecords)
    }
    if ($allFailures.Count -gt 0) {
        throw ("Failed to release $($allFailures.Count) paused session(s): " + ($allFailures -join '; '))
    }
}

function Clear-SwitchControlsForAllSpaces([hashtable]$TargetsByHome, [object[]]$SpaceStates, [bool]$AllowCancel) {
    $fenceFailures = @()
    foreach ($spaceState in @($SpaceStates)) {
        $key = ([string]$spaceState.kikiHome).ToLowerInvariant()
        $target = $TargetsByHome[$key]
        if ($null -eq $target) { continue }
        if ([bool](Get-ObjectProperty $target.meta 'desktop_managed') -and (Get-ObjectProperty (Lifecycle $target.instance '') 'hot_switch_prepared') -eq $true) {
            Lifecycle $target.instance 'cancel-update' | Out-Null
        }
        $fenceOpId = [string](Get-ObjectProperty $spaceState 'fenceOperationId')
        if (-not [string]::IsNullOrWhiteSpace($fenceOpId)) {
            $cancelResult = @{}
            Try-RuntimeSwitch $target.instance $fenceOpId 'cancel' $cancelResult
            if (-not [bool]$cancelResult.released) {
                $errDetail = if (-not [string]::IsNullOrWhiteSpace([string]$cancelResult.error)) { [string]$cancelResult.error } else { 'fence cancel unconfirmed' }
                $fenceFailures += ("{0}: {1}" -f $spaceState.kikiHome, $errDetail)
            }
        }
    }
    $pauseError = $null
    try {
        Release-OurPausesForAllSpaces $TargetsByHome $SpaceStates $AllowCancel
    } catch {
        $pauseError = $_.Exception.Message
    }
    if ($fenceFailures.Count -gt 0 -or $null -ne $pauseError) {
        $parts = @()
        if ($fenceFailures.Count -gt 0) { $parts += ('Failed to release admission fence(s): ' + ($fenceFailures -join '; ')) }
        if ($null -ne $pauseError) { $parts += $pauseError }
        throw ($parts -join ' | ')
    }
}

function Ensure-TrayHostRunning([object[]]$SpaceStates) {
    if ($SkipTrayHost) { return $false }
    if (-not [Environment]::UserInteractive) { return $false }
    if (@(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue).Count -eq 0) { return $false }
    $hasHeadless = @($SpaceStates | Where-Object { -not [bool]$_.hadDesktop }).Count -gt 0
    if (-not $hasHeadless) { return $false }
    if (@(Find-ShellEntries).Count -gt 0) { return $false }
    try {
        Invoke-Launch $runtime $homePath -TrayOnly | Out-Null
        return $true
    } catch {
        Write-Warning ("Could not start Kiki tray host for background space(s): {0}" -f $_.Exception.Message)
        return $false
    }
}

function Start-AllSpaces([object[]]$SpaceStates) {
    $fixedHeadlessPorts = @(
        foreach ($sp in @($SpaceStates)) {
            $ep = Get-ExpectedHeadlessPort $sp
            if ($null -ne $ep -and $ep -gt 0) { [int]$ep }
        }
    )
    if ($fixedHeadlessPorts.Count -gt 0) {
        Wait-ForPortsReleased $fixedHeadlessPorts 15
    }
    $launchers = @{}
    foreach ($spaceState in @($SpaceStates)) {
        $key = ([string]$spaceState.kikiHome).ToLowerInvariant()
        if ([bool]$spaceState.hadDesktop) {
            $passHome = [bool](Get-ObjectProperty $spaceState 'passHomeArg')
            $launchers[$key] = Invoke-Launch $runtime ([string]$spaceState.kikiHome) -PassThru -Background:$Background -PassHomeArg:$passHome
        } else {
            $headlessArgs = [string](Get-ObjectProperty $spaceState 'headlessLaunchArgs')
            if ([string]::IsNullOrWhiteSpace($headlessArgs)) {
                $headlessArgs = if ([bool](Get-ObjectProperty $spaceState 'isPrimary')) { 'serve' } else { 'serve --home ' + (Format-WindowsProcessArgument ([string]$spaceState.kikiHome)) }
            }
            $expectedPort = Get-ExpectedHeadlessPort $spaceState
            if ($null -ne $expectedPort -and $expectedPort -gt 0 -and ($null -eq (Get-ExplicitPortFromCommandLine $headlessArgs))) {
                $headlessArgs = ($headlessArgs.Trim() + (' --port {0}' -f $expectedPort))
            }
            $preserveManaged = [bool](Get-ObjectProperty $spaceState 'desktopManaged')
            $launchers[$key] = Invoke-HeadlessLaunch $runtime ([string]$spaceState.kikiHome) $headlessArgs -PassThru -RuntimeManaged:$preserveManaged
        }
    }
    return $launchers
}

if ($InspectOnly) {
    $discoveredSpaces = @(Discover-RuntimeSpaces -AllowMissingTokens)
    $primarySpace = $discoveredSpaces[0]
    $ownerToken = $primarySpace.ownerToken
    $tokenError = $primarySpace.tokenError
    $primarySnapshot = Get-LiveInspectionSnapshot $primarySpace.server $primarySpace.shells -AppScopeOnly:$AppScopeOnly
    $allShells = @($discoveredSpaces | ForEach-Object { $_.shells } | Where-Object { $null -ne $_ })
    $spaceSnapshots = @(
        foreach ($sp in $discoveredSpaces) {
            $snap = if ($sp.isPrimary) { $primarySnapshot } else { Get-LiveInspectionSnapshot $sp.server $sp.shells -AppScopeOnly:$AppScopeOnly }
            [ordered]@{
                kikiHome = [string]$sp.kikiHome
                isPrimary = [bool]$sp.isPrimary
                passHomeArg = [bool]$sp.passHomeArg
                hadDesktop = [bool]$sp.hadDesktop
                isHeadless = [bool]$sp.isHeadless
                headlessLaunchArgs = $sp.headlessLaunchArgs
                headlessOriginalPort = $sp.headlessOriginalPort
                headlessExplicitPort = $sp.headlessExplicitPort
                expectedPort = $sp.expectedPort
                desktopManaged = [bool]$sp.desktopManaged
                tokenError = $sp.tokenError
                liveServer = $snap.server
                shells = @($sp.shellEntries | ForEach-Object {
                    [ordered]@{
                        pid = [int]$_.pid
                        executablePath = [string]$_.executablePath
                        kikiHome = [string]$_.kikiHome
                    }
                })
                lifecycle = $snap.lifecycle
                workPendingSessions = @($snap.workPendingSessions)
                appScopeOnly = [bool]$AppScopeOnly
            }
        }
    )
    $currentManifest = Read-CurrentManifest $runtime -AllowMissing
    $activeManifest = Read-ActiveManifest $runtime -AllowMissing
    $candidateReport = $null
    $canaryReport = $null
    $inspectFailed = $false

    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
        try {
            $candFull = Get-FullPath $candidate
            $receiptObj = Read-BuildReceipt $candFull
            $checkCommit = if (-not [string]::IsNullOrWhiteSpace($commit)) { $commit } else { [string](Get-ObjectProperty $receiptObj 'sourceCommit') }
            $verifiedCand = Read-PromotionCandidate $candFull $checkCommit
            $candidateReport = [ordered]@{
                valid = $true
                candidateRoot = $verifiedCand.Path
                releaseId = $verifiedCand.ReleaseId
                sourceCommit = $verifiedCand.GitSha
                error = $null
            }
            if ($CanaryCheck) {
                try {
                    $canaryExe = if ($verifiedCand.SchemaVersion -eq 2) { $verifiedCand.Desktop.Path } else { $verifiedCand.Sidecar.Path }
                    $canaryEntry = if ($verifiedCand.SchemaVersion -eq 2) { $verifiedCand.ServerEntry.Path } else { '' }
                    $canaryReport = Invoke-CanaryCheck $canaryExe $verifiedCand.GitSha $CanaryTimeoutSeconds $canaryEntry
                } catch {
                    $inspectFailed = $true
                    $canaryReport = [ordered]@{ passed = $false; error = $_.Exception.Message }
                }
            }
        } catch {
            $inspectFailed = $true
            $candidateReport = [ordered]@{
                valid = $false
                candidateRoot = $candidate
                releaseId = $null
                sourceCommit = $commit
                error = $_.Exception.Message
            }
        }
    } elseif ($CanaryCheck) {
        $inspectFailed = $true
        $canaryReport = [ordered]@{ passed = $false; error = '-CanaryCheck requires -CandidateRoot.' }
    }

    $inspectOutput = [ordered]@{
        schemaVersion = 1
        inspectedAtUtc = [DateTime]::UtcNow.ToString('o')
        runtimeRoot = $runtime
        kikiHome = $homePath
        tokenError = $tokenError
        liveServer = $primarySnapshot.server
        shells = @($allShells | ForEach-Object { [ordered]@{ pid = [int]$_.Id; executablePath = (Get-ProcessPathSafe $_) } })
        lifecycle = $primarySnapshot.lifecycle
        workPendingSessions = $primarySnapshot.workPendingSessions
        spaces = $spaceSnapshots
        currentManifest = $currentManifest
        activeManifest = $activeManifest
        candidate = $candidateReport
        canary = $canaryReport
    }
    Write-Output ($inspectOutput | ConvertTo-Json -Depth 10)
    if ($inspectFailed) { exit 1 }
    return
}

[IO.Directory]::CreateDirectory($runtime) | Out-Null
$lock = [IO.File]::Open((Join-Path $runtime 'hot-switch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$pauseOwnersByHome = @{}
$script:report = $null
try {
    $ownerToken = Read-OwnerToken $homePath
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
    if ($Recover) {
        if ($null -eq $state -or $state.schemaVersion -ne 1 -or $state.kikiHome -ine $homePath -or $state.phase -eq 'complete') {
            throw 'There is no unfinished switch for this runtime and home.'
        }
        $shouldRollback = [bool]$Rollback -or ($state.phase -eq 'starting_failed')
        $recordedSpaces = @(Get-RecordedSpaces $state)
        $recordedHomeKeys = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($spState in $recordedSpaces) { $null = $recordedHomeKeys.Add(([string]$spState.kikiHome).ToLowerInvariant()) }
        $tokensByHome = @{}
        $runningByHome = @{}
        $unhealthyByHome = @{}
        $knownReleases = @($state.oldReleaseId, $state.targetReleaseId, $state.priorPointerReleaseId) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
        $allHomes = @($recordedSpaces | ForEach-Object { [string]$_.kikiHome })
        $recoverServerEntries = @(Find-RuntimeServerEntries $allHomes)
        foreach ($spState in $recordedSpaces) {
            $key = ([string]$spState.kikiHome).ToLowerInvariant()
            $spToken = Read-OwnerToken ([string]$spState.kikiHome)
            $tokensByHome[$key] = $spToken
            $liveServer = $null
            $probeFailed = $false
            try {
                $liveServer = Find-Server ([string]$spState.kikiHome) $spToken -AllowHeadless:(-not [bool]$spState.hadDesktop)
            } catch {
                $probeFailed = $true
                Write-Warning ("Recovery probe failed for {0}: {1}" -f $spState.kikiHome, $_.Exception.Message)
            }
            if ($null -ne $liveServer) {
                $runningByHome[$key] = $liveServer
            } elseif ($probeFailed) {
                $regPids = @(Get-HomeRegisteredServerPids ([string]$spState.kikiHome))
                $matchedEntries = @($recoverServerEntries | Where-Object {
                    ($regPids -contains [int]$_.pid) -or
                    ((-not [string]::IsNullOrWhiteSpace($_.kikiHome)) -and $_.kikiHome.ToLowerInvariant() -ceq $key)
                })
                if ($matchedEntries.Count -eq 0 -and $regPids.Count -gt 0) {
                    throw 'Recovery found a different service. Leave it running and inspect the switch record.'
                }
                foreach ($ent in $matchedEntries) {
                    if ($ent.binaryInfo.releaseId -cnotin $knownReleases) {
                        throw 'Recovery found a different service. Leave it running and inspect the switch record.'
                    }
                }
                if ($matchedEntries.Count -gt 0) {
                    $unhealthyPids = New-Object 'System.Collections.Generic.List[int]'
                    foreach ($ent in $matchedEntries) {
                        $unhealthyPids.Add([int]$ent.pid)
                        if ($ent.launcherPid -gt 0) { $unhealthyPids.Add([int]$ent.launcherPid) }
                    }
                    $unhealthyByHome[$key] = [pscustomobject]@{
                        kikiHome = [string]$spState.kikiHome
                        pids = @($unhealthyPids.ToArray())
                        entries = @($matchedEntries)
                    }
                }
            }
        }
        $targetReleaseId = [string](Get-ObjectProperty $state 'targetReleaseId')
        $targetBuildId = [string](Get-ObjectProperty $state 'targetBuildId')
        $canUseTarget = (-not $shouldRollback) -and (-not [string]::IsNullOrWhiteSpace($targetReleaseId)) -and (-not [string]::IsNullOrWhiteSpace($targetBuildId)) -and (Test-InstalledRelease $targetReleaseId)
        $desiredReleaseId = if ($canUseTarget) { $targetReleaseId } else { [string]$state.oldReleaseId }
        $desiredBuildId = if ($canUseTarget) { $targetBuildId } else { [string]$state.oldBuildId }
        $desiredLabel = if ($canUseTarget) { 'Target' } else { 'Original' }

        foreach ($spState in $recordedSpaces) {
            $key = ([string]$spState.kikiHome).ToLowerInvariant()
            if (-not $runningByHome.ContainsKey($key)) { continue }
            $srv = $runningByHome[$key]
            if ($srv.meta.server_home_id -cne $spState.serverHomeId -or $srv.meta.current_space_id -cne $spState.spaceId -or
                $srv.releaseId -cnotin $knownReleases) {
                throw 'Recovery found a different service. Leave it running and inspect the switch record.'
            }
        }

        $wrongSpaces = @($recordedSpaces | Where-Object {
            $k = ([string]$_.kikiHome).ToLowerInvariant()
            if ($unhealthyByHome.ContainsKey($k)) { return $true }
            if (-not $runningByHome.ContainsKey($k)) { return $false }
            $srv = $runningByHome[$k]
            $srvBuildId = [string](Get-ObjectProperty $srv.meta 'build_id')
            if ($srv.releaseId -cne $desiredReleaseId -or $srvBuildId -cne $desiredBuildId -or $srv.layout -ne 'active') { return $true }
            if (-not (Test-RecordedHeadlessPortMatch $_ $srv)) { return $true }
            return (-not (Test-ServerHealthz $srv.instance $tokensByHome[$k]))
        })
        $missingSpaces = @($recordedSpaces | Where-Object {
            -not $runningByHome.ContainsKey(([string]$_.kikiHome).ToLowerInvariant())
        })

        $uniqueRunningReleases = @($runningByHome.Values | ForEach-Object { [string]$_.releaseId } | Select-Object -Unique)
        $allHealthySurviving = ($unhealthyByHome.Count -eq 0) -and ($wrongSpaces.Count -eq 0)
        $allUniformOnRecordedRelease = Test-RecoverUniformFastPath $recordedSpaces $runningByHome $unhealthyByHome $shouldRollback $missingSpaces $uniqueRunningReleases $tokensByHome

        if ($allUniformOnRecordedRelease -or ($allHealthySurviving -and $missingSpaces.Count -eq 0)) {
            if ($shouldRollback) {
                Restore-OriginalRelease
            }
        } else {
            if ($wrongSpaces.Count -gt 0 -or $unhealthyByHome.Count -gt 0) {
                # Validate ownership BEFORE stopping any surviving recorded space so recovery never stops recorded homes only to fail on an unplanned space.
                $shellEntriesNow = @(Find-ShellEntries)
                $unplannedBeforeStop = @($shellEntriesNow | Where-Object { -not $recordedHomeKeys.Contains(([string]$_.kikiHome).ToLowerInvariant()) })
                if ($unplannedBeforeStop.Count -gt 0) {
                    throw 'Another desktop space outside the switch record is still running. Close it before retrying recovery.'
                }
                $recoverEntryByPid = @{}
                foreach ($ent in $recoverServerEntries) { $recoverEntryByPid[[int]$ent.pid] = $ent }
                $recordedRootPids = New-Object 'System.Collections.Generic.List[int]'
                foreach ($k in $runningByHome.Keys) {
                    $srvPid = [int]$runningByHome[$k].process.Id
                    $recordedRootPids.Add($srvPid)
                    if ($recoverEntryByPid.ContainsKey($srvPid) -and $recoverEntryByPid[$srvPid].launcherPid -gt 0) {
                        $recordedRootPids.Add([int]$recoverEntryByPid[$srvPid].launcherPid)
                    }
                }
                foreach ($k in $unhealthyByHome.Keys) {
                    foreach ($uPid in @($unhealthyByHome[$k].pids)) {
                        if ($uPid -gt 0) { $recordedRootPids.Add([int]$uPid) }
                    }
                }
                foreach ($entry in @($shellEntriesNow)) { $recordedRootPids.Add([int]$entry.pid) }
                $ownedBeforeRecoverStop = @(Get-ProcessTreePids $recordedRootPids.ToArray())
                $otherActiveBeforeRecoverStop = @(Get-OtherActiveServerPids $ownedBeforeRecoverStop)
                if ($otherActiveBeforeRecoverStop.Count -gt 0) {
                    throw ("Another Kiki home/instance is holding active\kiki-server.exe (PIDs: {0}); close it before recovery." -f ($otherActiveBeforeRecoverStop -join ', '))
                }

                # Stop verified unhealthy replacement processes whose /api/meta failed before graceful shutdown of any surviving spaces.
                if ($unhealthyByHome.Count -gt 0) {
                    $unhealthyHomes = @($unhealthyByHome.Values | ForEach-Object { [string]$_.kikiHome })
                    Stop-ReleaseProcesses '' @() $unhealthyHomes
                    $unhealthyByHome.Clear()
                }

                # Split runtime or rollback while another release is still running: close shells of already-exited recorded spaces first, then request shutdown from surviving recorded spaces honoring any backend refusal.
                foreach ($entry in @($shellEntriesNow | Where-Object {
                    $ek = ([string]$_.kikiHome).ToLowerInvariant()
                    $recordedHomeKeys.Contains($ek) -and (-not $runningByHome.ContainsKey($ek))
                })) {
                    try { $entry.process.EnableRaisingEvents = $true; $null = $entry.process.Handle } catch {}
                    Close-DesktopShell $entry.process $entry.kikiHome
                }
                $stopPlans = @(
                    foreach ($spState in $recordedSpaces) {
                        $k = ([string]$spState.kikiHome).ToLowerInvariant()
                        if (-not $runningByHome.ContainsKey($k)) { continue }
                        $srv = $runningByHome[$k]
                        $spShells = @($shellEntriesNow | Where-Object { ([string]$_.kikiHome).ToLowerInvariant() -ceq $k } | ForEach-Object { $_.process })
                        foreach ($sh in $spShells) { try { $sh.EnableRaisingEvents = $true; $null = $sh.Handle } catch {} }
                        $srvEnt = if ($recoverEntryByPid.ContainsKey([int]$srv.process.Id)) { $recoverEntryByPid[[int]$srv.process.Id] } else { $null }
                        $launcherProc = if ($null -ne $srvEnt) { $srvEnt.launcherProcess } else { $null }
                        if ($null -ne $launcherProc) { try { $launcherProc.EnableRaisingEvents = $true; $null = $launcherProc.Handle } catch {} }
                        Stop-SpaceServerGracefully $srv ($state.phase -eq 'stopping' -or $state.phase -eq 'starting_failed')
                        [pscustomobject]@{
                            kikiHome = [string]$spState.kikiHome
                            key = $k
                            hadDesktop = [bool]$spState.hadDesktop
                            headlessLaunchArgs = [string](Get-ObjectProperty $spState 'headlessLaunchArgs')
                            headlessOriginalPort = Get-ObjectProperty $spState 'headlessOriginalPort'
                            expectedPort = Get-ExpectedHeadlessPort $spState
                            ownerToken = $tokensByHome[$k]
                            server = $srv
                            launcherPid = if ($null -ne $srvEnt) { [int]$srvEnt.launcherPid } else { 0 }
                            launcherProcess = $launcherProc
                            shells = $spShells
                            interruptedAfterSettle = ($state.phase -eq 'stopping' -or $state.phase -eq 'starting_failed')
                        }
                    }
                )
                if ($stopPlans.Count -gt 0) {
                    Wait-ForAllExits $stopPlans
                }
                $runningByHome.Clear()
                $missingSpaces = @($recordedSpaces)
            }

            if ($runningByHome.Count -eq 0) {
                foreach ($entry in @(Find-ShellEntries | Where-Object { $recordedHomeKeys.Contains(([string]$_.kikiHome).ToLowerInvariant()) })) {
                    try { $entry.process.EnableRaisingEvents = $true; $null = $entry.process.Handle } catch {}
                    Close-DesktopShell $entry.process $entry.kikiHome
                }
                $unplannedShells = @(Find-ShellEntries | Where-Object { -not $recordedHomeKeys.Contains(([string]$_.kikiHome).ToLowerInvariant()) })
                if ($unplannedShells.Count -gt 0) {
                    throw 'Another desktop space outside the switch record is still running. Close it before retrying recovery.'
                }
                if (@(Find-Shells).Count -gt 0) { throw 'Quit the remaining desktop from its tray before retrying recovery.' }
                $otherActive = @(Get-OtherActiveServerPids @())
                if ($otherActive.Count -gt 0) {
                    throw ("Another Kiki home/instance is holding active\kiki-server.exe (PIDs: {0}); close it before recovery." -f ($otherActive -join ', '))
                }
            }

            $launchers = @{}
            if ($canUseTarget) {
                try {
                    if ($runningByHome.Count -eq 0) {
                        Select-InstalledRelease $desiredReleaseId $desiredBuildId $desiredLabel -RequireActiveSync
                    }
                    $launchers = Start-AllSpaces $missingSpaces
                    $startedByHome = Await-AllReleases $missingSpaces $desiredReleaseId $desiredBuildId $launchers $tokensByHome
                    foreach ($k in $startedByHome.Keys) { $runningByHome[$k] = $startedByHome[$k] }
                } catch {
                    Write-Warning ("Target release {0} failed to start during recovery: {1}. Rolling back to {2}." -f $desiredReleaseId, $_.Exception.Message, $state.oldReleaseId)
                    $state.phase = 'starting_failed'; Save-State
                    Stop-ReleaseProcesses $desiredReleaseId @($launchers.Values) $allHomes
                    Restore-OriginalRelease -RequireActiveSync
                    $rollbackLaunchers = Start-AllSpaces $recordedSpaces
                    $runningByHome = Await-AllReleases $recordedSpaces $state.oldReleaseId $state.oldBuildId $rollbackLaunchers $tokensByHome
                }
            } else {
                if ($runningByHome.Count -eq 0) {
                    Restore-OriginalRelease -RequireActiveSync
                }
                $launchers = Start-AllSpaces $missingSpaces
                $startedByHome = Await-AllReleases $missingSpaces $state.oldReleaseId $state.oldBuildId $launchers $tokensByHome
                foreach ($k in $startedByHome.Keys) { $runningByHome[$k] = $startedByHome[$k] }
            }
        }
        Clear-SwitchControlsForAllSpaces $runningByHome $recordedSpaces $true
        $null = Ensure-TrayHostRunning $recordedSpaces
        $state.phase = 'complete'; Save-State
        $primaryRecovered = $runningByHome[$homePath.ToLowerInvariant()]
        Write-Host "Recovery complete: $($primaryRecovered.releaseId)"
        return
    }

    if (!$candidate) {
        $controllerSettingsPath = Join-Path $PSScriptRoot 'settings.json'
        if (Test-Path -LiteralPath $controllerSettingsPath -PathType Leaf) {
            $controllerSettings = Get-Content -LiteralPath $controllerSettingsPath -Raw | ConvertFrom-Json
            if ($controllerSettings.schemaVersion -eq 1 -and -not [string]::IsNullOrWhiteSpace($controllerSettings.candidateRoot)) {
                $candidate = [string]$controllerSettings.candidateRoot
                if ([string]::IsNullOrWhiteSpace($commit) -and -not [string]::IsNullOrWhiteSpace($controllerSettings.expectedCommit)) {
                    $commit = [string]$controllerSettings.expectedCommit
                }
            }
        }
    }
    if (!$candidate) { throw 'Pass -CandidateRoot with the verified desktop build directory.' }
    $verified = Read-PromotionCandidate $candidate $commit
    $expectedBuildId = [string]$verified.GitSha
    $targetRelease = $verified.ReleaseId

    if ($null -ne $state -and $state.phase -ne 'complete' -and $state.schemaVersion -eq 1 -and $state.kikiHome -ine $homePath) {
        throw 'A switch for another Kiki home is unfinished. Run this command with -Recover for that home first.'
    }

    $discoveredSpaces = @(Discover-RuntimeSpaces)
    $primarySpace = $discoveredSpaces[0]
    $old = $primarySpace.server
    if ($null -eq $old) { throw 'No authenticated managed service is running from this runtime and home.' }
    $current = Read-CurrentManifest $runtime -AllowMissing
    $priorPointerReleaseId = if ($null -ne $current) { [string]$current.releaseId } else { $old.releaseId }

    $spacePlans = @()
    foreach ($sp in $discoveredSpaces) {
        if ($null -eq $sp.server) {
            throw ("No authenticated managed service is running for open desktop space {0}." -f $sp.kikiHome)
        }
        $expectedDesktopExe = Get-ExpectedDesktopPathForServer $sp.server
        if (@($sp.shells | Where-Object { (Get-ProcessPathSafe $_) -ine $expectedDesktopExe }).Count -gt 0) {
            throw ("A desktop shell for {0} does not match the executable of its running service." -f $sp.kikiHome)
        }
        if ((-not [bool]$sp.hadDesktop) -and [string]::IsNullOrWhiteSpace([string]$sp.headlessLaunchArgs)) {
            throw ("Cannot determine original command-line arguments for headless space {0} (pid {1}); refusing to drain without exact relaunch arguments." -f $sp.kikiHome, $sp.server.process.Id)
        }
        $spacePlans += [pscustomobject]@{
            kikiHome = $sp.kikiHome
            key = $sp.kikiHome.ToLowerInvariant()
            isPrimary = $sp.isPrimary
            passHomeArg = $sp.passHomeArg
            hadDesktop = [bool]$sp.hadDesktop
            isHeadless = [bool]$sp.isHeadless
            headlessLaunchArgs = $sp.headlessLaunchArgs
            headlessOriginalPort = $sp.headlessOriginalPort
            headlessExplicitPort = $sp.headlessExplicitPort
            expectedPort = $sp.expectedPort
            launcherPid = [int](Get-ObjectProperty $sp 'launcherPid')
            launcherProcess = Get-ObjectProperty $sp 'launcherProcess'
            desktopManaged = [bool]$sp.desktopManaged
            ownerToken = $sp.ownerToken
            server = $sp.server
            shells = @($sp.shells)
            interruptedAfterSettle = $false
            interruptedSessions = @()
            lastLifecycle = $null
        }
    }

    $allShells = @($spacePlans | ForEach-Object { $_.shells } | Where-Object { $null -ne $_ })
    $primaryPreSnapshot = Get-LiveInspectionSnapshot $old $primarySpace.shells
    $script:report = [ordered]@{
        schemaVersion = 1
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
        finishedAtUtc = $null
        outcome = 'in_progress'
        runtimeRoot = $runtime
        kikiHome = $homePath
        targetReleaseId = $targetRelease
        targetBuildId = $expectedBuildId
        preSnapshot = $primaryPreSnapshot
        spaces = @($spacePlans | ForEach-Object {
            [ordered]@{
                kikiHome = [string]$_.kikiHome
                isPrimary = [bool]$_.isPrimary
                passHomeArg = [bool]$_.passHomeArg
                hadDesktop = [bool]$_.hadDesktop
                isHeadless = [bool]$_.isHeadless
                headlessLaunchArgs = $_.headlessLaunchArgs
                headlessOriginalPort = $_.headlessOriginalPort
                headlessExplicitPort = $_.headlessExplicitPort
                expectedPort = $_.expectedPort
                desktopManaged = [bool]$_.desktopManaged
                preServerMeta = Format-ServerMetaReport $_.server
                postServerMeta = $null
                interruptedSessions = @()
            }
        })
        canaryPassed = $null
        canary = $null
        pausedSessions = @()
        skippedFailedOrIdleSessions = @()
        interruptedAfterSettle = $false
        interruptedSessions = @()
        interruptedSessionRecords = @()
        postServerMeta = $null
        resumedSessions = @()
        resumeFailures = @()
        error = $null
    }

    # Short-circuit as already_running only when EVERY discovered space is on $targetRelease from active\.
    $allAlreadyCurrent = (@($spacePlans | Where-Object { $_.server.releaseId -cne $targetRelease -or $_.server.layout -ne 'active' }).Count -eq 0)
    if ($allAlreadyCurrent) {
        Invoke-Promotion $runtime $verified | Out-Host
        $script:report.outcome = 'already_running'
        $script:report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
        $script:report.postServerMeta = $script:report.preSnapshot.server
        Save-Report
        Write-Host "Already running $targetRelease"
        return
    }

    # Pre-drain safety checks BEFORE any mutation:
    # 1. Verify rollback archive releases\<oldReleaseId>\ exists for every running space.
    foreach ($plan in $spacePlans) {
        if (-not (Test-InstalledRelease $plan.server.releaseId)) {
            throw ("Rollback archive releases\{0} is missing or corrupt; refusing to drain the running service ({1})." -f $plan.server.releaseId, $plan.kikiHome)
        }
    }
    # 2. Verify no unmanaged/unknown Kiki server is running from active\kiki-server.exe outside our discovered spaces.
    $ownedRootPids = @(
        @($spacePlans | ForEach-Object { [int]$_.server.process.Id }) +
        @($spacePlans | ForEach-Object { [int](Get-ObjectProperty $_ 'launcherPid') } | Where-Object { $_ -gt 0 }) +
        @($allShells | ForEach-Object { [int]$_.Id })
    )
    $ownedBeforeDrain = @(Get-ProcessTreePids $ownedRootPids)
    $otherActiveBeforeDrain = @(Get-OtherActiveServerPids $ownedBeforeDrain)
    if ($otherActiveBeforeDrain.Count -gt 0) {
        throw ("Another Kiki home/instance is running from active\kiki-server.exe (PIDs: {0}). Close other spaces sharing this runtime before hot-switching." -f ($otherActiveBeforeDrain -join ', '))
    }

    # 3. Run canary check FIRST BEFORE touching, fencing, pausing, or closing ANY space (0s blackout during canary!).
    if ($CanaryCheck) {
        try {
            $canaryExe = if ($verified.SchemaVersion -eq 2) { $verified.Desktop.Path } else { $verified.Sidecar.Path }
            $canaryEntry = if ($verified.SchemaVersion -eq 2) { $verified.ServerEntry.Path } else { '' }
            $canaryResult = Invoke-CanaryCheck $canaryExe $expectedBuildId $CanaryTimeoutSeconds $canaryEntry
            $script:report.canaryPassed = $true
            $script:report.canary = $canaryResult
            Write-Host ("Canary check passed (build={0}, elapsed={1}ms)" -f $canaryResult.build_id, $canaryResult.elapsedMs)
        } catch {
            $script:report.canaryPassed = $false
            $script:report.canary = [ordered]@{ passed = $false; error = $_.Exception.Message }
            throw ("Canary check failed; live desktop was not modified: {0}" -f $_.Exception.Message)
        }
        # Re-verify no new desktop space or active server appeared while canary ran.
        Assert-NoUnplannedRuntimeProcesses $spacePlans
    }

    $continuing = $false
    if ($null -ne $state -and $state.phase -ne 'complete') {
        if ($state.schemaVersion -eq 1 -and $state.phase -eq 'pausing' -and
            $state.oldServerId -ceq $old.meta.server_id -and $state.targetReleaseId -ceq $targetRelease) {
            $continuing = $true
        } else {
            Write-Warning ("Reconciling stale hot-switch record (phase={0}, old={1}, target={2}) before starting new switch." -f $state.phase, $state.oldReleaseId, $state.targetReleaseId)
            if ($state.schemaVersion -eq 1) {
                $staleTargets = @{}
                foreach ($plan in $spacePlans) { $staleTargets[$plan.key] = $plan.server }
                $staleSpaces = @(Get-RecordedSpaces $state | Where-Object {
                    $k = ([string]$_.kikiHome).ToLowerInvariant()
                    $staleTargets.ContainsKey($k) -and $staleTargets[$k].meta.server_home_id -ceq $_.serverHomeId -and $staleTargets[$k].meta.current_space_id -ceq $_.spaceId
                })
                if ($staleSpaces.Count -gt 0) {
                    Clear-SwitchControlsForAllSpaces $staleTargets $staleSpaces $true
                }
            }
            $state.phase = 'complete'; Save-State
            $state = $null
        }
    }

    # Promote-First: stage releases/<targetReleaseId>, cli/kiki.exe, and current.json before drain/detach
    # so any manual quit+relaunch boots the new release immediately.
    Invoke-Promotion $runtime $verified | Out-Host
    if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) { throw 'Promotion did not select the verified candidate.' }

    if ($Detach) {
        $lock.Dispose()
        $lock = $null
        $logPath = Join-Path $runtime 'hot-switch.log'
        $runnerPs1 = Join-Path $runtime 'hot-switch-detach.ps1'
        $runnerVbs = Join-Path $runtime 'hot-switch-detach.vbs'
        $psExe = Join-Path $PSHOME 'powershell.exe'
        $esc = { param([string]$s) "'" + $s.Replace("'", "''") + "'" }
        $invokeArgs = @(
            "-RuntimeRoot $(& $esc $runtime)",
            "-KikiHome $(& $esc $homePath)",
            "-CandidateRoot $(& $esc $candidate)",
            "-SettleSeconds $SettleSeconds",
            "-StartupSeconds $StartupSeconds",
            "-StopGraceSeconds $StopGraceSeconds"
        )
        if (-not [string]::IsNullOrWhiteSpace($commit)) { $invokeArgs += "-ExpectedCommit $(& $esc $commit)" }
        if ($Background) { $invokeArgs += '-Background' }
        if ($SkipTrayHost) { $invokeArgs += '-SkipTrayHost' }
        if ($NoInterruptAfterSettle -or (-not $InterruptAfterSettle)) { $invokeArgs += '-NoInterruptAfterSettle' }
        $runnerBody = @(
            "`$ErrorActionPreference = 'Stop'",
            "`$env:KIKI_HOME = $(& $esc $homePath)",
            "`$logPath = $(& $esc $logPath)",
            "[IO.File]::WriteAllText(`$logPath, '', (New-Object Text.UTF8Encoding(`$false)))",
            "Start-Sleep -Seconds $DetachDelaySeconds",
            "`$failed = `$false",
            "& {",
            "    try {",
            "        & $(& $esc $entryScript) $($invokeArgs -join ' ')",
            "    } catch {",
            "        `$script:failed = `$true",
            "        `$posMsg = if (`$null -ne `$_.InvocationInfo) { `$_.InvocationInfo.PositionMessage } else { '' }",
            "        Write-Error (`"{0}``n{1}``n{2}`" -f `$_.Exception.Message, `$posMsg, `$_.ScriptStackTrace) -ErrorAction Continue",
            "    }",
            "} *>&1 | Out-File -LiteralPath `$logPath -Encoding utf8 -Append -Width 4096",
            "if (`$failed) { exit 1 }"
        ) -join "`r`n"
        [IO.File]::WriteAllText($runnerPs1, $runnerBody + "`r`n", (New-Object Text.UTF8Encoding($false)))
        $vbsCmd = '""{0}"" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{1}""' -f $psExe, $runnerPs1
        [IO.File]::WriteAllText($runnerVbs, ('CreateObject("WScript.Shell").Run "{0}", 0, False' -f $vbsCmd), (New-Object Text.UTF8Encoding($false)))
        $wmiCmd = 'wscript.exe //B //NoLogo "{0}"' -f $runnerVbs
        $wmiRes = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $wmiCmd }
        if ($wmiRes.ReturnValue -ne 0) {
            throw "Failed to spawn detached hot-switch worker via Win32_Process (ReturnValue=$($wmiRes.ReturnValue))."
        }
        Write-Host ("Detached hot-switch scheduled (wmiPid={0}, delay={1}s, target={2}, spaces={3}, log={4})" -f $wmiRes.ProcessId, $DetachDelaySeconds, $targetRelease, $spacePlans.Count, $logPath)
        return
    }

    foreach ($shell in $allShells) { try { $shell.EnableRaisingEvents = $true; $null = $shell.Handle } catch {} }
    $tokensByHome = @{}
    foreach ($plan in $spacePlans) { $tokensByHome[$plan.key] = $plan.ownerToken }

    $activeFallbackBuildId = [string](Get-ObjectProperty (Read-ActiveManifest $runtime -AllowMissing) 'gitSha')
    if ([string]::IsNullOrWhiteSpace($activeFallbackBuildId)) {
        $activeFallbackBuildId = [string](Get-ObjectProperty $current 'gitSha')
    }
    if ($continuing) {
        if (-not (Get-ObjectProperty $state 'fenceOperationId')) {
            $state | Add-Member -NotePropertyName fenceOperationId -NotePropertyValue ('hot-switch:' + [guid]::NewGuid().ToString('N')) -Force
        }
        $rawExistingSpaces = Get-ObjectProperty $state 'spaces'
        $existingSpaces = @(if ($null -ne $rawExistingSpaces) { @($rawExistingSpaces) | Where-Object { $null -ne $_ } })
        if ($existingSpaces.Count -eq 0) {
            $rawPrimarySessions = Get-ObjectProperty $state 'sessions'
            $primarySessions = @(if ($null -ne $rawPrimarySessions) { @($rawPrimarySessions) | Where-Object { $null -ne $_ } })
            $state | Add-Member -NotePropertyName spaces -NotePropertyValue @(
                foreach ($plan in $spacePlans) {
                    $planOldBuildId = [string](Get-ObjectProperty $plan.server.meta 'build_id')
                    if ([string]::IsNullOrWhiteSpace($planOldBuildId)) { $planOldBuildId = $activeFallbackBuildId }
                    [pscustomobject]@{
                        kikiHome = $plan.kikiHome; isPrimary = $plan.isPrimary; passHomeArg = $plan.passHomeArg
                        oldReleaseId = $plan.server.releaseId; oldBuildId = $planOldBuildId
                        oldServerId = [string](Get-ObjectProperty $plan.server.meta 'server_id'); serverHomeId = [string](Get-ObjectProperty $plan.server.meta 'server_home_id')
                        spaceId = [string](Get-ObjectProperty $plan.server.meta 'current_space_id'); hadDesktop = [bool]$plan.hadDesktop
                        headlessLaunchArgs = $plan.headlessLaunchArgs
                        headlessOriginalPort = $plan.headlessOriginalPort; headlessExplicitPort = $plan.headlessExplicitPort; expectedPort = $plan.expectedPort
                        desktopManaged = [bool]$plan.desktopManaged
                        fenceOperationId = if ($plan.isPrimary) { [string]$state.fenceOperationId } else { 'hot-switch:' + [guid]::NewGuid().ToString('N') }
                        sessions = if ($plan.isPrimary) { $primarySessions } else { @() }
                    }
                }
            ) -Force
        }
        Save-State
    } else {
        $primaryFenceId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
        $spaceStateList = @(
            foreach ($plan in $spacePlans) {
                $planOldBuildId = [string](Get-ObjectProperty $plan.server.meta 'build_id')
                if ([string]::IsNullOrWhiteSpace($planOldBuildId)) { $planOldBuildId = $activeFallbackBuildId }
                [pscustomobject]@{
                    kikiHome = $plan.kikiHome; isPrimary = $plan.isPrimary; passHomeArg = $plan.passHomeArg
                    oldReleaseId = $plan.server.releaseId; oldBuildId = $planOldBuildId
                    oldServerId = [string](Get-ObjectProperty $plan.server.meta 'server_id'); serverHomeId = [string](Get-ObjectProperty $plan.server.meta 'server_home_id')
                    spaceId = [string](Get-ObjectProperty $plan.server.meta 'current_space_id'); hadDesktop = [bool]$plan.hadDesktop
                    headlessLaunchArgs = $plan.headlessLaunchArgs
                    headlessOriginalPort = $plan.headlessOriginalPort; headlessExplicitPort = $plan.headlessExplicitPort; expectedPort = $plan.expectedPort
                    desktopManaged = [bool]$plan.desktopManaged
                    fenceOperationId = if ($plan.isPrimary) { $primaryFenceId } else { 'hot-switch:' + [guid]::NewGuid().ToString('N') }
                    sessions = @()
                }
            }
        )
        $primaryOldBuildId = [string](Get-ObjectProperty $old.meta 'build_id')
        if ([string]::IsNullOrWhiteSpace($primaryOldBuildId)) { $primaryOldBuildId = $activeFallbackBuildId }
        $state = [pscustomobject]@{
            schemaVersion = 1; phase = 'pausing'; kikiHome = $homePath; oldReleaseId = $old.releaseId; oldBuildId = $primaryOldBuildId
            oldServerId = [string](Get-ObjectProperty $old.meta 'server_id'); serverHomeId = [string](Get-ObjectProperty $old.meta 'server_home_id'); spaceId = [string](Get-ObjectProperty $old.meta 'current_space_id')
            priorPointerReleaseId = $priorPointerReleaseId; targetReleaseId = $targetRelease; targetBuildId = $expectedBuildId; hadDesktop = [bool]$primarySpace.hadDesktop
            headlessLaunchArgs = $primarySpace.headlessLaunchArgs
            headlessOriginalPort = $primarySpace.headlessOriginalPort; headlessExplicitPort = $primarySpace.headlessExplicitPort; expectedPort = $primarySpace.expectedPort
            desktopManaged = [bool]$primarySpace.desktopManaged
            fenceOperationId = $primaryFenceId
            sessions = @()
            spaces = $spaceStateList
        }
        Save-State
    }

    $spaceStateByHome = @{}
    foreach ($spState in @(Get-RecordedSpaces $state)) {
        $spaceStateByHome[([string]$spState.kikiHome).ToLowerInvariant()] = $spState
    }
    foreach ($plan in $spacePlans) {
        $pauseOwnersByHome[$plan.key] = $plan.server
        $fenceResult = @{ confirmed = $false }
        Try-RuntimeSwitch $plan.server.instance ([string]$spaceStateByHome[$plan.key].fenceOperationId) 'fence' $fenceResult
        if ((-not [bool]$fenceResult.confirmed) -and (-not $plan.hadDesktop) -and (-not $AllowUnfencedHeadless)) {
            throw ("Headless space {0} does not expose /api/runtime-switch admission fencing; refusing to drain without an admission fence (pass -AllowUnfencedHeadless only for one-time migration of a legacy server)." -f $plan.kikiHome)
        }
    }

    $interruptedAfterSettle = $false
    $interruptedSessions = @()
    $notedPhases = @{}
    $deadline = [DateTime]::UtcNow.AddSeconds($SettleSeconds)
    do {
        $allPending = @()
        foreach ($plan in $spacePlans) {
            $spState = $spaceStateByHome[$plan.key]
            $lifecycle = Lifecycle $plan.server.instance ''
            $plan.lastLifecycle = $lifecycle
            foreach ($id in @($lifecycle.work_pending)) {
                $noteKey = '{0}|{1}' -f $plan.key, $id
                $control = Execution $plan.server.instance $id 'read'
                if ($control.phase -eq 'running') {
                    $item = [pscustomobject]@{ id = $id; pauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N') }
                    $spState.sessions = @($spState.sessions | Where-Object id -CNE $id) + @($item)
                    if ($plan.isPrimary) { $state.sessions = @($spState.sessions) }
                    Save-State
                    Execution $plan.server.instance $id 'pause' @(@{ operationId = $item.pauseId }) | Out-Null
                    Write-Host "Pausing $id"
                } elseif ($control.phase -in @('failed', 'idle')) {
                    if ($notedPhases[$noteKey] -cne $control.phase) {
                        $notedPhases[$noteKey] = $control.phase
                        Write-Host "Session $id is $($control.phase); no pause needed."
                    }
                } elseif ($control.phase -eq 'resuming') {
                    if ($notedPhases[$noteKey] -cne 'resuming') {
                        $notedPhases[$noteKey] = 'resuming'
                        Write-Host "Session $id is resuming; waiting up to settle deadline."
                    }
                }
            }
            $spacePending = @($lifecycle.work_pending)
            if ($spacePending.Count -gt 0) {
                $allPending += $spacePending
            }
        }
        if ($allPending.Count -eq 0) { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            if (-not $allowInterruptAfterSettle) {
                throw ('Still settling: ' + ($allPending -join ', '))
            }
            Write-Warning ('Settle deadline ({0}s) expired with active work ({1}); interrupting remaining work to complete hot switch.' -f $SettleSeconds, ($allPending -join ', '))
            $interruptedAfterSettle = $true
            $interruptedSessions = @($allPending)
            foreach ($plan in $spacePlans) {
                $spacePending = @(Get-ObjectProperty $plan.lastLifecycle 'work_pending')
                if ($spacePending.Count -gt 0) {
                    $plan.interruptedAfterSettle = $true
                    $plan.interruptedSessions = @($spacePending)
                    $spaceStateByHome[$plan.key] | Add-Member -NotePropertyName interruptedAfterSettle -NotePropertyValue $true -Force
                }
            }
            Save-State
            break
        }
        Start-Sleep -Milliseconds 400
    } while ($true)

    $allPausedRecords = @(
        foreach ($spState in @(Get-RecordedSpaces $state)) {
            foreach ($s in @(Get-ObjectProperty $spState 'sessions')) {
                if ($null -eq $s) { continue }
                [ordered]@{ id = [string]$s.id; pauseId = [string]$s.pauseId; kikiHome = [string]$spState.kikiHome }
            }
        }
    )
    $interruptedSessionRecords = @(
        foreach ($plan in $spacePlans) {
            foreach ($sid in @($plan.interruptedSessions)) {
                [ordered]@{ sessionId = [string]$sid; kikiHome = [string]$plan.kikiHome }
            }
        }
    )
    $script:report.pausedSessions = $allPausedRecords
    $script:report.interruptedAfterSettle = $interruptedAfterSettle
    $script:report.interruptedSessions = @($interruptedSessions)
    $script:report.interruptedSessionRecords = @($interruptedSessionRecords)
    foreach ($repSpace in @($script:report.spaces)) {
        $rk = ([string]$repSpace.kikiHome).ToLowerInvariant()
        $matchingPlan = @($spacePlans | Where-Object { $_.key -ceq $rk })[0]
        if ($null -ne $matchingPlan) {
            $repSpace.interruptedSessions = @($matchingPlan.interruptedSessions)
        }
    }

    # Revalidate ownership before entering stopping phase so an unplanned space opened during settle aborts cleanly while still in pausing.
    Assert-NoUnplannedRuntimeProcesses $spacePlans

    # Persist 'stopping' BEFORE sending the first 'update' request so any partial shutdown failure stays recoverable and never falls back to 'pausing' cleanup.
    $state.phase = 'stopping'; Save-State
    foreach ($plan in $spacePlans) {
        Stop-SpaceServerGracefully $plan.server ([bool]$plan.interruptedAfterSettle) $plan.lastLifecycle
    }

    Wait-ForAllExits $spacePlans
    $state.phase = 'starting'; Save-State

    $recordedSpaces = @(Get-RecordedSpaces $state)
    $allHomes = @($recordedSpaces | ForEach-Object { [string]$_.kikiHome })
    $launchers = @{}
    $targetsByHome = @{}
    try {
        if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) {
            Invoke-Promotion $runtime $verified | Out-Host
            if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) { throw 'Promotion did not select the verified candidate.' }
        }
        Sync-ActiveRelease $runtime $targetRelease $expectedBuildId $verified.Desktop $verified.Sidecar -SchemaVersion $verified.SchemaVersion -ExpectedServerEntry $verified.ServerEntry -ExpectedNativeAddons $verified.NativeAddons | Out-Null
        $launchers = Start-AllSpaces $recordedSpaces
        $targetsByHome = Await-AllReleases $recordedSpaces $targetRelease $expectedBuildId $launchers $tokensByHome
    } catch {
        $startFailure = $_
        Write-Warning ("New release {0} failed to start: {1}. Rolling back to {2}." -f $targetRelease, $startFailure.Exception.Message, $state.oldReleaseId)
        $state.phase = 'starting_failed'; Save-State
        Stop-ReleaseProcesses $targetRelease @($launchers.Values) $allHomes
        try {
            Restore-OriginalRelease -RequireActiveSync
            $rollbackLaunchers = Start-AllSpaces $recordedSpaces
            $restoredByHome = Await-AllReleases $recordedSpaces $state.oldReleaseId $state.oldBuildId $rollbackLaunchers $tokensByHome
            Clear-SwitchControlsForAllSpaces $restoredByHome $recordedSpaces $true
            $null = Ensure-TrayHostRunning $recordedSpaces
            $state.phase = 'complete'; Save-State
            $primaryRestored = $restoredByHome[$homePath.ToLowerInvariant()]
            $script:report.outcome = 'rolled_back'
            $script:report.postServerMeta = Format-ServerMetaReport $primaryRestored
            foreach ($repSpace in @($script:report.spaces)) {
                $k = ([string]$repSpace.kikiHome).ToLowerInvariant()
                if ($restoredByHome.ContainsKey($k)) { $repSpace.postServerMeta = Format-ServerMetaReport $restoredByHome[$k] }
            }
            Write-Warning ("Rolled back to previous release {0} ({1}) after new release failed to start." -f $state.oldReleaseId, $primaryRestored.meta.server_id)
        } catch {
            Write-Warning ("Automatic rollback to {0} failed: {1}" -f $state.oldReleaseId, $_.Exception.Message)
        }
        throw $startFailure
    }

    $state.phase = 'resuming'; Save-State
    $primaryTarget = $targetsByHome[$homePath.ToLowerInvariant()]
    $script:report.postServerMeta = Format-ServerMetaReport $primaryTarget
    foreach ($repSpace in @($script:report.spaces)) {
        $k = ([string]$repSpace.kikiHome).ToLowerInvariant()
        if ($targetsByHome.ContainsKey($k)) { $repSpace.postServerMeta = Format-ServerMetaReport $targetsByHome[$k] }
    }
    Release-OurPausesForAllSpaces $targetsByHome $recordedSpaces $interruptedAfterSettle
    $null = Ensure-TrayHostRunning $recordedSpaces
    $state.phase = 'complete'; Save-State
    $script:report.outcome = 'succeeded'
    $script:report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    Save-Report
    Write-Host "Running $targetRelease ($($primaryTarget.meta.server_id))"
} catch {
    $failure = $_
    if ($pauseOwnersByHome.Count -gt 0 -and $null -ne $state -and ($state.phase -eq 'pausing' -or $state.phase -eq 'switching')) {
        try {
            $recordedSpaces = @(Get-RecordedSpaces $state)
            $fenceFailures = @()
            foreach ($spState in $recordedSpaces) {
                $k = ([string]$spState.kikiHome).ToLowerInvariant()
                if (-not $pauseOwnersByHome.ContainsKey($k)) { continue }
                $fenceOpId = [string](Get-ObjectProperty $spState 'fenceOperationId')
                if ([string]::IsNullOrWhiteSpace($fenceOpId)) { continue }
                $cancelResult = @{}
                Try-RuntimeSwitch $pauseOwnersByHome[$k].instance $fenceOpId 'cancel' $cancelResult
                if (-not [bool]$cancelResult.released) {
                    $errDetail = if (-not [string]::IsNullOrWhiteSpace([string]$cancelResult.error)) { [string]$cancelResult.error } else { 'fence cancel unconfirmed' }
                    $fenceFailures += ("{0}: {1}" -f $spState.kikiHome, $errDetail)
                }
            }
            $pauseError = $null
            try {
                Release-OurPausesForAllSpaces $pauseOwnersByHome $recordedSpaces $true
            } catch {
                $pauseError = $_.Exception.Message
            }
            if ($fenceFailures.Count -eq 0 -and $null -eq $pauseError) {
                $state.phase = 'complete'; Save-State
                Write-Warning 'The running service was not switched; fences and pauses were released and current.json remains promoted to the verified target release.'
            } else {
                $parts = @()
                if ($fenceFailures.Count -gt 0) { $parts += ('Fence release still pending: ' + ($fenceFailures -join '; ')) }
                if ($null -ne $pauseError) { $parts += ("Pause release still pending: $pauseError") }
                Write-Warning ($parts -join ' | ')
            }
        } catch { Write-Warning "Pause recovery is still pending: $($_.Exception.Message)" }
    }
    if ($null -ne $script:report) {
        if ($script:report.outcome -eq 'in_progress') { $script:report.outcome = 'failed' }
        $script:report.error = $failure.Exception.Message
        $script:report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
        Save-Report
    }
    if (Test-Path -LiteralPath $statePath) {
        Write-Warning "Switch record: $statePath"
        if ($null -eq $state -or $state.phase -ne 'complete') {
            Write-Warning ('Recovery: & ''{0}'' -RuntimeRoot ''{1}'' -KikiHome ''{2}'' -Recover' -f $entryScript.Replace("'", "''"), $runtime.Replace("'", "''"), $homePath.Replace("'", "''"))
        }
    }
    throw $failure
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
