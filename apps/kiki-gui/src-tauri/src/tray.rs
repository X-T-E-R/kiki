use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::{
    autostart, local_spaces,
    local_spaces::LocalSpaceEntry,
    read_desktop_prefs_file, read_desktop_prefs_for, reload_space_window,
    show_main_window, spawn_detached_and_reap, DesktopSpace, SpaceBackendManager, WindowMode,
    TRAY_ID,
};

pub(crate) const TRAY_ID_SHOW: &str = "show";
pub(crate) const TRAY_ID_HIDE: &str = "hide";
pub(crate) const TRAY_ID_NEW: &str = "new";
pub(crate) const TRAY_ID_TOGGLE_AUTOSTART: &str = "toggle-autostart";
pub(crate) const TRAY_ID_CLOSE_WINDOW_KEEP_TRAY: &str = "close-window-keep-tray";
pub(crate) const TRAY_ID_QUIT: &str = "quit";
pub(crate) const TRAY_PREFIX_SPACE_OPEN: &str = "space-open:";
pub(crate) const TRAY_PREFIX_SPACE_STOP: &str = "space-stop:";

#[derive(Default)]
pub(crate) struct TrayState {
    spaces: Mutex<Vec<LocalSpaceEntry>>,
    last_signature: Mutex<Option<String>>,
    refresh_in_flight: AtomicBool,
    refresh_pending: AtomicBool,
    refresh_pending_force: AtomicBool,
}

impl TrayState {
    fn set_spaces(&self, spaces: Vec<LocalSpaceEntry>) {
        if let Ok(mut guard) = self.spaces.lock() {
            *guard = spaces;
        }
    }

    fn space_at(&self, index: usize) -> Option<LocalSpaceEntry> {
        self.spaces.lock().ok()?.get(index).cloned()
    }

    fn update_signature(&self, sig: String) -> bool {
        let Ok(mut guard) = self.last_signature.lock() else {
            return true;
        };
        if guard.as_deref() == Some(sig.as_str()) {
            return false;
        }
        *guard = Some(sig);
        true
    }
}

#[derive(Clone, Copy)]
pub(crate) struct TrayCopy {
    pub show: &'static str,
    pub hide: &'static str,
    pub new_session: &'static str,
    pub local_spaces: &'static str,
    pub open_window: &'static str,
    pub stop_background: &'static str,
    pub status_running: &'static str,
    pub status_background: &'static str,
    pub status_stopped: &'static str,
    pub autostart: &'static str,
    pub close_window_keep_tray: &'static str,
    pub quit_completely: &'static str,
}

pub(crate) fn tray_copy(zh: bool) -> TrayCopy {
    if zh {
        TrayCopy {
            show: "打开主窗口",
            hide: "隐藏到托盘",
            new_session: "新建会话",
            local_spaces: "本地空间",
            open_window: "打开窗口",
            stop_background: "停止该空间后台服务",
            status_running: "运行中",
            status_background: "后台运行",
            status_stopped: "未运行",
            autostart: "开机自启（托盘驻留）",
            close_window_keep_tray: "仅关闭窗口（保持托盘与后台）",
            quit_completely: "完全退出（停止后台服务）",
        }
    } else {
        TrayCopy {
            show: "Open Main Window",
            hide: "Hide to Tray",
            new_session: "New Session",
            local_spaces: "Local Spaces",
            open_window: "Open Window",
            stop_background: "Stop Background Server",
            status_running: "Running",
            status_background: "Background",
            status_stopped: "Stopped",
            autostart: "Start at Login (Tray)",
            close_window_keep_tray: "Close Window Only (Keep Tray)",
            quit_completely: "Quit Kiki Completely (Stop Services)",
        }
    }
}

pub(crate) fn format_tray_tooltip(
    spaces: &[LocalSpaceEntry],
    active_space: Option<&DesktopSpace>,
    window_visible: bool,
    zh: bool,
) -> String {
    if let Some(space) = active_space {
        if space.home_id != "main" {
            return format!("Kiki · {}", space.name);
        }
    }
    let running: Vec<&str> = spaces
        .iter()
        .filter(|s| s.running)
        .map(|s| s.name.as_str())
        .collect();
    if running.is_empty() {
        return "Kiki".to_string();
    }
    let summary = running.join(", ");
    if zh {
        if window_visible {
            format!("Kiki · 运行中（{summary}）")
        } else {
            format!("Kiki · 后台运行中（{summary}）")
        }
    } else if window_visible {
        format!("Kiki · Running ({summary})")
    } else {
        format!("Kiki · Running in background ({summary})")
    }
}

fn current_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn active_locale_is_zh(app: &AppHandle) -> bool {
    let locale = app
        .try_state::<SpaceBackendManager>()
        .and_then(|m| m.active_space().ok())
        .and_then(|space| read_desktop_prefs_for(Path::new(&space.path)).locale)
        .or_else(|| read_desktop_prefs_file().locale);
    locale.as_deref() == Some("zh")
}

fn collect_tray_spaces(app: &AppHandle, zh: bool) -> (Vec<LocalSpaceEntry>, Option<DesktopSpace>) {
    let Some(manager) = app.try_state::<SpaceBackendManager>() else {
        return (Vec::new(), None);
    };
    let active_space = manager.active_space().ok();
    let main_home = manager.main_home();
    let visible_home = if current_window_visible(app) {
        active_space.as_ref().map(|s| PathBuf::from(&s.path))
    } else {
        None
    };
    let spaces = local_spaces::discover_local_spaces(&main_home, visible_home.as_deref(), zh);
    (spaces, active_space)
}

fn tray_signature(
    zh: bool,
    window_visible: bool,
    autostart_enabled: bool,
    active_space: Option<&DesktopSpace>,
    spaces: &[LocalSpaceEntry],
) -> String {
    let mut parts = Vec::with_capacity(spaces.len() + 4);
    parts.push(format!("zh={zh}"));
    parts.push(format!("vis={window_visible}"));
    parts.push(format!("auto={autostart_enabled}"));
    parts.push(format!(
        "act={}",
        active_space.map(|s| s.home_id.as_str()).unwrap_or("")
    ));
    for space in spaces {
        parts.push(format!(
            "{}|{}|{}|{}|{:?}",
            space.home_id, space.name, space.running, space.has_window, space.pid
        ));
    }
    parts.join(";")
}

pub(crate) fn build_tray_menu(
    app: &AppHandle,
    zh: bool,
    spaces: &[LocalSpaceEntry],
    window_visible: bool,
    autostart_enabled: bool,
) -> Result<Menu<Wry>, String> {
    let copy = tray_copy(zh);
    let show_i = MenuItem::with_id(app, TRAY_ID_SHOW, copy.show, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let hide_i = MenuItem::with_id(app, TRAY_ID_HIDE, copy.hide, window_visible, None::<&str>)
        .map_err(|e| e.to_string())?;
    let new_i = MenuItem::with_id(app, TRAY_ID_NEW, copy.new_session, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(
        app,
        &[
            &show_i,
            &hide_i,
            &new_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    if !spaces.is_empty() {
        let running_count = spaces.iter().filter(|s| s.running).count();
        let spaces_title = if running_count > 0 {
            if zh {
                format!("{}（{} 运行中）", copy.local_spaces, running_count)
            } else {
                format!("{} ({} running)", copy.local_spaces, running_count)
            }
        } else {
            copy.local_spaces.to_string()
        };
        let spaces_submenu =
            Submenu::new(app, &spaces_title, true).map_err(|e| e.to_string())?;
        for (index, space) in spaces.iter().enumerate() {
            let status = if space.running && space.has_window {
                copy.status_running
            } else if space.running {
                copy.status_background
            } else {
                copy.status_stopped
            };
            let label = format!("{} · {}", space.name, status);
            let open_i = MenuItem::with_id(
                app,
                format!("{TRAY_PREFIX_SPACE_OPEN}{index}"),
                copy.open_window,
                true,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            let stop_i = MenuItem::with_id(
                app,
                format!("{TRAY_PREFIX_SPACE_STOP}{index}"),
                copy.stop_background,
                space.running,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            let entry_sub = Submenu::with_items(app, &label, true, &[&open_i, &stop_i])
                .map_err(|e| e.to_string())?;
            spaces_submenu
                .append(&entry_sub)
                .map_err(|e| e.to_string())?;
        }
        menu.append(&spaces_submenu).map_err(|e| e.to_string())?;
        menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }

    let autostart_i = CheckMenuItem::with_id(
        app,
        TRAY_ID_TOGGLE_AUTOSTART,
        copy.autostart,
        true,
        autostart_enabled,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    menu.append(&autostart_i).map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let close_win_i = MenuItem::with_id(
        app,
        TRAY_ID_CLOSE_WINDOW_KEEP_TRAY,
        copy.close_window_keep_tray,
        app.get_webview_window("main").is_some(),
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(app, TRAY_ID_QUIT, copy.quit_completely, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    menu.append(&close_win_i).map_err(|e| e.to_string())?;
    menu.append(&quit_i).map_err(|e| e.to_string())?;
    Ok(menu)
}

struct TraySnapshot {
    zh: bool,
    window_visible: bool,
    autostart_enabled: bool,
    spaces: Vec<LocalSpaceEntry>,
    signature: String,
    tooltip: String,
}

fn collect_tray_snapshot(app: &AppHandle, window_visible: bool) -> TraySnapshot {
    let zh = active_locale_is_zh(app);
    let autostart_enabled = autostart::get_autostart_status()
        .map(|s| s.enabled)
        .unwrap_or(false);
    let (spaces, active_space) = collect_tray_spaces(app, zh);
    let signature = tray_signature(
        zh,
        window_visible,
        autostart_enabled,
        active_space.as_ref(),
        &spaces,
    );
    let tooltip = format_tray_tooltip(&spaces, active_space.as_ref(), window_visible, zh);
    TraySnapshot {
        zh,
        window_visible,
        autostart_enabled,
        spaces,
        signature,
        tooltip,
    }
}

fn apply_tray_snapshot_on_main(app: &AppHandle, snapshot: TraySnapshot, force: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let changed = if let Some(tray_state) = app.try_state::<TrayState>() {
        let updated = tray_state.update_signature(snapshot.signature);
        if force || updated {
            tray_state.set_spaces(snapshot.spaces.clone());
            true
        } else {
            false
        }
    } else {
        true
    };
    if !changed {
        return;
    }
    let _ = tray.set_tooltip(Some(&snapshot.tooltip));
    if let Ok(menu) = build_tray_menu(
        app,
        snapshot.zh,
        &snapshot.spaces,
        snapshot.window_visible,
        snapshot.autostart_enabled,
    ) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Collects process/registry/disk tray state on the current (background) worker thread
/// and dispatches only the cheap in-memory menu/tooltip update onto the main thread.
pub(crate) fn refresh_tray_from_worker(app: &AppHandle, force: bool) {
    if app.tray_by_id(TRAY_ID).is_none() {
        return;
    }
    let window_visible = current_window_visible(app);
    let snapshot = collect_tray_snapshot(app, window_visible);
    let ui_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        apply_tray_snapshot_on_main(&ui_app, snapshot, force);
    });
}

/// Schedules a non-blocking background tray refresh; safe to call from the main thread
/// or any menu handler without blocking the UI event loop.
pub(crate) fn schedule_tray_refresh(app: &AppHandle, force: bool) {
    if app.tray_by_id(TRAY_ID).is_none() {
        return;
    }
    if let Some(state) = app.try_state::<TrayState>() {
        if force {
            state.refresh_pending_force.store(true, Ordering::SeqCst);
        }
        state.refresh_pending.store(true, Ordering::SeqCst);
        if state.refresh_in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || loop {
        let run_force = handle
            .try_state::<TrayState>()
            .map(|s| {
                s.refresh_pending.store(false, Ordering::SeqCst);
                s.refresh_pending_force.swap(false, Ordering::SeqCst)
            })
            .unwrap_or(force);
        refresh_tray_from_worker(&handle, run_force);
        let keep_going = handle
            .try_state::<TrayState>()
            .map(|s| {
                if s.refresh_pending.load(Ordering::SeqCst) {
                    true
                } else {
                    s.refresh_in_flight.store(false, Ordering::SeqCst);
                    s.refresh_pending.load(Ordering::SeqCst)
                        && !s.refresh_in_flight.swap(true, Ordering::SeqCst)
                }
            })
            .unwrap_or(false);
        if !keep_going {
            break;
        }
    });
}

fn show_tray_error_dialog(app: &AppHandle, zh: bool, title_zh: &str, title_en: &str, error: &str) {
    let title = if zh { title_zh } else { title_en };
    app.dialog()
        .message(error)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn handle_open_space_from_tray(app: &AppHandle, entry: LocalSpaceEntry) {
    let Some(manager) = app.try_state::<SpaceBackendManager>() else {
        return;
    };
    let active_path = manager
        .active_space()
        .ok()
        .map(|s| local_spaces::canonical_home_key(Path::new(&s.path)));
    let target_key = local_spaces::canonical_home_key(Path::new(&entry.path));
    if active_path.as_deref() == Some(target_key.as_str()) {
        let _ = show_main_window(app.clone());
        return;
    }
    let mode = manager.window_mode();
    let app_for_worker = app.clone();
    if mode == WindowMode::Switch && entry.registered {
        let manager = manager.inner().clone();
        let home_id = entry.home_id;
        let name = entry.name;
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = manager.switch(&app_for_worker, &home_id) {
                eprintln!("Kiki tray could not switch space {name}: {}", error.message);
                let zh = active_locale_is_zh(&app_for_worker);
                show_tray_error_dialog(
                    &app_for_worker,
                    zh,
                    "Kiki · 打开空间失败",
                    "Kiki · Could not open space",
                    &error.message,
                );
            } else {
                let ui_app = app_for_worker.clone();
                let _ = app_for_worker.run_on_main_thread(move || {
                    let _ = show_main_window(ui_app.clone());
                    let _ = reload_space_window(&ui_app);
                });
            }
        });
        return;
    }
    // Windows mode or unregistered/standalone local space: launch `kiki-desktop --home <path>`.
    // That process gets a distinct per-home single-instance identifier and attaches to the
    // already-running kiki-server without spawning a duplicate server.
    let target_path = PathBuf::from(&entry.path);
    tauri::async_runtime::spawn_blocking(move || {
        let launch_result = crate::release_redirect::resolve_launch_executable()
            .map_err(|error| error.to_string())
            .and_then(|exe| {
                let mut command = std::process::Command::new(&exe);
                crate::release_redirect::prepare_child_command(&mut command, &exe);
                command.arg("--home").arg(&target_path);
                spawn_detached_and_reap(command, "Cannot open space window")
            });
        if let Err(error) = launch_result {
            eprintln!("Kiki tray could not open space {}: {error}", target_path.display());
            let zh = active_locale_is_zh(&app_for_worker);
            show_tray_error_dialog(
                &app_for_worker,
                zh,
                "Kiki · 打开空间失败",
                "Kiki · Could not open space",
                &error,
            );
        }
    });
}

fn handle_stop_space_from_tray(app: &AppHandle, entry: LocalSpaceEntry) {
    let app = app.clone();
    let zh = active_locale_is_zh(&app);
    std::thread::spawn(move || {
        let (title, message, stop_label, cancel_label) = if zh {
            (
                format!("Kiki · 停止 {}", entry.name),
                format!(
                    "停止空间“{}”的后台服务？这将断开连接到该空间的所有窗口和客户端，并取消未完成的工作。",
                    entry.name
                ),
                "停止后台服务",
                "取消",
            )
        } else {
            (
                format!("Kiki · Stop {}", entry.name),
                format!(
                    "Stop the background server for \"{}\"? Connected windows and clients for this space will disconnect and unfinished work will be cancelled.",
                    entry.name
                ),
                "Stop Background Server",
                "Cancel",
            )
        };
        let choice = app
            .dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                stop_label.into(),
                cancel_label.into(),
            ))
            .blocking_show_with_result();
        let confirmed = matches!(choice, MessageDialogResult::Ok)
            || matches!(choice, MessageDialogResult::Custom(label) if label == stop_label);
        if !confirmed {
            return;
        }
        let target_path = PathBuf::from(&entry.path);
        if let Err(error) = local_spaces::stop_local_space_server(&target_path) {
            eprintln!(
                "Kiki tray could not stop background server for {}: {error}",
                entry.name
            );
            let err_title = if zh {
                "Kiki · 停止服务失败"
            } else {
                "Kiki · Could not stop service"
            };
            app.dialog()
                .message(error)
                .title(err_title)
                .blocking_show();
        }
        refresh_tray_from_worker(&app, true);
    });
}

pub(crate) fn build_tray(app: &AppHandle) -> Result<(), String> {
    // Build a fast initial menu with zero OS process/registry scans on the main thread,
    // then immediately populate live local spaces and autostart state from a background worker.
    let window_visible = current_window_visible(app);
    let zh = false;
    let initial_spaces: Vec<LocalSpaceEntry> = Vec::new();
    let active_space = app
        .try_state::<SpaceBackendManager>()
        .and_then(|m| m.active_space().ok());
    let menu = build_tray_menu(app, zh, &initial_spaces, window_visible, false)?;
    let tooltip = format_tray_tooltip(&initial_spaces, active_space.as_ref(), window_visible, zh);

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "No default window icon".to_string())?;

    // macOS status items natively open their menu on left click; on Windows and Linux,
    // left-click focuses/opens Kiki immediately while right-click opens the menu.
    let menu_on_left = cfg!(target_os = "macos");

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(&tooltip)
        .menu(&menu)
        .show_menu_on_left_click(menu_on_left)
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref();
            match id {
                TRAY_ID_SHOW => {
                    let _ = show_main_window(app.clone());
                    schedule_tray_refresh(app, true);
                }
                TRAY_ID_HIDE => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = crate::background_main_window(&w);
                    }
                    schedule_tray_refresh(app, true);
                }
                TRAY_ID_NEW => {
                    let _ = show_main_window(app.clone());
                    let _ = app.emit("kiki://new-session", ());
                    schedule_tray_refresh(app, true);
                }
                TRAY_ID_TOGGLE_AUTOSTART => {
                    let worker_app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let current = autostart::get_autostart_status()
                            .map(|s| s.enabled)
                            .unwrap_or(false);
                        let next = !current;
                        if let Err(error) = autostart::set_autostart_enabled(next) {
                            eprintln!("Kiki tray could not toggle autostart: {error}");
                            let zh = active_locale_is_zh(&worker_app);
                            show_tray_error_dialog(
                                &worker_app,
                                zh,
                                "Kiki · 自启动设置失败",
                                "Kiki · Autostart update failed",
                                &error,
                            );
                        } else if let Some(manager) = worker_app.try_state::<SpaceBackendManager>() {
                            let main_home = manager.main_home();
                            let _ = crate::write_autostart_pref(&main_home, next);
                        }
                        refresh_tray_from_worker(&worker_app, true);
                    });
                }
                TRAY_ID_CLOSE_WINDOW_KEEP_TRAY => {
                    // Destroy the WebView window to free RAM while keeping the tray icon
                    // and background servers alive (`RunEvent::ExitRequested` with `code=None`
                    // prevents exit when tray residency is active).
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.destroy();
                    }
                    schedule_tray_refresh(app, true);
                }
                TRAY_ID_QUIT => {
                    app.exit(0);
                }
                _ if id.starts_with(TRAY_PREFIX_SPACE_OPEN) => {
                    if let Ok(index) = id[TRAY_PREFIX_SPACE_OPEN.len()..].parse::<usize>() {
                        if let Some(entry) = app
                            .try_state::<TrayState>()
                            .and_then(|s| s.space_at(index))
                        {
                            handle_open_space_from_tray(app, entry);
                        }
                    }
                }
                _ if id.starts_with(TRAY_PREFIX_SPACE_STOP) => {
                    if let Ok(index) = id[TRAY_PREFIX_SPACE_STOP.len()..].parse::<usize>() {
                        if let Some(entry) = app
                            .try_state::<TrayState>()
                            .and_then(|s| s.space_at(index))
                        {
                            handle_stop_space_from_tray(app, entry);
                        }
                    }
                }
                _ => {}
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_space(home_id: &str, name: &str, running: bool, has_window: bool) -> LocalSpaceEntry {
        LocalSpaceEntry {
            home_id: home_id.into(),
            name: name.into(),
            path: format!(r"C:\spaces\{home_id}"),
            is_primary: home_id == "main",
            registered: true,
            running,
            has_window,
            pid: running.then_some(1234),
            port: running.then_some(50000),
            desktop_managed: None,
        }
    }

    #[test]
    fn formats_bilingual_tray_tooltip_for_background_and_visible_states() {
        let spaces = vec![
            sample_space("main", "主空间", true, false),
            sample_space("h-ctf", "CTF", true, false),
            sample_space("h-idle", "Idle", false, false),
        ];
        assert_eq!(
            format_tray_tooltip(&spaces, None, false, true),
            "Kiki · 后台运行中（主空间, CTF）"
        );
        assert_eq!(
            format_tray_tooltip(&spaces, None, true, true),
            "Kiki · 运行中（主空间, CTF）"
        );

        let en_spaces = vec![
            sample_space("main", "Main space", true, false),
            sample_space("h-ctf", "CTF", true, false),
        ];
        assert_eq!(
            format_tray_tooltip(&en_spaces, None, false, false),
            "Kiki · Running in background (Main space, CTF)"
        );
        assert_eq!(
            format_tray_tooltip(&[sample_space("main", "Main space", false, false)], None, false, false),
            "Kiki"
        );
    }
}
