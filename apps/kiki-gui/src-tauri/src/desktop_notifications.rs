use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationScope {
    pub home_id: String,
    pub scope_id: String,
    pub server_home_id: Option<String>,
    pub connection_ref: Option<String>,
}

#[derive(Clone, Default)]
pub struct NotificationRegistry {
    entries: HashMap<String, (NotificationScope, HashSet<String>)>,
}

impl NotificationRegistry {
    pub fn insert(&mut self, tag: String, scope: NotificationScope, sessions: Vec<String>) {
        self.entries
            .insert(tag, (scope, sessions.into_iter().collect()));
    }

    pub fn acknowledge(&mut self, session: &str, scope: &NotificationScope) -> Vec<String> {
        let mut removed = Vec::new();
        self.entries.retain(|tag, (owner, sessions)| {
            if owner != scope || !sessions.remove(session) || !sessions.is_empty() {
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
    use windows::{
        core::{IInspectable, Interface, HSTRING},
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager},
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
    }

    #[derive(Default)]
    struct Pending {
        registry: NotificationRegistry,
        entries: HashMap<String, Entry>,
    }

    static PENDING: std::sync::LazyLock<Mutex<Pending>> =
        std::sync::LazyLock::new(|| Mutex::new(Pending::default()));
    static NEXT: AtomicU64 = AtomicU64::new(1);
    const GROUP: &str = "kiki-sessions";

    fn xml_text(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    pub fn show(
        application_id: &str,
        title: &str,
        body: &str,
        scope: Option<NotificationScope>,
        sessions: Vec<String>,
        activate: impl Fn() + Send + Sync + 'static,
    ) -> Result<String, String> {
        let result = || -> windows::core::Result<String> {
            let tag = format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            );
            let document = XmlDocument::new()?;
            document.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><actions><action content=\"Open Kiki\" arguments=\"open\" activationType=\"foreground\"/></actions></toast>", xml_text(title), xml_text(body))))?;
            let toast = ToastNotification::CreateToastNotification(&document)?;
            toast.SetTag(&HSTRING::from(&tag))?;
            toast.SetGroup(&HSTRING::from(GROUP))?;
            toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
                move |_, value| {
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
                    Ok(())
                },
            ))?;
            let dismissed_tag = tag.clone();
            toast.Dismissed(&TypedEventHandler::<
                ToastNotification,
                windows::UI::Notifications::ToastDismissedEventArgs,
            >::new(move |_, args| {
                if args.as_ref().is_some_and(|args| {
                    args.Reason().ok()
                        == Some(windows::UI::Notifications::ToastDismissalReason::UserCanceled)
                }) {
                    if let Ok(mut pending) = PENDING.lock() {
                        pending.entries.remove(&dismissed_tag);
                        pending.registry.entries.remove(&dismissed_tag);
                    }
                }
                Ok(())
            }))?;
            let mut pending = PENDING.lock().map_err(|_| {
                windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32))
            })?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(application_id))?
                .Show(&toast)?;
            if let Some(scope) = scope {
                pending.registry.insert(tag.clone(), scope, sessions);
            }
            pending.entries.insert(
                tag.clone(),
                Entry {
                    toast,
                    application_id: application_id.to_string(),
                },
            );
            Ok(tag)
        };
        result().map_err(|error| format!("Cannot show desktop notification: {error}"))
    }

    pub fn acknowledge(session: &str, scope: &NotificationScope) -> Result<(), String> {
        let mut pending = PENDING
            .lock()
            .map_err(|_| "Notification registry lock was poisoned")?;
        let mut registry = pending.registry.clone();
        for tag in registry.acknowledge(session, scope) {
            if let Some(entry) = pending.entries.get(&tag) {
                let result = || -> windows::core::Result<()> {
                    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
                        &entry.application_id,
                    ))?
                    .Hide(&entry.toast)?;
                    ToastNotificationManager::History()?.RemoveGroupedTagWithId(
                        &HSTRING::from(&tag),
                        &HSTRING::from(GROUP),
                        &HSTRING::from(&entry.application_id),
                    )
                };
                result()
                    .map_err(|error| format!("Cannot acknowledge desktop notification: {error}"))?;
            }
            pending.entries.remove(&tag);
        }
        pending.registry = registry;
        Ok(())
    }
}

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
        registry.insert("a".into(), scope.clone(), vec!["a".into()]);
        registry.insert("b".into(), scope.clone(), vec!["b".into()]);
        registry.insert("merged".into(), scope.clone(), vec!["a".into(), "b".into()]);
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
            assert!(registry.acknowledge("a", &other).is_empty());
        }
        assert_eq!(registry.acknowledge("a", &scope), vec!["a"]);
        assert!(registry.acknowledge("a", &scope).is_empty());
        let mut removed = registry.acknowledge("b", &scope);
        removed.sort();
        assert_eq!(removed, vec!["b", "merged"]);
    }
}
