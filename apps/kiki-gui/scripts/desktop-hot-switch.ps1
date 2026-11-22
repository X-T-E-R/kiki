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
    [switch]$CanaryCheck,
    [ValidateRange(0, 86400)][int]$CanaryTimeoutSeconds = 0,
    [ValidateRange(0, 300)][int]$DetachDelaySeconds = 5,
    [ValidateRange(1, 86400)][int]$SettleSeconds = 600,
    [ValidateRange(1, 3600)][int]$StartupSeconds = 90,
    [ValidateRange(1, 300)][int]$StopGraceSeconds = 30,
    [bool]$InterruptAfterSettle = $true,
    [switch]$NoInterruptAfterSettle
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

function Call-Local([object]$Server, [string]$Path, [object]$Body, [int]$TimeoutSeconds = 60) {
    $headers = @{ Authorization = 'Bearer ' + $ownerToken }
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

function Try-RuntimeSwitch([object]$Server, [string]$OperationId, [string]$Action) {
    if (!$OperationId) { return }
    try {
        Call-Local $Server 'runtime-switch' @{ operationId = $OperationId; serverId = $Server.server_id; action = $Action } | Out-Null
    } catch {
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        $response = if ($null -ne $responseProperty) { $responseProperty.Value } else { $null }
        if ($null -eq $response -or $response.StatusCode.value__ -ne 404) { Write-Verbose "runtime-switch ($Action) skipped: $($_.Exception.Message)" }
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

function Get-HomeRegisteredServerPids {
    $pids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($file in @(Get-ChildItem -LiteralPath $instances -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
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

function Get-OtherActiveServerPids([int[]]$OwnedPids = @()) {
    $ownedSet = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($pidVal in @($OwnedPids)) {
        if ($pidVal -gt 0) { $null = $ownedSet.Add($pidVal) }
    }
    $expectedActiveServer = Join-Path (Get-ActivePath $runtime) 'kiki-server.exe'
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
    return @($otherPids)
}

function Get-RuntimeServerBinaryInfo([string]$BinaryPath) {
    if ([string]::IsNullOrWhiteSpace($BinaryPath)) { return $null }
    $expectedActiveServer = Join-Path (Get-ActivePath $runtime) 'kiki-server.exe'
    if ($BinaryPath -ieq $expectedActiveServer) {
        $activeReleaseId = Resolve-ActiveReleaseId $runtime
        if ([string]::IsNullOrWhiteSpace($activeReleaseId)) { return $null }
        return [pscustomobject]@{ layout = 'active'; releaseId = $activeReleaseId; executablePath = $BinaryPath }
    }
    $releasesPrefix = (Join-Path $runtime 'releases') + '\'
    if ($BinaryPath.StartsWith($releasesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $releaseId = Split-Path -Leaf (Split-Path -Parent $BinaryPath)
        if ($releaseId -match '^[0-9a-f]{24}-[0-9a-f]{24}$' -and $BinaryPath -ieq (Join-Path (Get-ReleasePath $runtime $releaseId) 'kiki-server.exe')) {
            return [pscustomobject]@{ layout = 'releases'; releaseId = $releaseId; executablePath = $BinaryPath }
        }
    }
    return $null
}

function Find-Server {
    $matches = @(
        foreach ($file in Get-ChildItem -LiteralPath $instances -Filter '*.json' -File -ErrorAction SilentlyContinue) {
            $instance = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            if ($instance.host -notin @('127.0.0.1', 'localhost') -or $instance.port -le 0) { continue }
            $process = Get-Process -Id $instance.pid -ErrorAction SilentlyContinue
            if ($null -eq $process -or $file.BaseName -cne $instance.server_id) { continue }
            $startedAt = ([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()
            if ([Math]::Abs($startedAt - [long]$instance.started_at) -gt 60000) { continue }
            $binary = Get-ProcessPathSafe $process
            $binaryInfo = Get-RuntimeServerBinaryInfo $binary
            if ($null -eq $binaryInfo) { continue }
            $meta = Call-Local $instance 'meta'
            if ($meta.server_id -cne $instance.server_id -or !$meta.desktop_managed -or $meta.dangerous_bypass_auth `
                -or $meta.build_id -cne $instance.build_id) { throw 'The local service identity does not match its registration.' }
            $process.EnableRaisingEvents = $true
            $null = $process.Handle
            [pscustomobject]@{
                instance = $instance
                process = $process
                meta = $meta
                releaseId = $binaryInfo.releaseId
                executablePath = $binaryInfo.executablePath
                layout = $binaryInfo.layout
            }
        }
    )
    if ($matches.Count -gt 1) { throw 'More than one managed service is active in this home. Close the extra instance before switching.' }
    if ($matches.Count -eq 1) { return $matches[0] }
}

function Find-Shells {
    $expectedActiveDesktop = Join-Path (Get-ActivePath $runtime) 'kiki-desktop.exe'
    $releasesPrefix = (Join-Path $runtime 'releases') + '\'
    Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue | Where-Object {
        $procPath = Get-ProcessPathSafe $_
        $procPath -and (
            ($procPath -ieq $expectedActiveDesktop) -or
            ($procPath.StartsWith($releasesPrefix, [StringComparison]::OrdinalIgnoreCase))
        )
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

function Get-LiveInspectionSnapshot([object]$ServerInfo, [object[]]$Shells = @()) {
    if ($null -eq $ServerInfo) {
        return [ordered]@{
            server = $null
            shells = @($Shells | ForEach-Object { [ordered]@{ pid = [int]$_.Id; executablePath = (Get-ProcessPathSafe $_) } })
            lifecycle = $null
            workPendingSessions = @()
        }
    }
    $lifecycle = Lifecycle $ServerInfo.instance ''
    $pendingDetails = @(
        foreach ($sid in @($lifecycle.work_pending)) {
            $control = $null
            $readError = $null
            try { $control = Execution $ServerInfo.instance $sid 'read' }
            catch { $readError = $_.Exception.Message }
            $agents = @(Get-ObjectProperty $control 'agents')
            $activeTaskCount = if ($null -ne $control) { Get-SessionActiveTaskCount $ServerInfo.instance $sid $control } else { 0 }
            [ordered]@{
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
            }
        }
    )
    return [ordered]@{
        server = [ordered]@{
            server_id = [string]$ServerInfo.meta.server_id
            pid = [int]$ServerInfo.process.Id
            port = [int]$ServerInfo.instance.port
            executablePath = [string]$ServerInfo.executablePath
            layout = [string]$ServerInfo.layout
            releaseId = [string]$ServerInfo.releaseId
            build_id = [string]$ServerInfo.meta.build_id
            server_version = Get-ObjectProperty $ServerInfo.meta 'server_version'
            server_home_id = [string]$ServerInfo.meta.server_home_id
            current_space_id = [string]$ServerInfo.meta.current_space_id
            desktop_managed = [bool]$ServerInfo.meta.desktop_managed
        }
        shells = @($Shells | ForEach-Object { [ordered]@{ pid = [int]$_.Id; executablePath = (Get-ProcessPathSafe $_) } })
        lifecycle = [ordered]@{
            managed = [bool](Get-ObjectProperty $lifecycle 'managed')
            draining = [bool](Get-ObjectProperty $lifecycle 'draining')
            hot_switch_prepared = [bool](Get-ObjectProperty $lifecycle 'hot_switch_prepared')
            work_pending = @($lifecycle.work_pending)
        }
        workPendingSessions = $pendingDetails
    }
}

function New-CanaryOwnerToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Invoke-CanaryCheck([string]$ServerExePath, [string]$ExpectedBuildId = '', [int]$TimeoutSeconds = 0) {
    if (-not (Test-Path -LiteralPath $ServerExePath -PathType Leaf)) {
        throw "Canary server executable is missing: $ServerExePath"
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
        $psi.Arguments = 'serve --port 0 --idle-exit 2m'
        $psi.WorkingDirectory = Split-Path -Parent $ServerExePath
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.EnvironmentVariables['KIKI_HOME'] = $canaryHome
        $psi.EnvironmentVariables['KIKI_SEARCH_DISABLED'] = '1'
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
        do {
            if ($proc.HasExited) {
                throw "Canary server exited prematurely with code $($proc.ExitCode)."
            }
            $ownedPids = @(Get-ProcessTreePids @([int]$proc.Id))
            if ($ownedPids.Count -eq 0) {
                throw "Canary server lost process liveness before reporting readiness."
            }
            foreach ($file in @(Get-ChildItem -LiteralPath $canaryInstances -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
                try {
                    $inst = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
                    $instPid = [int]$inst.pid
                    if ($instPid -le 0 -or [int]$inst.port -le 0) { continue }
                    if ($ownedPids -notcontains $instPid) { continue }
                    if ($inst.host -notin @('127.0.0.1', 'localhost')) { continue }
                    $liveToken = [IO.File]::ReadAllText((Join-Path $canaryHome 'server.local-owner')).Trim()
                    $headers = @{ Authorization = 'Bearer ' + $liveToken }
                    $url = 'http://127.0.0.1:{0}/api/meta' -f $inst.port
                    $reply = Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec 5
                    if ($reply.code -eq 0 -and $reply.data.server_id -ceq $inst.server_id) {
                        $canaryPort = [int]$inst.port
                        $canaryServerId = [string]$inst.server_id
                        $canaryServerPid = $instPid
                        $canaryManaged = [bool](Get-ObjectProperty $reply.data 'desktop_managed')
                        $canaryToken = $liveToken
                        $meta = $reply.data
                        break
                    }
                } catch {
                }
            }
            if ($null -ne $meta) { break }
            Start-Sleep -Milliseconds 150
        } while ($null -eq $deadline -or [DateTime]::UtcNow -lt $deadline)

        if ($null -eq $meta) {
            throw "Canary server did not report /api/meta readiness within ${TimeoutSeconds}s."
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

function Close-DesktopShell([object]$Shell) {
    if ($Shell.HasExited) { return }
    $prefsPath = Join-Path $homePath 'desktop.json'
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
                if (!$hadPrefs -and $prefs.PSObject.Properties.Count -eq 0) { Remove-Item -LiteralPath $prefsPath }
                else { Write-AtomicUtf8Json $prefsPath $prefs }
            }
        }
    }
}

function Wait-ForExit([object]$Old, [object[]]$Shells, [bool]$InterruptedAfterSettle = $false) {
    $graceSeconds = [Math]::Min($StartupSeconds, $StopGraceSeconds)
    $oldDirs = New-Object System.Collections.Generic.List[string]
    $oldExePath = Get-ObjectProperty $Old 'executablePath'
    if (-not [string]::IsNullOrWhiteSpace([string]$oldExePath)) {
        $oldDirs.Add((Split-Path -Parent ([string]$oldExePath)))
    }
    $oldDirs.Add((Get-ActivePath $runtime))
    if ($Old.releaseId -match '^[0-9a-f]{24}-[0-9a-f]{24}$') {
        $oldDirs.Add((Get-ReleasePath $runtime $Old.releaseId))
    }
    $uniqueDirs = @($oldDirs | Select-Object -Unique)
    $oldDesktopExes = @($uniqueDirs | ForEach-Object { Join-Path $_ 'kiki-desktop.exe' })
    $oldInstancePath = Join-Path $instances ($Old.meta.server_id + '.json')

    # Snapshot the process tree owned by $Old before it exits so we only sweep its own worker children
    # and never touch another Kiki home's server sharing active\kiki-server.exe.
    $ownedWorkerPids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($treePid in @(Get-ProcessTreePids @([int]$Old.process.Id))) {
        if ($treePid -ne [int]$Old.process.Id) { $null = $ownedWorkerPids.Add($treePid) }
    }

    $exitedGracefully = $Old.process.WaitForExit($graceSeconds * 1000)
    if (-not $exitedGracefully) {
        Write-Warning ("Original service {0} (pid {1}) did not exit within {2}s; closing old desktop shell and force-stopping original service." -f $Old.meta.server_id, $Old.process.Id, $graceSeconds)
        foreach ($shell in $Shells) { Close-DesktopShell $shell }
        foreach ($lingeringShell in @(Find-Shells | Where-Object { $p = Get-ProcessPathSafe $_; $p -and ($oldDesktopExes -contains $p) })) {
            try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
            Close-DesktopShell $lingeringShell
        }
        foreach ($treePid in @(Get-ProcessTreePids @([int]$Old.process.Id))) {
            if ($treePid -ne [int]$Old.process.Id) { $null = $ownedWorkerPids.Add($treePid) }
        }
        Stop-ProcessBounded $Old.process 5000
        if (-not $Old.process.HasExited) {
            throw ("Original service {0} (pid {1}) could not be terminated." -f $Old.meta.server_id, $Old.process.Id)
        }
    } else {
        $exitCode = $Old.process.ExitCode
        if ($exitCode -ne 0) {
            Write-Warning ("Original service {0} (pid {1}) exited with code {2} (interrupted={3}); continuing hot switch." -f $Old.meta.server_id, $Old.process.Id, $exitCode, $InterruptedAfterSettle)
        }
        foreach ($shell in $Shells) { Close-DesktopShell $shell }
        foreach ($lingeringShell in @(Find-Shells | Where-Object { $p = Get-ProcessPathSafe $_; $p -and ($oldDesktopExes -contains $p) })) {
            try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
            Close-DesktopShell $lingeringShell
        }
    }

    if (Test-Path -LiteralPath $oldInstancePath -PathType Leaf) {
        Write-Warning ("Removing leftover instance registration after old service exit: {0}" -f $oldInstancePath)
        Remove-Item -LiteralPath $oldInstancePath -Force -ErrorAction SilentlyContinue
    }
    foreach ($regPid in @(Get-HomeRegisteredServerPids)) {
        if ($regPid -ne [int]$Old.process.Id) { $null = $ownedWorkerPids.Add($regPid) }
    }
    foreach ($workerPid in @($ownedWorkerPids)) {
        $lingeringWorker = Get-Process -Id $workerPid -ErrorAction SilentlyContinue
        if ($null -ne $lingeringWorker -and (-not $lingeringWorker.HasExited)) {
            Write-Warning ("Stopping lingering worker process {0} owned by old service {1}." -f $lingeringWorker.Id, $Old.releaseId)
            Stop-ProcessBounded $lingeringWorker 5000
        }
    }
    foreach ($lingeringShell in @(Find-Shells | Where-Object { $p = Get-ProcessPathSafe $_; $p -and ($oldDesktopExes -contains $p) })) {
        try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
        Close-DesktopShell $lingeringShell
    }
    $otherActive = @(Get-OtherActiveServerPids @())
    if ($otherActive.Count -gt 0) {
        throw ("Another Kiki home/instance is holding active\kiki-server.exe (PIDs: {0}); cannot sync active runtime." -f ($otherActive -join ', '))
    }
    if (@(Find-Shells).Count -gt 0 -or $null -ne (Find-Server)) { throw 'Another desktop or managed service appeared before launch.' }
}

function Await-Release([string]$ReleaseId, [string]$ExpectedBuildId, [object]$Launcher) {
    if ([string]::IsNullOrWhiteSpace($ExpectedBuildId)) {
        throw 'Expected build commit is required when awaiting a switched release.'
    }
    $expectedActiveServer = Join-Path (Get-ActivePath $runtime) 'kiki-server.exe'
    $expectedActiveDesktop = Join-Path (Get-ActivePath $runtime) 'kiki-desktop.exe'
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupSeconds)
    do {
        $new = Find-Server
        if ($null -ne $new) {
            if ($new.releaseId -cne $ReleaseId -or $new.meta.server_id -ceq $state.oldServerId `
                -or $new.meta.server_home_id -cne $state.serverHomeId -or $new.meta.current_space_id -cne $state.spaceId) {
                throw 'The service that started does not match the selected release and home.'
            }
            if ($new.meta.build_id -cne $ExpectedBuildId -or $new.instance.build_id -cne $ExpectedBuildId) {
                throw ("The started service reported build_id '{0}' instead of expected commit '{1}'." -f $new.meta.build_id, $ExpectedBuildId)
            }
            $newExePath = Get-ObjectProperty $new 'executablePath'
            if (-not [string]::IsNullOrWhiteSpace([string]$newExePath) -and ([string]$newExePath) -ine $expectedActiveServer) {
                throw ("The started service is running from '{0}' instead of active path '{1}'." -f $newExePath, $expectedActiveServer)
            }
            if ($state.hadDesktop -and @((Find-Shells) | Where-Object { (Get-ProcessPathSafe $_) -ieq $expectedActiveDesktop }).Count -ne 1) {
                throw 'The new service is ready, but the selected desktop shell is not running from active.'
            }
            return $new
        }
        if ($Launcher.HasExited -and $Launcher.ExitCode -ne 0) { throw "The selected desktop exited with code $($Launcher.ExitCode) before its service was ready." }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The selected release did not start its local service before the startup deadline.'
}

function Test-InstalledRelease([string]$ReleaseId) {
    if ([string]::IsNullOrWhiteSpace($ReleaseId) -or $ReleaseId -notmatch '^[0-9a-f]{24}-[0-9a-f]{24}$') { return $false }
    try {
        $path = Get-ReleasePath $runtime $ReleaseId
        $desktopPath = Join-Path $path 'kiki-desktop.exe'
        $serverPath = Join-Path $path 'kiki-server.exe'
        if (-not (Test-Path -LiteralPath $desktopPath -PathType Leaf) -or -not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
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
    $desktop = Get-ArtifactInfo (Join-Path $path 'kiki-desktop.exe') "$Label Kiki GUI"
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
        Sync-ActiveRelease $runtime $ReleaseId $BuildId $desktop $server | Out-Null
    } else {
        Sync-ActiveRelease $runtime $ReleaseId $BuildId $desktop $server -SkipIfLocked | Out-Null
    }
}

function Restore-OriginalRelease([switch]$RequireActiveSync) {
    Select-InstalledRelease $state.oldReleaseId $state.oldBuildId 'Original' -RequireActiveSync:$RequireActiveSync
}

function Stop-ReleaseProcesses([string]$ReleaseId, [object]$Launcher = $null) {
    # Bind cleanup strictly to the launcher process tree and instances registered in THIS KikiHome.
    $ownedPids = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($null -ne $Launcher) {
        foreach ($treePid in @(Get-ProcessTreePids @([int]$Launcher.Id))) {
            $null = $ownedPids.Add($treePid)
        }
        Stop-ProcessBounded $Launcher 5000
    }
    foreach ($regPid in @(Get-HomeRegisteredServerPids)) {
        foreach ($treePid in @(Get-ProcessTreePids @($regPid))) {
            $null = $ownedPids.Add($treePid)
        }
    }
    foreach ($ownedPid in @($ownedPids)) {
        $proc = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
        if ($null -eq $proc -or $proc.HasExited) { continue }
        if ($proc.ProcessName -ieq 'kiki-desktop') {
            try { $proc.EnableRaisingEvents = $true; $null = $proc.Handle } catch {}
            Close-DesktopShell $proc
        } else {
            Stop-ProcessBounded $proc 5000
        }
    }
    foreach ($file in Get-ChildItem -LiteralPath $instances -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        try {
            $instance = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            if ($null -eq (Get-Process -Id $instance.pid -ErrorAction SilentlyContinue)) {
                Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
}

function Clear-SwitchControls([object]$Target, [bool]$AllowCancel) {
    if ((Get-ObjectProperty (Lifecycle $Target.instance '') 'hot_switch_prepared') -eq $true) {
        Lifecycle $Target.instance 'cancel-update' | Out-Null
    }
    Try-RuntimeSwitch $Target.instance (Get-ObjectProperty $state 'fenceOperationId') 'cancel'
    Release-OurPauses $Target $AllowCancel
}

function Release-OurPauses([object]$Target, [bool]$AllowCancel) {
    $failures = @()
    $resumed = @()
    $failureRecords = @()
    foreach ($item in @(Get-ObjectProperty $state 'sessions')) {
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
            $failureRecords += [ordered]@{ sessionId = [string]$item.id; error = $msg }
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

if ($InspectOnly) {
    $ownerPath = Join-Path $homePath 'server.local-owner'
    $ownerToken = $null
    $tokenError = $null
    if (Test-Path -LiteralPath $ownerPath -PathType Leaf) {
        $rawToken = [IO.File]::ReadAllText($ownerPath).Trim()
        if ($rawToken -match '^[A-Za-z0-9_-]{43}$') { $ownerToken = $rawToken }
        else { $tokenError = 'The local-owner capability is invalid.' }
    } else {
        $tokenError = 'No local-owner capability file found.'
    }
    $live = if ($null -ne $ownerToken) { Find-Server } else { $null }
    $shells = @(Find-Shells)
    $snapshot = Get-LiveInspectionSnapshot $live $shells
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
                    $canaryReport = Invoke-CanaryCheck $verifiedCand.Sidecar.Path $verifiedCand.GitSha $CanaryTimeoutSeconds
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
        liveServer = $snapshot.server
        shells = $snapshot.shells
        lifecycle = $snapshot.lifecycle
        workPendingSessions = $snapshot.workPendingSessions
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
$pauseOwner = $null
$script:report = $null
try {
    $ownerPath = Join-Path $homePath 'server.local-owner'
    if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) { throw 'The selected home has no local-owner capability. Start its managed desktop normally and verify the home before switching.' }
    $ownerToken = [IO.File]::ReadAllText($ownerPath).Trim()
    if ($ownerToken -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'The local-owner capability is invalid.' }
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
    if ($Recover) {
        if ($null -eq $state -or $state.schemaVersion -ne 1 -or $state.kikiHome -ine $homePath -or $state.phase -eq 'complete') {
            throw 'There is no unfinished switch for this runtime and home.'
        }
        $shouldRollback = [bool]$Rollback -or ($state.phase -eq 'starting_failed')
        $target = Find-Server
        if ($null -eq $target) {
            foreach ($lingeringShell in @(Find-Shells)) {
                try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
                Close-DesktopShell $lingeringShell
            }
            if (@(Find-Shells).Count -gt 0) { throw 'Quit the remaining desktop from its tray before retrying recovery.' }
            $otherActive = @(Get-OtherActiveServerPids @())
            if ($otherActive.Count -gt 0) {
                throw ("Another Kiki home/instance is holding active\kiki-server.exe (PIDs: {0}); close it before recovery." -f ($otherActive -join ', '))
            }
            $targetReleaseId = [string](Get-ObjectProperty $state 'targetReleaseId')
            $targetBuildId = [string](Get-ObjectProperty $state 'targetBuildId')
            if ((-not $shouldRollback) -and (-not [string]::IsNullOrWhiteSpace($targetReleaseId)) -and (-not [string]::IsNullOrWhiteSpace($targetBuildId)) -and (Test-InstalledRelease $targetReleaseId)) {
                $launcher = $null
                try {
                    Select-InstalledRelease $targetReleaseId $targetBuildId 'Target' -RequireActiveSync
                    $launcher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
                    $target = Await-Release $targetReleaseId $targetBuildId $launcher
                } catch {
                    Write-Warning ("Target release {0} failed to start during recovery: {1}. Rolling back to {2}." -f $targetReleaseId, $_.Exception.Message, $state.oldReleaseId)
                    $state.phase = 'starting_failed'; Save-State
                    Stop-ReleaseProcesses $targetReleaseId $launcher
                    Restore-OriginalRelease -RequireActiveSync
                    $rollbackLauncher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
                    $target = Await-Release $state.oldReleaseId $state.oldBuildId $rollbackLauncher
                }
            } else {
                Restore-OriginalRelease -RequireActiveSync
                $launcher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
                $target = Await-Release $state.oldReleaseId $state.oldBuildId $launcher
            }
        } elseif ($target.meta.server_home_id -cne $state.serverHomeId -or $target.meta.current_space_id -cne $state.spaceId -or
            $target.releaseId -cnotin @($state.oldReleaseId, $state.targetReleaseId, $state.priorPointerReleaseId)) {
            throw 'Recovery found a different service. Leave it running and inspect the switch record.'
        } elseif ($shouldRollback) {
            Restore-OriginalRelease
        }
        Clear-SwitchControls $target $true
        $state.phase = 'complete'; Save-State
        Write-Host "Recovery complete: $($target.releaseId)"
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
    $old = Find-Server

    if ($null -ne $state -and $state.phase -ne 'complete' -and $state.schemaVersion -eq 1 -and $state.kikiHome -ine $homePath) {
        throw 'A switch for another Kiki home is unfinished. Run this command with -Recover for that home first.'
    }
    if ($null -eq $old) { throw 'No authenticated managed service is running from this runtime and home.' }
    $current = Read-CurrentManifest $runtime -AllowMissing
    $priorPointerReleaseId = if ($null -ne $current) { [string]$current.releaseId } else { $old.releaseId }
    $shells = @(Find-Shells)

    $script:report = [ordered]@{
        schemaVersion = 1
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
        finishedAtUtc = $null
        outcome = 'in_progress'
        runtimeRoot = $runtime
        kikiHome = $homePath
        targetReleaseId = $targetRelease
        targetBuildId = $expectedBuildId
        preSnapshot = Get-LiveInspectionSnapshot $old $shells
        canaryPassed = $null
        canary = $null
        pausedSessions = @()
        skippedFailedOrIdleSessions = @()
        interruptedAfterSettle = $false
        interruptedSessions = @()
        postServerMeta = $null
        resumedSessions = @()
        resumeFailures = @()
        error = $null
    }

    # Only short-circuit as already_running when the live process is BOTH on $targetRelease AND running from active\.
    if ($old.releaseId -ceq $targetRelease -and $old.layout -eq 'active') {
        Invoke-Promotion $runtime $verified | Out-Host
        $script:report.outcome = 'already_running'
        $script:report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
        $script:report.postServerMeta = $script:report.preSnapshot.server
        Save-Report
        Write-Host "Already running $targetRelease"
        return
    }

    $expectedOldDesktopExe = Get-ExpectedDesktopPathForServer $old
    if ($shells.Count -gt 1 -or @($shells | Where-Object { (Get-ProcessPathSafe $_) -ine $expectedOldDesktopExe }).Count) {
        throw 'Close extra desktop shells; the running shell must match the service being switched.'
    }

    # Pre-drain safety checks BEFORE any mutation:
    # 1. Verify rollback archive releases\<oldReleaseId>\ exists and matches its hash.
    if (-not (Test-InstalledRelease $old.releaseId)) {
        throw ("Rollback archive releases\{0} is missing or corrupt; refusing to drain the running service." -f $old.releaseId)
    }
    # 2. Verify no other Kiki home/space is running from active\kiki-server.exe.
    $ownedBeforeDrain = @(Get-ProcessTreePids @([int]$old.process.Id))
    $otherActiveBeforeDrain = @(Get-OtherActiveServerPids $ownedBeforeDrain)
    if ($otherActiveBeforeDrain.Count -gt 0) {
        throw ("Another Kiki home/instance is running from active\kiki-server.exe (PIDs: {0}). Close other spaces sharing this runtime before hot-switching." -f ($otherActiveBeforeDrain -join ', '))
    }

    # 3. Run canary check BEFORE reconciling stale state or promoting so a bad candidate leaves live state completely untouched.
    if ($CanaryCheck) {
        try {
            $canaryResult = Invoke-CanaryCheck $verified.Sidecar.Path $expectedBuildId $CanaryTimeoutSeconds
            $script:report.canaryPassed = $true
            $script:report.canary = $canaryResult
            Write-Host ("Canary check passed (build={0}, elapsed={1}ms)" -f $canaryResult.build_id, $canaryResult.elapsedMs)
        } catch {
            $script:report.canaryPassed = $false
            $script:report.canary = [ordered]@{ passed = $false; error = $_.Exception.Message }
            throw ("Canary check failed; live desktop was not modified: {0}" -f $_.Exception.Message)
        }
    }

    $continuing = $false
    if ($null -ne $state -and $state.phase -ne 'complete') {
        if ($state.schemaVersion -eq 1 -and $state.phase -eq 'pausing' -and
            $state.oldServerId -ceq $old.meta.server_id -and $state.targetReleaseId -ceq $targetRelease) {
            $continuing = $true
        } else {
            Write-Warning ("Reconciling stale hot-switch record (phase={0}, old={1}, target={2}) before starting new switch." -f $state.phase, $state.oldReleaseId, $state.targetReleaseId)
            if ($state.schemaVersion -eq 1 -and $old.meta.server_home_id -ceq $state.serverHomeId -and $old.meta.current_space_id -ceq $state.spaceId) {
                Clear-SwitchControls $old $true
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
        Write-Host ("Detached hot-switch scheduled (wmiPid={0}, delay={1}s, target={2}, log={3})" -f $wmiRes.ProcessId, $DetachDelaySeconds, $targetRelease, $logPath)
        return
    }
    foreach ($shell in $shells) { try { $shell.EnableRaisingEvents = $true; $null = $shell.Handle } catch {} }
    if ($continuing) {
        if (-not (Get-ObjectProperty $state 'fenceOperationId')) {
            $state | Add-Member -NotePropertyName fenceOperationId -NotePropertyValue ('hot-switch:' + [guid]::NewGuid().ToString('N')) -Force
            Save-State
        }
    } else {
        $state = [pscustomobject]@{
            schemaVersion = 1; phase = 'pausing'; kikiHome = $homePath; oldReleaseId = $old.releaseId; oldBuildId = $old.meta.build_id
            oldServerId = $old.meta.server_id; serverHomeId = $old.meta.server_home_id; spaceId = $old.meta.current_space_id
            priorPointerReleaseId = $priorPointerReleaseId; targetReleaseId = $targetRelease; targetBuildId = $expectedBuildId; hadDesktop = $shells.Count -gt 0
            fenceOperationId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
            sessions = @()
        }
        Save-State
    }
    $pauseOwner = $old
    Try-RuntimeSwitch $old.instance $state.fenceOperationId 'fence'
    $interruptedAfterSettle = $false
    $interruptedSessions = @()
    $notedPhases = @{}
    $deadline = [DateTime]::UtcNow.AddSeconds($SettleSeconds)
    do {
        $lifecycle = Lifecycle $old.instance ''
        foreach ($id in @($lifecycle.work_pending)) {
            $control = Execution $old.instance $id 'read'
            if ($control.phase -eq 'running') {
                $item = [pscustomobject]@{ id = $id; pauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N') }
                $state.sessions = @($state.sessions | Where-Object id -CNE $id) + @($item)
                Save-State
                Execution $old.instance $id 'pause' @(@{ operationId = $item.pauseId }) | Out-Null
                Write-Host "Pausing $id"
            } elseif ($control.phase -in @('failed', 'idle')) {
                if ($notedPhases[$id] -cne $control.phase) {
                    $notedPhases[$id] = $control.phase
                    Write-Host "Session $id is $($control.phase); no pause needed."
                }
            } elseif ($control.phase -eq 'resuming') {
                if ($notedPhases[$id] -cne 'resuming') {
                    $notedPhases[$id] = 'resuming'
                    Write-Host "Session $id is resuming; waiting up to settle deadline."
                }
            }
        }
        $pending = @($lifecycle.work_pending)
        if ($pending.Count -eq 0) { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            if (-not $allowInterruptAfterSettle) {
                throw ('Still settling: ' + ($pending -join ', '))
            }
            Write-Warning ('Settle deadline ({0}s) expired with active work ({1}); interrupting remaining work to complete hot switch.' -f $SettleSeconds, ($pending -join ', '))
            $interruptedAfterSettle = $true
            $interruptedSessions = @($pending)
            break
        }
        Start-Sleep -Milliseconds 400
    } while ($true)
    $script:report.pausedSessions = @($state.sessions | ForEach-Object { [ordered]@{ id = [string]$_.id; pauseId = [string]$_.pauseId } })
    $script:report.interruptedAfterSettle = $interruptedAfterSettle
    $script:report.interruptedSessions = @($interruptedSessions)
    # The explicit exit record blocks reconnect recovery while the shell drains the backend pipes.
    if ($interruptedAfterSettle) {
        if ((Get-ObjectProperty $lifecycle 'hot_switch_prepared') -eq $true) {
            try { Lifecycle $old.instance 'cancel-update' | Out-Null } catch { Write-Warning "cancel-update failed: $($_.Exception.Message)" }
        }
        try {
            Lifecycle $old.instance 'update' $true | Out-Null
        } catch {
            Write-Warning ("Lifecycle 'update' (interrupt_work=true) failed: {0}. Proceeding to bounded shutdown." -f $_.Exception.Message)
        }
    } else {
        Lifecycle $old.instance 'update' | Out-Null
    }
    $state.phase = 'stopping'; Save-State
    Wait-ForExit $old $shells $interruptedAfterSettle
    $state.phase = 'starting'; Save-State
    $launcher = $null
    try {
        if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) {
            Invoke-Promotion $runtime $verified | Out-Host
            if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) { throw 'Promotion did not select the verified candidate.' }
        }
        Sync-ActiveRelease $runtime $targetRelease $expectedBuildId $verified.Desktop $verified.Sidecar | Out-Null
        $launcher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
        $target = Await-Release $targetRelease $expectedBuildId $launcher
    } catch {
        $startFailure = $_
        Write-Warning ("New release {0} failed to start: {1}. Rolling back to {2}." -f $targetRelease, $startFailure.Exception.Message, $state.oldReleaseId)
        $state.phase = 'starting_failed'; Save-State
        Stop-ReleaseProcesses $targetRelease $launcher
        try {
            Restore-OriginalRelease -RequireActiveSync
            $rollbackLauncher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
            $restored = Await-Release $state.oldReleaseId $state.oldBuildId $rollbackLauncher
            Clear-SwitchControls $restored $true
            $state.phase = 'complete'; Save-State
            $script:report.outcome = 'rolled_back'
            $script:report.postServerMeta = [ordered]@{
                server_id = [string]$restored.meta.server_id
                pid = [int]$restored.process.Id
                executablePath = [string]$restored.executablePath
                layout = [string]$restored.layout
                releaseId = [string]$restored.releaseId
                build_id = [string]$restored.meta.build_id
                server_version = Get-ObjectProperty $restored.meta 'server_version'
                server_home_id = [string]$restored.meta.server_home_id
                current_space_id = [string]$restored.meta.current_space_id
            }
            Write-Warning ("Rolled back to previous release {0} ({1}) after new release failed to start." -f $state.oldReleaseId, $restored.meta.server_id)
        } catch {
            Write-Warning ("Automatic rollback to {0} failed: {1}" -f $state.oldReleaseId, $_.Exception.Message)
        }
        throw $startFailure
    }
    $state.phase = 'resuming'; Save-State
    $script:report.postServerMeta = [ordered]@{
        server_id = [string]$target.meta.server_id
        pid = [int]$target.process.Id
        executablePath = [string]$target.executablePath
        layout = [string]$target.layout
        releaseId = [string]$target.releaseId
        build_id = [string]$target.meta.build_id
        server_version = Get-ObjectProperty $target.meta 'server_version'
        server_home_id = [string]$target.meta.server_home_id
        current_space_id = [string]$target.meta.current_space_id
    }
    Release-OurPauses $target $interruptedAfterSettle
    $state.phase = 'complete'; Save-State
    $script:report.outcome = 'succeeded'
    $script:report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    Save-Report
    Write-Host "Running $targetRelease ($($target.meta.server_id))"
} catch {
    $failure = $_
    if ($null -ne $pauseOwner -and $state.phase -eq 'pausing') {
        try {
            Try-RuntimeSwitch $pauseOwner.instance (Get-ObjectProperty $state 'fenceOperationId') 'cancel'
            Release-OurPauses $pauseOwner $true
            $state.phase = 'complete'; Save-State
            Write-Warning 'The running service was not switched; pauses were released and current.json remains promoted to the verified target release.'
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
