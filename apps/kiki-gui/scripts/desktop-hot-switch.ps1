[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$KikiHome,
    [string]$CandidateRoot,
    [string]$ExpectedCommit,
    [switch]$Recover,
    [switch]$AllowLegacyDesktopQuit,
    [ValidateRange(1, 86400)][int]$SettleSeconds = 300,
    [ValidateRange(1, 3600)][int]$StartupSeconds = 90
)

$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$homePath = [IO.Path]::GetFullPath($KikiHome)
$candidate = $CandidateRoot
$commit = $ExpectedCommit
$entryScript = $PSCommandPath
. (Join-Path $PSScriptRoot 'desktop-release.ps1') -Action Launch

$statePath = Join-Path $runtime 'hot-switch.json'
$instances = Join-Path $homePath 'server\instances'
$releases = Join-Path $runtime 'releases'

function Call-Local([object]$Server, [string]$Path, [object]$Body) {
    $headers = @{ Authorization = 'Bearer ' + $ownerToken }
    $url = 'http://127.0.0.1:{0}/api/{1}' -f $Server.port, $Path
    if ($null -eq $Body) {
        $reply = Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec 10
    } else {
        $reply = Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec 60 -Method Post `
            -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 6 -Compress)
    }
    if ($reply.code -ne 0) { throw ('{0}: {1} ({2})' -f $Path, $reply.msg, $reply.code) }
    return $reply.data
}

function Execution([object]$Server, [string]$Id, [string]$Method, [object[]]$Arguments = @()) {
    Call-Local $Server 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $Id; service = 'sessionExecutionControl'; method = $Method }
        params = $Arguments
    }
}

function Lifecycle([object]$Server, [string]$Action) {
    $body = if ($Action) { @{ action = $Action; server_id = $Server.server_id; consent = $true; interrupt_work = $false } } else { $null }
    Call-Local $Server 'desktop-lifecycle' $body
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
            $binary = $process.Path
            if (!$binary -or !$binary.StartsWith($releases + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
            $releaseId = Split-Path -Leaf (Split-Path -Parent $binary)
            if ($binary -ine (Join-Path (Get-ReleasePath $runtime $releaseId) 'kiki-server.exe')) { continue }
            $meta = Call-Local $instance 'meta'
            if ($meta.server_id -cne $instance.server_id -or !$meta.desktop_managed -or $meta.dangerous_bypass_auth `
                -or $meta.build_id -cne $instance.build_id) { throw 'The local service identity does not match its registration.' }
            $process.EnableRaisingEvents = $true
            $null = $process.Handle
            [pscustomobject]@{ instance = $instance; process = $process; meta = $meta; releaseId = $releaseId }
        }
    )
    if ($matches.Count -gt 1) { throw 'More than one managed service is active in this home. Close the extra instance before switching.' }
    if ($matches.Count -eq 1) { return $matches[0] }
}

function Find-Shells {
    Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($releases + '\', [StringComparison]::OrdinalIgnoreCase)
    }
}

function Save-State { Write-AtomicUtf8Json $statePath $state }

function Wait-ForExit([object]$Old, [object[]]$Shells) {
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupSeconds)
    while (!$Old.process.HasExited -or @($Shells | Where-Object { !$_.HasExited }).Count -gt 0) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The original desktop or service has not exited. Close it normally, then run recovery.' }
        Start-Sleep -Milliseconds 250
    }
    if ($Old.process.ExitCode -ne 0 -or (Test-Path -LiteralPath (Join-Path $instances ($Old.meta.server_id + '.json')))) {
        throw 'The original service did not confirm a clean shutdown. Inspect its exit before recovering.'
    }
    if (@(Find-Shells).Count -gt 0 -or $null -ne (Find-Server)) { throw 'Another desktop or managed service appeared before launch.' }
}

function Await-Release([string]$ReleaseId, [string]$BuildId, [object]$Launcher) {
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupSeconds)
    do {
        $new = Find-Server
        if ($null -ne $new) {
            if ($new.releaseId -cne $ReleaseId -or $new.meta.build_id -cne $BuildId -or $new.meta.server_id -ceq $state.oldServerId `
                -or $new.meta.server_home_id -cne $state.serverHomeId -or $new.meta.current_space_id -cne $state.spaceId) {
                throw 'The service that started does not match the selected release and home.'
            }
            if ($state.hadDesktop -and @((Find-Shells) | Where-Object { $_.Path -ieq (Join-Path (Get-ReleasePath $runtime $ReleaseId) 'kiki-desktop.exe') }).Count -ne 1) {
                throw 'The new service is ready, but the selected desktop shell is not running.'
            }
            return $new
        }
        if ($Launcher.HasExited -and $Launcher.ExitCode -ne 0) { throw "The selected desktop exited with code $($Launcher.ExitCode) before its service was ready." }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The selected release did not start its local service before the startup deadline.'
}

function Restore-OriginalRelease {
    $path = Get-ReleasePath $runtime $state.oldReleaseId
    $desktop = Get-ArtifactInfo (Join-Path $path 'kiki-desktop.exe') 'Original Kiki GUI'
    $server = Get-ArtifactInfo (Join-Path $path 'kiki-server.exe') 'Original Kiki backend'
    if (('{0}-{1}' -f $desktop.Hash.Substring(0,24), $server.Hash.Substring(0,24)) -cne $state.oldReleaseId) {
        throw 'The original binaries no longer match their installed release. Restore the original release files before continuing.'
    }
    Publish-CliExecutable $runtime $server | Out-Host
    Write-AtomicUtf8Json (Join-Path $runtime 'current.json') ([ordered]@{
        schemaVersion = 1; releaseId = $state.oldReleaseId; gitSha = $state.oldBuildId; promotedAtUtc = [DateTime]::UtcNow.ToString('o')
        files = @{ 'kiki-desktop.exe' = @{ sha256 = $desktop.Hash; bytes = $desktop.Length }; 'kiki-server.exe' = @{ sha256 = $server.Hash; bytes = $server.Length } }
    })
}

function Release-OurPauses([object]$Target, [bool]$AllowCancel) {
    foreach ($item in $state.sessions) {
        $actual = Execution $Target.instance $item.id 'read'
        if ((Get-ObjectProperty $actual 'pauseOperationId') -cne $item.pauseId) { continue }
        $action = switch ($actual.phase) {
            'running' { continue }
            'paused' { 'resume' }
            'pausing' { if ($AllowCancel) { 'cancelPause' } else { throw "Session $($item.id) is still pausing." } }
            default { throw "Session $($item.id) needs inspection: $($actual.phase)." }
        }
        if (!$action) { continue }
        $result = Execution $Target.instance $item.id $action @(@{ operationId = "$($item.pauseId):$action"; pauseOperationId = $item.pauseId })
        if ($result.phase -ne 'running') { throw "Session $($item.id) did not return to running." }
        Write-Host "Continued $($item.id)"
    }
}

$lock = [IO.File]::Open((Join-Path $runtime 'hot-switch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
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
        $target = Find-Server
        if ($null -eq $target) {
            if (@(Find-Shells).Count -gt 0) { throw 'Quit the remaining desktop from its tray before retrying recovery.' }
            Restore-OriginalRelease
            $launcher = Invoke-Launch $runtime $homePath -PassThru
            $target = Await-Release $state.oldReleaseId $state.oldBuildId $launcher
        } elseif ($target.meta.server_home_id -cne $state.serverHomeId -or $target.meta.current_space_id -cne $state.spaceId -or
            $target.releaseId -cnotin @($state.oldReleaseId, $state.targetReleaseId, $state.priorPointerReleaseId)) {
            throw 'Recovery found a different service. Leave it running and inspect the switch record.'
        }
        if ($target.releaseId -ceq $state.oldReleaseId -and $state.phase -in @('stopping', 'promoting', 'starting', 'resuming')) { Restore-OriginalRelease }
        if ((Get-ObjectProperty (Lifecycle $target.instance '') 'hot_switch_prepared') -eq $true) { Lifecycle $target.instance 'cancel-update' | Out-Null }
        Release-OurPauses $target $true
        $state.phase = 'complete'; Save-State
        Write-Host "Recovery complete: $($target.releaseId)"
        return
    }

    if ($null -ne $state -and $state.phase -ne 'complete') { throw 'A switch is unfinished. Run this command with -Recover first.' }
    Assert-FullCommit $commit
    if (!$candidate) { throw 'Pass -CandidateRoot with the verified desktop build directory.' }
    $candidate = Get-FullPath $candidate
    $receipt = Read-BuildReceipt $candidate
    $null = Assert-ReceiptIdentity $receipt $commit
    $main = Get-ArtifactInfo (Join-Path $candidate 'kiki-desktop.exe') 'Candidate Kiki GUI'
    $sidecar = Get-ArtifactInfo (Join-Path $candidate 'kiki-server.exe') 'Candidate Kiki backend'
    Assert-ReceiptFiles $receipt $main $sidecar
    $targetRelease = '{0}-{1}' -f $main.Hash.Substring(0,24), $sidecar.Hash.Substring(0,24)
    $old = Find-Server
    if ($null -eq $old) { throw 'No authenticated managed service is running from this runtime and home.' }
    if ($old.releaseId -ceq $targetRelease) { Write-Host "Already running $targetRelease"; return }
    $current = Read-CurrentManifest $runtime
    $shells = @(Find-Shells)
    if ($shells.Count -gt 1 -or @($shells | Where-Object { $_.Path -ine (Join-Path (Get-ReleasePath $runtime $old.releaseId) 'kiki-desktop.exe') }).Count) {
        throw 'Close extra desktop shells; the running shell must match the service being switched.'
    }
    if ($shells.Count -gt 0) {
        $otherServices = @(Get-CimInstance Win32_Process -Filter "Name = 'kiki-server.exe'" | Where-Object {
            $_.ProcessId -ne $old.instance.pid -and $_.ExecutablePath -and $_.CommandLine -match '(?:^|\s)serve(?:\s|$)'
        })
        if ($otherServices.Count) { throw 'Another local desktop service is running. Quit only after confirming the other spaces are safe; this switch targets one home.' }
    }
    $lifecycle = Lifecycle $old.instance ''
    $supportsPrepare = $null -ne (Get-ObjectProperty $lifecycle 'hot_switch_prepared')
    if ($shells.Count -gt 0 -and !$supportsPrepare -and !$AllowLegacyDesktopQuit) {
        throw 'This older desktop needs its tray Quit action. Close other spaces and rerun with -AllowLegacyDesktopQuit when you can confirm the quit yourself.'
    }
    $state = [pscustomobject]@{
        schemaVersion = 1; phase = 'pausing'; kikiHome = $homePath; oldReleaseId = $old.releaseId; oldBuildId = $old.meta.build_id
        oldServerId = $old.meta.server_id; serverHomeId = $old.meta.server_home_id; spaceId = $old.meta.current_space_id
        priorPointerReleaseId = $current.releaseId; targetReleaseId = $targetRelease; targetBuildId = $commit; hadDesktop = $shells.Count -gt 0
        sessions = @()
    }
    Save-State
    $deadline = [DateTime]::UtcNow.AddSeconds($SettleSeconds)
    do {
        $lifecycle = Lifecycle $old.instance ''
        foreach ($id in $lifecycle.work_pending) {
            if (@($state.sessions | Where-Object id -CEQ $id).Count) { continue }
            $control = Execution $old.instance $id 'read'
            if ($control.phase -eq 'running') {
                $item = [pscustomobject]@{ id = $id; pauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N') }
                $state.sessions += $item
                Save-State
                Execution $old.instance $id 'pause' @(@{ operationId = $item.pauseId }) | Out-Null
                Write-Host "Pausing $id"
            } elseif ($control.phase -in @('failed', 'resuming')) { throw "Session $id is $($control.phase). Resolve it before switching." }
        }
        $pending = @($lifecycle.work_pending)
        if ($pending.Count -eq 0) { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw ('Still settling: ' + ($pending -join ', ')) }
        Start-Sleep -Milliseconds 400
    } while ($true)
    foreach ($item in $state.sessions) {
        $control = Execution $old.instance $item.id 'read'
        if ($control.phase -ne 'paused' -or $control.pauseOperationId -cne $item.pauseId) { throw "Pause changed for $($item.id); no version was switched." }
    }
    $state.phase = 'stopping'; Save-State
    if ($supportsPrepare) { Lifecycle $old.instance 'prepare-update' | Out-Null }
    if ($shells.Count -gt 0) {
        Write-Host 'Kiki is paused. In the tray, choose Quit, then Stop services and quit. Closing the window only hides it.'
    } else {
        Lifecycle $old.instance 'update' | Out-Null
    }
    Wait-ForExit $old $shells
    $state.phase = 'promoting'; Save-State
    Invoke-Promotion $runtime $candidate $commit | Out-Host
    if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) { throw 'Promotion did not select the verified candidate.' }
    $state.phase = 'starting'; Save-State
    $launcher = Invoke-Launch $runtime $homePath -PassThru
    $target = Await-Release $targetRelease $commit $launcher
    $state.phase = 'resuming'; Save-State
    Release-OurPauses $target $false
    $state.phase = 'complete'; Save-State
    Write-Host "Running $targetRelease ($($target.meta.server_id))"
} catch {
    if (Test-Path -LiteralPath $statePath) {
        Write-Warning "Switch record: $statePath"
        Write-Warning ('Recovery: & ''{0}'' -RuntimeRoot ''{1}'' -KikiHome ''{2}'' -Recover' -f $entryScript.Replace("'", "''"), $runtime.Replace("'", "''"), $homePath.Replace("'", "''"))
    }
    throw
} finally {
    $lock.Dispose()
}
