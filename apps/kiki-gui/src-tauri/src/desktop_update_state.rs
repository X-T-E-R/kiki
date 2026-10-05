use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum DesktopUpdateMutation {
    Checked { at: serde_json::Number },
    Snooze { until: serde_json::Number },
    Skip { channel: crate::UpdateChannel, version: String },
}

/// Mutations read and change the latest app-scope record inside the existing preferences lock.
pub(super) fn mutate_for(
    home: &std::path::Path,
    mutation: DesktopUpdateMutation,
) -> Result<DesktopUpdateState, String> {
    let _write = crate::DESKTOP_PREFS_WRITE_LOCK.lock()
        .map_err(|_| "Desktop preferences lock was poisoned")?;
    let main = crate::main_home_for(home)?;
    let mut prefs = crate::read_main_desktop_prefs(&main);
    let mut state = prefs.update_state.take().unwrap_or_default();
    let timestamp = |previous: &mut Option<serde_json::Number>, next: serde_json::Number| {
        let value = next.as_f64().filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(|| "Update timestamps must be non-negative epoch milliseconds".to_string())?;
        if previous.as_ref().and_then(serde_json::Number::as_f64).is_none_or(|old| old < value) {
            *previous = Some(next);
        }
        Ok::<(), String>(())
    };
    match mutation {
        DesktopUpdateMutation::Checked { at } => timestamp(&mut state.last_checked_at, at)?,
        DesktopUpdateMutation::Snooze { until } => timestamp(&mut state.snoozed_until, until)?,
        DesktopUpdateMutation::Skip { channel, version } => {
            if version.trim().is_empty() { return Err("Skipped version must not be empty".to_string()); }
            let skipped = state.skipped.get_or_insert_with(SkippedVersions::default);
            let list = match channel {
                crate::UpdateChannel::Stable => &mut skipped.stable,
                crate::UpdateChannel::Beta => &mut skipped.beta,
            }.get_or_insert_with(Vec::new);
            if !list.contains(&version) { list.push(version); }
        }
    }
    prefs.update_state = Some(state.clone());
    crate::write_json_file(&main.join("desktop.json"), &prefs)?;
    Ok(state)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct DesktopUpdateState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<SkippedVersions>,
    #[serde(deserialize_with = "epoch", skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<serde_json::Number>,
    #[serde(deserialize_with = "epoch", skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<serde_json::Number>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub(super) struct SkippedVersions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stable: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beta: Option<Vec<String>>,
}

impl DesktopUpdateState {
    fn normalized(mut self) -> Option<Self> {
        if let Some(skipped) = &mut self.skipped {
            for list in [&mut skipped.stable, &mut skipped.beta]
                .into_iter()
                .flatten()
            {
                list.retain(|version| !version.is_empty());
            }
            if skipped.stable.is_none() && skipped.beta.is_none() {
                self.skipped = None;
            }
        }
        if self.skipped.is_none() && self.snoozed_until.is_none() && self.last_checked_at.is_none()
        {
            None
        } else {
            Some(self)
        }
    }
}

fn epoch<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Number>, D::Error> {
    let value = Option::<serde_json::Number>::deserialize(deserializer)?;
    if value.as_ref().is_some_and(|value| {
        value
            .as_f64()
            .is_none_or(|value| !value.is_finite() || value < 0.0)
    }) {
        return Err(serde::de::Error::custom(
            "Update timestamps must be non-negative epoch milliseconds",
        ));
    }
    Ok(value)
}

/// A damaged update record must not reset unrelated desktop preferences.
pub(super) fn read_state<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<DesktopUpdateState>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let Some(record) = value.as_object() else {
        return Ok(None);
    };
    let versions = |value: Option<&Value>| {
        value.and_then(Value::as_array).map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|version| !version.is_empty())
                .map(str::to_owned)
                .collect()
        })
    };
    let skipped = record
        .get("skipped")
        .and_then(Value::as_object)
        .map(|record| SkippedVersions {
            stable: versions(record.get("stable")),
            beta: versions(record.get("beta")),
        });
    let timestamp = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_number)
            .filter(|value| {
                value
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value >= 0.0)
            })
            .cloned()
    };
    Ok(DesktopUpdateState {
        skipped,
        snoozed_until: timestamp("snoozedUntil"),
        last_checked_at: timestamp("lastCheckedAt"),
    }
    .normalized())
}

/// Missing is unchanged; null or an empty record clears; an object replaces the record.
pub(super) fn patch_state<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<DesktopUpdateState>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(Some(None));
    }
    if !value.is_object()
        || value
            .get("skipped")
            .is_some_and(|value| !value.is_null() && !value.is_object())
    {
        return Err(serde::de::Error::custom(
            "Update state and skipped versions must be records",
        ));
    }
    let state: DesktopUpdateState =
        serde_json::from_value(value).map_err(serde::de::Error::custom)?;
    Ok(Some(state.normalized()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        read_desktop_prefs_for, write_desktop_prefs_file, AutoUpdateMode, DesktopLogLevel,
        DesktopPrefs, DesktopPrefsPatch, UpdateChannel,
    };
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Barrier,
        },
        thread,
    };

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct PrefsFixture {
        root: PathBuf,
        main: PathBuf,
        child: PathBuf,
        other: PathBuf,
    }

    impl PrefsFixture {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(".tmp")
                .join(format!(
                    "update-prefs-{}-{}-{}",
                    std::process::id(),
                    crate::unix_epoch_millis().unwrap(),
                    FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
                ));
            let main = root.join("main");
            let child = root.join("child");
            let other = root.join("other");
            fs::create_dir_all(&main).unwrap();
            fs::write(main.join("desktop.json"), r#"{"notifications":false,"closeToTray":false,"locale":"zh","autoUpdate":"install","logLevel":"info","window_mode":"windows"}"#).unwrap();
            for (index, home) in [&child, &other].iter().enumerate() {
                fs::create_dir_all(home).unwrap();
                fs::write(
                    home.join("home.toml"),
                    format!(
                        "schema = 1\nid = \"h-test-{index}\"\nname = \"Test\"\nbase = {:?}\n",
                        main.to_string_lossy().replace('\\', "/")
                    ),
                )
                .unwrap();
            }
            Self {
                root,
                main,
                child,
                other,
            }
        }

        fn write(&self, home: &std::path::Path, raw: &str) {
            let patch: DesktopPrefsPatch = serde_json::from_str(raw).unwrap();
            write_desktop_prefs_file(home, &patch).unwrap();
        }
    }

    impl Drop for PrefsFixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn full_state() -> Value {
        serde_json::json!({
            "skipped": {"stable": ["0.3.2", "0.3.3"], "beta": ["0.3.2-beta.1"]},
            "snoozedUntil": 1791200000123_u64,
            "lastCheckedAt": 1791113600123_u64
        })
    }

    #[test]
    fn desktop_update_state_round_trips_on_disk_and_across_spaces() {
        let fixture = PrefsFixture::new();
        let state = full_state();
        fixture.write(
            &fixture.child,
            &serde_json::json!({"updateState": state}).to_string(),
        );
        assert!(!fixture.child.join("desktop.json").exists());
        assert!(!fixture.other.join("desktop.json").exists());
        let disk: Value =
            serde_json::from_str(&fs::read_to_string(fixture.main.join("desktop.json")).unwrap())
                .unwrap();
        assert_eq!(disk["updateState"], state);
        // Reconstruct from disk without any process cache, as the next launch does.
        let restarted: DesktopPrefs = serde_json::from_value(disk).unwrap();
        assert_eq!(
            serde_json::to_value(restarted.update_state.as_ref().unwrap()).unwrap(),
            state
        );
        for home in [&fixture.main, &fixture.child, &fixture.other] {
            assert_eq!(
                read_desktop_prefs_for(home).update_state,
                restarted.update_state
            );
        }
        assert!(!restarted.notifications);
        assert!(!restarted.close_to_tray);
        assert_eq!(restarted.locale.as_deref(), Some("zh"));
        assert_eq!(restarted.auto_update, AutoUpdateMode::Install);
        assert_eq!(restarted.log_level, DesktopLogLevel::Info);
    }

    #[test]
    fn desktop_update_state_patch_omission_preserves_and_object_replacement_clears_members() {
        let fixture = PrefsFixture::new();
        fixture.write(
            &fixture.main,
            &serde_json::json!({"updateState": full_state()}).to_string(),
        );
        fixture.write(&fixture.main, r#"{"notifications":true}"#);
        fixture.write(
            &fixture.child,
            r#"{"logLevel":"trace","updateChannel":"beta"}"#,
        );
        assert_eq!(
            serde_json::to_value(read_desktop_prefs_for(&fixture.main).update_state).unwrap(),
            full_state()
        );
        assert_eq!(
            read_desktop_prefs_for(&fixture.child).log_level,
            DesktopLogLevel::Trace
        );
        assert_eq!(
            read_desktop_prefs_for(&fixture.main).log_level,
            DesktopLogLevel::Info
        );
        assert_eq!(
            read_desktop_prefs_for(&fixture.main).update_channel,
            UpdateChannel::Beta
        );
        fixture.write(&fixture.other, r#"{"updateState":{"skipped":{"beta":["0.3.4-beta.1"]},"lastCheckedAt":1791113600456}}"#);
        let prefs = read_desktop_prefs_for(&fixture.main);
        let state = prefs.update_state.unwrap();
        assert_eq!(state.snoozed_until, None);
        assert_eq!(state.skipped.unwrap().stable, None);
        assert_eq!(state.last_checked_at, Some(1791113600456_u64.into()));
        assert!(prefs.notifications);
        assert_eq!(prefs.auto_update, AutoUpdateMode::Install);
    }

    #[test]
    fn desktop_update_state_empty_or_null_explicitly_clears_the_record() {
        let fixture = PrefsFixture::new();
        for clear in [r#"{"updateState":{}}"#, r#"{"updateState":null}"#] {
            fixture.write(
                &fixture.main,
                &serde_json::json!({"updateState": full_state()}).to_string(),
            );
            fixture.write(&fixture.child, clear);
            assert!(read_desktop_prefs_for(&fixture.other)
                .update_state
                .is_none());
            let disk: Value = serde_json::from_str(
                &fs::read_to_string(fixture.main.join("desktop.json")).unwrap(),
            )
            .unwrap();
            assert!(disk.get("updateState").is_none());
            assert_eq!(disk["autoUpdate"], "install");
            assert!(!fixture.child.join("desktop.json").exists());
        }
    }

    #[test]
    fn desktop_update_state_legacy_and_damaged_record_preserve_old_preferences() {
        let fixture = PrefsFixture::new();
        assert!(read_desktop_prefs_for(&fixture.main).update_state.is_none());
        assert_eq!(
            read_desktop_prefs_for(&fixture.main).auto_update,
            AutoUpdateMode::Install
        );
        for state in [
            serde_json::json!("bad"),
            serde_json::json!({}),
            serde_json::json!({"snoozedUntil": -1}),
        ] {
            fs::write(fixture.main.join("desktop.json"), serde_json::json!({"notifications": false, "autoUpdate": "install", "updateState": state}).to_string()).unwrap();
            let prefs = read_desktop_prefs_for(&fixture.child);
            assert!(!prefs.notifications);
            assert_eq!(prefs.auto_update, AutoUpdateMode::Install);
            assert!(prefs.update_state.is_none());
        }
        fs::write(fixture.main.join("desktop.json"), r#"{"notifications":false,"updateState":{"skipped":{"stable":["0.3.2",null,"",3],"beta":"bad"},"snoozedUntil":"bad","lastCheckedAt":123.5}}"#).unwrap();
        let prefs = read_desktop_prefs_for(&fixture.main);
        assert!(!prefs.notifications);
        assert_eq!(
            serde_json::to_value(prefs.update_state).unwrap(),
            serde_json::json!({"skipped":{"stable":["0.3.2"]},"lastCheckedAt":123.5})
        );
        // An obsolete child-local record never masks the install's app-scope state.
        fs::write(
            fixture.child.join("desktop.json"),
            r#"{"updateState":{"lastCheckedAt":999}}"#,
        )
        .unwrap();
        assert_eq!(
            read_desktop_prefs_for(&fixture.child).update_state,
            read_desktop_prefs_for(&fixture.main).update_state
        );
    }

    #[test]
    fn desktop_update_state_rejects_invalid_write_inputs_without_touching_disk() {
        let fixture = PrefsFixture::new();
        let before = fs::read(fixture.main.join("desktop.json")).unwrap();
        for raw in [
            r#"{"updateState":"bad"}"#,
            r#"{"updateState":[]}"#,
            r#"{"updateState":{"skipped":[]}}"#,
            r#"{"updateState":{"skipped":{"stable":[1]}}}"#,
            r#"{"updateState":{"snoozedUntil":-1}}"#,
            r#"{"updateState":{"lastCheckedAt":"123"}}"#,
        ] {
            assert!(
                serde_json::from_str::<DesktopPrefsPatch>(raw).is_err(),
                "{raw}"
            );
        }
        assert_eq!(fs::read(fixture.main.join("desktop.json")).unwrap(), before);
        let patch: DesktopPrefsPatch =
            serde_json::from_str(r#"{"updateState":{"lastCheckedAt":0,"snoozedUntil":123.5}}"#)
                .unwrap();
        write_desktop_prefs_file(&fixture.main, &patch).unwrap();
        let state = read_desktop_prefs_for(&fixture.main).update_state.unwrap();
        assert_eq!(state.last_checked_at, Some(0.into()));
        assert_eq!(state.snoozed_until, serde_json::Number::from_f64(123.5));
    }

    #[test]
    fn desktop_update_state_concurrent_window_patches_merge_latest_preferences() {
        let fixture = PrefsFixture::new();
        let barrier = Arc::new(Barrier::new(3));
        let writes = [
            (
                fixture.main.clone(),
                serde_json::json!({"updateState": full_state()}).to_string(),
            ),
            (
                fixture.main.clone(),
                r#"{"notifications":true,"closeToTray":true}"#.to_owned(),
            ),
            (
                fixture.child.clone(),
                r#"{"updateChannel":"beta","autoUpdate":"off","logLevel":"trace"}"#.to_owned(),
            ),
        ];
        let threads: Vec<_> = writes
            .into_iter()
            .map(|(home, raw)| {
                let barrier = barrier.clone();
                thread::spawn(move || {
                    let patch: DesktopPrefsPatch = serde_json::from_str(&raw).unwrap();
                    barrier.wait();
                    write_desktop_prefs_file(&home, &patch).unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let prefs = read_desktop_prefs_for(&fixture.main);
        assert!(prefs.notifications);
        assert!(prefs.close_to_tray);
        assert_eq!(prefs.update_channel, UpdateChannel::Beta);
        assert_eq!(prefs.auto_update, AutoUpdateMode::Off);
        assert_eq!(
            serde_json::to_value(prefs.update_state).unwrap(),
            full_state()
        );
        assert_eq!(
            read_desktop_prefs_for(&fixture.child).log_level,
            DesktopLogLevel::Trace
        );
        assert_eq!(
            read_desktop_prefs_for(&fixture.other).log_level,
            DesktopLogLevel::Info
        );
    }

    #[test]
    fn desktop_update_stale_replacement_counterexample_and_atomic_actions() {
        let fixture = PrefsFixture::new();
        fixture.write(&fixture.main, r#"{"updateState":{"lastCheckedAt":1}}"#);
        let stale = read_desktop_prefs_for(&fixture.child).update_state.unwrap();
        fixture.write(&fixture.other, r#"{"updateState":{"skipped":{"stable":["0.3.2"]},"snoozedUntil":999}}"#);
        fixture.write(&fixture.child, &serde_json::json!({"updateState": stale}).to_string());
        // This is the old GUI's read/replace loss, not a change to the replacement protocol.
        assert!(read_desktop_prefs_for(&fixture.main).update_state.unwrap().skipped.is_none());
        let actions = [
            (fixture.child.clone(), r#"{"kind":"checked","at":123}"#),
            (fixture.other.clone(), r#"{"kind":"skip","channel":"stable","version":"0.3.2"}"#),
            (fixture.main.clone(), r#"{"kind":"snooze","until":999}"#),
            (fixture.other.clone(), r#"{"kind":"skip","channel":"beta","version":"0.4.0-beta.1"}"#),
        ];
        let barrier = Arc::new(Barrier::new(actions.len()));
        let threads: Vec<_> = actions.into_iter().map(|(home, raw)| {
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                mutate_for(&home, serde_json::from_str(raw).unwrap()).unwrap();
            })
        }).collect();
        for thread in threads { thread.join().unwrap(); }
        let result = mutate_for(&fixture.child, serde_json::from_str(r#"{"kind":"checked","at":2}"#).unwrap()).unwrap();
        assert_eq!(serde_json::to_value(&result).unwrap(), serde_json::json!({
            "skipped": {"stable": ["0.3.2"], "beta": ["0.4.0-beta.1"]},
            "lastCheckedAt": 123, "snoozedUntil": 999
        }));
        assert_eq!(read_desktop_prefs_for(&fixture.other).update_state, Some(result));
        assert_eq!(read_desktop_prefs_for(&fixture.main).auto_update, AutoUpdateMode::Install);
        assert!(!fixture.child.join("desktop.json").exists());
        let before = fs::read(fixture.main.join("desktop.json")).unwrap();
        for raw in [r#"{"kind":"snooze","until":-1}"#, r#"{"kind":"skip","channel":"stable","version":" "}"#] {
            assert!(mutate_for(&fixture.main, serde_json::from_str(raw).unwrap()).is_err());
        }
        assert_eq!(fs::read(fixture.main.join("desktop.json")).unwrap(), before);
    }

    #[test]
    fn desktop_update_state_storage_errors_are_reported() {
        let fixture = PrefsFixture::new();
        fs::create_dir(fixture.child.join("desktop.json")).unwrap();
        let patch: DesktopPrefsPatch = serde_json::from_str(r#"{"notifications":true}"#).unwrap();
        assert!(write_desktop_prefs_file(&fixture.child, &patch).is_err());
        assert!(!read_desktop_prefs_for(&fixture.main).notifications);
    }
}
