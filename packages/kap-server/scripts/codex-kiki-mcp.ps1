param(
  [string]$RuntimeDir,
  [switch]$ListWorkspaces,
  [switch]$ListBindings,
  [string]$StopWorkspace,
  [switch]$StopAllKap,
  [string]$ResignBinding,
  [switch]$ResignAllBindings,
  [string]$Model,
  [string]$ThinkingEffort
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security

function Stop-KikiMcp {
  param([string]$Message)
  throw [InvalidOperationException]::new($Message)
}

function Read-JsonFile {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Stop-KikiMcp "$Label is missing"
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    Stop-KikiMcp "$Label is unreadable"
  }
}

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  $json = $Value | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function Write-JsonFileAtomic {
  param([string]$Path, [object]$Value)
  $temporaryPath = "$Path.resigning.$PID.$([Guid]::NewGuid().ToString('N'))"
  try {
    Write-JsonFile $temporaryPath $Value
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-PropertySet {
  param([object]$Value, [string[]]$Expected, [string]$Label)
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count -or (Compare-Object $actual $wanted).Count -ne 0) {
    Stop-KikiMcp "$Label has an unexpected schema"
  }
}

function Read-DpapiSecret {
  param([string]$Path, [string]$Label)
  try {
    $blob = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $blob,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $secret = [Text.Encoding]::UTF8.GetString($bytes)
    [Array]::Clear($bytes, 0, $bytes.Length)
    if ([string]::IsNullOrWhiteSpace($secret)) {
      Stop-KikiMcp "$Label is empty"
    }
    return $secret
  } catch {
    Stop-KikiMcp "$Label cannot be decrypted by the current user"
  }
}

function Write-DpapiSecret {
  param([string]$Path, [string]$Secret)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Secret)
  try {
    $blob = [Security.Cryptography.ProtectedData]::Protect(
      $bytes,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllText(
      $Path,
      [Convert]::ToBase64String($blob),
      [Text.UTF8Encoding]::new($false)
    )
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function New-AuthoritySecret {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  try {
    return [Convert]::ToBase64String($bytes)
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Get-Sha256Hex {
  param([string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return -join ($hash | ForEach-Object { $_.ToString('x2') })
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Get-FileSha256Hex {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Stop-KikiMcp 'a file hash target is missing'
  }
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $hash = $sha.ComputeHash($stream)
      return (-join ($hash | ForEach-Object { $_.ToString('x2') }))
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-HmacBase64 {
  param([string]$Secret, [string]$Payload)
  $key = [Text.Encoding]::UTF8.GetBytes($Secret)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Payload)
  try {
    $hmac = [Security.Cryptography.HMACSHA256]::new($key)
    try {
      return [Convert]::ToBase64String($hmac.ComputeHash($bytes))
    } finally {
      $hmac.Dispose()
    }
  } finally {
    [Array]::Clear($key, 0, $key.Length)
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Test-FixedTimeEqual {
  param([string]$Left, [string]$Right)
  $a = [Text.Encoding]::UTF8.GetBytes($Left)
  $b = [Text.Encoding]::UTF8.GetBytes($Right)
  try {
    if ($a.Length -ne $b.Length) { return $false }
    $difference = 0
    for ($i = 0; $i -lt $a.Length; $i++) {
      $difference = $difference -bor ($a[$i] -bxor $b[$i])
    }
    return $difference -eq 0
  } finally {
    [Array]::Clear($a, 0, $a.Length)
    [Array]::Clear($b, 0, $b.Length)
  }
}

function Get-StableTimestampText {
  param([object]$Value)
  if ($Value -is [DateTime]) {
    $utc = $Value.ToUniversalTime()
    return ([DateTimeOffset]$utc).ToString(
      'o',
      [Globalization.CultureInfo]::InvariantCulture
    )
  }
  $parsed = [DateTimeOffset]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor `
    [Globalization.DateTimeStyles]::AdjustToUniversal
  if (
    [DateTimeOffset]::TryParse(
      [string]$Value,
      [Globalization.CultureInfo]::InvariantCulture,
      $styles,
      [ref]$parsed
    )
  ) {
    return $parsed.ToUniversalTime().ToString(
      'o',
      [Globalization.CultureInfo]::InvariantCulture
    )
  }
  return [string]$Value
}

function Get-InstallationPayload {
  param([object]$Meta)
  return @(
    'installation:v3',
    [string]$Meta.repoPath,
    [string]$Meta.nodePath,
    [string]$Meta.nodeVersion,
    [string]$Meta.kikiCliPath,
    [string]$Meta.kikiCliSha256,
    [string]$Meta.mcpPath,
    [string]$Meta.mcpSha256,
    [string]$Meta.launcherSha256,
    [string]$Meta.configPath,
    [string]$Meta.agentProfileHomeDir,
    [string]$Meta.configReadOnly,
    [string]$Meta.workspacesDir,
    [string]$Meta.defaultModel,
    [string]$Meta.defaultThinkingEffort,
    [string]$Meta.portRangeStart,
    [string]$Meta.portRangeEnd,
    (Get-StableTimestampText $Meta.createdAt)
  ) -join "`n"
}

function Get-BindingPayload {
  param([object]$Binding)
  return @(
    'workspace-binding:v1',
    [string]$Binding.workspaceKey,
    [string]$Binding.workspacePath,
    [string]$Binding.sessionId,
    [string]$Binding.sessionTitle,
    [string]$Binding.principalId,
    [string]$Binding.port,
    [string]$Binding.endpoint,
    [string]$Binding.homeDir,
    [string]$Binding.delegationSecretPath,
    [string]$Binding.configPath,
    [string]$Binding.agentProfileHomeDir,
    [string]$Binding.configReadOnly,
    [string]$Binding.model,
    [string]$Binding.thinkingEffort,
    [string]$Binding.delegationId,
    (Get-StableTimestampText $Binding.createdAt)
  ) -join "`n"
}

function Get-StatePayload {
  param([object]$State)
  return @(
    'workspace-runtime-state:v1',
    [string]$State.pid,
    [string]$State.executablePath,
    [string]$State.creationTicks,
    [string]$State.endpoint,
    [string]$State.port,
    [string]$State.homeDir,
    [string]$State.sessionId,
    [string]$State.workspacePath,
    [string]$State.configPath,
    [string]$State.agentProfileHomeDir,
    [string]$State.configReadOnly,
    [string]$State.serverId,
    [string]$State.instanceId,
    (Get-StableTimestampText $State.startedAt)
  ) -join "`n"
}

function Get-CanonicalDirectory {
  param([string]$Path, [string]$NodePath, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    Stop-KikiMcp "$Label is not an existing directory"
  }
  $script = "const fs=require('node:fs');process.stdout.write(fs.realpathSync.native(process.argv[1]));"
  $resolved = (& $NodePath -e $script $Path 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$resolved)) {
    Stop-KikiMcp "$Label cannot be canonicalized"
  }
  return ([IO.Path]::GetFullPath([string]$resolved)).TrimEnd(
    [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  )
}

function Get-WorkspaceKey {
  param([string]$CanonicalWorkspace)
  $identity = $CanonicalWorkspace
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $identity = $identity.ToLowerInvariant()
  }
  return Get-Sha256Hex "workspace:v1:$identity"
}

function Test-SamePath {
  param([string]$Left, [string]$Right)
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { return $Left -ieq $Right }
  return $Left -ceq $Right
}

function Get-ProcessIdentity {
  param([int]$PidValue)
  if ($PidValue -le 0) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  return [pscustomobject]@{
    pid = [int]$process.ProcessId
    executablePath = [string]$process.ExecutablePath
    creationTicks = [long]$process.CreationDate.ToUniversalTime().Ticks
    commandLine = [string]$process.CommandLine
  }
}

function Get-ListenerPids {
  param([int]$Port)
  return @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
}

function Get-PortOccupantDescription {
  param([int]$Port)
  $occupants = @(Get-ListenerPids $Port)
  if ($occupants.Count -eq 0) { return 'no listener' }
  $parts = foreach ($owner in $occupants) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    $name = 'unknown process'
    if ($null -ne $process -and -not [string]::IsNullOrWhiteSpace([string]$process.Name)) {
      $name = [string]$process.Name
    }
    "pid $owner ($name)"
  }
  return $parts -join ', '
}

function New-NamedMutex {
  param([string]$Name)
  return [Threading.Mutex]::new($false, "Local\$Name")
}

function Enter-NamedMutex {
  param([Threading.Mutex]$Mutex, [int]$TimeoutSeconds, [string]$Label)
  try {
    if (-not $Mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))) {
      Stop-KikiMcp "$Label did not become available"
    }
  } catch [Threading.AbandonedMutexException] {
    return
  }
}

function Exit-NamedMutex {
  param([Threading.Mutex]$Mutex)
  try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }
}

function Restore-EnvironmentValue {
  param([string]$Name, [AllowNull()][string]$Value)
  if ($null -eq $Value) {
    Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
  } else {
    Set-Item -LiteralPath "Env:$Name" -Value $Value
  }
}

function Assert-ArtifactHash {
  param([string]$Path, [string]$Expected, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Stop-KikiMcp "$Label is missing"
  }
  $actual = Get-FileSha256Hex $Path
  if ($actual -cne $Expected.ToLowerInvariant()) {
    Stop-KikiMcp "$Label does not match the installed candidate"
  }
}

function Read-InstallationMetadataCandidate {
  param([string]$RuntimeDir)
  $metadataPath = Join-Path $RuntimeDir 'runtime.json'
  $keyPath = Join-Path $RuntimeDir 'installation-key.dpapi'
  $meta = Read-JsonFile $metadataPath 'installation metadata'
  Assert-PropertySet $meta @(
    'schemaVersion', 'repoPath', 'nodePath', 'nodeVersion', 'kikiCliPath',
    'kikiCliSha256', 'mcpPath', 'mcpSha256', 'launcherSha256', 'configPath',
    'agentProfileHomeDir', 'configReadOnly', 'workspacesDir', 'defaultModel',
    'defaultThinkingEffort', 'portRangeStart', 'portRangeEnd', 'createdAt',
    'installationMac'
  ) 'installation metadata'
  if ([int]$meta.schemaVersion -ne 3 -or $meta.configReadOnly -ne $true) {
    Stop-KikiMcp 'installation metadata violates the v3 authority contract'
  }
  $installationKey = Read-DpapiSecret $keyPath 'installation authority credential'
  $expectedMac = Get-HmacBase64 $installationKey (Get-InstallationPayload $meta)
  $signatureValid = Test-FixedTimeEqual ([string]$meta.installationMac) $expectedMac
  $expectedWorkspaces = [IO.Path]::GetFullPath((Join-Path $RuntimeDir 'workspaces'))
  $configuredWorkspaces = [IO.Path]::GetFullPath([string]$meta.workspacesDir)
  if (
    -not (Test-SamePath $configuredWorkspaces $expectedWorkspaces) -or
    [int]$meta.portRangeStart -lt 1024 -or
    [int]$meta.portRangeEnd -gt 65535 -or
    [int]$meta.portRangeStart -gt [int]$meta.portRangeEnd
  ) {
    Stop-KikiMcp 'installation metadata contains an invalid routing boundary'
  }
  Assert-ArtifactHash (Join-Path $RuntimeDir 'kiki-mcp.ps1') ([string]$meta.launcherSha256) 'installed launcher'
  Assert-ArtifactHash ([string]$meta.kikiCliPath) ([string]$meta.kikiCliSha256) 'Kiki CLI bundle'
  Assert-ArtifactHash ([string]$meta.mcpPath) ([string]$meta.mcpSha256) 'Kiki MCP bundle'
  if (
    -not (Test-Path -LiteralPath ([string]$meta.repoPath) -PathType Container) -or
    -not (Test-Path -LiteralPath ([string]$meta.nodePath) -PathType Leaf) -or
    -not (Test-Path -LiteralPath ([string]$meta.configPath) -PathType Leaf) -or
    -not (Test-Path -LiteralPath ([string]$meta.agentProfileHomeDir) -PathType Container)
  ) {
    Stop-KikiMcp 'a pinned installation artifact is missing'
  }
  $nodeVersion = (& ([string]$meta.nodePath) --version 2>$null).Trim()
  if ($nodeVersion -cne [string]$meta.nodeVersion) {
    Stop-KikiMcp 'the pinned Node runtime version does not match'
  }
  New-Item -ItemType Directory -Path $expectedWorkspaces -Force | Out-Null
  return [pscustomobject]@{
    meta = $meta
    installationKey = $installationKey
    metadataPath = $metadataPath
    signatureValid = $signatureValid
  }
}

function Read-InstallationMetadata {
  param([string]$RuntimeDir)
  $installation = Read-InstallationMetadataCandidate $RuntimeDir
  if (-not $installation.signatureValid) {
    Stop-KikiMcp 'installation metadata signature does not match'
  }
  if (
    [string]::IsNullOrWhiteSpace([string]$installation.meta.defaultModel) -or
    [string]::IsNullOrWhiteSpace([string]$installation.meta.defaultThinkingEffort)
  ) {
    Stop-KikiMcp 'installation metadata contains an invalid routing boundary'
  }
  return $installation
}

function Get-ReservedPorts {
  param([string]$WorkspacesDir)
  $reserved = @{}
  Get-ChildItem -LiteralPath $WorkspacesDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $path = Join-Path $_.FullName 'binding.json'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      try {
        $port = [int]((Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).port)
        if ($port -gt 0) { $reserved[$port] = $true }
      } catch {
        Stop-KikiMcp 'an existing workspace binding is unreadable during port allocation'
      }
    }
  }
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $reserved[[int]$_.LocalPort] = $true
  }
  return $reserved
}

function Select-WorkspacePort {
  param([object]$Install, [string]$WorkspaceKey)
  $start = [int]$Install.portRangeStart
  $end = [int]$Install.portRangeEnd
  $count = $end - $start + 1
  $seed = [Convert]::ToUInt32($WorkspaceKey.Substring(0, 8), 16)
  $reserved = Get-ReservedPorts ([string]$Install.workspacesDir)
  for ($offset = 0; $offset -lt $count; $offset++) {
    $candidate = $start + (($seed + $offset) % $count)
    if (-not $reserved.ContainsKey([int]$candidate)) { return [int]$candidate }
  }
  Stop-KikiMcp 'the dedicated Kiki workspace port range is exhausted'
}

function New-BindingDriftItem {
  param(
    [string]$Field,
    [string]$Expected,
    [AllowEmptyString()][string]$Actual
  )
  return [pscustomobject]@{ field = $Field; expected = $Expected; actual = $Actual }
}

function Format-BindingDrift {
  param([object[]]$Drift)
  $parts = foreach ($item in @($Drift)) {
    $actual = [string]$item.actual
    if ([string]::IsNullOrWhiteSpace($actual)) {
      $actual = '<empty>'
    } else {
      $actual = "'$actual'"
    }
    "$($item.field): expected $($item.expected) (actual $actual)"
  }
  return $parts -join '; '
}

function Get-WorkspaceBindingDrift {
  param(
    [object]$Binding,
    [string]$ExpectedHome,
    [string]$ExpectedSecret,
    [string]$Workspace,
    [string]$WorkspaceKey,
    [object]$Install
  )
  $drift = @()
  if ([int]$Binding.schemaVersion -ne 1) {
    $drift += New-BindingDriftItem 'schemaVersion' "'1'" ([string]$Binding.schemaVersion)
  }
  if ([string]$Binding.workspaceKey -cne $WorkspaceKey) {
    $drift += New-BindingDriftItem 'workspaceKey' "'$WorkspaceKey'" ([string]$Binding.workspaceKey)
  }
  if (-not (Test-SamePath ([string]$Binding.workspacePath) $Workspace)) {
    $drift += New-BindingDriftItem 'workspacePath' "'$Workspace'" ([string]$Binding.workspacePath)
  }
  if ([string]$Binding.sessionId -notmatch '^session_[A-Za-z0-9_-]+$') {
    $drift += New-BindingDriftItem 'sessionId' `
      "matching '^session_[A-Za-z0-9_-]+$'" ([string]$Binding.sessionId)
  }
  if ([string]::IsNullOrWhiteSpace([string]$Binding.principalId)) {
    $drift += New-BindingDriftItem 'principalId' 'non-empty' ([string]$Binding.principalId)
  }
  $port = 0
  if (-not [int]::TryParse([string]$Binding.port, [ref]$port)) { $port = -1 }
  if ($port -lt [int]$Install.portRangeStart -or $port -gt [int]$Install.portRangeEnd) {
    $drift += New-BindingDriftItem 'port' `
      "$([int]$Install.portRangeStart)-$([int]$Install.portRangeEnd)" ([string]$Binding.port)
  }
  if ([string]$Binding.endpoint -cne "http://127.0.0.1:$port") {
    $drift += New-BindingDriftItem 'endpoint' `
      "'http://127.0.0.1:$port'" ([string]$Binding.endpoint)
  }
  if (-not (Test-SamePath ([IO.Path]::GetFullPath([string]$Binding.homeDir)) $ExpectedHome)) {
    $drift += New-BindingDriftItem 'homeDir' "'$ExpectedHome'" ([string]$Binding.homeDir)
  }
  if (
    -not (Test-SamePath ([IO.Path]::GetFullPath([string]$Binding.delegationSecretPath)) $ExpectedSecret)
  ) {
    $drift += New-BindingDriftItem 'delegationSecretPath' `
      "'$ExpectedSecret'" ([string]$Binding.delegationSecretPath)
  }
  if (-not (Test-SamePath ([string]$Binding.configPath) ([string]$Install.configPath))) {
    $drift += New-BindingDriftItem 'configPath' `
      "'$([string]$Install.configPath)'" ([string]$Binding.configPath)
  }
  if (-not (Test-SamePath ([string]$Binding.agentProfileHomeDir) ([string]$Install.agentProfileHomeDir))) {
    $drift += New-BindingDriftItem 'agentProfileHomeDir' `
      "'$([string]$Install.agentProfileHomeDir)'" ([string]$Binding.agentProfileHomeDir)
  }
  if ($Binding.configReadOnly -ne $true) {
    $drift += New-BindingDriftItem 'configReadOnly' "'True'" ([string]$Binding.configReadOnly)
  }
  if ([string]::IsNullOrWhiteSpace([string]$Binding.model)) {
    $drift += New-BindingDriftItem 'model' 'non-empty' ([string]$Binding.model)
  }
  if ([string]::IsNullOrWhiteSpace([string]$Binding.thinkingEffort)) {
    $drift += New-BindingDriftItem 'thinkingEffort' 'non-empty' ([string]$Binding.thinkingEffort)
  }
  if (
    -not [string]::IsNullOrWhiteSpace([string]$Binding.delegationId) -and
    [string]$Binding.delegationId -notmatch '^delegation_'
  ) {
    $drift += New-BindingDriftItem 'delegationId' `
      "unset or matching '^delegation_'" ([string]$Binding.delegationId)
  }
  return $drift
}

function Assert-WorkspaceBindingSignature {
  param([object]$Binding, [string]$Secret)
  $expectedMac = Get-HmacBase64 $Secret (Get-BindingPayload $Binding)
  if (-not (Test-FixedTimeEqual ([string]$Binding.bindingMac) $expectedMac)) {
    Stop-KikiMcp 'workspace binding signature does not match'
  }
}

function Assert-WorkspaceBinding {
  param(
    [object]$Binding,
    [string]$BindingDir,
    [string]$Workspace,
    [string]$WorkspaceKey,
    [object]$Install,
    [string]$Secret
  )
  Assert-PropertySet $Binding @(
    'schemaVersion', 'workspaceKey', 'workspacePath', 'sessionId', 'sessionTitle',
    'principalId', 'port', 'endpoint', 'homeDir', 'delegationSecretPath',
    'configPath', 'agentProfileHomeDir', 'configReadOnly', 'model',
    'thinkingEffort', 'delegationId', 'createdAt', 'bindingMac'
  ) 'workspace binding'
  $expectedHome = [IO.Path]::GetFullPath((Join-Path $BindingDir 'kap-home'))
  $expectedSecret = [IO.Path]::GetFullPath((Join-Path $BindingDir 'delegation-token.dpapi'))
  $drift = @(Get-WorkspaceBindingDrift `
    $Binding $expectedHome $expectedSecret $Workspace $WorkspaceKey $Install)
  if ($drift.Count -gt 0) {
    Stop-KikiMcp (
      'workspace binding violates the isolated authority contract; drifted fields: ' +
      "$(Format-BindingDrift $drift). " +
      "Run -ResignBinding $WorkspaceKey with the intended -Model and/or " +
      '-ThinkingEffort when only signed model parameters changed. For other fields, re-run ' +
      'the external install orchestration, or stop the workspace and remove ' +
      "'$BindingDir' to re-provision it (this abandons the recorded delegated Session)."
    )
  }
  Assert-WorkspaceBindingSignature $Binding $Secret
  if (
    -not (Test-Path -LiteralPath $expectedHome -PathType Container) -or
    -not (Test-Path -LiteralPath $expectedSecret -PathType Leaf)
  ) {
    Stop-KikiMcp 'workspace authority storage is incomplete'
  }
}

function New-WorkspaceBinding {
  param(
    [string]$BindingDir,
    [string]$Workspace,
    [string]$WorkspaceKey,
    [object]$Install,
    [string]$Secret
  )
  $port = Select-WorkspacePort $Install $WorkspaceKey
  $leaf = Split-Path -Leaf $Workspace
  if ([string]::IsNullOrWhiteSpace($leaf)) { $leaf = $Workspace }
  $binding = [ordered]@{
    schemaVersion = 1
    workspaceKey = $WorkspaceKey
    workspacePath = $Workspace
    sessionId = "session_$([Guid]::NewGuid())"
    sessionTitle = "Codex: $leaf"
    principalId = "codex-local:$WorkspaceKey"
    port = $port
    endpoint = "http://127.0.0.1:$port"
    homeDir = [IO.Path]::GetFullPath((Join-Path $BindingDir 'kap-home'))
    delegationSecretPath = [IO.Path]::GetFullPath((Join-Path $BindingDir 'delegation-token.dpapi'))
    configPath = [string]$Install.configPath
    agentProfileHomeDir = [string]$Install.agentProfileHomeDir
    configReadOnly = $true
    model = [string]$Install.defaultModel
    thinkingEffort = [string]$Install.defaultThinkingEffort
    delegationId = $null
    createdAt = [DateTime]::UtcNow.ToString('o')
    bindingMac = ''
  }
  $binding.bindingMac = Get-HmacBase64 $Secret (Get-BindingPayload $binding)
  return [pscustomobject]$binding
}

function Get-OrCreateWorkspaceBinding {
  param([string]$Workspace, [string]$WorkspaceKey, [object]$Install)
  $bindingDir = Join-Path ([string]$Install.workspacesDir) $WorkspaceKey
  $bindingPath = Join-Path $bindingDir 'binding.json'
  $secretPath = Join-Path $bindingDir 'delegation-token.dpapi'
  if (-not (Test-Path -LiteralPath $bindingDir -PathType Container)) {
    $provisionMutex = New-NamedMutex 'KikiMcpWorkspaceProvision-v1'
    Enter-NamedMutex $provisionMutex 60 'the Kiki workspace provision lock'
    try {
      if (-not (Test-Path -LiteralPath $bindingDir -PathType Container)) {
        $temporaryDir = "$bindingDir.provisioning.$PID.$([Guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Path $temporaryDir | Out-Null
        $secret = New-AuthoritySecret
        Write-DpapiSecret (Join-Path $temporaryDir 'delegation-token.dpapi') $secret
        New-Item -ItemType Directory -Path (Join-Path $temporaryDir 'kap-home') | Out-Null
        $binding = New-WorkspaceBinding $bindingDir $Workspace $WorkspaceKey $Install $secret
        Write-JsonFile (Join-Path $temporaryDir 'binding.json') $binding
        Move-Item -LiteralPath $temporaryDir -Destination $bindingDir
      }
    } finally {
      Exit-NamedMutex $provisionMutex
    }
  }
  $binding = Read-JsonFile $bindingPath 'workspace binding'
  $secret = Read-DpapiSecret $secretPath 'workspace delegation credential'
  Assert-WorkspaceBinding $binding $bindingDir $Workspace $WorkspaceKey $Install $secret
  return [pscustomobject]@{
    binding = $binding
    bindingDir = $bindingDir
    bindingPath = $bindingPath
    secret = $secret
  }
}

function Assert-RuntimeState {
  param([object]$State, [object]$Binding, [object]$Install, [string]$Secret)
  Assert-PropertySet $State @(
    'schemaVersion', 'pid', 'executablePath', 'creationTicks', 'endpoint', 'port',
    'homeDir', 'sessionId', 'workspacePath', 'configPath', 'agentProfileHomeDir',
    'configReadOnly', 'serverId', 'instanceId', 'startedAt', 'stateMac'
  ) 'workspace runtime state'
  if (
    [int]$State.schemaVersion -ne 1 -or
    [int]$State.pid -le 0 -or
    [long]$State.creationTicks -le 0 -or
    -not (Test-SamePath ([string]$State.executablePath) ([string]$Install.nodePath)) -or
    [string]$State.endpoint -cne [string]$Binding.endpoint -or
    [int]$State.port -ne [int]$Binding.port -or
    -not (Test-SamePath ([string]$State.homeDir) ([string]$Binding.homeDir)) -or
    [string]$State.sessionId -cne [string]$Binding.sessionId -or
    -not (Test-SamePath ([string]$State.workspacePath) ([string]$Binding.workspacePath)) -or
    -not (Test-SamePath ([string]$State.configPath) ([string]$Binding.configPath)) -or
    -not (Test-SamePath ([string]$State.agentProfileHomeDir) ([string]$Binding.agentProfileHomeDir)) -or
    $State.configReadOnly -ne $true -or
    [string]::IsNullOrWhiteSpace([string]$State.serverId) -or
    [string]::IsNullOrWhiteSpace([string]$State.instanceId)
  ) {
    Stop-KikiMcp 'workspace runtime state violates the recorded owner contract'
  }
  $expectedMac = Get-HmacBase64 $Secret (Get-StatePayload $State)
  if (-not (Test-FixedTimeEqual ([string]$State.stateMac) $expectedMac)) {
    Stop-KikiMcp 'workspace runtime state signature does not match'
  }
}

function Remove-DeadInstanceRecords {
  param([object]$Binding)
  $instancesDir = Join-Path ([string]$Binding.homeDir) 'server\instances'
  if (-not (Test-Path -LiteralPath $instancesDir -PathType Container)) { return }
  foreach ($record in @(Get-ChildItem -LiteralPath $instancesDir -Filter '*.json' -File)) {
    $instance = Read-JsonFile $record.FullName 'dedicated-home instance record'
    $identity = Get-ProcessIdentity ([int]$instance.pid)
    if ($null -ne $identity) {
      Stop-KikiMcp 'a live unrecorded process still owns the dedicated Kiki home'
    }
    Remove-Item -LiteralPath $record.FullName -Force
  }
}

function Assert-DedicatedInstance {
  param([object]$State, [object]$Identity, [object]$Binding)
  $instancesDir = Join-Path ([string]$Binding.homeDir) 'server\instances'
  $instancePath = Join-Path $instancesDir "$([string]$State.instanceId).json"
  if (-not (Test-Path -LiteralPath $instancePath -PathType Leaf)) {
    Stop-KikiMcp 'the recorded owner has no dedicated-home instance record'
  }
  $records = @(Get-ChildItem -LiteralPath $instancesDir -Filter '*.json' -File)
  if ($records.Count -ne 1 -or $records[0].FullName -ne $instancePath) {
    Stop-KikiMcp 'the dedicated-home instance registry is not exclusive'
  }
  $instance = Read-JsonFile $instancePath 'dedicated-home instance record'
  if (
    [string]$instance.server_id -cne [string]$State.instanceId -or
    [int]$instance.pid -ne [int]$Identity.pid -or
    [int]$instance.port -ne [int]$Binding.port -or
    [string]$instance.host -cne '127.0.0.1'
  ) {
    Stop-KikiMcp 'the dedicated-home instance record does not match the recorded owner'
  }
}

function Invoke-KapJson {
  param(
    [ValidateSet('GET', 'POST')][string]$Method,
    [string]$Uri,
    [string]$Bearer,
    [string]$DelegationToken,
    [object]$Body
  )
  if ([string]::IsNullOrWhiteSpace($Bearer)) {
    Stop-KikiMcp 'the authenticated KAP probe has no bearer credential'
  }
  $headers = @{ Authorization = "Bearer $Bearer" }
  if (-not [string]::IsNullOrWhiteSpace($DelegationToken)) {
    $headers['x-kiki-delegation-token'] = $DelegationToken
  }
  try {
    $args = @{ Uri = $Uri; Method = $Method; Headers = $headers; TimeoutSec = 15 }
    if ($Method -eq 'POST') {
      $args['ContentType'] = 'application/json'
      $args['Body'] = $Body | ConvertTo-Json -Compress -Depth 20
    }
    return Invoke-RestMethod @args
  } catch {
    Stop-KikiMcp "the authenticated KAP probe failed at $Uri"
  }
}

function Start-WorkspaceKap {
  param(
    [object]$Binding,
    [object]$Install,
    [string]$DelegationToken,
    [string]$StatePath
  )
  Remove-DeadInstanceRecords $Binding
  $prior = @{}
  foreach ($name in @(
    'KIMI_CODE_HOME', 'KIKI_MCP_CONFIG_PATH', 'KIKI_MCP_AGENT_PROFILE_HOME',
    'KIKI_MCP_CONFIG_READ_ONLY', 'KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP',
    'KIKI_EXTERNAL_PRINCIPAL_ID', 'KIKI_EXTERNAL_SESSION_ID',
    'KIKI_EXTERNAL_DELEGATION_TOKEN', 'KIKI_EXTERNAL_WORKSPACE_PATH',
    'KIKI_EXTERNAL_MODEL_ALIAS', 'KIKI_EXTERNAL_THINKING_EFFORT',
    'KIKI_EXTERNAL_SESSION_TITLE'
  )) {
    $prior[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $started = $null
  try {
    $env:KIMI_CODE_HOME = [string]$Binding.homeDir
    $env:KIKI_MCP_CONFIG_PATH = [string]$Binding.configPath
    $env:KIKI_MCP_AGENT_PROFILE_HOME = [string]$Binding.agentProfileHomeDir
    $env:KIKI_MCP_CONFIG_READ_ONLY = '1'
    $env:KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP = 'true'
    $env:KIKI_EXTERNAL_PRINCIPAL_ID = [string]$Binding.principalId
    $env:KIKI_EXTERNAL_SESSION_ID = [string]$Binding.sessionId
    $env:KIKI_EXTERNAL_DELEGATION_TOKEN = $DelegationToken
    $env:KIKI_EXTERNAL_WORKSPACE_PATH = [string]$Binding.workspacePath
    $env:KIKI_EXTERNAL_MODEL_ALIAS = [string]$Binding.model
    $env:KIKI_EXTERNAL_THINKING_EFFORT = [string]$Binding.thinkingEffort
    $env:KIKI_EXTERNAL_SESSION_TITLE = [string]$Binding.sessionTitle
    $started = Start-Process -FilePath ([string]$Install.nodePath) -ArgumentList @(
      [string]$Install.kikiCliPath,
      'web', '--host', '127.0.0.1', '--port', [string]$Binding.port, '--no-open'
    ) -WorkingDirectory ([string]$Binding.workspacePath) -WindowStyle Hidden `
      -RedirectStandardOutput 'NUL' -RedirectStandardError '\\.\NUL' -PassThru
  } finally {
    foreach ($name in $prior.Keys) { Restore-EnvironmentValue $name $prior[$name] }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 200
    if ($started.HasExited) { Stop-KikiMcp 'the dedicated workspace KAP exited during startup' }
    $listenerPids = @(Get-ListenerPids ([int]$Binding.port))
  } while ($listenerPids.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
  if ($listenerPids.Count -ne 1 -or [int]$listenerPids[0] -ne [int]$started.Id) {
    if (-not $started.HasExited) { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue }
    Stop-KikiMcp (
      'the new workspace KAP did not exclusively acquire its recorded port ' +
      "$([int]$Binding.port) (port listeners now: $(Get-PortOccupantDescription ([int]$Binding.port))); " +
      'another process owns the port - stop that process yourself (or a recorded Kiki KAP ' +
      "with -StopWorkspace $($Binding.workspaceKey)) and retry the launcher; the recorded port " +
      'cannot be reassigned without re-running the external install orchestration'
    )
  }
  $identity = Get-ProcessIdentity $started.Id
  if ($null -eq $identity -or -not (Test-SamePath $identity.executablePath ([string]$Install.nodePath))) {
    if (-not $started.HasExited) { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue }
    Stop-KikiMcp 'the new workspace KAP process identity is invalid'
  }

  $tokenPath = Join-Path ([string]$Binding.homeDir) 'server.token'
  $instanceDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $records = @(
      Get-ChildItem -LiteralPath (Join-Path ([string]$Binding.homeDir) 'server\instances') `
        -Filter '*.json' -File -ErrorAction SilentlyContinue
    )
    if ($records.Count -eq 1 -and (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $instanceDeadline)
  if ($records.Count -ne 1 -or -not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
    Stop-KikiMcp 'the new workspace KAP did not create its exclusive authority records'
  }
  $instance = Read-JsonFile $records[0].FullName 'dedicated-home instance record'
  if (
    [int]$instance.pid -ne [int]$identity.pid -or
    [int]$instance.port -ne [int]$Binding.port -or
    [string]$instance.host -cne '127.0.0.1' -or
    [string]::IsNullOrWhiteSpace([string]$instance.server_id)
  ) {
    Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
    Stop-KikiMcp 'the new workspace KAP instance record is invalid'
  }
  return [pscustomobject]@{ process = $started; identity = $identity; instance = $instance }
}

function Resolve-WorkspaceKap {
  param([object]$Binding, [object]$Install, [string]$Secret, [string]$BindingDir)
  $statePath = Join-Path $BindingDir 'runtime-state.json'
  $listenerPids = @(Get-ListenerPids ([int]$Binding.port))
  if ($listenerPids.Count -gt 1) {
    Stop-KikiMcp (
      "multiple processes own the workspace KAP port $([int]$Binding.port) " +
      "($(Get-PortOccupantDescription ([int]$Binding.port))); stop the processes that should not " +
      'own the port and retry the launcher'
    )
  }
  $started = $null
  if ($listenerPids.Count -eq 1) {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
      $stopHint = ''
      if (-not [string]::IsNullOrWhiteSpace([string]$Binding.workspaceKey)) {
        $stopHint = " or stop the recorded Kiki KAP with -StopWorkspace $($Binding.workspaceKey)"
      }
      Stop-KikiMcp (
        "the workspace KAP port $([int]$Binding.port) is occupied by an unrecorded process " +
        "($(Get-PortOccupantDescription ([int]$Binding.port))); this launcher never stops unrecorded " +
        "processes - free the port yourself$stopHint, then retry the launcher. The recorded port is " +
        'pinned by the signed workspace binding and can only change by re-running the external ' +
        'install orchestration'
      )
    }
    $state = Read-JsonFile $statePath 'workspace runtime state'
    Assert-RuntimeState $state $Binding $Install $Secret
    $identity = Get-ProcessIdentity ([int]$listenerPids[0])
    if (
      $null -eq $identity -or
      [int]$state.pid -ne [int]$identity.pid -or
      [long]$state.creationTicks -ne [long]$identity.creationTicks
    ) {
      Stop-KikiMcp 'the workspace KAP listener does not match the recorded process owner'
    }
    Assert-DedicatedInstance $state $identity $Binding
  } else {
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
      $stale = Read-JsonFile $statePath 'workspace runtime state'
      Assert-RuntimeState $stale $Binding $Install $Secret
      $staleIdentity = Get-ProcessIdentity ([int]$stale.pid)
      if (
        $null -ne $staleIdentity -and
        [long]$stale.creationTicks -eq [long]$staleIdentity.creationTicks
      ) {
        Stop-KikiMcp 'the recorded workspace KAP owner is alive but is not listening'
      }
      Remove-Item -LiteralPath $statePath -Force
    }
    $started = Start-WorkspaceKap $Binding $Install $Secret $statePath
    $metaProbe = Invoke-KapJson 'GET' "$($Binding.endpoint)/api/v1/meta" `
      ((Get-Content -LiteralPath (Join-Path ([string]$Binding.homeDir) 'server.token') -Raw).Trim()) '' $null
    if (
      $metaProbe.code -ne 0 -or
      $metaProbe.data.backend -cne 'v2' -or
      $metaProbe.data.experimental_flags.external_delegation_mcp -ne $true
    ) {
      Stop-Process -Id $started.process.Id -Force -ErrorAction SilentlyContinue
      Stop-KikiMcp 'the new listener is not an external-delegation KAP'
    }
    $state = [pscustomobject][ordered]@{
      schemaVersion = 1
      pid = [int]$started.identity.pid
      executablePath = [string]$started.identity.executablePath
      creationTicks = [long]$started.identity.creationTicks
      endpoint = [string]$Binding.endpoint
      port = [int]$Binding.port
      homeDir = [string]$Binding.homeDir
      sessionId = [string]$Binding.sessionId
      workspacePath = [string]$Binding.workspacePath
      configPath = [string]$Binding.configPath
      agentProfileHomeDir = [string]$Binding.agentProfileHomeDir
      configReadOnly = $true
      serverId = [string]$metaProbe.data.server_id
      instanceId = [string]$started.instance.server_id
      startedAt = [string]$metaProbe.data.started_at
      stateMac = ''
    }
    $state.stateMac = Get-HmacBase64 $Secret (Get-StatePayload $state)
    Write-JsonFile $statePath $state
    Assert-RuntimeState $state $Binding $Install $Secret
    Assert-DedicatedInstance $state $started.identity $Binding
  }
  return [pscustomobject]@{ state = $state; started = $started }
}

function Read-KapServerToken {
  param([object]$Binding)
  $tokenPath = Join-Path ([string]$Binding.homeDir) 'server.token'
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { return '' }
  return ((Get-Content -LiteralPath $tokenPath -Raw).Trim())
}

function Invoke-KapShutdownEndpoint {
  param([string]$Endpoint, [string]$Token)
  if ([string]::IsNullOrWhiteSpace($Token)) { return $false }
  try {
    $response = Invoke-RestMethod -Uri "$Endpoint/api/v1/shutdown" -Method Post `
      -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
    return ($null -ne $response -and [int]$response.code -eq 0)
  } catch {
    return $false
  }
}

function Wait-WorkspacePortReleased {
  param([int]$Port, [int]$TimeoutSeconds)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    Start-Sleep -Milliseconds 200
    if (@(Get-ListenerPids $Port).Count -eq 0) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
  }
}

function Wait-ProcessIdentityExited {
  param([int]$PidValue, [long]$CreationTicks, [int]$TimeoutSeconds)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    Start-Sleep -Milliseconds 200
    $identity = Get-ProcessIdentity $PidValue
    if ($null -eq $identity -or [long]$identity.creationTicks -ne $CreationTicks) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
  }
}

function Stop-RecordedOwnerProcess {
  param([object]$State)
  $identity = Get-ProcessIdentity ([int]$State.pid)
  if ($null -ne $identity -and [long]$identity.creationTicks -eq [long]$State.creationTicks) {
    Stop-Process -Id ([int]$State.pid) -Force -ErrorAction SilentlyContinue
  }
}

function Remove-WorkspaceStateIfStillRecorded {
  param([string]$StatePath, [object]$State)
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return }
  try {
    $current = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ([int]$current.pid -eq [int]$State.pid) {
      Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Stop-KikiMcp 'the workspace runtime state is unreadable during stop cleanup'
  }
}

function Assert-RuntimeStateSignature {
  param([object]$State, [object]$Binding, [string]$Secret)
  Assert-PropertySet $State @(
    'schemaVersion', 'pid', 'executablePath', 'creationTicks', 'endpoint', 'port',
    'homeDir', 'sessionId', 'workspacePath', 'configPath', 'agentProfileHomeDir',
    'configReadOnly', 'serverId', 'instanceId', 'startedAt', 'stateMac'
  ) 'workspace runtime state'
  if (
    [int]$State.schemaVersion -ne 1 -or
    [int]$State.pid -le 0 -or
    [long]$State.creationTicks -le 0
  ) {
    Stop-KikiMcp 'workspace runtime state violates the recorded owner contract'
  }
  $expectedMac = Get-HmacBase64 $Secret (Get-StatePayload $State)
  if (-not (Test-FixedTimeEqual ([string]$State.stateMac) $expectedMac)) {
    Stop-KikiMcp 'workspace runtime state signature does not match'
  }
  if (
    [int]$State.port -ne [int]$Binding.port -or
    -not (Test-SamePath ([string]$State.homeDir) ([string]$Binding.homeDir)) -or
    [string]$State.sessionId -cne [string]$Binding.sessionId
  ) {
    Stop-KikiMcp 'workspace runtime state does not match the workspace binding'
  }
}

function Stop-VerifiedWorkspaceKap {
  param([object]$Binding, [object]$State, [string]$StatePath)
  $port = [int]$Binding.port
  if (@(Get-ListenerPids $port).Count -eq 0) {
    if (-not (Wait-ProcessIdentityExited ([int]$State.pid) ([long]$State.creationTicks) 5)) {
      return 'failed'
    }
    Remove-WorkspaceStateIfStillRecorded $StatePath $State
    return 'already-stopped'
  }
  $graceful = Invoke-KapShutdownEndpoint ([string]$Binding.endpoint) (Read-KapServerToken $Binding)
  $method = 'graceful'
  if (-not (Wait-WorkspacePortReleased $port 10)) {
    Stop-RecordedOwnerProcess $State
    $method = 'force'
    if (-not (Wait-WorkspacePortReleased $port 10)) { return 'failed' }
  }
  if (-not (Wait-ProcessIdentityExited ([int]$State.pid) ([long]$State.creationTicks) 5)) {
    return 'failed'
  }
  Remove-WorkspaceStateIfStillRecorded $StatePath $State
  if ($graceful -and $method -eq 'graceful') { return 'stopped-graceful' }
  return 'stopped-force'
}

function Invoke-WorkspaceKapRecycle {
  param([object]$Binding, [object]$State, [string]$StatePath)
  $key = [string]$Binding.workspaceKey
  $mutex = $null
  try {
    $mutex = New-NamedMutex "KikiMcpWorkspace-$key"
    Enter-NamedMutex $mutex 10 'the workspace KAP recycle lock'
  } catch {
    if ($null -ne $mutex) { $mutex.Dispose() }
    [Console]::Error.WriteLine(
      'kiki-mcp: skipped workspace KAP recycle because another launcher holds the workspace lock'
    )
    return
  }
  try {
    $status = Stop-VerifiedWorkspaceKap $Binding $State $StatePath
    if ($status -eq 'failed') {
      [Console]::Error.WriteLine(
        "kiki-mcp: the workspace KAP could not be reclaimed; stop it with -StopWorkspace $key"
      )
    }
  } catch {
    [Console]::Error.WriteLine("kiki-mcp: workspace KAP recycle failed: $($_.Exception.Message)")
  } finally {
    Exit-NamedMutex $mutex
  }
}

function Stop-WorkspaceKapByRecord {
  param([string]$WorkspaceKey, [object]$Install)
  $result = [pscustomobject][ordered]@{
    key = $WorkspaceKey
    workspacePath = $null
    port = $null
    status = 'error'
    detail = ''
  }
  try {
    if ($WorkspaceKey -notmatch '^[0-9a-f]{64}$') {
      $result.status = 'invalid-key'
      $result.detail = 'the workspace key must be a 64-character lowercase hex string'
      return $result
    }
    $bindingDir = Join-Path ([string]$Install.workspacesDir) $WorkspaceKey
    $bindingPath = Join-Path $bindingDir 'binding.json'
    if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
      $result.status = 'missing'
      $result.detail = "no workspace binding exists under '$bindingDir'"
      return $result
    }
    $binding = Read-JsonFile $bindingPath 'workspace binding'
    $result.workspacePath = [string]$binding.workspacePath
    $result.port = [int]$binding.port
    $secret = Read-DpapiSecret (Join-Path $bindingDir 'delegation-token.dpapi') `
      'workspace delegation credential'
    Assert-WorkspaceBindingSignature $binding $secret
    $statePath = Join-Path $bindingDir 'runtime-state.json'
    $listenerPids = @(Get-ListenerPids ([int]$binding.port))
    if ($listenerPids.Count -gt 1) {
      $result.status = 'refused-multiple-listeners'
      $result.detail = "port $([int]$binding.port) is owned by " +
        "$(Get-PortOccupantDescription ([int]$binding.port))"
      return $result
    }
    if ($listenerPids.Count -eq 1) {
      if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        $result.status = 'refused-unrecorded-listener'
        $result.detail = "port $([int]$binding.port) is occupied by " +
          "$(Get-PortOccupantDescription ([int]$binding.port)), which has no signed runtime state; " +
          'unrecorded processes are never stopped'
        return $result
      }
      $state = Read-JsonFile $statePath 'workspace runtime state'
      Assert-RuntimeStateSignature $state $binding $secret
      $identity = Get-ProcessIdentity ([int]$listenerPids[0])
      if (
        $null -eq $identity -or
        [int]$state.pid -ne [int]$identity.pid -or
        [long]$state.creationTicks -ne [long]$identity.creationTicks
      ) {
        $result.status = 'refused-listener-mismatch'
        $result.detail = 'the port listener does not match the signed runtime state owner'
        return $result
      }
      $result.status = Stop-VerifiedWorkspaceKap $binding $state $statePath
      return $result
    }
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
      $state = Read-JsonFile $statePath 'workspace runtime state'
      Assert-RuntimeStateSignature $state $binding $secret
      $identity = Get-ProcessIdentity ([int]$state.pid)
      if ($null -ne $identity -and [long]$state.creationTicks -eq [long]$identity.creationTicks) {
        Stop-RecordedOwnerProcess $state
        if (-not (Wait-ProcessIdentityExited ([int]$state.pid) ([long]$state.creationTicks) 10)) {
          $result.status = 'failed'
          $result.detail = "the recorded owner pid $([int]$state.pid) did not exit"
          return $result
        }
        Remove-WorkspaceStateIfStillRecorded $statePath $state
        $result.status = 'stopped-force'
        return $result
      }
      Remove-WorkspaceStateIfStillRecorded $statePath $state
    }
    $result.status = 'already-stopped'
    return $result
  } catch {
    $result.status = 'refused-invalid-records'
    $result.detail = [string]$_.Exception.Message
    return $result
  }
}

function Get-KikiWorkspaceListing {
  param([object]$Install)
  $records = @()
  foreach ($dir in @(
    Get-ChildItem -LiteralPath ([string]$Install.workspacesDir) -Directory -ErrorAction SilentlyContinue
  )) {
    $record = [pscustomobject][ordered]@{
      key = $dir.Name
      workspacePath = $null
      port = $null
      endpoint = $null
      recordedPid = $null
      processAlive = $false
      listening = $false
      status = 'ok'
    }
    try {
      $bindingPath = Join-Path $dir.FullName 'binding.json'
      if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
        $record.status = 'no-binding'
        $records += $record
        continue
      }
      $binding = Read-JsonFile $bindingPath 'workspace binding'
      $record.workspacePath = [string]$binding.workspacePath
      $record.port = [int]$binding.port
      $record.endpoint = [string]$binding.endpoint
      $statePath = Join-Path $dir.FullName 'runtime-state.json'
      if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $state = Read-JsonFile $statePath 'workspace runtime state'
        $record.recordedPid = [int]$state.pid
        $identity = Get-ProcessIdentity ([int]$state.pid)
        $record.processAlive = (
          $null -ne $identity -and
          [long]$identity.creationTicks -eq [long]$state.creationTicks
        )
      }
      $record.listening = (@(Get-ListenerPids ([int]$binding.port)).Count -gt 0)
    } catch {
      $record.status = 'invalid-records'
    }
    $records += $record
  }
  return $records
}

function Test-WorkspaceBindingSignature {
  param([object]$Binding, [string]$Secret)
  $expectedMac = Get-HmacBase64 $Secret (Get-BindingPayload $Binding)
  return Test-FixedTimeEqual ([string]$Binding.bindingMac) $expectedMac
}

function Get-KikiBindingListing {
  param([object]$Installation)
  $records = @()
  foreach ($dir in @(
    Get-ChildItem -LiteralPath ([string]$Installation.meta.workspacesDir) `
      -Directory -ErrorAction SilentlyContinue
  )) {
    $record = [pscustomobject][ordered]@{
      key = $dir.Name
      workspacePath = $null
      sessionId = $null
      model = $null
      thinkingEffort = $null
      signatureValid = $false
      status = 'ok'
    }
    try {
      $bindingPath = Join-Path $dir.FullName 'binding.json'
      if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
        $record.status = 'no-binding'
        $records += $record
        continue
      }
      $binding = Read-JsonFile $bindingPath 'workspace binding'
      Assert-PropertySet $binding @(
        'schemaVersion', 'workspaceKey', 'workspacePath', 'sessionId', 'sessionTitle',
        'principalId', 'port', 'endpoint', 'homeDir', 'delegationSecretPath',
        'configPath', 'agentProfileHomeDir', 'configReadOnly', 'model',
        'thinkingEffort', 'delegationId', 'createdAt', 'bindingMac'
      ) 'workspace binding'
      $secret = Read-DpapiSecret (Join-Path $dir.FullName 'delegation-token.dpapi') `
        'workspace delegation credential'
      $record.workspacePath = [string]$binding.workspacePath
      $record.sessionId = [string]$binding.sessionId
      $record.model = [string]$binding.model
      $record.thinkingEffort = [string]$binding.thinkingEffort
      $record.signatureValid = Test-WorkspaceBindingSignature $binding $secret
      if (-not $record.signatureValid) { $record.status = 'signature-mismatch' }
    } catch {
      $record.status = 'invalid-records'
    }
    $records += $record
  }
  return [pscustomobject][ordered]@{
    runtime = [pscustomobject][ordered]@{
      defaultModel = [string]$Installation.meta.defaultModel
      defaultThinkingEffort = [string]$Installation.meta.defaultThinkingEffort
      signatureValid = [bool]$Installation.signatureValid
    }
    bindings = @($records)
  }
}

function Test-WorkspaceBindingActive {
  param([object]$Binding, [string]$BindingDir)
  if (@(Get-ListenerPids ([int]$Binding.port)).Count -gt 0) { return $true }
  $statePath = Join-Path $BindingDir 'runtime-state.json'
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
  try {
    $state = Read-JsonFile $statePath 'workspace runtime state'
    $identity = Get-ProcessIdentity ([int]$state.pid)
    return (
      $null -ne $identity -and
      [long]$identity.creationTicks -eq [long]$state.creationTicks
    )
  } catch {
    return $true
  }
}

function Invoke-KikiBindingResign {
  param(
    [string]$RuntimeDir,
    [string]$WorkspaceKey,
    [switch]$AllBindings,
    [string]$NewModel,
    [string]$NewThinkingEffort
  )
  if (
    [string]::IsNullOrWhiteSpace($NewModel) -and
    [string]::IsNullOrWhiteSpace($NewThinkingEffort)
  ) {
    Stop-KikiMcp 're-sign requires -Model and/or -ThinkingEffort'
  }
  if (-not [string]::IsNullOrWhiteSpace($WorkspaceKey) -and $WorkspaceKey -notmatch '^[0-9a-f]{64}$') {
    Stop-KikiMcp 'the workspace key must be a 64-character lowercase hex string'
  }

  $installation = Read-InstallationMetadataCandidate $RuntimeDir
  $install = $installation.meta
  $runtimeSignatureBefore = [bool]$installation.signatureValid
  if (-not [string]::IsNullOrWhiteSpace($NewModel)) {
    $install.defaultModel = $NewModel.Trim()
  }
  if (-not [string]::IsNullOrWhiteSpace($NewThinkingEffort)) {
    $install.defaultThinkingEffort = $NewThinkingEffort.Trim()
  }
  if (
    [string]::IsNullOrWhiteSpace([string]$install.defaultModel) -or
    [string]::IsNullOrWhiteSpace([string]$install.defaultThinkingEffort)
  ) {
    Stop-KikiMcp 're-sign must leave a non-empty model and thinking effort'
  }

  $bindingDirs = if ($AllBindings) {
    @(
      Get-ChildItem -LiteralPath ([string]$install.workspacesDir) `
        -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'binding.json') -PathType Leaf }
    )
  } else {
    $bindingDir = Join-Path ([string]$install.workspacesDir) $WorkspaceKey
    if (-not (Test-Path -LiteralPath (Join-Path $bindingDir 'binding.json') -PathType Leaf)) {
      Stop-KikiMcp "no workspace binding exists under '$bindingDir'"
    }
    @((Get-Item -LiteralPath $bindingDir))
  }

  $candidates = @(
    foreach ($dir in $bindingDirs) {
      $bindingPath = Join-Path $dir.FullName 'binding.json'
      $binding = Read-JsonFile $bindingPath 'workspace binding'
      Assert-PropertySet $binding @(
        'schemaVersion', 'workspaceKey', 'workspacePath', 'sessionId', 'sessionTitle',
        'principalId', 'port', 'endpoint', 'homeDir', 'delegationSecretPath',
        'configPath', 'agentProfileHomeDir', 'configReadOnly', 'model',
        'thinkingEffort', 'delegationId', 'createdAt', 'bindingMac'
      ) 'workspace binding'
      $secret = Read-DpapiSecret (Join-Path $dir.FullName 'delegation-token.dpapi') `
        'workspace delegation credential'
      $signatureBefore = Test-WorkspaceBindingSignature $binding $secret
      if (-not [string]::IsNullOrWhiteSpace($NewModel)) {
        $binding.model = $NewModel.Trim()
      }
      if (-not [string]::IsNullOrWhiteSpace($NewThinkingEffort)) {
        $binding.thinkingEffort = $NewThinkingEffort.Trim()
      }
      $canonicalWorkspace = Get-CanonicalDirectory `
        ([string]$binding.workspacePath) ([string]$install.nodePath) `
        "workspace binding $($dir.Name) path"
      $canonicalKey = Get-WorkspaceKey $canonicalWorkspace
      if ($dir.Name -cne $canonicalKey) {
        Stop-KikiMcp (
          "workspace binding $($dir.Name) has non-model drift that cannot be re-signed: " +
          "workspaceKey: expected '$canonicalKey' (actual '$($dir.Name)')"
        )
      }
      $expectedHome = [IO.Path]::GetFullPath((Join-Path $dir.FullName 'kap-home'))
      $expectedSecret = [IO.Path]::GetFullPath((Join-Path $dir.FullName 'delegation-token.dpapi'))
      $drift = @(Get-WorkspaceBindingDrift `
        $binding $expectedHome $expectedSecret $canonicalWorkspace $dir.Name $install)
      if ($drift.Count -gt 0) {
        Stop-KikiMcp (
          "workspace binding $($dir.Name) has non-model drift that cannot be re-signed: " +
          (Format-BindingDrift $drift)
        )
      }
      [pscustomobject]@{
        key = $dir.Name
        bindingDir = $dir.FullName
        bindingPath = $bindingPath
        binding = $binding
        secret = $secret
        signatureBefore = $signatureBefore
      }
    }
  )

  foreach ($candidate in @($candidates | Sort-Object key)) {
    $workspaceMutex = New-NamedMutex "KikiMcpWorkspace-$($candidate.key)"
    Enter-NamedMutex $workspaceMutex 90 'the workspace KAP re-sign lock'
    try {
      if (Test-WorkspaceBindingActive $candidate.binding $candidate.bindingDir) {
        if (-not $candidate.signatureBefore) {
          Stop-KikiMcp (
            "workspace $($candidate.key) is active but its binding signature is invalid; " +
            'stop the recorded process before re-signing'
          )
        }
        $stopResult = Stop-WorkspaceKapByRecord $candidate.key $install
        if ($stopResult.status -notin @('stopped-graceful', 'stopped-force', 'already-stopped')) {
          Stop-KikiMcp (
            "workspace $($candidate.key) could not be stopped before re-signing: " +
            "$($stopResult.status) $($stopResult.detail)"
          )
        }
      }
      $candidate.binding.bindingMac = Get-HmacBase64 `
        $candidate.secret (Get-BindingPayload $candidate.binding)
      Write-JsonFileAtomic $candidate.bindingPath $candidate.binding
    } finally {
      Exit-NamedMutex $workspaceMutex
    }
  }
  $install.installationMac = Get-HmacBase64 `
    $installation.installationKey (Get-InstallationPayload $install)
  Write-JsonFileAtomic $installation.metadataPath $install

  $verified = Read-InstallationMetadata $RuntimeDir
  $results = @(
    foreach ($candidate in $candidates) {
      Assert-WorkspaceBinding `
        $candidate.binding $candidate.bindingDir ([string]$candidate.binding.workspacePath) `
        $candidate.key $verified.meta $candidate.secret
      [pscustomobject][ordered]@{
        key = $candidate.key
        workspacePath = [string]$candidate.binding.workspacePath
        model = [string]$candidate.binding.model
        thinkingEffort = [string]$candidate.binding.thinkingEffort
        signatureBefore = [bool]$candidate.signatureBefore
        signatureValid = $true
      }
    }
  )
  return [pscustomobject][ordered]@{
    runtime = [pscustomobject][ordered]@{
      defaultModel = [string]$verified.meta.defaultModel
      defaultThinkingEffort = [string]$verified.meta.defaultThinkingEffort
      signatureBefore = $runtimeSignatureBefore
      signatureValid = $true
    }
    bindings = @($results)
  }
}

function Assert-WorkspaceAuthority {
  param(
    [object]$BindingRecord,
    [object]$Install,
    [string]$Workspace,
    [string]$WorkspaceKey,
    [object]$Runtime
  )
  $binding = $BindingRecord.binding
  $kapToken = (Get-Content -LiteralPath (Join-Path ([string]$binding.homeDir) 'server.token') -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($kapToken)) {
    Stop-KikiMcp 'the workspace KAP bearer credential is empty'
  }
  $meta = Invoke-KapJson 'GET' "$($binding.endpoint)/api/v1/meta" $kapToken '' $null
  if (
    $meta.code -ne 0 -or
    $meta.data.backend -cne 'v2' -or
    $meta.data.experimental_flags.external_delegation_mcp -ne $true -or
    [string]$meta.data.server_id -cne [string]$Runtime.state.serverId
  ) {
    Stop-KikiMcp 'the workspace KAP identity probe does not match the recorded owner'
  }
  $session = Invoke-KapJson 'GET' `
    "$($binding.endpoint)/api/v1/sessions/$([Uri]::EscapeDataString([string]$binding.sessionId))" `
    $kapToken '' $null
  if (
    $session.code -ne 0 -or
    $null -eq $session.data -or
    [string]::IsNullOrWhiteSpace([string]$session.data.metadata.cwd)
  ) {
    Stop-KikiMcp 'the workspace KAP Session is unavailable'
  }
  $sessionWorkspace = Get-CanonicalDirectory `
    ([string]$session.data.metadata.cwd) ([string]$Install.nodePath) 'the delegated Session workspace'
  if (-not (Test-SamePath $sessionWorkspace $Workspace)) {
    Stop-KikiMcp 'the delegated Session is rooted in another workspace'
  }
  $status = Invoke-KapJson 'GET' `
    "$($binding.endpoint)/api/v1/sessions/$([Uri]::EscapeDataString([string]$binding.sessionId))/status" `
    $kapToken '' $null
  if (
    $status.code -ne 0 -or
    [string]$status.data.model -cne [string]$binding.model -or
    [string]$status.data.thinking_level -cne [string]$binding.thinkingEffort
  ) {
    Stop-KikiMcp 'the delegated Session main binding does not match'
  }
  $list = Invoke-KapJson 'POST' `
    "$($binding.endpoint)/api/v2/sessions/$([Uri]::EscapeDataString([string]$binding.sessionId))/external-delegation/list" `
    $kapToken $BindingRecord.secret @{}
  $observedDelegationId = [string]$list.data.delegationId
  if ($list.code -ne 0 -or [string]::IsNullOrWhiteSpace($observedDelegationId)) {
    Stop-KikiMcp 'the delegated Session has no usable external authority'
  }
  if ([string]::IsNullOrWhiteSpace([string]$binding.delegationId)) {
    $binding.delegationId = $observedDelegationId
    $binding.bindingMac = Get-HmacBase64 $BindingRecord.secret (Get-BindingPayload $binding)
    Write-JsonFile $BindingRecord.bindingPath $binding
    Assert-WorkspaceBinding $binding $BindingRecord.bindingDir $Workspace $WorkspaceKey $Install $BindingRecord.secret
  } elseif ([string]$binding.delegationId -cne $observedDelegationId) {
    Stop-KikiMcp 'the delegated Session authority root does not match the workspace binding'
  }
  return [pscustomobject]@{
    endpoint = [string]$binding.endpoint
    delegationToken = $BindingRecord.secret
    sessionId = [string]$binding.sessionId
    workspacePath = $Workspace
  }
}

function Initialize-KikiWorkspaceConnection {
  param([string]$RuntimeDir)
  $installation = Read-InstallationMetadata $RuntimeDir
  $install = $installation.meta
  $workspace = Get-CanonicalDirectory `
    ([string](Get-Location).Path) ([string]$install.nodePath) 'the invoking workspace'
  $workspaceKey = Get-WorkspaceKey $workspace
  $workspaceMutex = New-NamedMutex "KikiMcpWorkspace-$workspaceKey"
  Enter-NamedMutex $workspaceMutex 90 'the workspace KAP initialization lock'
  try {
    $bindingRecord = Get-OrCreateWorkspaceBinding $workspace $workspaceKey $install
    $runtime = Resolve-WorkspaceKap `
      $bindingRecord.binding $install $bindingRecord.secret $bindingRecord.bindingDir
    $connection = Assert-WorkspaceAuthority $bindingRecord $install $workspace $workspaceKey $runtime
    return [pscustomobject]@{
      install = $install
      bindingRecord = $bindingRecord
      runtime = $runtime
      connection = $connection
    }
  } finally {
    Exit-NamedMutex $workspaceMutex
  }
}

function Invoke-KikiMcpLauncher {
  param([string]$RuntimeDir)
  $initialized = Initialize-KikiWorkspaceConnection $RuntimeDir
  $install = $initialized.install
  $connection = $initialized.connection
  [Environment]::SetEnvironmentVariable('KIKI_KAP_ENDPOINT', [string]$connection.endpoint, 'Process')
  [Environment]::SetEnvironmentVariable('KIKI_KAP_TOKEN', $null, 'Process')
  [Environment]::SetEnvironmentVariable(
    'KIKI_DELEGATION_TOKEN',
    [string]$connection.delegationToken,
    'Process'
  )
  [Environment]::SetEnvironmentVariable('KIKI_SESSION_ID', [string]$connection.sessionId, 'Process')
  [Environment]::SetEnvironmentVariable(
    'KIKI_WORKSPACE_PATH',
    [string]$connection.workspacePath,
    'Process'
  )
  $exitCode = 1
  try {
    & ([string]$install.nodePath) ([string]$install.mcpPath)
    $exitCode = $LASTEXITCODE
  } finally {
    if ($null -ne $initialized.runtime -and $null -ne $initialized.runtime.started) {
      Invoke-WorkspaceKapRecycle `
        $initialized.bindingRecord.binding `
        $initialized.runtime.state `
        (Join-Path $initialized.bindingRecord.bindingDir 'runtime-state.json')
    }
  }
  return $exitCode
}

function Get-KikiMcpUsageText {
  return @(
    'usage: kiki-mcp.ps1 -RuntimeDir <dir>                         run the Codex MCP launcher (default MCP stdio mode)',
    '       kiki-mcp.ps1 -RuntimeDir <dir> -ListWorkspaces        list recorded workspace process state as JSON',
    '       kiki-mcp.ps1 -RuntimeDir <dir> -ListBindings          list signed model bindings and signature state as JSON',
    '       kiki-mcp.ps1 -RuntimeDir <dir> -StopWorkspace <key>   stop one workspace KAP',
    '       kiki-mcp.ps1 -RuntimeDir <dir> -StopAllKap             stop every recorded workspace KAP',
    '       kiki-mcp.ps1 -RuntimeDir <dir> -ResignBinding <key> (-Model <alias> | -ThinkingEffort <value>)',
    '       kiki-mcp.ps1 -RuntimeDir <dir> -ResignAllBindings (-Model <alias> | -ThinkingEffort <value>)'
  ) -join [Environment]::NewLine
}

function Invoke-KikiMcpCli {
  param(
    [string]$CliRuntimeDir,
    [switch]$CliListWorkspaces,
    [switch]$CliListBindings,
    [string]$CliStopWorkspace,
    [switch]$CliStopAllKap,
    [string]$CliResignBinding,
    [switch]$CliResignAllBindings,
    [string]$CliModel,
    [string]$CliThinkingEffort
  )
  $modeCount = @(
    $CliListWorkspaces.IsPresent,
    $CliListBindings.IsPresent,
    -not [string]::IsNullOrWhiteSpace($CliStopWorkspace),
    $CliStopAllKap.IsPresent,
    -not [string]::IsNullOrWhiteSpace($CliResignBinding),
    $CliResignAllBindings.IsPresent
  ) | Where-Object { $_ }
  if (@($modeCount).Count -gt 1) {
    [Console]::Error.WriteLine("kiki-mcp: choose one management mode.$([Environment]::NewLine)$(Get-KikiMcpUsageText)")
    return 2
  }
  if ([string]::IsNullOrWhiteSpace($CliRuntimeDir)) {
    [Console]::Error.WriteLine("kiki-mcp: -RuntimeDir is required.$([Environment]::NewLine)$(Get-KikiMcpUsageText)")
    return 2
  }
  $resignMode = (
    -not [string]::IsNullOrWhiteSpace($CliResignBinding) -or
    $CliResignAllBindings.IsPresent
  )
  if (
    -not $resignMode -and
    (
      -not [string]::IsNullOrWhiteSpace($CliModel) -or
      -not [string]::IsNullOrWhiteSpace($CliThinkingEffort)
    )
  ) {
    [Console]::Error.WriteLine("kiki-mcp: -Model and -ThinkingEffort require a re-sign mode.$([Environment]::NewLine)$(Get-KikiMcpUsageText)")
    return 2
  }
  try {
    if ($CliListBindings) {
      $listing = Get-KikiBindingListing (Read-InstallationMetadataCandidate $CliRuntimeDir)
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $listing -Depth 6))
      return 0
    }
    if ($resignMode) {
      $result = Invoke-KikiBindingResign `
        $CliRuntimeDir $CliResignBinding `
        -AllBindings:$CliResignAllBindings.IsPresent `
        -NewModel $CliModel -NewThinkingEffort $CliThinkingEffort
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 6))
      return 0
    }
    if ($CliListWorkspaces) {
      $install = (Read-InstallationMetadata $CliRuntimeDir).meta
      $listing = @(Get-KikiWorkspaceListing $install)
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $listing -Depth 6))
      return 0
    }
    if ($CliStopAllKap) {
      $install = (Read-InstallationMetadata $CliRuntimeDir).meta
      $results = @(
        foreach ($dir in @(
          Get-ChildItem -LiteralPath ([string]$install.workspacesDir) -Directory -ErrorAction SilentlyContinue
        )) {
          if (-not (Test-Path -LiteralPath (Join-Path $dir.FullName 'binding.json') -PathType Leaf)) {
            continue
          }
          Stop-WorkspaceKapByRecord $dir.Name $install
        }
      )
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($results) -Depth 6))
      $failed = @($results | Where-Object {
        $_.status -notin @('stopped-graceful', 'stopped-force', 'already-stopped', 'missing')
      })
      if ($failed.Count -gt 0) { return 1 }
      return 0
    }
    if (-not [string]::IsNullOrWhiteSpace($CliStopWorkspace)) {
      $install = (Read-InstallationMetadata $CliRuntimeDir).meta
      $result = Stop-WorkspaceKapByRecord $CliStopWorkspace $install
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 6))
      if ($result.status -in @('stopped-graceful', 'stopped-force', 'already-stopped')) { return 0 }
      return 1
    }
    return Invoke-KikiMcpLauncher $CliRuntimeDir
  } catch {
    [Console]::Error.WriteLine("kiki-mcp: $($_.Exception.Message)")
    return 1
  }
}

# Main entry: skipped when the script is dot-sourced (`. kiki-mcp.ps1`), so the
# function library can be imported by tooling and tests without side effects.
if ($MyInvocation.InvocationName -ne '.') {
  exit (Invoke-KikiMcpCli `
    -CliRuntimeDir $RuntimeDir `
    -CliListWorkspaces:$ListWorkspaces.IsPresent `
    -CliListBindings:$ListBindings.IsPresent `
    -CliStopWorkspace $StopWorkspace `
    -CliStopAllKap:$StopAllKap.IsPresent `
    -CliResignBinding $ResignBinding `
    -CliResignAllBindings:$ResignAllBindings.IsPresent `
    -CliModel $Model `
    -CliThinkingEffort $ThinkingEffort)
}
