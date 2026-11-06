[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$controller = Join-Path $PSScriptRoot 'desktop-release.ps1'
$hotSwitch = Join-Path $PSScriptRoot 'desktop-hot-switch.ps1'
$powerShell = Join-Path $PSHOME 'powershell.exe'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$tempBase = Join-Path $repoRoot '.tmp\desktop-hot-switch-tests'
[IO.Directory]::CreateDirectory($tempBase) | Out-Null
$testRoot = Join-Path $tempBase ([guid]::NewGuid().ToString('N'))
$runtimeRoot = Join-Path $testRoot 'Kiki'
$homePath = Join-Path $testRoot 'home'
$oldCandidate = Join-Path $testRoot 'candidate-old'
$goodCandidate = Join-Path $testRoot 'candidate-good'
$failedCandidate = Join-Path $testRoot 'candidate-failed'
$fixtureSourcePath = Join-Path $testRoot 'desktop-hot-switch-fixture.cs'
$cscPath = $null
$oldCommit = -join (1..40 | ForEach-Object { '1' })
$goodCommit = -join (1..40 | ForEach-Object { '2' })
$failedCommit = -join (1..40 | ForEach-Object { '3' })
$fixtureToken = -join (1..43 | ForEach-Object { 'A' })
$serverHomeId = '22222222-2222-4222-8222-222222222222'
$runningSessionId = 'session-running'
$priorPausedSessionId = 'session-prior-paused'
$priorPauseId = 'prior-paused-operation'
$taskId = 'fixture-task-running'
$terminalReceiptId = 'terminal-receipt-running'
$notificationId = 'task-notification-running'
$originalKikiHome = $env:KIKI_HOME
$completed = $false

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "$Message`nExpected: $Expected`nActual:   $Actual"
    }
}

function Assert-NotEqual($Expected, $Actual, [string]$Message) {
    if ($Expected -eq $Actual) {
        throw "$Message`nBoth values: $Actual"
    }
}

function Assert-Contains([string]$Needle, [string]$Haystack, [string]$Message) {
    if (!$Haystack.Contains($Needle)) { throw $Message }
}

function Invoke-Script(
    [string]$Path,
    [object[]]$Arguments,
    [int]$ExpectedExitCode = 0
) {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $powerShell -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne $ExpectedExitCode) {
        throw "$([IO.Path]::GetFileName($Path)) exited with $exitCode instead of $ExpectedExitCode.`n$output"
    }
    return $output
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-ReleaseId([string]$MainPath, [string]$SidecarPath) {
    $mainHash = Get-Sha256 $MainPath
    $sidecarHash = Get-Sha256 $SidecarPath
    return '{0}-{1}' -f $mainHash.Substring(0, 24), $sidecarHash.Substring(0, 24)
}

function Write-Receipt([string]$Candidate, [string]$Commit) {
    $desktopPath = Join-Path $Candidate 'kiki-desktop.exe'
    $serverPath = Join-Path $Candidate 'kiki-server.exe'
    $desktop = Get-Item -LiteralPath $desktopPath
    $server = Get-Item -LiteralPath $serverPath
    $json = @"
{
  "schemaVersion": 1,
  "sourceCommit": "$Commit",
  "acceptanceRef": "fixture://desktop-hot-switch",
  "checkRef": "fixture://desktop-hot-switch.test.ps1",
  "files": {
    "kiki-desktop.exe": { "sha256": "$(Get-Sha256 $desktopPath)", "bytes": $($desktop.Length) },
    "kiki-server.exe": { "sha256": "$(Get-Sha256 $serverPath)", "bytes": $($server.Length) }
  }
}
"@
    [IO.File]::WriteAllText((Join-Path $Candidate 'desktop-build-receipt.json'), $json.Trim() + "`n", (New-Object Text.UTF8Encoding($false)))
}

function Resolve-Csc {
    $command = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($null -ne $command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        return $command.Source
    }
    $windowsRoot = if ([string]::IsNullOrWhiteSpace($env:WINDIR)) { 'C:\Windows' } else { $env:WINDIR }
    foreach ($path in @(
        (Join-Path $windowsRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $windowsRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    throw 'The desktop hot-switch fixture requires the Windows csc.exe compiler.'
}

$fixtureSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private const string BuildId = "__BUILD_ID__";
    private const int FailLaunch = __FAIL_LAUNCH__;
    private const string ServerHomeId = "22222222-2222-4222-8222-222222222222";
    private const string RunningSessionId = "session-running";
    private const string PriorPausedSessionId = "session-prior-paused";
    private const string PriorPauseId = "prior-paused-operation";
    private const string TaskId = "fixture-task-running";
    private const string TerminalReceiptId = "terminal-receipt-running";
    private const string NotificationId = "task-notification-running";
    private static readonly object Gate = new object();
    private static readonly Dictionary<string, SessionState> Sessions = new Dictionary<string, SessionState>(StringComparer.Ordinal);
    private static string home;
    private static string serverId;
    private static string instancePath;
    private static string statePath;
    private static string eventsPath;
    private static string token;
    private static string startedIso;
    private static long startedAt;
    private static HttpListener listener;
    private static bool stopping;
    private static bool recoverableOnlyLogged;

    private sealed class SessionState
    {
        internal string Phase;
        internal string PauseOperationId;
        internal string TaskId;
        internal string TerminalReceiptId;
        internal string NotificationId;
        internal int TaskRunCount;
        internal int NotificationDeliveryCount;
    }

    [STAThread]
    private static void Main()
    {
        string executableName = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName).ToLowerInvariant();
        if (executableName == "kiki-desktop")
        {
            RunLauncher();
            return;
        }
        if (executableName == "kiki-server")
        {
            RunServer();
            Environment.Exit(0);
            return;
        }
        throw new InvalidOperationException("The fixture must run as kiki-desktop.exe or kiki-server.exe.");
    }

    private static void RunLauncher()
    {
        if (FailLaunch != 0)
        {
            Environment.Exit(FailLaunch);
            return;
        }
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        string directory = Path.GetDirectoryName(executable);
        string server = Path.Combine(directory, "kiki-server.exe");
        string preferences = Path.Combine(Environment.GetEnvironmentVariable("KIKI_HOME"), "desktop.json");
        using (Form window = new Form { Text = "Kiki hot switch fixture", Width = 300, Height = 120 })
        {
            window.FormClosing += delegate(object sender, FormClosingEventArgs args)
            {
                args.Cancel = !File.Exists(preferences) || !Regex.IsMatch(File.ReadAllText(preferences), "\"closeToTray\"\\s*:\\s*false");
            };
            window.Shown += delegate
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = server,
                    Arguments = "serve",
                    WorkingDirectory = directory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            };
            Application.Run(window);
        }
    }

    private static void RunServer()
    {
        home = Environment.GetEnvironmentVariable("KIKI_HOME");
        if (String.IsNullOrWhiteSpace(home)) throw new InvalidOperationException("KIKI_HOME is missing.");
        token = File.ReadAllText(Path.Combine(home, "server.local-owner")).Trim();
        if (!Regex.IsMatch(token, "^[A-Za-z0-9_-]{43}$")) throw new InvalidOperationException("The fixture token is invalid.");
        Directory.CreateDirectory(Path.Combine(home, "server", "instances"));
        statePath = Path.Combine(home, "fixture-session-state.json");
        eventsPath = Path.Combine(home, "fixture-events.log");
        LoadSessions();
        serverId = "fixture-" + Guid.NewGuid().ToString("N");
        startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        startedIso = DateTimeOffset.UtcNow.ToString("o");
        int port = AllocatePort();
        listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
        listener.Start();
        instancePath = Path.Combine(home, "server", "instances", serverId + ".json");
        WriteInstance(port);
        try
        {
            while (true)
            {
                HttpListenerContext context;
                try
                {
                    context = listener.GetContext();
                }
                catch
                {
                    break;
                }
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try { Handle(context); } catch { }
                });
            }
        }
        finally
        {
            RemoveInstance();
        }
    }

    private static int AllocatePort()
    {
        TcpListener probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        int port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private static void WriteInstance(int port)
    {
        string body = "{\"server_id\":" + Json(serverId) + ",\"pid\":" + Process.GetCurrentProcess().Id +
            ",\"host\":\"127.0.0.1\",\"port\":" + port + ",\"started_at\":" + startedAt +
            ",\"heartbeat_at\":" + startedAt + ",\"build_id\":" + Json(BuildId) + "}";
        File.WriteAllText(instancePath, body, new UTF8Encoding(false));
    }

    private static void RemoveInstance()
    {
        try
        {
            if (!String.IsNullOrWhiteSpace(instancePath) && File.Exists(instancePath)) File.Delete(instancePath);
        }
        catch
        {
        }
    }

    private static void Handle(HttpListenerContext context)
    {
        try
        {
            if (!String.Equals(context.Request.Headers["Authorization"], "Bearer " + token, StringComparison.Ordinal))
            {
                Send(context, 401, Envelope(40101, "Fixture authentication failed", "null"));
                return;
            }
            string path = context.Request.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();
            if (path == "/api/meta" && context.Request.HttpMethod == "GET")
            {
                Send(context, 200, Envelope(0, "ok", Meta()));
                return;
            }
            if (path == "/api/desktop-lifecycle")
            {
                HandleLifecycle(context);
                return;
            }
            if (path == "/api/klient/call" && context.Request.HttpMethod == "POST")
            {
                HandleCall(context, ReadBody(context));
                return;
            }
            Send(context, 404, Envelope(40404, "Fixture route not found", "null"));
        }
        catch (Exception error)
        {
            Send(context, 500, Envelope(50001, error.Message, "null"));
        }
    }

    private static string Meta()
    {
        return "{\"server_id\":" + Json(serverId) + ",\"server_home_id\":" + Json(ServerHomeId) +
            ",\"current_space_id\":\"main\",\"server_version\":\"fixture\",\"started_at\":" + Json(startedIso) +
            ",\"desktop_managed\":true,\"dangerous_bypass_auth\":false,\"backend\":\"fixture\",\"build_id\":" + Json(BuildId) + "}";
    }

    private static void HandleLifecycle(HttpListenerContext context)
    {
        if (context.Request.HttpMethod == "GET")
        {
            Send(context, 200, Envelope(0, "ok", LifecycleState()));
            return;
        }
        if (context.Request.HttpMethod != "POST")
        {
            Send(context, 405, Envelope(40500, "Fixture method not allowed", "null"));
            return;
        }
        string body = ReadBody(context);
        string requestedServerId = JsonValue(body, "server_id");
        if (!String.Equals(requestedServerId, serverId, StringComparison.Ordinal))
        {
            Send(context, 200, Envelope(40001, "Fixture server identity changed", "null"));
            return;
        }
        string action = JsonValue(body, "action");
        if (action == "prepare-update")
        {
            Send(context, 200, Envelope(0, "ok", "{\"ok\":true}"));
            return;
        }
        if (action == "cancel-update")
        {
            Send(context, 200, Envelope(0, "ok", "{\"ok\":true}"));
            return;
        }
        if (action == "update" || action == "restart" || action == "quit")
        {
            Send(context, 200, Envelope(0, "ok", "{\"ok\":true}"));
            ThreadPool.QueueUserWorkItem(delegate
            {
                Thread.Sleep(75);
                StopServer();
            });
            return;
        }
        Send(context, 200, Envelope(40001, "Fixture lifecycle action is invalid", "null"));
    }

    private static string LifecycleState()
    {
        List<string> pending = new List<string>();
        bool recoverableOnly = false;
        lock (Gate)
        {
            foreach (KeyValuePair<string, SessionState> item in Sessions)
            {
                if (item.Value.Phase != "paused") pending.Add(item.Key);
                else if (String.Equals(item.Value.TerminalReceiptId, TerminalReceiptId, StringComparison.Ordinal) && item.Value.NotificationDeliveryCount == 0) recoverableOnly = true;
            }
            if (recoverableOnly && !recoverableOnlyLogged)
            {
                recoverableOnlyLogged = true;
                AppendEvent("lifecycle-recoverable-notification|" + TaskId + "|work_pending=0|task=settled");
            }
        }
        StringBuilder ids = new StringBuilder();
        for (int index = 0; index < pending.Count; index++)
        {
            if (index > 0) ids.Append(',');
            ids.Append(Json(pending[index]));
        }
        return "{\"server_id\":" + Json(serverId) + ",\"home_id\":\"main\",\"managed\":true,\"draining\":false,\"hot_switch_prepared\":false,\"work_pending\":[" + ids + "],\"impact\":\"all-windows-in-this-space\"}";
    }

    private static void HandleCall(HttpListenerContext context, string body)
    {
        string sessionId = JsonValue(body, "sessionId");
        string method = JsonValue(body, "method");
        if (String.IsNullOrWhiteSpace(sessionId) || String.IsNullOrWhiteSpace(method))
        {
            Send(context, 200, Envelope(40001, "Fixture procedure is invalid", "null"));
            return;
        }
        SessionState session;
        lock (Gate)
        {
            if (!Sessions.TryGetValue(sessionId, out session))
            {
                Send(context, 200, Envelope(40404, "Fixture session is missing", "null"));
                return;
            }
            if (method == "pause")
            {
                string operationId = JsonValue(body, "operationId");
                if (sessionId == RunningSessionId && String.IsNullOrWhiteSpace(session.TerminalReceiptId))
                {
                    session.TaskId = TaskId;
                    session.TaskRunCount = session.TaskRunCount == 0 ? 1 : session.TaskRunCount;
                    session.TerminalReceiptId = TerminalReceiptId;
                    session.NotificationId = NotificationId;
                    AppendEvent("task-settled|" + session.TaskId + "|receipt=" + session.TerminalReceiptId + "|notification=" + session.NotificationId + "|task_runs=" + session.TaskRunCount);
                }
                session.Phase = "paused";
                session.PauseOperationId = operationId;
                AppendEvent("pause|" + sessionId + "|" + operationId);
                SaveSessions();
            }
            else if (method == "resume")
            {
                string operationId = JsonValue(body, "operationId");
                string pauseOperationId = JsonValue(body, "pauseOperationId");
                if (session.PauseOperationId != pauseOperationId)
                {
                    Send(context, 200, Envelope(40901, "Fixture pause operation changed", "null"));
                    return;
                }
                if (sessionId == RunningSessionId && String.Equals(session.TerminalReceiptId, TerminalReceiptId, StringComparison.Ordinal) && session.NotificationDeliveryCount == 0)
                {
                    session.NotificationDeliveryCount = 1;
                    AppendEvent("notification-delivery|" + session.TaskId + "|" + session.NotificationId + "|count=" + session.NotificationDeliveryCount);
                }
                session.Phase = "running";
                AppendEvent("resume|" + sessionId + "|" + operationId + "|" + pauseOperationId);
                SaveSessions();
            }
            else if (method == "cancelPause")
            {
                string operationId = JsonValue(body, "operationId");
                string pauseOperationId = JsonValue(body, "pauseOperationId");
                if (session.PauseOperationId != pauseOperationId)
                {
                    Send(context, 200, Envelope(40901, "Fixture pause operation changed", "null"));
                    return;
                }
                session.Phase = "running";
                AppendEvent("cancelPause|" + sessionId + "|" + operationId + "|" + pauseOperationId);
                SaveSessions();
            }
            else if (method != "read")
            {
                Send(context, 200, Envelope(40001, "Fixture execution method is invalid", "null"));
                return;
            }
            Send(context, 200, Envelope(0, "ok", ExecutionState(session)));
        }
    }

    private static string ExecutionState(SessionState session)
    {
        return "{\"phase\":" + Json(session.Phase) + ",\"pauseOperationId\":" + Json(session.PauseOperationId) +
            ",\"taskId\":" + Json(session.TaskId) + ",\"terminalReceiptId\":" + Json(session.TerminalReceiptId) +
            ",\"notificationId\":" + Json(session.NotificationId) + ",\"taskRunCount\":" + session.TaskRunCount +
            ",\"notificationDeliveryCount\":" + session.NotificationDeliveryCount + ",\"agents\":[]}";
    }

    private static string ReadBody(HttpListenerContext context)
    {
        using (StreamReader reader = new StreamReader(context.Request.InputStream, Encoding.UTF8)) return reader.ReadToEnd();
    }

    private static string JsonValue(string body, string property)
    {
        Match match = Regex.Match(body ?? String.Empty, "\\\"" + Regex.Escape(property) + "\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"", RegexOptions.Singleline);
        return match.Success ? match.Groups[1].Value : String.Empty;
    }

    private static string Envelope(int code, string message, string data)
    {
        return "{\"code\":" + code + ",\"msg\":" + Json(message) + ",\"data\":" + data + ",\"request_id\":" + Json(Guid.NewGuid().ToString("N")) + "}";
    }

    private static string Json(string value)
    {
        if (value == null) return "null";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static void Send(HttpListenerContext context, int status, string body)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(body);
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength64 = bytes.Length;
        using (Stream output = context.Response.OutputStream) output.Write(bytes, 0, bytes.Length);
    }

    private static void StopServer()
    {
        lock (Gate)
        {
            if (stopping) return;
            stopping = true;
        }
        RemoveInstance();
        try { listener.Stop(); } catch { }
    }

    private static void LoadSessions()
    {
        lock (Gate)
        {
            Sessions.Clear();
            if (File.Exists(statePath))
            {
                string text = File.ReadAllText(statePath);
                string runningPhase = StateValue(text, RunningSessionId, "phase");
                string runningPause = StateValue(text, RunningSessionId, "pauseOperationId");
                string runningTaskId = StateValue(text, RunningSessionId, "taskId");
                string runningReceipt = StateValue(text, RunningSessionId, "terminalReceiptId");
                string runningNotification = StateValue(text, RunningSessionId, "notificationId");
                string priorPhase = StateValue(text, PriorPausedSessionId, "phase");
                string priorPause = StateValue(text, PriorPausedSessionId, "pauseOperationId");
                if (!String.IsNullOrWhiteSpace(runningPhase)) Sessions[RunningSessionId] = new SessionState {
                    Phase = runningPhase, PauseOperationId = runningPause,
                    TaskId = String.IsNullOrWhiteSpace(runningTaskId) ? TaskId : runningTaskId,
                    TerminalReceiptId = runningReceipt, NotificationId = runningNotification,
                    TaskRunCount = StateNumber(text, RunningSessionId, "taskRunCount"),
                    NotificationDeliveryCount = StateNumber(text, RunningSessionId, "notificationDeliveryCount")
                };
                if (!String.IsNullOrWhiteSpace(priorPhase)) Sessions[PriorPausedSessionId] = new SessionState { Phase = priorPhase, PauseOperationId = priorPause };
            }
            if (!Sessions.ContainsKey(RunningSessionId)) Sessions[RunningSessionId] = new SessionState {
                Phase = "running", PauseOperationId = String.Empty, TaskId = TaskId, TaskRunCount = 1
            };
            if (!Sessions.ContainsKey(PriorPausedSessionId)) Sessions[PriorPausedSessionId] = new SessionState { Phase = "paused", PauseOperationId = PriorPauseId };
            SaveSessions();
        }
    }

    private static string StateValue(string text, string sessionId, string property)
    {
        string pattern = "\\\"" + Regex.Escape(sessionId) + "\\\"\\s*:\\s*\\{[^}]*\\\"" + Regex.Escape(property) + "\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"";
        Match match = Regex.Match(text ?? String.Empty, pattern, RegexOptions.Singleline);
        return match.Success ? match.Groups[1].Value : String.Empty;
    }

    private static int StateNumber(string text, string sessionId, string property)
    {
        string pattern = "\\\"" + Regex.Escape(sessionId) + "\\\"\\s*:\\s*\\{[^}]*\\\"" + Regex.Escape(property) + "\\\"\\s*:\\s*(\\d+)";
        Match match = Regex.Match(text ?? String.Empty, pattern, RegexOptions.Singleline);
        int value;
        return match.Success && Int32.TryParse(match.Groups[1].Value, out value) ? value : 0;
    }

    private static string SessionJson(SessionState session)
    {
        return "{\"phase\":" + Json(session.Phase) + ",\"pauseOperationId\":" + Json(session.PauseOperationId) +
            ",\"taskId\":" + Json(session.TaskId) + ",\"terminalReceiptId\":" + Json(session.TerminalReceiptId) +
            ",\"notificationId\":" + Json(session.NotificationId) + ",\"taskRunCount\":" + session.TaskRunCount +
            ",\"notificationDeliveryCount\":" + session.NotificationDeliveryCount + "}";
    }

    private static void SaveSessions()
    {
        SessionState running = Sessions[RunningSessionId];
        SessionState prior = Sessions[PriorPausedSessionId];
        string body = "{\"sessions\":{" + Json(RunningSessionId) + ":" + SessionJson(running) + "," +
            Json(PriorPausedSessionId) + ":" + SessionJson(prior) + "}}";
        File.WriteAllText(statePath, body, new UTF8Encoding(false));
    }

    private static void AppendEvent(string line)
    {
        File.AppendAllText(eventsPath, line + Environment.NewLine, new UTF8Encoding(false));
    }
}
'@

function Compile-Fixture([string]$BuildId, [bool]$FailLaunch, [string]$OutputPath) {
    $failCode = if ($FailLaunch) { '23' } else { '0' }
    $source = $fixtureSource.Replace('__BUILD_ID__', $BuildId).Replace('__FAIL_LAUNCH__', $failCode)
    [IO.File]::WriteAllText($fixtureSourcePath, $source, (New-Object Text.UTF8Encoding($false)))
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $compilerOutput = (& $cscPath /nologo /target:winexe /reference:System.Windows.Forms.dll /optimize+ /out:$OutputPath $fixtureSourcePath 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0 -or !(Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
        throw "csc failed for fixture build $BuildId with exit code $exitCode.`n$compilerOutput`nSource: $fixtureSourcePath"
    }
}

function New-Candidate([string]$Name, [string]$BuildId, [bool]$FailLaunch) {
    $candidate = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory($candidate) | Out-Null
    $fixtureBinary = Join-Path $testRoot ($Name + '.exe')
    Compile-Fixture $BuildId $FailLaunch $fixtureBinary
    Copy-Item -LiteralPath $fixtureBinary -Destination (Join-Path $candidate 'kiki-desktop.exe')
    Copy-Item -LiteralPath $fixtureBinary -Destination (Join-Path $candidate 'kiki-server.exe')
    Write-Receipt $candidate $BuildId
    return $candidate
}

function Invoke-Fixture([object]$Server, [string]$Path, [object]$Body = $null, [string]$Token = $fixtureToken) {
    $headers = @{ Authorization = 'Bearer ' + $Token }
    $url = 'http://127.0.0.1:{0}/api/{1}' -f $Server.instance.port, $Path
    if ($null -eq $Body) {
        return Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec 5
    }
    return Invoke-RestMethod -Uri $url -Headers $headers -MaximumRedirection 0 -TimeoutSec 10 -Method Post `
        -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 8 -Compress)
}

function Get-ActiveFixtureServer {
    $instances = Join-Path $homePath 'server\instances'
    foreach ($file in Get-ChildItem -LiteralPath $instances -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        try {
            $instance = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $process = Get-Process -Id $instance.pid -ErrorAction SilentlyContinue
            $processPath = if ($null -ne $process) { $process.Path } else { $null }
            if ($null -ne $process -and !$process.HasExited -and $processPath -and
                $processPath.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                return [pscustomobject]@{ instance = $instance; process = $process }
            }
        }
        catch {
        }
    }
    return $null
}

function Wait-ForFixtureServer([string]$ExpectedBuildId, [int]$TimeoutSeconds = 15) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $server = Get-ActiveFixtureServer
        if ($null -ne $server) {
            try {
                $reply = Invoke-Fixture $server 'meta'
                if ($reply.code -eq 0 -and $reply.data.build_id -ceq $ExpectedBuildId) {
                    return [pscustomobject]@{ instance = $server.instance; process = $server.process; meta = $reply.data }
                }
            }
            catch {
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Fixture server with build $ExpectedBuildId did not become ready. Instances: $((Get-ChildItem -LiteralPath (Join-Path $homePath 'server\instances') -Filter '*.json' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName) -join ', ')"
}

function Wait-ForNoFixtureServer([int]$TimeoutSeconds = 15) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($null -eq (Get-ActiveFixtureServer)) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'A fixture server did not stop before the deadline.'
}

function Stop-OwnFixtureServer {
    $server = Get-ActiveFixtureServer
    if ($null -eq $server) { return }
    try {
        $body = @{ action = 'quit'; server_id = $server.instance.server_id; consent = $true; interrupt_work = $true }
        Invoke-Fixture $server 'desktop-lifecycle' $body | Out-Null
        Wait-ForNoFixtureServer 5
        return
    }
    catch {
        try {
            Stop-Process -Id $server.process.Id -Force -ErrorAction SilentlyContinue
        }
        catch {
        }
    }
}

function Read-FixtureState {
    return Get-Content -LiteralPath (Join-Path $homePath 'fixture-session-state.json') -Raw | ConvertFrom-Json
}

function Read-FixtureEvents {
    return @(Get-Content -LiteralPath (Join-Path $homePath 'fixture-events.log') -ErrorAction SilentlyContinue)
}

function Read-CurrentManifest {
    return Get-Content -LiteralPath (Join-Path $runtimeRoot 'current.json') -Raw | ConvertFrom-Json
}

function Read-FixtureExecution([object]$Server, [string]$SessionId) {
    $reply = Invoke-Fixture $Server 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $SessionId; service = 'sessionExecutionControl'; method = 'read' }
        params = @()
    }
    Assert-Equal 0 $reply.code "Execution read failed for $SessionId."
    return $reply.data
}

try {
    $cscPath = Resolve-Csc
    [IO.Directory]::CreateDirectory((Join-Path $homePath 'server\instances')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $homePath 'server.local-owner'), $fixtureToken + "`n", (New-Object Text.UTF8Encoding($false)))
    $remoteOwnerToken = -join (1..43 | ForEach-Object { 'B' })
    [IO.File]::WriteAllText((Join-Path $homePath 'server.token'), $remoteOwnerToken + "`n", (New-Object Text.UTF8Encoding($false)))
    $env:KIKI_HOME = $homePath

    $oldCandidate = New-Candidate 'candidate-old' $oldCommit $false
    $goodCandidate = New-Candidate 'candidate-good' $goodCommit $false
    $failedCandidate = New-Candidate 'candidate-failed' $failedCommit $true
    $oldReleaseId = Get-ReleaseId (Join-Path $oldCandidate 'kiki-desktop.exe') (Join-Path $oldCandidate 'kiki-server.exe')
    $goodReleaseId = Get-ReleaseId (Join-Path $goodCandidate 'kiki-desktop.exe') (Join-Path $goodCandidate 'kiki-server.exe')
    $failedReleaseId = Get-ReleaseId (Join-Path $failedCandidate 'kiki-desktop.exe') (Join-Path $failedCandidate 'kiki-server.exe')
    Assert-NotEqual $oldReleaseId $goodReleaseId 'Old and good fixture artifacts were not distinct.'
    Assert-NotEqual $goodReleaseId $failedReleaseId 'Good and failed fixture artifacts were not distinct.'
    $desktopPrefs = Join-Path $homePath 'desktop.json'
    [IO.File]::WriteAllText($desktopPrefs, '{"closeToTray":true,"notifications":false}')
    $otherHome = Join-Path $testRoot 'unrelated-home'
    [IO.Directory]::CreateDirectory($otherHome) | Out-Null
    [IO.File]::WriteAllText((Join-Path $otherHome 'server.local-owner'), $fixtureToken)
    $env:KIKI_HOME = $otherHome
    try { $unrelated = Start-Process -FilePath (Join-Path $oldCandidate 'kiki-server.exe') -ArgumentList 'serve' -PassThru }
    finally { $env:KIKI_HOME = $homePath }

    Invoke-Script $controller @(
        '-Action', 'Promote',
        '-RuntimeRoot', $runtimeRoot,
        '-CandidateRoot', $oldCandidate,
        '-ExpectedCommit', $oldCommit
    ) | Out-Null
    $oldManifest = Read-CurrentManifest
    Assert-Equal $oldReleaseId ([string]$oldManifest.releaseId) 'Initial desktop-release Promote selected the wrong release.'
    Invoke-Script $controller @('-Action', 'Launch', '-RuntimeRoot', $runtimeRoot) | Out-Null
    $oldServer = Wait-ForFixtureServer $oldCommit
    $oldPid = [int]$oldServer.process.Id
    Assert-Equal $oldCommit ([string]$oldServer.meta.build_id) 'Initial desktop-release Launch did not start the old build.'
    Assert-Equal $serverHomeId ([string]$oldServer.meta.server_home_id) 'Initial fixture meta did not expose the stable server home identity.'
    Assert-Equal 'main' ([string]$oldServer.meta.current_space_id) 'Initial fixture meta did not expose the stable space identity.'
    Assert-True ([bool]$oldServer.meta.desktop_managed) 'Initial fixture meta did not mark the service as desktop managed.'
    Assert-True (-not [bool]$oldServer.meta.dangerous_bypass_auth) 'Initial fixture meta unexpectedly enabled the dangerous auth bypass.'
    $badTokenRejected = $false
    try {
        Invoke-Fixture $oldServer 'meta' $null (-join (1..43 | ForEach-Object { 'B' })) | Out-Null
    }
    catch {
        $badTokenRejected = $true
    }
    Assert-True $badTokenRejected 'The fixture accepted a request without its fixture-only bearer token.'

    $initialPrior = Invoke-Fixture $oldServer 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $priorPausedSessionId; service = 'sessionExecutionControl'; method = 'read' }
        params = @()
    }
    Assert-Equal 0 $initialPrior.code 'Initial paused-session read failed.'
    Assert-Equal 'paused' ([string]$initialPrior.data.phase) 'The fixture did not seed the earlier paused session.'
    Assert-Equal $priorPauseId ([string]$initialPrior.data.pauseOperationId) 'The earlier paused operation ID was not seeded.'
    $initialRunning = Read-FixtureExecution $oldServer $runningSessionId
    Assert-Equal 'running' ([string]$initialRunning.phase) 'The fixture did not seed the active task session as running.'
    Assert-Equal $taskId ([string]$initialRunning.taskId) 'The fixture did not expose the original task identity.'
    Assert-Equal 1 ([int]$initialRunning.taskRunCount) 'The fixture did not seed exactly one original task run.'
    Assert-Equal 0 ([int]$initialRunning.notificationDeliveryCount) 'The fixture seeded a consumed task notification.'
    $initialLifecycle = Invoke-Fixture $oldServer 'desktop-lifecycle'
    Assert-True (@($initialLifecycle.data.work_pending) -contains $runningSessionId) 'The active task was missing from initial lifecycle work_pending.'

    $oldShellPath = Join-Path (Join-Path $runtimeRoot 'releases') (Join-Path $oldReleaseId 'kiki-desktop.exe')
    $oldShells = @(Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $oldShellPath })
    Assert-Equal 1 $oldShells.Count 'The fixture launcher did not leave its desktop window running.'
    Assert-True ($oldShells[0].MainWindowHandle -ne 0) 'The fixture desktop did not expose its close target.'

    $switchOutput = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $goodCandidate,
        '-ExpectedCommit', $goodCommit,
        '-SettleSeconds', '30',
        '-StartupSeconds', '15'
    )
    Assert-Contains $goodReleaseId $switchOutput 'Successful hot switch did not report the selected release.'
    $successState = Get-Content -LiteralPath (Join-Path $runtimeRoot 'hot-switch.json') -Raw | ConvertFrom-Json
    Assert-Equal 'complete' ([string]$successState.phase) 'Successful hot switch did not finish its state record.'
    $successManifest = Read-CurrentManifest
    Assert-Equal $goodReleaseId ([string]$successManifest.releaseId) 'Successful hot switch did not promote the good release.'
    $goodServer = Wait-ForFixtureServer $goodCommit
    Assert-Equal $goodCommit ([string]$goodServer.meta.build_id) 'Successful hot switch did not start the good build.'
    Assert-NotEqual $oldPid ([int]$goodServer.process.Id) 'Successful hot switch reused the old backend PID.'
    Assert-True ($oldShells[0].HasExited) 'The original shell did not exit automatically.'
    Assert-True (!$unrelated.HasExited) 'The switch stopped an unrelated service.'
    $prefsAfterSwitch = Get-Content -LiteralPath $desktopPrefs -Raw | ConvertFrom-Json
    Assert-True ($prefsAfterSwitch.closeToTray -and !$prefsAfterSwitch.notifications) 'The switch changed desktop preferences.'
    $oldProcessAfterSwitch = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($null -ne $oldProcessAfterSwitch) {
        Assert-True $oldProcessAfterSwitch.HasExited 'The old backend process was still running after the successful switch.'
    }

    $stateAfterSuccess = Read-FixtureState
    $runningAfterSuccess = $stateAfterSuccess.sessions.PSObject.Properties[$runningSessionId].Value
    $priorAfterSuccess = $stateAfterSuccess.sessions.PSObject.Properties[$priorPausedSessionId].Value
    Assert-Equal 'running' ([string]$runningAfterSuccess.phase) 'The newly paused session was not resumed after a successful switch.'
    Assert-True ([string]$runningAfterSuccess.pauseOperationId -match '^hot-switch:[0-9a-f]{32}$') 'The successful switch did not retain its new pause operation ID.'
    Assert-Equal $taskId ([string]$runningAfterSuccess.taskId) 'The successful switch lost the original task identity.'
    Assert-Equal $terminalReceiptId ([string]$runningAfterSuccess.terminalReceiptId) 'The successful switch lost the persisted terminal receipt.'
    Assert-Equal $notificationId ([string]$runningAfterSuccess.notificationId) 'The successful switch lost the pending notification identity.'
    Assert-Equal 1 ([int]$runningAfterSuccess.taskRunCount) 'The successful switch reran the original task.'
    Assert-Equal 1 ([int]$runningAfterSuccess.notificationDeliveryCount) 'The successful switch did not deliver the original notification once.'
    Assert-Equal 'paused' ([string]$priorAfterSuccess.phase) 'The earlier paused session was changed by a successful switch.'
    Assert-Equal $priorPauseId ([string]$priorAfterSuccess.pauseOperationId) 'The earlier paused operation ID was changed by a successful switch.'
    $goodExecution = Read-FixtureExecution $goodServer $runningSessionId
    Assert-Equal 'running' ([string]$goodExecution.phase) 'The new backend did not resume the task session.'
    Assert-Equal $terminalReceiptId ([string]$goodExecution.terminalReceiptId) 'The new backend did not expose the terminal receipt.'
    Assert-Equal $notificationId ([string]$goodExecution.notificationId) 'The new backend did not expose the original notification ID.'
    Assert-Equal 1 ([int]$goodExecution.taskRunCount) 'The new backend reran the original task.'
    Assert-Equal 1 ([int]$goodExecution.notificationDeliveryCount) 'The new backend did not record one notification delivery.'
    $goodPriorExecution = Read-FixtureExecution $goodServer $priorPausedSessionId
    Assert-Equal 'paused' ([string]$goodPriorExecution.phase) 'The new backend changed the earlier paused session.'
    Assert-Equal $priorPauseId ([string]$goodPriorExecution.pauseOperationId) 'The new backend changed the earlier paused operation ID.'

    $eventsAfterSuccess = Read-FixtureEvents
    $settledEvents = @($eventsAfterSuccess | Where-Object { $_ -match ('^task-settled\|{0}\|receipt={1}\|notification={2}\|task_runs=1$' -f [regex]::Escape($taskId), [regex]::Escape($terminalReceiptId), [regex]::Escape($notificationId)) })
    $recoverableLifecycleEvents = @($eventsAfterSuccess | Where-Object { $_ -match ('^lifecycle-recoverable-notification\|{0}\|work_pending=0\|task=settled$' -f [regex]::Escape($taskId)) })
    $notificationDeliveryEvents = @($eventsAfterSuccess | Where-Object { $_ -match ('^notification-delivery\|{0}\|{1}\|count=1$' -f [regex]::Escape($taskId), [regex]::Escape($notificationId)) })
    Assert-Equal 1 $settledEvents.Count 'The pause did not settle the original task into one terminal receipt.'
    Assert-True ($recoverableLifecycleEvents.Count -ge 1) 'Lifecycle did not report zero real work after the task receipt became durable.'
    Assert-Equal 1 $notificationDeliveryEvents.Count 'The resumed backend did not deliver exactly one original notification.'
    $successPauseEvents = @($eventsAfterSuccess | Where-Object { $_ -match ('^pause\|{0}\|hot-switch:' -f [regex]::Escape($runningSessionId)) })
    $successResumeEvents = @($eventsAfterSuccess | Where-Object { $_ -match ('^resume\|{0}\|' -f [regex]::Escape($runningSessionId)) })
    Assert-Equal 1 $successPauseEvents.Count 'Successful switch did not issue exactly one pause for the active session.'
    Assert-Equal 1 $successResumeEvents.Count 'Successful switch did not issue exactly one resume for the active session.'
    $successPauseId = $successPauseEvents[0].Split('|')[2]
    $successResumeParts = $successResumeEvents[0].Split('|')
    Assert-Equal $successPauseId $successResumeParts[3] 'Successful switch resumed with a different pause operation ID.'
    Assert-NotEqual $priorPauseId $successPauseId 'Successful switch reused the earlier paused operation ID.'

    $failureOutput = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $failedCandidate,
        '-ExpectedCommit', $failedCommit,
        '-SettleSeconds', '30',
        '-StartupSeconds', '15'
    ) 1
    Assert-Contains 'code 23' $failureOutput 'A failed launcher did not make hot-switch fail with its launcher exit code.'
    $failureState = Get-Content -LiteralPath (Join-Path $runtimeRoot 'hot-switch.json') -Raw | ConvertFrom-Json
    Assert-Equal 'starting' ([string]$failureState.phase) 'A failed launch did not leave the switch recoverable at starting.'
    $stateAfterFailure = Read-FixtureState
    $runningAfterFailure = $stateAfterFailure.sessions.PSObject.Properties[$runningSessionId].Value
    $priorAfterFailure = $stateAfterFailure.sessions.PSObject.Properties[$priorPausedSessionId].Value
    Assert-Equal 'paused' ([string]$runningAfterFailure.phase) 'A failed launch lost the newly created pause state before recovery.'
    $failedPauseId = [string]$runningAfterFailure.pauseOperationId
    Assert-True ($failedPauseId -match '^hot-switch:[0-9a-f]{32}$') 'A failed launch did not retain its new pause operation ID.'
    Assert-NotEqual $successPauseId $failedPauseId 'Two hot-switch attempts reused one pause operation ID.'
    Assert-Equal $taskId ([string]$runningAfterFailure.taskId) 'A failed launch lost the original task identity.'
    Assert-Equal $terminalReceiptId ([string]$runningAfterFailure.terminalReceiptId) 'A failed launch lost the persisted terminal receipt.'
    Assert-Equal $notificationId ([string]$runningAfterFailure.notificationId) 'A failed launch lost the original notification ID.'
    Assert-Equal 1 ([int]$runningAfterFailure.taskRunCount) 'A failed launch reran the original task.'
    Assert-Equal 1 ([int]$runningAfterFailure.notificationDeliveryCount) 'A failed launch changed the already delivered notification count.'
    Assert-Equal 'paused' ([string]$priorAfterFailure.phase) 'A failed launch changed the earlier paused session.'
    Assert-Equal $priorPauseId ([string]$priorAfterFailure.pauseOperationId) 'A failed launch changed the earlier paused operation ID.'
    $eventsAfterFailure = Read-FixtureEvents
    $settledAfterFailure = @($eventsAfterFailure | Where-Object { $_ -match ('^task-settled\|{0}\|' -f [regex]::Escape($taskId)) })
    $deliveryAfterFailure = @($eventsAfterFailure | Where-Object { $_ -match ('^notification-delivery\|{0}\|' -f [regex]::Escape($taskId)) })
    Assert-Equal 1 $settledAfterFailure.Count 'A failed launch reran or re-settled the original task.'
    Assert-Equal 1 $deliveryAfterFailure.Count 'A failed launch duplicated the original notification delivery.'
    $failedManifest = Read-CurrentManifest
    Assert-Equal $failedReleaseId ([string]$failedManifest.releaseId) 'The failed launch did not select the candidate release before reporting failure.'
    Assert-True ($null -eq (Get-ActiveFixtureServer)) 'The failed launcher unexpectedly left a backend process running.'

    $recoverOutput = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-Recover',
        '-StartupSeconds', '15'
    )
    Assert-Contains ("Recovery complete: {0}" -f $goodReleaseId) $recoverOutput 'Recovery did not report the old release selected by the switch record.'
    $recoverManifest = Read-CurrentManifest
    Assert-Equal $goodReleaseId ([string]$recoverManifest.releaseId) 'Recovery did not restore the previously running release.'
    $recoveredServer = Wait-ForFixtureServer $goodCommit
    Assert-Equal $goodCommit ([string]$recoveredServer.meta.build_id) 'Recovery did not launch the old build.'
    Assert-NotEqual ([int]$goodServer.process.Id) ([int]$recoveredServer.process.Id) 'Recovery reused the failed-switch backend PID.'
    $recoveredState = Get-Content -LiteralPath (Join-Path $runtimeRoot 'hot-switch.json') -Raw | ConvertFrom-Json
    Assert-Equal 'complete' ([string]$recoveredState.phase) 'Recovery did not complete the switch state record.'
    $stateAfterRecovery = Read-FixtureState
    $runningAfterRecovery = $stateAfterRecovery.sessions.PSObject.Properties[$runningSessionId].Value
    $priorAfterRecovery = $stateAfterRecovery.sessions.PSObject.Properties[$priorPausedSessionId].Value
    Assert-Equal 'running' ([string]$runningAfterRecovery.phase) 'Recovery did not resume the session paused by the failed switch.'
    Assert-Equal $failedPauseId ([string]$runningAfterRecovery.pauseOperationId) 'Recovery did not use the failed switch pause operation ID.'
    Assert-Equal $taskId ([string]$runningAfterRecovery.taskId) 'Recovery lost the original task identity.'
    Assert-Equal $terminalReceiptId ([string]$runningAfterRecovery.terminalReceiptId) 'Recovery lost the persisted terminal receipt.'
    Assert-Equal $notificationId ([string]$runningAfterRecovery.notificationId) 'Recovery lost the original notification ID.'
    Assert-Equal 1 ([int]$runningAfterRecovery.taskRunCount) 'Recovery reran the original task.'
    Assert-Equal 1 ([int]$runningAfterRecovery.notificationDeliveryCount) 'Recovery duplicated or lost the original notification delivery count.'
    Assert-Equal 'paused' ([string]$priorAfterRecovery.phase) 'Recovery changed the earlier paused session.'
    Assert-Equal $priorPauseId ([string]$priorAfterRecovery.pauseOperationId) 'Recovery changed the earlier paused operation ID.'
    $recoveredExecution = Read-FixtureExecution $recoveredServer $runningSessionId
    Assert-Equal 'running' ([string]$recoveredExecution.phase) 'Recovery did not leave the task session running.'
    Assert-Equal 1 ([int]$recoveredExecution.taskRunCount) 'Recovery reran the original task on the restored backend.'
    Assert-Equal 1 ([int]$recoveredExecution.notificationDeliveryCount) 'Recovery delivered the original notification more than once.'
    $recoveredPriorExecution = Read-FixtureExecution $recoveredServer $priorPausedSessionId
    Assert-Equal 'paused' ([string]$recoveredPriorExecution.phase) 'Recovery changed the prior paused session collection.'
    Assert-Equal $priorPauseId ([string]$recoveredPriorExecution.pauseOperationId) 'Recovery changed the prior paused operation ID.'

    $eventsAfterRecovery = Read-FixtureEvents
    $allPauseEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^pause\|{0}\|hot-switch:' -f [regex]::Escape($runningSessionId)) })
    $allResumeEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^resume\|{0}\|' -f [regex]::Escape($runningSessionId)) })
    Assert-Equal 2 $allPauseEvents.Count 'The two switch attempts did not create two distinct active-session pauses.'
    Assert-Equal 2 $allResumeEvents.Count 'The successful switch and recovery did not each resume one active-session pause.'
    $allSettledEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^task-settled\|{0}\|' -f [regex]::Escape($taskId)) })
    $allDeliveryEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^notification-delivery\|{0}\|' -f [regex]::Escape($taskId)) })
    $allRecoverableLifecycleEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^lifecycle-recoverable-notification\|{0}\|work_pending=0\|task=settled$' -f [regex]::Escape($taskId)) })
    Assert-Equal 1 $allSettledEvents.Count 'The failed launch or recovery reran the original task settlement.'
    Assert-Equal 1 $allDeliveryEvents.Count 'The failed launch or recovery duplicated the original notification delivery.'
    Assert-True ($allRecoverableLifecycleEvents.Count -ge 1) 'The lifecycle did not preserve the receipt-only recovery state.'
    $recoveredResumeParts = $allResumeEvents[1].Split('|')
    Assert-Equal $failedPauseId $recoveredResumeParts[3] 'Recovery resumed a pause operation other than the failed switch pause.'
    Assert-True ($recoveredResumeParts[2] -match '^hot-switch:[0-9a-f]{32}:resume$') 'Recovery did not record a fresh resume operation ID.'

    $pointerPauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
    Invoke-Fixture $recoveredServer 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $runningSessionId; service = 'sessionExecutionControl'; method = 'pause' }
        params = @(@{ operationId = $pointerPauseId })
    } | Out-Null
    $pointerState = [ordered]@{
        schemaVersion = 1; phase = 'pausing'; kikiHome = $homePath; oldReleaseId = $oldReleaseId; oldBuildId = $oldCommit
        oldServerId = $oldServer.instance.server_id; serverHomeId = $serverHomeId; spaceId = 'main'
        priorPointerReleaseId = $failedReleaseId; targetReleaseId = $failedReleaseId; targetBuildId = $failedCommit; hadDesktop = $false
        sessions = @(@{ id = $runningSessionId; pauseId = $pointerPauseId })
    }
    $switchStatePath = Join-Path $runtimeRoot 'hot-switch.json'
    [IO.File]::WriteAllText($switchStatePath, ($pointerState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    $unrecordedOutput = Invoke-Script $hotSwitch @('-RuntimeRoot', $runtimeRoot, '-KikiHome', $homePath, '-Recover') 1
    Assert-Contains 'Recovery found a different service' $unrecordedOutput 'Recovery accepted an unrecorded running release.'
    Assert-Equal 'paused' ([string](Read-FixtureExecution $recoveredServer $runningSessionId).phase) 'Rejected recovery changed the pause.'
    $pointerState.priorPointerReleaseId = $goodReleaseId
    [IO.File]::WriteAllText($switchStatePath, ($pointerState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    $pointerRecoveryOutput = Invoke-Script $hotSwitch @('-RuntimeRoot', $runtimeRoot, '-KikiHome', $homePath, '-Recover')
    Assert-Contains ("Recovery complete: {0}" -f $goodReleaseId) $pointerRecoveryOutput 'Recovery rejected the recorded prior pointer release.'
    Assert-Equal $goodReleaseId ([string](Read-CurrentManifest).releaseId) 'Recovery changed the manually started release.'
    $pointerExecution = Read-FixtureExecution $recoveredServer $runningSessionId
    Assert-Equal 'running' ([string]$pointerExecution.phase) 'Prior-pointer recovery did not resume its pause.'
    Assert-Equal $pointerPauseId ([string]$pointerExecution.pauseOperationId) 'Prior-pointer recovery changed pause ownership.'
    Assert-Equal 1 ([int]$pointerExecution.taskRunCount) 'Prior-pointer recovery reran the task.'
    Assert-Equal 1 ([int]$pointerExecution.notificationDeliveryCount) 'Prior-pointer recovery duplicated the notification.'
    Assert-Equal $priorPauseId ([string](Read-FixtureExecution $recoveredServer $priorPausedSessionId).pauseOperationId) 'Prior-pointer recovery changed an unrelated pause.'

    $completed = $true
    Write-Output 'desktop-hot-switch tests passed: real Promote/Launch, PID/build switch, durable task receipt, one notification delivery, fresh pause preservation, prior paused preservation, failed launch, Recover, and prior-pointer recovery.'
}
finally {
    $env:KIKI_HOME = $originalKikiHome
    Stop-OwnFixtureServer
    Get-Process -Name 'kiki-desktop','kiki-server' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { $_.Kill(); $null = $_.WaitForExit(5000) }
    if ($completed) {
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    }
    else {
        Write-Warning "desktop-hot-switch fixture scratch retained at $testRoot"
    }
}
