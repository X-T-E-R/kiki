#![cfg(windows)]

#[path = "../src/desktop_notifications.rs"]
mod desktop_notifications;

use desktop_notifications::{register_application, NotificationScope};
use std::{path::PathBuf, sync::mpsc, thread, time::Duration};

fn registry_path() -> PathBuf {
    PathBuf::from(
        std::env::var("KIKI_NOTIFICATION_FIXTURE_OUTPUT")
            .expect("set an isolated fixture output path"),
    )
    .with_extension("registry.json")
}

fn show(
    application_id: &str,
    title: &str,
    body: &str,
    scope: Option<NotificationScope>,
    sessions: Vec<String>,
    activate: impl Fn() + Send + Sync + 'static,
) -> Result<String, String> {
    desktop_notifications::show(
        application_id,
        &registry_path(),
        title,
        body,
        scope,
        sessions,
        None,
        activate,
    )
}

fn acknowledge(session: &str, scope: &NotificationScope) -> Result<(), String> {
    let application_id = std::env::var("KIKI_NOTIFICATION_FIXTURE_AUMID").unwrap();
    desktop_notifications::acknowledge(&application_id, &registry_path(), session, scope, None)
}
use windows::{core::HSTRING, UI::Notifications::ToastNotificationManager};

fn contains(application_id: &str, tag: &str) -> bool {
    let history = ToastNotificationManager::History()
        .unwrap()
        .GetHistoryWithId(&HSTRING::from(application_id))
        .unwrap();
    (0..history.Size().unwrap()).any(|index| history.GetAt(index).unwrap().Tag().unwrap() == tag)
}

#[test]
#[ignore = "sends isolated native toasts and requires a driver to click the first toast after banner expiry; no backend or home is opened"]
fn isolated_native_notification_retention_and_click() {
    let output = std::env::var("KIKI_NOTIFICATION_FIXTURE_OUTPUT")
        .expect("set an isolated fixture output path");
    let application_id = std::env::var("KIKI_NOTIFICATION_FIXTURE_AUMID")
        .expect("set the task-owned fixture identity after checking its registry preimage");
    assert!(application_id.starts_with("ai.easyagent.kiki.notification-fixture."));
    register_application(&application_id, "Kiki isolated notification fixture").unwrap();
    let scope = NotificationScope {
        home_id: format!("fixture-{}", std::process::id()),
        scope_id: "local".into(),
        server_home_id: Some("fixture-server".into()),
        connection_ref: None,
    };
    let other = NotificationScope {
        scope_id: "ssh:example".into(),
        ..scope.clone()
    };
    let (sender, receiver) = mpsc::channel();
    let title = format!("Kiki notification fixture {}", std::process::id());
    let clicked_scope = scope.clone();
    let first = show(
        &application_id,
        &title,
        "Open this notification after the banner has closed.",
        Some(scope.clone()),
        vec!["conversation-b".into()],
        move || {
            sender
                .send(("/s/conversation-b", clicked_scope.clone()))
                .unwrap();
        },
    )
    .unwrap();
    let second = show(
        &application_id,
        &format!("Kiki retained fixture {}", std::process::id()),
        "This other conversation must remain in Notification Center.",
        Some(scope.clone()),
        vec!["conversation-c".into()],
        || {},
    )
    .unwrap();
    let run = std::panic::catch_unwind(|| {
        thread::sleep(Duration::from_secs(12));
        assert!(
            contains(&application_id, &first),
            "banner expiry must retain the first Notification Center entry"
        );
        assert!(
            contains(&application_id, &second),
            "banner expiry must retain the other entry"
        );
        acknowledge("conversation-b", &other).unwrap();
        assert!(
            contains(&application_id, &first),
            "another connection must not acknowledge this notification"
        );
        std::fs::write(&output, serde_json::to_string(&serde_json::json!({ "stage": "awaiting_click", "title": title, "first": first, "second": second, "retained_after_banner": true, "wrong_scope_retained": true })).unwrap()).unwrap();
        let (route, clicked_scope) = receiver
            .recv_timeout(Duration::from_secs(90))
            .expect("click the first notification in Notification Center");
        assert_eq!(route, "/s/conversation-b");
        assert_eq!(clicked_scope, scope);
        acknowledge("conversation-b", &scope).unwrap();
        assert!(!contains(&application_id, &first));
        assert!(
            contains(&application_id, &second),
            "reading B must retain C"
        );
        std::fs::write(&output, serde_json::to_string(&serde_json::json!({ "stage": "passed", "route": route, "scope": scope, "retained_after_banner": true, "wrong_scope_retained": true, "clicked_after_banner": true, "acknowledged_only_target": true })).unwrap()).unwrap();
    });
    acknowledge("conversation-b", &scope).unwrap();
    acknowledge("conversation-c", &scope).unwrap();
    if let Err(error) = run {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "sends isolated native toasts; requires a task-owned registered identity and no backend or home"]
fn isolated_native_notification_retention_and_acknowledgment() {
    let output = std::env::var("KIKI_NOTIFICATION_FIXTURE_OUTPUT")
        .expect("set an isolated fixture output path");
    let application_id = std::env::var("KIKI_NOTIFICATION_FIXTURE_AUMID")
        .expect("set the task-owned fixture identity after checking its registry preimage");
    assert!(application_id.starts_with("ai.easyagent.kiki.notification-fixture."));
    register_application(&application_id, "Kiki isolated notification fixture").unwrap();
    let scope = NotificationScope {
        home_id: format!("fixture-{}", std::process::id()),
        scope_id: "local".into(),
        server_home_id: Some("fixture-server".into()),
        connection_ref: None,
    };
    let first = show(
        &application_id,
        "Kiki isolated conversation B",
        "Completion remains unread after the banner closes.",
        Some(scope.clone()),
        vec!["conversation-b".into()],
        || {},
    )
    .unwrap();
    let second = show(
        &application_id,
        "Kiki isolated conversation C",
        "Reading B must retain this notification.",
        Some(scope.clone()),
        vec!["conversation-c".into()],
        || {},
    )
    .unwrap();
    let run = std::panic::catch_unwind(|| {
        assert!(contains(&application_id, &first));
        assert!(contains(&application_id, &second));
        thread::sleep(Duration::from_secs(12));
        assert!(contains(&application_id, &first));
        assert!(contains(&application_id, &second));
        let other = NotificationScope {
            scope_id: "ssh:example".into(),
            ..scope.clone()
        };
        acknowledge("conversation-b", &other).unwrap();
        assert!(contains(&application_id, &first));
        acknowledge("conversation-b", &scope).unwrap();
        assert!(!contains(&application_id, &first));
        assert!(contains(&application_id, &second));
        std::fs::write(&output, serde_json::to_string(&serde_json::json!({ "stage": "passed", "scope": scope, "retained_after_banner": true, "wrong_scope_retained": true, "acknowledged_only_target": true })).unwrap()).unwrap();
    });
    acknowledge("conversation-b", &scope).unwrap();
    acknowledge("conversation-c", &scope).unwrap();
    if let Err(error) = run {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "child stage for the isolated cross-process fixture"]
fn isolated_native_restart_stage() {
    let stage = std::env::var("KIKI_NOTIFICATION_FIXTURE_STAGE").unwrap();
    let output = PathBuf::from(std::env::var("KIKI_NOTIFICATION_FIXTURE_OUTPUT").unwrap());
    let application_id = std::env::var("KIKI_NOTIFICATION_FIXTURE_AUMID").unwrap();
    assert!(application_id.starts_with("ai.easyagent.kiki.notification-fixture."));
    assert_eq!(desktop_notifications::retained_count(), 0);
    if stage == "send" {
        let scope = NotificationScope {
            home_id: "restart-fixture-home".into(),
            scope_id: "local".into(),
            server_home_id: Some("restart-fixture-server".into()),
            connection_ref: Some("restart-fixture-connection".into()),
        };
        let b = show(
            &application_id,
            "Kiki restart fixture B",
            "Only reading B removes this entry.",
            Some(scope.clone()),
            vec!["b".into()],
            || {},
        )
        .unwrap();
        let c = show(
            &application_id,
            "Kiki restart fixture C",
            "Reading B must keep C.",
            Some(scope.clone()),
            vec!["c".into()],
            || {},
        )
        .unwrap();
        let merged = show(
            &application_id,
            "Kiki restart fixture B+C",
            "Both conversations must be read.",
            Some(scope.clone()),
            vec!["b".into(), "c".into()],
            || {},
        )
        .unwrap();
        for tag in [&b, &c, &merged] {
            assert!(contains(&application_id, tag));
        }
        std::fs::write(
            &output,
            serde_json::to_vec(
                &serde_json::json!({ "scope": scope, "b": b, "c": c, "merged": merged }),
            )
            .unwrap(),
        )
        .unwrap();
    } else {
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
        let scope: NotificationScope = serde_json::from_value(saved["scope"].clone()).unwrap();
        let b = saved["b"].as_str().unwrap();
        let c = saved["c"].as_str().unwrap();
        let merged = saved["merged"].as_str().unwrap();
        if stage == "read-b" {
            for tag in [b, c, merged] {
                assert!(
                    contains(&application_id, tag),
                    "entry must survive the sender process exiting"
                );
            }
            for other in [
                NotificationScope {
                    home_id: "other-home".into(),
                    ..scope.clone()
                },
                NotificationScope {
                    scope_id: "ssh:example".into(),
                    ..scope.clone()
                },
                NotificationScope {
                    server_home_id: Some("other-server".into()),
                    ..scope.clone()
                },
                NotificationScope {
                    connection_ref: Some("other-connection".into()),
                    ..scope.clone()
                },
            ] {
                acknowledge("b", &other).unwrap();
                for tag in [b, c, merged] {
                    assert!(contains(&application_id, tag));
                }
            }
            acknowledge("b", &scope).unwrap();
            assert!(!contains(&application_id, b));
            assert!(contains(&application_id, c));
            assert!(contains(&application_id, merged));
        } else {
            assert_eq!(stage, "read-c");
            assert!(!contains(&application_id, b));
            assert!(contains(&application_id, c));
            assert!(contains(&application_id, merged));
            acknowledge("c", &scope).unwrap();
            for tag in [b, c, merged] {
                assert!(!contains(&application_id, tag));
            }
        }
    }
}

#[test]
#[ignore = "sends task-owned native toasts and opens three fixture subprocesses; no backend or Kiki home"]
fn isolated_native_notification_restart_acknowledgment() {
    let application_id = std::env::var("KIKI_NOTIFICATION_FIXTURE_AUMID").unwrap();
    assert!(application_id.starts_with("ai.easyagent.kiki.notification-fixture."));
    register_application(&application_id, "Kiki isolated restart fixture").unwrap();
    let exe = std::env::current_exe().unwrap();
    for stage in ["send", "read-b", "read-c"] {
        let child = std::process::Command::new(&exe)
            .args([
                "--exact",
                "isolated_native_restart_stage",
                "--ignored",
                "--nocapture",
            ])
            .env("KIKI_NOTIFICATION_FIXTURE_STAGE", stage)
            .output()
            .unwrap();
        print!(
            "stage={stage}\n{}{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(child.status.success(), "restart stage {stage} failed");
        if stage == "send" {
            thread::sleep(Duration::from_secs(12));
        }
    }
    let output = PathBuf::from(std::env::var("KIKI_NOTIFICATION_FIXTURE_OUTPUT").unwrap());
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
    receipt["stage"] = "passed".into();
    receipt["cross_process_exact_ack"] = true.into();
    receipt["wrong_scope_retained"] = true.into();
    receipt["merged_partial_ack_survived_restart"] = true.into();
    std::fs::write(output, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
}
