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
include!("app_commands.rs");

macro_rules! command_handlers {
    ($($command:ident),* $(,)?) => {
        tauri::generate_handler![$($command),*]
    };
}

use std::{
    collections::VecDeque,
    env, fs,
    fs::OpenOptions,
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Receiver;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, Url, WindowEvent, Wry,
};
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
const EXPECTED_SIDECAR_SERVER_VERSION: &str = env!("KIKI_SIDECAR_SERVER_VERSION");
const EXPECTED_SIDECAR_BUILD_ID: &str = env!("KIKI_SIDECAR_BUILD_ID");
const EXPECTED_SIDECAR_BUILD_CHANNEL: &str = env!("KIKI_SIDECAR_BUILD_CHANNEL");
const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("KIKI_UPDATER_PUBLIC_KEY");
const STABLE_UPDATE_ENDPOINT: &str = "https://x-t-e-r.github.io/kiki/updater/stable/latest.json";
const BETA_UPDATE_ENDPOINT: &str = "https://x-t-e-r.github.io/kiki/updater/beta/latest.json";
const TRAY_ID: &str = "main-tray";
/// Filename (under the kimi home) the desktop backend's stderr is appended to.
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

/// Per-backend runtime diagnostics shared by the output pump and waiters:
/// the stderr tail, its on-disk log, and the sidecar's exit status.
struct BackendMonitor {
    /// Append target for stderr lines; `None` once writing is impossible.
    log: Mutex<Option<fs::File>>,
    log_path: Option<PathBuf>,
    /// Bounded rolling tail of the backend's stderr.
    stderr_tail: Mutex<VecDeque<String>>,
    /// Set once the sidecar reports Terminated (or its event stream closes).
    exit: Mutex<Option<TerminatedPayload>>,
}

impl BackendMonitor {
    /// Open the append log under `home`; diagnostics stay in memory on failure.
    fn open(home: &Path) -> Self {
        let path = home.join(DESKTOP_BACKEND_LOG_FILE);
        let file = fs::create_dir_all(home).ok().and_then(|_| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok()
        });
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
                if writeln!(file, "{line}").is_err() {
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
    /// Bumped every time a fresh connection is published; host-root grants
    /// authorize only under the generation they were issued in.
    generation: u64,
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

/// A user-granted file-access boundary for one canonical workspace root,
/// valid only while the backend connection generation it was granted under
/// stays live.
struct HostGrant {
    generation: u64,
    root: PathBuf,
}

#[derive(Clone, Default)]
struct BackendManager {
    inner: Arc<Mutex<BackendState>>,
    /// User-granted host roots, each bound to the connection generation it
    /// was granted under. See `require_authorized_host_path`.
    host_grants: Arc<Mutex<Vec<HostGrant>>>,
}

impl BackendManager {
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
        let runtime = resolve_runtime_paths(&read_desktop_prefs_file())?;
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
                    let command = app
                        .shell()
                        .sidecar("kiki-server")
                        .map_err(|error| {
                            DesktopStartupFailure::plain(format!(
                                "Cannot resolve the packaged Kiki backend: {error}"
                            ))
                        })?
                        .args(["web", "--no-open", "--port", "0", "--log-level", "warn"])
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
        state.generation += 1;
        if let Ok(mut grants) = self.host_grants.lock() {
            grants.clear();
        }
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
        state.generation += 1;
        if let Ok(mut grants) = self.host_grants.lock() {
            grants.clear();
        }
        Some(connection.clone())
    }

    fn handle_backend_exit(
        &self,
        app: &AppHandle,
        pid: u32,
        launched_at_ms: u64,
        exit: &TerminatedPayload,
    ) {
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
    Ok(RuntimePaths {
        kiki_home: kiki_home.to_path_buf(),
        config_path: kiki_home.join("config.toml"),
        oauth_home: selected_compatibility_home(&settings.compatibility, kimi_home, kiki_home)?,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct DesktopPrefs {
    notifications: bool,
    close_to_tray: bool,
    /// UI locale mirrored from the frontend ("en"/"zh"); drives tray labels.
    locale: Option<String>,
    update_channel: UpdateChannel,
    compatibility: CompatibilitySettings,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            notifications: true,
            close_to_tray: true,
            locale: None,
            update_channel: UpdateChannel::build_default(option_env!("KIKI_UPDATE_CHANNEL")),
            compatibility: CompatibilitySettings::default(),
        }
    }
}

fn should_hide_on_close(prefs: &DesktopPrefs) -> bool {
    prefs.close_to_tray
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPrefsPatch {
    notifications: Option<bool>,
    close_to_tray: Option<bool>,
    locale: Option<String>,
    update_channel: Option<UpdateChannel>,
    compatibility: Option<CompatibilitySettings>,
}

fn desktop_prefs_path() -> Result<PathBuf, String> {
    Ok(kiki_home_dir()?.join("desktop.json"))
}

fn read_desktop_prefs_file() -> DesktopPrefs {
    let path = match desktop_prefs_path() {
        Ok(path) => path,
        Err(_) => return DesktopPrefs::default(),
    };
    if let Ok(raw) = fs::read_to_string(&path) {
        return serde_json::from_str(&raw).unwrap_or_default();
    }
    let legacy = kimi_home_dir()
        .ok()
        .map(|home| home.join("kiki").join("desktop.json"));
    match legacy.and_then(|path| fs::read_to_string(path).ok()) {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => DesktopPrefs::default(),
    }
}

fn write_desktop_prefs_file(prefs: &DesktopPrefs) -> Result<(), String> {
    let path = desktop_prefs_path()?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let raw = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_connection(
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<DesktopConnection, DesktopStartupFailure> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.connection(&app))
        .await
        .map_err(|error| {
            DesktopStartupFailure::plain(format!("Kiki backend startup task failed: {error}"))
        })?
}

/// Kill a spawned-but-not-ready backend: the user cancelled the boot wait.
#[tauri::command]
fn cancel_desktop_startup(manager: State<'_, BackendManager>) {
    manager.cancel_startup();
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
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write_host_file_text(&app, &path, &text))
        .await
        .map_err(|error| format!("Kiki host-file task failed: {error}"))?
}

/// Narrow host-opener pair behind the session/file context menus. Both are
/// gated by `require_authorized_host_path` and spawn the platform shell
/// without waiting: `explorer` exits non-zero even on success, so spawn
/// success is the whole contract. The gate may show a blocking native grant
/// prompt, so every command dispatches on a blocking worker — never the main
/// thread.
#[tauri::command]
async fn reveal_host_path(
    path: PathBuf,
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.reveal_host_path(&app, &path))
        .await
        .map_err(|error| format!("Kiki host-path task failed: {error}"))?
}

#[tauri::command]
async fn open_host_path(
    path: PathBuf,
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.open_host_path(&app, &path))
        .await
        .map_err(|error| format!("Kiki host-path task failed: {error}"))?
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
    fn current_connection(&self) -> Result<DesktopConnection, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "Kiki backend lifecycle lock was poisoned".to_string())?;
        state
            .backend
            .as_ref()
            .and_then(|backend| backend.connection.clone())
            .or_else(|| state.attached.clone())
            .ok_or_else(|| "Kiki backend is not connected".to_string())
    }

    /// The generation of the CURRENT live backend connection, if any. Grants
    /// recorded under any other generation — or while no live connection
    /// exists (backend removed, exited, or mid-restart) — authorize nothing.
    /// An attached backend has no exit monitor; its generation was bumped at
    /// attach time, and a dead peer fails the registry fetch closed anyway.
    fn live_connection_generation(&self) -> Option<u64> {
        let state = self.inner.lock().ok()?;
        if let Some(backend) = state.backend.as_ref() {
            backend.connection.as_ref()?;
            if backend.monitor.exit().is_some() {
                return None;
            }
            return Some(state.generation);
        }
        state.attached.as_ref()?;
        Some(state.generation)
    }

    fn host_grant_covers(&self, generation: u64, canonical: &Path) -> bool {
        self.host_grants.lock().is_ok_and(|grants| {
            grants
                .iter()
                .any(|grant| grant.generation == generation && canonical.starts_with(&grant.root))
        })
    }

    fn record_host_grant(&self, generation: u64, root: PathBuf) {
        if let Ok(mut grants) = self.host_grants.lock() {
            grants.retain(|grant| grant.root != root);
            grants.push(HostGrant { generation, root });
        }
    }

    /// The boundary every host-path command shares: the target must
    /// canonicalize inside a root holding a LIVE grant for the current
    /// connection generation, or the user is asked — natively, on the Rust
    /// side — to grant the registry-reported workspace root covering it.
    /// The CHECK uses the canonical path while the ACTION keeps the caller's
    /// path verbatim; the residual symlink-swap race is accepted on this
    /// local single-user shell.
    fn require_authorized_host_path(
        &self,
        path: &Path,
        op: HostPathOp,
        confirm: &dyn Fn(&Path) -> bool,
    ) -> Result<(), String> {
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
        let canonical = canonicalize_host_path(path, op == HostPathOp::Write)?;
        let Some(generation) = self.live_connection_generation() else {
            return Err("Kiki backend is not connected".to_string());
        };
        let connection = self.current_connection()?;
        self.decide_host_path_access(generation, &connection, &canonical, path, confirm)
    }

    /// Grant check → registry consultation → user confirmation, given a live
    /// connection generation. The backend's workspace registry only selects
    /// WHICH root the user is asked about: the renderer holds the bearer
    /// token and could register `C:\` as a workspace, so membership alone
    /// proves nothing. The grant itself requires the confirmation callback —
    /// in production the native dialog, the one channel a compromised
    /// renderer cannot forge. A registry fetch failure fails closed (there is
    /// no stale registry cache to fall back to); confirmed grants survive
    /// transient registry failures within their generation because they are
    /// the user-consented boundary, not a registry mirror.
    fn decide_host_path_access(
        &self,
        generation: u64,
        connection: &DesktopConnection,
        canonical: &Path,
        display: &Path,
        confirm: &dyn Fn(&Path) -> bool,
    ) -> Result<(), String> {
        if self.host_grant_covers(generation, canonical) {
            return Ok(());
        }
        let roots = fetch_workspace_roots(connection)?;
        let Some(root) = roots.into_iter().find(|root| canonical.starts_with(root)) else {
            return Err(format!(
                "Host path {} is outside every workspace root registered with the backend",
                display.display()
            ));
        };
        if !confirm(&root) {
            return Err(format!(
                "Access to host root {} was not granted",
                root.display()
            ));
        }
        self.record_host_grant(generation, root);
        Ok(())
    }

    fn open_host_path(&self, app: &AppHandle, path: &Path) -> Result<(), String> {
        self.require_authorized_host_path(path, HostPathOp::Open, &|root| {
            confirm_host_root_native(app, root)
        })?;
        open_with_default_app(path)
    }

    fn reveal_host_path(&self, app: &AppHandle, path: &Path) -> Result<(), String> {
        self.require_authorized_host_path(path, HostPathOp::Reveal, &|root| {
            confirm_host_root_native(app, root)
        })?;
        reveal_in_file_manager(path)
    }

    fn write_host_file_text(&self, app: &AppHandle, path: &Path, text: &str) -> Result<(), String> {
        self.require_authorized_host_path(path, HostPathOp::Write, &|root| {
            confirm_host_root_native(app, root)
        })?;
        write_host_file_text_authorized(path, text)
    }
}

/// The write itself; only reachable after `require_authorized_host_path`.
fn write_host_file_text_authorized(path: &Path, text: &str) -> Result<(), String> {
    fs::write(path, text)
        .map_err(|error| format!("Cannot write host file {}: {error}", path.display()))
}

/// Native user confirmation of a workspace root — the dialog is created and
/// answered entirely on the Rust side, so renderer content cannot forge a
/// grant. `blocking_show` must not run on the main thread; the commands
/// dispatch through spawn_blocking.
fn confirm_host_root_native(app: &AppHandle, root: &Path) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let labels = host_root_prompt_labels(read_desktop_prefs_file().locale.as_deref());
    app.dialog()
        .message(format!("{}\n\n{}", labels.message, root.display()))
        .title(labels.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            labels.allow.to_string(),
            labels.deny.to_string(),
        ))
        .blocking_show()
}

struct HostRootPromptLabels {
    title: &'static str,
    message: &'static str,
    allow: &'static str,
    deny: &'static str,
}

/// Grant-prompt copy follows the frontend's UI locale (mirrored into
/// desktop.json), same as the tray labels.
fn host_root_prompt_labels(locale: Option<&str>) -> HostRootPromptLabels {
    match locale {
        Some("zh") => HostRootPromptLabels {
            title: "Kiki 文件访问",
            message: "允许 Kiki 打开并编辑此工作区文件夹中的文件？",
            allow: "允许",
            deny: "不允许",
        },
        _ => HostRootPromptLabels {
            title: "Kiki file access",
            message: "Allow Kiki to open and edit files under this workspace folder?",
            allow: "Allow",
            deny: "Don't allow",
        },
    }
}

/// Extensions the platform opener would EXECUTE rather than view (`open` on
/// macOS, ShellExecuteW on Windows). Opening one from transcript or menu
/// content would be code execution, so `open` refuses them outright —
/// reveal-in-folder stays allowed since selecting a file executes nothing.
/// `.js` is listed because stock Windows associates "open" with wscript.
const EXECUTABLE_HOST_EXTENSIONS: &[&str] = &[
    "exe", "com", "pif", "scr", "cpl", "msi", "msp", "msc", "bat", "cmd", "ps1", "vbs", "vbe",
    "js", "jse", "wsf", "wsh", "hta", "lnk", "reg",
];

fn is_executable_host_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            EXECUTABLE_HOST_EXTENSIONS
                .iter()
                .any(|denied| extension.eq_ignore_ascii_case(denied))
        })
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

/// Canonicalize so symlinks/junctions and `..` resolve BEFORE the root check.
/// Writes may target a file that does not exist yet; then the deepest
/// existing ancestor is canonicalized and the missing tail re-attached.
fn canonicalize_host_path(path: &Path, allow_missing_tail: bool) -> Result<PathBuf, String> {
    match fs::canonicalize(path) {
        Ok(canonical) => Ok(canonical),
        Err(error) if allow_missing_tail => canonicalize_missing_tail(path, &error),
        Err(error) => Err(format!(
            "Cannot resolve host path {}: {error}",
            path.display()
        )),
    }
}

fn canonicalize_missing_tail(path: &Path, original: &io::Error) -> Result<PathBuf, String> {
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut ancestor = path;
    loop {
        match fs::canonicalize(ancestor) {
            Ok(canonical) => {
                let mut resolved = canonical;
                for component in tail.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(_) => {
                // file_name() is None for a trailing `..` — those tails are
                // refused here rather than resolved textually.
                let Some(name) = ancestor.file_name() else {
                    return Err(format!(
                        "Cannot resolve host path {}: {original}",
                        path.display()
                    ));
                };
                tail.push(name);
                ancestor = ancestor
                    .parent()
                    .expect("a path with a file name always has a parent");
            }
        }
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

#[tauri::command]
fn read_desktop_prefs() -> DesktopPrefs {
    read_desktop_prefs_file()
}

#[tauri::command]
fn write_desktop_prefs(app: AppHandle, prefs: DesktopPrefsPatch) -> Result<(), String> {
    let current = read_desktop_prefs_file();
    let locale_changed = prefs.locale.is_some() && prefs.locale != current.locale;
    let next = DesktopPrefs {
        notifications: prefs.notifications.unwrap_or(current.notifications),
        close_to_tray: prefs.close_to_tray.unwrap_or(current.close_to_tray),
        locale: prefs.locale.or(current.locale),
        update_channel: prefs.update_channel.unwrap_or(current.update_channel),
        compatibility: prefs.compatibility.unwrap_or(current.compatibility),
    };
    validate_compatibility_settings(&next.compatibility)?;
    write_desktop_prefs_file(&next)?;
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

fn desktop_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let public_key = UPDATER_PUBLIC_KEY
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "Desktop updater is not configured in this build".to_string())?;
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
fn prepare_for_update(manager: State<'_, BackendManager>) {
    manager.shutdown();
}

#[tauri::command]
async fn restart_server(
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<DesktopConnection, DesktopStartupFailure> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.restart(&app))
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

fn kiki_home_dir() -> Result<PathBuf, String> {
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
    let path = home.join("server.token");
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

/// Max size of the backend's workspace registry response.
const MAX_WORKSPACES_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct WorkspacesEnvelope {
    data: WorkspacesData,
}

#[derive(Debug, Deserialize)]
struct WorkspacesData {
    items: Vec<WorkspaceRecord>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceRecord {
    root: String,
}

/// Pull the backend's workspace registry over authenticated loopback HTTP.
/// The server is the authority on which directories the user registered as
/// workspaces, so host-path commands derive their boundary from IT — never
/// from a renderer-reported path.
fn fetch_workspace_roots(connection: &DesktopConnection) -> Result<Vec<PathBuf>, String> {
    let port = connection_port(connection)?;
    let response = http_get_body(
        port,
        "/api/workspaces",
        &connection.token,
        MAX_WORKSPACES_RESPONSE_BYTES,
    )?;
    parse_workspaces_registry_response(&response)
}

fn parse_workspaces_registry_response(response: &[u8]) -> Result<Vec<PathBuf>, String> {
    let status_end = response
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| {
            "Kiki backend returned an incomplete workspace registry status line".to_string()
        })?;
    match parse_http_status_line(&response[..=status_end]) {
        StatusLineParse::Complete(200) => {}
        StatusLineParse::Complete(_) => {
            return Err(
                "Kiki backend rejected the authenticated workspace registry request".to_string(),
            )
        }
        StatusLineParse::Incomplete | StatusLineParse::Invalid => {
            return Err(
                "Kiki backend returned an invalid workspace registry status line".to_string(),
            )
        }
    }

    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Kiki backend returned incomplete workspace registry headers".to_string())?;
    let envelope: WorkspacesEnvelope = serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| {
            format!("Kiki backend returned invalid workspace registry JSON: {error}")
        })?;
    let mut roots = Vec::with_capacity(envelope.data.items.len());
    for item in envelope.data.items {
        let root = PathBuf::from(&item.root);
        if !root.is_absolute() {
            continue;
        }
        // Roots join the containment check canonicalized, so a workspace root
        // reached through a symlink still matches its resolved children.
        match fs::canonicalize(&root) {
            Ok(canonical) => roots.push(canonical),
            Err(error) => {
                eprintln!(
                    "Kiki skips workspace root {} that no longer resolves: {error}",
                    root.display()
                );
            }
        }
    }
    Ok(roots)
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
    Menu::with_items(
        app,
        &[
            &show_i,
            &hide_i,
            &new_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &quit_i,
        ],
    )
    .map_err(|e| e.to_string())
}

/// Toggle used by the global show/hide shortcut: hide only when the window is
/// both visible and focused, otherwise restore and focus it.
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
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
                let _ = app.get_webview_window("main").and_then(|w| {
                    let _ = w.show();
                    w.set_focus().ok()
                });
            }
            "hide" => {
                let _ = app.get_webview_window("main").and_then(|w| w.hide().ok());
            }
            "new" => {
                let _ = app.get_webview_window("main").and_then(|w| {
                    let _ = w.show();
                    let _ = w.set_focus();
                    w.unminimize().ok()
                });
                let _ = app.emit("kiki://new-session", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn run() {
    let manager = BackendManager::default();
    let shutdown_manager = manager.clone();

    let app = tauri::Builder::default()
        // Register first so a second launch focuses the original window
        // without starting another backend.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    // Updater is optional. tauri-plugin-updater still deserializes
    // `plugins.updater` as a Config struct (null panics the whole shell),
    // so tauri.conf.json always carries a Config object. The plugin itself
    // is only registered when a signing key was baked in at compile time;
    // local promotes fail closed via desktop_updater() either way.
    let app = if let Some(public_key) = UPDATER_PUBLIC_KEY.filter(|key| !key.is_empty()) {
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
        .invoke_handler(app_commands!(command_handlers))
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let prefs = read_desktop_prefs_file();
                if should_hide_on_close(&prefs) {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // If close_to_tray is false, default exit proceeds and the
                // RunEvent::ExitRequested handler below shuts down the backend.
            }
        })
        .setup(|app| {
            // The tray is part of the desktop lifecycle contract, not a
            // best-effort decoration: close-to-tray would strand a hidden
            // window if the icon could not be created.
            build_tray(app.handle()).map_err(std::io::Error::other)?;
            // Global show/hide hotkey (hardcoded; a configurable surface is a
            // settings-page concern). A collision with another app degrades to
            // no hotkey rather than a startup failure.
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK);
            if let Err(error) = app.global_shortcut().register(shortcut) {
                eprintln!("Kiki could not register the Ctrl+Shift+K show/hide hotkey: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| panic!("failed to build Kiki desktop: {error}"));

    app.run(move |app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            shutdown_manager.shutdown();
        }
        if let RunEvent::TrayIconEvent(TrayIconEvent::Click { button, .. }) = &event {
            // Left-click on the tray icon shows the window if it is currently hidden.
            if *button == MouseButton::Left {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
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

        let corrupt = serde_json::from_str::<DesktopPrefs>("{not-json").unwrap_or_default();
        assert!(corrupt.close_to_tray);
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
    fn explicit_quit_preference_does_not_hide_on_close() {
        let prefs: DesktopPrefs =
            serde_json::from_str(r#"{"notifications":true,"closeToTray":false}"#).unwrap();
        assert!(!should_hide_on_close(&prefs));
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
        fs::write(home.join("server.token"), "shared-home-token\n").unwrap();
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
        fs::write(home.join("server.token"), "test-token\n").unwrap();
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
        fs::write(home.join("server.token"), "test-token\n").unwrap();
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

        // Every stderr line was appended to the on-disk log as well.
        let log_path = failure.log_path.expect("log path should be reported");
        assert!(log_path.ends_with(DESKTOP_BACKEND_LOG_FILE));
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

    fn stub_connection(port: u16) -> DesktopConnection {
        DesktopConnection {
            url: format!("http://127.0.0.1:{port}"),
            token: "test-token".to_string(),
        }
    }

    /// Registry JSON listing `roots` as the backend's workspaces.
    fn registry_body(roots: &[&Path]) -> String {
        serde_json::json!({
            "data": { "items": roots.iter().map(|root| serde_json::json!({
                "id": "w",
                "root": root.to_string_lossy(),
            })).collect::<Vec<_>>() }
        })
        .to_string()
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

        // The gate rejects relative paths before any prompt or I/O.
        let manager = BackendManager::default();
        let never_confirm = |_: &Path| panic!("relative paths must be rejected before any prompt");
        assert!(manager
            .require_authorized_host_path(
                Path::new("relative.txt"),
                HostPathOp::Write,
                &never_confirm
            )
            .is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_path_citations_require_real_paths_without_relaxing_authorization() {
        let root = env::current_dir().unwrap().join(".tmp").join(format!(
            "host-reference-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("source 中.txt");
        fs::write(&file, "first\nsecond\n").unwrap();
        assert!(canonicalize_host_path(&file, false).is_ok());
        assert!(canonicalize_host_path(&root, false).is_ok());
        let citation = PathBuf::from(format!("{}:2:3", file.display()));
        assert!(canonicalize_host_path(&citation, false).is_err());
        let manager = BackendManager::default();
        for path in [&file, &root] {
            for op in [HostPathOp::Open, HostPathOp::Reveal] {
                let error = manager
                    .require_authorized_host_path(path, op, &|_| panic!("must not prompt"))
                    .unwrap_err();
                assert!(error.contains("not connected"), "{error}");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_path_gate_accepts_attached_backend_connection() {
        let root = env::current_dir().unwrap().join(".tmp").join(format!(
            "host-attached-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("note.txt");
        fs::write(&file, "x").unwrap();
        let port = spawn_stub_server("200 OK", registry_body(&[root.as_path()]), 4);
        let manager = BackendManager::default();
        assert!(manager.publish_attached(stub_connection(port)).is_some());
        manager
            .require_authorized_host_path(&file, HostPathOp::Reveal, &|_| true)
            .unwrap();
        manager
            .require_authorized_host_path(&file, HostPathOp::Open, &|_| {
                panic!("grant must be remembered within the attach generation")
            })
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_path_openers_reject_relative_paths() {
        let manager = BackendManager::default();
        let never_confirm = |_: &Path| panic!("relative paths must be rejected before any prompt");
        assert!(manager
            .require_authorized_host_path(
                Path::new("relative.txt"),
                HostPathOp::Open,
                &never_confirm
            )
            .is_err());
        assert!(manager
            .require_authorized_host_path(
                Path::new("nested/file.md"),
                HostPathOp::Reveal,
                &never_confirm
            )
            .is_err());
    }

    #[test]
    fn grants_require_a_live_connection() {
        // Even a recorded grant authorizes nothing while no backend
        // connection is live (a default manager's backend slot is empty).
        let root = env::temp_dir().join(format!(
            "kiki-root-live-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("note.txt");
        fs::write(&path, "x").unwrap();

        let manager = BackendManager::default();
        manager.record_host_grant(0, fs::canonicalize(&root).unwrap());
        assert!(manager
            .require_authorized_host_path(&path, HostPathOp::Open, &|_| panic!("must not prompt"))
            .is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_root_requires_confirmation_and_grants_bind_to_the_connection_generation() {
        let root = env::temp_dir().join(format!(
            "kiki-root-grant-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("note.txt");
        fs::write(&file, "x").unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let canonical_file = fs::canonicalize(&file).unwrap();

        let port = spawn_stub_server("200 OK", registry_body(&[root.as_path()]), 4);
        let connection = stub_connection(port);
        let manager = BackendManager::default();

        // Denied: nothing is recorded.
        assert!(manager
            .decide_host_path_access(1, &connection, &canonical_file, &file, &|_| false)
            .is_err());
        assert!(!manager.host_grant_covers(1, &canonical_file));

        // Allowed: the user is asked about the CANONICAL root…
        manager
            .decide_host_path_access(1, &connection, &canonical_file, &file, &|asked| {
                assert_eq!(asked, canonical_root);
                true
            })
            .unwrap();
        // …and the grant then serves without any registry fetch or prompt.
        manager
            .decide_host_path_access(1, &connection, &canonical_file, &file, &|_| {
                panic!("grant hit must not re-prompt")
            })
            .unwrap();

        // A new connection generation (backend restart/reconnect) invalidates
        // the grant: the user is asked again.
        manager
            .decide_host_path_access(2, &connection, &canonical_file, &file, &|_| true)
            .unwrap();
        assert!(manager.host_grant_covers(2, &canonical_file));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn paths_outside_every_registry_root_fail_closed_without_prompting() {
        let millis = unix_epoch_millis().unwrap();
        let pid = std::process::id();
        let allowed = env::temp_dir().join(format!("kiki-root-allowed-{pid}-{millis}"));
        let other = env::temp_dir().join(format!("kiki-root-other-{pid}-{millis}"));
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&other).unwrap();
        let outside = other.join("secret.txt");
        fs::write(&outside, "x").unwrap();

        let port = spawn_stub_server("200 OK", registry_body(&[allowed.as_path()]), 2);
        let connection = stub_connection(port);
        let manager = BackendManager::default();

        let error = manager
            .decide_host_path_access(
                1,
                &connection,
                &fs::canonicalize(&outside).unwrap(),
                &outside,
                &|_| panic!("outside paths must never prompt"),
            )
            .unwrap_err();
        assert!(error.contains("outside every workspace root"));

        fs::remove_dir_all(allowed).unwrap();
        fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn registry_failure_fails_closed_with_no_stale_fallback() {
        let root = env::temp_dir().join(format!(
            "kiki-root-failclosed-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("note.txt");
        fs::write(&file, "x").unwrap();
        let canonical_file = fs::canonicalize(&file).unwrap();
        let manager = BackendManager::default();

        // Registry answers, but not with a valid registry payload.
        let port = spawn_stub_server("500 Internal Server Error", "{}".to_string(), 1);
        assert!(manager
            .decide_host_path_access(1, &stub_connection(port), &canonical_file, &file, &|_| {
                panic!("must not prompt")
            })
            .is_err());

        // Registry unreachable at all.
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let dead_port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(manager
            .decide_host_path_access(
                1,
                &stub_connection(dead_port),
                &canonical_file,
                &file,
                &|_| panic!("must not prompt")
            )
            .is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_refuses_executables_before_any_io() {
        let manager = BackendManager::default();
        let never_confirm = |_: &Path| panic!("executables must be rejected before any prompt");
        for raw in [
            "C:/work/runme.exe",
            "C:/work/script.BAT",
            "C:/work/evil.ps1",
            "C:/work/x.cmd",
            "C:/work/x.msi",
            "C:/work/x.lnk",
            "C:/work/x.js",
        ] {
            assert!(
                manager
                    .require_authorized_host_path(Path::new(raw), HostPathOp::Open, &never_confirm)
                    .is_err(),
                "{raw} must be refused"
            );
        }
    }

    #[test]
    fn executable_extension_detection_is_case_insensitive() {
        assert!(is_executable_host_path(Path::new("C:/work/Evil.EXE")));
        assert!(is_executable_host_path(Path::new("C:/work/run.Ps1")));
        assert!(!is_executable_host_path(Path::new("C:/work/notes.txt")));
        assert!(!is_executable_host_path(Path::new("C:/work/no-extension")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unc_device_and_verbatim_prefixes_are_rejected_before_any_io() {
        let manager = BackendManager::default();
        let never_confirm = |_: &Path| panic!("prefix-rejected paths must never prompt");
        for raw in [
            r"\\server\share\file.txt",
            r"\\.\PhysicalDrive0",
            r"\\?\C:\Windows\notepad.exe",
        ] {
            let path = Path::new(raw);
            assert!(path.is_absolute(), "{raw}");
            for op in [HostPathOp::Open, HostPathOp::Reveal, HostPathOp::Write] {
                assert!(
                    manager
                        .require_authorized_host_path(path, op, &never_confirm)
                        .is_err(),
                    "{raw} must be refused for {op:?}"
                );
            }
        }
    }

    #[test]
    fn symlink_escape_outside_a_granted_root_is_rejected() {
        let millis = unix_epoch_millis().unwrap();
        let pid = std::process::id();
        let root = env::temp_dir().join(format!("kiki-root-link-{pid}-{millis}"));
        let outside = env::temp_dir().join(format!("kiki-root-link-target-{pid}-{millis}"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "x").unwrap();

        let link = root.join("link");
        #[cfg(target_os = "windows")]
        let linked = std::os::windows::fs::symlink_dir(&outside, &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        let Ok(()) = linked else {
            // No symlink privilege (stock Windows without developer mode):
            // nothing to test on this host.
            fs::remove_dir_all(root).unwrap();
            fs::remove_dir_all(outside).unwrap();
            return;
        };

        let manager = BackendManager::default();
        let canonical_root = fs::canonicalize(&root).unwrap();
        manager.record_host_grant(9, canonical_root.clone());

        let escape = link.join("secret.txt");
        assert!(escape.exists());
        let canonical_escape = fs::canonicalize(&escape).unwrap();
        // The symlink target resolved OUTSIDE the granted root: the grant
        // must not cover it…
        assert!(!canonical_escape.starts_with(&canonical_root));
        assert!(!manager.host_grant_covers(9, &canonical_escape));
        // …and the registry (which lists the root) offers no covering root
        // either, so access fails closed without prompting.
        let port = spawn_stub_server("200 OK", registry_body(&[root.as_path()]), 1);
        assert!(manager
            .decide_host_path_access(
                9,
                &stub_connection(port),
                &canonical_escape,
                &escape,
                &|_| panic!("symlink escapes must never prompt"),
            )
            .is_err());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn dotdot_segments_cannot_escape_a_granted_root() {
        let base = env::temp_dir().join(format!(
            "kiki-root-dotdot-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let root = base.join("root");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let manager = BackendManager::default();
        manager.record_host_grant(3, fs::canonicalize(&root).unwrap());

        // The escape canonicalizes OUTSIDE the granted root.
        let escape = sub.join("..").join("..").join("escape.txt");
        let canonical_escape = canonicalize_host_path(&escape, true).unwrap();
        assert!(!manager.host_grant_covers(3, &canonical_escape));

        // A `..` that stays INSIDE the root keeps working.
        let within = sub.join("..").join("ok.txt");
        let canonical_within = canonicalize_host_path(&within, true).unwrap();
        assert!(manager.host_grant_covers(3, &canonical_within));
        write_host_file_text_authorized(&within, "yes").unwrap();
        assert_eq!(fs::read_to_string(root.join("ok.txt")).unwrap(), "yes");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn workspaces_registry_response_yields_canonical_absolute_roots() {
        let root = env::temp_dir().join(format!(
            "kiki-root-registry-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let body = serde_json::json!({
            "data": { "items": [
                { "id": "w1", "root": root.to_string_lossy() },
                { "id": "w2", "root": "relative/not-absolute" },
            ] }
        });
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{body}");
        let roots = parse_workspaces_registry_response(response.as_bytes()).unwrap();
        assert_eq!(roots, vec![fs::canonicalize(&root).unwrap()]);

        assert!(
            parse_workspaces_registry_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n{}").is_err()
        );
        assert!(parse_workspaces_registry_response(b"HTTP/1.1 200 OK\r\n\r\n{not json").is_err());
        assert!(parse_workspaces_registry_response(b"garbage").is_err());

        fs::remove_dir_all(root).unwrap();
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
