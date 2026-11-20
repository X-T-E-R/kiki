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

$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$homePath = [IO.Path]::GetFullPath($KikiHome)
$candidate = $CandidateRoot
$commit = $ExpectedCommit
$allowInterruptAfterSettle = $InterruptAfterSettle -and (-not $NoInterruptAfterSettle)
$entryScript = $PSCommandPath
. (Join-Path $PSScriptRoot 'desktop-release.ps1') -Action Launch

$statePath = Join-Path $runtime 'hot-switch.json'
$instances = Join-Path $homePath 'server\instances'
$releases = Join-Path $runtime 'releases'
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
    $oldReleaseDir = Get-ReleasePath $runtime $Old.releaseId
    $oldDesktopExe = Join-Path $oldReleaseDir 'kiki-desktop.exe'
    $oldServerExe = Join-Path $oldReleaseDir 'kiki-server.exe'
    $oldInstancePath = Join-Path $instances ($Old.meta.server_id + '.json')

    $exitedGracefully = $Old.process.WaitForExit($graceSeconds * 1000)
    if (-not $exitedGracefully) {
        Write-Warning ("Original service {0} (pid {1}) did not exit within {2}s; closing old desktop shell and force-stopping original service." -f $Old.meta.server_id, $Old.process.Id, $graceSeconds)
        foreach ($shell in $Shells) { Close-DesktopShell $shell }
        foreach ($lingeringShell in @(Find-Shells | Where-Object { $_.Path -ieq $oldDesktopExe })) {
            try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
            Close-DesktopShell $lingeringShell
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
        foreach ($lingeringShell in @(Find-Shells | Where-Object { $_.Path -ieq $oldDesktopExe })) {
            try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
            Close-DesktopShell $lingeringShell
        }
    }

    if (Test-Path -LiteralPath $oldInstancePath -PathType Leaf) {
        Write-Warning ("Removing leftover instance registration after old service exit: {0}" -f $oldInstancePath)
        Remove-Item -LiteralPath $oldInstancePath -Force -ErrorAction SilentlyContinue
    }
    foreach ($lingeringWorker in @(Get-Process -Name 'kiki-server' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $Old.process.Id -and $_.Path -ieq $oldServerExe })) {
        Write-Warning ("Stopping lingering worker process {0} from old release {1}." -f $lingeringWorker.Id, $Old.releaseId)
        Stop-ProcessBounded $lingeringWorker 5000
    }
    foreach ($lingeringShell in @(Find-Shells | Where-Object { $_.Path -ieq $oldDesktopExe })) {
        try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
        Close-DesktopShell $lingeringShell
    }
    if (@(Find-Shells).Count -gt 0 -or $null -ne (Find-Server)) { throw 'Another desktop or managed service appeared before launch.' }
}

function Await-Release([string]$ReleaseId, [string]$ExpectedBuildId, [object]$Launcher) {
    if ([string]::IsNullOrWhiteSpace($ExpectedBuildId)) {
        throw 'Expected build commit is required when awaiting a switched release.'
    }
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

function Select-InstalledRelease([string]$ReleaseId, [string]$BuildId, [string]$Label = 'Selected') {
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
}

function Restore-OriginalRelease {
    Select-InstalledRelease $state.oldReleaseId $state.oldBuildId 'Original'
}

function Stop-ReleaseProcesses([string]$ReleaseId, [object]$Launcher = $null) {
    if ($null -ne $Launcher) { Stop-ProcessBounded $Launcher 5000 }
    if (-not [string]::IsNullOrWhiteSpace($ReleaseId) -and $ReleaseId -match '^[0-9a-f]{24}-[0-9a-f]{24}$') {
        $releaseDir = Get-ReleasePath $runtime $ReleaseId
        $desktopExe = Join-Path $releaseDir 'kiki-desktop.exe'
        $serverExe = Join-Path $releaseDir 'kiki-server.exe'
        foreach ($lingeringShell in @(Find-Shells | Where-Object { $_.Path -ieq $desktopExe })) {
            try { $lingeringShell.EnableRaisingEvents = $true; $null = $lingeringShell.Handle } catch {}
            Close-DesktopShell $lingeringShell
        }
        foreach ($lingeringServer in @(Get-Process -Name 'kiki-server' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $serverExe })) {
            Stop-ProcessBounded $lingeringServer 5000
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
            Write-Host "Continued $($item.id)"
        } catch {
            $msg = $_.Exception.Message
            Write-Warning "Failed to release pause on $($item.id): $msg"
            $failures += "$($item.id): $msg"
        }
    }
    if ($failures.Count -gt 0) {
        throw ("Failed to release $($failures.Count) paused session(s): " + ($failures -join '; '))
    }
}

$lock = [IO.File]::Open((Join-Path $runtime 'hot-switch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$pauseOwner = $null
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
            $targetReleaseId = [string](Get-ObjectProperty $state 'targetReleaseId')
            $targetBuildId = [string](Get-ObjectProperty $state 'targetBuildId')
            if ((-not $shouldRollback) -and (-not [string]::IsNullOrWhiteSpace($targetReleaseId)) -and (-not [string]::IsNullOrWhiteSpace($targetBuildId)) -and (Test-InstalledRelease $targetReleaseId)) {
                $launcher = $null
                try {
                    Select-InstalledRelease $targetReleaseId $targetBuildId 'Target'
                    $launcher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
                    $target = Await-Release $targetReleaseId $targetBuildId $launcher
                } catch {
                    Write-Warning ("Target release {0} failed to start during recovery: {1}. Rolling back to {2}." -f $targetReleaseId, $_.Exception.Message, $state.oldReleaseId)
                    $state.phase = 'starting_failed'; Save-State
                    Stop-ReleaseProcesses $targetReleaseId $launcher
                    Restore-OriginalRelease
                    $rollbackLauncher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
                    $target = Await-Release $state.oldReleaseId $state.oldBuildId $rollbackLauncher
                }
            } else {
                Restore-OriginalRelease
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

    $continuing = $false
    if ($null -ne $state -and $state.phase -ne 'complete') {
        if ($state.schemaVersion -eq 1 -and $state.kikiHome -ine $homePath) {
            throw 'A switch for another Kiki home is unfinished. Run this command with -Recover for that home first.'
        }
        if ($state.schemaVersion -eq 1 -and $state.phase -eq 'pausing' -and $null -ne $old -and
            $state.oldServerId -ceq $old.meta.server_id -and $state.targetReleaseId -ceq $targetRelease) {
            $continuing = $true
        } elseif ($null -ne $old) {
            Write-Warning ("Reconciling stale hot-switch record (phase={0}, old={1}, target={2}) before starting new switch." -f $state.phase, $state.oldReleaseId, $state.targetReleaseId)
            if ($state.schemaVersion -eq 1 -and $old.meta.server_home_id -ceq $state.serverHomeId -and $old.meta.current_space_id -ceq $state.spaceId) {
                Clear-SwitchControls $old $true
            }
            $state.phase = 'complete'; Save-State
            $state = $null
        }
    }

    if ($null -eq $old) { throw 'No authenticated managed service is running from this runtime and home.' }
    $current = Read-CurrentManifest $runtime -AllowMissing
    $priorPointerReleaseId = if ($null -ne $current) { [string]$current.releaseId } else { $old.releaseId }
    if ($old.releaseId -ceq $targetRelease) {
        Invoke-Promotion $runtime $verified | Out-Host
        Write-Host "Already running $targetRelease"
        return
    }
    $shells = @(Find-Shells)
    if ($shells.Count -gt 1 -or @($shells | Where-Object { $_.Path -ine (Join-Path (Get-ReleasePath $runtime $old.releaseId) 'kiki-desktop.exe') }).Count) {
        throw 'Close extra desktop shells; the running shell must match the service being switched.'
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
    $deadline = [DateTime]::UtcNow.AddSeconds($SettleSeconds)
    do {
        $lifecycle = Lifecycle $old.instance ''
        foreach ($id in $lifecycle.work_pending) {
            $control = Execution $old.instance $id 'read'
            if ($control.phase -eq 'running') {
                $item = [pscustomobject]@{ id = $id; pauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N') }
                $state.sessions = @($state.sessions | Where-Object id -CNE $id) + @($item)
                Save-State
                Execution $old.instance $id 'pause' @(@{ operationId = $item.pauseId }) | Out-Null
                Write-Host "Pausing $id"
            } elseif ($control.phase -in @('failed', 'resuming')) { throw "Session $id is $($control.phase). Resolve it before switching." }
        }
        $pending = @($lifecycle.work_pending)
        if ($pending.Count -eq 0) { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            if (-not $allowInterruptAfterSettle) {
                throw ('Still settling: ' + ($pending -join ', '))
            }
            Write-Warning ('Settle deadline ({0}s) expired with active work ({1}); interrupting remaining work to complete hot switch.' -f $SettleSeconds, ($pending -join ', '))
            $interruptedAfterSettle = $true
            break
        }
        Start-Sleep -Milliseconds 400
    } while ($true)
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
    if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) {
        Invoke-Promotion $runtime $verified | Out-Host
        if ((Read-CurrentManifest $runtime).releaseId -cne $targetRelease) { throw 'Promotion did not select the verified candidate.' }
    }
    $state.phase = 'starting'; Save-State
    $launcher = $null
    try {
        $launcher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
        $target = Await-Release $targetRelease $expectedBuildId $launcher
    } catch {
        $startFailure = $_
        Write-Warning ("New release {0} failed to start: {1}. Rolling back to {2}." -f $targetRelease, $startFailure.Exception.Message, $state.oldReleaseId)
        $state.phase = 'starting_failed'; Save-State
        Stop-ReleaseProcesses $targetRelease $launcher
        try {
            Restore-OriginalRelease
            $rollbackLauncher = Invoke-Launch $runtime $homePath -PassThru -Background:$Background
            $restored = Await-Release $state.oldReleaseId $state.oldBuildId $rollbackLauncher
            Clear-SwitchControls $restored $true
            $state.phase = 'complete'; Save-State
            Write-Warning ("Rolled back to previous release {0} ({1}) after new release failed to start." -f $state.oldReleaseId, $restored.meta.server_id)
        } catch {
            Write-Warning ("Automatic rollback to {0} failed: {1}" -f $state.oldReleaseId, $_.Exception.Message)
        }
        throw $startFailure
    }
    $state.phase = 'resuming'; Save-State
    Release-OurPauses $target $interruptedAfterSettle
    $state.phase = 'complete'; Save-State
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
