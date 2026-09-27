use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};

use serde::{Deserialize, Serialize};

static PROFILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub id: String,
    pub label: String,
    pub target: SshTarget,
    pub identity_file: Option<String>,
    pub release_channel: ReleaseChannel,
    pub remote_port: Option<u16>,
    pub server_home_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshTarget {
    Alias { alias: String },
    Host { hostname: String, username: Option<String>, port: Option<u16> },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseChannel { Stable, Beta }

pub fn config_path() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("kiki").join("remote-connections.json"))
        .ok_or_else(|| "Cannot resolve the application config directory".to_string())
}

fn safe_field(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit &&
        !value.chars().any(|c| c.is_control())
}

impl SshProfile {
    pub fn validate(&self) -> Result<(), String> {
        if !safe_field(&self.id, 80) ||
            !self.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err("Invalid SSH profile ID".to_string());
        }
        if !safe_field(&self.label, 100) { return Err("Invalid SSH profile label".to_string()); }
        match &self.target {
            SshTarget::Alias { alias } => {
                if !safe_field(alias, 255) || alias.starts_with('-') ||
                    alias.chars().any(char::is_whitespace) {
                    return Err("Invalid SSH config alias".to_string());
                }
            }
            SshTarget::Host { hostname, username, port } => {
                if !safe_field(hostname, 255) || hostname.starts_with('-') ||
                    !hostname.bytes().all(|c| c.is_ascii_alphanumeric() || b".-:_".contains(&c)) {
                    return Err("Invalid SSH hostname".to_string());
                }
                if let Some(user) = username {
                    if !safe_field(user, 64) || user.starts_with('-') ||
                        !user.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) {
                        return Err("Invalid SSH username".to_string());
                    }
                }
                if *port == Some(0) { return Err("Invalid SSH port".to_string()); }
            }
        }
        if let Some(path) = &self.identity_file {
            if !safe_field(path, 4096) { return Err("Invalid SSH identity path".to_string()); }
        }
        if self.remote_port == Some(0) { return Err("Invalid remote Kiki port".to_string()); }
        if let Some(id) = &self.server_home_id {
            let bytes = id.as_bytes();
            if bytes.len() != 36 || bytes.iter().enumerate().any(|(i, byte)| {
                if matches!(i, 8 | 13 | 18 | 23) { *byte != b'-' }
                else { !byte.is_ascii_hexdigit() }
            }) {
                return Err("Invalid expected SSH server home ID".to_string());
            }
        }
        Ok(())
    }

    pub fn ssh_arguments(&self) -> Result<Vec<String>, String> {
        self.validate()?;
        let mut args = vec![
            "-T".into(), "-o".into(), "BatchMode=yes".into(),
            "-o".into(), "PreferredAuthentications=publickey".into(),
            "-o".into(), "PasswordAuthentication=no".into(),
            "-o".into(), "KbdInteractiveAuthentication=no".into(),
            "-o".into(), "StrictHostKeyChecking=yes".into(),
            "-o".into(), "ForwardAgent=no".into(),
            "-o".into(), "ForwardX11=no".into(),
            "-o".into(), "PermitLocalCommand=no".into(),
            "-o".into(), "ClearAllForwardings=no".into(),
            "-o".into(), "ConnectTimeout=10".into(),
            "-o".into(), "ServerAliveInterval=15".into(),
            "-o".into(), "ServerAliveCountMax=3".into(),
            "-o".into(), "ControlMaster=no".into(),
            "-o".into(), "RequestTTY=no".into(),
        ];
        if let Some(path) = &self.identity_file {
            args.extend(["-i".to_string(), path.clone()]);
        }
        match &self.target {
            SshTarget::Alias { alias } => args.push(alias.clone()),
            SshTarget::Host { hostname, username, port } => {
                if let Some(port) = port { args.extend(["-p".to_string(), port.to_string()]); }
                if let Some(user) = username { args.extend(["-l".to_string(), user.clone()]); }
                args.push(hostname.clone());
            }
        }
        Ok(args)
    }
}

pub fn read_profiles(path: &Path) -> Result<Vec<SshProfile>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot read SSH profiles: {error}")),
    };
    if raw.len() > 1024 * 1024 { return Err("SSH profile file exceeds size limit".to_string()); }
    let profiles: Vec<SshProfile> = serde_json::from_str(&raw)
        .map_err(|_| "SSH profile file is invalid".to_string())?;
    if profiles.len() > 100 { return Err("Too many SSH profiles".to_string()); }
    for profile in &profiles { profile.validate()?; }
    if profiles.iter().enumerate().any(|(i, profile)|
        profiles.iter().skip(i + 1).any(|next| next.id == profile.id)) {
        return Err("Duplicate SSH profile IDs".to_string());
    }
    Ok(profiles)
}

fn write_profiles(path: &Path, profiles: &[SshProfile]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid SSH profile path")?;
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create SSH config directory: {e}"))?;
    let staging = path.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staging).map_err(|e| format!("Cannot stage SSH profiles: {e}"))?;
        serde_json::to_writer(&mut file, profiles).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&staging, path).map_err(|e| format!("Cannot save SSH profiles: {e}"))
    })();
    if result.is_err() { let _ = fs::remove_file(&staging); }
    result
}

pub fn save_profile(path: &Path, profile: SshProfile) -> Result<Vec<SshProfile>, String> {
    let _lock = PROFILE_LOCK.lock().map_err(|_| "SSH profile store is unavailable".to_string())?;
    profile.validate()?;
    let mut profiles = read_profiles(path)?;
    if let Some(current) = profiles.iter_mut().find(|entry| entry.id == profile.id) {
        *current = profile;
    } else {
        if profiles.len() >= 100 { return Err("Too many SSH profiles".to_string()); }
        profiles.push(profile);
    }
    write_profiles(path, &profiles)?;
    Ok(profiles)
}

pub fn remove_profile(path: &Path, id: &str) -> Result<Vec<SshProfile>, String> {
    let _lock = PROFILE_LOCK.lock().map_err(|_| "SSH profile store is unavailable".to_string())?;
    let mut profiles = read_profiles(path)?;
    profiles.retain(|profile| profile.id != id);
    write_profiles(path, &profiles)?;
    Ok(profiles)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(target: SshTarget) -> SshProfile {
        SshProfile { id: "host-1".into(), label: "Example host".into(), target,
            identity_file: None, release_channel: ReleaseChannel::Stable,
            remote_port: None, server_home_id: None }
    }
    #[test]
    fn validates_shell_and_ssh_option_boundaries() {
        for alias in ["-oProxyCommand=evil", "host\ncommand", "host name", ""] {
            assert!(profile(SshTarget::Alias { alias: alias.into() }).validate().is_err());
        }
        let mut valid = profile(SshTarget::Host {
            hostname: "example.test".into(), username: Some("user_name".into()), port: Some(2222),
        });
        valid.identity_file = Some("/home/user/.ssh/id_ed25519".into());
        let args = valid.ssh_arguments().unwrap();
        assert_eq!(args.last().unwrap(), "example.test");
        assert!(args.windows(2).any(|pair| pair[0] == "-l" && pair[1] == "user_name"));
        assert!(args.windows(2).any(|pair| pair[0] == "-i" && pair[1] == "/home/user/.ssh/id_ed25519"));
        assert!(!args.iter().any(|arg| arg.contains("ProxyCommand=evil")));
        assert!(profile(SshTarget::Host { hostname: "-evil".into(), username: None, port: None }).validate().is_err());
        assert!(profile(SshTarget::Host { hostname: "example.test".into(), username: Some("bad;cmd".into()), port: None }).validate().is_err());
    }
    #[test]
    fn profiles_round_trip_without_credentials() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("kiki-ssh-profile-test-{}-{stamp}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("remote-connections.json");
        let profile = profile(SshTarget::Alias { alias: "example".into() });
        assert_eq!(save_profile(&path, profile.clone()).unwrap(), vec![profile.clone()]);
        assert_eq!(read_profiles(&path).unwrap(), vec![profile]);
        assert!(fs::read_to_string(&path).unwrap().find("token").is_none());
        assert!(remove_profile(&path, "host-1").unwrap().is_empty());
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
