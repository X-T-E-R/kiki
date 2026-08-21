/**
 * Kiki desktop shell: one user-facing window, an owned Kiki SEA backend,
 * a system tray icon, close-to-tray, and approval notifications.
 *
 * The bounded shutdown and process-tree fallback follow LiveAgent's managed
 * process lifecycle at 00a2c6fc43754f40022b0703459824559bee73ea (MIT).
 * Kiki deliberately keeps only the single-child subset needed here and relies
 * on kap-server's own registry, token, and authenticated shutdown contracts.
 */
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
    AppHandle, Emitter, Manager, RunEvent, State, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent, TerminatedPayload},
    ShellExt,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const MAX_HTTP_STATUS_LINE_BYTES: usize = 256;
const MAX_META_RESPONSE_BYTES: usize = 64 * 1024;
const EXPECTED_SIDECAR_SERVER_VERSION: &str = env!("KIKI_SIDECAR_SERVER_VERSION");
const TRAY_ID: &str = "main-tray";
/// Filename (under the kimi home) the desktop backend's stderr is appended to.
const DESKTOP_BACKEND_LOG_FILE: &str = "desktop-backend.log";
/// In-memory stderr lines kept for startup-failure diagnostics.
const STDERR_TAIL_LINES: usize = 100;
/// Frontend event carrying the boot phase ("waiting" once the sidecar exists).
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

/// Structured startup failure for the frontend's desktop failure card.
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
fn spawn_backend_event_pump(mut events: Receiver<CommandEvent>, monitor: Arc<BackendMonitor>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(_) => {}
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    monitor.record_stderr_line(line.trim_end_matches(['\n', '\r']));
                }
                CommandEvent::Error(message) => {
                    monitor.record_stderr_line(&format!("sidecar error: {message}"));
                }
                CommandEvent::Terminated(payload) => monitor.set_exit(payload),
                // CommandEvent is #[non_exhaustive]; future event kinds are
                // intentionally ignored by this diagnostics pump.
                _ => {}
            }
        }
        monitor.ensure_exit();
    });
}

fn emit_backend_stage(app: &AppHandle, stage: &'static str) {
    let _ = app.emit(BACKEND_STAGE_EVENT, stage);
}

struct OwnedBackend {
    child: CommandChild,
    pid: u32,
    launched_at_ms: u64,
    connection: Option<DesktopConnection>,
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

#[derive(Clone, Default)]
struct BackendManager {
    inner: Arc<Mutex<Option<OwnedBackend>>>,
}

impl BackendManager {
    fn has_backend(&self) -> bool {
        self.inner.lock().is_ok_and(|slot| slot.is_some())
    }

    fn connection(&self, app: &AppHandle) -> Result<DesktopConnection, DesktopStartupFailure> {
        // Locked phase — spawn decision and slot writes only. The readiness
        // wait below runs outside the lock so a slow cold start cannot block
        // restart or a concurrent reconnect for up to STARTUP_TIMEOUT.
        let pending = {
            let mut slot = self.inner.lock().map_err(|_| {
                DesktopStartupFailure::plain("Kiki backend lifecycle lock was poisoned".to_string())
            })?;

            if let Some(connection) = slot
                .as_ref()
                .and_then(|backend| backend.connection.as_ref())
            {
                return Ok(connection.clone());
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
                        .env("KIKI_DESKTOP_CONFIG_PATH", &runtime.config_path)
                        .env(
                            "KIKI_DESKTOP_MODEL_ACCOUNT_HOME",
                            &runtime.model_account_home,
                        )
                        .env("KIKI_DESKTOP_USER_SKILL_DIR", &runtime.user_skill_dir);
                    let (events, child) = command.spawn().map_err(|error| {
                        DesktopStartupFailure::plain(format!(
                            "Cannot start the packaged Kiki backend: {error}"
                        ))
                    })?;
                    let pid = child.pid();
                    let monitor = Arc::new(BackendMonitor::open(&home));
                    spawn_backend_event_pump(events, monitor.clone());
                    emit_backend_stage(app, "waiting");

                    let monitor_handle = monitor.clone();
                    *slot = Some(OwnedBackend {
                        child,
                        pid,
                        launched_at_ms,
                        connection: None,
                        monitor: monitor_handle,
                        home: home.clone(),
                    });
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
                        self.publish_connection(&pending, &connection);
                        return Ok(connection);
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

    /// Cache the resolved connection iff the slot still holds this launch.
    fn publish_connection(&self, pending: &PendingBackend, connection: &DesktopConnection) {
        let Ok(mut slot) = self.inner.lock() else {
            return;
        };
        if let Some(backend) = slot.as_mut() {
            if backend.pid == pending.pid
                && backend.launched_at_ms == pending.launched_at_ms
                && backend.connection.is_none()
            {
                backend.connection = Some(connection.clone());
            }
        }
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
        if let Some(backend) = self.take_backend_if(|candidate| candidate.connection.is_none()) {
            force_stop(backend);
        }
    }

    fn take_backend_if(&self, matches: impl Fn(&OwnedBackend) -> bool) -> Option<OwnedBackend> {
        self.inner.lock().ok().and_then(|mut slot| {
            if slot.as_ref().is_some_and(matches) {
                slot.take()
            } else {
                None
            }
        })
    }

    fn shutdown(&self) {
        let backend = self.inner.lock().ok().and_then(|mut slot| slot.take());
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
    inherit_models_accounts: bool,
    inherit_user_skills: bool,
}

impl Default for CompatibilitySettings {
    fn default() -> Self {
        Self {
            home_kind: CompatibilityHomeKind::Kimi,
            custom_home: None,
            inherit_models_accounts: true,
            inherit_user_skills: true,
        }
    }
}

struct RuntimePaths {
    kiki_home: PathBuf,
    config_path: PathBuf,
    model_account_home: PathBuf,
    user_skill_dir: PathBuf,
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
    let selected = selected_compatibility_home(&settings.compatibility, kimi_home, kiki_home)?;
    let kiki_model_account_home = kiki_home.join("models-and-accounts");
    let model_account_home = if settings.compatibility.inherit_models_accounts
        && settings.compatibility.home_kind != CompatibilityHomeKind::Kiki
    {
        selected.clone()
    } else {
        kiki_model_account_home
    };
    let user_skill_dir = if settings.compatibility.inherit_user_skills
        && settings.compatibility.home_kind != CompatibilityHomeKind::Kiki
    {
        selected.join("skills")
    } else {
        kiki_home.join("skills")
    };
    Ok(RuntimePaths {
        kiki_home: kiki_home.to_path_buf(),
        config_path: model_account_home.join("config.toml"),
        model_account_home,
        user_skill_dir,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct DesktopPrefs {
    notifications: bool,
    close_to_tray: bool,
    /// UI locale mirrored from the frontend ("en"/"zh"); drives tray labels.
    locale: Option<String>,
    compatibility: CompatibilitySettings,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            notifications: true,
            close_to_tray: true,
            locale: None,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum MigrationCategory {
    ModelsAccounts,
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

#[tauri::command]
async fn migrate_compatibility_category(
    category: MigrationCategory,
) -> Result<MigrationResult, String> {
    tauri::async_runtime::spawn_blocking(move || migrate_category(category))
        .await
        .map_err(|error| format!("Compatibility migration task failed: {error}"))?
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
    settings: &CompatibilitySettings,
    source_root: &Path,
    target_root: &Path,
) -> Result<SessionsMigrationPlan, String> {
    let sessions_source = source_root.join("sessions");
    let sessions_target = target_root.join("sessions");
    let workspaces_source = source_root.join("workspaces.json");
    let workspaces_target = target_root.join("workspaces.json");
    let sessions_move = SessionsMigrationMove {
        entry: "sessions",
        source: sessions_source.display().to_string(),
        target: sessions_target.display().to_string(),
    };
    let workspaces_move = SessionsMigrationMove {
        entry: "workspaces.json",
        source: workspaces_source.display().to_string(),
        target: workspaces_target.display().to_string(),
    };
    let session_count = count_sessions(&sessions_source)?;
    let sessions_bytes = path_bytes(&sessions_source)?;
    let has_sessions_data = session_count > 0 || sessions_bytes > 0;
    let has_workspace_catalog =
        workspaces_source.exists() && !workspace_catalog_is_empty(&workspaces_source)?;
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
    let total_bytes = sessions_bytes + workspace_bytes;
    if settings.home_kind == CompatibilityHomeKind::Kiki
        || paths_equivalent(source_root, target_root)
    {
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
    let workspaces_conflict = has_sessions_data
        && has_workspace_catalog
        && !workspace_catalog_is_empty(&workspaces_target)?;
    let target_conflict = sessions_conflict || workspaces_conflict;
    let (status, blocker) = if !has_sessions_data {
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
    } else {
        ("ready", None)
    };
    let planned_moves = if status == "noop" {
        Vec::new()
    } else {
        let mut moves = Vec::with_capacity(if has_workspace_catalog { 2 } else { 1 });
        if has_workspace_catalog {
            moves.push(workspaces_move);
        }
        moves.push(sessions_move);
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
    let sessions_source = source_root.join("sessions");
    let sessions_target = target_root.join("sessions");
    let workspaces_source = source_root.join("workspaces.json");
    let workspaces_target = target_root.join("workspaces.json");
    fs::create_dir_all(target_root).map_err(|error| {
        format!(
            "Cannot prepare Kiki Home {} for the Sessions move: {error}",
            target_root.display()
        )
    })?;
    if plan
        .planned_moves
        .iter()
        .any(|planned| planned.entry == "workspaces.json")
    {
        if workspaces_target.exists() {
            fs::remove_file(&workspaces_target).map_err(|error| {
                format!(
                    "Cannot remove empty Kiki workspace catalog {} before the move: {error}",
                    workspaces_target.display()
                )
            })?;
        }
        rename(&workspaces_source, &workspaces_target).map_err(|error| {
            format!(
                "Cannot move workspace catalog from {} to {} with filesystem rename: {error}; no copy was attempted",
                workspaces_source.display(),
                workspaces_target.display()
            )
        })?;
    }
    if sessions_target.exists() {
        fs::remove_dir_all(&sessions_target).map_err(|error| {
            format!(
                "Cannot remove empty Kiki Sessions target {} before the move: {error}",
                sessions_target.display()
            )
        })?;
    }
    rename(&sessions_source, &sessions_target).map_err(|error| {
        format!(
            "Cannot move Sessions from {} to {} with filesystem rename: {error}; no copy was attempted",
            sessions_source.display(),
            sessions_target.display()
        )
    })?;
    plan.status = "moved";
    Ok(plan)
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

fn migrate_category_with(
    category: MigrationCategory,
    mut prefs: DesktopPrefs,
    selected: &Path,
    kiki_home: &Path,
    write_prefs: impl FnOnce(&DesktopPrefs) -> Result<(), String>,
) -> Result<MigrationResult, String> {
    let (source, target) = match category {
        MigrationCategory::ModelsAccounts => (
            selected.to_path_buf(),
            kiki_home.join("models-and-accounts"),
        ),
        MigrationCategory::UserSkills => (selected.join("skills"), kiki_home.join("skills")),
    };
    if migration_is_noop(
        &prefs.compatibility,
        &selected,
        &source,
        &target,
        &kiki_home,
    ) {
        return Ok(MigrationResult {
            status: "noop",
            category,
            source: source.display().to_string(),
            target: target.display().to_string(),
            files: 0,
            activation_error: None,
        });
    }
    let files = copy_category_to_target(category, &source, &target, &kiki_home)?;
    match category {
        MigrationCategory::ModelsAccounts => {
            prefs.compatibility.inherit_models_accounts = false;
        }
        MigrationCategory::UserSkills => {
            prefs.compatibility.inherit_user_skills = false;
        }
    }
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
    })
}

fn migration_is_noop(
    settings: &CompatibilitySettings,
    selected: &Path,
    source: &Path,
    target: &Path,
    kiki_home: &Path,
) -> bool {
    settings.home_kind == CompatibilityHomeKind::Kiki
        || paths_equivalent(source, target)
        || paths_equivalent(selected, kiki_home)
}

fn copy_category_to_target(
    category: MigrationCategory,
    source: &Path,
    target: &Path,
    kiki_home: &Path,
) -> Result<usize, String> {
    ensure_empty_target(target)?;
    let stage = kiki_home.join(format!(
        ".{}-migration-{}-{}",
        match category {
            MigrationCategory::ModelsAccounts => "models-and-accounts",
            MigrationCategory::UserSkills => "skills",
        },
        std::process::id(),
        unix_epoch_millis()?
    ));
    fs::create_dir_all(&stage)
        .map_err(|error| format!("Cannot prepare migration staging directory: {error}"))?;
    let copied = match category {
        MigrationCategory::ModelsAccounts => copy_model_account_category(&source, &stage),
        MigrationCategory::UserSkills => copy_tree_contents(&source, &stage),
    };
    let files = match copied {
        Ok(files) if files > 0 => files,
        Ok(_) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!(
                "The selected compatibility Home has no {} data to migrate",
                match category {
                    MigrationCategory::ModelsAccounts => "Models & Accounts",
                    MigrationCategory::UserSkills => "User Skills",
                }
            ));
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

fn copy_model_account_category(source: &Path, target: &Path) -> Result<usize, String> {
    let mut files = 0;
    for name in ["config.toml", "device_id", "credentials", "oauth"] {
        let from = source.join(name);
        if !from.exists() {
            continue;
        }
        let to = target.join(name);
        files += copy_path(&from, &to)?;
    }
    Ok(files)
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
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|error| format!("Cannot connect to Kiki backend on port {port}: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Cannot configure Kiki backend metadata probe: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Cannot configure Kiki backend metadata probe: {error}"))?;

    let request = format!(
        "GET /api/v1/meta HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Cannot write Kiki backend metadata request: {error}"))?;

    let mut response = Vec::new();
    stream
        .take((MAX_META_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|error| format!("Cannot read Kiki backend metadata response: {error}"))?;
    if response.len() > MAX_META_RESPONSE_BYTES {
        return Err("Kiki backend metadata response is unexpectedly large".to_string());
    }
    parse_meta_server_version_response(&response)
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

fn shutdown_request(connection: &DesktopConnection) -> Result<(), String> {
    let port = connection
        .url
        .rsplit_once(':')
        .and_then(|(_, value)| value.parse::<u16>().ok())
        .ok_or_else(|| "Kiki desktop connection contained an invalid port".to_string())?;
    http_request(port, "POST", "/api/v1/shutdown", &connection.token)
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
        .plugin(tauri_plugin_notification::init())
        .manage(manager)
        .invoke_handler(tauri::generate_handler![
            desktop_connection,
            cancel_desktop_startup,
            show_main_window,
            read_desktop_prefs,
            write_desktop_prefs,
            migrate_compatibility_category,
            dry_run_sessions_migration,
            execute_sessions_migration,
            restart_server
        ])
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

        let corrupt = serde_json::from_str::<DesktopPrefs>("{not-json").unwrap_or_default();
        assert!(corrupt.close_to_tray);
    }

    #[test]
    fn compatibility_defaults_validation_and_runtime_resolution() {
        let defaults: DesktopPrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(
            defaults.compatibility,
            CompatibilitySettings {
                home_kind: CompatibilityHomeKind::Kimi,
                custom_home: None,
                inherit_models_accounts: true,
                inherit_user_skills: true,
            }
        );

        let root = if cfg!(windows) {
            PathBuf::from("C:\\homes")
        } else {
            PathBuf::from("/homes")
        };
        let kimi = root.join("kimi");
        let kiki = root.join("kiki");
        let inherited = resolve_runtime_paths_with_homes(&defaults, &kimi, &kiki).unwrap();
        assert_eq!(inherited.kiki_home, kiki);
        assert_eq!(inherited.config_path, kimi.join("config.toml"));
        assert_eq!(inherited.model_account_home, kimi);
        assert_eq!(inherited.user_skill_dir, kimi.join("skills"));

        let mut local = defaults.clone();
        local.compatibility.inherit_models_accounts = false;
        local.compatibility.inherit_user_skills = false;
        let local_paths = resolve_runtime_paths_with_homes(&local, &kimi, &kiki).unwrap();
        assert_eq!(
            local_paths.model_account_home,
            kiki.join("models-and-accounts")
        );
        assert_eq!(local_paths.user_skill_dir, kiki.join("skills"));

        let mut custom = defaults.clone();
        custom.compatibility.home_kind = CompatibilityHomeKind::Custom;
        let custom_home = root.join("custom");
        custom.compatibility.custom_home = Some(custom_home.display().to_string());
        let custom_paths = resolve_runtime_paths_with_homes(&custom, &kimi, &kiki).unwrap();
        assert_eq!(custom_paths.model_account_home, custom_home);
        assert_eq!(
            custom_paths.user_skill_dir,
            root.join("custom").join("skills")
        );

        custom.compatibility.custom_home = Some("relative".to_string());
        assert!(resolve_runtime_paths_with_homes(&custom, &kimi, &kiki).is_err());

        let mut kiki_selected = defaults;
        kiki_selected.compatibility.home_kind = CompatibilityHomeKind::Kiki;
        let kiki_paths = resolve_runtime_paths_with_homes(&kiki_selected, &kimi, &kiki).unwrap();
        assert_eq!(
            kiki_paths.model_account_home,
            kiki.join("models-and-accounts")
        );
        assert_eq!(kiki_paths.user_skill_dir, kiki.join("skills"));
        assert!(migration_is_noop(
            &kiki_selected.compatibility,
            &kiki,
            &kiki.join("skills"),
            &kiki.join("skills"),
            &kiki,
        ));
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
        fs::create_dir_all(source.join("credentials")).unwrap();
        fs::create_dir_all(source.join("oauth")).unwrap();
        fs::write(source.join("config.toml"), "default_model = 'example'").unwrap();
        fs::write(source.join("device_id"), "device-example").unwrap();
        fs::write(
            source.join("credentials").join("account.json"),
            "fixture-token",
        )
        .unwrap();
        fs::write(source.join("oauth").join("kimi-code.lock"), "fixture-lock").unwrap();
        let model_target = kiki.join("models-and-accounts");
        let model_files = copy_category_to_target(
            MigrationCategory::ModelsAccounts,
            &source,
            &model_target,
            &kiki,
        )
        .unwrap();
        assert_eq!(model_files, 4);
        assert_eq!(
            fs::read_to_string(model_target.join("config.toml")).unwrap(),
            "default_model = 'example'"
        );
        assert_eq!(
            fs::read_to_string(source.join("credentials").join("account.json")).unwrap(),
            "fixture-token"
        );

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
            |pending| {
                assert!(!pending.compatibility.inherit_user_skills);
                Err("desktop prefs are read-only".to_string())
            },
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
}
