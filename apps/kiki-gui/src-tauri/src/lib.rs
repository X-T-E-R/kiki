/**
 * Kiki desktop shell: one user-facing window, an owned Kiki SEA backend,
 * a system tray icon, close-to-tray, and approval notifications.
 *
 * The bounded shutdown and process-tree fallback follow LiveAgent's managed
 * process lifecycle at 00a2c6fc43754f40022b0703459824559bee73ea (MIT).
 * Kiki deliberately keeps only the single-child subset needed here and relies
 * on kap-server's own registry, token, and authenticated shutdown contracts.
 */
pub mod config_import;

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

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const RUNTIME_RECOVERY_ATTEMPTS: usize = 3;
const RUNTIME_RECOVERY_INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const RUNTIME_STABILITY_WINDOW: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const MAX_HTTP_STATUS_LINE_BYTES: usize = 256;
const MAX_META_RESPONSE_BYTES: usize = 64 * 1024;
const EXPECTED_SIDECAR_SERVER_VERSION: &str = env!("KIKI_SIDECAR_SERVER_VERSION");
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConnection {
    url: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct InstanceRecord {
    pid: u32,
    host: String,
    port: u16,
    started_at: u64,
}

#[derive(Debug, Deserialize)]
struct MetaEnvelope {
    data: MetaData,
}

#[derive(Debug, Deserialize)]
struct MetaData {
    server_version: String,
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

#[derive(Default)]
struct BackendState {
    backend: Option<OwnedBackend>,
    recovery: RuntimeRecoveryState,
}

#[derive(Clone, Default)]
struct BackendManager {
    inner: Arc<Mutex<BackendState>>,
    /// Canonicalized workspace roots reported by the connected backend — the
    /// containment boundary for every host-path command. See
    /// `require_authorized_host_path`.
    host_roots: Arc<Mutex<Vec<PathBuf>>>,
}

impl BackendManager {
    fn has_backend(&self) -> bool {
        self.inner.lock().is_ok_and(|state| state.backend.is_some())
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
        // Locked phase — spawn decision and slot writes only. The readiness
        // wait below runs outside the lock so a slow cold start cannot block
        // restart or a concurrent reconnect for up to STARTUP_TIMEOUT.
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
                    // Capture the epoch before spawn. A reused PID can make an
                    // old registry record look live, so PID alone is not
                    // sufficient to identify the child we just created.
                    let launched_at_ms = unix_epoch_millis()?;
                    let runtime = resolve_runtime_paths(&read_desktop_prefs_file())?;
                    let home = runtime.kiki_home.clone();
                    let command = app
                        .shell()
                        .sidecar("kiki-server")
                        .map_err(|error| {
                            DesktopStartupFailure::plain(format!(
                                "Cannot resolve the packaged Kiki backend: {error}"
                            ))
                        })?
                        // `warn` keeps the default silent behavior off so
                        // startup failures reach stderr (the token-bearing
                        // ready line stays on stdout, which is never logged).
                        .args(["web", "--no-open", "--port", "0", "--log-level", "warn"])
                        .env("KIMI_CODE_HOME", &runtime.kiki_home)
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

        // Unlocked phase — wait for readiness or early exit.
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
                    if let Ok(server_version) =
                        authenticated_server_version(record.port, &connection.token)
                    {
                        if !sidecar_version_matches(
                            EXPECTED_SIDECAR_SERVER_VERSION,
                            &server_version,
                        ) {
                            self.discard_backend(&pending);
                            return Err(pending.monitor.startup_failure(
                                pending.pid,
                                format!(
                                    "reported server version {server_version}, but this desktop bundle expects {EXPECTED_SIDECAR_SERVER_VERSION}. The packaged backend is stale or belongs to a different build; run `pnpm desktop:prepare` and rebuild Kiki."
                                ),
                            ));
                        }
                        if let Some(connection) = self.publish_connection(&pending, &connection) {
                            // Best-effort warm-up of the authorized host-root
                            // set. Host-path commands re-fetch lazily on a
                            // containment miss, so a failure here (registry
                            // still building) must not fail the connection.
                            let _ = self.refresh_host_roots();
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

    /// Publish this launch's connection or return the value a peer published.
    fn publish_connection(
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
        let transition = {
            let mut state = self
                .inner
                .lock()
                .expect("backend lifecycle lock must not be poisoned");
            let BackendState { backend, recovery } = &mut *state;
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
        self.shutdown();
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KimiHomePaths {
    home: String,
    credential_path: String,
    source_config_path: String,
    config_path: String,
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
    let oauth_home = selected_compatibility_home(&settings.compatibility, kimi_home, kiki_home)?;
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
fn write_host_file_text(
    path: PathBuf,
    text: String,
    manager: State<'_, BackendManager>,
) -> Result<(), String> {
    manager.write_host_file_text(&path, &text)
}

/// Narrow host-opener pair behind the session/file context menus. Both are
/// gated by `require_authorized_host_path` and spawn the platform shell
/// without waiting: `explorer` exits non-zero even on success, so spawn
/// success is the whole contract.
#[tauri::command]
fn reveal_host_path(path: PathBuf, manager: State<'_, BackendManager>) -> Result<(), String> {
    manager.reveal_host_path(&path)
}

#[tauri::command]
fn open_host_path(path: PathBuf, manager: State<'_, BackendManager>) -> Result<(), String> {
    manager.open_host_path(&path)
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
        self.inner
            .lock()
            .map_err(|_| "Kiki backend lifecycle lock was poisoned".to_string())?
            .backend
            .as_ref()
            .and_then(|backend| backend.connection.clone())
            .ok_or_else(|| "Kiki backend is not connected".to_string())
    }

    /// Re-pull the backend's workspace registry into the authorized host-root
    /// set. A fetch failure leaves the previous set in place.
    fn refresh_host_roots(&self) -> Result<(), String> {
        let connection = self.current_connection()?;
        let roots = fetch_workspace_roots(&connection)?;
        let mut set = self
            .host_roots
            .lock()
            .map_err(|_| "Kiki host-root lock was poisoned".to_string())?;
        *set = roots;
        Ok(())
    }

    fn host_roots_contain(&self, canonical: &Path) -> bool {
        self.host_roots
            .lock()
            .is_ok_and(|roots| roots.iter().any(|root| canonical.starts_with(root)))
    }

    /// The boundary every host-path command shares: the target must
    /// canonicalize inside one of the workspace roots the backend itself
    /// reported — the renderer never declares roots, so transcript or menu
    /// content cannot widen the boundary. A containment miss retries once
    /// against a fresh registry pull (a workspace registered since the last
    /// fetch must not be rejected), then fails closed. The CHECK uses the
    /// canonical path while the ACTION keeps the caller's path verbatim; the
    /// residual symlink-swap race is accepted on this local single-user
    /// shell.
    fn require_authorized_host_path(&self, path: &Path, op: HostPathOp) -> Result<(), String> {
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
        if self.host_roots_contain(&canonical) {
            return Ok(());
        }
        self.refresh_host_roots()?;
        if self.host_roots_contain(&canonical) {
            Ok(())
        } else {
            Err(format!(
                "Host path {} is outside every workspace root registered with the backend",
                path.display()
            ))
        }
    }

    fn open_host_path(&self, path: &Path) -> Result<(), String> {
        self.require_authorized_host_path(path, HostPathOp::Open)?;
        open_with_default_app(path)
    }

    fn reveal_host_path(&self, path: &Path) -> Result<(), String> {
        self.require_authorized_host_path(path, HostPathOp::Reveal)?;
        reveal_in_file_manager(path)
    }

    fn write_host_file_text(&self, path: &Path, text: &str) -> Result<(), String> {
        self.require_authorized_host_path(path, HostPathOp::Write)?;
        fs::write(path, text)
            .map_err(|error| format!("Cannot write host file {}: {error}", path.display()))
    }

    #[cfg(test)]
    fn authorize_host_roots_for_tests(&self, roots: &[&Path]) {
        let canonical: Vec<PathBuf> = roots
            .iter()
            .filter_map(|root| fs::canonicalize(root).ok())
            .collect();
        *self.host_roots.lock().unwrap() = canonical;
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
    // explorer.exe reads its own argv — no shell parses this argument — and an
    // OsString keeps non-UTF-8 paths intact (display() would lossy them).
    let mut select = std::ffi::OsString::from("/select,");
    select.push(path.as_os_str());
    std::process::Command::new("explorer")
        .arg(select)
        .spawn()
        .map_err(|error| format!("Cannot reveal host path {}: {error}", path.display()))?;
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
fn read_kimi_home_paths() -> Result<KimiHomePaths, String> {
    let runtime = resolve_runtime_paths(&read_desktop_prefs_file())?;
    Ok(KimiHomePaths {
        credential_path: runtime
            .oauth_home
            .join("credentials")
            .join("kimi-code.json")
            .display()
            .to_string(),
        source_config_path: runtime.oauth_home.join("config.toml").display().to_string(),
        config_path: runtime.config_path.display().to_string(),
        home: runtime.oauth_home.display().to_string(),
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KimiConfigImportResult {
    status: &'static str,
    source: String,
    target: String,
    updated_categories: Vec<String>,
    restart_error: Option<String>,
}

impl From<config_import::ConfigImportResult> for KimiConfigImportResult {
    fn from(result: config_import::ConfigImportResult) -> Self {
        Self {
            status: result.status,
            source: result.source,
            target: result.target,
            updated_categories: result.updated_categories,
            restart_error: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum MigrationCategory {
    UserSkills,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationResult {
    status: &'static str,
    category: MigrationCategory,
    source: String,
    target: String,
    files: usize,
    activation_error: Option<String>,
    restart_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsMigrationMove {
    entry: &'static str,
    source: String,
    target: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsMigrationPlan {
    status: &'static str,
    source_root: String,
    target_root: String,
    session_count: usize,
    total_bytes: u64,
    planned_moves: Vec<SessionsMigrationMove>,
    target_conflict: bool,
    blocker: Option<String>,
    execution: &'static str,
}

fn current_config_import_plan() -> Result<config_import::ConfigImportPlan, String> {
    let prefs = read_desktop_prefs_file();
    let kimi_home = kimi_home_dir()?;
    let kiki_home = kiki_home_dir()?;
    let source_home = selected_compatibility_home(&prefs.compatibility, &kimi_home, &kiki_home)?;
    config_import::plan_config_import_homes(&source_home, &kiki_home)
}

fn import_current_kimi_config() -> Result<config_import::ConfigImportResult, String> {
    let prefs = read_desktop_prefs_file();
    let kimi_home = kimi_home_dir()?;
    let kiki_home = kiki_home_dir()?;
    let source_home = selected_compatibility_home(&prefs.compatibility, &kimi_home, &kiki_home)?;
    config_import::import_config_homes(&source_home, &kiki_home)
}

#[tauri::command]
async fn import_kimi_config(
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<KimiConfigImportResult, String> {
    let app = app.clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let plan = current_config_import_plan()?;
        let has_changes = plan.has_changes();
        let initial = KimiConfigImportResult::from(plan.result());
        let restart = manager.has_backend();
        run_kimi_config_import_lifecycle(
            has_changes,
            initial,
            || {
                if restart {
                    manager.shutdown();
                }
            },
            import_current_kimi_config,
            || {
                if restart {
                    manager
                        .connection(&app)
                        .map(|_| ())
                        .map_err(|error| error.message)
                } else {
                    Ok(())
                }
            },
        )
    })
    .await
    .map_err(|error| format!("Kimi config import task failed: {error}"))?
}

fn run_kimi_config_import_lifecycle(
    has_changes: bool,
    initial: KimiConfigImportResult,
    stop: impl FnOnce(),
    import: impl FnOnce() -> Result<config_import::ConfigImportResult, String>,
    restart: impl FnOnce() -> Result<(), String>,
) -> Result<KimiConfigImportResult, String> {
    if !has_changes {
        return Ok(initial);
    }
    stop();
    let imported = import();
    let restart_error = restart().err();
    match imported {
        Ok(result) => {
            let mut result = KimiConfigImportResult::from(result);
            result.restart_error = restart_error;
            Ok(result)
        }
        Err(error) => Err(match restart_error {
            Some(restart_error) => {
                format!("{error}; Kiki also could not restart: {restart_error}")
            }
            None => error,
        }),
    }
}

#[tauri::command]
async fn migrate_compatibility_category(
    app: AppHandle,
    manager: State<'_, BackendManager>,
    category: MigrationCategory,
) -> Result<MigrationResult, String> {
    let app = app.clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let restart = manager.has_backend();
        run_copy_migration_lifecycle(
            || preflight_category(category),
            || {
                if restart {
                    manager.shutdown();
                }
            },
            || migrate_category(category),
            || {
                if restart {
                    manager
                        .connection(&app)
                        .map(|_| ())
                        .map_err(|error| error.message)
                } else {
                    Ok(())
                }
            },
        )
    })
    .await
    .map_err(|error| format!("Compatibility migration task failed: {error}"))?
}

fn run_copy_migration_lifecycle(
    preflight: impl FnOnce() -> Result<bool, String>,
    stop: impl FnOnce(),
    migrate: impl FnOnce() -> Result<MigrationResult, String>,
    restart: impl FnOnce() -> Result<(), String>,
) -> Result<MigrationResult, String> {
    if !preflight()? {
        return migrate();
    }
    stop();
    let result = migrate();
    let restart_error = restart().err();
    match result {
        Ok(mut result) => {
            result.restart_error = restart_error;
            Ok(result)
        }
        Err(error) => Err(match restart_error {
            Some(restart_error) => format!(
                "User Skills were not copied and settings were not changed: {error}; Kiki also could not restart: {restart_error}"
            ),
            None => format!(
                "User Skills were not copied and settings were not changed: {error}"
            ),
        }),
    }
}

#[tauri::command]
async fn dry_run_sessions_migration() -> Result<SessionsMigrationPlan, String> {
    tauri::async_runtime::spawn_blocking(plan_sessions_migration)
        .await
        .map_err(|error| format!("Sessions migration dry-run task failed: {error}"))?
}

#[tauri::command]
async fn execute_sessions_migration(
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<SessionsMigrationPlan, String> {
    let app = app.clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let initial = plan_sessions_migration()?;
        if initial.status != "ready" {
            return Ok(initial);
        }
        let restart = manager.has_backend();
        if restart {
            manager.shutdown();
        }
        let result = execute_sessions_migration_with(|from, to| fs::rename(from, to));
        let restart_result = restart.then(|| manager.connection(&app));
        match (result, restart_result) {
            (Ok(_plan), Some(Err(error))) => Err(format!(
                "Sessions were moved, but Kiki could not restart: {}",
                error.message
            )),
            (Err(error), Some(Err(restart_error))) => Err(format!(
                "{error}; Kiki also could not restart: {}",
                restart_error.message
            )),
            (result, _) => result,
        }
    })
    .await
    .map_err(|error| format!("Sessions migration task failed: {error}"))?
}

fn plan_sessions_migration() -> Result<SessionsMigrationPlan, String> {
    let prefs = read_desktop_prefs_file();
    let kimi_home = kimi_home_dir()?;
    let kiki_home = kiki_home_dir()?;
    let source_root = selected_compatibility_home(&prefs.compatibility, &kimi_home, &kiki_home)?;
    plan_sessions_migration_with_homes(&prefs.compatibility, &source_root, &kiki_home)
}

fn plan_sessions_migration_with_homes(
    _settings: &CompatibilitySettings,
    source_root: &Path,
    target_root: &Path,
) -> Result<SessionsMigrationPlan, String> {
    let sessions_source = source_root.join("sessions");
    let sessions_target = target_root.join("sessions");
    let workspaces_source = source_root.join("workspaces.json");
    let workspaces_target = target_root.join("workspaces.json");
    let index_source = source_root.join("session_index.jsonl");
    let index_target = target_root.join("session_index.jsonl");
    let session_count = count_sessions(&sessions_source)?;
    let sessions_bytes = path_bytes(&sessions_source)?;
    let has_sessions_data = session_count > 0 || sessions_bytes > 0;
    let index_bytes = session_index_bytes(&index_source)?;
    let has_session_index = index_bytes > 0;
    let has_owned_data = has_sessions_data || has_session_index;
    let has_workspace_catalog = has_owned_data
        && workspaces_source.exists()
        && !workspace_catalog_is_empty(&workspaces_source)?;
    let workspace_bytes = if has_workspace_catalog {
        fs::metadata(&workspaces_source)
            .map_err(|error| {
                format!(
                    "Cannot inspect workspace catalog {}: {error}",
                    workspaces_source.display()
                )
            })?
            .len()
    } else {
        0
    };
    let total_bytes = sessions_bytes + workspace_bytes + index_bytes;
    if paths_equivalent(source_root, target_root) {
        return Ok(SessionsMigrationPlan {
            status: "noop",
            source_root: source_root.display().to_string(),
            target_root: target_root.display().to_string(),
            session_count,
            total_bytes,
            planned_moves: Vec::new(),
            target_conflict: false,
            blocker: None,
            execution: "filesystemRename",
        });
    }
    let sessions_conflict = has_sessions_data && path_has_data(&sessions_target)?;
    let workspaces_conflict =
        has_workspace_catalog && !workspace_catalog_is_empty(&workspaces_target)?;
    let index_conflict = has_session_index && session_index_target_has_data(&index_target)?;
    let target_conflict = sessions_conflict || workspaces_conflict || index_conflict;
    let (status, blocker) = if !has_owned_data {
        ("noop", None)
    } else if sessions_conflict {
        (
            "blocked",
            Some(format!(
                "Kiki Sessions target {} already contains data; no files were changed",
                sessions_target.display()
            )),
        )
    } else if workspaces_conflict {
        (
            "blocked",
            Some(format!(
                "Kiki workspace catalog target {} already contains data; no files were changed",
                workspaces_target.display()
            )),
        )
    } else if index_conflict {
        (
            "blocked",
            Some(format!(
                "Kiki session index target {} already contains data; no files were changed",
                index_target.display()
            )),
        )
    } else {
        ("ready", None)
    };
    let planned_moves = if status == "noop" {
        Vec::new()
    } else {
        let mut moves = Vec::with_capacity(3);
        if has_workspace_catalog {
            moves.push(SessionsMigrationMove {
                entry: "workspaces.json",
                source: workspaces_source.display().to_string(),
                target: workspaces_target.display().to_string(),
            });
        }
        if has_session_index {
            moves.push(SessionsMigrationMove {
                entry: "session_index.jsonl",
                source: index_source.display().to_string(),
                target: index_target.display().to_string(),
            });
        }
        if has_sessions_data {
            moves.push(SessionsMigrationMove {
                entry: "sessions",
                source: sessions_source.display().to_string(),
                target: sessions_target.display().to_string(),
            });
        }
        moves
    };
    Ok(SessionsMigrationPlan {
        status,
        source_root: source_root.display().to_string(),
        target_root: target_root.display().to_string(),
        session_count,
        total_bytes,
        planned_moves,
        target_conflict,
        blocker,
        execution: "filesystemRename",
    })
}

fn execute_sessions_migration_with(
    rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<SessionsMigrationPlan, String> {
    let prefs = read_desktop_prefs_file();
    let kimi_home = kimi_home_dir()?;
    let kiki_home = kiki_home_dir()?;
    let source_root = selected_compatibility_home(&prefs.compatibility, &kimi_home, &kiki_home)?;
    execute_sessions_migration_with_homes(&prefs.compatibility, &source_root, &kiki_home, rename)
}

fn execute_sessions_migration_with_homes(
    settings: &CompatibilitySettings,
    source_root: &Path,
    target_root: &Path,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<SessionsMigrationPlan, String> {
    let mut plan = plan_sessions_migration_with_homes(settings, source_root, target_root)?;
    if plan.status != "ready" {
        return Ok(plan);
    }
    fs::create_dir_all(target_root).map_err(|error| {
        format!(
            "Cannot prepare Kiki Home {} for the Sessions move: {error}",
            target_root.display()
        )
    })?;
    let moves = plan
        .planned_moves
        .iter()
        .map(|planned| {
            (
                planned.entry,
                source_root.join(planned.entry),
                target_root.join(planned.entry),
            )
        })
        .collect::<Vec<_>>();
    let mut completed = Vec::new();
    for (entry, source, target) in moves {
        if let Err(error) = remove_empty_sessions_target(entry, &target) {
            return compensate_sessions_moves(error, &completed, &mut rename);
        }
        if let Err(error) = rename(&source, &target) {
            let label = match entry {
                "sessions" => "Sessions",
                "workspaces.json" => "workspace catalog",
                "session_index.jsonl" => "session index",
                _ => entry,
            };
            let original = format!(
                "Cannot move {label} from {} to {} with filesystem rename: {error}; no copy was attempted",
                source.display(),
                target.display()
            );
            return compensate_sessions_moves(original, &completed, &mut rename);
        }
        completed.push((entry, source, target));
    }
    plan.status = "moved";
    Ok(plan)
}

fn remove_empty_sessions_target(entry: &str, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    if entry == "sessions" {
        fs::remove_dir_all(target).map_err(|error| {
            format!(
                "Cannot remove empty Kiki Sessions target {} before the move: {error}",
                target.display()
            )
        })
    } else {
        fs::remove_file(target).map_err(|error| {
            format!(
                "Cannot remove empty Kiki {entry} target {} before the move: {error}",
                target.display()
            )
        })
    }
}

fn compensate_sessions_moves(
    original: String,
    completed: &[(&'static str, PathBuf, PathBuf)],
    rename: &mut impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<SessionsMigrationPlan, String> {
    if completed.is_empty() {
        return Err(original);
    }
    let mut restored = Vec::new();
    let mut failures = Vec::new();
    for (entry, source, target) in completed.iter().rev() {
        match rename(target, source) {
            Ok(()) => restored.push(*entry),
            Err(error) => failures.push(format!(
                "compensation rename from {} back to {} for {entry} also failed: {error}",
                target.display(),
                source.display()
            )),
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "Partial Sessions move: {original}; {}",
            failures.join("; ")
        ));
    }
    if completed.len() == 1 && completed[0].0 == "workspaces.json" {
        return Err(format!(
            "{original}; workspace catalog was restored from {} to {}",
            completed[0].2.display(),
            completed[0].1.display()
        ));
    }
    Err(format!(
        "{original}; moved entries were restored in reverse order: {}",
        restored.join(", ")
    ))
}

fn count_sessions(sessions_root: &Path) -> Result<usize, String> {
    if !sessions_root.exists() {
        return Ok(0);
    }
    if !sessions_root.is_dir() {
        return Err(format!(
            "Sessions source {} is not a directory",
            sessions_root.display()
        ));
    }
    let mut count = 0;
    for workspace in read_dir(sessions_root, "Sessions source")? {
        let workspace = workspace.map_err(|error| error.to_string())?;
        if !workspace.path().is_dir() {
            continue;
        }
        for session in read_dir(&workspace.path(), "Sessions workspace")? {
            let session = session.map_err(|error| error.to_string())?;
            let path = session.path();
            if path.is_dir()
                && (path.join("state.json").is_file()
                    || path.join("session-meta").join("state.json").is_file())
            {
                count += 1;
            }
        }
    }
    Ok(count)
}

fn path_bytes(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect {}: {error}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(metadata.len());
    }
    let mut bytes = 0;
    for entry in read_dir(path, "Sessions data")? {
        bytes += path_bytes(&entry.map_err(|error| error.to_string())?.path())?;
    }
    Ok(bytes)
}

fn path_has_data(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect {}: {error}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(true);
    }
    for entry in read_dir(path, "Kiki Sessions target")? {
        if path_has_data(&entry.map_err(|error| error.to_string())?.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn session_index_bytes(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect session index {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "Session index source {} is not a file",
            path.display()
        ));
    }
    Ok(metadata.len())
}

fn session_index_target_has_data(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    if !path.is_file() {
        return Ok(true);
    }
    Ok(session_index_bytes(path)? > 0)
}

fn workspace_catalog_is_empty(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    if !path.is_file() {
        return Ok(false);
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Cannot read workspace catalog {}: {error}", path.display()))?;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(false);
    };
    let Some(object) = value.as_object() else {
        return Ok(true);
    };
    let has_workspace = object
        .get("workspaces")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|workspaces| {
            workspaces.values().any(|entry| {
                entry.as_object().is_some_and(|entry| {
                    ["root", "name", "created_at", "last_opened_at"]
                        .iter()
                        .all(|key| entry.get(*key).is_some_and(serde_json::Value::is_string))
                })
            })
        });
    let has_deleted = object
        .get("deleted_workspace_ids")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|deleted| deleted.iter().any(serde_json::Value::is_string));
    Ok(!has_workspace && !has_deleted)
}

fn read_dir(path: &Path, label: &str) -> Result<fs::ReadDir, String> {
    fs::read_dir(path).map_err(|error| format!("Cannot read {label} {}: {error}", path.display()))
}

fn preflight_category(category: MigrationCategory) -> Result<bool, String> {
    let prefs = read_desktop_prefs_file();
    let kimi_home = kimi_home_dir()?;
    let kiki_home = kiki_home_dir()?;
    let selected = selected_compatibility_home(&prefs.compatibility, &kimi_home, &kiki_home)?;
    let (source, target) = category_paths(category, &selected, &kiki_home);
    if migration_is_noop(&selected, &source, &target, &kiki_home) {
        return Ok(false);
    }
    ensure_empty_target(&target)?;
    if !source.is_dir() {
        return Err(format!(
            "The selected Kimi Home has no User Skills data to migrate at {}",
            source.display()
        ));
    }
    Ok(true)
}

fn migrate_category(category: MigrationCategory) -> Result<MigrationResult, String> {
    let prefs = read_desktop_prefs_file();
    let kimi_home = kimi_home_dir()?;
    let kiki_home = kiki_home_dir()?;
    let selected = selected_compatibility_home(&prefs.compatibility, &kimi_home, &kiki_home)?;
    migrate_category_with(
        category,
        prefs,
        &selected,
        &kiki_home,
        write_desktop_prefs_file,
    )
}

fn category_paths(
    _category: MigrationCategory,
    selected: &Path,
    kiki_home: &Path,
) -> (PathBuf, PathBuf) {
    (selected.join("skills"), kiki_home.join("skills"))
}

fn migrate_category_with(
    category: MigrationCategory,
    prefs: DesktopPrefs,
    selected: &Path,
    kiki_home: &Path,
    write_prefs: impl FnOnce(&DesktopPrefs) -> Result<(), String>,
) -> Result<MigrationResult, String> {
    let (source, target) = category_paths(category, selected, kiki_home);
    if migration_is_noop(selected, &source, &target, kiki_home) {
        return Ok(MigrationResult {
            status: "noop",
            category,
            source: source.display().to_string(),
            target: target.display().to_string(),
            files: 0,
            activation_error: None,
            restart_error: None,
        });
    }
    let files = copy_category_to_target(category, &source, &target, kiki_home)?;
    let activation_error = write_prefs(&prefs).err();
    Ok(MigrationResult {
        status: if activation_error.is_some() {
            "copiedActivationPending"
        } else {
            "copied"
        },
        category,
        source: source.display().to_string(),
        target: target.display().to_string(),
        files,
        activation_error,
        restart_error: None,
    })
}

fn migration_is_noop(selected: &Path, source: &Path, target: &Path, kiki_home: &Path) -> bool {
    paths_equivalent(source, target) || paths_equivalent(selected, kiki_home)
}

fn copy_category_to_target(
    category: MigrationCategory,
    source: &Path,
    target: &Path,
    kiki_home: &Path,
) -> Result<usize, String> {
    ensure_empty_target(target)?;
    let stage = kiki_home.join(format!(
        ".skills-migration-{}-{}",
        std::process::id(),
        unix_epoch_millis()?
    ));
    fs::create_dir_all(&stage)
        .map_err(|error| format!("Cannot prepare migration staging directory: {error}"))?;
    let copied = match category {
        MigrationCategory::UserSkills => copy_tree_contents(source, &stage),
    };
    let files = match copied {
        Ok(files) if files > 0 => files,
        Ok(_) => {
            let _ = fs::remove_dir_all(&stage);
            return Err("The selected Kimi Home has no User Skills data to migrate".to_string());
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    if target.exists() {
        fs::remove_dir(&target).map_err(|error| {
            let _ = fs::remove_dir_all(&stage);
            format!(
                "Kiki migration target {} changed while preparing the copy: {error}",
                target.display()
            )
        })?;
    }
    fs::rename(&stage, &target).map_err(|error| {
        let _ = fs::remove_dir_all(&stage);
        format!(
            "Cannot activate migrated data at {}: {error}",
            target.display()
        )
    })?;
    Ok(files)
}

fn ensure_empty_target(target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    if !target.is_dir() {
        return Err(format!(
            "Kiki migration target {} is occupied; no files were changed",
            target.display()
        ));
    }
    let mut entries = fs::read_dir(target).map_err(|error| {
        format!(
            "Cannot inspect Kiki migration target {}: {error}",
            target.display()
        )
    })?;
    if entries
        .next()
        .transpose()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err(format!(
            "Kiki migration target {} already contains data; no files were changed",
            target.display()
        ));
    }
    Ok(())
}

fn copy_tree_contents(source: &Path, target: &Path) -> Result<usize, String> {
    if !source.is_dir() {
        return Ok(0);
    }
    let mut files = 0;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Cannot read migration source {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        files += copy_path(&entry.path(), &target.join(entry.file_name()))?;
    }
    Ok(files)
}

fn copy_path(source: &Path, target: &Path) -> Result<usize, String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        format!(
            "Cannot inspect migration source {}: {error}",
            source.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Migration source {} is a symbolic link, which this local copy action does not follow",
            source.display()
        ));
    }
    if metadata.is_dir() {
        fs::create_dir_all(target).map_err(|error| {
            format!(
                "Cannot create migration directory {}: {error}",
                target.display()
            )
        })?;
        return copy_tree_contents(source, target);
    }
    if !metadata.is_file() {
        return Err(format!(
            "Migration source {} is not a regular file or directory",
            source.display()
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, target).map_err(|error| {
        format!(
            "Cannot copy migration source {} to {}: {error}",
            source.display(),
            target.display()
        )
    })?;
    Ok(1)
}

fn paths_equivalent(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
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
    if let Some(path) = env::var_os("KIMI_CODE_HOME").filter(|value| !value.is_empty()) {
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

fn find_instance_for_pid(
    home: &Path,
    pid: u32,
    launched_at_ms: u64,
) -> Result<Option<InstanceRecord>, String> {
    let instances = home.join("server").join("instances");
    let entries = match fs::read_dir(&instances) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Cannot read Kiki's server registry at {}: {error}",
                instances.display()
            ))
        }
    };

    let mut records = Vec::new();
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
    Ok(select_instance_for_pid(records, pid, launched_at_ms))
}

fn select_instance_for_pid(
    records: impl IntoIterator<Item = InstanceRecord>,
    pid: u32,
    launched_at_ms: u64,
) -> Option<InstanceRecord> {
    records
        .into_iter()
        .filter(|record| usable_instance(record, pid, launched_at_ms))
        .max_by_key(|record| record.started_at)
}

fn usable_instance(record: &InstanceRecord, pid: u32, launched_at_ms: u64) -> bool {
    record.pid == pid
        && record.started_at >= launched_at_ms
        && is_loopback_host(&record.host)
        && record.port > 0
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

fn sidecar_version_matches(expected: &str, actual: &str) -> bool {
    expected == actual
}

fn authenticated_server_version(port: u16, token: &str) -> Result<String, String> {
    let response = http_get_body(port, "/api/v1/meta", token, MAX_META_RESPONSE_BYTES)?;
    parse_meta_server_version_response(&response)
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
        "/api/v1/workspaces",
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

fn parse_meta_server_version_response(response: &[u8]) -> Result<String, String> {
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
    Ok(envelope.data.server_version)
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
        "/api/v1/shutdown",
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

        custom.compatibility.home_kind = CompatibilityHomeKind::Kiki;
        custom.compatibility.custom_home = None;
        let kiki_paths = resolve_runtime_paths_with_homes(&custom, &kimi, &kiki).unwrap();
        assert_eq!(kiki_paths.oauth_home, kiki);
        assert_eq!(kiki_paths.config_path, kiki.join("config.toml"));

        custom.compatibility.home_kind = CompatibilityHomeKind::Custom;
        custom.compatibility.custom_home = Some("relative".to_string());
        assert!(resolve_runtime_paths_with_homes(&custom, &kimi, &kiki).is_err());
    }

    #[test]
    fn category_migration_copies_sources_and_rejects_occupied_targets() {
        let root = env::temp_dir().join(format!(
            "kiki-category-migration-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let source = root.join("source");
        let kiki = root.join("kiki");
        fs::create_dir_all(source.join("skills").join("demo")).unwrap();
        fs::write(
            source.join("skills").join("demo").join("SKILL.md"),
            "fixture skill",
        )
        .unwrap();
        let skill_target = kiki.join("skills");
        assert_eq!(
            copy_category_to_target(
                MigrationCategory::UserSkills,
                &source.join("skills"),
                &skill_target,
                &kiki,
            )
            .unwrap(),
            1
        );
        assert_eq!(
            fs::read_to_string(skill_target.join("demo").join("SKILL.md")).unwrap(),
            "fixture skill"
        );
        assert!(source.join("skills").join("demo").join("SKILL.md").exists());

        let occupied = kiki.join("occupied-skills");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("existing.txt"), "keep").unwrap();
        let conflict = copy_category_to_target(
            MigrationCategory::UserSkills,
            &source.join("skills"),
            &occupied,
            &kiki,
        )
        .unwrap_err();
        assert!(conflict.contains("already contains data"));
        assert_eq!(
            fs::read_to_string(occupied.join("existing.txt")).unwrap(),
            "keep"
        );
        assert!(!occupied.join("demo").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn category_migration_reports_activation_pending_after_completed_copy() {
        let root = env::temp_dir().join(format!(
            "kiki-category-activation-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let source = root.join("source");
        let kiki = root.join("kiki");
        fs::create_dir_all(source.join("skills/demo")).unwrap();
        fs::write(source.join("skills/demo/SKILL.md"), "fixture skill").unwrap();
        let prefs = DesktopPrefs::default();

        let result = migrate_category_with(
            MigrationCategory::UserSkills,
            prefs,
            &source,
            &kiki,
            |_pending| Err("desktop prefs are read-only".to_string()),
        )
        .unwrap();

        assert_eq!(result.status, "copiedActivationPending");
        assert_eq!(result.files, 1);
        assert_eq!(
            result.activation_error.as_deref(),
            Some("desktop prefs are read-only")
        );
        assert_eq!(
            fs::read_to_string(kiki.join("skills/demo/SKILL.md")).unwrap(),
            "fixture skill"
        );
        assert_eq!(
            fs::read_to_string(source.join("skills/demo/SKILL.md")).unwrap(),
            "fixture skill"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copy_migration_stops_copies_saves_and_restarts_in_order() {
        use std::cell::RefCell;

        let calls = RefCell::new(Vec::new());
        let result = run_copy_migration_lifecycle(
            || {
                calls.borrow_mut().push("preflight");
                Ok(true)
            },
            || calls.borrow_mut().push("stop"),
            || {
                calls.borrow_mut().push("copy+prefs");
                Ok(MigrationResult {
                    status: "copied",
                    category: MigrationCategory::UserSkills,
                    source: "source".to_string(),
                    target: "target".to_string(),
                    files: 1,
                    activation_error: None,
                    restart_error: None,
                })
            },
            || {
                calls.borrow_mut().push("restart");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(result.status, "copied");
        assert_eq!(
            calls.into_inner(),
            vec!["preflight", "stop", "copy+prefs", "restart"]
        );
    }

    #[test]
    fn config_import_noop_skips_backend_and_changes_stop_import_restart_in_order() {
        use std::cell::RefCell;

        let noop_calls = RefCell::new(Vec::new());
        let noop = run_kimi_config_import_lifecycle(
            false,
            KimiConfigImportResult {
                status: "noop",
                source: "source/config.toml".to_string(),
                target: "target/config.toml".to_string(),
                updated_categories: Vec::new(),
                restart_error: None,
            },
            || noop_calls.borrow_mut().push("stop"),
            || {
                noop_calls.borrow_mut().push("import");
                unreachable!()
            },
            || {
                noop_calls.borrow_mut().push("restart");
                unreachable!()
            },
        )
        .unwrap();
        assert_eq!(noop.status, "noop");
        assert!(noop_calls.into_inner().is_empty());

        let calls = RefCell::new(Vec::new());
        let imported = run_kimi_config_import_lifecycle(
            true,
            KimiConfigImportResult {
                status: "imported",
                source: "source/config.toml".to_string(),
                target: "target/config.toml".to_string(),
                updated_categories: vec!["providers".to_string()],
                restart_error: None,
            },
            || calls.borrow_mut().push("stop"),
            || {
                calls.borrow_mut().push("import");
                Ok(config_import::ConfigImportResult {
                    status: "imported",
                    source: "source/config.toml".to_string(),
                    target: "target/config.toml".to_string(),
                    updated_categories: vec!["providers".to_string()],
                })
            },
            || {
                calls.borrow_mut().push("restart");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(imported.status, "imported");
        assert_eq!(calls.into_inner(), vec!["stop", "import", "restart"]);
    }

    #[test]
    fn sessions_migration_dry_run_and_rename_cover_the_owned_dataset() {
        let root = env::temp_dir().join(format!(
            "kiki-sessions-migration-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let source = root.join("source");
        let kiki = root.join("kiki");
        let first = source.join("sessions/workspace-a/session-1");
        let second = source.join("sessions/workspace-b/session-2");
        fs::create_dir_all(first.join("agents/main/blobs")).unwrap();
        fs::create_dir_all(second.join("session-meta")).unwrap();
        fs::create_dir_all(first.join("attachments")).unwrap();
        fs::write(first.join("state.json"), "one").unwrap();
        fs::write(first.join("agents/main/wire.jsonl"), "history").unwrap();
        fs::write(first.join("agents/main/blobs/image"), [1_u8, 2, 3]).unwrap();
        fs::write(first.join("attachments/note.txt"), "file").unwrap();
        fs::write(second.join("session-meta/state.json"), "two").unwrap();
        let workspace_catalog = r#"{"version":1,"workspaces":{"workspace-a":{"root":"C:/repo","name":"repo","created_at":"2026-01-01T00:00:00.000Z","last_opened_at":"2026-01-01T00:00:00.000Z"}},"deleted_workspace_ids":[]}"#;
        fs::write(source.join("workspaces.json"), workspace_catalog).unwrap();
        fs::create_dir_all(&kiki).unwrap();
        let empty_workspace_catalog = r#"{"version":1,"workspaces":{},"deleted_workspace_ids":[]}"#;
        fs::write(kiki.join("workspaces.json"), empty_workspace_catalog).unwrap();
        let settings = CompatibilitySettings::default();

        let dry_run = plan_sessions_migration_with_homes(&settings, &source, &kiki).unwrap();
        assert_eq!(dry_run.status, "ready");
        assert_eq!(dry_run.source_root, source.display().to_string());
        assert_eq!(dry_run.target_root, kiki.display().to_string());
        assert_eq!(dry_run.session_count, 2);
        assert_eq!(
            dry_run.total_bytes,
            3 + 7 + 3 + 4 + 3 + workspace_catalog.len() as u64
        );
        assert_eq!(dry_run.planned_moves.len(), 2);
        assert_eq!(dry_run.planned_moves[0].entry, "workspaces.json");
        assert_eq!(
            dry_run.planned_moves[0].source,
            source.join("workspaces.json").display().to_string()
        );
        assert_eq!(
            dry_run.planned_moves[0].target,
            kiki.join("workspaces.json").display().to_string()
        );
        assert_eq!(dry_run.planned_moves[1].entry, "sessions");
        assert_eq!(
            dry_run.planned_moves[1].source,
            source.join("sessions").display().to_string()
        );
        assert_eq!(
            dry_run.planned_moves[1].target,
            kiki.join("sessions").display().to_string()
        );
        assert!(!dry_run.target_conflict);
        assert_eq!(dry_run.execution, "filesystemRename");
        assert_eq!(fs::read_to_string(first.join("state.json")).unwrap(), "one");
        assert_eq!(
            fs::read_to_string(kiki.join("workspaces.json")).unwrap(),
            empty_workspace_catalog
        );

        let mut rename_calls = 0;
        let moved = execute_sessions_migration_with_homes(&settings, &source, &kiki, |from, to| {
            rename_calls += 1;
            fs::rename(from, to)
        })
        .unwrap();
        assert_eq!(moved.status, "moved");
        assert_eq!(rename_calls, 2);
        assert!(!source.join("sessions").exists());
        assert!(!source.join("workspaces.json").exists());
        assert_eq!(
            fs::read_to_string(kiki.join("workspaces.json")).unwrap(),
            workspace_catalog
        );
        assert_eq!(
            fs::read_to_string(kiki.join("sessions/workspace-a/session-1/state.json")).unwrap(),
            "one"
        );
        assert_eq!(
            fs::read(kiki.join("sessions/workspace-a/session-1/agents/main/blobs/image")).unwrap(),
            [1_u8, 2, 3]
        );
        assert_eq!(
            fs::read_to_string(kiki.join("sessions/workspace-b/session-2/session-meta/state.json"))
                .unwrap(),
            "two"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sessions_migration_handles_index_only_data_and_conflicts() {
        let root = env::temp_dir().join(format!(
            "kiki-session-index-migration-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let settings = CompatibilitySettings::default();
        let blank_source = root.join("blank-source");
        let blank_target = root.join("blank-target");
        fs::create_dir_all(&blank_source).unwrap();
        fs::write(blank_source.join("session_index.jsonl"), "").unwrap();

        let blank =
            plan_sessions_migration_with_homes(&settings, &blank_source, &blank_target).unwrap();
        assert_eq!(blank.status, "noop");
        assert_eq!(blank.total_bytes, 0);
        assert!(blank.planned_moves.is_empty());

        let source = root.join("source");
        let target = root.join("target");
        let index = "{\"sessionId\":\"session-1\",\"workspaceId\":\"workspace-1\"}\n";
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("session_index.jsonl"), index).unwrap();
        fs::write(target.join("session_index.jsonl"), "").unwrap();

        let ready = plan_sessions_migration_with_homes(&settings, &source, &target).unwrap();
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.session_count, 0);
        assert_eq!(ready.total_bytes, index.len() as u64);
        assert_eq!(ready.planned_moves.len(), 1);
        assert_eq!(ready.planned_moves[0].entry, "session_index.jsonl");
        assert!(!ready.target_conflict);

        let moved =
            execute_sessions_migration_with_homes(&settings, &source, &target, |from, to| {
                fs::rename(from, to)
            })
            .unwrap();
        assert_eq!(moved.status, "moved");
        assert!(!source.join("session_index.jsonl").exists());
        assert_eq!(
            fs::read_to_string(target.join("session_index.jsonl")).unwrap(),
            index
        );

        let same_home = plan_sessions_migration_with_homes(&settings, &target, &target).unwrap();
        assert_eq!(same_home.status, "noop");
        assert_eq!(same_home.total_bytes, index.len() as u64);
        assert!(same_home.planned_moves.is_empty());

        let conflict_source = root.join("conflict-source");
        let conflict_target = root.join("conflict-target");
        fs::create_dir_all(&conflict_source).unwrap();
        fs::create_dir_all(&conflict_target).unwrap();
        fs::write(conflict_source.join("session_index.jsonl"), index).unwrap();
        fs::write(
            conflict_target.join("session_index.jsonl"),
            "{\"sessionId\":\"existing\"}\n",
        )
        .unwrap();
        let blocked =
            plan_sessions_migration_with_homes(&settings, &conflict_source, &conflict_target)
                .unwrap();
        assert_eq!(blocked.status, "blocked");
        assert!(blocked.target_conflict);
        assert!(blocked.blocker.unwrap().contains("session index target"));
        let blocked_execute = execute_sessions_migration_with_homes(
            &settings,
            &conflict_source,
            &conflict_target,
            |_, _| panic!("rename must not run for a non-empty session index target"),
        )
        .unwrap();
        assert_eq!(blocked_execute.status, "blocked");
        assert_eq!(
            fs::read_to_string(conflict_source.join("session_index.jsonl")).unwrap(),
            index
        );
        assert_eq!(
            fs::read_to_string(conflict_target.join("session_index.jsonl")).unwrap(),
            "{\"sessionId\":\"existing\"}\n"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sessions_migration_blocks_conflicts_noops_for_kiki_and_surfaces_rename_failure() {
        let root = env::temp_dir().join(format!(
            "kiki-sessions-migration-guards-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let settings = CompatibilitySettings::default();
        let source = root.join("source");
        let kiki = root.join("kiki");
        fs::create_dir_all(source.join("sessions/workspace/session")).unwrap();
        fs::create_dir_all(kiki.join("sessions/workspace/existing")).unwrap();
        fs::write(
            source.join("sessions/workspace/session/state.json"),
            "source",
        )
        .unwrap();
        fs::write(
            kiki.join("sessions/workspace/existing/state.json"),
            "target",
        )
        .unwrap();

        let blocked = plan_sessions_migration_with_homes(&settings, &source, &kiki).unwrap();
        assert_eq!(blocked.status, "blocked");
        assert!(blocked.target_conflict);
        assert!(blocked.blocker.unwrap().contains("already contains data"));
        let blocked_execute =
            execute_sessions_migration_with_homes(&settings, &source, &kiki, |_, _| {
                panic!("rename must not run for a conflicting target")
            })
            .unwrap();
        assert_eq!(blocked_execute.status, "blocked");
        assert_eq!(
            fs::read_to_string(source.join("sessions/workspace/session/state.json")).unwrap(),
            "source"
        );
        assert_eq!(
            fs::read_to_string(kiki.join("sessions/workspace/existing/state.json")).unwrap(),
            "target"
        );

        let catalog_source = root.join("catalog-source");
        let catalog_kiki = root.join("catalog-kiki");
        fs::create_dir_all(catalog_source.join("sessions/workspace/session")).unwrap();
        fs::create_dir_all(&catalog_kiki).unwrap();
        fs::write(
            catalog_source.join("sessions/workspace/session/state.json"),
            "source",
        )
        .unwrap();
        fs::write(
            catalog_source.join("workspaces.json"),
            r#"{"workspaces":{"workspace":{"root":"C:/source","name":"source","created_at":"2026-01-01T00:00:00.000Z","last_opened_at":"2026-01-01T00:00:00.000Z"}}}"#,
        )
        .unwrap();
        fs::write(catalog_kiki.join("workspaces.json"), "occupied").unwrap();
        let catalog_blocked =
            plan_sessions_migration_with_homes(&settings, &catalog_source, &catalog_kiki).unwrap();
        assert_eq!(catalog_blocked.status, "blocked");
        assert!(catalog_blocked.target_conflict);
        assert!(catalog_blocked
            .blocker
            .unwrap()
            .contains("workspace catalog"));
        execute_sessions_migration_with_homes(&settings, &catalog_source, &catalog_kiki, |_, _| {
            panic!("rename must not run for an occupied workspace catalog")
        })
        .unwrap();
        assert!(catalog_source.join("sessions").exists());
        assert!(catalog_source.join("workspaces.json").exists());

        let mut kiki_settings = settings.clone();
        kiki_settings.home_kind = CompatibilityHomeKind::Kiki;
        let noop = execute_sessions_migration_with_homes(&kiki_settings, &kiki, &kiki, |_, _| {
            panic!("rename must not run when Kiki is the source")
        })
        .unwrap();
        assert_eq!(noop.status, "noop");
        assert_eq!(noop.session_count, 1);
        assert_eq!(noop.total_bytes, 6);
        assert!(noop.planned_moves.is_empty());

        let failing_source = root.join("failing-source");
        let failing_kiki = root.join("failing-kiki");
        fs::create_dir_all(failing_source.join("sessions/workspace/session")).unwrap();
        fs::create_dir_all(failing_kiki.join("sessions/empty-workspace")).unwrap();
        fs::write(
            failing_source.join("sessions/workspace/session/state.json"),
            "source",
        )
        .unwrap();
        let failure = execute_sessions_migration_with_homes(
            &settings,
            &failing_source,
            &failing_kiki,
            |_, _| Err(io::Error::other("cross-device link")),
        )
        .unwrap_err();
        assert!(failure.contains("filesystem rename: cross-device link"));
        assert!(failure.contains("no copy was attempted"));
        assert_eq!(
            fs::read_to_string(failing_source.join("sessions/workspace/session/state.json"))
                .unwrap(),
            "source"
        );
        assert!(!failing_kiki.join("sessions").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sessions_rename_failure_compensates_index_and_catalog_in_reverse_order() {
        let root = env::temp_dir().join(format!(
            "kiki-sessions-compensation-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let settings = CompatibilitySettings::default();

        for compensation_fails in [false, true] {
            let suffix = if compensation_fails {
                "partial"
            } else {
                "restored"
            };
            let source = root.join(format!("source-{suffix}"));
            let target = root.join(format!("target-{suffix}"));
            fs::create_dir_all(source.join("sessions/workspace/session")).unwrap();
            fs::create_dir_all(&target).unwrap();
            fs::write(
                source.join("sessions/workspace/session/state.json"),
                "source",
            )
            .unwrap();
            fs::write(
                source.join("workspaces.json"),
                r#"{"workspaces":{"workspace":{"root":"C:/source","name":"source","created_at":"2026-01-01","last_opened_at":"2026-01-01"}}}"#,
            )
            .unwrap();
            fs::write(
                source.join("session_index.jsonl"),
                "{\"sessionId\":\"session\"}\n",
            )
            .unwrap();
            let mut call = 0;
            let error =
                execute_sessions_migration_with_homes(&settings, &source, &target, |from, to| {
                    call += 1;
                    match call {
                        1 => fs::rename(from, to),
                        2 => fs::rename(from, to),
                        3 => Err(io::Error::other("sessions rename failed")),
                        4 if compensation_fails => {
                            Err(io::Error::other("index compensation failed"))
                        }
                        4 | 5 => fs::rename(from, to),
                        _ => unreachable!(),
                    }
                })
                .unwrap_err();

            assert!(error.contains("sessions rename failed"));
            if compensation_fails {
                assert!(error.contains("Partial Sessions move"));
                assert!(error.contains("index compensation failed"));
                assert!(error.contains(&target.join("session_index.jsonl").display().to_string()));
                assert!(error.contains(&source.join("session_index.jsonl").display().to_string()));
                assert!(source.join("workspaces.json").is_file());
                assert!(target.join("session_index.jsonl").is_file());
            } else {
                assert!(error
                    .contains("restored in reverse order: session_index.jsonl, workspaces.json"));
                assert!(source.join("workspaces.json").is_file());
                assert!(source.join("session_index.jsonl").is_file());
                assert!(!target.join("workspaces.json").exists());
                assert!(!target.join("session_index.jsonl").exists());
            }
            assert!(source.join("sessions").is_dir());
            assert!(!target.join("sessions").exists());
        }
        fs::remove_dir_all(root).unwrap();
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
    fn instance_record_requires_exact_pid_loopback_and_bound_port() {
        let valid: InstanceRecord =
            serde_json::from_str(r#"{"pid":42,"host":"127.0.0.1","port":43123,"started_at":200}"#)
                .unwrap();
        assert_eq!(valid.pid, 42);
        assert!(usable_instance(&valid, 42, 150));
        assert!(!usable_instance(&valid, 7, 150));
        assert!(!usable_instance(&valid, 42, 201));

        let wildcard: InstanceRecord =
            serde_json::from_str(r#"{"pid":42,"host":"0.0.0.0","port":43123,"started_at":200}"#)
                .unwrap();
        assert!(!usable_instance(&wildcard, 42, 150));

        let unbound: InstanceRecord =
            serde_json::from_str(r#"{"pid":42,"host":"127.0.0.1","port":0,"started_at":200}"#)
                .unwrap();
        assert!(!usable_instance(&unbound, 42, 150));
    }

    #[test]
    fn instance_selection_rejects_stale_pid_reuse_and_picks_newest_launch() {
        let record = |port, started_at| InstanceRecord {
            pid: 42,
            host: "127.0.0.1".to_string(),
            port,
            started_at,
        };
        let selected = select_instance_for_pid(
            [record(41000, 100), record(43000, 220), record(42000, 200)],
            42,
            150,
        )
        .expect("a post-launch record should be selected");
        assert_eq!(selected.port, 43000);
        assert!(select_instance_for_pid([record(41000, 100)], 42, 150).is_none());
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
    fn metadata_probe_extracts_version_and_rejects_incompatible_payloads() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"data\":{\"server_version\":\"0.36.1\"}}";
        assert_eq!(
            parse_meta_server_version_response(response).unwrap(),
            "0.36.1"
        );
        assert!(sidecar_version_matches("0.36.1", "0.36.1"));
        assert!(!sidecar_version_matches("0.36.1", "0.35.0"));

        let missing = b"HTTP/1.1 200 OK\r\n\r\n{\"data\":{}}";
        assert!(parse_meta_server_version_response(missing).is_err());
        let rejected = b"HTTP/1.1 401 Unauthorized\r\n\r\n{}";
        assert!(parse_meta_server_version_response(rejected).is_err());
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

    #[test]
    fn host_file_write_requires_an_authorized_root_and_writes_utf8() {
        let root = env::temp_dir().join(format!(
            "kiki-host-file-write-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let manager = BackendManager::default();
        manager.authorize_host_roots_for_tests(&[root.as_path()]);
        let path = root.join("note.txt");

        manager.write_host_file_text(&path, "hello 世界").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello 世界");
        assert!(manager
            .write_host_file_text(Path::new("relative.txt"), "no")
            .is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_path_openers_reject_relative_paths() {
        let manager = BackendManager::default();
        assert!(manager.reveal_host_path(Path::new("relative.txt")).is_err());
        assert!(manager.open_host_path(Path::new("relative.txt")).is_err());
    }

    #[test]
    fn host_paths_outside_authorized_roots_fail_closed() {
        let millis = unix_epoch_millis().unwrap();
        let pid = std::process::id();
        let allowed = env::temp_dir().join(format!("kiki-root-allowed-{pid}-{millis}"));
        let other = env::temp_dir().join(format!("kiki-root-other-{pid}-{millis}"));
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("secret.txt"), "x").unwrap();

        let manager = BackendManager::default();
        manager.authorize_host_roots_for_tests(&[allowed.as_path()]);

        // Inside the authorized root all three ops pass the gate (calling the
        // gate directly never reaches ShellExecute/explorer in tests).
        let inside = allowed.join("note.txt");
        fs::write(&inside, "x").unwrap();
        manager
            .require_authorized_host_path(&inside, HostPathOp::Open)
            .unwrap();
        manager
            .require_authorized_host_path(&inside, HostPathOp::Reveal)
            .unwrap();
        // Writes also cover a file that does not exist yet.
        manager
            .write_host_file_text(&allowed.join("created.txt"), "new")
            .unwrap();
        assert_eq!(
            fs::read_to_string(allowed.join("created.txt")).unwrap(),
            "new"
        );

        // Outside the root everything is rejected; with no backend connected
        // the miss-triggered registry refresh fails too — the gate fails
        // CLOSED either way.
        let outside = other.join("secret.txt");
        assert!(manager
            .require_authorized_host_path(&outside, HostPathOp::Open)
            .is_err());
        assert!(manager
            .require_authorized_host_path(&outside, HostPathOp::Reveal)
            .is_err());
        assert!(manager
            .write_host_file_text(&other.join("pwned.txt"), "no")
            .is_err());
        assert!(!other.join("pwned.txt").exists());

        fs::remove_dir_all(allowed).unwrap();
        fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn open_refuses_executables_even_inside_an_authorized_root() {
        let root = env::temp_dir().join(format!(
            "kiki-root-exec-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let manager = BackendManager::default();
        manager.authorize_host_roots_for_tests(&[root.as_path()]);

        for name in [
            "runme.exe",
            "script.BAT",
            "evil.ps1",
            "x.cmd",
            "x.msi",
            "x.lnk",
            "x.js",
        ] {
            let path = root.join(name);
            fs::write(&path, "x").unwrap();
            assert!(
                manager
                    .require_authorized_host_path(&path, HostPathOp::Open)
                    .is_err(),
                "{name} must be refused"
            );
            // Reveal stays allowed: selecting a file in Explorer runs nothing.
            manager
                .require_authorized_host_path(&path, HostPathOp::Reveal)
                .unwrap();
        }
        let document = root.join("readme.md");
        fs::write(&document, "x").unwrap();
        manager
            .require_authorized_host_path(&document, HostPathOp::Open)
            .unwrap();

        fs::remove_dir_all(root).unwrap();
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
        for raw in [
            r"\\server\share\file.txt",
            r"\\.\PhysicalDrive0",
            r"\\?\C:\Windows\notepad.exe",
        ] {
            let path = Path::new(raw);
            assert!(path.is_absolute(), "{raw}");
            for op in [HostPathOp::Open, HostPathOp::Reveal, HostPathOp::Write] {
                assert!(
                    manager.require_authorized_host_path(path, op).is_err(),
                    "{raw} must be refused for {op:?}"
                );
            }
        }
    }

    #[test]
    fn symlink_escape_outside_an_authorized_root_is_rejected() {
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
        manager.authorize_host_roots_for_tests(&[root.as_path()]);
        let escape = link.join("secret.txt");
        assert!(escape.exists());
        assert!(manager
            .require_authorized_host_path(&escape, HostPathOp::Open)
            .is_err());
        // ...including a not-yet-created file reached through the symlink.
        assert!(manager
            .write_host_file_text(&link.join("new.txt"), "no")
            .is_err());
        assert!(!outside.join("new.txt").exists());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn dotdot_segments_cannot_escape_an_authorized_root() {
        let base = env::temp_dir().join(format!(
            "kiki-root-dotdot-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        let root = base.join("root");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let manager = BackendManager::default();
        manager.authorize_host_roots_for_tests(&[root.as_path()]);

        let escape = sub.join("..").join("..").join("escape.txt");
        assert!(manager.write_host_file_text(&escape, "no").is_err());
        assert!(!base.join("escape.txt").exists());

        // A `..` that stays INSIDE the root keeps working.
        let within = sub.join("..").join("ok.txt");
        manager.write_host_file_text(&within, "yes").unwrap();
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
