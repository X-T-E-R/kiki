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
    collections::BTreeMap,
    env, fs,
    fs::OpenOptions,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use toml_edit::{table, value, DocumentMut, Item};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const MAX_HTTP_STATUS_LINE_BYTES: usize = 256;

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

struct OwnedBackend {
    child: CommandChild,
    pid: u32,
    launched_at_ms: u64,
    connection: Option<DesktopConnection>,
}

#[derive(Clone, Default)]
struct BackendManager {
    inner: Arc<Mutex<Option<OwnedBackend>>>,
}

impl BackendManager {
    fn connection(&self, app: &AppHandle) -> Result<DesktopConnection, String> {
        let mut slot = self
            .inner
            .lock()
            .map_err(|_| "Kiki backend lifecycle lock was poisoned".to_string())?;

        if let Some(connection) = slot
            .as_ref()
            .and_then(|backend| backend.connection.as_ref())
        {
            return Ok(connection.clone());
        }

        if slot.is_none() {
            // Capture the epoch before spawn. A reused PID can make an old
            // registry record look live, so PID alone is not sufficient to
            // identify the child we just created.
            let launched_at_ms = unix_epoch_millis()?;
            let command = app
                .shell()
                .sidecar("kiki-server")
                .map_err(|error| format!("Cannot resolve the packaged Kiki backend: {error}"))?
                .args(["web", "--no-open", "--port", "0"]);
            let (mut events, child) = command
                .spawn()
                .map_err(|error| format!("Cannot start the packaged Kiki backend: {error}"))?;
            let pid = child.pid();

            // Drain sidecar output so its pipes cannot fill. The CLI's ready
            // line can contain the bearer token, so desktop never forwards or
            // logs stdout/stderr from this channel.
            tauri::async_runtime::spawn(async move { while events.recv().await.is_some() {} });

            *slot = Some(OwnedBackend {
                child,
                pid,
                launched_at_ms,
                connection: None,
            });
        }

        let backend = slot.as_ref().expect("backend was inserted");
        let pid = backend.pid;
        let launched_at_ms = backend.launched_at_ms;
        let home = kimi_home_dir()?;
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let ready = loop {
            if let Some(record) = find_instance_for_pid(&home, pid, launched_at_ms)? {
                if let Some(token) = read_token(&home)? {
                    let connection = DesktopConnection {
                        url: format!("http://127.0.0.1:{}", record.port),
                        token,
                    };
                    if authenticated_probe(record.port, &connection.token) {
                        break Ok(connection);
                    }
                }
            }
            if Instant::now() >= deadline {
                break Err(format!(
                    "Kiki backend (pid {pid}) did not become ready within {} seconds",
                    STARTUP_TIMEOUT.as_secs()
                ));
            }
            thread::sleep(STARTUP_POLL_INTERVAL);
        };

        match ready {
            Ok(connection) => {
                if let Some(backend) = slot.as_mut() {
                    backend.connection = Some(connection.clone());
                }
                Ok(connection)
            }
            Err(error) => {
                if let Some(backend) = slot.take() {
                    force_stop(backend);
                }
                Err(error)
            }
        }
    }

    fn shutdown(&self) {
        let backend = self.inner.lock().ok().and_then(|mut slot| slot.take());
        let Some(backend) = backend else {
            return;
        };

        if let Some(connection) = backend.connection.as_ref() {
            let _ = shutdown_request(connection);
            let home = kimi_home_dir().ok();
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            while Instant::now() < deadline {
                let registered = home
                    .as_deref()
                    .and_then(|path| {
                        find_instance_for_pid(path, backend.pid, backend.launched_at_ms).ok()
                    })
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

    fn restart(&self, app: &AppHandle) -> Result<DesktopConnection, String> {
        self.shutdown();
        self.connection(app)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct DesktopPrefs {
    notifications: bool,
    close_to_tray: bool,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            notifications: true,
            close_to_tray: true,
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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopServerConfig {
    config_path: String,
    backup_path: String,
    subagent: DesktopSubagentConfig,
    agents: DesktopAgentsConfig,
    builtin_product_skills: bool,
    model_catalog: DesktopModelCatalogConfig,
    experimental_env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSubagentConfig {
    default_model: String,
    default_effort: String,
    timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAgentsConfig {
    enabled: bool,
    default_subagent_model: String,
    default_subagent_reasoning_effort: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopModelCatalogConfig {
    refresh_interval_ms: u64,
    refresh_on_start: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopServerConfigPatch {
    subagent_default_model: String,
    subagent_default_effort: String,
    subagent_timeout_ms: u64,
    agents_enabled: bool,
    default_subagent_model: String,
    default_subagent_reasoning_effort: String,
    builtin_product_skills: bool,
    model_catalog_refresh_interval_ms: u64,
    model_catalog_refresh_on_start: bool,
}

fn server_config_path() -> Result<PathBuf, String> {
    Ok(kimi_home_dir()?.join("config.toml"))
}

fn server_config_backup_path(path: &Path) -> PathBuf {
    path.with_extension("toml.kiki-backup")
}

fn read_server_config_file(path: &Path) -> Result<DesktopServerConfig, String> {
    let doc = read_config_document(path)?;
    let experimental_env = env::vars()
        .filter(|(name, _)| name.starts_with("KIMI_CODE_EXPERIMENTAL_"))
        .collect::<BTreeMap<_, _>>();
    Ok(DesktopServerConfig {
        config_path: path.display().to_string(),
        backup_path: server_config_backup_path(path).display().to_string(),
        subagent: DesktopSubagentConfig {
            default_model: table_string(&doc, "subagent", "default_model"),
            default_effort: table_string(&doc, "subagent", "default_effort"),
            timeout_ms: table_u64(&doc, "subagent", "timeout_ms").unwrap_or(7_200_000),
        },
        agents: DesktopAgentsConfig {
            enabled: table_bool(&doc, "agents", "enabled").unwrap_or(true),
            default_subagent_model: table_string(&doc, "agents", "default_subagent_model"),
            default_subagent_reasoning_effort: table_string(
                &doc,
                "agents",
                "default_subagent_reasoning_effort",
            ),
        },
        builtin_product_skills: doc
            .get("builtin_product_skills")
            .and_then(Item::as_bool)
            .unwrap_or(true),
        model_catalog: DesktopModelCatalogConfig {
            refresh_interval_ms: table_u64(&doc, "model_catalog", "refresh_interval_ms")
                .unwrap_or(0),
            refresh_on_start: table_bool(&doc, "model_catalog", "refresh_on_start")
                .unwrap_or(false),
        },
        experimental_env,
    })
}

fn read_config_document(path: &Path) -> Result<DocumentMut, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
    };
    raw.parse::<DocumentMut>()
        .map_err(|error| format!("Invalid TOML in {}: {error}", path.display()))
}

fn table_string(doc: &DocumentMut, section: &str, key: &str) -> String {
    doc.get(section)
        .and_then(Item::as_table)
        .and_then(|table| table.get(key))
        .and_then(Item::as_str)
        .unwrap_or_default()
        .to_string()
}

fn table_bool(doc: &DocumentMut, section: &str, key: &str) -> Option<bool> {
    doc.get(section)
        .and_then(Item::as_table)
        .and_then(|table| table.get(key))
        .and_then(Item::as_bool)
}

fn table_u64(doc: &DocumentMut, section: &str, key: &str) -> Option<u64> {
    doc.get(section)
        .and_then(Item::as_table)
        .and_then(|table| table.get(key))
        .and_then(Item::as_integer)
        .and_then(|number| u64::try_from(number).ok())
}

fn write_server_config_file(
    path: &Path,
    patch: DesktopServerConfigPatch,
) -> Result<DesktopServerConfig, String> {
    if patch.subagent_timeout_ms > 86_400_000 {
        return Err("Subagent timeout cannot exceed 24 hours".to_string());
    }
    let mut doc = read_config_document(path)?;
    set_table_string(
        &mut doc,
        "subagent",
        "default_model",
        &patch.subagent_default_model,
    );
    set_table_string(
        &mut doc,
        "subagent",
        "default_effort",
        &patch.subagent_default_effort,
    );
    set_table_integer(
        &mut doc,
        "subagent",
        "timeout_ms",
        patch.subagent_timeout_ms,
    )?;
    set_table_bool(&mut doc, "agents", "enabled", patch.agents_enabled);
    set_table_string(
        &mut doc,
        "agents",
        "default_subagent_model",
        &patch.default_subagent_model,
    );
    set_table_string(
        &mut doc,
        "agents",
        "default_subagent_reasoning_effort",
        &patch.default_subagent_reasoning_effort,
    );
    doc["builtin_product_skills"] = value(patch.builtin_product_skills);
    set_table_integer(
        &mut doc,
        "model_catalog",
        "refresh_interval_ms",
        patch.model_catalog_refresh_interval_ms,
    )?;
    set_table_bool(
        &mut doc,
        "model_catalog",
        "refresh_on_start",
        patch.model_catalog_refresh_on_start,
    );
    atomic_write_config(path, &doc.to_string())?;
    read_server_config_file(path)
}

fn ensure_table(doc: &mut DocumentMut, section: &str) {
    if !doc.get(section).is_some_and(Item::is_table) {
        doc[section] = table();
    }
}

fn set_table_string(doc: &mut DocumentMut, section: &str, key: &str, next: &str) {
    ensure_table(doc, section);
    if next.is_empty() {
        if let Some(table) = doc.get_mut(section).and_then(Item::as_table_mut) {
            table.remove(key);
        }
    } else {
        doc[section][key] = value(next);
    }
}

fn set_table_bool(doc: &mut DocumentMut, section: &str, key: &str, next: bool) {
    ensure_table(doc, section);
    doc[section][key] = value(next);
}

fn set_table_integer(
    doc: &mut DocumentMut,
    section: &str,
    key: &str,
    next: u64,
) -> Result<(), String> {
    let next = i64::try_from(next).map_err(|_| format!("{section}.{key} is too large"))?;
    ensure_table(doc, section);
    doc[section][key] = value(next);
    Ok(())
}

fn atomic_write_config(path: &Path, raw: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Config path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    if path.exists() {
        let backup = server_config_backup_path(path);
        fs::copy(path, &backup).map_err(|error| {
            format!(
                "Cannot back up {} to {}: {error}",
                path.display(),
                backup.display()
            )
        })?;
    }
    let temp = parent.join(format!(
        ".config.toml.{}.{}.tmp",
        std::process::id(),
        unix_epoch_millis()?
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("Cannot create {}: {error}", temp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Cannot secure {}: {error}", temp.display()))?;
        }
        file.write_all(raw.as_bytes())
            .map_err(|error| format!("Cannot write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("Cannot flush {}: {error}", temp.display()))?;
        fs::rename(&temp, path).map_err(|error| {
            format!(
                "Cannot atomically replace {} with {}: {error}",
                path.display(),
                temp.display()
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn desktop_prefs_path() -> Result<PathBuf, String> {
    Ok(kimi_home_dir()?.join("kiki").join("desktop.json"))
}

fn read_desktop_prefs_file() -> DesktopPrefs {
    let path = match desktop_prefs_path() {
        Ok(path) => path,
        Err(_) => return DesktopPrefs::default(),
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => DesktopPrefs::default(),
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
) -> Result<DesktopConnection, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.connection(&app))
        .await
        .map_err(|error| format!("Kiki backend startup task failed: {error}"))?
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
fn write_desktop_prefs(prefs: DesktopPrefsPatch) -> Result<(), String> {
    let current = read_desktop_prefs_file();
    let next = DesktopPrefs {
        notifications: prefs.notifications.unwrap_or(current.notifications),
        close_to_tray: prefs.close_to_tray.unwrap_or(current.close_to_tray),
    };
    write_desktop_prefs_file(&next)
}

#[tauri::command]
fn read_server_config() -> Result<DesktopServerConfig, String> {
    read_server_config_file(&server_config_path()?)
}

#[tauri::command]
fn write_server_config(patch: DesktopServerConfigPatch) -> Result<DesktopServerConfig, String> {
    write_server_config_file(&server_config_path()?, patch)
}

#[tauri::command]
async fn restart_server(
    app: AppHandle,
    manager: State<'_, BackendManager>,
) -> Result<DesktopConnection, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.restart(&app))
        .await
        .map_err(|error| format!("Kiki backend restart task failed: {error}"))?
}

fn kimi_home_dir() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("KIMI_CODE_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".kimi-code"))
        .ok_or_else(|| "Cannot resolve the current user's home directory".to_string())
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

fn authenticated_probe(port: u16, token: &str) -> bool {
    http_request(port, "GET", "/api/v1/meta", token).is_ok()
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

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let show_i =
        MenuItem::with_id(app, "show", "Show", true, None::<&str>).map_err(|e| e.to_string())?;
    let hide_i =
        MenuItem::with_id(app, "hide", "Hide", true, None::<&str>).map_err(|e| e.to_string())?;
    let new_i = MenuItem::with_id(app, "new", "New Session", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_i =
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(
        app,
        &[
            &show_i,
            &hide_i,
            &new_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &quit_i,
        ],
    )
    .map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "No default window icon".to_string())?;

    TrayIconBuilder::new()
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(manager)
        .invoke_handler(tauri::generate_handler![
            desktop_connection,
            show_main_window,
            read_desktop_prefs,
            write_desktop_prefs,
            read_server_config,
            write_server_config,
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

        let corrupt = serde_json::from_str::<DesktopPrefs>("{not-json").unwrap_or_default();
        assert!(corrupt.close_to_tray);
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
    fn server_config_write_preserves_unknown_data_and_creates_backup() {
        let root = env::temp_dir().join(format!(
            "kiki-config-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.toml");
        let original = r#"telemetry = true
[providers.example]
type = "openai"
api_key = "secret-kept"
"#;
        fs::write(&path, original).unwrap();

        let saved = write_server_config_file(
            &path,
            DesktopServerConfigPatch {
                subagent_default_model: "example/worker".to_string(),
                subagent_default_effort: "high".to_string(),
                subagent_timeout_ms: 60_000,
                agents_enabled: true,
                default_subagent_model: "example/worker".to_string(),
                default_subagent_reasoning_effort: "medium".to_string(),
                builtin_product_skills: false,
                model_catalog_refresh_interval_ms: 300_000,
                model_catalog_refresh_on_start: true,
            },
        )
        .unwrap();

        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("api_key = \"secret-kept\""));
        assert!(written.contains("default_model = \"example/worker\""));
        assert!(written.contains("builtin_product_skills = false"));
        assert_eq!(saved.subagent.timeout_ms, 60_000);
        assert_eq!(
            fs::read_to_string(server_config_backup_path(&path)).unwrap(),
            original
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_server_config_is_rejected_before_write() {
        let root = env::temp_dir().join(format!(
            "kiki-config-invalid-test-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.toml");
        fs::write(&path, "[broken\n").unwrap();
        assert!(read_server_config_file(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[broken\n");
        fs::remove_dir_all(root).unwrap();
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
}
