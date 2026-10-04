/**
 * Kiki desktop shell: one user-facing window, an attach-or-spawn Kiki backend,
 * a system tray icon, close-to-tray, and approval notifications.
 *
 * The bounded shutdown and process-tree fallback follow LiveAgent's managed
 * process lifecycle at 00a2c6fc43754f40022b0703459824559bee73ea (MIT).
 * Kiki deliberately keeps only the single-child subset needed here and relies
 * on kap-server's own registry, token, and authenticated shutdown contracts.
 * Registry peers are attached only when their exact build identity matches;
 * every attached peer remains externally owned and is never stopped by Kiki.
 */
mod ssh_remote;
mod ssh_tunnel;
mod desktop_log;
mod space_badge;
mod space_shortcut;
mod remote_space;
use desktop_log::DesktopLogLevel;
include!("app_commands.rs");

macro_rules! command_handlers {
    ($($command:ident),* $(,)?) => {
        tauri::generate_handler![$($command),*]
    };
}

use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Receiver;
#[cfg(windows)]
use tauri::image::Image;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, Url, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent, TerminatedPayload},
    ShellExt,
};
use tauri_plugin_updater::UpdaterExt;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED},
    System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const RUNTIME_RECOVERY_ATTEMPTS: usize = 3;
const RUNTIME_RECOVERY_INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const RUNTIME_STABILITY_WINDOW: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const MAX_HTTP_STATUS_LINE_BYTES: usize = 256;
const MAX_META_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_SESSIONS_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const EXPECTED_SIDECAR_SERVER_VERSION: &str = env!("KIKI_SIDECAR_SERVER_VERSION");
const EXPECTED_SIDECAR_BUILD_ID: &str = env!("KIKI_SIDECAR_BUILD_ID");
const EXPECTED_SIDECAR_BUILD_CHANNEL: &str = env!("KIKI_SIDECAR_BUILD_CHANNEL");
const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("KIKI_UPDATER_PUBLIC_KEY");
const DISTRIBUTION: &str = env!("KIKI_DISTRIBUTION");
const STABLE_UPDATE_ENDPOINT: &str = "https://x-t-e-r.github.io/kiki/updater/stable/latest.json";
const BETA_UPDATE_ENDPOINT: &str = "https://x-t-e-r.github.io/kiki/updater/beta/latest.json";
const TRAY_ID: &str = "main-tray";
/// Subdirectory of a space home that holds that home's logs; kap-server writes
/// its own `kimi-code.log` beside the desktop backend log here.
const DESKTOP_LOG_DIR: &str = "logs";
/// Filename (under the home's log directory) the desktop backend's stderr is appended to.
const DESKTOP_BACKEND_LOG_FILE: &str = "desktop-backend.log";
/// In-memory stderr lines kept for startup-failure diagnostics.
const STDERR_TAIL_LINES: usize = 100;
/// Frontend event carrying a waiting phase or structured recovery failure.
const BACKEND_STAGE_EVENT: &str = "kiki://desktop-backend-stage";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConnection {
    url: String,
    token: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct InstanceRecord {
    #[serde(default, alias = "serverId")]
    server_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    pid: u32,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(alias = "startedAt")]
    started_at: u64,
    #[serde(default, alias = "heartbeatAt")]
    heartbeat_at: u64,
    #[serde(default)]
    workspaces: Vec<String>,
    #[serde(default)]
    build_id: Option<String>,
    #[serde(default)]
    build_channel: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InstanceCandidate {
    pid: u32,
    port: u16,
    started_at: u64,
    heartbeat_at: u64,
    workspaces: Vec<String>,
    build_id: Option<String>,
    build_channel: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MetaEnvelope {
    data: BackendIdentity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct BackendIdentity {
    server_version: String,
    #[serde(default)]
    build_id: Option<String>,
    #[serde(default)]
    build_channel: Option<String>,
}

/// Structured backend failure for the frontend's desktop failure card.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStartupFailure {
    message: String,
    stderr_tail: Vec<String>,
    log_path: Option<String>,
}

impl DesktopStartupFailure {
    fn plain(message: String) -> Self {
        Self {
            message,
            stderr_tail: Vec::new(),
            log_path: None,
        }
    }
}

impl From<String> for DesktopStartupFailure {
    fn from(message: String) -> Self {
        Self::plain(message)
    }
}

#[derive(Clone, Debug, Serialize)]
struct DesktopBackendFailureStage {
    stage: &'static str,
    failure: DesktopStartupFailure,
}

fn runtime_recovery_backoff(attempt: usize) -> Duration {
    RUNTIME_RECOVERY_INITIAL_BACKOFF * 2_u32.pow(attempt as u32)
}

/// Human phrasing of a sidecar exit status.
fn describe_exit(payload: &TerminatedPayload) -> String {
    match (payload.code, payload.signal) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("terminated by signal {signal}"),
        (None, None) => "no exit status reported".to_string(),
    }
}

/// The home's log directory: where the desktop backend log, and the server's
/// own `kimi-code.log`, live. "Open log folder" opens exactly this.
fn desktop_log_dir(home: &Path) -> PathBuf {
    home.join(DESKTOP_LOG_DIR)
}

/// The desktop backend's rotating stderr log inside the home's log directory.
fn desktop_backend_log_path(home: &Path) -> PathBuf {
    desktop_log_dir(home).join(DESKTOP_BACKEND_LOG_FILE)
}

/// Per-backend runtime diagnostics shared by the output pump and waiters:
/// the stderr tail, its on-disk log, and the sidecar's exit status.
struct BackendMonitor {
    /// Append target for stderr lines; `None` once writing is impossible.
    log: Mutex<Option<desktop_log::RotatingLog>>,
    log_path: Option<PathBuf>,
    /// Bounded rolling tail of the backend's stderr.
    stderr_tail: Mutex<VecDeque<String>>,
    /// Set once the sidecar reports Terminated (or its event stream closes).
    exit: Mutex<Option<TerminatedPayload>>,
}

impl BackendMonitor {
    /// Open the append log under `home`'s log directory; diagnostics stay in memory on failure.
    fn open(home: &Path) -> Self {
        let path = desktop_backend_log_path(home);
        let file = desktop_log::RotatingLog::open(&path, desktop_log::LOG_MAX_BYTES, desktop_log::LOG_BACKUPS).ok();
        let log_path = file.as_ref().map(|_| path);
        Self {
            log: Mutex::new(file),
            log_path,
            stderr_tail: Mutex::new(VecDeque::new()),
            exit: Mutex::new(None),
        }
    }
    /// Record one stderr line: rolling memory tail plus best-effort disk append.
    fn record_stderr_line(&self, line: &str) {
        if line.is_empty() {
            return;
        }
        if let Ok(mut tail) = self.stderr_tail.lock() {
            tail.push_back(line.to_string());
            while tail.len() > STDERR_TAIL_LINES {
                tail.pop_front();
            }
        }
        if let Ok(mut guard) = self.log.lock() {
            if let Some(file) = guard.as_mut() {
                if file.write_line(line).is_err() {
                    // Disk logging is a convenience, not a health dependency:
                    // stop retrying and keep the in-memory tail only.
                    *guard = None;
                }
            }
        }
    }

    fn set_exit(&self, payload: TerminatedPayload) {
        if let Ok(mut exit) = self.exit.lock() {
            *exit = Some(payload);
        }
    }

    /// The pump ended without a Terminated event; fail waiters fast regardless.
    fn ensure_exit(&self) {
        if let Ok(mut exit) = self.exit.lock() {
            if exit.is_none() {
                *exit = Some(TerminatedPayload {
                    code: None,
                    signal: None,
                });
            }
        }
    }

    fn exit(&self) -> Option<TerminatedPayload> {
        self.exit.lock().ok().and_then(|exit| exit.clone())
    }

    fn stderr_tail_lines(&self) -> Vec<String> {
        self.stderr_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn log_path_string(&self) -> Option<String> {
        self.log_path
            .as_ref()
            .map(|path| path.display().to_string())
    }

    /// A startup failure carrying the summary plus stderr tail and log path.
    fn startup_failure(&self, pid: u32, summary: String) -> DesktopStartupFailure {
        let stderr_tail = self.stderr_tail_lines();
        let mut message = format!("Kiki backend (pid {pid}) {summary}");
        if !stderr_tail.is_empty() {
            message.push_str(&format!(
                "\nstderr (last {} lines):\n{}",
                stderr_tail.len(),
                stderr_tail.join("\n")
            ));
        }
        if let Some(path) = &self.log_path_string() {
            message.push_str(&format!("\nlog file: {path}"));
        }
        DesktopStartupFailure {
            message,
            stderr_tail,
            log_path: self.log_path_string(),
        }
    }
}

/// Consume the sidecar's event stream for the lifetime of the process:
/// stderr is logged (warn+ via `--log-level warn` and runtime errors),
/// stdout is dropped (the ready line carries the bearer token), and a
/// Terminated event is recorded so startup waiters fail immediately.
fn spawn_backend_event_pump(
    mut events: Receiver<CommandEvent>,
    monitor: Arc<BackendMonitor>,
    manager: BackendManager,
    app: AppHandle,
    pid: u32,
    launched_at_ms: u64,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Some(CommandEvent::Stdout(_)) => {}
                Some(CommandEvent::Stderr(bytes)) => {
                    let line = String::from_utf8_lossy(&bytes);
                    monitor.record_stderr_line(line.trim_end_matches(['\n', '\r']));
                }
                Some(CommandEvent::Error(message)) => {
                    monitor.record_stderr_line(&format!("sidecar error: {message}"));
                }
                Some(CommandEvent::Terminated(payload)) => {
                    monitor.set_exit(payload);
                    break;
                }
                // CommandEvent is #[non_exhaustive]; future event kinds are
                // intentionally ignored by this diagnostics pump.
                Some(_) => {}
                None => {
                    monitor.ensure_exit();
                    break;
                }
            }
        }
        let exit = monitor
            .exit()
            .expect("backend event pump must record an exit");
        manager.handle_backend_exit(&app, pid, launched_at_ms, &exit);
    });
}

fn emit_backend_waiting(app: &AppHandle) {
    let _ = app.emit(BACKEND_STAGE_EVENT, "waiting");
}

fn emit_backend_failure(app: &AppHandle, failure: DesktopStartupFailure) {
    let _ = app.emit(
        BACKEND_STAGE_EVENT,
        DesktopBackendFailureStage {
            stage: "failed",
            failure,
        },
    );
}

struct OwnedBackend {
    child: CommandChild,
    pid: u32,
    launched_at_ms: u64,
    connection: Option<DesktopConnection>,
    ready_at: Option<Instant>,
    monitor: Arc<BackendMonitor>,
    home: PathBuf,
}

/// A spawned backend being waited on, cloned out of the manager's lock so the
/// readiness wait can run without holding it.
struct PendingBackend {
    pid: u32,
    launched_at_ms: u64,
    monitor: Arc<BackendMonitor>,
    home: PathBuf,
}

#[derive(Default)]
struct RuntimeRecoveryState {
    rapid_exit_count: usize,
    blocked: bool,
    generation: u64,
}

impl RuntimeRecoveryState {
    fn record_exit(&mut self, uptime: Duration) -> Option<u64> {
        self.generation += 1;
        if uptime >= RUNTIME_STABILITY_WINDOW {
            self.rapid_exit_count = 0;
        }
        self.rapid_exit_count += 1;
        if self.rapid_exit_count > RUNTIME_RECOVERY_ATTEMPTS {
            self.blocked = true;
            None
        } else {
            Some(self.generation)
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        !self.blocked && self.generation == generation
    }

    fn mark_failed(&mut self, generation: u64) -> bool {
        if self.generation != generation {
            return false;
        }
        self.blocked = true;
        true
    }

    fn reset(&mut self) {
        self.rapid_exit_count = 0;
        self.blocked = false;
        self.generation += 1;
    }
}

fn begin_runtime_recovery_transition<T>(
    backend: &mut Option<T>,
    recovery: &mut RuntimeRecoveryState,
    matches: impl FnOnce(&T) -> bool,
    uptime: impl FnOnce(&T) -> Duration,
) -> Option<(T, Option<u64>)> {
    let candidate = backend.as_ref()?;
    if !matches(candidate) {
        return None;
    }
    let uptime = uptime(candidate);
    let backend = backend
        .take()
        .expect("matched runtime backend must remain in its lifecycle slot");
    let recovery_generation = recovery.record_exit(uptime);
    Some((backend, recovery_generation))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendOwnership {
    None,
    External,
    Owned,
}

#[derive(Clone, Copy)]
enum OwnedBackendOperation {
    Restart,
}

impl OwnedBackendOperation {
    fn label(self) -> &'static str {
        "restart"
    }
}

#[derive(Default)]
struct BackendState {
    backend: Option<OwnedBackend>,
    attached: Option<DesktopConnection>,
    recovery: RuntimeRecoveryState,
}

impl BackendState {
    fn ownership(&self) -> BackendOwnership {
        if self.attached.is_some() {
            BackendOwnership::External
        } else if self.backend.is_some() {
            BackendOwnership::Owned
        } else {
            BackendOwnership::None
        }
    }
}

#[derive(Clone, Default)]
struct BackendManager {
    inner: Arc<Mutex<BackendState>>,
    home: Option<PathBuf>,
    idle_exit: bool,
}

impl BackendManager {
    fn for_home(home: PathBuf, idle_exit: bool) -> Self {
        Self { inner: Arc::new(Mutex::new(BackendState::default())), home: Some(home), idle_exit }
    }

    fn ownership(&self) -> Result<BackendOwnership, String> {
        self.inner
            .lock()
            .map(|state| state.ownership())
            .map_err(|_| "Kiki backend lifecycle lock was poisoned".to_string())
    }

    fn owned_backend_for(&self, operation: OwnedBackendOperation) -> Result<bool, String> {
        match self.ownership()? {
            BackendOwnership::Owned => Ok(true),
            BackendOwnership::None => Ok(false),
            BackendOwnership::External => Err(format!(
                "The connected Kiki daemon is externally managed; {} is unsupported from this desktop window",
                operation.label()
            )),
        }
    }

    fn hot_connection(&self) -> Option<DesktopConnection> {
        let state = self.inner.lock().ok()?;
        state.attached.clone().or_else(|| state.backend.as_ref().and_then(|backend| backend.connection.clone()))
    }

    fn connection(&self, app: &AppHandle) -> Result<DesktopConnection, DesktopStartupFailure> {
        if let Ok(mut state) = self.inner.lock() {
            if state.recovery.blocked {
                state.recovery.reset();
            }
        }
        self.connection_impl(app, None)
    }

    fn connection_for_recovery(
        &self,
        app: &AppHandle,
        recovery_generation: u64,
    ) -> Result<DesktopConnection, DesktopStartupFailure> {
        self.connection_impl(app, Some(recovery_generation))
    }

    fn connection_impl(
        &self,
        app: &AppHandle,
        recovery_generation: Option<u64>,
    ) -> Result<DesktopConnection, DesktopStartupFailure> {
        let home = self.home.as_ref().map_or_else(kiki_home_dir, |home| Ok(home.clone()))?;
        let runtime = resolve_runtime_paths_with_homes(&read_desktop_prefs_for(&home), &kimi_home_dir()?, &home)?;
        let current_workspace = env::current_dir().ok();

        let cached = self
            .inner
            .lock()
            .map_err(|_| {
                DesktopStartupFailure::plain("Kiki backend lifecycle lock was poisoned".to_string())
            })?
            .attached
            .clone();
        if let Some(connection) = cached {
            let port = connection_port(&connection)?;
            if authenticated_backend_identity(port, &connection.token)
                .is_ok_and(|identity| backend_identity_matches(&identity))
            {
                return Ok(connection);
            }
            self.clear_attached(&connection);
        }

        if let Some(connection) =
            discover_running_backend(&runtime.kiki_home, current_workspace.as_deref())?
        {
            if let Some(connection) = self.publish_attached(connection) {
                return Ok(connection);
            }
        }

        let pending = {
            let mut state = self.inner.lock().map_err(|_| {
                DesktopStartupFailure::plain("Kiki backend lifecycle lock was poisoned".to_string())
            })?;
            if recovery_generation.is_some_and(|generation| !state.recovery.is_current(generation))
            {
                return Err(DesktopStartupFailure::plain(
                    "Kiki backend runtime recovery was cancelled".to_string(),
                ));
            }
            if let Some(connection) = state.attached.as_ref() {
                return Ok(connection.clone());
            }
            let slot = &mut state.backend;

            if let Some(backend) = slot.as_ref() {
                if let Some(connection) = backend.connection.as_ref() {
                    if let Some(exit) = backend.monitor.exit() {
                        return Err(backend.monitor.startup_failure(
                            backend.pid,
                            format!("exited at runtime ({})", describe_exit(&exit)),
                        ));
                    }
                    return Ok(connection.clone());
                }
            }

            match slot.as_ref() {
                Some(backend) => PendingBackend {
                    pid: backend.pid,
                    launched_at_ms: backend.launched_at_ms,
                    monitor: backend.monitor.clone(),
                    home: backend.home.clone(),
                },
                None => {
                    let launched_at_ms = unix_epoch_millis()?;
                    let home = runtime.kiki_home.clone();
                    let level = read_desktop_prefs_for(&home).log_level;
                    let mut args = vec!["web", "--no-open", "--port", "0", "--log-level", level.as_str()];
                    if self.idle_exit { args.extend(["--idle-exit", "30m"]); }
                    let command = app
                        .shell()
                        .sidecar("kiki-server")
                        .map_err(|error| {
                            DesktopStartupFailure::plain(format!(
                                "Cannot resolve the packaged Kiki backend: {error}"
                            ))
                        })?
                        .args(args)
                        .env("KIKI_HOME", &runtime.kiki_home)
                        .env("KIKI_BUILD_ID", EXPECTED_SIDECAR_BUILD_ID)
                        .env("KIKI_BUILD_CHANNEL", EXPECTED_SIDECAR_BUILD_CHANNEL)
                        .env("KIKI_DESKTOP_BUNDLED", "1")
                        .env("KIKI_DESKTOP_OAUTH_HOME", &runtime.oauth_home);
                    let (events, child) = command.spawn().map_err(|error| {
                        DesktopStartupFailure::plain(format!(
                            "Cannot start the packaged Kiki backend: {error}"
                        ))
                    })?;
                    let pid = child.pid();
                    let monitor = Arc::new(BackendMonitor::open(&home));
                    *slot = Some(OwnedBackend {
                        child,
                        pid,
                        launched_at_ms,
                        connection: None,
                        ready_at: None,
                        monitor: monitor.clone(),
                        home: home.clone(),
                    });
                    spawn_backend_event_pump(
                        events,
                        monitor.clone(),
                        self.clone(),
                        app.clone(),
                        pid,
                        launched_at_ms,
                    );
                    emit_backend_waiting(app);
                    PendingBackend {
                        pid,
                        launched_at_ms,
                        monitor,
                        home,
                    }
                }
            }
        };

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Some(record) =
                find_instance_for_pid(&pending.home, pending.pid, pending.launched_at_ms)?
            {
                if let Some(token) = read_token(&pending.home)? {
                    let connection = DesktopConnection {
                        url: format!("http://127.0.0.1:{}", record.port),
                        token,
                    };
                    if let Ok(identity) =
                        authenticated_backend_identity(record.port, &connection.token)
                    {
                        if !backend_identity_matches(&identity) {
                            self.discard_backend(&pending);
                            return Err(pending.monitor.startup_failure(
                                pending.pid,
                                format!(
                                    "reported backend identity {} / {} / {}, but this desktop bundle expects {} / {} / {}. The packaged backend is stale or belongs to a different build; run `pnpm desktop:prepare` and rebuild Kiki.",
                                    identity.server_version,
                                    identity.build_id.as_deref().unwrap_or("missing build id"),
                                    identity.build_channel.as_deref().unwrap_or("missing channel"),
                                    EXPECTED_SIDECAR_SERVER_VERSION,
                                    EXPECTED_SIDECAR_BUILD_ID,
                                    EXPECTED_SIDECAR_BUILD_CHANNEL,
                                ),
                            ));
                        }
                        if let Some(connection) =
                            self.publish_owned_connection(&pending, &connection)
                        {
                            return Ok(connection);
                        }
                    }
                }
            }
            if let Some(exit) = pending.monitor.exit() {
                self.discard_backend(&pending);
                return Err(pending.monitor.startup_failure(
                    pending.pid,
                    format!("exited during startup ({})", describe_exit(&exit)),
                ));
            }
            if Instant::now() >= deadline {
                self.discard_backend(&pending);
                return Err(pending.monitor.startup_failure(
                    pending.pid,
                    format!(
                        "did not become ready within {} seconds",
                        STARTUP_TIMEOUT.as_secs()
                    ),
                ));
            }
            thread::sleep(STARTUP_POLL_INTERVAL);
        }
    }

    fn clear_attached(&self, connection: &DesktopConnection) {
        if let Ok(mut state) = self.inner.lock() {
            if state.attached.as_ref() == Some(connection) {
                state.attached = None;
            }
        }
    }

    fn publish_attached(&self, connection: DesktopConnection) -> Option<DesktopConnection> {
        let Ok(mut state) = self.inner.lock() else {
            return None;
        };
        if let Some(connection) = state.attached.as_ref() {
            return Some(connection.clone());
        }
        if state.backend.is_some() {
            return None;
        }
        state.attached = Some(connection.clone());
        Some(connection)
    }

    fn publish_owned_connection(
        &self,
        pending: &PendingBackend,
        connection: &DesktopConnection,
    ) -> Option<DesktopConnection> {
        let Ok(mut state) = self.inner.lock() else {
            return None;
        };
        let Some(backend) = state.backend.as_mut() else {
            return None;
        };
        if backend.pid != pending.pid
            || backend.launched_at_ms != pending.launched_at_ms
            || backend.monitor.exit().is_some()
        {
            return None;
        }
        if let Some(connection) = backend.connection.as_ref() {
            return Some(connection.clone());
        }
        backend.connection = Some(connection.clone());
        backend.ready_at = Some(Instant::now());
        Some(connection.clone())
    }

    fn handle_backend_exit(
        &self,
        app: &AppHandle,
        pid: u32,
        launched_at_ms: u64,
        exit: &TerminatedPayload,
    ) {
        if self.idle_exit && exit.code == Some(0) {
            let retired = self.take_backend_if(|candidate| {
                candidate.pid == pid && candidate.launched_at_ms == launched_at_ms
                    && candidate.connection.is_some()
                    && find_instance_for_pid(&candidate.home, pid, launched_at_ms).is_ok_and(|record| record.is_none())
            });
            if retired.is_some() {
                if let Ok(mut state) = self.inner.lock() { state.recovery.reset(); }
                return;
            }
        }
        let transition = {
            let mut state = self
                .inner
                .lock()
                .expect("backend lifecycle lock must not be poisoned");
            let BackendState {
                backend, recovery, ..
            } = &mut *state;
            begin_runtime_recovery_transition(
                backend,
                recovery,
                |candidate| {
                    candidate.pid == pid
                        && candidate.launched_at_ms == launched_at_ms
                        && candidate.connection.is_some()
                },
                |candidate| {
                    candidate
                        .ready_at
                        .expect("ready backend must record its ready instant")
                        .elapsed()
                },
            )
        };
        let Some((backend, recovery_generation)) = transition else {
            return;
        };
        let failure = backend.monitor.startup_failure(
            backend.pid,
            format!("exited at runtime ({})", describe_exit(exit)),
        );
        let Some(recovery_generation) = recovery_generation else {
            emit_backend_failure(app, failure);
            return;
        };
        self.spawn_runtime_recovery(app.clone(), recovery_generation);
    }

    fn spawn_runtime_recovery(&self, app: AppHandle, recovery_generation: u64) {
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut last_failure = None;
            for attempt in 0..RUNTIME_RECOVERY_ATTEMPTS {
                thread::sleep(runtime_recovery_backoff(attempt));
                if !manager
                    .inner
                    .lock()
                    .expect("backend lifecycle lock must not be poisoned")
                    .recovery
                    .is_current(recovery_generation)
                {
                    return;
                }
                match manager.connection_for_recovery(&app, recovery_generation) {
                    Ok(_) => return,
                    Err(failure) => {
                        if !manager
                            .inner
                            .lock()
                            .expect("backend lifecycle lock must not be poisoned")
                            .recovery
                            .is_current(recovery_generation)
                        {
                            return;
                        }
                        last_failure = Some(failure);
                    }
                }
            }
            if !manager
                .inner
                .lock()
                .expect("backend lifecycle lock must not be poisoned")
                .recovery
                .mark_failed(recovery_generation)
            {
                return;
            }
            emit_backend_failure(
                &app,
                last_failure.expect("runtime recovery must make at least one attempt"),
            );
        });
    }

    /// Kill the spawned backend iff the slot still holds this exact,
    /// not-yet-ready launch (another caller may have already discarded,
    /// cancelled, or replaced it).
    fn discard_backend(&self, pending: &PendingBackend) {
        if let Some(backend) = self.take_backend_if(|candidate| {
            candidate.pid == pending.pid
                && candidate.launched_at_ms == pending.launched_at_ms
                && candidate.connection.is_none()
        }) {
            force_stop(backend);
        }
    }

    /// Kill a spawned-but-not-ready backend — the user cancelled the wait.
    fn cancel_startup(&self) {
        let backend = self.inner.lock().ok().and_then(|mut state| {
            state.recovery.reset();
            if state
                .backend
                .as_ref()
                .is_some_and(|candidate| candidate.connection.is_none())
            {
                state.backend.take()
            } else {
                None
            }
        });
        if let Some(backend) = backend {
            force_stop(backend);
        }
    }

    fn take_backend_if(&self, matches: impl Fn(&OwnedBackend) -> bool) -> Option<OwnedBackend> {
        self.inner.lock().ok().and_then(|mut state| {
            if state.backend.as_ref().is_some_and(matches) {
                state.backend.take()
            } else {
                None
            }
        })
    }

    fn shutdown(&self) {
        let backend = self.inner.lock().ok().and_then(|mut state| {
            state.recovery.reset();
            state.attached = None;
            state.backend.take()
        });
        let Some(backend) = backend else {
            return;
        };

        if let Some(connection) = backend.connection.as_ref() {
            let _ = shutdown_request(connection);
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            while Instant::now() < deadline {
                let registered =
                    find_instance_for_pid(&backend.home, backend.pid, backend.launched_at_ms)
                        .ok()
                        .flatten()
                        .is_some();
                if !registered {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }

        force_stop(backend);
    }

    fn restart(&self, app: &AppHandle) -> Result<DesktopConnection, DesktopStartupFailure> {
        let owned = self
            .owned_backend_for(OwnedBackendOperation::Restart)
            .map_err(DesktopStartupFailure::plain)?;
        if owned {
            self.shutdown();
        }
        self.connection(app)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSpaceStatus {
    home_id: String,
    active: bool,
    hot: bool,
    pending_count: usize,
    busy_count: usize,
}

#[derive(Clone)]
struct SpaceBackendManager {
    inner: Arc<Mutex<SpaceBackendState>>,
}

struct SpaceBackendState {
    main: PathBuf,
    mode: WindowMode,
    active: String,
    epoch: u64,
    slots: HashMap<String, (DesktopSpace, BackendManager)>,
    attention: HashMap<String, HashSet<String>>,
    busy_counts: HashMap<String, usize>,
    restarting: HashSet<String>,
    unread_count: usize,
    stopping: bool,
}

impl SpaceBackendManager {
    fn new(startup: &Path, mode: WindowMode) -> Result<Self, String> {
        let main = main_home_for(startup)?;
        let main_space = DesktopSpace {
            home_id: "main".to_string(), name: "Main space".to_string(), color: None, preset: None,
            path: main.to_string_lossy().into_owned(), base_home: None, credentials_shared: true,
        };
        let mut slots = HashMap::new();
        slots.insert("main".to_string(), (main_space, BackendManager::for_home(main.clone(), false)));
        let active = if startup != main {
            let space = read_desktop_space(startup)?.ok_or("The selected home has no home.toml")?;
            if space.base_home.as_deref() != Some(main.to_string_lossy().as_ref()) {
                return Err("Space base does not match the main home".to_string());
            }
            let id = space.home_id.clone();
            slots.insert(id.clone(), (space, BackendManager::for_home(startup.to_path_buf(), mode == WindowMode::Switch && !has_enabled_cron(startup))));
            id
        } else { "main".to_string() };
        Ok(Self { inner: Arc::new(Mutex::new(SpaceBackendState {
            main, mode, active, epoch: 0, slots,
            attention: HashMap::new(), busy_counts: HashMap::new(), restarting: HashSet::new(), unread_count: 0, stopping: false,
        })) })
    }

    fn active_space(&self) -> Result<DesktopSpace, String> {
        let state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
        Ok(state.slots.get(&state.active).ok_or("Active space is unavailable")?.0.clone())
    }

    fn space_statuses(&self) -> Result<Vec<DesktopSpaceStatus>, String> {
        let state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
        Ok(state.slots.iter().map(|(id, (_, backend))| DesktopSpaceStatus {
            home_id: id.clone(),
            active: id == &state.active,
            hot: backend.hot_connection().is_some(),
            pending_count: state.attention.get(id).map(HashSet::len).unwrap_or(0),
            busy_count: *state.busy_counts.get(id).unwrap_or(&0),
        }).collect())
    }

    fn registered_spaces(&self) -> Result<Vec<DesktopSpace>, String> {
        let (main, primary) = {
            let state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
            (state.main.clone(), state.slots.get("main").ok_or("Main space is unavailable")?.0.clone())
        };
        let text = match fs::read_to_string(main.join("homes.json")) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![primary]),
            Err(error) => return Err(format!("Cannot read homes.json: {error}")),
        };
        let records: Vec<serde_json::Value> = serde_json::from_str(&text)
            .map_err(|error| format!("Invalid homes.json: {error}"))?;
        let mut spaces = vec![primary];
        for record in records {
            if let Some(id) = record.get("id").and_then(serde_json::Value::as_str) {
                if let Ok(space) = self.find_space(id) { spaces.push(space); }
            }
        }
        Ok(spaces)
    }

    fn active_backend(&self) -> Result<BackendManager, String> {
        let state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
        Ok(state.slots.get(&state.active).ok_or("Active space is unavailable")?.1.clone())
    }

    fn main_backend(&self) -> Result<BackendManager, String> {
        let state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
        Ok(state.slots.get("main").ok_or("Main space is unavailable")?.1.clone())
    }

    fn find_space(&self, id: &str) -> Result<DesktopSpace, String> {
        let state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
        if let Some((space, _)) = state.slots.get(id) { return Ok(space.clone()); }
        let text = fs::read_to_string(state.main.join("homes.json"))
            .map_err(|error| format!("Cannot read homes.json: {error}"))?;
        let records: Vec<serde_json::Value> = serde_json::from_str(&text)
            .map_err(|error| format!("Invalid homes.json: {error}"))?;
        for record in records {
            if record.get("id").and_then(serde_json::Value::as_str) != Some(id) { continue; }
            let path = record.get("path").and_then(serde_json::Value::as_str).ok_or("Space path is missing")?;
            if !Path::new(path).is_absolute() { return Err("Space path must be absolute".to_string()); }
            let space = read_desktop_space(Path::new(path))?.ok_or("Space home.toml is missing")?;
            if space.home_id != id || space.base_home.as_deref() != Some(state.main.to_string_lossy().as_ref()) {
                return Err("Space identity or base changed since registration".to_string());
            }
            return Ok(space);
        }
        Err(format!("Unknown space: {id}"))
    }

    fn backend_for(&self, space: DesktopSpace) -> Result<BackendManager, String> {
        let mut state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
        let id = space.home_id.clone();
        let switch_mode = state.mode == WindowMode::Switch;
        Ok(state.slots.entry(id).or_insert_with(|| {
            let home = PathBuf::from(&space.path);
            let idle_exit = switch_mode && space.home_id != "main" && !has_enabled_cron(&home);
            (space, BackendManager::for_home(home, idle_exit))
        }).1.clone())
    }

    fn switch(&self, app: &AppHandle, id: &str) -> Result<DesktopSpace, DesktopStartupFailure> {
        let space = self.find_space(id).map_err(DesktopStartupFailure::plain)?;
        let backend = self.backend_for(space.clone()).map_err(DesktopStartupFailure::plain)?;
        let epoch = {
            let mut state = self.inner.lock().map_err(|_| DesktopStartupFailure::plain("Space manager lock was poisoned".to_string()))?;
            if state.mode != WindowMode::Switch && state.active != id {
                return Err(DesktopStartupFailure::plain("Use open_space in multi-window mode".to_string()));
            }
            state.epoch += 1;
            state.epoch
        };
        backend.connection(app)?;
        let mut state = self.inner.lock().map_err(|_| DesktopStartupFailure::plain("Space manager lock was poisoned".to_string()))?;
        if state.epoch != epoch {
            return Err(DesktopStartupFailure::plain("A newer space switch replaced this request".to_string()));
        }
        if state.active != id { state.unread_count = 0; }
        state.active = id.to_string();
        Ok(space)
    }

    fn poll_attention(&self, app: &AppHandle) -> bool {
        let (mode, targets) = {
            let Ok(state) = self.inner.lock() else { return false; };
            if state.stopping { return false; }
            (state.mode, state.slots.iter().filter(|(id, _)| {
                if state.mode == WindowMode::Switch { *id != &state.active } else { *id == &state.active }
            }).map(|(id, (space, backend))| (id.clone(), space.clone(), backend.hot_connection()))
                .collect::<Vec<_>>())
        };
        for (id, space, connection) in targets {
            let result = match connection {
                Some(connection) => connection_port(&connection).and_then(|port|
                    http_get_body(port, "/api/sessions?include_ephemeral=true", &connection.token, MAX_SESSIONS_RESPONSE_BYTES)
                        .and_then(|response| parse_attention_response(&response))),
                None => Ok((HashSet::new(), 0)),
            };
            let Ok((pending, busy)) = result else { continue; };
            let (changed, newly_pending) = {
                let Ok(mut state) = self.inner.lock() else { return false; };
                if (mode == WindowMode::Switch && state.active == id) || (mode == WindowMode::Windows && state.active != id) { continue; }
                let previous = state.attention.insert(id.clone(), pending.clone()).unwrap_or_default();
                state.busy_counts.insert(id.clone(), busy);
                let newly_pending = pending.difference(&previous).count();
                (pending != previous, newly_pending)
            };
            if changed {
                let _ = app.emit("kiki://space-attention", serde_json::json!({"homeId": id, "count": pending.len()}));
                if let Ok(active) = self.active_space() { set_space_identity(app, &active); }
            }
            if mode == WindowMode::Switch && newly_pending > 0 && read_main_desktop_prefs(&main_home_for(Path::new(&space.path)).unwrap_or_else(|_| PathBuf::from(&space.path))).notifications {
                let _ = show_native_notification(app.clone(), format!("Kiki · {}", space.name),
                    Some(format!("{newly_pending} session(s) need your input")),
                    Some("/activity".to_string()), Some(id.clone()));
            }
        }
        true
    }

    fn restart_space(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let space = self.find_space(id)?;
        let backend = self.backend_for(space)?;
        {
            let mut state = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
            if state.active != "main" || id == "main" {
                return Err("Only the main space can restart a subspace".to_string());
            }
            if state.stopping || !state.restarting.insert(id.to_string()) {
                return Err("A space restart or shutdown is already in progress".to_string());
            }
        }
        let result = (|| {
            if !backend.owned_backend_for(OwnedBackendOperation::Restart)? {
                return Err("The space backend is not running".to_string());
            }
            let connection = backend.hot_connection().ok_or("The space backend is still starting")?;
            let port = connection_port(&connection)?;
            let response = http_get_body(port, "/api/sessions?include_ephemeral=true", &connection.token, MAX_SESSIONS_RESPONSE_BYTES)
                .map_err(|error| format!("Cannot check space sessions before restart: {error}"))?;
            let (pending, busy) = parse_attention_response(&response)
                .map_err(|error| format!("Cannot check space sessions before restart: {error}"))?;
            restart_space_readiness(busy, pending.len())?;
            backend.restart(app).map(|_| ()).map_err(|error| error.message)
        })();
        if let Ok(mut state) = self.inner.lock() { state.restarting.remove(id); }
        result
    }

    fn owned_spaces_with_work(&self) -> Result<Vec<String>, String> {
        let slots = self.inner.lock().map_err(|_| "Space manager lock was poisoned")?
            .slots.values().map(|(space, backend)| (space.clone(), backend.clone())).collect::<Vec<_>>();
        let mut names = Vec::new();
        for (space, backend) in slots {
            if backend.ownership()? != BackendOwnership::Owned { continue; }
            let Some(connection) = backend.hot_connection() else { continue; };
            let port = connection_port(&connection)?;
            let response = http_get_body(port, "/api/sessions?include_ephemeral=true", &connection.token, MAX_SESSIONS_RESPONSE_BYTES)?;
            let (pending, busy) = parse_attention_response(&response)?;
            if busy > 0 || !pending.is_empty() { names.push(space.name); }
        }
        Ok(names)
    }

    fn shutdown(&self) {
        let slots = self.inner.lock().ok().map(|mut state| {
            state.stopping = true;
            state.slots.values().map(|(_, backend)| backend.clone()).collect::<Vec<_>>()
        }).unwrap_or_default();
        for backend in slots { backend.shutdown(); }
    }
}

fn restart_space_readiness(busy: usize, pending: usize) -> Result<(), String> {
    if busy > 0 || pending > 0 {
        Err(format!("The space has {busy} running session(s) and {pending} pending interaction(s); finish them before restarting"))
    } else {
        Ok(())
    }
}

// This is called off the UI thread: the native dialog must never block the event loop.
fn confirm_backend_shutdown(app: &AppHandle, manager: &SpaceBackendManager, action: &str) -> bool {
    let prompt = match manager.owned_spaces_with_work() {
        Ok(spaces) if spaces.is_empty() => return true,
        Ok(spaces) => format!(
            "These spaces still have running sessions or pending input: {}. {action} will stop their owned backends. Continue?",
            spaces.join(", "),
        ),
        Err(error) => format!(
            "Kiki could not verify whether its backends have running sessions ({error}). {action} may interrupt work. Continue?",
        ),
    };
    app.dialog().message(prompt)
        .title("Kiki · Running sessions")
        .buttons(MessageDialogButtons::OkCancelCustom("Continue".into(), "Keep running".into()))
        .blocking_show()
}

fn has_enabled_cron(home: &Path) -> bool {
    let entries = match fs::read_dir(home.join("cron")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    for workspace in entries {
        let Ok(workspace) = workspace else { return true; };
        let tasks = match fs::read_dir(workspace.path()) {
            Ok(tasks) => tasks,
            Err(_) => return true,
        };
        for task in tasks {
            let Ok(task) = task else { return true; };
            if task.path().extension().and_then(|extension| extension.to_str()) != Some("json") { continue; }
            let record = fs::read_to_string(task.path()).ok().and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
            if !record.is_some_and(|record| record.get("paused").and_then(serde_json::Value::as_bool) == Some(true)) {
                return true;
            }
        }
    }
    false
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum CompatibilityHomeKind {
    #[default]
    Kimi,
    Kiki,
    Custom,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct CompatibilitySettings {
    home_kind: CompatibilityHomeKind,
    custom_home: Option<String>,
}

impl Default for CompatibilitySettings {
    fn default() -> Self {
        Self {
            home_kind: CompatibilityHomeKind::Kimi,
            custom_home: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSpace {
    home_id: String,
    name: String,
    color: Option<String>,
    preset: Option<String>,
    path: String,
    base_home: Option<String>,
    credentials_shared: bool,
}

fn read_desktop_space(home: &Path) -> Result<Option<DesktopSpace>, String> {
    let path = home.join("home.toml");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
    };
    let value: toml::Value = toml::from_str(&text).map_err(|error| format!("Invalid {}: {error}", path.display()))?;
    if value.get("schema").and_then(toml::Value::as_integer) != Some(1) {
        return Err("Unsupported space home.toml schema".to_string());
    }
    let id = value.get("id").and_then(toml::Value::as_str).ok_or("Space is missing an id")?;
    if !id.starts_with("h-") || id.len() <= 2 || !id.bytes().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-') {
        return Err("Invalid space id".to_string());
    }
    let preset = value.get("preset").map(|value| value.as_str().ok_or("Invalid space preset")).transpose()?;
    if preset.is_some_and(|id| id.is_empty() || id.len() > 64 || !id.as_bytes()[0].is_ascii_lowercase() || !id.bytes().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')) {
        return Err("Invalid space preset".to_string());
    }
    let defaults = space_shortcut::preset_metadata(preset.unwrap_or("kiki"))?;
    let name_value = value.get("name").or_else(|| defaults.get("name"));
    let name = name_value.and_then(toml::Value::as_str).filter(|name| !name.trim().is_empty()).ok_or("Space is missing a name")?;
    let color = value.get("color").or_else(|| defaults.get("color")).map(|value| {
        let color = value.as_str().ok_or("Invalid space color")?;
        if color.len() != 7 || !color.starts_with('#') || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) { return Err("Invalid space color"); }
        Ok(color.to_string())
    }).transpose()?;
    let base = value.get("base").and_then(toml::Value::as_str).map(PathBuf::from);
    if base.as_ref().is_some_and(|base| !base.is_absolute() || base == home) {
        return Err("Space base must be another absolute home".to_string());
    }
    let credentials_shared = value.get("inherit").and_then(|inherit| inherit.get("credentials"))
        .and_then(toml::Value::as_str) != Some("isolated");
    Ok(Some(DesktopSpace {
        home_id: id.to_string(),
        name: name.trim().to_string(),
        color,
        preset: preset.map(str::to_string),
        path: home.to_string_lossy().into_owned(),
        base_home: base.map(|path| path.to_string_lossy().into_owned()),
        credentials_shared,
    }))
}

struct RuntimePaths {
    kiki_home: PathBuf,
    config_path: PathBuf,
    oauth_home: PathBuf,
}

fn validate_compatibility_settings(settings: &CompatibilitySettings) -> Result<(), String> {
    match settings.home_kind {
        CompatibilityHomeKind::Custom => {
            let Some(path) = settings
                .custom_home
                .as_deref()
                .filter(|path| !path.trim().is_empty())
            else {
                return Err("Custom compatibility Home requires an absolute path".to_string());
            };
            if !Path::new(path).is_absolute() {
                return Err("Custom compatibility Home must be an absolute path".to_string());
            }
        }
        CompatibilityHomeKind::Kimi | CompatibilityHomeKind::Kiki => {}
    }
    Ok(())
}

fn selected_compatibility_home(
    settings: &CompatibilitySettings,
    kimi_home: &Path,
    kiki_home: &Path,
) -> Result<PathBuf, String> {
    validate_compatibility_settings(settings)?;
    match settings.home_kind {
        CompatibilityHomeKind::Kimi => Ok(kimi_home.to_path_buf()),
        CompatibilityHomeKind::Kiki => Ok(kiki_home.to_path_buf()),
        CompatibilityHomeKind::Custom => Ok(PathBuf::from(
            settings.custom_home.as_deref().unwrap_or_default(),
        )),
    }
}

fn resolve_runtime_paths(settings: &DesktopPrefs) -> Result<RuntimePaths, String> {
    let kimi_home = kimi_home_dir()?;
    let kiki_home = kiki_home_dir()?;
    resolve_runtime_paths_with_homes(settings, &kimi_home, &kiki_home)
}

fn resolve_runtime_paths_with_homes(
    settings: &DesktopPrefs,
    kimi_home: &Path,
    kiki_home: &Path,
) -> Result<RuntimePaths, String> {
    let space = read_desktop_space(kiki_home)?;
    let oauth_home = if let Some(space) = space.as_ref().filter(|space| !space.credentials_shared && space.base_home.is_some()) {
        PathBuf::from(&space.path)
    } else {
        let compatibility_kiki_home = space.as_ref().and_then(|space| space.base_home.as_deref())
            .map(Path::new).unwrap_or(kiki_home);
        selected_compatibility_home(&settings.compatibility, kimi_home, compatibility_kiki_home)?
    };
    Ok(RuntimePaths {
        kiki_home: kiki_home.to_path_buf(),
        config_path: kiki_home.join("config.toml"),
        oauth_home,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    fn build_default(value: Option<&str>) -> Self {
        if value == Some("beta") {
            Self::Beta
        } else {
            Self::Stable
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_UPDATE_ENDPOINT,
            Self::Beta => BETA_UPDATE_ENDPOINT,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum AutoUpdateMode {
    Off,
    Notify,
    Install,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WindowMode {
    #[default]
    Switch,
    Windows,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct DesktopPrefs {
    notifications: bool,
    close_to_tray: bool,
    /// UI locale mirrored from the frontend ("en"/"zh"); drives tray labels.
    locale: Option<String>,
    update_channel: UpdateChannel,
    auto_update: AutoUpdateMode,
    log_level: DesktopLogLevel,
    compatibility: CompatibilitySettings,
    #[serde(rename = "window_mode", alias = "windowMode")]
    window_mode: WindowMode,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            notifications: true,
            close_to_tray: true,
            locale: None,
            update_channel: UpdateChannel::build_default(option_env!("KIKI_UPDATE_CHANNEL")),
            auto_update: AutoUpdateMode::Notify,
            log_level: DesktopLogLevel::default(),
            compatibility: CompatibilitySettings::default(),
            window_mode: WindowMode::Switch,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopCloseAction {
    Hide,
    Minimize,
    Exit,
}

fn desktop_close_action(prefs: &DesktopPrefs, tray_created: bool, platform: &str) -> DesktopCloseAction {
    if !prefs.close_to_tray || !tray_created {
        DesktopCloseAction::Exit
    } else if platform == "linux" {
        // An AppIndicator object does not prove the desktop displays its icon.
        DesktopCloseAction::Minimize
    } else {
        DesktopCloseAction::Hide
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPrefsPatch {
    notifications: Option<bool>,
    close_to_tray: Option<bool>,
    locale: Option<String>,
    update_channel: Option<UpdateChannel>,
    auto_update: Option<AutoUpdateMode>,
    log_level: Option<DesktopLogLevel>,
    compatibility: Option<CompatibilitySettings>,
    #[serde(alias = "window_mode")]
    window_mode: Option<WindowMode>,
}

fn main_home_for(home: &Path) -> Result<PathBuf, String> {
    Ok(read_desktop_space(home)?.and_then(|space| space.base_home.map(PathBuf::from))
        .unwrap_or_else(|| home.to_path_buf()))
}

fn main_home_dir() -> Result<PathBuf, String> {
    main_home_for(&kiki_home_dir()?)
}

fn read_main_desktop_prefs(main: &Path) -> DesktopPrefs {
    if let Ok(raw) = fs::read_to_string(main.join("desktop.json")) {
        return serde_json::from_str(&raw).unwrap_or_default();
    }
    let legacy = kimi_home_dir().ok().map(|home| home.join("kiki").join("desktop.json"));
    match legacy.and_then(|path| fs::read_to_string(path).ok()) {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => DesktopPrefs::default(),
    }
}

fn read_desktop_prefs_for(home: &Path) -> DesktopPrefs {
    let main = match main_home_for(home) {
        Ok(main) => main,
        Err(_) => return DesktopPrefs::default(),
    };
    let mut prefs = read_main_desktop_prefs(&main);
    if home == main {
        return prefs;
    }
    if let Ok(raw) = fs::read_to_string(home.join("desktop.json")) {
        if let Ok(override_prefs) = serde_json::from_str::<DesktopPrefsPatch>(&raw) {
            prefs.notifications = override_prefs.notifications.unwrap_or(prefs.notifications);
            prefs.close_to_tray = override_prefs.close_to_tray.unwrap_or(prefs.close_to_tray);
            prefs.locale = override_prefs.locale.or(prefs.locale);
            prefs.log_level = override_prefs.log_level.unwrap_or(prefs.log_level);
            prefs.compatibility = override_prefs.compatibility.unwrap_or(prefs.compatibility);
        }
    }
    if read_desktop_space(home).ok().flatten().is_some_and(|space| !space.credentials_shared) {
        prefs.compatibility = CompatibilitySettings { home_kind: CompatibilityHomeKind::Kiki, custom_home: None };
    }
    prefs
}

fn read_desktop_prefs_file() -> DesktopPrefs {
    kiki_home_dir().map(|home| read_desktop_prefs_for(&home)).unwrap_or_default()
}

fn write_json_file(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

fn write_desktop_prefs_file(home: &Path, prefs: &DesktopPrefs, patch: &DesktopPrefsPatch) -> Result<(), String> {
    let main = main_home_for(home)?;
    if home == main {
        return write_json_file(&home.join("desktop.json"), prefs);
    }
    let path = home.join("desktop.json");
    let mut child = fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw).ok()).unwrap_or_default();
    if let Some(value) = patch.notifications { child.insert("notifications".to_string(), value.into()); }
    if let Some(value) = patch.close_to_tray { child.insert("closeToTray".to_string(), value.into()); }
    if let Some(value) = &patch.locale { child.insert("locale".to_string(), value.clone().into()); }
    if let Some(value) = &patch.compatibility { child.insert("compatibility".to_string(), serde_json::to_value(value).map_err(|error| error.to_string())?); }
    if let Some(value) = patch.log_level { child.insert("logLevel".to_string(), serde_json::to_value(value).map_err(|error| error.to_string())?); }
    if patch.notifications.is_some() || patch.close_to_tray.is_some() || patch.locale.is_some() || patch.compatibility.is_some() || patch.log_level.is_some() {
        write_json_file(&path, &child)?;
    }
    if patch.window_mode.is_some() || patch.update_channel.is_some() || patch.auto_update.is_some() {
        let mut main_prefs = read_main_desktop_prefs(&main);
        main_prefs.window_mode = patch.window_mode.unwrap_or(main_prefs.window_mode);
        main_prefs.update_channel = patch.update_channel.unwrap_or(main_prefs.update_channel);
        main_prefs.auto_update = patch.auto_update.unwrap_or(main_prefs.auto_update);
        write_json_file(&main.join("desktop.json"), &main_prefs)?;
    }
    Ok(())
}

#[tauri::command]
async fn desktop_connection(
    app: AppHandle,
    manager: State<'_, SpaceBackendManager>,
) -> Result<DesktopConnection, DesktopStartupFailure> {
    let backend = manager.active_backend().map_err(DesktopStartupFailure::plain)?;
    tauri::async_runtime::spawn_blocking(move || backend.connection(&app))
        .await
        .map_err(|error| {
            DesktopStartupFailure::plain(format!("Kiki backend startup task failed: {error}"))
        })?
}

#[tauri::command]
fn desktop_active_space(manager: State<'_, SpaceBackendManager>) -> Result<DesktopSpace, String> {
    manager.active_space()
}

#[tauri::command]
fn desktop_space_statuses(manager: State<'_, SpaceBackendManager>) -> Result<Vec<DesktopSpaceStatus>, String> {
    manager.space_statuses()
}

#[tauri::command]
fn set_unread_count(app: AppHandle, manager: State<'_, SpaceBackendManager>, n: u32) -> Result<(), String> {
    let total = {
        let mut state = manager.inner.lock().map_err(|_| "Space manager lock was poisoned")?;
        state.unread_count = n as usize;
        combined_space_attention(state.unread_count, &state.active, &state.attention)
    };
    set_unread_overlay(&app, total);
    Ok(())
}

#[cfg(windows)]
fn unread_overlay_icon(pending: usize) -> Option<Image<'static>> {
    let rgba = space_badge::render(pending)?;
    Some(Image::new_owned(rgba, space_badge::OVERLAY_SIZE, space_badge::OVERLAY_SIZE))
}

fn combined_space_attention(current: usize, active: &str, attention: &HashMap<String, HashSet<String>>) -> usize {
    attention.iter().filter(|(id, _)| id.as_str() != active)
        .fold(current, |sum, (_, sessions)| sum.saturating_add(sessions.len()))
}

fn set_unread_overlay(app: &AppHandle, total: usize) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        let _ = window.set_overlay_icon(unread_overlay_icon(total));
        #[cfg(not(windows))]
        let _ = window.set_badge_count((total > 0).then_some(total.min(i64::MAX as usize) as i64));
    }
}

fn set_space_identity(app: &AppHandle, space: &DesktopSpace) {
    let title = if space.home_id == "main" { "Kiki".to_string() } else { format!("Kiki · {}", space.name) };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&title);
        if let Some(manager) = app.try_state::<SpaceBackendManager>() {
            if let Ok(state) = manager.inner.lock() {
                let total = combined_space_attention(state.unread_count, &state.active, &state.attention);
                set_unread_overlay(app, total);
            }
        }
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&title));
        let labels = tray_labels(read_desktop_prefs_for(Path::new(&space.path)).locale.as_deref());
        if let Ok(menu) = build_tray_menu(app, labels) { let _ = tray.set_menu(Some(menu)); }
    }
}

fn reload_space_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(manager) = app.try_state::<SpaceBackendManager>() {
            if let Ok(space) = manager.active_space() { set_space_identity(app, &space); }
        }
        window.eval("window.location.reload()").map_err(|error| error.to_string())?;
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

#[cfg(windows)]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow<Wry>) -> tauri::Result<()> {
    window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;

        let result = webview.controller().CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
            .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false));
        if let Err(error) = result {
            eprintln!("Kiki could not disable WebView2 browser accelerator keys: {error}");
        }
    })
}

fn notification_action_opens(action: &str) -> bool {
    matches!(action, "default" | "open")
}

static PENDING_NAVIGATION_INTENT: Mutex<Option<serde_json::Value>> = Mutex::new(None);

#[tauri::command]
fn take_navigation_intent() -> Option<serde_json::Value> {
    PENDING_NAVIGATION_INTENT.lock().ok()?.take()
}

fn notification_navigation_intent(route: &str, home_id: Option<&str>) -> serde_json::Value {
    serde_json::json!({ "route": route, "homeId": home_id })
}

fn deliver_notification_click(app: &AppHandle, route: &str, home_id: Option<&str>) {
    let intent = notification_navigation_intent(route, home_id);
    if let Ok(mut pending) = PENDING_NAVIGATION_INTENT.lock() { *pending = Some(intent.clone()); }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    // The live Router owns guard, source capture and scope commit. A booting
    // page consumes the same intent without inventing a predecessor.
    let _ = app.emit("kiki://notification-click", intent);
}

fn show_native_notification(app: AppHandle, title: String, body: Option<String>, route: Option<String>, home_id: Option<String>) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.summary(&title).body(body.as_deref().unwrap_or(""));
    if route.is_some() { notification.action("open", "Open Kiki"); }
    #[cfg(windows)]
    if let Ok(exe) = env::current_exe() {
        let directory = exe.parent().map(|path| path.to_string_lossy().replace('\\', "/"));
        if !directory.as_deref().is_some_and(|path| path.ends_with("/target/debug") || path.ends_with("/target/release")) {
            notification.app_id(&app.config().identifier);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() { "com.apple.Terminal" } else { &app.config().identifier });
        if let Some(route) = route {
            let handle = notify_rust::NotificationHandle::new(notification.finalize());
            thread::spawn(move || handle.wait_for_action(|action| {
                if notification_action_opens(action) { deliver_notification_click(&app, &route, home_id.as_deref()); }
            }));
            return Ok(());
        }
    }
    let handle = notification.show().map_err(|error| format!("Cannot show desktop notification: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    if let Some(route) = route {
        thread::spawn(move || handle.wait_for_action(|action| {
            if notification_action_opens(action) { deliver_notification_click(&app, &route, home_id.as_deref()); }
        }));
    }
    #[cfg(target_os = "macos")]
    let _ = handle;
    Ok(())
}

#[tauri::command]
async fn send_desktop_notification(app: AppHandle, title: String, body: Option<String>, route: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show_native_notification(app, title, body, route, None))
        .await.map_err(|error| format!("Notification task failed: {error}"))?
}

#[tauri::command]
async fn prepare_space(app: AppHandle, manager: State<'_, SpaceBackendManager>, home_id: String) -> Result<DesktopSpace, DesktopStartupFailure> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.switch(&app, &home_id))
        .await.map_err(|error| DesktopStartupFailure::plain(format!("Space startup task failed: {error}")))?
}

#[tauri::command]
async fn switch_space(app: AppHandle, manager: State<'_, SpaceBackendManager>, home_id: String) -> Result<DesktopSpace, DesktopStartupFailure> {
    let manager = manager.inner().clone();
    let app_for_switch = app.clone();
    let space = tauri::async_runtime::spawn_blocking(move || manager.switch(&app_for_switch, &home_id))
        .await.map_err(|error| DesktopStartupFailure::plain(format!("Space startup task failed: {error}")))??;
    reload_space_window(&app).map_err(DesktopStartupFailure::plain)?;
    Ok(space)
}

#[tauri::command]
async fn restart_space(app: AppHandle, manager: State<'_, SpaceBackendManager>, home_id: String) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.restart_space(&app, &home_id))
        .await.map_err(|error| format!("Space restart task failed: {error}"))?
}

#[tauri::command]
async fn create_space_shortcut(manager: State<'_, SpaceBackendManager>, home_id: String) -> Result<space_shortcut::SpaceShortcut, space_shortcut::ShortcutFailure> {
    if !cfg!(windows) {
        return Err(space_shortcut::ShortcutFailure::new("unsupported_platform", "Desktop space shortcuts are currently supported only on Windows"));
    }
    let space = manager.find_space(&home_id).map_err(|error| space_shortcut::ShortcutFailure::new("invalid_space", error))?;
    tauri::async_runtime::spawn_blocking(move || space_shortcut::create(&space.home_id, &space.name, Path::new(&space.path)))
        .await.map_err(|error| space_shortcut::ShortcutFailure::new("shortcut_failed", error.to_string()))?
}

#[tauri::command]
async fn open_space(app: AppHandle, manager: State<'_, SpaceBackendManager>, home_id: Option<String>, connection_id: Option<String>) -> Result<(), String> {
    let mode = manager.inner.lock().map_err(|_| "Space manager lock was poisoned")?.mode;
    if let Some(id) = connection_id {
        if home_id.is_some() { return Err("Select a local home or a remote connection, not both".to_string()); }
        if mode != WindowMode::Windows { return Err("Remote windows require windows mode".to_string()); }
        let source = manager.active_space()?;
        let exe = env::current_exe().map_err(|error| error.to_string())?;
        remote_space::command(&exe, Path::new(&source.path), &id)?.spawn()
            .map_err(|error| format!("Cannot open remote space window: {error}"))?;
        return Ok(());
    }
    let home_id = home_id.ok_or("A local home or remote connection is required")?;
    let space = manager.find_space(&home_id)?;
    if mode == WindowMode::Switch {
        let manager = manager.inner().clone();
        let app_for_switch = app.clone();
        tauri::async_runtime::spawn_blocking(move || manager.switch(&app_for_switch, &home_id))
            .await.map_err(|error| error.to_string())?.map_err(|error| error.message)?;
        reload_space_window(&app)?;
        return Ok(());
    }
    let exe = env::current_exe().map_err(|error| error.to_string())?;
    std::process::Command::new(exe).arg("--home").arg(&space.path).spawn()
        .map_err(|error| format!("Cannot open space window: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn list_ssh_profiles() -> Result<Vec<ssh_remote::SshProfile>, String> {
    tauri::async_runtime::spawn_blocking(|| ssh_remote::read_profiles(&ssh_remote::config_path()?))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_ssh_profile(profile: ssh_remote::SshProfile) -> Result<Vec<ssh_remote::SshProfile>, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_remote::save_profile(&ssh_remote::config_path()?, profile))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn remove_ssh_profile(id: String) -> Result<Vec<ssh_remote::SshProfile>, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_remote::remove_profile(&ssh_remote::config_path()?, &id))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn connect_ssh_profile(
    id: String,
    token: String,
    window: tauri::WebviewWindow,
    spaces: State<'_, SpaceBackendManager>,
    manager: State<'_, ssh_tunnel::TunnelManager>,
) -> Result<ssh_tunnel::SshResolvedConnection, String> {
    let manager = manager.inner().clone();
    let home_id = spaces.active_space()?.home_id;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let profiles = ssh_remote::read_profiles(&ssh_remote::config_path()?)?;
        let profile = profiles.iter().find(|profile| profile.id == id)
            .ok_or_else(|| "SSH profile no longer exists".to_string())?;
        let connection = manager.connect(profile, &token)?;
        manager.bind(&id, &connection.tunnel_id, &home_id, &label)?;
        Ok(connection)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn prepare_ssh_profile(id: String, token: String, window: tauri::WebviewWindow,
    spaces: State<'_, SpaceBackendManager>, manager: State<'_, ssh_tunnel::TunnelManager>) -> Result<ssh_tunnel::SshResolvedConnection, String> {
    let manager = manager.inner().clone();
    let home_id = spaces.active_space()?.home_id;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let profiles = ssh_remote::read_profiles(&ssh_remote::config_path()?)?;
        let profile = profiles.iter().find(|profile| profile.id == id).ok_or("SSH profile no longer exists")?;
        manager.prepare(profile, &token, &home_id, &label)
    }).await.map_err(|error| error.to_string())?
}

#[derive(Clone)]
struct ScopeConnectionReference { home_id: String, profile_id: String, tunnel_id: String, window_label: String }
static PENDING_SCOPE_CONNECTION: Mutex<Option<ScopeConnectionReference>> = Mutex::new(None);

fn resolve_scope_reference(reference: &ScopeConnectionReference, manager: &ssh_tunnel::TunnelManager) -> Result<serde_json::Value, String> {
    let profiles = ssh_remote::read_profiles(&ssh_remote::config_path()?)?;
    let profile = profiles.iter().find(|profile| profile.id == reference.profile_id).ok_or("SSH profile no longer exists")?;
    if !manager.profile_matches(profile, &reference.tunnel_id) { return Err("SSH profile identity changed".to_string()); }
    let connection = manager.resume(&reference.profile_id, &reference.tunnel_id, &reference.home_id, &reference.window_label)?;
    if profile.server_home_id.as_deref() != Some(connection.server_home_id.as_str()) { return Err("SSH server identity changed".to_string()); }
    Ok(serde_json::json!({ "profile": profile, "connection": connection }))
}

#[tauri::command]
fn resume_scope_connection(home_id: String, id: String, tunnel_id: String, window: tauri::WebviewWindow,
    spaces: State<'_, SpaceBackendManager>, manager: State<'_, ssh_tunnel::TunnelManager>) -> Result<serde_json::Value, String> {
    if spaces.active_space()?.home_id != home_id { return Err("Space identity changed".to_string()); }
    resolve_scope_reference(&ScopeConnectionReference { home_id, profile_id: id, tunnel_id, window_label: window.label().to_string() }, &manager)
}

#[tauri::command]
fn commit_scope_connection(home_id: String, id: String, tunnel_id: String, reload: bool, window: tauri::WebviewWindow,
    spaces: State<'_, SpaceBackendManager>, manager: State<'_, ssh_tunnel::TunnelManager>) -> Result<(), String> {
    if spaces.active_space()?.home_id != home_id { return Err("Space identity changed".to_string()); }
    let reference = ScopeConnectionReference { home_id, profile_id: id, tunnel_id, window_label: window.label().to_string() };
    resolve_scope_reference(&reference, &manager)?;
    manager.commit(&reference.profile_id, &reference.tunnel_id, &reference.home_id, &reference.window_label)?;
    let mut pending = PENDING_SCOPE_CONNECTION.lock().map_err(|_| "Scope handoff unavailable")?;
    *pending = reload.then_some(reference);
    Ok(())
}

#[tauri::command]
fn take_scope_connection(window: tauri::WebviewWindow, spaces: State<'_, SpaceBackendManager>,
    manager: State<'_, ssh_tunnel::TunnelManager>) -> Result<Option<serde_json::Value>, String> {
    let mut pending = PENDING_SCOPE_CONNECTION.lock().map_err(|_| "Scope handoff unavailable")?;
    let Some(reference) = pending.as_ref() else { return Ok(None); };
    if reference.window_label != window.label() || reference.home_id != spaces.active_space()?.home_id { return Err("Scope handoff identity changed".to_string()); }
    let resolved = resolve_scope_reference(reference, &manager)?;
    *pending = None;
    Ok(Some(resolved))
}

#[tauri::command]
async fn ssh_tunnel_running(id: String, tunnel_id: String, manager: State<'_, ssh_tunnel::TunnelManager>) -> Result<bool, String> {
    let manager = manager.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || manager.is_running(&id, &tunnel_id)).await.unwrap_or(false))
}

#[tauri::command]
async fn disconnect_ssh_profile(id: String, tunnel_id: String, manager: State<'_, ssh_tunnel::TunnelManager>) -> Result<(), String> {
    let manager = manager.inner().clone();
    let _ = tauri::async_runtime::spawn_blocking(move || manager.disconnect(&id, &tunnel_id)).await;
    Ok(())
}

/// Kill a spawned-but-not-ready backend: the user cancelled the boot wait.
#[tauri::command]
fn cancel_desktop_startup(manager: State<'_, SpaceBackendManager>) {
    if let Ok(backend) = manager.active_backend() { backend.cancel_startup(); }
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn write_host_file_text(
    path: PathBuf,
    text: String,
    manager: State<'_, SpaceBackendManager>,
) -> Result<(), String> {
    let backend = manager.active_backend()?;
    tauri::async_runtime::spawn_blocking(move || backend.write_host_file_text(&path, &text))
        .await
        .map_err(|error| format!("Kiki host-file task failed: {error}"))?
}

/// Narrow host-opener pair behind the session/file context menus. Both spawn
/// the platform shell without waiting: `explorer` exits non-zero even on
/// success, so spawn success is the whole contract. Shell interaction stays
/// off the main thread, so every command dispatches on a blocking worker.
#[tauri::command]
async fn reveal_host_path(
    path: PathBuf,
    manager: State<'_, SpaceBackendManager>,
) -> Result<(), String> {
    let backend = manager.active_backend()?;
    tauri::async_runtime::spawn_blocking(move || backend.reveal_host_path(&path))
        .await
        .map_err(|error| format!("Kiki host-path task failed: {error}"))?
}

#[tauri::command]
async fn open_host_path(
    path: PathBuf,
    manager: State<'_, SpaceBackendManager>,
) -> Result<(), String> {
    let backend = manager.active_backend()?;
    tauri::async_runtime::spawn_blocking(move || backend.open_host_path(&path))
        .await
        .map_err(|error| format!("Kiki host-path task failed: {error}"))?
}

/// Open an http(s) URL in the system browser. Renderer `window.open` is
/// unreliable in the desktop webview (wry rejects unhandled new-window
/// requests), so device-code sign-in routes through this command instead.
/// Only plain `http:`/`https:` URLs pass — every other scheme stays closed.
#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http(s) URLs can be opened".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || open_url_in_browser(&url))
        .await
        .map_err(|error| format!("Kiki open-url task failed: {error}"))?
}

/// The same shell launch `open_with_default_app` uses, but for a URL: the
/// opener resolves the default browser and returns after spawn, without
/// waiting for the browser process to exit.
#[cfg(target_os = "windows")]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb = wide_null(std::ffi::OsStr::new("open"));
    let file = wide_null(std::ffi::OsStr::new(url));
    // SAFETY: both pointers are NUL-terminated UTF-16 buffers that outlive the
    // call; the rest are null. ShellExecuteW with the "open" verb is callable
    // from any thread.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Per MSDN, a return value of 32 or less is an error code, not a handle.
    if (result as usize) <= 32 {
        return Err(format!("Cannot open {url}: shell error {}", result as usize));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Cannot open {url}: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Cannot open {url}: {error}"))?;
    Ok(())
}

/// What the caller intends to do with a host path: writes tolerate a missing
/// final component, and `open` additionally refuses executable files.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HostPathOp {
    Open,
    Reveal,
    Write,
}

impl BackendManager {
    fn open_host_path(&self, path: &Path) -> Result<(), String> {
        check_host_path(path, HostPathOp::Open)?;
        open_with_default_app(path)
    }

    fn reveal_host_path(&self, path: &Path) -> Result<(), String> {
        check_host_path(path, HostPathOp::Reveal)?;
        reveal_in_file_manager(path)
    }

    fn write_host_file_text(&self, path: &Path, text: &str) -> Result<(), String> {
        check_host_path(path, HostPathOp::Write)?;
        write_host_file_text_authorized(path, text)
    }
}

/// The whole boundary host-path commands share on this local single-user
/// shell: plain absolute local drive paths only (no UNC, device, or verbatim
/// prefix), and `open` additionally refuses executable files the platform
/// shell would RUN rather than view. Every one of these actions is initiated
/// by the user from a context menu or preview, so there is no workspace-root
/// containment check and no grant prompt.
fn check_host_path(path: &Path, op: HostPathOp) -> Result<(), String> {
    reject_remote_or_device_host_path(path)?;
    if op == HostPathOp::Open && is_executable_host_path(path) {
        return Err(format!(
            "Refusing to open executable host path {}",
            path.display()
        ));
    }
    if !path.is_absolute() {
        return Err("Host path must be absolute".to_string());
    }
    #[cfg(unix)]
    if op == HostPathOp::Open {
        if let Ok(target) = fs::canonicalize(path) {
            if is_executable_host_path(&target) {
                return Err(format!("Refusing to open executable host path {}", path.display()));
            }
        }
    }
    Ok(())
}

/// The write itself; only reachable after `check_host_path`.
fn write_host_file_text_authorized(path: &Path, text: &str) -> Result<(), String> {
    fs::write(path, text)
        .map_err(|error| format!("Cannot write host file {}: {error}", path.display()))
}

/// Stock Windows associations execute scripts, shortcuts and installers.
/// Reveal and write do not invoke these associations and remain allowed.
const WINDOWS_EXECUTABLE_HOST_EXTENSIONS: &[&str] = &[
    "exe", "com", "pif", "scr", "cpl", "msi", "msp", "msc", "bat", "cmd", "ps1", "vbs", "vbe",
    "js", "jse", "wsf", "wsh", "hta", "lnk", "reg", "url", "chm", "application",
    "settingcontent-ms",
];

fn is_executable_host_path(path: &Path) -> bool {
    is_executable_host_path_for(path, env::consts::OS)
}

fn is_executable_host_path_for(path: &Path, platform: &str) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    // Only ShellExecuteW strips trailing dots/spaces before association lookup.
    let file_name = if platform == "windows" {
        file_name.trim_matches(|c| c == '.' || c == ' ')
    } else {
        file_name
    };
    let Some(extension) = file_name.rsplit_once('.').map(|(_, extension)| extension) else {
        return false;
    };
    let extensions: &[&str] = match platform {
        "windows" => WINDOWS_EXECUTABLE_HOST_EXTENSIONS,
        // Launch Services launches .app bundles and Terminal handles .command.
        "macos" => &["app", "command"],
        // xdg-open delegates to desktop handlers, some of which launch Exec/DBus.
        "linux" => &["desktop"],
        _ => &[],
    };
    extensions.iter().any(|denied| extension.eq_ignore_ascii_case(denied))
}

/// UNC (`\\server\share`), device-namespace (`\\.\…`), and verbatim (`\\?\…`)
/// paths are refused outright: verbatim prefixes skip path normalization,
/// device paths would let a write touch raw disks, and UNC leaves the local
/// trust zone. Only plain `C:\…` drive paths carry a prefix on Windows; other
/// platforms have no prefix component and pass through.
fn reject_remote_or_device_host_path(path: &Path) -> Result<(), String> {
    use std::path::{Component, Prefix};
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return Ok(());
    };
    match prefix.kind() {
        Prefix::Disk(_) => Ok(()),
        _ => Err(format!(
            "Host path {} must be a plain local drive path (no UNC, device, or verbatim prefix)",
            path.display()
        )),
    }
}

#[cfg(target_os = "windows")]
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    // `explorer /select,` mangles forward slashes (server paths arrive both
    // ways), commas, and trailing dots, and silently opens the wrong folder on
    // failure. Parse a PIDL and ask the shell to select the item instead —
    // the same mechanism Electron/VS Code use.
    use windows_sys::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};
    let mut text = path.to_string_lossy().replace('/', "\\");
    if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
        text = format!("\\\\{rest}");
    } else if let Some(rest) = text.strip_prefix("\\\\?\\") {
        text = rest.to_string();
    }
    let wide = wide_null(std::ffi::OsStr::new(&text));
    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives both
    // calls; the returned PIDL is owned by us and freed with ILFree.
    let pidl = unsafe { ILCreateFromPathW(wide.as_ptr()) };
    if pidl.is_null() {
        return Err(format!("Cannot reveal host path {}", path.display()));
    }
    let result = unsafe { SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0) };
    unsafe { ILFree(pidl) };
    if result < 0 {
        return Err(format!(
            "Cannot reveal host path {}: shell error {result}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Cannot reveal host path {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    // No portable "select this file" on Linux; open the containing folder.
    let folder = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("Cannot reveal host path {}: {error}", path.display()))?;
    Ok(())
}

/// NUL-terminated UTF-16 view of an OS string — the shape every Win32 W API
/// expects. Plain transcoding: no quoting, no escaping, no shell anywhere in
/// the pipeline.
#[cfg(target_os = "windows")]
fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn open_with_default_app(path: &Path) -> Result<(), String> {
    // ShellExecuteW resolves the file association directly — no cmd.exe
    // intermediary, so `& | < > ^ %` in the path are bytes, not shell syntax.
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb = wide_null(std::ffi::OsStr::new("open"));
    let file = wide_null(path.as_os_str());
    // SAFETY: both pointers are NUL-terminated UTF-16 buffers that outlive the
    // call; the rest are null. ShellExecuteW with the "open" verb is callable
    // from any thread.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Per MSDN, a return value of 32 or less is an error code, not a handle.
    if (result as usize) <= 32 {
        return Err(format!(
            "Cannot open host path {}: shell error {}",
            path.display(),
            result as usize
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_with_default_app(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Cannot open host path {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_default_app(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Cannot open host path {}: {error}", path.display()))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLogInfo {
    directory: String,
    backend_log_path: String,
    max_bytes: u64,
    backups: usize,
    log_level: DesktopLogLevel,
    applies_on_next_launch: bool,
}

#[tauri::command]
fn desktop_log_info(manager: State<'_, SpaceBackendManager>) -> Result<DesktopLogInfo, String> {
    let home = PathBuf::from(manager.active_space()?.path);
    Ok(DesktopLogInfo {
        directory: desktop_log_dir(&home).to_string_lossy().into_owned(),
        backend_log_path: desktop_backend_log_path(&home).to_string_lossy().into_owned(),
        max_bytes: desktop_log::LOG_MAX_BYTES,
        backups: desktop_log::LOG_BACKUPS,
        log_level: read_desktop_prefs_for(&home).log_level,
        applies_on_next_launch: true,
    })
}

#[tauri::command]
async fn open_desktop_log_directory(manager: State<'_, SpaceBackendManager>) -> Result<(), String> {
    let home = PathBuf::from(manager.active_space()?.path);
    let dir = desktop_log_dir(&home);
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        check_host_path(&dir, HostPathOp::Open)?;
        open_with_default_app(&dir)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_desktop_prefs(manager: State<'_, SpaceBackendManager>) -> DesktopPrefs {
    manager.active_space().map(|space| read_desktop_prefs_for(Path::new(&space.path)))
        .unwrap_or_else(|_| read_desktop_prefs_file())
}

#[tauri::command]
fn write_desktop_prefs(app: AppHandle, manager: State<'_, SpaceBackendManager>, prefs: DesktopPrefsPatch) -> Result<(), String> {
    let home = PathBuf::from(manager.active_space()?.path);
    let current = read_desktop_prefs_for(&home);
    let locale_changed = prefs.locale.is_some() && prefs.locale != current.locale;
    let patch = prefs.clone();
    let next = DesktopPrefs {
        notifications: prefs.notifications.unwrap_or(current.notifications),
        close_to_tray: prefs.close_to_tray.unwrap_or(current.close_to_tray),
        locale: prefs.locale.or(current.locale),
        update_channel: prefs.update_channel.unwrap_or(current.update_channel),
        auto_update: prefs.auto_update.unwrap_or(current.auto_update),
        log_level: prefs.log_level.unwrap_or(current.log_level),
        compatibility: prefs.compatibility.unwrap_or(current.compatibility),
        window_mode: prefs.window_mode.unwrap_or(current.window_mode),
    };
    validate_compatibility_settings(&next.compatibility)?;
    if read_desktop_space(&home)?.is_some_and(|space| space.base_home.is_some() && !space.credentials_shared) && patch.compatibility.is_some() && next.compatibility.home_kind != CompatibilityHomeKind::Kiki {
        return Err("Isolated spaces must use their own OAuth home".to_string());
    }
    write_desktop_prefs_file(&home, &next, &patch)?;
    // The frontend owns the UI locale; mirror it onto the tray menu live.
    if locale_changed {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let menu = build_tray_menu(&app, tray_labels(next.locale.as_deref()))?;
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateInfo {
    current_version: String,
    version: String,
    date: Option<String>,
    notes: Option<String>,
}

fn desktop_updates_supported_for(distribution: &str, public_key: Option<&str>) -> bool {
    distribution == "github" && public_key.is_some_and(|key| !key.is_empty())
}

fn desktop_updates_supported() -> bool {
    desktop_updates_supported_for(DISTRIBUTION, UPDATER_PUBLIC_KEY)
}

#[tauri::command]
fn supports_desktop_updates() -> bool {
    desktop_updates_supported()
}

fn desktop_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    if !desktop_updates_supported() {
        return Err("Desktop updater is not available for this distribution".to_string());
    }
    let public_key = UPDATER_PUBLIC_KEY.expect("supported updater has a public key");
    let endpoint = Url::parse(read_desktop_prefs_file().update_channel.endpoint())
        .map_err(|error| error.to_string())?;
    app.updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_desktop_update(app: AppHandle) -> Result<Option<DesktopUpdateInfo>, String> {
    Ok(desktop_updater(&app)?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .map(|update| DesktopUpdateInfo {
            current_version: update.current_version,
            version: update.version,
            date: update.date.map(|date| date.to_string()),
            notes: update.body,
        }))
}

#[tauri::command]
async fn install_desktop_update(app: AppHandle) -> Result<(), String> {
    let update = desktop_updater(&app)?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No desktop update is available".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn prepare_for_update(app: AppHandle, manager: State<'_, SpaceBackendManager>) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !confirm_backend_shutdown(&app, &manager, "Installing the update") {
            return Err("Update cancelled; running sessions continue".to_string());
        }
        manager.shutdown();
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn restart_server(
    app: AppHandle,
    manager: State<'_, SpaceBackendManager>,
) -> Result<DesktopConnection, DesktopStartupFailure> {
    let backend = manager.active_backend().map_err(DesktopStartupFailure::plain)?;
    tauri::async_runtime::spawn_blocking(move || backend.restart(&app))
        .await
        .map_err(|error| {
            DesktopStartupFailure::plain(format!("Kiki backend restart task failed: {error}"))
        })?
}

fn kimi_home_dir() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("KIKI_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".kimi-code"))
        .ok_or_else(|| "Cannot resolve the current user's home directory".to_string())
}

fn requested_home(args: &[String]) -> Result<Option<PathBuf>, String> {
    let mut selected = None;
    let mut index = 1;
    while index < args.len() {
        if args[index] == "--home" {
            let path = args.get(index + 1).ok_or("--home requires an absolute directory")?;
            if selected.is_some() || !Path::new(path).is_absolute() {
                return Err("--home requires one absolute directory".to_string());
            }
            selected = Some(PathBuf::from(path));
            index += 1;
        }
        index += 1;
    }
    Ok(selected)
}

fn kiki_home_dir() -> Result<PathBuf, String> {
    if let Some(path) = requested_home(&env::args().collect::<Vec<_>>())? {
        return Ok(path);
    }
    if let Some(path) = env::var_os("KIKI_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    default_kiki_home_dir()
}

fn default_kiki_home_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".kiki"))
        .ok_or_else(|| "Cannot resolve Kiki Home for the current user".to_string())
}

fn unix_epoch_millis() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| "Current time does not fit in milliseconds".to_string())
}

fn read_instance_records(home: &Path) -> Result<Vec<InstanceRecord>, String> {
    let directories = [
        home.join("server").join("instances"),
        home.join("instances"),
    ];
    let mut records = Vec::new();
    for instances in directories {
        let entries = match fs::read_dir(&instances) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Cannot read Kiki's server registry at {}: {error}",
                    instances.display()
                ))
            }
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<InstanceRecord>(&raw) else {
                continue;
            };
            records.push(record);
        }
    }
    Ok(records)
}

fn read_discoverable_instance_records(
    home: &Path,
    is_alive: impl Fn(u32) -> bool,
) -> Result<Vec<InstanceRecord>, String> {
    let directories = [
        home.join("server").join("instances"),
        home.join("instances"),
    ];
    let mut records = Vec::new();
    for instances in directories {
        let entries = match fs::read_dir(&instances) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Cannot read Kiki's server registry at {}: {error}",
                    instances.display()
                ))
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let record = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<InstanceRecord>(&raw).ok());
            let valid = record
                .as_ref()
                .is_some_and(|record| instance_candidate(record.clone()).is_some());
            let alive = record.as_ref().is_some_and(|record| is_alive(record.pid));
            if !valid || !alive {
                if let Err(error) = fs::remove_file(&path) {
                    if error.kind() != io::ErrorKind::NotFound {
                        eprintln!(
                            "Kiki could not prune invalid server instance record {}: {error}",
                            path.display()
                        );
                    }
                }
                continue;
            }
            records.push(record.expect("validated instance record must exist"));
        }
    }
    Ok(records)
}

fn remove_owned_instance_records(home: &Path, pid: u32, launched_at_ms: u64) {
    for instances in [
        home.join("server").join("instances"),
        home.join("instances"),
    ] {
        let Ok(entries) = fs::read_dir(instances) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<InstanceRecord>(&raw) else {
                continue;
            };
            if record.pid == pid && record.started_at >= launched_at_ms {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn find_instance_for_pid(
    home: &Path,
    pid: u32,
    launched_at_ms: u64,
) -> Result<Option<InstanceCandidate>, String> {
    Ok(select_instance_for_pid(
        read_instance_records(home)?,
        pid,
        launched_at_ms,
    ))
}

fn discover_running_backend(
    home: &Path,
    current_workspace: Option<&Path>,
) -> Result<Option<DesktopConnection>, String> {
    let Some(token) = read_token(home)? else {
        return Ok(None);
    };
    for candidate in rank_instance_candidates(
        read_discoverable_instance_records(home, pid_alive)?,
        current_workspace,
        |_| true,
    ) {
        if candidate.build_id.as_deref() != Some(EXPECTED_SIDECAR_BUILD_ID)
            || candidate.build_channel.as_deref() != Some(EXPECTED_SIDECAR_BUILD_CHANNEL)
        {
            eprintln!(
                "Kiki skipped backend pid {} on port {}: registry build identity {} / {} does not match {} / {}",
                candidate.pid,
                candidate.port,
                candidate.build_id.as_deref().unwrap_or("missing build id"),
                candidate
                    .build_channel
                    .as_deref()
                    .unwrap_or("missing channel"),
                EXPECTED_SIDECAR_BUILD_ID,
                EXPECTED_SIDECAR_BUILD_CHANNEL,
            );
            continue;
        }
        let Ok(identity) = authenticated_backend_identity(candidate.port, &token) else {
            continue;
        };
        if backend_identity_matches(&identity) {
            return Ok(Some(DesktopConnection {
                url: format!("http://127.0.0.1:{}", candidate.port),
                token,
            }));
        }
        eprintln!(
            "Kiki skipped backend pid {} on port {}: authenticated identity {} / {} / {} does not match {} / {} / {}",
            candidate.pid,
            candidate.port,
            identity.server_version,
            identity.build_id.as_deref().unwrap_or("missing build id"),
            identity
                .build_channel
                .as_deref()
                .unwrap_or("missing channel"),
            EXPECTED_SIDECAR_SERVER_VERSION,
            EXPECTED_SIDECAR_BUILD_ID,
            EXPECTED_SIDECAR_BUILD_CHANNEL,
        );
    }
    Ok(None)
}

fn select_instance_for_pid(
    records: impl IntoIterator<Item = InstanceRecord>,
    pid: u32,
    launched_at_ms: u64,
) -> Option<InstanceCandidate> {
    records
        .into_iter()
        .filter_map(instance_candidate)
        .filter(|record| record.pid == pid && record.started_at >= launched_at_ms)
        .max_by_key(|record| record.started_at)
}

fn rank_instance_candidates(
    records: impl IntoIterator<Item = InstanceRecord>,
    current_workspace: Option<&Path>,
    is_alive: impl Fn(u32) -> bool,
) -> Vec<InstanceCandidate> {
    let mut candidates: Vec<_> = records
        .into_iter()
        .filter_map(instance_candidate)
        .filter(|candidate| is_alive(candidate.pid))
        .collect();
    candidates.sort_by(|left, right| {
        workspace_matches(right, current_workspace)
            .cmp(&workspace_matches(left, current_workspace))
            .then_with(|| right.heartbeat_at.cmp(&left.heartbeat_at))
            .then_with(|| right.started_at.cmp(&left.started_at))
    });
    candidates
}

fn instance_candidate(record: InstanceRecord) -> Option<InstanceCandidate> {
    let port = if let Some(url) = record.url.as_deref() {
        let url = Url::parse(url).ok()?;
        if url.scheme() != "http" || !url.host_str().is_some_and(is_loopback_host) {
            return None;
        }
        url.port()?
    } else {
        let host = record.host.as_deref()?;
        if !is_loopback_host(host) {
            return None;
        }
        record.port?
    };
    if port == 0 {
        return None;
    }
    Some(InstanceCandidate {
        pid: record.pid,
        port,
        started_at: record.started_at,
        heartbeat_at: record.heartbeat_at.max(record.started_at),
        workspaces: record.workspaces,
        build_id: record.build_id,
        build_channel: record.build_channel,
    })
}

fn workspace_matches(candidate: &InstanceCandidate, current_workspace: Option<&Path>) -> bool {
    let Some(current_workspace) = current_workspace.and_then(Path::to_str) else {
        return false;
    };
    let current_workspace = normalized_workspace(current_workspace);
    candidate.workspaces.iter().any(|workspace| {
        let workspace = normalized_workspace(workspace);
        current_workspace == workspace || current_workspace.starts_with(&format!("{workspace}/"))
    })
}

fn normalized_workspace(path: &str) -> String {
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    unsafe {
        CloseHandle(handle);
    }
    true
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host == "::1"
        || host == "[::1]"
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn read_token(home: &Path) -> Result<Option<String>, String> {
    let path = home.join("server.local-owner");
    match fs::metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() > 4096 {
                return Err("Invalid local owner capability file".to_string());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err("Local owner capability must have private permissions".to_string());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect local owner capability: {error}")),
    }
    match fs::read_to_string(&path) {
        Ok(value) => {
            let token = value.trim();
            if token.is_empty() {
                Ok(None)
            } else if token.len() > 4096 {
                Err(format!(
                    "Kiki server token at {} is unexpectedly large",
                    path.display()
                ))
            } else {
                Ok(Some(token.to_string()))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Cannot read Kiki server token at {}: {error}",
            path.display()
        )),
    }
}

fn backend_identity_matches(identity: &BackendIdentity) -> bool {
    identity.server_version == EXPECTED_SIDECAR_SERVER_VERSION
        && identity.build_id.as_deref() == Some(EXPECTED_SIDECAR_BUILD_ID)
        && identity.build_channel.as_deref() == Some(EXPECTED_SIDECAR_BUILD_CHANNEL)
}

fn authenticated_backend_identity(port: u16, token: &str) -> Result<BackendIdentity, String> {
    let response = http_get_body(port, "/api/meta", token, MAX_META_RESPONSE_BYTES)?;
    parse_meta_backend_identity_response(&response)
}

/// Authenticated GET against the loopback backend; returns the raw response
/// (status line through body), capped at `max_bytes`.
fn http_get_body(port: u16, path: &str, token: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|error| format!("Cannot connect to Kiki backend on port {port}: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Cannot configure Kiki backend request: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Cannot configure Kiki backend request: {error}"))?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Cannot write Kiki backend request: {error}"))?;

    let mut response = Vec::new();
    stream
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|error| format!("Cannot read Kiki backend response: {error}"))?;
    if response.len() > max_bytes {
        return Err("Kiki backend response is unexpectedly large".to_string());
    }
    Ok(response)
}

fn parse_attention_response(response: &[u8]) -> Result<(HashSet<String>, usize), String> {
    let status_end = response.iter().position(|byte| *byte == b'\n')
        .ok_or("Kiki backend returned an incomplete sessions status line")?;
    if !matches!(parse_http_status_line(&response[..=status_end]), StatusLineParse::Complete(200)) {
        return Err("Kiki backend rejected the sessions request".to_string());
    }
    let header_end = response.windows(4).position(|part| part == b"\r\n\r\n")
        .ok_or("Kiki backend returned incomplete sessions headers")?;
    let envelope: serde_json::Value = serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| format!("Invalid sessions JSON: {error}"))?;
    if envelope.get("code").and_then(serde_json::Value::as_i64) != Some(0) {
        return Err("Kiki backend sessions request failed".to_string());
    }
    let data = envelope.get("data").ok_or("Kiki backend sessions data is missing")?;
    let items = data.get("items").and_then(serde_json::Value::as_array)
        .ok_or("Kiki backend sessions list is missing")?;
    let ephemeral = data.get("ephemeral").and_then(serde_json::Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[]);
    let mut pending = HashSet::new();
    let mut busy = 0;
    for item in items.iter().chain(ephemeral.iter()) {
        if item.get("busy").and_then(serde_json::Value::as_bool) == Some(true) { busy += 1; }
        if matches!(item.get("pending_interaction").and_then(serde_json::Value::as_str), Some("approval" | "question")) {
            if let Some(id) = item.get("id").and_then(serde_json::Value::as_str) { pending.insert(id.to_string()); }
        }
    }
    Ok((pending, busy))
}

fn parse_meta_backend_identity_response(response: &[u8]) -> Result<BackendIdentity, String> {
    let status_end = response
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "Kiki backend returned an incomplete metadata status line".to_string())?;
    match parse_http_status_line(&response[..=status_end]) {
        StatusLineParse::Complete(200) => {}
        StatusLineParse::Complete(_) => {
            return Err("Kiki backend rejected the authenticated metadata request".to_string())
        }
        StatusLineParse::Incomplete | StatusLineParse::Invalid => {
            return Err("Kiki backend returned an invalid metadata status line".to_string())
        }
    }

    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Kiki backend returned incomplete metadata headers".to_string())?;
    let envelope: MetaEnvelope = serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| format!("Kiki backend returned invalid metadata JSON: {error}"))?;
    if envelope.data.server_version.is_empty() {
        return Err("Kiki backend metadata omitted server_version".to_string());
    }
    if envelope
        .data
        .build_id
        .as_ref()
        .is_some_and(String::is_empty)
    {
        return Err("Kiki backend metadata contained an empty build_id".to_string());
    }
    if envelope
        .data
        .build_channel
        .as_ref()
        .is_some_and(String::is_empty)
    {
        return Err("Kiki backend metadata contained an empty build_channel".to_string());
    }
    Ok(envelope.data)
}

fn connection_port(connection: &DesktopConnection) -> Result<u16, String> {
    connection
        .url
        .rsplit_once(':')
        .and_then(|(_, value)| value.parse::<u16>().ok())
        .ok_or_else(|| "Kiki desktop connection contained an invalid port".to_string())
}

fn shutdown_request(connection: &DesktopConnection) -> Result<(), String> {
    http_request(
        connection_port(connection)?,
        "POST",
        "/api/shutdown",
        &connection.token,
    )
}

fn http_request(port: u16, method: &str, path: &str, token: &str) -> Result<(), String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|error| format!("Cannot connect to Kiki backend on port {port}: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Cannot configure Kiki backend probe: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Cannot configure Kiki backend probe: {error}"))?;

    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Cannot write Kiki backend request: {error}"))?;

    let mut status_line = Vec::with_capacity(64);
    let mut chunk = [0_u8; 64];
    loop {
        let bytes = stream
            .read(&mut chunk)
            .map_err(|error| format!("Cannot read Kiki backend response: {error}"))?;
        if bytes == 0 {
            return Err("Kiki backend returned an incomplete HTTP status line".to_string());
        }
        status_line.extend_from_slice(&chunk[..bytes]);
        match parse_http_status_line(&status_line) {
            StatusLineParse::Incomplete => continue,
            StatusLineParse::Complete(200 | 204) => return Ok(()),
            StatusLineParse::Complete(_) => {
                return Err("Kiki backend rejected the authenticated local request".to_string())
            }
            StatusLineParse::Invalid => {
                return Err("Kiki backend returned an invalid HTTP status line".to_string())
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StatusLineParse {
    Incomplete,
    Complete(u16),
    Invalid,
}

fn parse_http_status_line(bytes: &[u8]) -> StatusLineParse {
    let Some(end) = bytes.iter().position(|byte| *byte == b'\n') else {
        return if bytes.len() <= MAX_HTTP_STATUS_LINE_BYTES {
            StatusLineParse::Incomplete
        } else {
            StatusLineParse::Invalid
        };
    };
    if end > MAX_HTTP_STATUS_LINE_BYTES {
        return StatusLineParse::Invalid;
    }

    let line = bytes[..end].strip_suffix(b"\r").unwrap_or(&bytes[..end]);
    let Ok(line) = std::str::from_utf8(line) else {
        return StatusLineParse::Invalid;
    };
    let mut fields = line.split_whitespace();
    let Some(version) = fields.next() else {
        return StatusLineParse::Invalid;
    };
    let Some(code) = fields.next() else {
        return StatusLineParse::Invalid;
    };
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || code.len() != 3
        || !code.bytes().all(|byte| byte.is_ascii_digit())
    {
        return StatusLineParse::Invalid;
    }
    match code.parse::<u16>() {
        Ok(code @ 100..=599) => StatusLineParse::Complete(code),
        _ => StatusLineParse::Invalid,
    }
}

fn force_stop(backend: OwnedBackend) {
    let _ = kill_tree::blocking::kill_tree(backend.pid);
    let _ = backend.child.kill();
    remove_owned_instance_records(&backend.home, backend.pid, backend.launched_at_ms);
}

struct TrayLabels {
    show: &'static str,
    hide: &'static str,
    new_session: &'static str,
    quit: &'static str,
}

/// Tray menu copy follows the frontend's UI locale (mirrored into desktop.json).
fn tray_labels(locale: Option<&str>) -> TrayLabels {
    match locale {
        Some("zh") => TrayLabels {
            show: "显示",
            hide: "隐藏",
            new_session: "新会话",
            quit: "退出",
        },
        _ => TrayLabels {
            show: "Show",
            hide: "Hide",
            new_session: "New Session",
            quit: "Quit",
        },
    }
}

fn build_tray_menu(app: &AppHandle, labels: TrayLabels) -> Result<Menu<Wry>, String> {
    let show_i = MenuItem::with_id(app, "show", labels.show, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let hide_i = MenuItem::with_id(app, "hide", labels.hide, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let new_i = MenuItem::with_id(app, "new", labels.new_session, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[
        &show_i, &hide_i, &new_i,
        &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
    ]).map_err(|e| e.to_string())?;
    if let Some(manager) = app.try_state::<SpaceBackendManager>() {
        if let Ok(state) = manager.inner.lock() {
            if state.mode == WindowMode::Switch {
                drop(state);
                if let Ok(spaces) = manager.registered_spaces() {
                    if spaces.len() > 1 {
                        let title = if read_desktop_prefs_file().locale.as_deref() == Some("zh") { "空间" } else { "Spaces" };
                        let submenu = Submenu::new(app, title, true).map_err(|error| error.to_string())?;
                        let status = manager.space_statuses().unwrap_or_default();
                        for space in spaces {
                            let slot = status.iter().find(|slot| slot.home_id == space.home_id);
                            let suffix = match slot {
                                Some(slot) if slot.active => " ✓".to_string(),
                                Some(slot) if slot.pending_count > 0 => format!("  ({})", slot.pending_count),
                                Some(slot) if slot.hot => "  ●".to_string(),
                                _ => String::new(),
                            };
                            let item = MenuItem::with_id(app, format!("space:{}", space.home_id),
                                format!("{}{}", space.name, suffix), true, None::<&str>)
                                .map_err(|error| error.to_string())?;
                            submenu.append(&item).map_err(|error| error.to_string())?;
                        }
                        menu.append(&submenu).map_err(|error| error.to_string())?;
                        menu.append(&PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?)
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
        }
    }
    menu.append(&quit_i).map_err(|error| error.to_string())?;
    Ok(menu)
}

fn background_main_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    return window.minimize();
    #[cfg(not(target_os = "linux"))]
    window.hide()
}

/// Linux keeps a taskbar recovery entry even when no indicator is visible.
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && focused && !minimized {
            let _ = background_main_window(&window);
        } else {
            let _ = show_main_window(app.clone());
        }
    }
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let menu = build_tray_menu(
        app,
        tray_labels(read_desktop_prefs_file().locale.as_deref()),
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "No default window icon".to_string())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Kiki")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                let _ = show_main_window(app.clone());
            }
            "hide" => {
                let _ = app.get_webview_window("main").and_then(|w| background_main_window(&w).ok());
            }
            "new" => {
                let _ = show_main_window(app.clone());
                let _ = app.emit("kiki://new-session", ());
            }
            "quit" => {
                app.exit(0);
            }
            id if id.starts_with("space:") => {
                if let Some(manager) = app.try_state::<SpaceBackendManager>() {
                    let manager = manager.inner().clone();
                    let app = app.clone();
                    let home_id = id.trim_start_matches("space:").to_string();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = manager.switch(&app, &home_id) {
                            eprintln!("Kiki tray could not switch space: {}", error.message);
                        } else if let Err(error) = reload_space_window(&app) {
                            eprintln!("Kiki tray could not reload space: {error}");
                        }
                    });
                }
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn request_confirmed_exit(
    app: AppHandle,
    manager: SpaceBackendManager,
    confirmed: Arc<AtomicBool>,
    prompting: Arc<AtomicBool>,
) {
    if prompting.swap(true, Ordering::SeqCst) { return; }
    thread::spawn(move || {
        let proceed = confirm_backend_shutdown(&app, &manager, "Exiting Kiki");
        if proceed { confirmed.store(true, Ordering::SeqCst); }
        prompting.store(false, Ordering::SeqCst);
        if proceed { app.exit(0); }
    });
}

pub fn run() {
    let startup_home = kiki_home_dir().unwrap_or_else(|error| panic!("Cannot resolve Kiki home: {error}"));
    let main_home = main_home_for(&startup_home).unwrap_or_else(|error| panic!("Cannot resolve main space: {error}"));
    let mode = read_main_desktop_prefs(&main_home).window_mode;
    let remote_connection = remote_space::requested_connection(&env::args().collect::<Vec<_>>())
        .unwrap_or_else(|error| panic!("Cannot select remote space: {error}"));
    if let Some(id) = &remote_connection {
        if mode != WindowMode::Windows { panic!("Remote windows require windows mode"); }
        if let Ok(mut pending) = PENDING_NAVIGATION_INTENT.lock() { *pending = Some(serde_json::json!({ "connectionId": id })); }
    }
    let manager = SpaceBackendManager::new(&startup_home, mode)
        .unwrap_or_else(|error| panic!("Cannot initialize desktop spaces: {error}"));
    let shutdown_manager = manager.clone();
    let second_launch_manager = manager.clone();
    let setup_manager = manager.clone();
    let close_manager = manager.clone();
    let tray_created = Arc::new(AtomicBool::new(false));
    let close_tray_created = tray_created.clone();
    let exit_confirmed = Arc::new(AtomicBool::new(false));
    let exit_prompting = Arc::new(AtomicBool::new(false));
    let close_confirmed = exit_confirmed.clone();
    let close_prompting = exit_prompting.clone();
    let tunnel_manager = ssh_tunnel::TunnelManager::default();
    let shutdown_tunnels = tunnel_manager.clone();
    let mut context = tauri::generate_context!();
    if mode == WindowMode::Windows && startup_home != main_home {
        let space = read_desktop_space(&startup_home).unwrap_or_else(|error| panic!("Invalid space: {error}"))
            .unwrap_or_else(|| panic!("Multi-window spaces require home.toml"));
        let identifier = format!("ai.easyagent.kiki.{}", space.home_id);
        context.config_mut().identifier = identifier.clone();
        #[cfg(windows)]
        {
            let wide = wide_null(std::ffi::OsStr::new(&identifier));
            let result = unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
            if result < 0 { eprintln!("Kiki could not set the space taskbar identity: 0x{:x}", result); }
        }
    }
    if let Some(id) = &remote_connection {
        let identifier = remote_space::window_identifier(&context.config().identifier, &startup_home, id);
        context.config_mut().identifier = identifier.clone();
        #[cfg(windows)]
        {
            let wide = wide_null(std::ffi::OsStr::new(&identifier));
            let result = unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
            if result < 0 { eprintln!("Kiki could not set the remote taskbar identity: 0x{:x}", result); }
        }
    }

    let app = tauri::Builder::default()
        // Register first so a second launch focuses the original window
        // without starting another backend.
        .plugin(tauri_plugin_single_instance::init(move |app, args, _cwd| {
            if let Ok(Some(home)) = requested_home(&args) {
                if let Ok(id) = read_desktop_space(&home).map(|space| space.map(|space| space.home_id)) {
                    let manager = second_launch_manager.clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let target = id.unwrap_or_else(|| "main".to_string());
                        if let Err(error) = manager.switch(&app, &target) {
                            eprintln!("Kiki could not switch space on second launch: {}", error.message);
                        } else if let Err(error) = reload_space_window(&app) {
                            eprintln!("Kiki could not reload the selected space: {error}");
                        }
                    });
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Window geometry memory: restores on window creation, saves on
        // move/resize/close — no frontend involvement.
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    // Updater is optional. tauri-plugin-updater still deserializes
    // `plugins.updater` as a Config struct (null panics the whole shell),
    // so tauri.conf.json always carries a Config object. The plugin itself
    // is only registered when a signing key was baked in at compile time;
    // local promotes fail closed via desktop_updater() either way.
    let app = if let Some(public_key) = UPDATER_PUBLIC_KEY.filter(|key| !key.is_empty() && (mode == WindowMode::Switch || startup_home == main_home)) {
        app.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(public_key)
                .build(),
        )
    } else {
        app
    };

    let app = app
        .manage(manager)
        .manage(tunnel_manager)
        .invoke_handler(app_commands!(command_handlers))
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let prefs = close_manager.active_space()
                    .map(|space| read_desktop_prefs_for(Path::new(&space.path)))
                    .unwrap_or_else(|_| read_desktop_prefs_file());
                if close_confirmed.load(Ordering::SeqCst) { return; }
                api.prevent_close();
                let action = desktop_close_action(&prefs, close_tray_created.load(Ordering::SeqCst), env::consts::OS);
                match action {
                    DesktopCloseAction::Hide | DesktopCloseAction::Minimize => {
                        let result = if action == DesktopCloseAction::Minimize { window.minimize() } else { window.hide() };
                        if let Err(error) = result {
                            eprintln!("Kiki could not background the main window: {error}");
                            let _ = show_main_window(window.app_handle().clone());
                        }
                    }
                    DesktopCloseAction::Exit => {
                        request_confirmed_exit(window.app_handle().clone(), close_manager.clone(), close_confirmed.clone(), close_prompting.clone());
                    }
                }
            }
        })
        .setup(move |app| {
            // Tauri 2.11.5 exposes clipboard permission on the
            // WebviewWindowBuilder, not tauri.conf.json. The config window is
            // created here so the main webview receives that attribute before
            // WebView2 starts; this removes the native paste permission prompt.
            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| std::io::Error::other("main window config is missing"))?;
            let main_window = WebviewWindowBuilder::from_config(app.handle(), main_config)
                .map_err(std::io::Error::other)?
                .enable_clipboard_access()
                .build()
                .map_err(std::io::Error::other)?;
            #[cfg(windows)]
            disable_browser_accelerator_keys(&main_window).map_err(std::io::Error::other)?;
            match build_tray(app.handle()) {
                Ok(()) => { tray_created.store(true, Ordering::SeqCst); }
                Err(error) => {
                    eprintln!("Kiki could not create its tray; close-to-tray is disabled for this run: {error}");
                }
            }
            // Saved window visibility and an unavailable hotkey must not strand startup.
            main_window.unminimize().map_err(std::io::Error::other)?;
            main_window.show().map_err(std::io::Error::other)?;
            if let Ok(space) = setup_manager.active_space() { set_space_identity(app.handle(), &space); }
            // Both manager initialization and shortcut registration are optional.
            if mode == WindowMode::Switch || startup_home == main_home {
                let plugin = tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed { toggle_main_window(app); }
                    })
                    .build();
                match app.handle().plugin(plugin) {
                    Ok(()) => {
                        let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK);
                        if let Err(error) = app.global_shortcut().register(shortcut) {
                            eprintln!("Kiki could not register the Ctrl+Shift+K show/hide hotkey: {error}");
                        }
                    }
                    Err(error) => eprintln!("Kiki could not initialize global shortcuts: {error}"),
                }
            }
            if mode == WindowMode::Switch || startup_home == main_home {
                if let Ok(main_backend) = setup_manager.main_backend() {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = main_backend.connection(&handle) {
                            eprintln!("Kiki main-space backend could not start: {}", error.message);
                        }
                    });
                }
            }
            let poll_manager = setup_manager.clone();
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(5));
                if !poll_manager.poll_attention(&handle) { break; }
            });
            Ok(())
        })
        .build(context)
        .unwrap_or_else(|error| panic!("failed to build Kiki desktop: {error}"));

    app.run(move |app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = &event {
            if exit_confirmed.load(Ordering::SeqCst) {
                shutdown_tunnels.shutdown();
                shutdown_manager.shutdown();
            } else {
                api.prevent_exit();
                request_confirmed_exit(app_handle.clone(), shutdown_manager.clone(), exit_confirmed.clone(), exit_prompting.clone());
            }
        }
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = &event {
            let _ = show_main_window(app_handle.clone());
        }
        if let RunEvent::TrayIconEvent(TrayIconEvent::Click { button, .. }) = &event {
            if *button == MouseButton::Left {
                let _ = show_main_window(app_handle.clone());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_prefs_default_and_partial_json_close_to_tray() {
        assert!(DesktopPrefs::default().close_to_tray);

        let absent: DesktopPrefs = serde_json::from_str("{}").unwrap();
        assert!(absent.close_to_tray);

        let partial: DesktopPrefs = serde_json::from_str(r#"{"notifications":false}"#).unwrap();
        assert!(!partial.notifications);
        assert!(partial.close_to_tray);
        assert_eq!(partial.locale, None);
        assert_eq!(partial.update_channel, UpdateChannel::Stable);
        assert_eq!(partial.auto_update, AutoUpdateMode::Notify);
        assert_eq!(
            UpdateChannel::build_default(Some("beta")),
            UpdateChannel::Beta
        );
        assert_eq!(
            UpdateChannel::build_default(Some("stable")),
            UpdateChannel::Stable
        );

        let beta: DesktopPrefs = serde_json::from_str(r#"{"updateChannel":"beta"}"#).unwrap();
        assert_eq!(beta.update_channel, UpdateChannel::Beta);
        let install: DesktopPrefs = serde_json::from_str(r#"{"autoUpdate":"install"}"#).unwrap();
        assert_eq!(install.auto_update, AutoUpdateMode::Install);

        let corrupt = serde_json::from_str::<DesktopPrefs>("{not-json").unwrap_or_default();
        assert!(corrupt.close_to_tray);
    }

    #[test]
    fn desktop_log_level_round_trips_inherited_and_space_overrides() {
        let root = env::temp_dir().join(format!("kiki-log-prefs-{}-{}", std::process::id(), unix_epoch_millis().unwrap()));
        let main = root.join("main");
        let child = root.join("child");
        fs::create_dir_all(&child).unwrap();
        let main_text = main.to_string_lossy().replace('\\', "/");
        fs::write(child.join("home.toml"), format!("schema = 1\nid = \"h-test\"\nname = \"Test\"\nbase = {:?}\n", main_text)).unwrap();
        let prefs: DesktopPrefs = serde_json::from_str(r#"{"logLevel":"info"}"#).unwrap();
        let patch: DesktopPrefsPatch = serde_json::from_str(r#"{"logLevel":"info"}"#).unwrap();
        write_desktop_prefs_file(&main, &prefs, &patch).unwrap();
        assert_eq!(read_desktop_prefs_for(&main).log_level, DesktopLogLevel::Info);
        assert_eq!(read_desktop_prefs_for(&child).log_level, DesktopLogLevel::Info);
        let patch: DesktopPrefsPatch = serde_json::from_str(r#"{"logLevel":"trace"}"#).unwrap();
        let mut next = prefs.clone(); next.log_level = DesktopLogLevel::Trace;
        write_desktop_prefs_file(&child, &next, &patch).unwrap();
        assert_eq!(read_desktop_prefs_for(&child).log_level, DesktopLogLevel::Trace);
        assert_eq!(read_desktop_prefs_for(&main).log_level, DesktopLogLevel::Info);
        assert!(serde_json::from_str::<DesktopPrefsPatch>(r#"{"logLevel":"verbose"}"#).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_space_resolves_preset_defaults_and_keeps_user_overrides() {
        let root = env::temp_dir().join(format!("kiki-space-preset-{}-{}", std::process::id(), unix_epoch_millis().unwrap()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("home.toml"), "schema = 1\nid = \"h-example\"\npreset = \"kiki\"\n").unwrap();
        let space = read_desktop_space(&root).unwrap().unwrap();
        assert_eq!(space.name, "Kiki");
        assert_eq!(space.color, None);
        assert_eq!(space.preset.as_deref(), Some("kiki"));
        fs::write(root.join("home.toml"), "schema = 1\nid = \"h-example\"\npreset = \"kiki\"\nname = \"Custom\"\ncolor = \"#be185d\"\n").unwrap();
        let space = read_desktop_space(&root).unwrap().unwrap();
        assert_eq!(space.name, "Custom");
        assert_eq!(space.color.as_deref(), Some("#be185d"));
        fs::write(root.join("home.toml"), "schema = 1\nid = \"h-example\"\npreset = \"../escape\"\n").unwrap();
        assert!(read_desktop_space(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn space_window_mode_defaults_to_switch_and_accepts_both_preference_spellings() {
        let default: DesktopPrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(default.window_mode, WindowMode::Switch);
        let mode: DesktopPrefs = serde_json::from_str(r#"{"window_mode":"windows"}"#).unwrap();
        assert_eq!(mode.window_mode, WindowMode::Windows);
        let legacy: DesktopPrefs = serde_json::from_str(r#"{"windowMode":"windows"}"#).unwrap();
        assert_eq!(legacy.window_mode, WindowMode::Windows);
    }

    #[test]
    fn explicit_home_argument_requires_one_absolute_path() {
        let root = if cfg!(windows) { "C:\\spaces\\alpha" } else { "/spaces/alpha" };
        let args = vec!["kiki-desktop".to_string(), "--home".to_string(), root.to_string()];
        assert_eq!(requested_home(&args).unwrap(), Some(PathBuf::from(root)));
        assert!(requested_home(&["kiki-desktop".into(), "--home".into()]).is_err());
        assert!(requested_home(&["kiki-desktop".into(), "--home".into(), "relative".into()]).is_err());
        assert!(requested_home(&["kiki-desktop".into(), "--home".into(), root.into(), "--home".into(), root.into()]).is_err());
    }

    #[test]
    fn notification_activation_routes_only_clicks_not_dismissals() {
        assert!(notification_action_opens("default"));
        assert!(notification_action_opens("open"));
        assert!(!notification_action_opens("__closed"));
        assert!(!notification_action_opens("reply"));
    }

    #[test]
    fn cross_space_notification_preserves_the_scope_intent_for_router_guarding() {
        let intent = notification_navigation_intent("/activity", Some("home-b"));
        assert_eq!(intent, serde_json::json!({ "route": "/activity", "homeId": "home-b" }));
        assert_eq!(notification_navigation_intent("/s/example", None), serde_json::json!({ "route": "/s/example", "homeId": null }));
        *PENDING_NAVIGATION_INTENT.lock().unwrap() = Some(intent.clone());
        assert_eq!(take_navigation_intent(), Some(intent));
        assert_eq!(take_navigation_intent(), None);
    }

    #[test]
    fn space_restart_rejects_busy_and_pending_sessions_with_reasons() {
        assert!(restart_space_readiness(0, 0).is_ok());
        assert!(restart_space_readiness(2, 0).unwrap_err().contains("2 running"));
        assert!(restart_space_readiness(0, 1).unwrap_err().contains("1 pending"));
        assert!(restart_space_readiness(2, 1).is_err());
    }

    #[test]
    fn unread_overlay_adds_only_other_spaces_and_clears_at_zero() {
        let attention = HashMap::from([
            ("main".to_string(), HashSet::from(["a".to_string()])),
            ("child".to_string(), HashSet::from(["b".to_string(), "c".to_string()])),
        ]);
        assert_eq!(combined_space_attention(3, "main", &attention), 5);
        assert_eq!(combined_space_attention(0, "child", &attention), 1);
        assert_eq!(combined_space_attention(0, "main", &HashMap::new()), 0);
        assert_eq!(combined_space_attention(usize::MAX, "main", &attention), usize::MAX);
    }

    #[test]
    fn background_attention_counts_approval_question_and_busy_independently() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"code\":0,\"data\":{\"items\":[{\"id\":\"a\",\"busy\":false,\"pending_interaction\":\"approval\"},{\"id\":\"b\",\"busy\":true,\"pending_interaction\":\"question\"},{\"id\":\"c\",\"busy\":true,\"pending_interaction\":\"none\"}]}}";
        let (pending, busy) = parse_attention_response(response).unwrap();
        assert_eq!(pending, HashSet::from(["a".to_string(), "b".to_string()]));
        assert_eq!(busy, 2);
        assert!(parse_attention_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n{}").is_err());
    }

    #[test]
    fn desktop_update_support_requires_github_distribution_and_public_key() {
        assert!(desktop_updates_supported_for("github", Some("public-key")));
        assert!(!desktop_updates_supported_for("github", None));
        assert!(!desktop_updates_supported_for("github", Some("")));
        assert!(!desktop_updates_supported_for("local", Some("public-key")));
    }

    #[test]
    fn kimi_home_oauth_and_kiki_config_runtime_resolution() {
        let defaults: DesktopPrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(
            defaults.compatibility,
            CompatibilitySettings {
                home_kind: CompatibilityHomeKind::Kimi,
                custom_home: None,
            }
        );

        let root = if cfg!(windows) {
            PathBuf::from("C:\\homes")
        } else {
            PathBuf::from("/homes")
        };
        let kimi = root.join("kimi");
        let kiki = root.join("kiki");
        let paths = resolve_runtime_paths_with_homes(&defaults, &kimi, &kiki).unwrap();
        assert_eq!(paths.kiki_home, kiki);
        assert_eq!(paths.config_path, kiki.join("config.toml"));
        assert_eq!(paths.oauth_home, kimi);

        let mut custom = defaults;
        custom.compatibility.home_kind = CompatibilityHomeKind::Custom;
        let custom_home = root.join("custom");
        custom.compatibility.custom_home = Some(custom_home.display().to_string());
        let custom_paths = resolve_runtime_paths_with_homes(&custom, &kimi, &kiki).unwrap();
        assert_eq!(custom_paths.config_path, kiki.join("config.toml"));
        assert_eq!(custom_paths.oauth_home, custom_home);
        assert_eq!(
            selected_compatibility_home(&custom.compatibility, &kimi, &kiki).unwrap(),
            custom_home
        );

        custom.compatibility.home_kind = CompatibilityHomeKind::Kiki;
        custom.compatibility.custom_home = None;
        let kiki_paths = resolve_runtime_paths_with_homes(&custom, &kimi, &kiki).unwrap();
        assert_eq!(kiki_paths.oauth_home, kiki);
        assert_eq!(kiki_paths.config_path, kiki.join("config.toml"));

        custom.compatibility.home_kind = CompatibilityHomeKind::Custom;
        custom.compatibility.custom_home = Some("relative".to_string());
        assert!(selected_compatibility_home(&custom.compatibility, &kimi, &kiki).is_err());
        assert!(resolve_runtime_paths_with_homes(&custom, &kimi, &kiki).is_err());
    }

    #[test]
    fn default_kiki_home_preserves_the_existing_user_state_root() {
        assert_eq!(
            default_kiki_home_dir().unwrap(),
            dirs::home_dir().unwrap().join(".kiki")
        );
    }

    #[test]
    fn tray_labels_follow_the_mirrored_ui_locale() {
        let zh: DesktopPrefs = serde_json::from_str(r#"{"locale":"zh"}"#).unwrap();
        let zh_labels = tray_labels(zh.locale.as_deref());
        assert_eq!(zh_labels.show, "显示");
        assert_eq!(zh_labels.quit, "退出");

        let en_labels = tray_labels(DesktopPrefs::default().locale.as_deref());
        assert_eq!(en_labels.show, "Show");
        assert_eq!(en_labels.new_session, "New Session");

        // Unknown values fall back to English instead of rendering raw ids.
        assert_eq!(tray_labels(Some("fr")).show, "Show");
    }

    #[test]
    fn explicit_quit_preference_preserves_confirmed_exit_on_every_platform() {
        let prefs: DesktopPrefs =
            serde_json::from_str(r#"{"notifications":true,"closeToTray":false}"#).unwrap();
        for platform in ["windows", "macos", "linux"] {
            for tray_created in [false, true] {
                assert_eq!(desktop_close_action(&prefs, tray_created, platform), DesktopCloseAction::Exit);
            }
        }
    }

    #[test]
    fn tray_failure_disables_background_close_without_changing_saved_preferences() {
        let prefs = DesktopPrefs::default();
        for platform in ["windows", "macos", "linux"] {
            assert_eq!(desktop_close_action(&prefs, false, platform), DesktopCloseAction::Exit);
        }
        assert!(prefs.close_to_tray);
    }

    #[test]
    fn linux_close_keeps_a_taskbar_entry_instead_of_trusting_indicator_visibility() {
        let prefs = DesktopPrefs::default();
        assert_eq!(desktop_close_action(&prefs, true, "linux"), DesktopCloseAction::Minimize);
        for platform in ["windows", "macos"] {
            assert_eq!(desktop_close_action(&prefs, true, platform), DesktopCloseAction::Hide);
        }
    }

    #[test]
    fn bundle_metadata_matches_the_bundled_node_macos_floor() {
        let config: tauri::utils::config::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config.bundle.macos.minimum_system_version.as_deref(), Some("13.5"));
        assert_eq!(config.bundle.create_updater_artifacts, tauri::utils::config::Updater::Bool(false));
    }

    #[test]
    fn instance_record_parses_both_registry_shapes_and_rejects_non_loopback_urls() {
        let snake: InstanceRecord = serde_json::from_str(
            r#"{"server_id":"snake","pid":42,"host":"127.0.0.1","port":43123,"started_at":200,"heartbeat_at":250,"workspaces":["C:/workspace"]}"#,
        )
        .unwrap();
        let camel: InstanceRecord = serde_json::from_str(
            r#"{"serverId":"camel","url":"http://localhost:43124","pid":43,"startedAt":201,"heartbeatAt":251,"version":"0.40.0"}"#,
        )
        .unwrap();
        assert_eq!(instance_candidate(snake).unwrap().port, 43123);
        assert_eq!(instance_candidate(camel).unwrap().port, 43124);

        let remote: InstanceRecord =
            serde_json::from_str(r#"{"pid":44,"url":"http://example.test:43125","startedAt":202}"#)
                .unwrap();
        assert!(instance_candidate(remote).is_none());
    }

    #[test]
    fn instance_selection_prefers_workspace_then_heartbeat_and_filters_liveness() {
        let record = |pid, port, started_at, heartbeat_at, workspace: &str| {
            serde_json::from_value::<InstanceRecord>(serde_json::json!({
                "pid": pid,
                "host": "127.0.0.1",
                "port": port,
                "started_at": started_at,
                "heartbeat_at": heartbeat_at,
                "workspaces": [workspace],
            }))
            .unwrap()
        };
        let selected = select_instance_for_pid(
            [
                record(42, 41000, 100, 100, "C:/other"),
                record(42, 43000, 220, 220, "C:/other"),
                record(42, 42000, 200, 200, "C:/other"),
            ],
            42,
            150,
        )
        .expect("a post-launch record should be selected");
        assert_eq!(selected.port, 43000);

        let ranked = rank_instance_candidates(
            [
                record(41, 41001, 100, 500, "C:/other"),
                record(42, 41002, 100, 200, "C:/workspace"),
                record(43, 41003, 100, 300, "C:/workspace"),
            ],
            Some(Path::new("C:/workspace/worktree")),
            |pid| pid != 43,
        );
        assert_eq!(
            ranked.iter().map(|item| item.port).collect::<Vec<_>>(),
            vec![41002, 41001]
        );
    }

    #[test]
    fn discovery_cleanup_keeps_valid_live_records_and_removes_invalid_or_dead_records() {
        let home = env::temp_dir().join(format!(
            "kiki-discovery-cleanup-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let instances = home.join("server").join("instances");
        fs::create_dir_all(&instances).unwrap();
        let live = instances.join("live.json");
        let dead = instances.join("dead.json");
        let remote = instances.join("remote.json");
        let invalid = instances.join("invalid.json");
        fs::write(
            &live,
            r#"{"pid":42,"host":"127.0.0.1","port":43123,"started_at":100}"#,
        )
        .unwrap();
        fs::write(
            &dead,
            r#"{"pid":43,"host":"127.0.0.1","port":43124,"started_at":100}"#,
        )
        .unwrap();
        fs::write(
            &remote,
            r#"{"pid":42,"host":"example.test","port":43125,"started_at":100}"#,
        )
        .unwrap();
        fs::write(&invalid, "{broken").unwrap();

        let records = read_discoverable_instance_records(&home, |pid| pid == 42).unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, 42);
        assert!(live.exists());
        assert!(!dead.exists());
        assert!(!remote.exists());
        assert!(!invalid.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn owned_instance_cleanup_removes_only_valid_records_from_the_same_launch() {
        let home = env::temp_dir().join(format!(
            "kiki-owned-instance-cleanup-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let instances = home.join("server").join("instances");
        fs::create_dir_all(&instances).unwrap();
        let matching = instances.join("matching.json");
        let older = instances.join("older.json");
        let other_pid = instances.join("other-pid.json");
        let invalid = instances.join("invalid.json");
        fs::write(
            &matching,
            r#"{"pid":42,"host":"127.0.0.1","port":43123,"started_at":200}"#,
        )
        .unwrap();
        fs::write(
            &older,
            r#"{"pid":42,"host":"127.0.0.1","port":43124,"started_at":99}"#,
        )
        .unwrap();
        fs::write(
            &other_pid,
            r#"{"pid":43,"host":"127.0.0.1","port":43125,"started_at":200}"#,
        )
        .unwrap();
        fs::write(&invalid, "{broken").unwrap();

        remove_owned_instance_records(&home, 42, 100);

        assert!(!matching.exists());
        assert!(older.exists());
        assert!(other_pid.exists());
        assert!(invalid.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn desktop_connection_token_comes_from_the_home_token_file() {
        let home = env::temp_dir().join(format!(
            "kiki-token-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("server.local-owner"), "shared-home-token\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(home.join("server.local-owner"), fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            read_token(&home).unwrap().as_deref(),
            Some("shared-home-token")
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    #[ignore = "requires a live daemon configured by the caller"]
    fn live_daemon_attach_contract() {
        let home = env::var_os("KIKI_GUI_ATTACH_TEST_HOME")
            .map(PathBuf::from)
            .expect("KIKI_GUI_ATTACH_TEST_HOME is required");
        let expected_url =
            env::var("KIKI_GUI_ATTACH_TEST_URL").expect("KIKI_GUI_ATTACH_TEST_URL is required");
        let connection = discover_running_backend(&home, env::current_dir().ok().as_deref())
            .unwrap()
            .expect("the live daemon should be discoverable");
        assert_eq!(connection.url, expected_url);
        assert_eq!(connection.token, read_token(&home).unwrap().unwrap());
    }

    #[test]
    fn shutdown_releases_an_attached_daemon_without_owning_its_process() {
        let manager = BackendManager::default();
        manager.inner.lock().unwrap().attached = Some(DesktopConnection {
            url: "http://127.0.0.1:43123".to_string(),
            token: "shared-home-token".to_string(),
        });
        assert_eq!(manager.ownership().unwrap(), BackendOwnership::External);
        manager.shutdown();
        let state = manager.inner.lock().unwrap();
        assert_eq!(state.ownership(), BackendOwnership::None);
    }

    #[test]
    fn external_daemon_rejects_restart_without_releasing_the_connection() {
        let manager = BackendManager::default();
        manager.inner.lock().unwrap().attached = Some(DesktopConnection {
            url: "http://127.0.0.1:43123".to_string(),
            token: "shared-home-token".to_string(),
        });
        let error = manager
            .owned_backend_for(OwnedBackendOperation::Restart)
            .unwrap_err();
        assert!(error.contains("externally managed"));
        assert!(error.contains("restart"));
        assert_eq!(manager.ownership().unwrap(), BackendOwnership::External);
    }

    #[test]
    fn loopback_host_accepts_only_local_addresses() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.9.8.7"));
        assert!(is_loopback_host("::1"));
        assert!(!is_loopback_host("0.0.0.0"));
        assert!(!is_loopback_host("example.test"));
    }

    #[test]
    fn http_status_parser_handles_split_short_and_malformed_responses() {
        let mut response = b"HTTP/1.".to_vec();
        assert_eq!(
            parse_http_status_line(&response),
            StatusLineParse::Incomplete
        );
        response.extend_from_slice(b"1 200");
        assert_eq!(
            parse_http_status_line(&response),
            StatusLineParse::Incomplete
        );
        response.extend_from_slice(b" OK\r\nContent-Length: 0\r\n\r\n");
        assert_eq!(
            parse_http_status_line(&response),
            StatusLineParse::Complete(200)
        );

        assert_eq!(
            parse_http_status_line(b"HTTP/1.1 2"),
            StatusLineParse::Incomplete
        );
        assert_eq!(
            parse_http_status_line(b"HTTP/2 200 OK\r\n"),
            StatusLineParse::Invalid
        );
        assert_eq!(
            parse_http_status_line(b"HTTP/1.1 nope\r\n"),
            StatusLineParse::Invalid
        );
        assert_eq!(
            parse_http_status_line(&vec![b'x'; MAX_HTTP_STATUS_LINE_BYTES + 1]),
            StatusLineParse::Invalid
        );
    }

    #[test]
    fn metadata_probe_extracts_build_identity_and_rejects_incompatible_payloads() {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{{\"data\":{{\"server_version\":\"{}\",\"build_id\":\"{}\",\"build_channel\":\"{}\"}}}}",
            EXPECTED_SIDECAR_SERVER_VERSION,
            EXPECTED_SIDECAR_BUILD_ID,
            EXPECTED_SIDECAR_BUILD_CHANNEL,
        );
        let identity = parse_meta_backend_identity_response(response.as_bytes()).unwrap();
        assert!(backend_identity_matches(&identity));

        let same_version_other_build = BackendIdentity {
            server_version: EXPECTED_SIDECAR_SERVER_VERSION.to_string(),
            build_id: Some("different-build".to_string()),
            build_channel: Some(EXPECTED_SIDECAR_BUILD_CHANNEL.to_string()),
        };
        assert!(!backend_identity_matches(&same_version_other_build));

        let missing = b"HTTP/1.1 200 OK\r\n\r\n{\"data\":{}}";
        assert!(parse_meta_backend_identity_response(missing).is_err());
        let rejected = b"HTTP/1.1 401 Unauthorized\r\n\r\n{}";
        assert!(parse_meta_backend_identity_response(rejected).is_err());
    }

    #[test]
    fn discovery_rejects_same_version_different_build_without_removing_external_record() {
        let home = env::temp_dir().join(format!(
            "kiki-build-selection-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let instances = home.join("server").join("instances");
        fs::create_dir_all(&instances).unwrap();
        fs::write(home.join("server.local-owner"), "test-token\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(home.join("server.local-owner"), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let body = serde_json::json!({
            "data": {
                "server_version": EXPECTED_SIDECAR_SERVER_VERSION,
                "build_id": "different-build",
                "build_channel": EXPECTED_SIDECAR_BUILD_CHANNEL,
            }
        })
        .to_string();

        let rejected_port = spawn_stub_server("200 OK", body, 1);
        let record_path = instances.join("rejected.json");
        fs::write(
            &record_path,
            serde_json::json!({
                "server_id": "rejected",
                "pid": std::process::id(),
                "host": "127.0.0.1",
                "port": rejected_port,
                "started_at": 100,
                "heartbeat_at": 100,
                "build_id": EXPECTED_SIDECAR_BUILD_ID,
                "build_channel": EXPECTED_SIDECAR_BUILD_CHANNEL,
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(discover_running_backend(&home, None).unwrap(), None);
        assert!(record_path.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn discovery_skips_legacy_record_without_build_identity_before_http_probe() {
        let home = env::temp_dir().join(format!(
            "kiki-record-build-prefilter-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let instances = home.join("server").join("instances");
        fs::create_dir_all(&instances).unwrap();
        fs::write(home.join("server.local-owner"), "test-token\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(home.join("server.local-owner"), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let record_path = instances.join("legacy.json");
        fs::write(
            &record_path,
            serde_json::json!({
                "server_id": "legacy",
                "pid": std::process::id(),
                "host": "127.0.0.1",
                "port": port,
                "started_at": 100,
                "heartbeat_at": 100,
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(discover_running_backend(&home, None).unwrap(), None);
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert!(record_path.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn exit_status_description_covers_code_signal_and_unknown() {
        assert_eq!(
            describe_exit(&TerminatedPayload {
                code: Some(1),
                signal: None
            }),
            "exit code 1"
        );
        assert_eq!(
            describe_exit(&TerminatedPayload {
                code: None,
                signal: Some(9)
            }),
            "terminated by signal 9"
        );
        assert_eq!(
            describe_exit(&TerminatedPayload {
                code: None,
                signal: None
            }),
            "no exit status reported"
        );
    }

    #[test]
    fn runtime_recovery_backoff_and_rapid_exit_limit_are_bounded() {
        assert_eq!(runtime_recovery_backoff(0), Duration::from_millis(500));
        assert_eq!(runtime_recovery_backoff(1), Duration::from_secs(1));
        assert_eq!(runtime_recovery_backoff(2), Duration::from_secs(2));

        let mut recovery = RuntimeRecoveryState::default();
        assert_eq!(recovery.record_exit(Duration::from_secs(1)), Some(1));
        assert_eq!(recovery.record_exit(Duration::from_secs(1)), Some(2));
        assert_eq!(recovery.record_exit(Duration::from_secs(1)), Some(3));
        assert_eq!(recovery.record_exit(Duration::from_secs(1)), None);
        assert!(recovery.blocked);

        recovery.reset();
        assert_eq!(recovery.record_exit(RUNTIME_STABILITY_WINDOW), Some(6));
        assert_eq!(recovery.rapid_exit_count, 1);
    }

    #[test]
    fn runtime_exit_transition_and_shutdown_reset_have_deterministic_ordering() {
        #[derive(Debug, PartialEq, Eq)]
        struct FakeBackend {
            pid: u32,
            launched_at_ms: u64,
        }

        let mut backend = Some(FakeBackend {
            pid: 42,
            launched_at_ms: 100,
        });
        let mut recovery = RuntimeRecoveryState::default();
        let (taken, generation) = begin_runtime_recovery_transition(
            &mut backend,
            &mut recovery,
            |candidate| candidate.pid == 42 && candidate.launched_at_ms == 100,
            |_| Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(taken.pid, 42);
        assert!(backend.is_none());
        let generation = generation.unwrap();
        recovery.reset();
        assert!(!recovery.is_current(generation));

        let mut backend = Some(FakeBackend {
            pid: 43,
            launched_at_ms: 200,
        });
        let mut recovery = RuntimeRecoveryState::default();
        recovery.reset();
        let stopped = backend.take();
        let generation_after_shutdown = recovery.generation;
        assert!(stopped.is_some());
        assert!(begin_runtime_recovery_transition(
            &mut backend,
            &mut recovery,
            |_| true,
            |_| Duration::from_secs(1),
        )
        .is_none());
        assert_eq!(recovery.generation, generation_after_shutdown);
    }

    #[test]
    fn runtime_failure_stage_serializes_for_the_frontend() {
        let stage = DesktopBackendFailureStage {
            stage: "failed",
            failure: DesktopStartupFailure {
                message: "backend exited".to_string(),
                stderr_tail: vec!["boom".to_string()],
                log_path: Some("desktop-backend.log".to_string()),
            },
        };
        let value = serde_json::to_value(stage).unwrap();
        assert_eq!(value["stage"], "failed");
        assert_eq!(value["failure"]["message"], "backend exited");
        assert_eq!(value["failure"]["stderrTail"][0], "boom");
        assert_eq!(value["failure"]["logPath"], "desktop-backend.log");
    }

    #[test]
    fn backend_monitor_tails_appends_and_reports_startup_failure() {
        let root = env::temp_dir().join(format!(
            "kiki-monitor-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let monitor = BackendMonitor::open(&root);

        // Empty lines are noise, not diagnostics.
        monitor.record_stderr_line("");
        for index in 0..(STDERR_TAIL_LINES + 20) {
            monitor.record_stderr_line(&format!("line-{index}"));
        }

        let failure =
            monitor.startup_failure(4242, "exited during startup (exit code 3)".to_string());
        assert_eq!(failure.stderr_tail.len(), STDERR_TAIL_LINES);
        assert_eq!(failure.stderr_tail.first().unwrap(), "line-20");
        assert_eq!(
            failure.stderr_tail.last().unwrap(),
            &format!("line-{}", STDERR_TAIL_LINES + 19)
        );
        assert!(failure.message.contains("pid 4242"));
        assert!(failure.message.contains("exit code 3"));
        assert!(failure
            .message
            .contains(&format!("stderr (last {STDERR_TAIL_LINES} lines)")));

        // Every stderr line was appended to the on-disk log as well, in the
        // home's log directory rather than the home itself.
        let log_path = failure.log_path.expect("log path should be reported");
        assert!(log_path.ends_with(DESKTOP_BACKEND_LOG_FILE));
        assert_eq!(Path::new(&log_path).parent().unwrap(), desktop_log_dir(&root));
        let logged = fs::read_to_string(&log_path).unwrap();
        assert_eq!(logged.lines().count(), STDERR_TAIL_LINES + 20);
        assert!(logged.ends_with(&format!("line-{}\n", STDERR_TAIL_LINES + 19)));

        // Exit status starts unknown and becomes observable once.
        assert!(monitor.exit().is_none());
        monitor.set_exit(TerminatedPayload {
            code: Some(1),
            signal: None,
        });
        assert_eq!(monitor.exit().map(|payload| payload.code), Some(Some(1)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_log_directory_is_the_home_logs_folder() {
        let home = Path::new("C:/home/space");
        let dir = desktop_log_dir(home);
        assert_eq!(dir, home.join(DESKTOP_LOG_DIR));
        assert_eq!(
            desktop_backend_log_path(home),
            dir.join(DESKTOP_BACKEND_LOG_FILE)
        );
        // The reported folder is a real directory holding the log, so opening
        // it shows the log rather than the bare home.
        let temp = env::temp_dir().join(format!(
            "kiki-log-dir-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        drop(BackendMonitor::open(&temp));
        assert!(desktop_backend_log_path(&temp).is_file());
        assert_eq!(fs::read_dir(desktop_log_dir(&temp)).unwrap().count(), 1);
        fs::remove_dir_all(temp).unwrap();
    }

    /// Loopback HTTP stub answering each request with the canned response;
    /// serves up to `max_requests` connections, then the thread exits.
    fn spawn_stub_server(status: &'static str, body: String, max_requests: usize) -> u16 {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for _ in 0..max_requests {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                // Drain the request headers before answering.
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            request.extend_from_slice(&chunk[..n]);
                            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                    if request.len() > 64 * 1024 {
                        break;
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn host_file_write_writes_utf8_and_rejects_relative_paths() {
        let root = env::temp_dir().join(format!(
            "kiki-host-file-write-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("note.txt");
        write_host_file_text_authorized(&path, "hello 世界").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello 世界");

        // Relative paths are rejected before any I/O.
        assert!(check_host_path(Path::new("relative.txt"), HostPathOp::Write).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_path_openers_reject_relative_paths() {
        assert!(check_host_path(Path::new("relative.txt"), HostPathOp::Open).is_err());
        assert!(check_host_path(Path::new("nested/file.md"), HostPathOp::Reveal).is_err());
    }

    #[test]
    fn host_paths_outside_any_workspace_root_are_allowed() {
        // No registry, no grant, no prompt: user-initiated reveal/open/save
        // act on any plain local absolute path.
        let root = env::temp_dir().join(format!(
            "kiki-host-outside-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("鹈鹕骑自行车.html");
        fs::write(&file, "x").unwrap();
        for op in [HostPathOp::Open, HostPathOp::Reveal, HostPathOp::Write] {
            assert!(check_host_path(&file, op).is_ok(), "{op:?} must be allowed");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn open_refuses_executables_before_any_io() {
        for raw in [
            "C:/work/runme.exe",
            "C:/work/script.BAT",
            "C:/work/evil.ps1",
            "C:/work/x.cmd",
            "C:/work/x.msi",
            "C:/work/x.lnk",
            "C:/work/x.js",
            "C:/work/shortcut.url",
            "C:/work/manual.chm",
            "C:/work/setup.application",
            "C:/work/spec.SettingContent-ms",
        ] {
            assert!(
                check_host_path(Path::new(raw), HostPathOp::Open).is_err(),
                "{raw} must be refused"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn open_refuses_trailing_dots_and_spaces_the_shell_would_strip() {
        for raw in [
            "C:/work/runme.exe.",
            "C:/work/runme.exe ",
            "C:/work/runme.exe. .",
            "C:/work/evil.ps1.",
        ] {
            assert!(
                check_host_path(Path::new(raw), HostPathOp::Open).is_err(),
                "{raw} must be refused"
            );
        }
        // A dotfile with no extension after the tail is not an executable.
        assert!(!is_executable_host_path(Path::new("C:/work/notes.txt.")));
    }

    #[test]
    fn executable_extension_detection_matches_each_platform_opener() {
        for name in ["Evil.EXE", "run.Ps1", "shortcut.URL", "spec.SETTINGCONTENT-MS", "run.exe. ."] {
            assert!(is_executable_host_path_for(Path::new(name), "windows"), "{name}");
        }
        for name in ["Example.app", "Example.APP", "run.command", "run.COMMAND"] {
            assert!(is_executable_host_path_for(Path::new(name), "macos"), "{name}");
        }
        for name in ["example.desktop", "example.DESKTOP"] {
            assert!(is_executable_host_path_for(Path::new(name), "linux"), "{name}");
        }
        for platform in ["windows", "macos", "linux"] {
            for name in ["notes.txt", "世界 notes.md", "no-extension", "notes.txt."] {
                assert!(!is_executable_host_path_for(Path::new(name), platform), "{platform}: {name}");
            }
        }
        for platform in ["macos", "linux"] {
            for name in ["notes.js", "notes.sh", "notes.py"] {
                assert!(!is_executable_host_path_for(Path::new(name), platform), "{platform}: {name}");
            }
        }
        assert!(!is_executable_host_path_for(Path::new("notes.command.txt"), "macos"));
        assert!(!is_executable_host_path_for(Path::new("notes.desktop.txt"), "linux"));
        assert!(!is_executable_host_path_for(Path::new("notes.command."), "macos"));
        assert!(!is_executable_host_path_for(Path::new("notes.desktop "), "linux"));
    }

    #[cfg(unix)]
    #[test]
    fn posix_open_refuses_launchers_and_symlinks_but_reveal_and_write_remain_allowed() {
        let root = env::temp_dir().join(format!("kiki-host-launcher-{}-{}", std::process::id(), unix_epoch_millis().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let names: &[&str] = if cfg!(target_os = "macos") { &["Example.app", "run.command"] } else { &["example.desktop"] };
        for (index, name) in names.iter().enumerate() {
            let launcher = root.join(name);
            if name.ends_with(".app") { fs::create_dir(&launcher).unwrap(); } else { fs::write(&launcher, "test fixture").unwrap(); }
            let alias = root.join(format!("alias-{index}.txt"));
            std::os::unix::fs::symlink(&launcher, &alias).unwrap();
            for path in [&launcher, &alias] {
                assert!(check_host_path(path, HostPathOp::Open).is_err());
                assert!(check_host_path(path, HostPathOp::Reveal).is_ok());
                assert!(check_host_path(path, HostPathOp::Write).is_ok());
            }
        }
        let text = root.join("世界 notes.js");
        fs::write(&text, "plain text").unwrap();
        let alias = root.join("text-alias.txt");
        std::os::unix::fs::symlink(&text, &alias).unwrap();
        assert!(check_host_path(&text, HostPathOp::Open).is_ok());
        assert!(check_host_path(&alias, HostPathOp::Open).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_external_url_accepts_http_and_https_only() {
        // The happy paths parse and pass the scheme gate; the spawn itself is
        // not exercised here (it would launch a real browser).
        assert!(Url::parse("https://example.com/device").is_ok());
        assert!(Url::parse("http://example.com/device").is_ok());
        for raw in [
            "file:///C:/Windows/System32/calc.exe",
            "ms-msdt:test",
            "search-ms:query=x",
            "javascript:alert(1)",
            "not a url",
        ] {
            let parsed = Url::parse(raw);
            assert!(
                parsed.is_err() || !matches!(parsed.unwrap().scheme(), "http" | "https"),
                "{raw} must not pass the scheme gate"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unc_device_and_verbatim_prefixes_are_rejected_before_any_io() {
        for raw in [
            r"\\server\share\file.txt",
            r"\\.\PhysicalDrive0",
            r"\\?\C:\Windows\notepad.exe",
        ] {
            let path = Path::new(raw);
            assert!(path.is_absolute(), "{raw}");
            for op in [HostPathOp::Open, HostPathOp::Reveal, HostPathOp::Write] {
                assert!(
                    check_host_path(path, op).is_err(),
                    "{raw} must be refused for {op:?}"
                );
            }
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn wide_null_passes_shell_metacharacters_through_untouched() {
        use std::ffi::OsStr;
        // Every cmd.exe metacharacter plus whitespace and non-ASCII: the wide
        // conversion must be a byte-faithful UTF-16 transcoding — quoting or
        // escaping here would corrupt the path ShellExecuteW receives.
        let sample = OsStr::new("C:\\tmp\\a&b|c<d>^e%f\\c d 世界.txt");
        let wide = wide_null(sample);
        assert_eq!(wide.last(), Some(&0));
        let body = &wide[..wide.len() - 1];
        assert_eq!(String::from_utf16(body).unwrap(), sample.to_str().unwrap());
        assert_eq!(body.len(), sample.to_str().unwrap().encode_utf16().count());
    }
}
