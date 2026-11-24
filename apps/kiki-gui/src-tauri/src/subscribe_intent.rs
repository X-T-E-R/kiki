use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Url;

pub const SUBSCRIBE_INTENT_EVENT: &str = "kiki://subscribe-intent";
pub const MAX_SUBSCRIBE_URL_CHARS: usize = 4096;
pub const MAX_SUBSCRIBE_NAME_CHARS: usize = 120;
pub const SUBSCRIBE_INTENT_QUEUE_CAPACITY: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSubscribeIntent {
    pub url: String,
    pub name: Option<String>,
    pub mode: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeIntent {
    pub id: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

pub struct SubscribeIntentQueue {
    items: Mutex<VecDeque<SubscribeIntent>>,
    next_id: AtomicU64,
    capacity: usize,
}

impl Default for SubscribeIntentQueue {
    fn default() -> Self {
        Self::with_capacity(SUBSCRIBE_INTENT_QUEUE_CAPACITY)
    }
}

impl SubscribeIntentQueue {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            items: Mutex::new(VecDeque::new()),
            next_id: AtomicU64::new(1),
            capacity,
        }
    }

    pub fn enqueue(&self, parsed: ParsedSubscribeIntent) -> Result<SubscribeIntent, String> {
        let mut guard = self
            .items
            .lock()
            .map_err(|_| "Subscribe intent queue lock poisoned".to_string())?;
        if guard.len() >= self.capacity {
            return Err(format!(
                "Subscribe intent queue is full ({} pending items)",
                self.capacity
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let intent = SubscribeIntent {
            id,
            url: parsed.url,
            name: parsed.name,
            mode: parsed.mode,
        };
        guard.push_back(intent.clone());
        Ok(intent)
    }

    pub fn peek(&self) -> Option<SubscribeIntent> {
        self.items.lock().ok()?.front().cloned()
    }

    pub fn ack(&self, id: &str) -> bool {
        let Ok(mut guard) = self.items.lock() else {
            return false;
        };
        if guard.front().map(|front| front.id.as_str()) == Some(id) {
            guard.pop_front();
            return true;
        }
        false
    }
}

pub fn allow_loopback_subscribe_urls() -> bool {
    cfg!(debug_assertions)
        || std::env::var("KIKI_ALLOW_LOOPBACK_SUBSCRIPTIONS")
            .ok()
            .as_deref()
            == Some("1")
}

fn percent_decode_once(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut changed = false;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                index += 3;
                changed = true;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    if !changed {
        return None;
    }
    String::from_utf8(out).ok()
}

fn sanitize_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|ch| !ch.is_control())
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let bounded: String = trimmed.chars().take(MAX_SUBSCRIBE_NAME_CHARS).collect();
    let final_trimmed = bounded.trim();
    if final_trimmed.is_empty() {
        None
    } else {
        Some(final_trimmed.to_string())
    }
}

fn parse_target_url(raw: &str, allow_loopback: bool) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("Subscription target URL is required".to_string());
    }
    if candidate.chars().count() > MAX_SUBSCRIBE_URL_CHARS {
        return Err("Subscription target URL exceeds maximum length".to_string());
    }

    let parsed = match Url::parse(candidate) {
        Ok(url) => url,
        Err(_) => {
            let decoded = percent_decode_once(candidate)
                .ok_or_else(|| "Invalid subscription target URL".to_string())?;
            if decoded.chars().count() > MAX_SUBSCRIBE_URL_CHARS {
                return Err("Subscription target URL exceeds maximum length".to_string());
            }
            Url::parse(decoded.trim())
                .map_err(|_| "Invalid subscription target URL".to_string())?
        }
    };

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Subscription target URL must not include credentials".to_string());
    }
    let Some(host) = parsed.host_str() else {
        return Err("Subscription target URL must include a host".to_string());
    };
    if host.is_empty() {
        return Err("Subscription target URL must include a host".to_string());
    }
    let allowed_scheme = parsed.scheme() == "https"
        || (allow_loopback
            && parsed.scheme() == "http"
            && matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]"));
    if !allowed_scheme {
        return Err("Subscription target URL must use HTTPS".to_string());
    }
    let serialized = parsed.as_str();
    if serialized.chars().count() > MAX_SUBSCRIBE_URL_CHARS {
        return Err("Subscription target URL exceeds maximum length".to_string());
    }
    Ok(serialized.to_string())
}

pub fn parse_subscribe_intent_with_loopback(
    raw: &str,
    allow_loopback: bool,
) -> Result<Option<ParsedSubscribeIntent>, String> {
    let trimmed = raw.trim();
    let Ok(parsed) = Url::parse(trimmed) else {
        return Ok(None);
    };
    if !parsed.scheme().eq_ignore_ascii_case("kiki") {
        return Ok(None);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Subscribe deep link must not include userinfo".to_string());
    }
    if parsed.port().is_some() {
        return Err("Subscribe deep link must not include a port".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("Subscribe deep link must not include a fragment".to_string());
    }

    let host_form = parsed
        .host_str()
        .map(|host| host.eq_ignore_ascii_case("subscribe"))
        .unwrap_or(false)
        && (parsed.path().is_empty() || parsed.path() == "/");
    let path_form = parsed.host_str().is_none()
        && parsed.path().eq_ignore_ascii_case("/subscribe");
    if !host_form && !path_form {
        return Err("Unsupported kiki:// subscribe route".to_string());
    }

    let mut url_param: Option<String> = None;
    let mut name_param: Option<String> = None;
    let mut mode_param: Option<String> = None;

    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "url" => {
                if url_param.is_some() {
                    return Err("Duplicate url parameter in subscribe deep link".to_string());
                }
                url_param = Some(value.into_owned());
            }
            "name" => {
                if name_param.is_some() {
                    return Err("Duplicate name parameter in subscribe deep link".to_string());
                }
                name_param = Some(value.into_owned());
            }
            "mode" => {
                if mode_param.is_some() {
                    return Err("Duplicate mode parameter in subscribe deep link".to_string());
                }
                mode_param = Some(value.into_owned());
            }
            _ => {}
        }
    }

    let raw_url = url_param.ok_or_else(|| "Missing url parameter in subscribe deep link".to_string())?;
    let target_url = parse_target_url(&raw_url, allow_loopback)?;
    let name = name_param.as_deref().and_then(sanitize_name);
    let mode = mode_param.as_deref().and_then(|raw_mode| {
        let lower = raw_mode.trim().to_ascii_lowercase();
        match lower.as_str() {
            "auto" | "manual" | "once" => Some(lower),
            _ => None,
        }
    });

    Ok(Some(ParsedSubscribeIntent {
        url: target_url,
        name,
        mode,
    }))
}

pub fn parse_subscribe_intent(raw: &str) -> Result<Option<ParsedSubscribeIntent>, String> {
    parse_subscribe_intent_with_loopback(raw, allow_loopback_subscribe_urls())
}

pub fn extract_subscribe_intents_from_args<S: AsRef<str>>(args: &[S]) -> Vec<ParsedSubscribeIntent> {
    let mut intents = Vec::new();
    for arg in args.iter().skip(1) {
        if let Ok(Some(parsed)) = parse_subscribe_intent(arg.as_ref()) {
            intents.push(parsed);
        }
    }
    intents
}

fn escape_desktop_exec_quoted(path: &str) -> Option<String> {
    if path.is_empty() || path.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n') {
        return None;
    }
    let mut escaped = String::with_capacity(path.len() + 8);
    for ch in path.chars() {
        match ch {
            '\\' | '"' | '`' | '$' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            '%' => escaped.push_str("%%"),
            _ => escaped.push(ch),
        }
    }
    Some(escaped)
}

pub fn format_linux_appimage_desktop_entry(appimage_path: &str) -> Option<String> {
    let exec_escaped = escape_desktop_exec_quoted(appimage_path)?;
    Some(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Kiki\n\
         Comment=Kiki AI Agent Desktop\n\
         TryExec={appimage_path}\n\
         Exec=\"{exec_escaped}\" %u\n\
         Icon=kiki-desktop\n\
         Categories=Development;Utility;\n\
         Terminal=false\n\
         StartupWMClass=kiki-desktop\n\
         MimeType=x-scheme-handler/kiki;\n"
    ))
}

#[cfg(target_os = "linux")]
pub fn ensure_linux_appimage_desktop_registration() {
    let Ok(appimage_path) = std::env::var("APPIMAGE") else {
        return;
    };
    let trimmed = appimage_path.trim();
    if trimmed.is_empty() || !std::path::Path::new(trimmed).is_file() {
        return;
    }
    let Some(contents) = format_linux_appimage_desktop_entry(trimmed) else {
        return;
    };
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| std::path::PathBuf::from(home).join(".local").join("share"))
        });
    let Some(data_home) = data_home else {
        return;
    };
    let applications_dir = data_home.join("applications");
    if let Err(error) = std::fs::create_dir_all(&applications_dir) {
        eprintln!("Kiki could not create Linux applications directory: {error}");
        return;
    }
    let desktop_path = applications_dir.join("kiki-desktop.desktop");
    if std::fs::read_to_string(&desktop_path).ok().as_deref() == Some(contents.as_str()) {
        return;
    }
    if let Err(error) = std::fs::write(&desktop_path, contents) {
        eprintln!("Kiki could not write Linux AppImage desktop entry: {error}");
        return;
    }
    let _ = std::process::Command::new("xdg-mime")
        .args(["default", "kiki-desktop.desktop", "x-scheme-handler/kiki"])
        .status();
    let _ = std::process::Command::new("update-desktop-database")
        .arg(&applications_dir)
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_and_empty_authority_forms_with_name_and_mode() {
        let host_form = parse_subscribe_intent_with_loopback(
            "kiki://subscribe?url=https%3A%2F%2Fexample.test%2Fpack.tgz&name=Lab%20Pack&mode=manual",
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(host_form.url, "https://example.test/pack.tgz");
        assert_eq!(host_form.name.as_deref(), Some("Lab Pack"));
        assert_eq!(host_form.mode.as_deref(), Some("manual"));

        let path_form = parse_subscribe_intent_with_loopback(
            "kiki:///subscribe?url=https%3A%2F%2Fexample.test%2Fpack.tgz&mode=once",
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(path_form.url, "https://example.test/pack.tgz");
        assert_eq!(path_form.mode.as_deref(), Some("once"));

        let unknown_mode = parse_subscribe_intent_with_loopback(
            "kiki://subscribe?url=https%3A%2F%2Fexample.test%2Fpack.tgz&mode=silent",
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(unknown_mode.mode, None);
    }

    #[test]
    fn preserves_signed_query_and_encoded_plus_without_double_decoding() {
        let intent = parse_subscribe_intent_with_loopback(
            "kiki://subscribe?url=https%3A%2F%2Fcdn.example.test%2Fpack.tgz%3Fsig%3Da%252Bb%26exp%3D999",
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            intent.url,
            "https://cdn.example.test/pack.tgz?sig=a%2Bb&exp=999"
        );

        let double_encoded = parse_subscribe_intent_with_loopback(
            "kiki://subscribe?url=https%253A%252F%252Fcdn.example.test%252Fpack.tgz",
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(double_encoded.url, "https://cdn.example.test/pack.tgz");
    }

    #[test]
    fn rejects_invalid_outer_grammar_duplicates_userinfo_and_release_loopback() {
        assert!(parse_subscribe_intent_with_loopback("kiki://evil/subscribe?url=https://example.test/a.tgz", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://subscribe/extra?url=https://example.test/a.tgz", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://user@subscribe?url=https://example.test/a.tgz", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://subscribe:8080?url=https://example.test/a.tgz", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://subscribe?url=https://example.test/a.tgz#frag", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://subscribe?url=https://example.test/a.tgz&url=https://example.test/b.tgz", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://subscribe?url=https://user:pass@example.test/a.tgz", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://subscribe?url=http://127.0.0.1:8080/pack.tgz", false).is_err());
        assert!(parse_subscribe_intent_with_loopback("kiki://subscribe?url=http://127.0.0.1:8080/pack.tgz", true).unwrap().is_some());
    }

    #[test]
    fn bounds_name_and_strips_control_chars() {
        let long_name = format!(" \x07{}\n", "a".repeat(200));
        let raw = format!(
            "kiki://subscribe?url=https%3A%2F%2Fexample.test%2Fpack.tgz&name={}",
            urlencoding_minimal(&long_name)
        );
        let parsed = parse_subscribe_intent_with_loopback(&raw, false)
            .unwrap()
            .unwrap();
        let name = parsed.name.unwrap();
        assert_eq!(name.chars().count(), MAX_SUBSCRIBE_NAME_CHARS);
        assert!(!name.chars().any(|c| c.is_control()));
    }

    fn urlencoding_minimal(input: &str) -> String {
        let mut out = String::new();
        for b in input.as_bytes() {
            if b.is_ascii_alphanumeric() {
                out.push(*b as char);
            } else {
                out.push_str(&format!("%{:02X}", b));
            }
        }
        out
    }

    #[test]
    fn queue_is_fifo_redelivers_before_ack_keeps_duplicate_urls_and_bounds_capacity() {
        let queue = SubscribeIntentQueue::with_capacity(2);
        let first = queue
            .enqueue(ParsedSubscribeIntent {
                url: "https://example.test/same.tgz".to_string(),
                name: Some("First".to_string()),
                mode: Some("auto".to_string()),
            })
            .unwrap();
        let second = queue
            .enqueue(ParsedSubscribeIntent {
                url: "https://example.test/same.tgz".to_string(),
                name: Some("Second".to_string()),
                mode: Some("manual".to_string()),
            })
            .unwrap();
        assert_ne!(first.id, second.id);

        assert!(queue
            .enqueue(ParsedSubscribeIntent {
                url: "https://example.test/overflow.tgz".to_string(),
                name: None,
                mode: None,
            })
            .is_err());

        assert_eq!(queue.peek().as_ref().map(|i| i.id.as_str()), Some(first.id.as_str()));
        assert_eq!(queue.peek().as_ref().map(|i| i.id.as_str()), Some(first.id.as_str()));
        assert!(!queue.ack(&second.id));
        assert!(queue.ack(&first.id));
        assert_eq!(queue.peek().as_ref().map(|i| i.id.as_str()), Some(second.id.as_str()));
        assert!(queue.ack(&second.id));
        assert_eq!(queue.peek(), None);
    }

    #[test]
    fn formats_linux_appimage_desktop_entry_with_escaping() {
        let entry = format_linux_appimage_desktop_entry("/home/user/My Apps/Kiki%20$1.AppImage").unwrap();
        assert!(entry.contains("Exec=\"/home/user/My Apps/Kiki%%20\\$1.AppImage\" %u\n"));
        assert!(entry.contains("MimeType=x-scheme-handler/kiki;\n"));
        assert!(format_linux_appimage_desktop_entry("").is_none());
        assert!(format_linux_appimage_desktop_entry("/tmp/bad\nline.AppImage").is_none());
    }
}
