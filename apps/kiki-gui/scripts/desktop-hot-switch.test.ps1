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
$originalKikiBuildId = $env:KIKI_BUILD_ID
$originalKikiDesktopBundled = $env:KIKI_DESKTOP_BUNDLED
$originalKikiRuntimeManaged = $env:KIKI_RUNTIME_MANAGED
Remove-Item Env:KIKI_BUILD_ID -ErrorAction SilentlyContinue
Remove-Item Env:KIKI_DESKTOP_BUNDLED -ErrorAction SilentlyContinue
Remove-Item Env:KIKI_RUNTIME_MANAGED -ErrorAction SilentlyContinue
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
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal sealed class HiddenFixtureForm : Form
{
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00000080 | 0x08000000;
            return cp;
        }
    }
}

internal static class Program
{
    private const string BuildId = "__BUILD_ID__";
    private const int FailLaunch = __FAIL_LAUNCH__;
    private const int FailServer = __FAIL_SERVER__;
    private const string ServerHomeId = "22222222-2222-4222-8222-222222222222";
    private const string RunningSessionId = "session-running";
    private const string PriorPausedSessionId = "session-prior-paused";
    private const string FailedSessionId = "session-failed";
    private const string ResumingSessionId = "session-resuming";
    private const string PriorPauseId = "prior-paused-operation";
    private const string TaskId = "fixture-task-running";
    private const string TerminalReceiptId = "terminal-receipt-running";
    private const string NotificationId = "task-notification-running";
    private static readonly object Gate = new object();
    private static readonly Dictionary<string, SessionState> Sessions = new Dictionary<string, SessionState>(StringComparer.Ordinal);
    private static int resumingReads = 0;
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
    private static bool desktopManaged = true;
    private static bool runtimeManaged = true;
    private static string effectiveBuildId = BuildId;
    private static string fencedOperationId = null;

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
        string launcherHome = null;
        string[] cmdArgs = Environment.GetCommandLineArgs();
        for (int i = 1; i < cmdArgs.Length; i++)
        {
            if (String.Equals(cmdArgs[i], "--home", StringComparison.OrdinalIgnoreCase) && i + 1 < cmdArgs.Length)
            {
                launcherHome = cmdArgs[i + 1];
                break;
            }
            if (cmdArgs[i].StartsWith("--home=", StringComparison.OrdinalIgnoreCase))
            {
                launcherHome = cmdArgs[i].Substring("--home=".Length);
                break;
            }
        }
        if (String.IsNullOrWhiteSpace(launcherHome))
        {
            launcherHome = Environment.GetEnvironmentVariable("KIKI_HOME");
        }
        string preferences = Path.Combine(launcherHome, "desktop.json");
        string explicitExitPath = Path.Combine(launcherHome, "server", "explicit-exit.json");
        bool launcherClosing = false;
        Process backend = null;
        using (Form window = new HiddenFixtureForm { Text = "Kiki hot switch fixture", Width = 1, Height = 1, StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), FormBorderStyle = FormBorderStyle.None, Opacity = 0 })
        {
            window.FormClosing += delegate(object sender, FormClosingEventArgs args)
            {
                bool allowed = File.Exists(preferences) && Regex.IsMatch(File.ReadAllText(preferences), "\"closeToTray\"\\s*:\\s*false");
                args.Cancel = !allowed;
                launcherClosing = allowed;
                if (allowed && backend != null && !backend.HasExited)
                {
                    File.WriteAllText(Path.Combine(launcherHome, "fixture-stderr-reader-closed-" + backend.Id), "closed");
                }
            };
            Action startServer = null;
            startServer = delegate
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = server,
                    Arguments = "serve",
                    WorkingDirectory = directory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                psi.EnvironmentVariables["KIKI_HOME"] = launcherHome;
                psi.EnvironmentVariables["KIKI_DESKTOP_BUNDLED"] = "1";
                psi.EnvironmentVariables["KIKI_BUILD_ID"] = BuildId;
                Process process = Process.Start(psi);
                backend = process;
                int backendPid = process.Id;
                process.EnableRaisingEvents = true;
                process.Exited += delegate
                {
                    if (launcherClosing || window.IsDisposed) return;
                    if (File.Exists(explicitExitPath) && Regex.IsMatch(File.ReadAllText(explicitExitPath), "\"pid\"\\s*:\\s*" + backendPid + "(?:,|})")) return;
                    try { window.BeginInvoke(startServer); }
                    catch { }
                };
            };
            window.Shown += delegate { startServer(); };
            Application.Run(window);
        }
    }

    private static void RunServer()
    {
        if (FailServer != 0)
        {
            Environment.Exit(FailServer);
            return;
        }
        string[] cmdArgs = Environment.GetCommandLineArgs();
        int requestedPort = 0;
        for (int i = 1; i < cmdArgs.Length; i++)
        {
            if (String.Equals(cmdArgs[i], "--home", StringComparison.OrdinalIgnoreCase) && i + 1 < cmdArgs.Length)
            {
                home = cmdArgs[++i];
            }
            else if (cmdArgs[i].StartsWith("--home=", StringComparison.OrdinalIgnoreCase))
            {
                home = cmdArgs[i].Substring("--home=".Length);
            }
            else if (String.Equals(cmdArgs[i], "--port", StringComparison.OrdinalIgnoreCase) && i + 1 < cmdArgs.Length)
            {
                int.TryParse(cmdArgs[++i], out requestedPort);
            }
            else if (cmdArgs[i].StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
            {
                int.TryParse(cmdArgs[i].Substring("--port=".Length), out requestedPort);
            }
            else if (String.Equals(cmdArgs[i], "--headless-unmanaged", StringComparison.OrdinalIgnoreCase))
            {
                desktopManaged = false;
                runtimeManaged = false;
            }
            else if (String.Equals(cmdArgs[i], "--headless-runtime-managed", StringComparison.OrdinalIgnoreCase))
            {
                desktopManaged = false;
                runtimeManaged = true;
            }
            else if (String.Equals(cmdArgs[i], "--heap-reexec", StringComparison.OrdinalIgnoreCase))
            {
                if (!String.Equals(Environment.GetEnvironmentVariable("KIKI_FIXTURE_REEXEC"), "1", StringComparison.Ordinal))
                {
                    string selfPath = Process.GetCurrentProcess().MainModule.FileName;
                    string rawCmd = Environment.CommandLine;
                    string tailArgs = "";
                    if (rawCmd.StartsWith("\""))
                    {
                        int closeQuote = rawCmd.IndexOf('"', 1);
                        tailArgs = closeQuote > 0 ? rawCmd.Substring(closeQuote + 1).Trim() : "";
                    }
                    else
                    {
                        int firstSpace = rawCmd.IndexOf(' ');
                        tailArgs = firstSpace > 0 ? rawCmd.Substring(firstSpace + 1).Trim() : "";
                    }
                    ProcessStartInfo childPsi = new ProcessStartInfo
                    {
                        FileName = selfPath,
                        Arguments = tailArgs,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WorkingDirectory = Path.GetDirectoryName(selfPath),
                    };
                    childPsi.EnvironmentVariables["KIKI_FIXTURE_REEXEC"] = "1";
                    using (Process childProc = Process.Start(childPsi))
                    {
                        childProc.WaitForExit();
                        Environment.Exit(childProc.ExitCode);
                    }
                    return;
                }
            }
        }
        if (String.IsNullOrWhiteSpace(home))
        {
            home = Environment.GetEnvironmentVariable("KIKI_HOME");
        }
        if (String.IsNullOrWhiteSpace(home)) throw new InvalidOperationException("KIKI_HOME is missing.");
        if (File.Exists(Path.Combine(home, "fixture-headless-unmanaged")))
        {
            desktopManaged = false;
            runtimeManaged = false;
        }
        bool envDesktopBundled = String.Equals(Environment.GetEnvironmentVariable("KIKI_DESKTOP_BUNDLED"), "1", StringComparison.Ordinal);
        bool envRuntimeManaged = String.Equals(Environment.GetEnvironmentVariable("KIKI_RUNTIME_MANAGED"), "1", StringComparison.Ordinal);
        if (envRuntimeManaged && !envDesktopBundled)
        {
            desktopManaged = false;
            runtimeManaged = true;
        }
        string envBuildId = Environment.GetEnvironmentVariable("KIKI_BUILD_ID");
        if (!String.IsNullOrEmpty(envBuildId))
        {
            effectiveBuildId = envBuildId;
        }
        else if (!desktopManaged)
        {
            effectiveBuildId = null;
        }
        token = File.ReadAllText(Path.Combine(home, "server.local-owner")).Trim();
        if (!Regex.IsMatch(token, "^[A-Za-z0-9_-]{43}$")) throw new InvalidOperationException("The fixture token is invalid.");
        Directory.CreateDirectory(Path.Combine(home, "server", "instances"));
        statePath = Path.Combine(home, "fixture-session-state.json");
        eventsPath = Path.Combine(home, "fixture-events.log");
        LoadSessions();
        serverId = "fixture-" + Guid.NewGuid().ToString("N");
        startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        startedIso = DateTimeOffset.UtcNow.ToString("o");
        int port = requestedPort > 0 ? requestedPort : AllocatePort();
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
        string buildField = String.IsNullOrEmpty(effectiveBuildId) ? "" : (",\"build_id\":" + Json(effectiveBuildId));
        string body = "{\"server_id\":" + Json(serverId) + ",\"pid\":" + Process.GetCurrentProcess().Id +
            ",\"host\":\"127.0.0.1\",\"port\":" + port + ",\"started_at\":" + startedAt +
            ",\"heartbeat_at\":" + startedAt + buildField + "}";
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
            if (path == "/api/healthz" && context.Request.HttpMethod == "GET")
            {
                if (File.Exists(Path.Combine(home, "fixture-fail-healthz")))
                {
                    Send(context, 200, "{\"ok\":false}");
                    return;
                }
                Send(context, 200, "{\"ok\":true}");
                return;
            }
            if (path == "/api/runtime-switch")
            {
                if (File.Exists(Path.Combine(home, "fixture-no-runtime-switch")))
                {
                    Send(context, 404, Envelope(40404, "Fixture route not found", "null"));
                    return;
                }
                if (context.Request.HttpMethod == "GET")
                {
                    string opJson = fencedOperationId == null ? "null" : Json(fencedOperationId);
                    Send(context, 200, Envelope(0, "ok", "{\"writer\":{\"serverId\":" + Json(serverId) + ",\"phase\":" + Json(fencedOperationId == null ? "ready" : "draining") + ",\"operationId\":" + opJson + "},\"admission\":{\"pending\":[]},\"workPending\":[]}"));
                    return;
                }
                if (context.Request.HttpMethod == "POST")
                {
                    string body = ReadBody(context);
                    string reqSrv = JsonValue(body, "serverId");
                    if (!String.Equals(reqSrv, serverId, StringComparison.Ordinal))
                    {
                        Send(context, 200, Envelope(40001, "Server identity mismatch", "null"));
                        return;
                    }
                    string action = JsonValue(body, "action");
                    string opId = JsonValue(body, "operationId");
                    lock (Gate)
                    {
                        if (action == "fence" || action == "prepare")
                        {
                            fencedOperationId = opId;
                            AppendEvent("fenced|" + opId);
                        }
                        else if (action == "cancel")
                        {
                            fencedOperationId = null;
                            AppendEvent("fence-cancelled|" + opId);
                        }
                    }
                    Send(context, 200, Envelope(0, "ok", "{\"writer\":{\"serverId\":" + Json(serverId) + ",\"phase\":" + Json(fencedOperationId == null ? "ready" : "draining") + "},\"admission\":{\"pending\":[]},\"workPending\":[]}"));
                    return;
                }
            }
            if (path.StartsWith("/api/sessions/") && path.EndsWith("/prompts") && context.Request.HttpMethod == "POST")
            {
                lock (Gate)
                {
                    if (fencedOperationId != null)
                    {
                        Send(context, 200, Envelope(40900, "Server admission is fenced for runtime switch", "null"));
                        return;
                    }
                }
                Send(context, 200, Envelope(0, "ok", "{\"accepted\":true}"));
                return;
            }
            if (path == "/api/shutdown" && context.Request.HttpMethod == "POST")
            {
                Send(context, 200, Envelope(0, "ok", "{\"ok\":true}"));
                ThreadPool.QueueUserWorkItem(delegate
                {
                    Thread.Sleep(50);
                    StopServer();
                });
                return;
            }
            if (path == "/api/meta" && context.Request.HttpMethod == "GET")
            {
                if (File.Exists(Path.Combine(home, "fixture-fail-meta")))
                {
                    Send(context, 500, Envelope(50001, "Fixture simulated broken /api/meta", "null"));
                    return;
                }
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
        string buildField = String.IsNullOrEmpty(effectiveBuildId) ? "" : (",\"build_id\":" + Json(effectiveBuildId));
        return "{\"server_id\":" + Json(serverId) + ",\"server_home_id\":" + Json(ServerHomeId) +
            ",\"current_space_id\":\"main\",\"server_version\":\"fixture\",\"started_at\":" + Json(startedIso) +
            ",\"desktop_managed\":" + (desktopManaged ? "true" : "false") + ",\"dangerous_bypass_auth\":false,\"backend\":\"fixture\"" + buildField + "}";
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
        if (!runtimeManaged)
        {
            Send(context, 200, Envelope(40005, "This service is externally managed; stop it through its owner", "null"));
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
            if (action == "update" && File.Exists(Path.Combine(home, "fixture-reject-update")))
            {
                Send(context, 200, Envelope(50001, "Fixture rejected update shutdown", "null"));
                return;
            }
            int pid = Process.GetCurrentProcess().Id;
            File.WriteAllText(Path.Combine(home, "server", "explicit-exit.json"),
                "{\"schemaVersion\":1,\"serverId\":" + Json(serverId) + ",\"pid\":" + pid + ",\"startedAt\":" + startedAt + ",\"action\":" + Json(action) + "}");
            Send(context, 200, Envelope(0, "ok", "{\"ok\":true}"));
            ThreadPool.QueueUserWorkItem(delegate
            {
                Thread.Sleep(75);
                if (action == "update" && File.Exists(Path.Combine(home, "fixture-hang-on-update")))
                {
                    AppendEvent("shutdown-hung|" + pid);
                    return;
                }
                if (action == "update" && File.Exists(Path.Combine(home, "fixture-stderr-reader-closed-" + pid)))
                {
                    AppendEvent("shutdown-stderr-epipe|" + pid);
                    RemoveInstance();
                    Environment.Exit(1);
                }
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
        if (File.Exists(Path.Combine(home, "fixture-block-exit")) && !pending.Contains(RunningSessionId)) pending.Add(RunningSessionId);
        if (File.Exists(Path.Combine(home, "fixture-failed-pending")) && !pending.Contains(FailedSessionId)) pending.Add(FailedSessionId);
        if (File.Exists(Path.Combine(home, "fixture-resuming-pending")) && !pending.Contains(ResumingSessionId)) pending.Add(ResumingSessionId);
        StringBuilder ids = new StringBuilder();
        for (int index = 0; index < pending.Count; index++)
        {
            if (index > 0) ids.Append(',');
            ids.Append(Json(pending[index]));
        }
        return "{\"server_id\":" + Json(serverId) + ",\"home_id\":\"main\",\"managed\":" + (runtimeManaged ? "true" : "false") + ",\"draining\":false,\"hot_switch_prepared\":false,\"work_pending\":[" + ids + "],\"impact\":\"all-windows-in-this-space\"}";
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
            if (sessionId == FailedSessionId && method == "read")
            {
                Send(context, 200, Envelope(0, "ok", "{\"phase\":\"failed\",\"pauseOperationId\":null,\"agents\":[]}"));
                return;
            }
            if (sessionId == ResumingSessionId && method == "read")
            {
                resumingReads++;
                if (resumingReads < 3)
                {
                    Send(context, 200, Envelope(0, "ok", "{\"phase\":\"resuming\",\"pauseOperationId\":null,\"agents\":[]}"));
                    return;
                }
                string resumingFlag = Path.Combine(home, "fixture-resuming-pending");
                if (File.Exists(resumingFlag)) { try { File.Delete(resumingFlag); } catch {} }
                Send(context, 200, Envelope(0, "ok", "{\"phase\":\"idle\",\"pauseOperationId\":null,\"agents\":[]}"));
                return;
            }
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

function Compile-Fixture([string]$BuildId, [bool]$FailLaunch, [string]$OutputPath, [bool]$FailServer = $false) {
    $failCode = if ($FailLaunch) { '23' } else { '0' }
    $failServerCode = if ($FailServer) { '42' } else { '0' }
    $source = $fixtureSource.Replace('__BUILD_ID__', $BuildId).Replace('__FAIL_LAUNCH__', $failCode).Replace('__FAIL_SERVER__', $failServerCode)
    [IO.File]::WriteAllText($fixtureSourcePath, $source, (New-Object Text.UTF8Encoding($false)))
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $compilerOutput = (& $cscPath /nologo /target:winexe /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /optimize+ /out:$OutputPath $fixtureSourcePath 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0 -or !(Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
        throw "csc failed for fixture build $BuildId with exit code $exitCode.`n$compilerOutput`nSource: $fixtureSourcePath"
    }
}

function New-Candidate([string]$Name, [string]$BuildId, [bool]$FailLaunch, [bool]$FailServer = $false) {
    $candidate = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory($candidate) | Out-Null
    $fixtureBinary = Join-Path $testRoot ($Name + '.exe')
    Compile-Fixture $BuildId $FailLaunch $fixtureBinary $FailServer
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
    & {
        $ownerToken = $fixtureToken
        $ast = [Management.Automation.Language.Parser]::ParseFile($hotSwitch, [ref]$null, [ref]$null)
        foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Call-Local', 'Execution', 'Lifecycle', 'Try-RuntimeSwitch', 'Release-OurPauses') }, $false)) {
            . ([scriptblock]::Create($definition.Extent.Text))
        }
        function Invoke-RestMethod {
            param($Uri, $Headers, $MaximumRedirection, $TimeoutSec, $Method, $ContentType, $Body)
            return @{ code = 0; data = $TimeoutSec }
        }
        $server = @{ port = 1; server_id = 'fixture' }
        foreach ($method in @('resume', 'cancelPause')) { Assert-Equal 120 (Execution $server 'session' $method) "Cold $method lost its bounded request timeout." }
        foreach ($method in @('read', 'pause')) { Assert-Equal 60 (Execution $server 'session' $method) "$method lost its request timeout." }
        Assert-Equal 60 (Lifecycle $server 'update') 'The lifecycle action lost its request timeout.'

        Add-Type @'
using System.IO;
using System.Net;
public sealed class DesktopHotSwitchTestWebResponse : WebResponse
{
    public HttpStatusCode StatusCode { get; set; }
    public override Stream GetResponseStream() { return Stream.Null; }
}
'@
        $script:runtimeSwitchScenario = $null
        function Call-Local([object]$Server, [string]$Path, [object]$Body) {
            switch ($script:runtimeSwitchScenario) {
                'runtime' { throw [System.Management.Automation.RuntimeException]::new('runtime failure without Response') }
                'network' { throw [System.Net.WebException]::new('connection failed', [System.Net.WebExceptionStatus]::ConnectFailure) }
                'http404' {
                    $response = [DesktopHotSwitchTestWebResponse]::new()
                    $response.StatusCode = [System.Net.HttpStatusCode]::NotFound
                    throw [System.Net.WebException]::new('not found', $null, [System.Net.WebExceptionStatus]::ProtocolError, $response)
                }
                'http500' {
                    $response = [DesktopHotSwitchTestWebResponse]::new()
                    $response.StatusCode = [System.Net.HttpStatusCode]::InternalServerError
                    throw [System.Net.WebException]::new('server failure', $null, [System.Net.WebExceptionStatus]::ProtocolError, $response)
                }
                default { throw "Unknown runtime-switch scenario: $script:runtimeSwitchScenario" }
            }
        }
        $previousVerbosePreference = $VerbosePreference
        $VerbosePreference = 'Continue'
        try {
            foreach ($case in @(
                @{ name = 'RuntimeException without Response'; scenario = 'runtime'; expectVerbose = $true; message = 'runtime failure without Response' },
                @{ name = 'network exception with null Response'; scenario = 'network'; expectVerbose = $true; message = 'connection failed' },
                @{ name = 'HTTP 404 response'; scenario = 'http404'; expectVerbose = $false; message = $null },
                @{ name = 'HTTP 500 response'; scenario = 'http500'; expectVerbose = $true; message = 'server failure' }
            )) {
                $script:runtimeSwitchScenario = $case.scenario
                $verbose = @(Try-RuntimeSwitch $server 'operation' 'fence' 4>&1 | ForEach-Object { [string]$_ })
                Assert-Equal $case.expectVerbose ($verbose.Count -gt 0) "$($case.name) produced unexpected verbose output: $($verbose -join ' | ')"
                if ($case.expectVerbose) {
                    Assert-Contains $case.message ($verbose -join "`n") "$($case.name) did not report its failure."
                }
            }
        }
        finally {
            $VerbosePreference = $previousVerbosePreference
        }

        function Get-ObjectProperty([object]$Target, [string]$Name) {
            if ($null -eq $Target) { return $null }
            $prop = $Target.PSObject.Properties[$Name]
            if ($null -ne $prop) { return $prop.Value }
            return $null
        }
        function Execution([object]$Server, [string]$Id, [string]$Method, [object[]]$Arguments = @()) {
            if ($Method -eq 'read') {
                return [pscustomobject]@{ phase = 'failed'; pauseOperationId = 'hot-switch:stuck' }
            }
            throw 'cancelPause RPC failed'
        }
        $state = [pscustomobject]@{
            sessions = @([pscustomobject]@{ id = 'session-failed'; pauseId = 'hot-switch:stuck' })
        }
        $threwOnAllowCancel = $false
        try {
            Release-OurPauses ([pscustomobject]@{ instance = $server }) $true 3>$null
        }
        catch {
            $threwOnAllowCancel = $true
            Assert-Contains 'Failed to release 1 paused session(s)' $_.Exception.Message 'Release-OurPauses did not surface failed cancelPause details.'
        }
        Assert-True $threwOnAllowCancel 'Release-OurPauses swallowed a failed pause release when AllowCancel was true.'
    }
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
    try { $unrelated = Start-Process -FilePath (Join-Path $oldCandidate 'kiki-server.exe') -ArgumentList 'serve' -WindowStyle Hidden -PassThru }
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

    $oldShellPath = Join-Path (Join-Path $runtimeRoot 'active') 'kiki-desktop.exe'
    $oldShells = @(Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $oldShellPath })
    Assert-Equal 1 $oldShells.Count 'The fixture launcher did not leave its active desktop window running.'
    Assert-True ($oldShells[0].MainWindowHandle -ne 0) 'The fixture desktop did not expose its close target.'
    Assert-Equal (Join-Path (Join-Path $runtimeRoot 'active') 'kiki-server.exe') $oldServer.process.Path 'Initial launch did not run kiki-server.exe from active\.'

    $continuedPauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
    Invoke-Fixture $oldServer 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $runningSessionId; service = 'sessionExecutionControl'; method = 'pause' }
        params = @(@{ operationId = $continuedPauseId })
    } | Out-Null
    $continuedState = [ordered]@{
        schemaVersion = 1; phase = 'pausing'; kikiHome = $homePath; oldReleaseId = $oldReleaseId; oldBuildId = $oldCommit
        oldServerId = $oldServer.instance.server_id; serverHomeId = $serverHomeId; spaceId = 'main'
        priorPointerReleaseId = $oldReleaseId; targetReleaseId = $goodReleaseId; targetBuildId = $goodCommit; hadDesktop = $true
        sessions = @(@{ id = $runningSessionId; pauseId = $continuedPauseId })
    }
    [IO.File]::WriteAllText((Join-Path $runtimeRoot 'hot-switch.json'), ($continuedState | ConvertTo-Json -Depth 6))
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
    Assert-Equal (Join-Path (Join-Path $runtimeRoot 'active') 'kiki-server.exe') $goodServer.process.Path 'Hot switch did not launch new kiki-server.exe from active\.'
    $switchReportPath = Join-Path $runtimeRoot 'hot-switch-report.json'
    Assert-True (Test-Path -LiteralPath $switchReportPath -PathType Leaf) 'Hot switch did not write hot-switch-report.json.'
    $switchReport = Get-Content -LiteralPath $switchReportPath -Raw | ConvertFrom-Json
    Assert-Equal 'succeeded' ([string]$switchReport.outcome) 'hot-switch-report.json did not record succeeded outcome.'
    Assert-Equal 'active' ([string]$switchReport.postServerMeta.layout) 'hot-switch-report.json did not record active postServerMeta layout.'
    Assert-True (@($switchReport.resumedSessions) -contains $runningSessionId) 'hot-switch-report.json did not record resumedSessions.'
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

    function Stop-FixtureDesktopAndServer {
        Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)
        } | ForEach-Object { try { $_.Kill() } catch {}; try { $null = $_.WaitForExit(5000) } catch {} }
        Stop-OwnFixtureServer
    }

    function Read-SharedFileBytes([string]$Path) {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $memory = New-Object IO.MemoryStream
            try {
                $stream.CopyTo($memory)
                return ,$memory.ToArray()
            } finally {
                $memory.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
    }

    function Assert-ValidUtf8Log([string]$LogPath, [string]$ExpectedSubstring, [string]$Message) {
        Assert-True (Test-Path -LiteralPath $LogPath -PathType Leaf) "$Message (log file missing: $LogPath)"
        $bytes = Read-SharedFileBytes $LogPath
        Assert-True ($bytes.Length -gt 0) "$Message (log file is empty)"
        Assert-True (-not ($bytes -contains [byte]0)) "$Message (log file contains UTF-16LE NUL bytes)"
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $text = $strictUtf8.GetString($bytes)
        Assert-Contains $ExpectedSubstring $text "$Message`nLog contents:`n$text"
    }

    # 1. Broken new binary during phase='starting' automatically rolls back to the previous release
    $failureOutput = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $failedCandidate,
        '-ExpectedCommit', $failedCommit,
        '-SettleSeconds', '30',
        '-StartupSeconds', '15'
    ) 1
    Assert-Contains 'code 23' $failureOutput 'A failed launcher did not make hot-switch fail with its launcher exit code.'
    Assert-Contains ("Rolled back to previous release {0}" -f $goodReleaseId) $failureOutput 'A failed launch did not automatically roll back to the previous release.'
    $recoveredManifest = Read-CurrentManifest
    Assert-Equal $goodReleaseId ([string]$recoveredManifest.releaseId) 'Automatic rollback did not restore the previously running release.'
    $recoveredServer = Wait-ForFixtureServer $goodCommit
    Assert-Equal $goodCommit ([string]$recoveredServer.meta.build_id) 'Automatic rollback did not relaunch the old build.'
    Assert-NotEqual ([int]$goodServer.process.Id) ([int]$recoveredServer.process.Id) 'Automatic rollback reused the failed-switch backend PID.'
    $recoveredState = Get-Content -LiteralPath (Join-Path $runtimeRoot 'hot-switch.json') -Raw | ConvertFrom-Json
    Assert-Equal 'complete' ([string]$recoveredState.phase) 'Automatic rollback did not complete the switch state record.'
    $stateAfterRecovery = Read-FixtureState
    $runningAfterRecovery = $stateAfterRecovery.sessions.PSObject.Properties[$runningSessionId].Value
    $priorAfterRecovery = $stateAfterRecovery.sessions.PSObject.Properties[$priorPausedSessionId].Value
    Assert-Equal 'running' ([string]$runningAfterRecovery.phase) 'Automatic rollback did not resume the session paused by the failed switch.'
    $failedPauseId = [string]$runningAfterRecovery.pauseOperationId
    Assert-True ($failedPauseId -match '^hot-switch:[0-9a-f]{32}$') 'Automatic rollback did not retain its new pause operation ID.'
    Assert-NotEqual $successPauseId $failedPauseId 'Two hot-switch attempts reused one pause operation ID.'
    Assert-Equal $taskId ([string]$runningAfterRecovery.taskId) 'Automatic rollback lost the original task identity.'
    Assert-Equal $terminalReceiptId ([string]$runningAfterRecovery.terminalReceiptId) 'Automatic rollback lost the persisted terminal receipt.'
    Assert-Equal $notificationId ([string]$runningAfterRecovery.notificationId) 'Automatic rollback lost the original notification ID.'
    Assert-Equal 1 ([int]$runningAfterRecovery.taskRunCount) 'Automatic rollback reran the original task.'
    Assert-Equal 1 ([int]$runningAfterRecovery.notificationDeliveryCount) 'Automatic rollback duplicated or lost the original notification delivery count.'
    Assert-Equal 'paused' ([string]$priorAfterRecovery.phase) 'Automatic rollback changed the earlier paused session.'
    Assert-Equal $priorPauseId ([string]$priorAfterRecovery.pauseOperationId) 'Automatic rollback changed the earlier paused operation ID.'
    $recoveredExecution = Read-FixtureExecution $recoveredServer $runningSessionId
    Assert-Equal 'running' ([string]$recoveredExecution.phase) 'Automatic rollback did not leave the task session running.'
    Assert-Equal 1 ([int]$recoveredExecution.taskRunCount) 'Automatic rollback reran the original task on the restored backend.'
    Assert-Equal 1 ([int]$recoveredExecution.notificationDeliveryCount) 'Automatic rollback delivered the original notification more than once.'
    $recoveredPriorExecution = Read-FixtureExecution $recoveredServer $priorPausedSessionId
    Assert-Equal 'paused' ([string]$recoveredPriorExecution.phase) 'Automatic rollback changed the prior paused session collection.'
    Assert-Equal $priorPauseId ([string]$recoveredPriorExecution.pauseOperationId) 'Automatic rollback changed the prior paused operation ID.'

    $eventsAfterRecovery = Read-FixtureEvents
    $allPauseEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^pause\|{0}\|hot-switch:' -f [regex]::Escape($runningSessionId)) })
    $allResumeEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^resume\|{0}\|' -f [regex]::Escape($runningSessionId)) })
    Assert-Equal 2 $allPauseEvents.Count 'The two switch attempts did not create two distinct active-session pauses.'
    Assert-Equal 2 $allResumeEvents.Count 'The successful switch and automatic rollback did not each resume one active-session pause.'
    $allSettledEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^task-settled\|{0}\|' -f [regex]::Escape($taskId)) })
    $allDeliveryEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^notification-delivery\|{0}\|' -f [regex]::Escape($taskId)) })
    $allRecoverableLifecycleEvents = @($eventsAfterRecovery | Where-Object { $_ -match ('^lifecycle-recoverable-notification\|{0}\|work_pending=0\|task=settled$' -f [regex]::Escape($taskId)) })
    Assert-Equal 1 $allSettledEvents.Count 'The failed launch or automatic rollback reran the original task settlement.'
    Assert-Equal 1 $allDeliveryEvents.Count 'The failed launch or automatic rollback duplicated the original notification delivery.'
    Assert-True ($allRecoverableLifecycleEvents.Count -ge 1) 'The lifecycle did not preserve the receipt-only recovery state.'
    $recoveredResumeParts = $allResumeEvents[1].Split('|')
    Assert-Equal $failedPauseId $recoveredResumeParts[3] 'Automatic rollback resumed a pause operation other than the failed switch pause.'
    Assert-True ($recoveredResumeParts[2] -match '^hot-switch:[0-9a-f]{32}:resume$') 'Automatic rollback did not record a fresh resume operation ID.'

    # 2. Prior-pointer -Recover validation (rejects unrecorded release, accepts recorded priorPointerReleaseId)
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

    # 3. Promote-First: settle timeout keeps current.json promoted to targetReleaseId so manual quit+restart boots the NEW release
    $blockedExit = Join-Path $homePath 'fixture-block-exit'
    [IO.File]::WriteAllText($blockedExit, 'pending task')
    $timeoutOutput = Invoke-Script $hotSwitch @('-RuntimeRoot', $runtimeRoot, '-KikiHome', $homePath,
        '-CandidateRoot', $oldCandidate, '-ExpectedCommit', $oldCommit, '-SettleSeconds', '1', '-NoInterruptAfterSettle') 1
    Assert-Contains 'Still settling' $timeoutOutput 'The pending exit did not reach its settle deadline.'
    Assert-Equal 'running' ([string](Read-FixtureExecution $recoveredServer $runningSessionId).phase) 'A failed switch left its session paused.'
    Assert-Equal 'paused' ([string](Read-FixtureExecution $recoveredServer $priorPausedSessionId).phase) 'Failed-switch cleanup resumed an earlier pause.'
    Assert-Equal 'complete' ([string](Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json).phase) 'Failed-switch cleanup left an unfinished pause record.'
    Assert-Equal $oldReleaseId ([string](Read-CurrentManifest).releaseId) 'Promote-First did not keep current.json promoted to targetReleaseId after settle timeout.'
    Assert-True (!$recoveredServer.process.HasExited) 'Failed-switch cleanup stopped the original service.'
    Remove-Item -LiteralPath $blockedExit
    Assert-Equal $continuedPauseId ([string]$successState.sessions[0].pauseId) 'A resumed switch replaced the original saved pause.'

    # Simulate user manually quitting and relaunching Kiki: must boot the NEW target release ($oldCommit), NOT the old running release ($goodCommit)
    Stop-FixtureDesktopAndServer
    Invoke-Script $controller @('-Action', 'Launch', '-RuntimeRoot', $runtimeRoot) | Out-Null
    $manualRestartServer = Wait-ForFixtureServer $oldCommit 15
    Assert-Equal $oldCommit ([string]$manualRestartServer.meta.build_id) 'Manual quit+restart did not boot the newly promoted target release.'

    # 4. -Recover behavior: prefers targetReleaseId on 'stopping' (no downgrade!), honors 'starting_failed', and honors explicit -Rollback
    $recoverTargetPauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
    Invoke-Fixture $manualRestartServer 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $runningSessionId; service = 'sessionExecutionControl'; method = 'pause' }
        params = @(@{ operationId = $recoverTargetPauseId })
    } | Out-Null
    $stoppingState = [ordered]@{
        schemaVersion = 1; phase = 'stopping'; kikiHome = $homePath; oldReleaseId = $oldReleaseId; oldBuildId = $oldCommit
        oldServerId = $manualRestartServer.instance.server_id; serverHomeId = $serverHomeId; spaceId = 'main'
        priorPointerReleaseId = $oldReleaseId; targetReleaseId = $goodReleaseId; targetBuildId = $goodCommit; hadDesktop = $true
        sessions = @(@{ id = $runningSessionId; pauseId = $recoverTargetPauseId })
    }
    [IO.File]::WriteAllText($switchStatePath, ($stoppingState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Stop-FixtureDesktopAndServer
    $recoverToTargetOut = Invoke-Script $hotSwitch @('-RuntimeRoot', $runtimeRoot, '-KikiHome', $homePath, '-Recover', '-StartupSeconds', '15')
    Assert-Contains ("Recovery complete: {0}" -f $goodReleaseId) $recoverToTargetOut '-Recover on stopping did not prefer targetReleaseId.'
    Assert-Equal $goodReleaseId ([string](Read-CurrentManifest).releaseId) '-Recover on stopping did not keep/select targetReleaseId in current.json.'
    $recoverTargetServer = Wait-ForFixtureServer $goodCommit 15
    Assert-Equal 'running' ([string](Read-FixtureExecution $recoverTargetServer $runningSessionId).phase) '-Recover to target did not resume paused session.'

    # -Recover when targetReleaseId is already running (e.g. user manually restarted) clears pauses without downgrading
    $manualTargetPauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
    Invoke-Fixture $recoverTargetServer 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $runningSessionId; service = 'sessionExecutionControl'; method = 'pause' }
        params = @(@{ operationId = $manualTargetPauseId })
    } | Out-Null
    $stoppingState.sessions = @(@{ id = $runningSessionId; pauseId = $manualTargetPauseId })
    [IO.File]::WriteAllText($switchStatePath, ($stoppingState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    $recoverRunningTargetOut = Invoke-Script $hotSwitch @('-RuntimeRoot', $runtimeRoot, '-KikiHome', $homePath, '-Recover', '-StartupSeconds', '15')
    Assert-Contains ("Recovery complete: {0}" -f $goodReleaseId) $recoverRunningTargetOut '-Recover with target already running failed.'
    Assert-Equal $goodReleaseId ([string](Read-CurrentManifest).releaseId) '-Recover with target already running altered current.json.'
    Assert-Equal 'running' ([string](Read-FixtureExecution $recoverTargetServer $runningSessionId).phase) '-Recover with target already running did not clear pause.'

    # -Recover -Rollback explicitly rolls back to oldReleaseId even when targetReleaseId is valid on 'stopping'
    $explicitRollbackState = [ordered]@{
        schemaVersion = 1; phase = 'stopping'; kikiHome = $homePath; oldReleaseId = $oldReleaseId; oldBuildId = $oldCommit
        oldServerId = $recoverTargetServer.instance.server_id; serverHomeId = $serverHomeId; spaceId = 'main'
        priorPointerReleaseId = $oldReleaseId; targetReleaseId = $goodReleaseId; targetBuildId = $goodCommit; hadDesktop = $true
        sessions = @()
    }
    [IO.File]::WriteAllText($switchStatePath, ($explicitRollbackState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Stop-FixtureDesktopAndServer
    $explicitRollbackOut = Invoke-Script $hotSwitch @('-RuntimeRoot', $runtimeRoot, '-KikiHome', $homePath, '-Recover', '-Rollback', '-StartupSeconds', '15')
    Assert-Contains ("Recovery complete: {0}" -f $oldReleaseId) $explicitRollbackOut '-Recover -Rollback did not roll back to oldReleaseId.'
    Assert-Equal $oldReleaseId ([string](Read-CurrentManifest).releaseId) '-Recover -Rollback did not restore current.json to oldReleaseId.'
    $explicitRollbackServer = Wait-ForFixtureServer $oldCommit 15

    # -Recover on starting_failed restores oldReleaseId
    $startingFailedState = [ordered]@{
        schemaVersion = 1; phase = 'starting_failed'; kikiHome = $homePath; oldReleaseId = $oldReleaseId; oldBuildId = $oldCommit
        oldServerId = $explicitRollbackServer.instance.server_id; serverHomeId = $serverHomeId; spaceId = 'main'
        priorPointerReleaseId = $oldReleaseId; targetReleaseId = $failedReleaseId; targetBuildId = $failedCommit; hadDesktop = $true
        sessions = @()
    }
    [IO.File]::WriteAllText($switchStatePath, ($startingFailedState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Stop-FixtureDesktopAndServer
    $recoverRollbackOut = Invoke-Script $hotSwitch @('-RuntimeRoot', $runtimeRoot, '-KikiHome', $homePath, '-Recover', '-StartupSeconds', '15')
    Assert-Contains ("Recovery complete: {0}" -f $oldReleaseId) $recoverRollbackOut '-Recover on starting_failed did not roll back to oldReleaseId.'
    Assert-Equal $oldReleaseId ([string](Read-CurrentManifest).releaseId) '-Recover on starting_failed did not restore current.json.'
    $rolledBackServer = Wait-ForFixtureServer $oldCommit 15

    # 5. Hung old server during stopping is bounded-stopped and switches cleanly to goodCandidate
    $hangFlag = Join-Path $homePath 'fixture-hang-on-update'
    [IO.File]::WriteAllText($hangFlag, 'hang')
    $hungOldPid = [int]$rolledBackServer.process.Id
    $hungOldInstanceFile = Join-Path (Join-Path $homePath 'server\instances') ($rolledBackServer.instance.server_id + '.json')
    try {
        $hungSwitchOut = Invoke-Script $hotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-CandidateRoot', $goodCandidate,
            '-ExpectedCommit', $goodCommit,
            '-SettleSeconds', '15',
            '-StopGraceSeconds', '2',
            '-StartupSeconds', '15'
        )
    } finally {
        if (Test-Path -LiteralPath $hangFlag) { Remove-Item -LiteralPath $hangFlag -Force }
    }
    Assert-Contains $goodReleaseId $hungSwitchOut 'Hung-server hot switch did not switch to goodCandidate.'
    Assert-Contains 'force-stopping original service' $hungSwitchOut 'Hung-server hot switch did not log bounded force-stop fallback.'
    $hungOldProc = Get-Process -Id $hungOldPid -ErrorAction SilentlyContinue
    if ($null -ne $hungOldProc) { Assert-True $hungOldProc.HasExited 'Hung old server was not force-stopped.' }
    Assert-True (-not (Test-Path -LiteralPath $hungOldInstanceFile -PathType Leaf)) 'Stale instance JSON of force-stopped old server was not cleaned up.'
    $afterHungServer = Wait-ForFixtureServer $goodCommit 15
    Assert-Equal $goodReleaseId ([string](Read-CurrentManifest).releaseId) 'Hung-server switch did not keep goodReleaseId current.'
    Assert-Equal 'running' ([string](Read-FixtureExecution $afterHungServer $runningSessionId).phase) 'Hung-server switch did not resume paused session.'
    Assert-Equal 'complete' ([string](Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json).phase) 'Hung-server switch did not complete hot-switch.json.'

    # 6. Auto-reconcile stale hot-switch.json on a new switch without requiring manual -Recover
    $stalePauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
    Invoke-Fixture $afterHungServer 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $runningSessionId; service = 'sessionExecutionControl'; method = 'pause' }
        params = @(@{ operationId = $stalePauseId })
    } | Out-Null
    $staleState = [ordered]@{
        schemaVersion = 1; phase = 'stopping'; kikiHome = $homePath; oldReleaseId = $oldReleaseId; oldBuildId = $oldCommit
        oldServerId = 'stale-server-id'; serverHomeId = $serverHomeId; spaceId = 'main'
        priorPointerReleaseId = $oldReleaseId; targetReleaseId = $goodReleaseId; targetBuildId = $goodCommit; hadDesktop = $true
        sessions = @(@{ id = $runningSessionId; pauseId = $stalePauseId })
    }
    [IO.File]::WriteAllText($switchStatePath, ($staleState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    $reconcileSwitchOut = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $oldCandidate,
        '-ExpectedCommit', $oldCommit,
        '-SettleSeconds', '15',
        '-StartupSeconds', '15'
    )
    Assert-Contains 'Reconciling stale hot-switch record' $reconcileSwitchOut 'New switch did not auto-reconcile stale hot-switch.json.'
    Assert-Contains $oldReleaseId $reconcileSwitchOut 'New switch after auto-reconcile did not switch to target release.'
    $afterReconcileServer = Wait-ForFixtureServer $oldCommit 15
    Assert-Equal 'running' ([string](Read-FixtureExecution $afterReconcileServer $runningSessionId).phase) 'Auto-reconciled switch did not leave session running.'
    Assert-Equal 'complete' ([string](Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json).phase) 'Auto-reconciled switch did not complete state.'

    # 7. Detached hot-switch promotes immediately BEFORE worker delay AND writes clean UTF-8 hot-switch.log
    $shortcutDesktopDir = Join-Path $testRoot 'DesktopShortcuts'
    Invoke-Script $controller @(
        '-Action', 'InstallShortcuts',
        '-RuntimeRoot', $runtimeRoot,
        '-CandidateRoot', $goodCandidate,
        '-DesktopPath', $shortcutDesktopDir,
        '-ExpectedCommit', $goodCommit
    ) | Out-Null
    $installedHotSwitch = Join-Path $runtimeRoot 'controller\desktop-hot-switch.ps1'
    Assert-True (Test-Path -LiteralPath $installedHotSwitch -PathType Leaf) 'InstallShortcuts did not sync desktop-hot-switch.ps1 into controller/.'
    $detachOutput = Invoke-Script $installedHotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-Detach',
        '-DetachDelaySeconds', '2',
        '-SettleSeconds', '15',
        '-StartupSeconds', '15'
    )
    Assert-Contains 'Detached hot-switch scheduled' $detachOutput 'Detached hot-switch did not schedule its Job-escaped worker.'
    Assert-Equal $goodReleaseId ([string](Read-CurrentManifest).releaseId) 'Detached hot-switch did not promote current.json BEFORE spawning the delayed worker.'
    $detachedServer = Wait-ForFixtureServer $goodCommit 25
    Assert-Equal $goodCommit ([string]$detachedServer.meta.build_id) 'Detached controller hot-switch did not switch to the settings.json candidate.'
    $detachWaitDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $detachWaitDeadline) {
        $detachState = Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json
        if ([string]$detachState.phase -eq 'complete') { break }
        Start-Sleep -Milliseconds 200
    }
    Assert-Equal 'complete' ([string](Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json).phase) 'Detached hot-switch did not complete its state record.'
    $detachLogPath = Join-Path $runtimeRoot 'hot-switch.log'
    Assert-ValidUtf8Log $detachLogPath $goodReleaseId 'Detached hot-switch.log was not clean UTF-8 or missed completion output.'

    # Detached failure also writes clean UTF-8 error message to hot-switch.log
    [IO.File]::WriteAllText($blockedExit, 'pending task')
    try {
        $detachFailOutput = Invoke-Script $installedHotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-CandidateRoot', $oldCandidate,
            '-ExpectedCommit', $oldCommit,
            '-Detach',
            '-DetachDelaySeconds', '1',
            '-SettleSeconds', '1',
            '-NoInterruptAfterSettle'
        )
        Assert-Contains 'Detached hot-switch scheduled' $detachFailOutput 'Detached failure test did not schedule worker.'
        $failLogDeadline = [DateTime]::UtcNow.AddSeconds(15)
        $sawStillSettling = $false
        while ([DateTime]::UtcNow -lt $failLogDeadline) {
            if (Test-Path -LiteralPath $detachLogPath -PathType Leaf) {
                $rawBytes = Read-SharedFileBytes $detachLogPath
                if ($rawBytes.Length -gt 0 -and (-not ($rawBytes -contains [byte]0))) {
                    $logText = (New-Object Text.UTF8Encoding($false, $true)).GetString($rawBytes)
                    if ($logText.Contains('Still settling')) { $sawStillSettling = $true; break }
                }
            }
            Start-Sleep -Milliseconds 200
        }
        Assert-True $sawStillSettling 'Detached failure worker did not log Still settling in clean UTF-8.'
        Assert-ValidUtf8Log $detachLogPath 'Still settling' 'Detached failure hot-switch.log was not valid UTF-8.'
        # Wait briefly for the detached worker process to release hot-switch.log before test cleanup
        $unlockDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([DateTime]::UtcNow -lt $unlockDeadline) {
            try {
                $probe = [IO.File]::Open($detachLogPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
                $probe.Dispose()
                break
            } catch {
                Start-Sleep -Milliseconds 100
            }
        }
    } finally {
        if (Test-Path -LiteralPath $blockedExit) { Remove-Item -LiteralPath $blockedExit -Force }
    }

    # 8. -InspectOnly + -CanaryCheck (passing and failing) + failed/resuming sessions + legacy releases\<id>\ -> active\ transition
    $failedServerCommit = -join (1..40 | ForEach-Object { '4' })
    $failedServerCandidate = New-Candidate 'candidate-failed-server' $failedServerCommit $false $true

    $inspectJsonRaw = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $oldCandidate,
        '-ExpectedCommit', $oldCommit,
        '-InspectOnly',
        '-CanaryCheck'
    )
    $inspectObj = $inspectJsonRaw | ConvertFrom-Json
    Assert-Equal $goodCommit ([string]$inspectObj.liveServer.build_id) '-InspectOnly did not report live build_id.'
    Assert-Equal 'active' ([string]$inspectObj.liveServer.layout) '-InspectOnly did not report active layout.'
    Assert-True ([bool]$inspectObj.candidate.valid) '-InspectOnly did not validate good candidate receipt.'
    Assert-True ([bool]$inspectObj.canary.passed) '-InspectOnly -CanaryCheck did not pass for healthy candidate.'

    # Failing -CanaryCheck aborts BEFORE reconciling stale hot-switch.json or touching live desktop or current.json!
    $liveBeforeCanaryFail = Wait-ForFixtureServer $goodCommit 10
    $manifestBeforeCanaryFail = [string](Read-CurrentManifest).releaseId
    $preCanaryPauseId = 'hot-switch:' + [guid]::NewGuid().ToString('N')
    Invoke-Fixture $liveBeforeCanaryFail 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $runningSessionId; service = 'sessionExecutionControl'; method = 'pause' }
        params = @(@{ operationId = $preCanaryPauseId })
    } | Out-Null
    $preCanaryStaleState = [ordered]@{
        schemaVersion = 1; phase = 'stopping'; kikiHome = $homePath; oldReleaseId = $oldReleaseId; oldBuildId = $oldCommit
        oldServerId = 'stale-before-canary'; serverHomeId = $serverHomeId; spaceId = 'main'
        priorPointerReleaseId = $oldReleaseId; targetReleaseId = $goodReleaseId; targetBuildId = $goodCommit; hadDesktop = $true
        sessions = @(@{ id = $runningSessionId; pauseId = $preCanaryPauseId })
    }
    [IO.File]::WriteAllText($switchStatePath, ($preCanaryStaleState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    $canaryFailOut = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $failedServerCandidate,
        '-ExpectedCommit', $failedServerCommit,
        '-CanaryCheck',
        '-SettleSeconds', '10',
        '-StartupSeconds', '10'
    ) 1
    Assert-Contains 'Canary check failed; live desktop was not modified' $canaryFailOut 'Failing -CanaryCheck did not abort cleanly.'
    $liveAfterCanaryFail = Wait-ForFixtureServer $goodCommit 10
    Assert-Equal ([int]$liveBeforeCanaryFail.process.Id) ([int]$liveAfterCanaryFail.process.Id) 'Failing -CanaryCheck disturbed the live server PID.'
    Assert-Equal $manifestBeforeCanaryFail ([string](Read-CurrentManifest).releaseId) 'Failing -CanaryCheck mutated current.json.'
    Assert-Equal 'paused' ([string](Read-FixtureExecution $liveAfterCanaryFail $runningSessionId).phase) 'Failing -CanaryCheck reconciled stale state and mutated live session pause!'
    Assert-Equal 'stopping' ([string](Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json).phase) 'Failing -CanaryCheck overwrote stale hot-switch.json!'
    $canaryFailReport = Get-Content -LiteralPath $switchReportPath -Raw | ConvertFrom-Json
    Assert-Equal $false ([bool]$canaryFailReport.canaryPassed) 'hot-switch-report.json did not record canaryPassed=false.'
    # Clean up the pre-canary test pause before continuing.
    Invoke-Fixture $liveAfterCanaryFail 'klient/call' @{
        procedure = @{ scope = 'session'; sessionId = $runningSessionId; service = 'sessionExecutionControl'; method = 'resume' }
        params = @(@{ operationId = "$preCanaryPauseId`:resume"; pauseOperationId = $preCanaryPauseId })
    } | Out-Null
    $preCanaryStaleState.phase = 'complete'
    [IO.File]::WriteAllText($switchStatePath, ($preCanaryStaleState | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

    # Multi-home guard: if another Kiki home is running from active\kiki-server.exe, abort BEFORE draining and do NOT kill the other home!
    $secondHome = Join-Path $testRoot 'second-home-active'
    [IO.Directory]::CreateDirectory($secondHome) | Out-Null
    [IO.File]::WriteAllText((Join-Path $secondHome 'server.local-owner'), $fixtureToken)
    $env:KIKI_HOME = $secondHome
    $secondActiveServer = $null
    try {
        $secondActiveServer = Start-Process -FilePath (Join-Path (Join-Path $runtimeRoot 'active') 'kiki-server.exe') -ArgumentList 'serve' -WindowStyle Hidden -PassThru
        Start-Sleep -Milliseconds 400
    } finally {
        $env:KIKI_HOME = $homePath
    }
    try {
        $multiHomeOut = Invoke-Script $hotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-CandidateRoot', $oldCandidate,
            '-ExpectedCommit', $oldCommit,
            '-SettleSeconds', '10',
            '-StartupSeconds', '10'
        ) 1
        Assert-Contains 'Another Kiki home/instance is running from active\kiki-server.exe' $multiHomeOut 'Multi-home active guard did not block switch before draining.'
        Assert-True (-not $secondActiveServer.HasExited) 'Multi-home guard killed another home''s active\kiki-server.exe!'
        $stillAlivePrimary = Wait-ForFixtureServer $goodCommit 5
        Assert-Equal ([int]$liveAfterCanaryFail.process.Id) ([int]$stillAlivePrimary.process.Id) 'Multi-home guard drained primary server.'
    } finally {
        if ($null -ne $secondActiveServer -and (-not $secondActiveServer.HasExited)) {
            try { $secondActiveServer.Kill(); $null = $secondActiveServer.WaitForExit(5000) } catch {}
        }
    }

    # Stale instance registration pointing to an unrelated live PID with mismatched start time must NOT cause cleanup to kill it.
    $staleReusedFile = Join-Path (Join-Path $homePath 'server\instances') 'stale-reused-pid.json'
    [IO.File]::WriteAllText($staleReusedFile, (@{
        server_id = 'stale-reused-pid'
        pid = [int]$unrelated.Id
        host = '127.0.0.1'
        port = 1
        started_at = 1000
        heartbeat_at = 1000
        build_id = $oldCommit
    } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))

    # Transition compatibility: start a legacy instance directly from releases\<oldReleaseId>\,
    # seed a persistent failed session AND a resuming session in work_pending:
    # (a) with -NoInterruptAfterSettle, failed session does NOT abort immediately and honors -NoInterruptAfterSettle at deadline;
    # (b) with default InterruptAfterSettle, failed + resuming switch cleanly with -CanaryCheck -> active\ without killing $unrelated.
    Stop-FixtureDesktopAndServer
    $legacyOldDir = Join-Path (Join-Path $runtimeRoot 'releases') $oldReleaseId
    $legacyLauncher = Start-Process -FilePath (Join-Path $legacyOldDir 'kiki-desktop.exe') -WorkingDirectory $legacyOldDir -PassThru
    $legacyServer = Wait-ForFixtureServer $oldCommit 15
    Assert-Equal (Join-Path $legacyOldDir 'kiki-server.exe') $legacyServer.process.Path 'Legacy fixture did not start from releases\<oldId>\.'

    $failedPendingFlag = Join-Path $homePath 'fixture-failed-pending'
    [IO.File]::WriteAllText($failedPendingFlag, '1')
    try {
        $noIntFailedOut = Invoke-Script $hotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-CandidateRoot', $goodCandidate,
            '-ExpectedCommit', $goodCommit,
            '-NoInterruptAfterSettle',
            '-SettleSeconds', '1',
            '-StartupSeconds', '15'
        ) 1
        Assert-Contains 'Session session-failed is failed; no pause needed.' $noIntFailedOut 'Failed session did not log non-aborting path.'
        Assert-Contains 'Still settling: session-failed' $noIntFailedOut '-NoInterruptAfterSettle did not honor server work_pending blocker.'
        Assert-True (-not $legacyServer.process.HasExited) '-NoInterruptAfterSettle stopped live server while work_pending was non-empty.'

        [IO.File]::WriteAllText((Join-Path $homePath 'fixture-resuming-pending'), '1')
        $migrateOut = Invoke-Script $hotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-CandidateRoot', $goodCandidate,
            '-ExpectedCommit', $goodCommit,
            '-CanaryCheck',
            '-SettleSeconds', '2',
            '-StartupSeconds', '15'
        )
    } finally {
        if (Test-Path -LiteralPath $failedPendingFlag) { Remove-Item -LiteralPath $failedPendingFlag -Force }
        if (Test-Path -LiteralPath $staleReusedFile) { Remove-Item -LiteralPath $staleReusedFile -Force }
    }
    Assert-Contains 'Canary check passed' $migrateOut 'Legacy->active migration did not run canary check.'
    Assert-Contains 'Session session-failed is failed; no pause needed.' $migrateOut 'Failed session in work_pending did not take the non-aborting path.'
    Assert-Contains 'Session session-resuming is resuming; waiting up to settle deadline.' $migrateOut 'Resuming session in work_pending did not wait cleanly.'
    Assert-True (-not $unrelated.HasExited) 'Cleanup terminated an unrelated process referenced by a stale instance registration!'
    $migratedServer = Wait-ForFixtureServer $goodCommit 15
    Assert-Equal (Join-Path (Join-Path $runtimeRoot 'active') 'kiki-server.exe') $migratedServer.process.Path 'Legacy->active migration did not launch new server from active\.'
    $migrateReport = Get-Content -LiteralPath $switchReportPath -Raw | ConvertFrom-Json
    Assert-Equal 'releases' ([string]$migrateReport.preSnapshot.server.layout) 'Migration report did not capture preSnapshot releases layout.'
    Assert-Equal 'active' ([string]$migrateReport.postServerMeta.layout) 'Migration report did not capture postServerMeta active layout.'
    Assert-Equal $true ([bool]$migrateReport.canaryPassed) 'Migration report did not record canaryPassed=true.'

    # Same-build legacy migration: running releases\<goodReleaseId>\ and switching to $goodCandidate MUST migrate to active\ (not no-op).
    Stop-FixtureDesktopAndServer
    $legacyGoodDir = Join-Path (Join-Path $runtimeRoot 'releases') $goodReleaseId
    $null = Start-Process -FilePath (Join-Path $legacyGoodDir 'kiki-desktop.exe') -WorkingDirectory $legacyGoodDir -PassThru
    $legacyGoodServer = Wait-ForFixtureServer $goodCommit 15
    Assert-Equal (Join-Path $legacyGoodDir 'kiki-server.exe') $legacyGoodServer.process.Path 'Same-build legacy fixture did not start from releases\<goodId>\.'
    $sameBuildMigrateOut = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $goodCandidate,
        '-ExpectedCommit', $goodCommit,
        '-SettleSeconds', '15',
        '-StartupSeconds', '15'
    )
    Assert-True (-not $sameBuildMigrateOut.Contains('Already running')) 'Same-build legacy migration wrongly short-circuited as Already running.'
    $migratedGoodServer = Wait-ForFixtureServer $goodCommit 15
    Assert-Equal (Join-Path (Join-Path $runtimeRoot 'active') 'kiki-server.exe') $migratedGoodServer.process.Path 'Same-build legacy migration did not move process to active\.'

    # 9. Out-of-band kiki-ops-conductor.mjs end-to-end switch against live compiled fixture
    $conductorScript = Join-Path $PSScriptRoot 'kiki-ops-conductor.mjs'
    $conductorRaw = & node $conductorScript switch --runtime-root $runtimeRoot --kiki-home $homePath --candidate-root $oldCandidate --expected-commit $oldCommit --settle-seconds 15 --startup-seconds 15 --json 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "kiki-ops-conductor.mjs switch exited with $LASTEXITCODE.`n$conductorRaw" }
    $conductorObj = $conductorRaw | ConvertFrom-Json
    Assert-True ([bool]$conductorObj.ok) 'kiki-ops-conductor.mjs switch did not return ok=true.'
    Assert-Equal $oldCommit ([string]$conductorObj.postSwitch.build_id) 'kiki-ops-conductor.mjs switch did not verify post-switch build_id.'
    Assert-Equal 'active' ([string]$conductorObj.postSwitch.layout) 'kiki-ops-conductor.mjs switch did not verify active layout.'
    Assert-True (Test-Path -LiteralPath (Join-Path $runtimeRoot 'hot-switch-ledger.json') -PathType Leaf) 'kiki-ops-conductor.mjs did not write hot-switch-ledger.json.'

    # 10. Multi-home end-to-end: two managed spaces (second path WITH spaces), AppScopeOnly inspect, partial shutdown failure recovery, and rollback.
    $secondSpaceHome = Join-Path $testRoot 'second space home'
    [IO.Directory]::CreateDirectory((Join-Path $secondSpaceHome 'server\instances')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $secondSpaceHome 'server.local-owner'), $fixtureToken)
    function Wait-ForSpaceServer([string]$SpaceHome, [string]$ExpectedCommit, [int]$TimeoutSeconds = 15) {
        $spaceInstances = Join-Path $SpaceHome 'server\instances'
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            foreach ($file in Get-ChildItem -LiteralPath $spaceInstances -Filter '*.json' -File -ErrorAction SilentlyContinue) {
                try {
                    $inst = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
                    $proc = Get-Process -Id ([int]$inst.pid) -ErrorAction Stop
                    $reply = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/meta" -f $inst.port) -Headers @{ Authorization = 'Bearer ' + $fixtureToken } -TimeoutSec 3
                    $replyBuildId = if ($null -ne $reply.data -and $null -ne $reply.data.PSObject.Properties['build_id']) { [string]$reply.data.build_id } else { '' }
                    if ($reply.code -eq 0 -and ([string]::IsNullOrEmpty($ExpectedCommit) -or $replyBuildId -ceq $ExpectedCommit)) {
                        return [pscustomobject]@{ instance = $inst; process = $proc; meta = $reply.data }
                    }
                } catch {}
            }
            Start-Sleep -Milliseconds 150
        }
        throw "Timed out waiting for fixture server in $SpaceHome with build_id $ExpectedCommit"
    }

    $activeDesktopPath = Join-Path (Join-Path $runtimeRoot 'active') 'kiki-desktop.exe'
    $null = Start-Process -FilePath $activeDesktopPath -WorkingDirectory (Split-Path -Parent $activeDesktopPath) -ArgumentList ('--home "' + $secondSpaceHome + '"') -PassThru
    $secondOldServer = Wait-ForSpaceServer $secondSpaceHome $oldCommit 15
    Assert-Equal $oldCommit ([string]$secondOldServer.meta.build_id) 'Secondary space with spaces in path did not start on old commit.'

    # 10a. -InspectOnly -AppScopeOnly must discover BOTH spaces without invoking per-session RPCs.
    $appScopeInspectRaw = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-InspectOnly',
        '-AppScopeOnly'
    ) 0
    $appScopeInspect = $appScopeInspectRaw | ConvertFrom-Json
    Assert-Equal 2 (@($appScopeInspect.spaces).Count) 'Multi-home -InspectOnly -AppScopeOnly did not discover both spaces.'
    Assert-Equal $true ([bool]$appScopeInspect.spaces[1].appScopeOnly) 'Secondary space inspect did not report appScopeOnly=true.'
    Assert-Equal 0 (@($appScopeInspect.spaces[1].workPendingSessions).Count) 'AppScopeOnly inspect should not populate per-session workPendingSessions.'

    # 10b. Partial shutdown failure: secondary rejects 'update' after primary accepts and exits -> must persist 'stopping' (NOT 'complete'), then -Recover converges BOTH spaces onto $goodCommit!
    $rejectFlag = Join-Path $secondSpaceHome 'fixture-reject-update'
    [IO.File]::WriteAllText($rejectFlag, '1')
    try {
        $partialFailOut = Invoke-Script $hotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-CandidateRoot', $goodCandidate,
            '-ExpectedCommit', $goodCommit,
            '-SettleSeconds', '15',
            '-StartupSeconds', '15'
        ) 1
        Assert-Contains 'Fixture rejected update shutdown' $partialFailOut 'Partial shutdown failure did not surface secondary update rejection.'
        $splitState = Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json
        Assert-Equal 'stopping' ([string]$splitState.phase) 'Partial shutdown failure did not keep phase=stopping for recovery!'
    } finally {
        if (Test-Path -LiteralPath $rejectFlag) { Remove-Item -LiteralPath $rejectFlag -Force }
    }

    $recoverMultiOut = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-Recover',
        '-StartupSeconds', '15'
    ) 0
    Assert-Contains "Recovery complete: $goodReleaseId" $recoverMultiOut 'Multi-home -Recover did not converge to target release.'
    $primaryGoodMulti = Wait-ForSpaceServer $homePath $goodCommit 15
    $secondGoodMulti = Wait-ForSpaceServer $secondSpaceHome $goodCommit 15
    Assert-Equal $goodCommit ([string]$primaryGoodMulti.meta.build_id) 'Primary home not on target commit after multi-home recovery.'
    Assert-Equal $goodCommit ([string]$secondGoodMulti.meta.build_id) 'Secondary home (with spaces in path) not on target commit after multi-home recovery.'

    # 10c. -Recover -Rollback on an unfinished switch record while BOTH homes are running on target MUST replace BOTH homes back onto $oldCommit (preserving quoted --home path with spaces)!
    $forcedUnfinished = Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json
    $forcedUnfinished.phase = 'resuming'
    [IO.File]::WriteAllText($switchStatePath, ($forcedUnfinished | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    $rollbackMultiOut = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-Recover',
        '-Rollback',
        '-StartupSeconds', '15'
    ) 0
    Assert-Contains "Recovery complete: $oldReleaseId" $rollbackMultiOut 'Multi-home -Recover -Rollback did not roll back to old release.'
    $primaryRolledBack = Wait-ForSpaceServer $homePath $oldCommit 15
    $secondRolledBack = Wait-ForSpaceServer $secondSpaceHome $oldCommit 15
    Assert-Equal $oldCommit ([string]$primaryRolledBack.meta.build_id) 'Primary home was not replaced with old commit on -Recover -Rollback.'
    Assert-Equal $oldCommit ([string]$secondRolledBack.meta.build_id) 'Secondary home (with spaces in path) was not replaced with old commit on -Recover -Rollback.'

    # 11. Headless Space Home end-to-end (e.g., Subtext daemon running active\kiki-server.exe serve --home ... --port <fixedPort> without kiki-desktop.exe):
    # Must discover it alongside GUI spaces, stop it cleanly via /api/shutdown, relaunch headlessly on the exact same port without spawning kiki-desktop.exe, and roll back cleanly on failed candidate!
    $headlessHome = Join-Path $testRoot 'headless space home'
    [IO.Directory]::CreateDirectory((Join-Path $headlessHome 'server\instances')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $headlessHome 'server.local-owner'), $fixtureToken)
    $portProbe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $portProbe.Start()
    $headlessFixedPort = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
    $portProbe.Stop()

    $activeServerPath = Join-Path (Join-Path $runtimeRoot 'active') 'kiki-server.exe'
    $headlessArgs = ('serve --home "{0}" --port {1} --headless-runtime-managed --heap-reexec' -f $headlessHome, $headlessFixedPort)
    $null = Start-Process -FilePath $activeServerPath -WorkingDirectory (Split-Path -Parent $activeServerPath) -ArgumentList $headlessArgs -WindowStyle Hidden -PassThru
    $headlessOldServer = Wait-ForSpaceServer $headlessHome '' 15
    Assert-Equal $headlessFixedPort ([int]$headlessOldServer.instance.port) 'Headless Space Home did not bind to its requested fixed port.'
    Assert-Equal $false ([bool]$headlessOldServer.meta.desktop_managed) 'Headless fixture server should report desktop_managed=false.'
    Assert-Equal $null ($headlessOldServer.meta.PSObject.Properties['build_id']) 'Initial headless server spawned without KIKI_BUILD_ID should omit build_id just like real kiki-server.'

    # 11a. -InspectOnly -AppScopeOnly must discover Primary GUI + Secondary GUI + Headless Space Home (3 total, including heap-reexec parent attribution and missing build_id under StrictMode).
    $headlessInspectRaw = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-InspectOnly',
        '-AppScopeOnly'
    ) 0
    $headlessInspect = $headlessInspectRaw | ConvertFrom-Json
    Assert-Equal 3 (@($headlessInspect.spaces).Count) 'Inspect did not discover primary + secondary GUI + headless Space Home.'
    $headlessSpaceInspect = @($headlessInspect.spaces | Where-Object { $_.kikiHome -ieq $headlessHome })[0]
    Assert-True ($null -ne $headlessSpaceInspect) 'Inspect output missing headless Space Home entry.'
    Assert-Equal $false ([bool]$headlessSpaceInspect.hadDesktop) 'Headless Space Home should report hadDesktop=false.'
    Assert-Equal $true ([bool]$headlessSpaceInspect.isHeadless) 'Headless Space Home should report isHeadless=true.'
    Assert-Equal $true ([bool]$headlessSpaceInspect.desktopManaged) 'Headless runtime-managed Space Home should preserve desktopManaged=true from lifecycle.managed.'
    Assert-Contains ("--port $headlessFixedPort") ([string]$headlessSpaceInspect.headlessLaunchArgs) 'Headless Space Home did not preserve original --port launch args.'

    # 11a2. Unfenced headless server (404 on /api/runtime-switch) MUST be rejected before draining unless -AllowUnfencedHeadless is passed.
    $noSwitchFlag = Join-Path $headlessHome 'fixture-no-runtime-switch'
    [IO.File]::WriteAllText($noSwitchFlag, '1')
    try {
        $unfencedFailOut = Invoke-Script $hotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-CandidateRoot', $goodCandidate,
            '-ExpectedCommit', $goodCommit,
            '-SettleSeconds', '15',
            '-StartupSeconds', '15'
        ) 1
        Assert-Contains 'admission fencing' $unfencedFailOut 'Unfenced headless server should be refused before draining.'
        $headlessStillOld = Wait-ForSpaceServer $headlessHome '' 10
        Assert-Equal $headlessOldServer.instance.server_id ([string]$headlessStillOld.meta.server_id) 'Refused unfenced headless switch must leave old server running untouched.'
    } finally {
        if (Test-Path -LiteralPath $noSwitchFlag) { Remove-Item -LiteralPath $noSwitchFlag -Force }
    }

    # 11b. Hot-switch ALL 3 spaces (2 GUI + 1 Headless with heap-reexec parent wrapper) onto $goodCommit!
    $headlessSwitchOut = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $goodCandidate,
        '-ExpectedCommit', $goodCommit,
        '-SettleSeconds', '15',
        '-StartupSeconds', '20'
    ) 0
    Assert-Contains "Running $goodReleaseId" $headlessSwitchOut 'Hot-switch with headless Space Home did not complete.'
    $headlessEvents = Get-Content -LiteralPath (Join-Path $headlessHome 'fixture-events.log') -Raw
    Assert-Contains 'fenced|' $headlessEvents 'Headless Space Home did not receive confirmed /api/runtime-switch fence before draining.'
    $primaryAfterHeadlessSwitch = Wait-ForSpaceServer $homePath $goodCommit 15
    $secondAfterHeadlessSwitch = Wait-ForSpaceServer $secondSpaceHome $goodCommit 15
    $headlessAfterSwitch = Wait-ForSpaceServer $headlessHome $goodCommit 15
    Assert-Equal $goodCommit ([string]$primaryAfterHeadlessSwitch.meta.build_id) 'Primary GUI space not on goodCommit after headless-included switch.'
    Assert-Equal $goodCommit ([string]$secondAfterHeadlessSwitch.meta.build_id) 'Secondary GUI space not on goodCommit after headless-included switch.'
    Assert-Equal $goodCommit ([string]$headlessAfterSwitch.meta.build_id) 'Headless Space Home not on goodCommit after switch.'
    Assert-Equal $headlessFixedPort ([int]$headlessAfterSwitch.instance.port) 'Headless Space Home did not retain its fixed port after switch!'
    Assert-Equal $activeServerPath ([string]$headlessAfterSwitch.process.Path) 'Headless Space Home not running from active\kiki-server.exe!'
    Assert-Equal $false ([bool]$headlessAfterSwitch.meta.desktop_managed) 'Headless Space Home lost its unmanaged headless mode after switch!'
    $headlessDesktopShells = @(Get-CimInstance Win32_Process -Filter "Name='kiki-desktop.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($headlessHome, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    Assert-Equal 0 $headlessDesktopShells.Count 'Hot-switch wrongly spawned a kiki-desktop.exe window for the headless Space Home!'

    # 11c. Recovery -Rollback MUST succeed even when the live replacement headless server is returning HTTP 500 on /api/meta!
    $brokenTargetHomeFlag = Join-Path $headlessHome 'fixture-fail-meta'
    $brokenRecoverState = Get-Content -LiteralPath $switchStatePath -Raw | ConvertFrom-Json
    $brokenRecoverState.phase = 'starting_failed'
    [IO.File]::WriteAllText($switchStatePath, ($brokenRecoverState | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    $oldHeadlessPidForBroken = [int]$headlessAfterSwitch.process.Id
    [IO.File]::WriteAllText($brokenTargetHomeFlag, '1')
    $flagCleaner = Start-Job -ScriptBlock {
        param($TargetPid, $FlagFile)
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($null -eq (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {
                if (Test-Path -LiteralPath $FlagFile) { Remove-Item -LiteralPath $FlagFile -Force -ErrorAction SilentlyContinue }
                break
            }
            Start-Sleep -Milliseconds 100
        }
    } -ArgumentList $oldHeadlessPidForBroken, $brokenTargetHomeFlag
    try {
        $brokenRecoverOkOut = Invoke-Script $hotSwitch @(
            '-RuntimeRoot', $runtimeRoot,
            '-KikiHome', $homePath,
            '-Recover',
            '-Rollback',
            '-StartupSeconds', '20'
        ) 0
        Assert-Contains "Recovery complete: $oldReleaseId" $brokenRecoverOkOut 'Recovery -Rollback failed to stop a live server whose /api/meta returned 500!'
        $headlessRecoveredOld = Wait-ForSpaceServer $headlessHome $oldCommit 15
        Assert-Equal $oldCommit ([string]$headlessRecoveredOld.meta.build_id) 'Headless space not restored to oldCommit after broken-/api/meta rollback!'
        Assert-Equal $headlessFixedPort ([int]$headlessRecoveredOld.instance.port) 'Headless space lost fixed port after broken-/api/meta rollback!'
    } finally {
        Wait-Job $flagCleaner -Timeout 5 | Out-Null
        Remove-Job $flagCleaner -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $brokenTargetHomeFlag) { Remove-Item -LiteralPath $brokenTargetHomeFlag -Force -ErrorAction SilentlyContinue }
    }

    # 11d. Automatic rollback when switching from oldCommit to $failedCandidate must restore ALL 3 spaces (including Headless Space Home on its exact fixed port) back onto $oldCommit!
    $headlessFailOut = Invoke-Script $hotSwitch @(
        '-RuntimeRoot', $runtimeRoot,
        '-KikiHome', $homePath,
        '-CandidateRoot', $failedCandidate,
        '-ExpectedCommit', $failedCommit,
        '-SettleSeconds', '15',
        '-StartupSeconds', '15'
    ) 1
    Assert-Contains 'Rolled back to previous release' $headlessFailOut 'Failed switch with headless Space Home did not trigger automatic rollback.'
    $primaryAfterHeadlessRollback = Wait-ForSpaceServer $homePath $oldCommit 15
    $secondAfterHeadlessRollback = Wait-ForSpaceServer $secondSpaceHome $oldCommit 15
    $headlessAfterRollback = Wait-ForSpaceServer $headlessHome $oldCommit 15
    Assert-Equal $oldCommit ([string]$primaryAfterHeadlessRollback.meta.build_id) 'Primary space not restored on rollback.'
    Assert-Equal $oldCommit ([string]$secondAfterHeadlessRollback.meta.build_id) 'Secondary GUI space not restored on rollback.'
    Assert-Equal $oldCommit ([string]$headlessAfterRollback.meta.build_id) 'Headless Space Home not restored on rollback.'
    Assert-Equal $headlessFixedPort ([int]$headlessAfterRollback.instance.port) 'Headless Space Home did not retain its fixed port after rollback!'

    $completed = $true
    Write-Output 'desktop-hot-switch tests passed: promote-first + manual restart, automatic starting rollback, target-preferred recovery, hung-server bounded force-stop, stale-state auto-reconcile, clean UTF-8 detached logging, inspect/canary, failed/resuming fix, legacy->active migration, kiki-ops-conductor, multi-home recovery/rollback with quoted spaces, and headless Space Home switch/rollback.'
}
finally {
    $env:KIKI_HOME = $originalKikiHome
    if ($null -eq $originalKikiBuildId) { Remove-Item Env:KIKI_BUILD_ID -ErrorAction SilentlyContinue } else { $env:KIKI_BUILD_ID = $originalKikiBuildId }
    if ($null -eq $originalKikiDesktopBundled) { Remove-Item Env:KIKI_DESKTOP_BUNDLED -ErrorAction SilentlyContinue } else { $env:KIKI_DESKTOP_BUNDLED = $originalKikiDesktopBundled }
    if ($null -eq $originalKikiRuntimeManaged) { Remove-Item Env:KIKI_RUNTIME_MANAGED -ErrorAction SilentlyContinue } else { $env:KIKI_RUNTIME_MANAGED = $originalKikiRuntimeManaged }
    # Close launchers before their servers. An open fixture window restarts a server that exits.
    Get-Process -Name 'kiki-desktop' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { try { $_.Kill() } catch {}; try { $null = $_.WaitForExit(5000) } catch {} }
    Stop-OwnFixtureServer
    Get-Process -Name 'kiki-desktop','kiki-server' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { try { $_.Kill() } catch {}; try { $null = $_.WaitForExit(5000) } catch {} }
    if ($completed) {
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    }
    else {
        Write-Warning "desktop-hot-switch fixture scratch retained at $testRoot"
    }
}
