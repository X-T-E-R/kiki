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

function Test-PortBindable {
  param([int]$Port)
  try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { return $true } finally { $listener.Stop() }
  } catch {
    return $false
  }
}

function Find-BindablePortWindow {
  param([int]$Size)
  # Windows reserves excluded port ranges (Hyper-V/WinNAT) that never show up
  # as listeners; probe for a contiguous window the fixtures can really bind.
  for ($start = 24000; $start + $Size -le 64000; $start += $Size) {
    $allBindable = $true
    for ($port = $start; $port -lt $start + $Size; $port++) {
      if (-not (Test-PortBindable $port)) { $allBindable = $false; break }
    }
    if ($allBindable) { return @{ start = $start; end = $start + $Size - 1 } }
  }
  throw [InvalidOperationException]::new('no bindable loopback port window was found for the fixture')
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
  $portWindow = Find-BindablePortWindow 20
  $install = [pscustomobject]@{
    workspacesDir = $workspacesDir
    configPath = $configPath
    agentProfileHomeDir = $agentHome
    defaultModel = 'model-test'
    defaultThinkingEffort = 'high'
    portRangeStart = [int]$portWindow.start
    portRangeEnd = [int]$portWindow.end
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

  $driftedBinding = $originalBindingText | ConvertFrom-Json
  $driftedBinding.configPath = Join-Path $testRoot 'other-config.toml'
  Write-JsonFile $bindingPath $driftedBinding
  Assert-ThrowsLike {
    Get-OrCreateWorkspaceBinding $canonicalA $keyA $install | Out-Null
  } 'drifted fields: .*configPath: expected .*Run -ResignBinding .*For other fields, re-run' 'drifted workspace metadata did not name the drifted field and recovery path'
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
    } "occupied by an unrecorded process \(pid $listenerPid \([^)]+\)\)" 'an unowned loopback listener without signed runtime state was accepted without naming the occupying process'
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

  $workspaceC = Join-Path $testRoot 'workspace-c'
  New-Item -ItemType Directory -Path $workspaceC | Out-Null
  $canonicalC = Get-CanonicalDirectory $workspaceC $nodePath 'workspace C'
  $keyC = Get-WorkspaceKey $canonicalC
  $bindingRecordC = Get-OrCreateWorkspaceBinding $canonicalC $keyC $install
  $portC = [int]$bindingRecordC.binding.port
  $stopStatePath = Join-Path $bindingRecordC.bindingDir 'runtime-state.json'
  $stopReadyPath = Join-Path $testRoot 'stop-listener-ready.json'
  $stopListenerJob = $null
  try {
    $stopListenerJob = Start-Job -ArgumentList $portC, $stopReadyPath -ScriptBlock {
      param($port, $readyPath)
      $ErrorActionPreference = 'Stop'
      $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
      try {
        $listener.Start()
        [IO.File]::WriteAllText(
          $readyPath,
          ([pscustomobject]@{ port = $port; pid = $PID } | ConvertTo-Json -Compress),
          [Text.UTF8Encoding]::new($false)
        )
        $listenerDeadline = [DateTime]::UtcNow.AddSeconds(90)
        while ([DateTime]::UtcNow -lt $listenerDeadline) {
          if ($listener.Pending()) {
            $client = $listener.AcceptTcpClient()
            $client.Close()
            continue
          }
          Start-Sleep -Milliseconds 50
        }
      } finally {
        $listener.Stop()
      }
    }
    $stopReadyDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      if (Test-Path -LiteralPath $stopReadyPath -PathType Leaf) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $stopReadyDeadline)
    Assert-True (Test-Path -LiteralPath $stopReadyPath -PathType Leaf) 'the stop-path listener did not become ready'
    $stopListenerPid = [int]((Get-Content -LiteralPath $stopReadyPath -Raw | ConvertFrom-Json).pid)
    $stopOwnerDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      $stopListenerPids = @(Get-ListenerPids $portC)
      if ($stopListenerPids.Count -eq 1 -and [int]$stopListenerPids[0] -eq $stopListenerPid) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $stopOwnerDeadline)
    Assert-True (
      $stopListenerPids.Count -eq 1 -and [int]$stopListenerPids[0] -eq $stopListenerPid
    ) 'the stop-path listener did not exclusively own the recorded port'

    $stopIdentity = Get-ProcessIdentity $stopListenerPid
    $stopState = [ordered]@{
      schemaVersion = 1
      pid = $stopListenerPid
      executablePath = $nodePath
      creationTicks = [long]$stopIdentity.creationTicks
      endpoint = [string]$bindingRecordC.binding.endpoint
      port = $portC
      homeDir = [string]$bindingRecordC.binding.homeDir
      sessionId = [string]$bindingRecordC.binding.sessionId
      workspacePath = [string]$bindingRecordC.binding.workspacePath
      configPath = [string]$bindingRecordC.binding.configPath
      agentProfileHomeDir = [string]$bindingRecordC.binding.agentProfileHomeDir
      configReadOnly = $true
      serverId = 'server-stop-test'
      instanceId = 'instance-stop-test'
      startedAt = [DateTime]::UtcNow.ToString('o')
      stateMac = ''
    }
    $stopState.stateMac = Get-HmacBase64 $bindingRecordC.secret (Get-StatePayload $stopState)
    Write-JsonFile $stopStatePath $stopState

    $listingC = @(@(Get-KikiWorkspaceListing $install) | Where-Object { $_.key -ceq $keyC })
    Assert-True ($listingC.Count -eq 1) 'the workspace listing did not include the stop fixture workspace'
    Assert-True ([int]$listingC[0].port -eq $portC) 'the workspace listing recorded the wrong port'
    Assert-True ([string]$listingC[0].workspacePath -ceq $canonicalC) 'the workspace listing recorded the wrong workspace'
    Assert-True ([int]$listingC[0].recordedPid -eq $stopListenerPid) 'the workspace listing recorded the wrong pid'
    Assert-True ($listingC[0].processAlive -eq $true) 'the workspace listing marked the live owner dead'
    Assert-True ($listingC[0].listening -eq $true) 'the workspace listing marked the live listener absent'

    $stopResult = Stop-WorkspaceKapByRecord $keyC $install
    Assert-True (
      $stopResult.status -eq 'stopped-force'
    ) "the recorded workspace KAP stop did not stop the owner: $($stopResult.status) $($stopResult.detail)"
    $stopReleaseDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      if (@(Get-ListenerPids $portC).Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $stopReleaseDeadline)
    Assert-True (@(Get-ListenerPids $portC).Count -eq 0) 'the recorded port stayed busy after the stop'
    Assert-True (-not (Test-Path -LiteralPath $stopStatePath -PathType Leaf)) 'the runtime state survived the stop'
    $stoppedIdentity = Get-ProcessIdentity $stopListenerPid
    Assert-True (
      $null -eq $stoppedIdentity -or
      [long]$stoppedIdentity.creationTicks -ne [long]$stopIdentity.creationTicks
    ) 'the recorded owner process survived the stop'
    $stopAgain = Stop-WorkspaceKapByRecord $keyC $install
    Assert-True ($stopAgain.status -eq 'already-stopped') 'stopping a stopped workspace did not report already-stopped'
  } finally {
    if ($null -ne $stopListenerJob) {
      Stop-Job -Job $stopListenerJob -ErrorAction SilentlyContinue
      Wait-Job -Job $stopListenerJob -Timeout 5 | Out-Null
      Remove-Job -Job $stopListenerJob -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $stopReadyPath -Force -ErrorAction SilentlyContinue
  }

  $mcpStubPath = Join-Path $testRoot 'mcp-stub.js'
  [IO.File]::WriteAllText($mcpStubPath, 'process.exit(7)', [Text.UTF8Encoding]::new($false))
  $recycleJob = Start-Job -ArgumentList $launcher, $mcpStubPath -ScriptBlock {
    param($launcherPath, $stubPath)
    $ErrorActionPreference = 'Stop'
    . $launcherPath
    $script:fakeStarted = 'started-here'
    $script:fakeNodePath = (Get-Command node -ErrorAction Stop).Source
    $script:recycleCalls = @()
    function Invoke-WorkspaceKapRecycle {
      param([object]$RecycleBinding, [object]$RecycleState, [string]$RecycleStatePath)
      $script:recycleCalls += [pscustomobject]@{
        key = [string]$RecycleBinding.workspaceKey
        statePid = [int]$RecycleState.pid
        statePath = $RecycleStatePath
      }
    }
    function Initialize-KikiWorkspaceConnection {
      param([string]$IgnoredRuntimeDir)
      [pscustomobject]@{
        install = [pscustomobject]@{ nodePath = $script:fakeNodePath; mcpPath = $stubPath }
        bindingRecord = [pscustomobject]@{
          binding = [pscustomobject]@{ workspaceKey = 'job-owner-key' }
          bindingDir = 'C:\job-binding-dir'
        }
        runtime = [pscustomobject]@{
          started = $script:fakeStarted
          state = [pscustomobject]@{ pid = 4242 }
        }
        connection = [pscustomobject]@{
          endpoint = 'http://127.0.0.1:1'
          kapToken = 'token'
          delegationToken = 'delegation'
          sessionId = 'session_job'
          workspacePath = 'C:\job-workspace'
        }
      }
    }
    $ownerExit = Invoke-KikiMcpLauncher 'C:\ignored'
    $ownerCalls = @($script:recycleCalls)
    $script:recycleCalls = @()
    $script:fakeStarted = $null
    $attachedExit = Invoke-KikiMcpLauncher 'C:\ignored'
    $attachedCalls = @($script:recycleCalls)
    $script:recycleCalls = @()
    $script:fakeStarted = 'started-here'
    $script:fakeNodePath = 'C:\definitely-missing-node.exe'
    $launcherThrew = $false
    try {
      Invoke-KikiMcpLauncher 'C:\ignored' | Out-Null
    } catch {
      $launcherThrew = $true
    }
    $failureCalls = @($script:recycleCalls)
    [pscustomobject]@{
      ownerExit = [int]$ownerExit
      ownerRecycleCount = $ownerCalls.Count
      ownerKey = [string]$ownerCalls[0].key
      ownerStatePid = [int]$ownerCalls[0].statePid
      ownerStatePath = [string]$ownerCalls[0].statePath
      attachedExit = [int]$attachedExit
      attachedRecycleCount = $attachedCalls.Count
      launcherThrew = $launcherThrew
      failureRecycleCount = $failureCalls.Count
    }
  }
  $recycleJob | Wait-Job | Out-Null
  $recycle = $recycleJob | Receive-Job -ErrorAction Stop
  $recycleJob | Remove-Job -Force
  Assert-True ($recycle.ownerExit -eq 7) 'the owner launcher did not propagate the MCP process exit code'
  Assert-True ($recycle.ownerRecycleCount -eq 1) 'the owner launcher did not recycle its workspace KAP'
  Assert-True ($recycle.ownerKey -ceq 'job-owner-key') 'the recycle call did not receive the workspace binding'
  Assert-True ($recycle.ownerStatePid -eq 4242) 'the recycle call did not receive the recorded runtime state'
  Assert-True ($recycle.ownerStatePath -like '*runtime-state.json') 'the recycle call did not receive the state path'
  Assert-True ($recycle.attachedExit -eq 7) 'the attached launcher did not propagate the MCP process exit code'
  Assert-True ($recycle.attachedRecycleCount -eq 0) 'an attached launcher recycled a KAP it did not start'
  Assert-True ($recycle.launcherThrew -eq $true) 'a broken Node invocation did not surface its failure'
  Assert-True ($recycle.failureRecycleCount -eq 1) 'the owner launcher did not recycle its KAP on failure'

  $pwshExe = (Get-Process -Id $PID).Path
  $cliRoot = Join-Path $testRoot 'cli-runtime'
  $cliWorkspaces = Join-Path $cliRoot 'workspaces'
  New-Item -ItemType Directory -Path $cliRoot, $cliWorkspaces | Out-Null
  $cliLauncherPath = Join-Path $cliRoot 'kiki-mcp.ps1'
  Copy-Item -LiteralPath $launcher -Destination $cliLauncherPath
  $cliBundlePath = Join-Path $cliRoot 'kiki-cli.js'
  $cliMcpBundlePath = Join-Path $cliRoot 'kiki-mcp-bundle.js'
  [IO.File]::WriteAllText($cliBundlePath, '// cli fixture', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($cliMcpBundlePath, '// mcp fixture', [Text.UTF8Encoding]::new($false))
  $cliKey = New-AuthoritySecret
  Write-DpapiSecret (Join-Path $cliRoot 'installation-key.dpapi') $cliKey
  $cliMeta = [ordered]@{
    schemaVersion = 3
    repoPath = $testRoot
    nodePath = $nodePath
    nodeVersion = (& $nodePath --version).Trim()
    kikiCliPath = $cliBundlePath
    kikiCliSha256 = (Get-FileSha256Hex $cliBundlePath)
    mcpPath = $cliMcpBundlePath
    mcpSha256 = (Get-FileSha256Hex $cliMcpBundlePath)
    launcherSha256 = (Get-FileSha256Hex $cliLauncherPath)
    configPath = $configPath
    agentProfileHomeDir = $agentHome
    configReadOnly = $true
    workspacesDir = $cliWorkspaces
    defaultModel = 'model-test'
    defaultThinkingEffort = 'high'
    portRangeStart = [int]$portWindow.start
    portRangeEnd = [int]$portWindow.end
    createdAt = [DateTime]::UtcNow.ToString('o')
    installationMac = ''
  }
  $cliMeta.installationMac = Get-HmacBase64 $cliKey (Get-InstallationPayload $cliMeta)
  Write-JsonFile (Join-Path $cliRoot 'runtime.json') ([pscustomobject]$cliMeta)

  $cliEmptyOutput = (& $pwshExe -NoProfile -File $cliLauncherPath -RuntimeDir $cliRoot -ListWorkspaces)
  Assert-True ($LASTEXITCODE -eq 0) 'the management CLI failed on an empty workspaces directory'
  Assert-True ((@($cliEmptyOutput) -join '').Trim() -eq '[]') 'the empty workspace listing was not empty JSON'

  $workspaceCli = Join-Path $testRoot 'workspace-cli'
  New-Item -ItemType Directory -Path $workspaceCli | Out-Null
  $canonicalCli = Get-CanonicalDirectory $workspaceCli $nodePath 'workspace cli'
  $keyCli = Get-WorkspaceKey $canonicalCli
  $cliInstall = [pscustomobject]@{
    workspacesDir = $cliWorkspaces
    configPath = $configPath
    agentProfileHomeDir = $agentHome
    defaultModel = 'model-test'
    defaultThinkingEffort = 'high'
    portRangeStart = [int]$portWindow.start
    portRangeEnd = [int]$portWindow.end
  }
  $bindingRecordCli = Get-OrCreateWorkspaceBinding $canonicalCli $keyCli $cliInstall
  $workspaceCliOther = Join-Path $testRoot 'workspace-cli-other'
  New-Item -ItemType Directory -Path $workspaceCliOther | Out-Null
  $canonicalCliOther = Get-CanonicalDirectory $workspaceCliOther $nodePath 'workspace cli other'
  $keyCliOther = Get-WorkspaceKey $canonicalCliOther
  $bindingRecordCliOther = Get-OrCreateWorkspaceBinding `
    $canonicalCliOther $keyCliOther $cliInstall

  $bindingListOutput = (& $pwshExe -NoProfile -File $cliLauncherPath `
    -RuntimeDir $cliRoot -ListBindings)
  Assert-True ($LASTEXITCODE -eq 0) 'the binding listing failed for valid records'
  $bindingList = ((@($bindingListOutput) -join "`n") | ConvertFrom-Json)
  Assert-True ($bindingList.runtime.signatureValid -eq $true) 'the binding listing marked valid runtime metadata invalid'
  Assert-True (@($bindingList.bindings).Count -eq 2) 'the binding listing did not include both bindings'
  Assert-True (
    @($bindingList.bindings | Where-Object { $_.signatureValid -ne $true }).Count -eq 0
  ) 'the binding listing marked a valid binding signature invalid'

  $staleRuntime = Get-Content -LiteralPath (Join-Path $cliRoot 'runtime.json') -Raw |
    ConvertFrom-Json
  $staleRuntime.defaultModel = 'model-manual-edit'
  $staleRuntime.defaultThinkingEffort = 'medium'
  Write-JsonFile (Join-Path $cliRoot 'runtime.json') $staleRuntime
  Assert-ThrowsLike {
    Read-InstallationMetadata $cliRoot | Out-Null
  } 'signature does not match' 'the stale runtime signature was accepted before re-signing'

  $staleListOutput = (& $pwshExe -NoProfile -File $cliLauncherPath `
    -RuntimeDir $cliRoot -ListBindings)
  Assert-True ($LASTEXITCODE -eq 0) 'the binding listing could not diagnose stale runtime metadata'
  $staleList = ((@($staleListOutput) -join "`n") | ConvertFrom-Json)
  Assert-True ($staleList.runtime.signatureValid -eq $false) 'the stale runtime signature was not reported'

  $resignOneOutput = (& $pwshExe -NoProfile -File $cliLauncherPath `
    -RuntimeDir $cliRoot -ResignBinding $keyCli `
    -Model 'model-next' -ThinkingEffort 'medium')
  Assert-True ($LASTEXITCODE -eq 0) 'targeted binding re-sign failed'
  $resignOne = ((@($resignOneOutput) -join "`n") | ConvertFrom-Json)
  Assert-True ($resignOne.runtime.signatureBefore -eq $false) 'targeted re-sign did not report the stale runtime signature'
  Assert-True ($resignOne.runtime.signatureValid -eq $true) 'targeted re-sign did not restore the runtime signature'
  Assert-True (@($resignOne.bindings).Count -eq 1) 'targeted re-sign changed the wrong binding count'
  Assert-True ([string]$resignOne.bindings[0].key -ceq $keyCli) 'targeted re-sign changed another binding'

  $verifiedCliInstallation = Read-InstallationMetadata $cliRoot
  Assert-True (
    [string]$verifiedCliInstallation.meta.defaultModel -ceq 'model-next'
  ) 'targeted re-sign did not update the runtime default model'
  $targetedBinding = Read-JsonFile $bindingRecordCli.bindingPath 'targeted binding'
  $targetedSecret = Read-DpapiSecret $targetedBinding.delegationSecretPath 'targeted credential'
  Assert-WorkspaceBinding $targetedBinding $bindingRecordCli.bindingDir `
    $canonicalCli $keyCli $verifiedCliInstallation.meta $targetedSecret
  Assert-True ([string]$targetedBinding.model -ceq 'model-next') 'targeted binding kept the old model'
  Assert-True ([string]$targetedBinding.thinkingEffort -ceq 'medium') 'targeted binding kept the old effort'

  $untouchedBinding = Read-JsonFile $bindingRecordCliOther.bindingPath 'untouched binding'
  $untouchedSecret = Read-DpapiSecret $untouchedBinding.delegationSecretPath 'untouched credential'
  Assert-WorkspaceBinding $untouchedBinding $bindingRecordCliOther.bindingDir `
    $canonicalCliOther $keyCliOther $verifiedCliInstallation.meta $untouchedSecret
  Assert-True ([string]$untouchedBinding.model -ceq 'model-test') 'targeted re-sign changed another binding model'
  Assert-True ([string]$untouchedBinding.thinkingEffort -ceq 'high') 'targeted re-sign changed another binding effort'

  $staleRuntimeAgain = Get-Content -LiteralPath (Join-Path $cliRoot 'runtime.json') -Raw |
    ConvertFrom-Json
  $staleRuntimeAgain.defaultModel = 'model-all-manual-edit'
  Write-JsonFile (Join-Path $cliRoot 'runtime.json') $staleRuntimeAgain
  $resignAllOutput = (& $pwshExe -NoProfile -File $cliLauncherPath `
    -RuntimeDir $cliRoot -ResignAllBindings `
    -Model 'model-all' -ThinkingEffort 'low')
  Assert-True ($LASTEXITCODE -eq 0) 'all-binding re-sign failed'
  $resignAll = ((@($resignAllOutput) -join "`n") | ConvertFrom-Json)
  Assert-True (@($resignAll.bindings).Count -eq 2) 'all-binding re-sign did not update every binding'
  Assert-True (
    @($resignAll.bindings | Where-Object {
      $_.model -cne 'model-all' -or $_.thinkingEffort -cne 'low' -or $_.signatureValid -ne $true
    }).Count -eq 0
  ) 'all-binding re-sign returned an incomplete update'
  $verifiedAllInstallation = Read-InstallationMetadata $cliRoot
  foreach ($bindingRecord in @($bindingRecordCli, $bindingRecordCliOther)) {
    $updatedBinding = Read-JsonFile $bindingRecord.bindingPath 'updated binding'
    $updatedSecret = Read-DpapiSecret $updatedBinding.delegationSecretPath 'updated credential'
    Assert-WorkspaceBinding $updatedBinding $bindingRecord.bindingDir `
      ([string]$updatedBinding.workspacePath) ([string]$updatedBinding.workspaceKey) `
      $verifiedAllInstallation.meta $updatedSecret
  }

  $bindingRecordCli = Get-OrCreateWorkspaceBinding `
    $canonicalCli $keyCli $verifiedAllInstallation.meta
  $cliIdentity = Get-ProcessIdentity $PID
  $cliState = [ordered]@{
    schemaVersion = 1
    pid = $PID
    executablePath = $nodePath
    creationTicks = [long]$cliIdentity.creationTicks
    endpoint = [string]$bindingRecordCli.binding.endpoint
    port = [int]$bindingRecordCli.binding.port
    homeDir = [string]$bindingRecordCli.binding.homeDir
    sessionId = [string]$bindingRecordCli.binding.sessionId
    workspacePath = [string]$bindingRecordCli.binding.workspacePath
    configPath = [string]$bindingRecordCli.binding.configPath
    agentProfileHomeDir = [string]$bindingRecordCli.binding.agentProfileHomeDir
    configReadOnly = $true
    serverId = 'server-cli-test'
    instanceId = 'instance-cli-test'
    startedAt = [DateTime]::UtcNow.ToString('o')
    stateMac = ''
  }
  $cliState.stateMac = Get-HmacBase64 $bindingRecordCli.secret (Get-StatePayload $cliState)
  Write-JsonFile (Join-Path $bindingRecordCli.bindingDir 'runtime-state.json') $cliState

  $cliListOutput = (& $pwshExe -NoProfile -File $cliLauncherPath -RuntimeDir $cliRoot -ListWorkspaces)
  Assert-True ($LASTEXITCODE -eq 0) 'the management CLI failed to list workspaces'
  $cliListing = ((@($cliListOutput) -join "`n") | ConvertFrom-Json)
  $cliEntry = @($cliListing | Where-Object { $_.key -ceq $keyCli })
  Assert-True ($cliEntry.Count -eq 1) 'the CLI listing did not include the seeded workspace'
  Assert-True ([int]$cliEntry[0].port -eq [int]$bindingRecordCli.binding.port) 'the CLI listing recorded the wrong port'
  Assert-True ([string]$cliEntry[0].workspacePath -ceq $canonicalCli) 'the CLI listing recorded the wrong workspace'
  Assert-True ([int]$cliEntry[0].recordedPid -eq $PID) 'the CLI listing recorded the wrong pid'
  Assert-True ($cliEntry[0].processAlive -eq $true) 'the CLI listing marked the live test process dead'

  $cliStopUnknownOutput = (& $pwshExe -NoProfile -File $cliLauncherPath -RuntimeDir $cliRoot -StopWorkspace ('0' * 64))
  Assert-True ($LASTEXITCODE -eq 1) 'stopping an unknown workspace key did not fail'
  $cliStopUnknown = ((@($cliStopUnknownOutput) -join "`n") | ConvertFrom-Json)
  Assert-True ([string]$cliStopUnknown.status -eq 'missing') 'stopping an unknown workspace key did not report missing'

  $cliStopBadKeyOutput = (& $pwshExe -NoProfile -File $cliLauncherPath -RuntimeDir $cliRoot -StopWorkspace 'not-a-hex-key')
  Assert-True ($LASTEXITCODE -eq 1) 'stopping a malformed workspace key did not fail'
  $cliStopBadKey = ((@($cliStopBadKeyOutput) -join "`n") | ConvertFrom-Json)
  Assert-True ([string]$cliStopBadKey.status -eq 'invalid-key') 'a malformed workspace key was not reported as invalid-key'

  & $pwshExe -NoProfile -File $cliLauncherPath -RuntimeDir $cliRoot -ListWorkspaces -StopWorkspace ('0' * 64) 2>&1 | Out-Null
  Assert-True ($LASTEXITCODE -eq 2) 'combining management modes did not fail with the usage exit code'

  & $pwshExe -NoProfile -File $cliLauncherPath -ListWorkspaces 2>&1 | Out-Null
  Assert-True ($LASTEXITCODE -eq 2) 'omitting -RuntimeDir did not fail with the usage exit code'

  [pscustomobject]@{
    canonicalAlias = 'passed'
    windowsCaseFoldKey = 'passed'
    concurrentDifferentWorkspaces = 'passed'
    deterministicSameWorkspaceReuse = 'passed'
    mutatedBindingRejected = 'passed'
    bindingDriftFieldsListed = 'passed'
    liveStaleOwnerRejected = 'passed'
    unownedListenerRejected = 'passed'
    unownedListenerNamesOccupant = 'passed'
    unownedListenerCleanup = 'passed'
    authorityCredentialsIsolated = 'passed'
    workspaceListingFields = 'passed'
    recordedStopEndToEnd = 'passed'
    recycleOwnerSemantics = 'passed'
    managementCliListAndStop = 'passed'
    bindingSignatureListing = 'passed'
    staleRuntimeResigned = 'passed'
    targetedBindingResigned = 'passed'
    allBindingsResigned = 'passed'
    managementCliInvalidKey = 'passed'
    managementCliModeExclusive = 'passed'
    managementCliMissingRuntime = 'passed'
  } | ConvertTo-Json
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedTestRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'refusing to remove a test path outside the temporary directory'
  }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
