use std::{collections::hash_map::DefaultHasher, hash::{Hash, Hasher}, path::Path};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowModeDescriptor {
    pub preset_id: String,
    pub window_id: String,
}

pub fn valid_preset(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty() && bytes.len() <= 64 && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

pub fn requested_preset(args: &[String]) -> Result<Option<String>, String> {
    let mut selected = None;
    for (index, argument) in args.iter().enumerate().skip(1) {
        if argument != "--preset" { continue; }
        let id = args.get(index + 1).ok_or("--preset requires a mode id")?;
        if selected.is_some() || !valid_preset(id) { return Err("--preset requires one valid mode id".to_string()); }
        selected = Some(id.clone());
    }
    Ok(selected)
}

pub fn window_identity(home: &Path, preset: &str) -> String {
    let mut hasher = DefaultHasher::new();
    let path = home.to_string_lossy().replace('\\', "/");
    let path = if cfg!(windows) { path.to_lowercase() } else { path };
    path.hash(&mut hasher);
    format!("w-{:016x}-{preset}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_are_window_local_not_home_settings() {
        assert_ne!(window_identity(Path::new("/example/a"), "kiki"), window_identity(Path::new("/example/a"), "work"));
        assert_ne!(window_identity(Path::new("/example/a"), "work"), window_identity(Path::new("/example/b"), "work"));
        assert_eq!(requested_preset(&["app".into(), "--preset".into(), "work".into()]).unwrap(), Some("work".into()));
        assert!(requested_preset(&["app".into(), "--preset".into(), "../work".into()]).is_err());
        assert!(requested_preset(&["app".into(), "--preset".into(), "work".into(), "--preset".into(), "kiki".into()]).is_err());
    }
}
