use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationScope {
    pub home_id: String,
    pub scope_id: String,
    pub server_home_id: Option<String>,
    pub connection_ref: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct NotificationRecord {
    scope: NotificationScope,
    sessions: HashSet<String>,
    delivery_id: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct NotificationRegistry {
    entries: HashMap<String, NotificationRecord>,
}

impl NotificationRegistry {
    pub fn insert(
        &mut self,
        tag: String,
        scope: NotificationScope,
        sessions: Vec<String>,
        delivery_id: Option<String>,
    ) {
        self.entries.insert(
            tag,
            NotificationRecord {
                scope,
                sessions: sessions.into_iter().collect(),
                delivery_id,
            },
        );
    }

    pub fn acknowledge(
        &mut self,
        session: &str,
        scope: &NotificationScope,
        delivery_id: Option<&str>,
    ) -> Vec<String> {
        let mut removed = Vec::new();
        self.entries.retain(|tag, record| {
            if &record.scope != scope
                || delivery_id.is_some_and(|id| record.delivery_id.as_deref() != Some(id))
                || !record.sessions.remove(session)
                || !record.sessions.is_empty()
            {
                return true;
            }
            removed.push(tag.clone());
            false
        });
        removed
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        fs::{self, File, OpenOptions},
        io::Write,
        path::Path,
        sync::{
            atomic::{AtomicU64, Ordering},
            Mutex,
        },
    };
    use windows::{
        core::{IInspectable, Interface, HSTRING},
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        UI::Notifications::{
            ToastActivatedEventArgs, ToastDismissalReason, ToastDismissedEventArgs,
            ToastFailedEventArgs, ToastNotification, ToastNotificationManager,
        },
    };

    pub fn register_application(application_id: &str, display_name: &str) -> Result<(), String> {
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE,
            REG_OPTION_NON_VOLATILE, REG_SZ,
        };
        let path: Vec<u16> = format!("SOFTWARE\\Classes\\AppUserModelId\\{application_id}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut key = std::ptr::null_mut();
        let opened = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if opened != 0 {
            return Err(format!(
                "Cannot register desktop notification identity: {opened}"
            ));
        }
        let name: Vec<u16> = "DisplayName".encode_utf16().chain(Some(0)).collect();
        let value: Vec<u16> = display_name.encode_utf16().chain(Some(0)).collect();
        let written = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        unsafe {
            RegCloseKey(key);
        }
        if written != 0 {
            return Err(format!(
                "Cannot name desktop notification identity: {written}"
            ));
        }
        Ok(())
    }

    struct Entry {
        toast: ToastNotification,
        application_id: String,
        activated: i64,
        dismissed: i64,
        failed: i64,
    }

    impl Drop for Entry {
        fn drop(&mut self) {
            let _ = self.toast.RemoveActivated(self.activated);
            let _ = self.toast.RemoveDismissed(self.dismissed);
            let _ = self.toast.RemoveFailed(self.failed);
        }
    }

    static PENDING: std::sync::LazyLock<Mutex<HashMap<String, Entry>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    static NEXT: AtomicU64 = AtomicU64::new(1);
    const GROUP: &str = "kiki-sessions";

    fn release(tag: &str) {
        let entry = PENDING
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(tag));
        drop(entry);
    }

    #[cfg(test)]
    pub fn retained_count() -> usize {
        PENDING.lock().unwrap().len()
    }

    fn history_tags(application_id: &str) -> Result<HashSet<String>, String> {
        let result = || -> windows::core::Result<HashSet<String>> {
            let history = ToastNotificationManager::History()?
                .GetHistoryWithId(&HSTRING::from(application_id))?;
            let mut tags = HashSet::new();
            for index in 0..history.Size()? {
                let toast = history.GetAt(index)?;
                if toast.Group()? == GROUP {
                    tags.insert(toast.Tag()?.to_string());
                }
            }
            Ok(tags)
        };
        result().map_err(|error| format!("Cannot read desktop notification history: {error}"))
    }

    fn open_registry(
        application_id: &str,
        path: &Path,
    ) -> Result<(File, NotificationRegistry), String> {
        let dir = path.parent().ok_or("Invalid notification registry path")?;
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("lock"))
            .map_err(|error| error.to_string())?;
        lock.lock().map_err(|error| error.to_string())?;
        let mut registry: NotificationRegistry = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("Cannot decode notification registry: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                NotificationRegistry::default()
            }
            Err(error) => return Err(format!("Cannot read notification registry: {error}")),
        };
        let tags = history_tags(application_id)?;
        registry.entries.retain(|tag, _| tags.contains(tag));
        let stale = PENDING
            .lock()
            .map_err(|_| "Notification registry lock was poisoned")?
            .iter()
            .filter(|(tag, entry)| entry.application_id == application_id && !tags.contains(*tag))
            .map(|(tag, _)| tag.clone())
            .collect::<Vec<_>>();
        for tag in stale {
            release(&tag);
        }
        Ok((lock, registry))
    }

    fn save_registry(path: &Path, registry: &NotificationRegistry) -> Result<(), String> {
        let staging = path.with_extension(format!("{}.tmp", std::process::id()));
        let saved = (|| -> Result<(), String> {
            let mut file = File::create(&staging).map_err(|error| error.to_string())?;
            serde_json::to_writer(&mut file, &registry).map_err(|error| error.to_string())?;
            file.flush()
                .and_then(|_| file.sync_all())
                .map_err(|error| error.to_string())?;
            fs::rename(&staging, path).map_err(|error| error.to_string())
        })();
        if saved.is_err() {
            let _ = fs::remove_file(&staging);
        }
        saved.map_err(|error| format!("Cannot save notification registry: {error}"))?;
        Ok(())
    }

    fn xml_text(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    fn dismissed(tag: &str, reason: ToastDismissalReason) {
        if reason != ToastDismissalReason::TimedOut {
            release(tag);
        }
    }

    fn prepare(
        application_id: &str,
        tag: &str,
        title: &str,
        body: &str,
        activate: impl Fn() + Send + Sync + 'static,
    ) -> windows::core::Result<(
        Entry,
        TypedEventHandler<ToastNotification, IInspectable>,
        TypedEventHandler<ToastNotification, ToastFailedEventArgs>,
    )> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><actions><action content=\"Open Kiki\" arguments=\"open\" activationType=\"foreground\"/></actions></toast>", xml_text(title), xml_text(body))))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        toast.SetTag(&HSTRING::from(tag))?;
        toast.SetGroup(&HSTRING::from(GROUP))?;
        let activated_tag = tag.to_string();
        let activate_handler =
            TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, value| {
                let action = value
                    .as_ref()
                    .and_then(|value| value.cast::<ToastActivatedEventArgs>().ok())
                    .and_then(|args| args.Arguments().ok());
                if action
                    .as_ref()
                    .is_none_or(|value| value.is_empty() || value == "open")
                {
                    activate();
                }
                release(&activated_tag);
                Ok(())
            });
        let activated = toast.Activated(&activate_handler)?;
        let dismissed_tag = tag.to_string();
        let dismissed = toast.Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, args| {
            if let Some(reason) = args.as_ref().and_then(|args| args.Reason().ok()) {
                dismissed(&dismissed_tag, reason);
            }
            Ok(())
        }))?;
        let failed_tag = tag.to_string();
        let fail_handler =
            TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
                release(&failed_tag);
                Ok(())
            });
        let failed = toast.Failed(&fail_handler)?;
        Ok((
            Entry {
                toast,
                application_id: application_id.into(),
                activated,
                dismissed,
                failed,
            },
            activate_handler,
            fail_handler,
        ))
    }

    pub fn show(
        application_id: &str,
        path: &Path,
        title: &str,
        body: &str,
        scope: Option<NotificationScope>,
        sessions: Vec<String>,
        delivery_id: Option<String>,
        activate: impl Fn() + Send + Sync + 'static,
    ) -> Result<String, String> {
        let tag = format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let (entry, _, _) = prepare(application_id, &tag, title, body, activate)
            .map_err(|error| format!("Cannot prepare desktop notification: {error}"))?;
        let toast = entry.toast.clone();
        let (_lock, mut registry) = open_registry(application_id, path)?;
        if let Some(scope) = scope {
            registry.insert(tag.clone(), scope, sessions, delivery_id);
        }
        save_registry(path, &registry)?;
        PENDING
            .lock()
            .map_err(|_| "Notification registry lock was poisoned")?
            .insert(tag.clone(), entry);
        let shown =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(application_id))
                .and_then(|notifier| notifier.Show(&toast));
        if let Err(error) = shown {
            release(&tag);
            return Err(format!("Cannot show desktop notification: {error}"));
        }
        Ok(tag)
    }

    pub fn acknowledge(
        application_id: &str,
        path: &Path,
        session: &str,
        scope: &NotificationScope,
        delivery_id: Option<&str>,
    ) -> Result<(), String> {
        let (_lock, mut registry) = open_registry(application_id, path)?;
        for tag in registry.acknowledge(session, scope, delivery_id) {
            let result = || -> windows::core::Result<()> {
                let toast = PENDING
                    .lock()
                    .ok()
                    .and_then(|entries| entries.get(&tag).map(|entry| entry.toast.clone()));
                if let Some(toast) = toast {
                    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
                        application_id,
                    ))?
                    .Hide(&toast)?;
                }
                ToastNotificationManager::History()?.RemoveGroupedTagWithId(
                    &HSTRING::from(&tag),
                    &HSTRING::from(GROUP),
                    &HSTRING::from(application_id),
                )
            };
            result()
                .map_err(|error| format!("Cannot acknowledge desktop notification: {error}"))?;
            release(&tag);
        }
        save_registry(path, &registry)
    }

    #[test]
    fn n052_f4_terminal_callbacks_release_unscoped_ownership_but_timeout_keeps_activation() {
        use std::sync::{atomic::AtomicUsize, Arc};
        let called = Arc::new(AtomicUsize::new(0));
        for index in 0..64 {
            let captured = Arc::new(());
            let weak = Arc::downgrade(&captured);
            let count = called.clone();
            let tag = format!("unscoped-lifecycle-{index}");
            let (entry, activate, fail) = prepare(
                "fixture-only",
                &tag,
                "Fixture",
                "No OS toast is sent",
                move || {
                    let _ = &captured;
                    count.fetch_add(1, Ordering::SeqCst);
                },
            )
            .unwrap();
            let _toast = entry.toast.clone();
            PENDING.lock().unwrap().insert(tag.clone(), entry);
            dismissed(&tag, ToastDismissalReason::TimedOut);
            assert!(PENDING.lock().unwrap().contains_key(&tag));
            assert!(weak.upgrade().is_some());
            match index % 4 {
                0 => activate.Invoke(None, None).unwrap(),
                1 => fail.Invoke(None, None).unwrap(),
                2 => dismissed(&tag, ToastDismissalReason::UserCanceled),
                _ => dismissed(&tag, ToastDismissalReason::ApplicationHidden),
            }
            assert!(!PENDING.lock().unwrap().contains_key(&tag));
            drop(activate);
            drop(fail);
            assert!(
                weak.upgrade().is_none(),
                "terminal toast must release its captured application handle"
            );
        }
        assert_eq!(called.load(Ordering::SeqCst), 16);
    }
}

#[cfg(all(windows, test))]
pub use native::retained_count;
#[cfg(windows)]
pub use native::{acknowledge, register_application, show};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledgment_preserves_other_sessions_homes_connections_and_generations() {
        let scope = NotificationScope {
            home_id: "home-a".into(),
            scope_id: "local".into(),
            server_home_id: Some("server-a".into()),
            connection_ref: None,
        };
        let mut registry = NotificationRegistry::default();
        registry.insert(
            "a".into(),
            scope.clone(),
            vec!["a".into()],
            Some("old".into()),
        );
        registry.insert(
            "new-a".into(),
            scope.clone(),
            vec!["a".into()],
            Some("new".into()),
        );
        registry.insert("b".into(), scope.clone(), vec!["b".into()], None);
        registry.insert(
            "merged".into(),
            scope.clone(),
            vec!["a".into(), "b".into()],
            None,
        );
        for other in [
            NotificationScope {
                home_id: "home-b".into(),
                ..scope.clone()
            },
            NotificationScope {
                scope_id: "ssh:example".into(),
                ..scope.clone()
            },
            NotificationScope {
                server_home_id: Some("server-b".into()),
                ..scope.clone()
            },
            NotificationScope {
                connection_ref: Some("other".into()),
                ..scope.clone()
            },
        ] {
            assert!(registry.acknowledge("a", &other, None).is_empty());
        }
        assert_eq!(registry.acknowledge("a", &scope, Some("old")), vec!["a"]);
        assert_eq!(registry.acknowledge("a", &scope, None), vec!["new-a"]);
        assert!(registry.acknowledge("a", &scope, None).is_empty());
        registry = serde_json::from_str(&serde_json::to_string(&registry).unwrap()).unwrap();
        let mut removed = registry.acknowledge("b", &scope, None);
        removed.sort();
        assert_eq!(removed, vec!["b", "merged"]);
    }
}
