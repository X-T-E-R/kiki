#![cfg(windows)]

#[path = "../src/desktop_exit.rs"]
mod desktop_exit;

use std::{sync::{atomic::{AtomicBool, Ordering}, Arc}, thread};
use desktop_exit::{desktop_exit_requested, desktop_quit_dialog, request_desktop_only_exit};
use tauri::{Manager, WindowEvent, WebviewWindowBuilder};

#[test]
#[ignore = "requires an isolated native dialog driver; no backend or user home is opened"]
fn isolated_native_exit_entry_fixture() {
    let confirmed = Arc::new(AtomicBool::new(false));
    let close_confirmed = confirmed.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("ai.easyagent.kiki.exit-fixture.{}", std::process::id());
    let data = std::env::temp_dir().join(format!("kiki-exit-webview-{}", std::process::id()));
    let app = tauri::Builder::default().any_thread().plugin(tauri_plugin_dialog::init())
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_desktop_only_exit(window.app_handle(), &close_confirmed);
            }
        }).build(context).unwrap();
    let handle = app.handle().clone();
    let driver = thread::spawn(move || {
        for (stage, zh, expected) in [("en-enter", false, true), ("zh-escape", true, false), ("en-cancel", false, false), ("zh-stop", true, true)] {
            let title = format!("Kiki isolated exit {} {stage}", std::process::id());
            let stopping = desktop_quit_dialog(&handle, zh, &title);
            assert_eq!(stopping, expected, "{stage}");
            let steps = std::cell::RefCell::new(Vec::new());
            let exited = desktop_exit_requested(false, stopping,
                || { steps.borrow_mut().push("stop"); Err("fixture unreadable shutdown state".into()) },
                |_| steps.borrow_mut().push("diagnostic"), || steps.borrow_mut().push("exit"));
            assert_eq!(exited, expected);
            assert_eq!(*steps.borrow(), if expected { vec!["stop", "diagnostic", "exit"] } else { vec![] });
            println!("native {stage}: stopping={stopping}, steps={:?}", steps.borrow());
        }
        let create = handle.clone();
        handle.run_on_main_thread(move || {
            WebviewWindowBuilder::new(&create, "isolated-close", tauri::WebviewUrl::External("about:blank".parse().unwrap()))
                .data_directory(data).title("Kiki isolated close window").build().unwrap().close().unwrap();
        }).unwrap();
    });
    let code = app.run_return(|_, _| {});
    driver.join().unwrap();
    assert_eq!(code, 0);
    assert!(confirmed.load(Ordering::SeqCst), "native window close must bypass the service-stop confirmation");
    println!("native window close: final exit without service access");
}
