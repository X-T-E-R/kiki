use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

pub(crate) fn desktop_exit_requested(
    keeping: bool,
    stopping: bool,
    stop_services: impl FnOnce() -> Result<(), String>,
    diagnose: impl FnOnce(String),
    exit: impl FnOnce(),
) -> bool {
    if !keeping && !stopping { return false; }
    if stopping && !keeping {
        if let Err(error) = stop_services() { diagnose(error); }
    }
    exit();
    true
}

pub(crate) fn desktop_exit_copy(zh: bool) -> (&'static str, &'static str, &'static str) {
    if zh {
        ("退出会停止本桌面连接的本机共享服务，断开其他客户端，并取消未完成的工作。其他空间、远端和外部管理的服务不受影响。关闭窗口可保留后台。", "停止服务并退出", "取消")
    } else {
        ("Quitting stops this desktop’s connected local shared services, disconnects other clients, and cancels unfinished work. Other spaces, remote and externally managed services are unaffected. Close the window to keep the backend running.", "Stop services and quit", "Cancel")
    }
}

pub(crate) fn desktop_exit_stopping(choice: &MessageDialogResult, stop: &str) -> bool {
    matches!(choice, MessageDialogResult::Ok) || matches!(choice, MessageDialogResult::Custom(label) if label == stop)
}

pub(crate) fn desktop_quit_dialog(app: &AppHandle, zh: bool, title: &str) -> bool {
    let (message, stop, cancel) = desktop_exit_copy(zh);
    let choice = app.dialog().message(message).title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(stop.into(), cancel.into()))
        .blocking_show_with_result();
    desktop_exit_stopping(&choice, stop)
}

pub(crate) fn request_desktop_only_exit(app: &AppHandle, confirmed: &AtomicBool) {
    confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
}
