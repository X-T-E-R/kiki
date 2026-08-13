$ErrorActionPreference = 'Stop'

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw [InvalidOperationException]::new($Message) }
}

function Assert-ThrowsLike {
  param([scriptblock]$Action, [string]$Pattern, [string]$Message)
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -match $Pattern) { return }
    throw
  }
  throw [InvalidOperationException]::new($Message)
}

$launcher = Join-Path $PSScriptRoot 'codex-kiki-mcp.ps1'
. $launcher

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "codex-kiki-mcp-test-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  $runtimeDir = Join-Path $testRoot 'runtime'
  $workspacesDir = Join-Path $runtimeDir 'workspaces'
  $agentHome = Join-Path $testRoot 'agent-home'
  $configPath = Join-Path $agentHome 'config.toml'
  $workspaceA = Join-Path $testRoot 'workspace-a'
  $workspaceB = Join-Path $testRoot 'workspace-b'
  New-Item -ItemType Directory -Path $runtimeDir, $workspacesDir, $agentHome, $workspaceA, $workspaceB | Out-Null
  [IO.File]::WriteAllText($configPath, '', [Text.UTF8Encoding]::new($false))
  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $install = [pscustomobject]@{
    workspacesDir = $workspacesDir
    configPath = $configPath
    agentProfileHomeDir = $agentHome
    defaultModel = 'model-test'
    defaultThinkingEffort = 'high'
    portRangeStart = 62000
    portRangeEnd = 62050
    nodePath = $nodePath
  }

  $canonicalA = Get-CanonicalDirectory $workspaceA $nodePath 'workspace A'
  $junction = Join-Path $testRoot 'workspace-a-link'
  New-Item -ItemType Junction -Path $junction -Target $workspaceA | Out-Null
  $canonicalAlias = Get-CanonicalDirectory $junction $nodePath 'workspace A alias'
  $keyA = Get-WorkspaceKey $canonicalA
  $upperCanonicalA = $canonicalA.ToUpperInvariant()
  Assert-True (Test-SamePath $canonicalA $canonicalAlias) 'canonical alias did not resolve to the target workspace'
  Assert-True ($keyA -ceq (Get-WorkspaceKey $canonicalAlias)) 'canonical alias produced another workspace key'
  Assert-True ($canonicalA -cne $upperCanonicalA) 'the Windows case-fold fixture did not produce a distinct path spelling'
  Assert-True ($keyA -ceq (Get-WorkspaceKey $upperCanonicalA)) 'a Windows path case variant produced another workspace key'

  $installJson = $install | ConvertTo-Json -Compress
  $inputs = @(
    [pscustomobject]@{ workspace = $canonicalA; key = $keyA },
    [pscustomobject]@{
      workspace = (Get-CanonicalDirectory $workspaceB $nodePath 'workspace B')
      key = (Get-WorkspaceKey (Get-CanonicalDirectory $workspaceB $nodePath 'workspace B'))
    }
  )
  $jobs = foreach ($entry in $inputs) {
    Start-Job -ArgumentList $launcher, $installJson, $entry.workspace, $entry.key -ScriptBlock {
      param($launcherPath, $serializedInstall, $workspace, $key)
      $ErrorActionPreference = 'Stop'
      . $launcherPath
      $install = $serializedInstall | ConvertFrom-Json
      $record = Get-OrCreateWorkspaceBinding $workspace $key $install
      [pscustomobject]@{
        workspaceKey = [string]$record.binding.workspaceKey
        sessionId = [string]$record.binding.sessionId
        port = [int]$record.binding.port
      }
    }
  }
  $jobs | Wait-Job | Out-Null
  $different = @($jobs | Receive-Job -ErrorAction Stop)
  $jobs | Remove-Job -Force
  Assert-True ($different.Count -eq 2) 'concurrent different-workspace provisioning did not return two bindings'
  Assert-True ($different[0].workspaceKey -cne $different[1].workspaceKey) 'different workspaces reused one key'
  Assert-True ($different[0].sessionId -cne $different[1].sessionId) 'different workspaces reused one Session'
  Assert-True ([int]$different[0].port -ne [int]$different[1].port) 'different workspaces reused one port'

  $reuseJobs = 1..2 | ForEach-Object {
    Start-Job -ArgumentList $launcher, $installJson, $canonicalA, $keyA -ScriptBlock {
      param($launcherPath, $serializedInstall, $workspace, $key)
      $ErrorActionPreference = 'Stop'
      . $launcherPath
      $install = $serializedInstall | ConvertFrom-Json
      $record = Get-OrCreateWorkspaceBinding $workspace $key $install
      [pscustomobject]@{
        sessionId = [string]$record.binding.sessionId
        port = [int]$record.binding.port
      }
    }
  }
  $reuseJobs | Wait-Job | Out-Null
  $same = @($reuseJobs | Receive-Job -ErrorAction Stop)
  $reuseJobs | Remove-Job -Force
  Assert-True ($same.Count -eq 2) 'concurrent same-workspace provisioning did not return twice'
  Assert-True ($same[0].sessionId -ceq $same[1].sessionId) 'same workspace did not reuse its Session'
  Assert-True ([int]$same[0].port -eq [int]$same[1].port) 'same workspace did not reuse its port'

  $bindingDir = Join-Path $workspacesDir $keyA
  $bindingPath = Join-Path $bindingDir 'binding.json'
  $originalBindingText = Get-Content -LiteralPath $bindingPath -Raw
  $mutated = $originalBindingText | ConvertFrom-Json
  $mutated.sessionId = 'session_mutated'
  Write-JsonFile $bindingPath $mutated
  Assert-ThrowsLike {
    Get-OrCreateWorkspaceBinding $canonicalA $keyA $install | Out-Null
  } 'signature does not match' 'mutated workspace metadata was accepted'
  [IO.File]::WriteAllText($bindingPath, $originalBindingText, [Text.UTF8Encoding]::new($false))

  $bindingRecord = Get-OrCreateWorkspaceBinding $canonicalA $keyA $install
  $identity = Get-ProcessIdentity $PID
  $state = [ordered]@{
    schemaVersion = 1
    pid = $PID
    executablePath = $nodePath
    creationTicks = [long]$identity.creationTicks
    endpoint = [string]$bindingRecord.binding.endpoint
    port = [int]$bindingRecord.binding.port
    homeDir = [string]$bindingRecord.binding.homeDir
    sessionId = [string]$bindingRecord.binding.sessionId
    workspacePath = [string]$bindingRecord.binding.workspacePath
    configPath = [string]$bindingRecord.binding.configPath
    agentProfileHomeDir = [string]$bindingRecord.binding.agentProfileHomeDir
    configReadOnly = $true
    serverId = 'server-test'
    instanceId = 'instance-test'
    startedAt = [DateTime]::UtcNow.ToString('o')
    stateMac = ''
  }
  $state.stateMac = Get-HmacBase64 $bindingRecord.secret (Get-StatePayload $state)
  $statePath = Join-Path $bindingDir 'runtime-state.json'
  Write-JsonFile $statePath $state
  Assert-ThrowsLike {
    Resolve-WorkspaceKap $bindingRecord.binding $install $bindingRecord.secret $bindingDir | Out-Null
  } 'alive but is not listening' 'a live stale owner without its listener was accepted'
  Remove-Item -LiteralPath $statePath -Force

  $unownedBindingDir = Join-Path $testRoot 'unowned-listener-binding'
  $listenerReadyPath = Join-Path $unownedBindingDir 'listener-ready.json'
  $listenerStopPath = Join-Path $unownedBindingDir 'listener-stop'
  $listenerJob = $null
  $listenerPort = 0
  $listenerPid = 0
  $listenerReleased = $false
  $unownedFixtureRemoved = $false
  try {
    New-Item -ItemType Directory -Path $unownedBindingDir | Out-Null
    $listenerJob = Start-Job -ArgumentList $listenerReadyPath, $listenerStopPath -ScriptBlock {
      param($readyPath, $stopPath)
      $ErrorActionPreference = 'Stop'
      $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
      try {
        $listener.Start()
        $endpoint = [Net.IPEndPoint]$listener.LocalEndpoint
        $ready = [ordered]@{ port = [int]$endpoint.Port; pid = $PID }
        [IO.File]::WriteAllText(
          $readyPath,
          ($ready | ConvertTo-Json -Compress),
          [Text.UTF8Encoding]::new($false)
        )
        $listenerDeadline = [DateTime]::UtcNow.AddSeconds(30)
        while (
          -not (Test-Path -LiteralPath $stopPath -PathType Leaf) -and
          [DateTime]::UtcNow -lt $listenerDeadline
        ) {
          Start-Sleep -Milliseconds 50
        }
      } finally {
        $listener.Stop()
      }
    }

    $readyDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      if (Test-Path -LiteralPath $listenerReadyPath -PathType Leaf) { break }
      if (@('Completed', 'Failed', 'Stopped') -contains [string]$listenerJob.State) { break }
      Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $readyDeadline)
    Assert-True (Test-Path -LiteralPath $listenerReadyPath -PathType Leaf) 'the dummy loopback listener did not become ready'

    $listenerReady = Get-Content -LiteralPath $listenerReadyPath -Raw | ConvertFrom-Json
    $listenerPort = [int]$listenerReady.port
    $listenerPid = [int]$listenerReady.pid
    Assert-True ($listenerPort -gt 0 -and $listenerPid -gt 0) 'the dummy loopback listener reported invalid identity data'

    $ownerDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      $listenerPids = @(Get-ListenerPids $listenerPort)
      if ($listenerPids.Count -eq 1 -and [int]$listenerPids[0] -eq $listenerPid) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $ownerDeadline)
    Assert-True (
      $listenerPids.Count -eq 1 -and [int]$listenerPids[0] -eq $listenerPid
    ) 'the dummy process did not exclusively own its loopback listener'

    $unownedBinding = [pscustomobject]@{ port = $listenerPort }
    Assert-True (
      -not (Test-Path -LiteralPath (Join-Path $unownedBindingDir 'runtime-state.json') -PathType Leaf)
    ) 'the unowned-listener fixture unexpectedly contained runtime state'
    Assert-ThrowsLike {
      Resolve-WorkspaceKap $unownedBinding $install 'unused-secret' $unownedBindingDir | Out-Null
    } 'occupied by an unrecorded process' 'an unowned loopback listener without signed runtime state was accepted'
  } finally {
    try {
      if ($null -ne $listenerJob) {
        [IO.File]::WriteAllText($listenerStopPath, '', [Text.UTF8Encoding]::new($false))
        $completedListenerJob = Wait-Job -Job $listenerJob -Timeout 5
        if ($null -eq $completedListenerJob) {
          Stop-Job -Job $listenerJob -ErrorAction SilentlyContinue
          Wait-Job -Job $listenerJob -Timeout 5 | Out-Null
        }
        Remove-Job -Job $listenerJob -Force -ErrorAction SilentlyContinue
      }
    } finally {
      if ($listenerPort -gt 0 -and $listenerPid -gt 0) {
        $releaseDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
          $remainingListenerPids = @(Get-ListenerPids $listenerPort)
          if ($remainingListenerPids -notcontains $listenerPid) { break }
          Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $releaseDeadline)
        $listenerReleased = $remainingListenerPids -notcontains $listenerPid
      }
      Remove-Item -LiteralPath $unownedBindingDir -Recurse -Force -ErrorAction SilentlyContinue
      $unownedFixtureRemoved = -not (Test-Path -LiteralPath $unownedBindingDir)
    }
  }
  Assert-True $listenerReleased 'the dummy loopback listener leaked after its test'
  Assert-True $unownedFixtureRemoved 'the unowned-listener fixture leaked after its test'

  $secretA = Read-DpapiSecret $bindingRecord.binding.delegationSecretPath 'workspace A credential'
  $bindingB = Get-OrCreateWorkspaceBinding $inputs[1].workspace $inputs[1].key $install
  $secretB = Read-DpapiSecret $bindingB.binding.delegationSecretPath 'workspace B credential'
  Assert-True (-not (Test-FixedTimeEqual $secretA $secretB)) 'different workspaces reused one authority credential'

  [pscustomobject]@{
    canonicalAlias = 'passed'
    windowsCaseFoldKey = 'passed'
    concurrentDifferentWorkspaces = 'passed'
    deterministicSameWorkspaceReuse = 'passed'
    mutatedBindingRejected = 'passed'
    liveStaleOwnerRejected = 'passed'
    unownedListenerRejected = 'passed'
    unownedListenerCleanup = 'passed'
    authorityCredentialsIsolated = 'passed'
  } | ConvertTo-Json
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedTestRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'refusing to remove a test path outside the temporary directory'
  }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
