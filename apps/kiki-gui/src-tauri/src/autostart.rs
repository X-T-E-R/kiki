use std::path::{Path, PathBuf};
use serde::Serialize;

pub const AUTOSTART_FLAG: &str = "--autostart";
#[cfg(windows)]
const WINDOWS_RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const WINDOWS_RUN_VALUE_NAME: &str = "Kiki";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub enabled: bool,
    pub supported: bool,
    pub command: Option<String>,
}

/// Prefer `<RuntimeRoot>/active/kiki-desktop(.exe)` when the current binary is
/// part of a promoted runtime layout and `active` holds a real non-empty binary.
pub(crate) fn resolve_autostart_executable_for(current_exe: &Path) -> PathBuf {
    let resolved = crate::release_redirect::resolve_launch_executable_for(current_exe);
    let normalized = crate::release_redirect::strip_windows_verbatim_prefix(&resolved);
    if let Some(release_dir) = normalized.parent() {
        if let Some(releases_dir) = release_dir.parent() {
            let is_releases = releases_dir
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("releases"));
            if is_releases {
                if let Some(runtime_root) = releases_dir.parent() {
                    if let Some(file_name) = normalized.file_name() {
                        let active_exe = runtime_root.join("active").join(file_name);
                        if std::fs::symlink_metadata(&active_exe)
                            .map(|meta| meta.is_file() && meta.len() > 0 && !meta.file_type().is_symlink())
                            .unwrap_or(false)
                        {
                            return active_exe;
                        }
                    }
                }
            }
        }
    }
    normalized
}

pub(crate) fn resolve_autostart_executable() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(resolve_autostart_executable_for(&current))
}

pub(crate) fn format_windows_run_command(exe: &Path) -> Result<String, String> {
    let text = exe
        .to_str()
        .ok_or_else(|| "Kiki executable path is not valid Unicode".to_string())?;
    if !exe.is_absolute() || text.contains('"') || text.chars().any(char::is_control) {
        return Err("Kiki executable path cannot be registered for autostart".to_string());
    }
    Ok(format!("\"{text}\" {AUTOSTART_FLAG}"))
}

/// Extract the executable path from a Windows Run command like `"C:\...\kiki-desktop.exe" --autostart`.
pub(crate) fn parse_run_command_executable(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    let exe_str = if let Some(rest) = trimmed.strip_prefix('"') {
        let end = rest.find('"')?;
        &rest[..end]
    } else {
        trimmed.split_whitespace().next()?
    };
    if exe_str.is_empty() {
        return None;
    }
    Some(PathBuf::from(exe_str))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    struct RegKeyGuard(HKEY);

    impl Drop for RegKeyGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    RegCloseKey(self.0);
                }
            }
        }
    }

    pub(crate) fn read_run_value(subkey: &str, value_name: &str) -> Result<Option<String>, String> {
        let subkey_w = wide_null(OsStr::new(subkey));
        let value_w = wide_null(OsStr::new(value_name));
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey_w.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(format!("Cannot open Windows autostart registry key (error {status})"));
        }
        let _guard = RegKeyGuard(hkey);

        let mut value_type: u32 = 0;
        let mut bytes_needed: u32 = 0;
        let size_status = unsafe {
            RegQueryValueExW(
                hkey,
                value_w.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                std::ptr::null_mut(),
                &mut bytes_needed,
            )
        };
        if size_status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if size_status != ERROR_SUCCESS {
            return Err(format!("Cannot query Windows autostart entry (error {size_status})"));
        }
        if bytes_needed == 0 || bytes_needed > 64 * 1024 {
            return Ok(None);
        }
        let units_len = (bytes_needed as usize).div_ceil(2);
        let mut buffer = vec![0u16; units_len];
        let mut actual_bytes = (buffer.len() * 2) as u32;
        let read_status = unsafe {
            RegQueryValueExW(
                hkey,
                value_w.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                buffer.as_mut_ptr() as *mut u8,
                &mut actual_bytes,
            )
        };
        if read_status != ERROR_SUCCESS {
            return Err(format!("Cannot read Windows autostart entry (error {read_status})"));
        }
        let actual_units = (actual_bytes as usize) / 2;
        let trimmed = buffer[..actual_units.min(buffer.len())]
            .split(|&ch| ch == 0)
            .next()
            .unwrap_or(&[]);
        let text = String::from_utf16_lossy(trimmed).trim().to_string();
        if text.is_empty() {
            Ok(None)
        } else {
            Ok(Some(text))
        }
    }

    pub(crate) fn write_run_value(subkey: &str, value_name: &str, command: &str) -> Result<(), String> {
        let subkey_w = wide_null(OsStr::new(subkey));
        let value_w = wide_null(OsStr::new(value_name));
        let data_w = wide_null(OsStr::new(command));
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey_w.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut hkey,
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("Cannot open Windows autostart registry key for writing (error {status})"));
        }
        let _guard = RegKeyGuard(hkey);

        let byte_len = (data_w.len() * 2) as u32;
        let set_status = unsafe {
            RegSetValueExW(
                hkey,
                value_w.as_ptr(),
                0,
                REG_SZ,
                data_w.as_ptr() as *const u8,
                byte_len,
            )
        };
        if set_status != ERROR_SUCCESS {
            return Err(format!("Cannot save Windows autostart entry (error {set_status})"));
        }
        Ok(())
    }

    pub(crate) fn delete_run_value(subkey: &str, value_name: &str) -> Result<(), String> {
        let subkey_w = wide_null(OsStr::new(subkey));
        let value_w = wide_null(OsStr::new(value_name));
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey_w.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut hkey,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        if status != ERROR_SUCCESS {
            return Err(format!("Cannot open Windows autostart registry key (error {status})"));
        }
        let _guard = RegKeyGuard(hkey);

        let del_status = unsafe { RegDeleteValueW(hkey, value_w.as_ptr()) };
        if del_status != ERROR_SUCCESS && del_status != ERROR_FILE_NOT_FOUND {
            return Err(format!("Cannot remove Windows autostart entry (error {del_status})"));
        }
        Ok(())
    }

    pub fn get_status() -> Result<AutostartStatus, String> {
        let command = read_run_value(WINDOWS_RUN_SUBKEY, WINDOWS_RUN_VALUE_NAME)?;
        Ok(AutostartStatus {
            enabled: command.is_some(),
            supported: true,
            command,
        })
    }

    pub fn set_enabled(enabled: bool) -> Result<AutostartStatus, String> {
        if enabled {
            let exe = resolve_autostart_executable()?;
            let command = format_windows_run_command(&exe)?;
            write_run_value(WINDOWS_RUN_SUBKEY, WINDOWS_RUN_VALUE_NAME, &command)?;
            Ok(AutostartStatus {
                enabled: true,
                supported: true,
                command: Some(command),
            })
        } else {
            delete_run_value(WINDOWS_RUN_SUBKEY, WINDOWS_RUN_VALUE_NAME)?;
            Ok(AutostartStatus {
                enabled: false,
                supported: true,
                command: None,
            })
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs;

    fn desktop_entry_path() -> Result<PathBuf, String> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| "Cannot resolve XDG config directory for autostart".to_string())?;
        Ok(config_dir.join("autostart").join("ai.easyagent.kiki.desktop"))
    }

    pub fn get_status() -> Result<AutostartStatus, String> {
        let path = desktop_entry_path()?;
        match fs::read_to_string(&path) {
            Ok(content) => {
                let exec = content
                    .lines()
                    .find_map(|line| line.strip_prefix("Exec="))
                    .map(|line| line.trim().to_string());
                Ok(AutostartStatus {
                    enabled: exec.is_some(),
                    supported: true,
                    command: exec,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AutostartStatus {
                enabled: false,
                supported: true,
                command: None,
            }),
            Err(error) => Err(format!("Cannot read autostart file {}: {error}", path.display())),
        }
    }

    pub fn set_enabled(enabled: bool) -> Result<AutostartStatus, String> {
        let path = desktop_entry_path()?;
        if !enabled {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Cannot remove autostart file: {error}")),
            }
            return Ok(AutostartStatus {
                enabled: false,
                supported: true,
                command: None,
            });
        }
        let exe = resolve_autostart_executable()?;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| "Kiki executable path is not valid Unicode".to_string())?;
        let escaped = exe_str
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`");
        let exec = format!("\"{escaped}\" {AUTOSTART_FLAG}");
        let body = format!(
            "[Desktop Entry]\nType=Application\nName=Kiki\nExec={exec}\nX-GNOME-Autostart-enabled=true\n"
        );
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&path, body).map_err(|error| format!("Cannot write autostart file: {error}"))?;
        Ok(AutostartStatus {
            enabled: true,
            supported: true,
            command: Some(exec),
        })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::fs;

    fn plist_path() -> Result<PathBuf, String> {
        let home = dirs::home_dir()
            .ok_or_else(|| "Cannot resolve home directory for LaunchAgent".to_string())?;
        Ok(home
            .join("Library")
            .join("LaunchAgents")
            .join("ai.easyagent.kiki.plist"))
    }

    pub fn get_status() -> Result<AutostartStatus, String> {
        let path = plist_path()?;
        if path.is_file() {
            Ok(AutostartStatus {
                enabled: true,
                supported: true,
                command: Some(path.display().to_string()),
            })
        } else {
            Ok(AutostartStatus {
                enabled: false,
                supported: true,
                command: None,
            })
        }
    }

    pub fn set_enabled(enabled: bool) -> Result<AutostartStatus, String> {
        let path = plist_path()?;
        if !enabled {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Cannot remove LaunchAgent: {error}")),
            }
            return Ok(AutostartStatus {
                enabled: false,
                supported: true,
                command: None,
            });
        }
        let exe = resolve_autostart_executable()?;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| "Kiki executable path is not valid Unicode".to_string())?;
        let xml_exe = exe_str
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>ai.easyagent.kiki</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{xml_exe}</string>\n    <string>{AUTOSTART_FLAG}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>\n"
        );
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&path, body).map_err(|error| format!("Cannot write LaunchAgent: {error}"))?;
        Ok(AutostartStatus {
            enabled: true,
            supported: true,
            command: Some(path.display().to_string()),
        })
    }
}

pub fn get_autostart_status() -> Result<AutostartStatus, String> {
    platform::get_status()
}

pub fn set_autostart_enabled(enabled: bool) -> Result<AutostartStatus, String> {
    platform::set_enabled(enabled)
}

/// If OS autostart is already enabled and points to a stale promoted release path
/// (or lacks `--autostart`), refresh it to the current stable executable.
/// Never enables autostart when disabled.
pub fn refresh_autostart_if_enabled() {
    let Ok(status) = get_autostart_status() else {
        return;
    };
    if !status.enabled {
        return;
    }
    let Ok(expected_exe) = resolve_autostart_executable() else {
        return;
    };
    #[cfg(windows)]
    {
        let Ok(expected_cmd) = format_windows_run_command(&expected_exe) else {
            return;
        };
        if status.command.as_deref() == Some(expected_cmd.as_str()) {
            return;
        }
        // Only auto-refresh when the existing command already points to a kiki-desktop binary.
        let is_kiki_exe = status
            .command
            .as_deref()
            .and_then(parse_run_command_executable)
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
            .is_some_and(|name| name == "kiki-desktop.exe");
        if is_kiki_exe {
            let _ = set_autostart_enabled(true);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = expected_exe;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_windows_run_commands_safely() {
        let path = PathBuf::from(r"C:\Users\Alice\AppData\Local\EasyAgent\Kiki\active\kiki-desktop.exe");
        let cmd = format_windows_run_command(&path).expect("valid absolute path");
        assert_eq!(
            cmd,
            r#""C:\Users\Alice\AppData\Local\EasyAgent\Kiki\active\kiki-desktop.exe" --autostart"#
        );
        assert_eq!(parse_run_command_executable(&cmd), Some(path));
        assert!(format_windows_run_command(Path::new("relative/kiki-desktop.exe")).is_err());
        assert!(format_windows_run_command(Path::new("C:\\bad\"path\\kiki-desktop.exe")).is_err());
    }

    #[test]
    fn resolves_active_binary_over_versioned_release_dir_when_present() {
        let root = std::env::temp_dir().join(format!(
            "kiki-autostart-resolve-{}-{}",
            std::process::id(),
            crate::unix_epoch_millis().unwrap_or(0)
        ));
        let release_id = "111111111111111111111111-222222222222222222222222";
        let rel_dir = root.join("releases").join(release_id);
        let active_dir = root.join("active");
        std::fs::create_dir_all(&rel_dir).unwrap();
        std::fs::create_dir_all(&active_dir).unwrap();
        let exe_name = if cfg!(windows) { "kiki-desktop.exe" } else { "kiki-desktop" };
        let rel_exe = rel_dir.join(exe_name);
        let active_exe = active_dir.join(exe_name);
        std::fs::write(&rel_exe, b"rel").unwrap();
        std::fs::write(&active_exe, b"active").unwrap();

        let resolved = resolve_autostart_executable_for(&rel_exe);
        assert_eq!(resolved, active_exe);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_registry_roundtrip_uses_isolated_test_key() {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};

        let subkey = format!(
            r"Software\EasyAgent\KikiAutostartTest_{}_{}",
            std::process::id(),
            crate::unix_epoch_millis().unwrap_or(0)
        );
        struct KeyCleanup(String);
        impl Drop for KeyCleanup {
            fn drop(&mut self) {
                let wide: Vec<u16> = OsStr::new(&self.0)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                unsafe {
                    let _ = RegDeleteKeyW(HKEY_CURRENT_USER, wide.as_ptr());
                }
            }
        }
        let _cleanup = KeyCleanup(subkey.clone());

        assert_eq!(platform::read_run_value(&subkey, "Kiki").unwrap(), None);
        let cmd = r#""C:\Users\Test\Kiki\active\kiki-desktop.exe" --autostart"#;
        platform::write_run_value(&subkey, "Kiki", cmd).unwrap();
        assert_eq!(
            platform::read_run_value(&subkey, "Kiki").unwrap().as_deref(),
            Some(cmd)
        );
        platform::delete_run_value(&subkey, "Kiki").unwrap();
        assert_eq!(platform::read_run_value(&subkey, "Kiki").unwrap(), None);
    }
}
