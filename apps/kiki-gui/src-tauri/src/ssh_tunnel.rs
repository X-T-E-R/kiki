use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicU64, Ordering}, mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::ssh_remote::{ReleaseChannel, SshProfile};

const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_META_BYTES: u64 = 64 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshResolvedConnection {
    pub config: SshConnectionConfig,
    pub tunnel_id: String,
    pub server_home_id: String,
    pub server_instance_id: String,
    pub server_version: String,
    pub build_id: Option<String>,
    pub build_channel: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct SshConnectionConfig {
    pub url: String,
    pub token: String,
}

struct Tunnel {
    profile_id: String,
    tunnel_id: String,
    child: Child,
    home_id: String,
    window_label: String,
    connection: Option<SshResolvedConnection>,
    accepted: bool,
    profile: SshProfile,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Default)]
pub struct TunnelManager {
    active: Arc<Mutex<Option<Tunnel>>>,
    prepared: Arc<Mutex<Option<Tunnel>>>,
    selected: Arc<Mutex<Option<String>>>,
    next_id: Arc<AtomicU64>,
}

impl TunnelManager {
    pub fn connect(&self, profile: &SshProfile, token: &str) -> Result<SshResolvedConnection, String> {
        self.connect_with_binary(profile, token, Path::new("ssh"))
    }

    pub fn prepare(&self, profile: &SshProfile, token: &str, home_id: &str, window_label: &str) -> Result<SshResolvedConnection, String> {
        {
            let mut prepared = self.prepared.lock().map_err(|_| "SSH tunnel manager unavailable")?;
            let selected = self.selected.lock().map_err(|_| "SSH tunnel manager unavailable")?;
            if prepared.as_ref().is_some_and(|tunnel| tunnel.accepted && selected.as_deref() == Some(tunnel.tunnel_id.as_str())) {
                let mut active = self.active.lock().map_err(|_| "SSH tunnel manager unavailable")?;
                *active = prepared.take();
            }
        }
        let connection = self.connect_to(profile, token, Path::new("ssh"), true)?;
        self.bind(&profile.id, &connection.tunnel_id, home_id, window_label)?;
        Ok(connection)
    }

    fn connect_with_binary(&self, profile: &SshProfile, token: &str, ssh: &Path) -> Result<SshResolvedConnection, String> {
        self.connect_to(profile, token, ssh, false)
    }

    fn connect_to(&self, profile: &SshProfile, token: &str, ssh: &Path, staged: bool) -> Result<SshResolvedConnection, String> {
        profile.validate()?;
        let remote_port = profile.remote_port.ok_or("Set the running Kiki server port in this SSH profile")?;
        let expected_home = profile.server_home_id.as_deref().ok_or("Set the expected home ID from the trusted remote Kiki terminal")?;
        if token.len() != 43 || !token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
            return Err("Enter the 43-character bearer token printed by the remote Kiki server".to_string());
        }
        let mut active = (if staged { &self.prepared } else { &self.active }).lock().map_err(|_| "SSH tunnel manager unavailable")?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| format!("Cannot reserve a local SSH port: {e}"))?;
        let local_port = listener.local_addr().map_err(|e| format!("Cannot read the local SSH port: {e}"))?.port();
        drop(listener);

        let mut args = profile.ssh_arguments()?;
        let forward = format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}");
        let position = args.len() - 1;
        args.splice(position..position, ["-v".to_string(), "-N".to_string(), "-o".to_string(), "ExitOnForwardFailure=yes".to_string(), "-L".to_string(), forward]);
        let mut child = Command::new(ssh).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("Cannot start system OpenSSH: {e}"))?;
        let stderr = child.stderr.take().ok_or("Cannot inspect system OpenSSH forwarding readiness")?;
        let (ready_sender, ready_receiver) = mpsc::channel();
        let expected_ready = format!("debug1: Local forwarding listening on 127.0.0.1 port {local_port}.");
        thread::spawn(move || {
            let mut reported = false;
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break; };
                if !reported && line.trim_end() == expected_ready {
                    let _ = ready_sender.send(());
                    reported = true;
                }
            }
        });
        let tunnel_id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let mut candidate = Tunnel { profile_id: profile.id.clone(), tunnel_id: tunnel_id.clone(), child,
            home_id: String::new(), window_label: String::new(), connection: None, accepted: !staged, profile: profile.clone() };
        let start = Instant::now();
        // Never send the bearer to a freshly freed port until this exact SSH
        // process reports binding it. A competing listener must not get a probe.
        loop {
            if let Some(status) = candidate.child.try_wait().map_err(|e| format!("Cannot inspect the SSH tunnel: {e}"))? {
                return Err(format!("SSH tunnel exited ({status}); verify the host key, SSH config alias, and local forwarding permission"));
            }
            if ready_receiver.try_recv().is_ok() { break; }
            if start.elapsed() >= PROBE_TIMEOUT {
                return Err("SSH tunnel did not confirm local forwarding; verify the host key, SSH alias and port".to_string());
            }
            thread::sleep(Duration::from_millis(50));
        }
        let verified = loop {
            if let Some(status) = candidate.child.try_wait().map_err(|e| format!("Cannot inspect the SSH tunnel: {e}"))? {
                return Err(format!("SSH tunnel exited ({status}); verify the host key, SSH config alias, and remote port"));
            }
            match probe_meta(local_port, token, expected_home, &profile.release_channel) {
                Ok(Some(identity)) => break identity,
                Ok(None) if start.elapsed() < PROBE_TIMEOUT => thread::sleep(Duration::from_millis(100)),
                Ok(None) => return Err("SSH tunnel timed out; verify the running Kiki port and SSH forwarding permission".to_string()),
                Err(error) => return Err(error),
            }
        };
        if candidate.child.try_wait().map_err(|e| format!("Cannot inspect the SSH tunnel: {e}"))?.is_some() {
            return Err("SSH tunnel closed before the server identity was verified".to_string());
        }
        let connection = SshResolvedConnection {
            config: SshConnectionConfig { url: format!("http://127.0.0.1:{local_port}"), token: token.to_string() },
            tunnel_id,
            server_home_id: verified.home_id,
            server_instance_id: verified.server_id,
            server_version: verified.version,
            build_id: verified.build_id,
            build_channel: verified.build_channel,
        };
        candidate.connection = Some(connection.clone());
        *active = Some(candidate);
        Ok(connection)
    }

    pub fn bind(&self, profile_id: &str, tunnel_id: &str, home_id: &str, window_label: &str) -> Result<(), String> {
        for slot in [&self.prepared, &self.active] {
            let mut value = slot.lock().map_err(|_| "SSH tunnel manager unavailable")?;
            if let Some(tunnel) = value.as_mut().filter(|t| t.profile_id == profile_id && t.tunnel_id == tunnel_id) {
                tunnel.home_id = home_id.to_string();
                tunnel.window_label = window_label.to_string();
                return Ok(());
            }
        }
        Err("SSH connection reference expired".to_string())
    }

    pub fn profile_matches(&self, profile: &SshProfile, tunnel_id: &str) -> bool {
        for slot in [&self.prepared, &self.active] {
            if let Ok(value) = slot.lock() {
                if let Some(tunnel) = value.as_ref().filter(|t| t.profile_id == profile.id && t.tunnel_id == tunnel_id) {
                    return &tunnel.profile == profile;
                }
            }
        }
        false
    }

    pub fn resume(&self, profile_id: &str, tunnel_id: &str, home_id: &str, window_label: &str) -> Result<SshResolvedConnection, String> {
        for slot in [&self.prepared, &self.active] {
            let mut value = slot.lock().map_err(|_| "SSH tunnel manager unavailable")?;
            if let Some(tunnel) = value.as_mut().filter(|t| t.profile_id == profile_id && t.tunnel_id == tunnel_id &&
                t.home_id == home_id && t.window_label == window_label) {
                if tunnel.child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("SSH tunnel is offline".to_string()); }
                return tunnel.connection.clone().ok_or_else(|| "SSH connection reference expired".to_string());
            }
        }
        Err("SSH connection reference expired".to_string())
    }

    pub fn commit(&self, profile_id: &str, tunnel_id: &str, home_id: &str, window_label: &str) -> Result<(), String> {
        self.resume(profile_id, tunnel_id, home_id, window_label)?;
        let mut prepared = self.prepared.lock().map_err(|_| "SSH tunnel manager unavailable")?;
        if let Some(tunnel) = prepared.as_mut().filter(|t| t.profile_id == profile_id && t.tunnel_id == tunnel_id) {
            tunnel.accepted = true;
        }
        *self.selected.lock().map_err(|_| "SSH tunnel manager unavailable")? = Some(tunnel_id.to_string());
        Ok(())
    }

    pub fn is_running(&self, profile_id: &str, tunnel_id: &str) -> bool {
        for slot in [&self.prepared, &self.active] {
            let Ok(mut value) = slot.lock() else { continue; };
            if let Some(tunnel) = value.as_mut().filter(|t| t.profile_id == profile_id && t.tunnel_id == tunnel_id) {
                return match tunnel.child.try_wait() { Ok(None) => true, _ => { *value = None; false } };
            }
        }
        false
    }

    pub fn disconnect(&self, profile_id: &str, tunnel_id: &str) {
        for slot in [&self.prepared, &self.active] {
            if let Ok(mut value) = slot.lock() {
                if value.as_ref().is_some_and(|t| t.profile_id == profile_id && t.tunnel_id == tunnel_id) { *value = None; }
            }
        }
    }

    pub fn shutdown(&self) {
        for slot in [&self.prepared, &self.active] { if let Ok(mut value) = slot.lock() { *value = None; } }
    }
}

struct VerifiedMeta {
    home_id: String,
    server_id: String,
    version: String,
    build_id: Option<String>,
    build_channel: Option<String>,
}

fn probe_meta(port: u16, token: &str, expected_home: &str, channel: &ReleaseChannel) -> Result<Option<VerifiedMeta>, String> {
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
        Ok(stream) => stream,
        Err(error) if matches!(error.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut) => return Ok(None),
        Err(error) => return Err(format!("Cannot reach the SSH tunnel: {error}")),
    };
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    let request = format!("GET /api/meta HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|e| format!("Cannot send the SSH server identity probe: {e}"))?;
    let mut response = Vec::new();
    stream.take(MAX_META_BYTES + 1).read_to_end(&mut response)
        .map_err(|e| format!("Cannot read SSH server metadata ({e}); verify the remote Kiki port and service"))?;
    if response.len() as u64 > MAX_META_BYTES { return Err("SSH server metadata is too large".to_string()); }
    let header_end = response.windows(4).position(|chunk| chunk == b"\r\n\r\n")
        .ok_or("SSH server returned an incomplete HTTP response")?;
    let headers = std::str::from_utf8(&response[..header_end]).map_err(|_| "SSH server returned invalid HTTP headers")?;
    let mut status = headers.lines().next().unwrap_or("").split_ascii_whitespace();
    let protocol = status.next().unwrap_or("");
    let code = status.next().unwrap_or("");
    if !matches!(protocol, "HTTP/1.0" | "HTTP/1.1") || code.len() != 3 ||
        !code.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Remote Kiki server returned an invalid HTTP status".to_string());
    }
    if matches!(code, "401" | "403") {
        return Err("Remote Kiki server rejected the bearer token or Host header".to_string());
    }
    if code != "200" { return Err(format!("Remote Kiki metadata request failed (HTTP {code})")); }
    let body = decode_http_body(headers, &response[header_end + 4..])?;
    let json: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| "Remote Kiki server returned invalid metadata JSON")?;
    let data = json.get("data").ok_or("Remote Kiki metadata has no data envelope")?;
    let home_id = data.get("server_home_id").and_then(serde_json::Value::as_str)
        .ok_or("Remote Kiki server is too old: server_home_id is missing; upgrade the server")?;
    if home_id != expected_home { return Err("SSH server home identity does not match the trusted profile; connection blocked".to_string()); }
    if data.get("dangerous_bypass_auth").and_then(serde_json::Value::as_bool) != Some(false) {
        return Err("Remote Kiki server does not confirm bearer authentication; SSH connection blocked".to_string());
    }
    let server_id = data.get("server_id").and_then(serde_json::Value::as_str).filter(|id| !id.is_empty())
        .ok_or("Remote Kiki metadata has no server instance identity")?;
    let version = data.get("server_version").and_then(serde_json::Value::as_str).filter(|version| !version.is_empty())
        .ok_or("Remote Kiki metadata has no server version")?;
    let build_id = data.get("build_id").and_then(serde_json::Value::as_str).map(str::to_string);
    let build_channel = data.get("build_channel").and_then(serde_json::Value::as_str).map(str::to_string);
    if build_id.as_deref() == Some("") || build_channel.as_deref() == Some("") {
        return Err("Remote Kiki metadata has an invalid build identity".to_string());
    }
    if let Some(actual) = build_channel.as_deref() {
        let expected = match channel { ReleaseChannel::Stable => "stable", ReleaseChannel::Beta => "beta" };
        if actual != expected {
            let hint = match actual {
                "stable" | "beta" => format!("Remote Kiki release channel is {actual}; select {actual} in this SSH profile and retry"),
                _ => "Remote Kiki metadata has an unsupported release channel".to_string(),
            };
            return Err(hint);
        }
    }
    Ok(Some(VerifiedMeta { home_id: home_id.to_string(), server_id: server_id.to_string(),
        version: version.to_string(), build_id, build_channel }))
}

fn decode_http_body(headers: &str, body: &[u8]) -> Result<Vec<u8>, String> {
    let framing = headers.lines().skip(1).filter_map(|line| line.split_once(':'));
    let mut length = None;
    let mut transfer = None;
    for (name, value) in framing {
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.trim().parse::<usize>().map_err(|_| "Invalid SSH metadata content length")?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            transfer = Some(value.trim());
        }
    }
    if let Some(encoding) = transfer {
        if !encoding.eq_ignore_ascii_case("chunked") || length.is_some() {
            return Err("Unsupported SSH metadata HTTP framing".to_string());
        }
        let mut decoded = Vec::new();
        let mut cursor = 0;
        loop {
            let line_end = body.get(cursor..).and_then(|tail| tail.windows(2).position(|part| part == b"\r\n"))
                .ok_or("Incomplete chunked SSH metadata")?;
            let line = std::str::from_utf8(&body[cursor..cursor + line_end])
                .map_err(|_| "Invalid chunked SSH metadata")?;
            let size = usize::from_str_radix(line.split(';').next().unwrap_or(""), 16)
                .map_err(|_| "Invalid chunked SSH metadata")?;
            cursor += line_end + 2;
            if size == 0 {
                if body.get(cursor..) != Some(b"\r\n".as_slice()) {
                    return Err("Incomplete chunked SSH metadata".to_string());
                }
                return Ok(decoded);
            }
            if size > MAX_META_BYTES as usize || decoded.len() + size > MAX_META_BYTES as usize {
                return Err("SSH server metadata is too large".to_string());
            }
            let end = cursor.checked_add(size).ok_or("Invalid chunked SSH metadata")?;
            let chunk = body.get(cursor..end).ok_or("Incomplete chunked SSH metadata")?;
            decoded.extend_from_slice(chunk);
            if body.get(end..end + 2) != Some(b"\r\n".as_slice()) {
                return Err("Invalid chunked SSH metadata".to_string());
            }
            cursor = end + 2;
        }
    }
    if let Some(expected) = length {
        if expected != body.len() { return Err("Incomplete SSH metadata response".to_string()); }
    }
    Ok(body.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn scope_reference_child_process() { thread::sleep(Duration::from_secs(30)); }

    fn fixture_tunnel(id: &str, home: &str, window: &str) -> Tunnel {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "ssh_tunnel::tests::scope_reference_child_process"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        Tunnel { profile_id: "example".to_string(), tunnel_id: id.to_string(), child,
            home_id: home.to_string(), window_label: window.to_string(), accepted: false,
            profile: SshProfile { id: "example".to_string(), label: "Example".to_string(), target: crate::ssh_remote::SshTarget::Alias { alias: "example".to_string() },
                identity_file: None, release_channel: ReleaseChannel::Stable, remote_port: Some(58627), server_home_id: Some("server-example".to_string()) },
            connection: Some(SshResolvedConnection { config: SshConnectionConfig { url: "http://127.0.0.1:41321".to_string(), token: "fixture-memory-bearer".to_string() },
                tunnel_id: id.to_string(), server_home_id: "server-example".to_string(), server_instance_id: "instance-example".to_string(),
                server_version: "0.1.0".to_string(), build_id: None, build_channel: Some("stable".to_string()) }) }
    }

    #[test]
    fn scope_reference_is_bound_to_window_home_profile_and_exact_live_tunnel() {
        let manager = TunnelManager::default();
        *manager.active.lock().unwrap() = Some(fixture_tunnel("original", "home-a", "window-a"));
        assert!(manager.resume("example", "original", "home-a", "window-a").is_ok());
        assert!(manager.resume("example", "original", "home-b", "window-a").is_err());
        assert!(manager.resume("example", "original", "home-a", "window-b").is_err());
        assert!(manager.resume("other-profile", "original", "home-a", "window-a").is_err());
        assert!(manager.resume("example", "same-name-new-tunnel", "home-a", "window-a").is_err());
        let mut profile = manager.active.lock().unwrap().as_ref().unwrap().profile.clone();
        assert!(manager.profile_matches(&profile, "original"));
        profile.remote_port = Some(58628);
        assert!(!manager.profile_matches(&profile, "original"));
        manager.disconnect("example", "original");
        assert!(manager.resume("example", "original", "home-a", "window-a").is_err());
    }

    #[test]
    fn scope_reference_cancelled_candidate_never_revokes_the_source() {
        let manager = TunnelManager::default();
        *manager.active.lock().unwrap() = Some(fixture_tunnel("original", "home-a", "window-a"));
        *manager.prepared.lock().unwrap() = Some(fixture_tunnel("candidate", "home-b", "window-a"));
        assert!(manager.commit("example", "candidate", "home-b", "window-a").is_ok());
        assert!(manager.resume("example", "original", "home-a", "window-a").is_ok());
        manager.disconnect("example", "candidate");
        assert!(manager.resume("example", "original", "home-a", "window-a").is_ok());
        assert!(!manager.is_running("example", "candidate"));
    }

    #[test]
    fn scope_reference_return_selects_the_exact_prior_connection_without_reauthentication() {
        let manager = TunnelManager::default();
        *manager.active.lock().unwrap() = Some(fixture_tunnel("original", "home-a", "window-a"));
        *manager.prepared.lock().unwrap() = Some(fixture_tunnel("candidate", "home-b", "window-a"));
        manager.commit("example", "candidate", "home-b", "window-a").unwrap();
        manager.commit("example", "original", "home-a", "window-a").unwrap();
        assert_eq!(manager.selected.lock().unwrap().as_deref(), Some("original"));
        assert_eq!(manager.resume("example", "original", "home-a", "window-a").unwrap().tunnel_id, "original");
        assert!(manager.is_running("example", "candidate"));
    }

    #[test]
    fn accepts_complete_meta_body_and_rejects_incomplete_framing() {
        assert_eq!(decode_http_body("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", b"2\r\n{}\r\n0\r\n\r\n").unwrap(), b"{}");
        assert_eq!(decode_http_body("HTTP/1.1 200 OK\r\nContent-Length: 2", b"{}").unwrap(), b"{}");
        assert!(decode_http_body("HTTP/1.1 200 OK\r\nContent-Length: 4", b"{}").is_err());
        assert!(decode_http_body("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", b"2\r\n{}\r\n0\r\n").is_err());
        assert!(decode_http_body("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip", b"{}").is_err());
    }

    #[test]
    fn rejects_missing_manual_inputs_without_launching_ssh() {
        use crate::ssh_remote::{SshTarget, SshProfile, ReleaseChannel};
        let manager = TunnelManager::default();
        let profile = SshProfile { id: "host-1".into(), label: "Example".into(),
            target: SshTarget::Alias { alias: "example".into() }, identity_file: None,
            release_channel: ReleaseChannel::Stable, remote_port: None, server_home_id: None };
        assert!(manager.connect_with_binary(&profile, "a", Path::new("nonexistent-fake-ssh")).err().unwrap().contains("port"));
    }

    #[cfg(unix)]
    #[test]
    fn fake_ssh_tunnel_accepts_matching_meta_rejects_changed_home_without_install() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use crate::ssh_remote::SshTarget;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("kiki-fake-ssh-{}-{stamp}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let fake = dir.join("ssh");
        fs::write(&fake, "#!/bin/sh\nexec node -e 'const net=require(\"net\");const a=process.argv;const p=a[a.indexOf(\"-L\")+1].split(\":\");net.createServer(s=>{const t=net.connect(Number(p[3]),\"127.0.0.1\");s.pipe(t).pipe(s)}).listen(Number(p[1]),\"127.0.0.1\",()=>console.error(\"debug1: Local forwarding listening on 127.0.0.1 port \"+p[1]+\".\"))' -- \"$@\"\n").unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
        let id = "46aca369-50e8-4fd3-9c45-606d084450ed";
        let token = "a".repeat(43);
        let serve = |home: &'static str, channel: &'static str| {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let thread = thread::spawn(move || {
                let (mut connection, _) = listener.accept().unwrap();
                let mut input = [0_u8; 4096];
                let size = connection.read(&mut input).unwrap();
                assert!(std::str::from_utf8(&input[..size]).unwrap().contains("Authorization: Bearer "));
                let body = serde_json::json!({"data": {"server_home_id": home,
                    "server_id": "server-one", "server_version": "0.1.0", "dangerous_bypass_auth": false,
                    "build_id": "build-one", "build_channel": channel}}).to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                connection.write_all(response.as_bytes()).unwrap();
            });
            (port, thread)
        };
        let manager = TunnelManager::default();
        let (port, server) = serve("46aca369-50e8-4fd3-9c45-606d084450ed", "stable");
        let mut profile = SshProfile { id: "host-1".into(), label: "Example".into(),
            target: SshTarget::Alias { alias: "example".into() }, identity_file: None,
            release_channel: ReleaseChannel::Stable, remote_port: Some(port), server_home_id: Some(id.into()) };
        let connection = manager.connect_with_binary(&profile, &token, &fake).unwrap();
        server.join().unwrap();
        assert!(connection.config.url.starts_with("http://127.0.0.1:"));
        assert_eq!(connection.server_home_id, id);
        assert!(manager.is_running("host-1", &connection.tunnel_id));
        let (changed_port, changed_server) = serve("00000000-0000-4000-8000-000000000000", "stable");
        profile.remote_port = Some(changed_port);
        assert!(manager.connect_with_binary(&profile, &token, &fake).err().unwrap().contains("does not match"));
        changed_server.join().unwrap();
        assert!(manager.is_running("host-1", &connection.tunnel_id));
        let (beta_port, beta_server) = serve("46aca369-50e8-4fd3-9c45-606d084450ed", "beta");
        profile.remote_port = Some(beta_port);
        assert!(manager.connect_with_binary(&profile, &token, &fake).err().unwrap().contains("release channel"));
        beta_server.join().unwrap();
        assert!(manager.is_running("host-1", &connection.tunnel_id));
        let (new_port, new_server) = serve("46aca369-50e8-4fd3-9c45-606d084450ed", "beta");
        profile.release_channel = ReleaseChannel::Beta;
        profile.remote_port = Some(new_port);
        let replaced = manager.connect_with_binary(&profile, &token, &fake).unwrap();
        new_server.join().unwrap();
        assert!(!manager.is_running("host-1", &connection.tunnel_id));
        manager.disconnect("host-1", &connection.tunnel_id);
        assert!(manager.is_running("host-1", &replaced.tunnel_id));
        manager.disconnect("host-1", &replaced.tunnel_id);
        assert!(!manager.is_running("host-1", &replaced.tunnel_id));
        fs::remove_file(&fake).unwrap();
        fs::remove_dir(&dir).unwrap();
    }
}
