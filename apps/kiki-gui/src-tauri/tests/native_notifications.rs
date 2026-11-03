#![cfg(windows)]

#[path = "../src/desktop_notifications.rs"]
mod desktop_notifications;

use desktop_notifications::{acknowledge, register_application, show, NotificationScope};
use std::{sync::mpsc, thread, time::Duration};
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
