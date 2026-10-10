//! Background plugin-focus requests.
//!
//! Each App host keeps one short-lived navigation request. The desktop poll
//! reads that request from homes that are not on screen, then the reloaded
//! page for that home consumes it. The session route is stored with the home
//! id so a foreground connection cannot open the same path on its own host.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

pub const PLUGIN_NAVIGATION_PATH: &str = "/api/plugins/navigation";
pub const MAX_PLUGIN_NAVIGATION_RESPONSE_BYTES: usize = 64 * 1024;
pub const PLUGIN_FOCUS_TTL_MS: u64 = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginFocusRequest {
    pub id: u64,
    pub session_id: String,
    pub at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFocusIntent {
    pub home_id: String,
    pub route: String,
    pub request_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginFocusCandidate {
    pub home_id: String,
    pub request: PluginFocusRequest,
}

static PENDING: Mutex<Option<PluginFocusIntent>> = Mutex::new(None);
static SEEN: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn seen_map() -> std::sync::MutexGuard<'static, Option<HashMap<String, u64>>> {
    let mut guard = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
}

pub fn seen_request_id(home_id: &str) -> u64 {
    let seen = seen_map();
    seen.as_ref().and_then(|map| map.get(home_id).copied()).unwrap_or(0)
}

pub fn remember_request_id(home_id: &str, request_id: u64) {
    let mut seen = seen_map();
    if let Some(map) = seen.as_mut() {
        map.insert(home_id.to_string(), request_id);
    }
}

pub fn store_plugin_focus(intent: PluginFocusIntent) -> bool {
    let Ok(mut pending) = PENDING.lock() else { return false; };
    *pending = Some(intent);
    true
}

pub fn pending_plugin_focus() -> Option<PluginFocusIntent> {
    PENDING.lock().ok().and_then(|pending| pending.clone())
}

pub fn acknowledge_plugin_focus(request_id: u64) {
    let Ok(mut pending) = PENDING.lock() else { return; };
    if pending.as_ref().is_some_and(|intent| intent.request_id == request_id) {
        pending.take();
    }
}

pub fn parse_plugin_navigation_response(response: &[u8]) -> Result<Option<PluginFocusRequest>, String> {
    let body = http_json_body(response)?;
    let envelope: serde_json::Value = serde_json::from_slice(body)
        .map_err(|error| format!("Invalid plugin navigation JSON: {error}"))?;
    if envelope.get("code").and_then(serde_json::Value::as_i64) != Some(0) {
        return Err("Kiki backend plugin navigation request failed".to_string());
    }
    let data = envelope.get("data").ok_or("Kiki backend plugin navigation data is missing")?;
    if data.is_null() {
        return Err("Kiki backend plugin navigation data is missing".to_string());
    }
    let Some(request) = data.get("request").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let id = request.get("id").and_then(serde_json::Value::as_u64)
        .ok_or("Kiki backend plugin navigation id is missing")?;
    let session_id = request.get("sessionId").and_then(serde_json::Value::as_str)
        .filter(|session_id| !session_id.is_empty())
        .ok_or("Kiki backend plugin navigation session is missing")?
        .to_string();
    let at_ms = request.get("at").and_then(serde_json::Value::as_u64)
        .ok_or("Kiki backend plugin navigation time is missing")?;
    Ok(Some(PluginFocusRequest { id, session_id, at_ms }))
}

pub fn plugin_focus_is_actionable(request: &PluginFocusRequest, seen_id: u64, now_ms: u64) -> bool {
    request.id > seen_id && now_ms.saturating_sub(request.at_ms) < PLUGIN_FOCUS_TTL_MS
}

pub fn plugin_focus_route(session_id: &str) -> Option<String> {
    if session_id.is_empty() { return None; }
    let mut encoded = String::new();
    for byte in session_id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    let route = format!("/s/{encoded}");
    if !route.starts_with("/s/") || route[3..].chars().any(|character| character == '/' || character == '?' || character == '#') {
        return None;
    }
    Some(route)
}

pub fn plugin_focus_intent(home_id: &str, request: &PluginFocusRequest) -> Option<PluginFocusIntent> {
    Some(PluginFocusIntent {
        home_id: home_id.to_string(),
        route: plugin_focus_route(&request.session_id)?,
        request_id: request.id,
    })
}

/// Newest request wins. Equal timestamps use the higher id, then the lower home id.
pub fn select_background_plugin_focus(candidates: &[PluginFocusCandidate]) -> Option<&PluginFocusCandidate> {
    candidates.iter().max_by(|left, right| {
        left.request.at_ms.cmp(&right.request.at_ms)
            .then(left.request.id.cmp(&right.request.id))
            .then(right.home_id.cmp(&left.home_id))
    })
}

fn http_json_body(response: &[u8]) -> Result<&[u8], String> {
    let status_end = response.iter().position(|byte| *byte == b'\n')
        .ok_or("Kiki backend returned an incomplete plugin navigation status line")?;
    let line = response[..status_end].strip_suffix(b"\r").unwrap_or(&response[..status_end]);
    let line = std::str::from_utf8(line).map_err(|_| "Kiki backend returned an invalid plugin navigation status line".to_string())?;
    let mut fields = line.split_whitespace();
    let version = fields.next().unwrap_or("");
    let code = fields.next().unwrap_or("");
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1") || code != "200" {
        return Err("Kiki backend rejected the plugin navigation request".to_string());
    }
    let header_end = response.windows(4).position(|part| part == b"\r\n\r\n")
        .ok_or("Kiki backend returned incomplete plugin navigation headers")?;
    Ok(&response[header_end + 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(body: &str) -> Vec<u8> {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{body}").into_bytes()
    }

    #[test]
    fn reads_a_navigation_request_from_a_successful_envelope() {
        let response = envelope(r#"{"code":0,"msg":"success","data":{"request":{"id":4,"pluginId":"demo","sessionId":"session-a","at":5000}},"request_id":"r"}"#);
        let request = parse_plugin_navigation_response(&response).unwrap().unwrap();
        assert_eq!(request, PluginFocusRequest { id: 4, session_id: "session-a".to_string(), at_ms: 5000 });
    }

    #[test]
    fn reads_an_empty_navigation_envelope_as_no_request() {
        let response = envelope(r#"{"code":0,"msg":"success","data":{},"request_id":"r"}"#);
        assert_eq!(parse_plugin_navigation_response(&response).unwrap(), None);
    }

    #[test]
    fn rejects_a_non_success_status() {
        let response = b"HTTP/1.1 401 Unauthorized\r\n\r\n{\"code\":0,\"data\":{}}";
        assert!(parse_plugin_navigation_response(response).is_err());
    }

    #[test]
    fn rejects_a_failed_envelope_code() {
        let response = envelope(r#"{"code":1,"msg":"failed","data":null,"request_id":"r"}"#);
        assert!(parse_plugin_navigation_response(&response).is_err());
    }

    #[test]
    fn accepts_a_request_inside_the_ten_second_window_and_rejects_an_expired_or_seen_one() {
        let request = PluginFocusRequest { id: 4, session_id: "session-a".to_string(), at_ms: 5_000 };
        assert!(plugin_focus_is_actionable(&request, 3, 14_999));
        assert!(!plugin_focus_is_actionable(&request, 4, 14_999));
        assert!(!plugin_focus_is_actionable(&request, 3, 15_000));
    }

    #[test]
    fn chooses_the_newest_background_request_and_keeps_its_home_id() {
        let older = PluginFocusCandidate {
            home_id: "space-a".to_string(),
            request: PluginFocusRequest { id: 2, session_id: "old".to_string(), at_ms: 1_000 },
        };
        let newer = PluginFocusCandidate {
            home_id: "space-b".to_string(),
            request: PluginFocusRequest { id: 3, session_id: "new".to_string(), at_ms: 2_000 },
        };
        let candidates = [older, newer.clone()];
        let selected = select_background_plugin_focus(&candidates).unwrap();
        assert_eq!(selected, &newer);
        let intent = plugin_focus_intent(&selected.home_id, &selected.request).unwrap();
        assert_eq!(intent.home_id, "space-b");
        assert_eq!(intent.route, "/s/new");
        assert_eq!(intent.request_id, 3);
    }

    #[test]
    fn encodes_a_session_route_and_rejects_an_empty_session_id() {
        assert_eq!(plugin_focus_route("session a").as_deref(), Some("/s/session%20a"));
        assert_eq!(plugin_focus_route("a/b").as_deref(), Some("/s/a%2Fb"));
        assert_eq!(plugin_focus_route(""), None);
    }

    #[test]
    fn acknowledge_clears_only_the_matching_pending_intent() {
        let intent = PluginFocusIntent { home_id: "space-a".to_string(), route: "/s/session-a".to_string(), request_id: 6 };
        assert!(store_plugin_focus(intent.clone()));
        acknowledge_plugin_focus(5);
        assert_eq!(pending_plugin_focus(), Some(intent));
        acknowledge_plugin_focus(6);
        assert_eq!(pending_plugin_focus(), None);
    }
}
