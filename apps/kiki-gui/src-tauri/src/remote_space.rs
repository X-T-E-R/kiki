use std::{collections::hash_map::DefaultHasher, hash::{Hash, Hasher}, path::Path, process::Command};

pub fn validate_connection_id(id: &str) -> Result<(), String> {
    let valid = id.len() == 36 && id.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' }
        else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
    });
    if valid { Ok(()) } else { Err("Invalid remote connection id".to_string()) }
}

pub fn requested_connection(args: &[String]) -> Result<Option<String>, String> {
    let mut selected = None;
    let mut index = 1;
    while index < args.len() {
        if args[index] == "--remote-connection" {
            let id = args.get(index + 1).ok_or("--remote-connection requires one connection id")?;
            validate_connection_id(id)?;
            if selected.is_some() { return Err("Only one remote connection may be selected".to_string()); }
            selected = Some(id.clone());
            index += 1;
        }
        index += 1;
    }
    Ok(selected)
}

pub fn command(exe: &Path, source_home: &Path, connection_id: &str) -> Result<Command, String> {
    validate_connection_id(connection_id)?;
    let mut command = Command::new(exe);
    command.env("KIKI_HOME", source_home).arg("--remote-connection").arg(connection_id);
    Ok(command)
}

pub fn window_identifier(base: &str, source_home: &Path, connection_id: &str) -> String {
    let mut hash = DefaultHasher::new();
    source_home.hash(&mut hash);
    format!("{base}.remote.{:016x}.{}", hash.finish(), connection_id.replace('-', ""))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn remote_launch_contains_only_the_id_and_keeps_the_source_home_in_the_environment() {
        let command = command(Path::new("kiki-desktop"), Path::new("source-home"), ID).unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec!["--remote-connection", ID]);
        assert_eq!(command.get_envs().collect::<Vec<_>>(), vec![(std::ffi::OsStr::new("KIKI_HOME"), Some(std::ffi::OsStr::new("source-home")))]);
    }

    #[test]
    fn remote_boot_rejects_missing_malformed_or_duplicate_ids() {
        assert_eq!(requested_connection(&["kiki-desktop".into(), "--remote-connection".into(), ID.into()]).unwrap(), Some(ID.into()));
        assert!(requested_connection(&["kiki-desktop".into(), "--remote-connection".into()]).is_err());
        assert!(requested_connection(&["kiki-desktop".into(), "--remote-connection".into(), "https://remote.example.test".into()]).is_err());
        assert!(requested_connection(&["kiki-desktop".into(), "--remote-connection".into(), ID.into(), "--remote-connection".into(), ID.into()]).is_err());
    }

    #[test]
    fn remote_single_instance_identity_does_not_reuse_the_local_or_another_source_window() {
        let base = "example.kiki";
        let first = window_identifier(base, Path::new("source-one"), ID);
        assert_ne!(first, base);
        assert_eq!(first, window_identifier(base, Path::new("source-one"), ID));
        assert_ne!(first, window_identifier(base, Path::new("source-two"), ID));
        assert_ne!(first, window_identifier(base, Path::new("source-one"), "33333333-3333-4333-8333-333333333333"));
    }
}
