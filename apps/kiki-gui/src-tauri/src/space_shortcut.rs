use std::path::{Path, PathBuf};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutFailure {
    pub code: &'static str,
    pub message: String,
}

impl ShortcutFailure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceShortcut {
    pub home_id: String,
    pub path: String,
}

pub fn preset_metadata(id: &str) -> Result<toml::Value, String> {
    let text = include_str!("../../../../packages/agent-core-v2/src/app/bootstrap/presets/catalog.toml");
    let catalog: toml::Value = toml::from_str(text).map_err(|error| format!("Invalid bundled space presets: {error}"))?;
    let presets = catalog.get("presets").and_then(toml::Value::as_array).ok_or("Bundled presets are missing")?;
    let baseline = presets.iter().find(|preset| preset.get("id").and_then(toml::Value::as_str) == Some("kiki"));
    presets.iter().find(|preset| preset.get("id").and_then(toml::Value::as_str) == Some(id))
        .or(baseline).cloned().ok_or_else(|| "Bundled Kiki baseline preset is missing".to_string())
}

fn shortcut_name(name: &str, id: &str) -> String {
    let sanitized: String = name.chars().map(|ch| {
        if ch.is_control() || "<>:\"/\\|?*".contains(ch) { '_' } else { ch }
    }).take(60).collect();
    let sanitized = sanitized.trim().trim_end_matches(['.', ' ']);
    format!("Kiki - {} ({id}).lnk", if sanitized.is_empty() { "Space" } else { sanitized })
}

fn home_arguments(home: &Path) -> Result<String, ShortcutFailure> {
    let text = home.to_str().ok_or_else(|| ShortcutFailure::new("invalid_space", "Space path is not Unicode"))?;
    if !home.is_absolute() || text.contains('"') || text.chars().any(char::is_control) {
        return Err(ShortcutFailure::new("invalid_space", "Space path is not a valid absolute directory"));
    }
    let trailing = text.chars().rev().take_while(|ch| *ch == '\\').count();
    Ok(format!("--home \"{text}{}\"", "\\".repeat(trailing)))
}

#[cfg(windows)]
fn write_shortcut(path: &Path, exe: &Path, arguments: &str, name: &str) -> Result<(), ShortcutFailure> {
    use std::os::windows::process::CommandExt;
    let script = r#"$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $env:KIKI_SHORTCUT_PATH) { throw 'Shortcut already exists' }
$temporary = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($env:KIKI_SHORTCUT_PATH), ([System.Guid]::NewGuid().ToString() + '.lnk'))
try {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($temporary)
  $link.TargetPath = $env:KIKI_SHORTCUT_EXE
  $link.Arguments = $env:KIKI_SHORTCUT_ARGS
  $link.WorkingDirectory = [System.IO.Path]::GetDirectoryName($env:KIKI_SHORTCUT_EXE)
  $link.IconLocation = $env:KIKI_SHORTCUT_EXE + ',0'
  $link.Description = $env:KIKI_SHORTCUT_NAME
  $link.Save()
  [System.IO.File]::Move($temporary, $env:KIKI_SHORTCUT_PATH)
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
"#;
    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| ShortcutFailure::new("shortcut_failed", "SystemRoot is unavailable"))?;
    let powershell = PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = std::process::Command::new(powershell)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
        .env("KIKI_SHORTCUT_PATH", path).env("KIKI_SHORTCUT_EXE", exe)
        .env("KIKI_SHORTCUT_ARGS", arguments).env("KIKI_SHORTCUT_NAME", name)
        .creation_flags(0x08000000).output()
        .map_err(|error| ShortcutFailure::new("shortcut_failed", format!("Cannot start Windows shortcut service: {error}")))?;
    if !output.status.success() {
        if path.exists() { return Err(ShortcutFailure::new("shortcut_exists", "A shortcut for this space already exists")); }
        return Err(ShortcutFailure::new("shortcut_failed", format!("Windows could not create the shortcut: {}", String::from_utf8_lossy(&output.stderr).trim())));
    }
    if !path.is_file() { return Err(ShortcutFailure::new("shortcut_failed", "Windows did not save the shortcut")); }
    Ok(())
}

pub fn create(home_id: &str, name: &str, home: &Path) -> Result<SpaceShortcut, ShortcutFailure> {
    #[cfg(not(windows))]
    {
        let _ = (home_id, name, home);
        Err(ShortcutFailure::new("unsupported_platform", "Desktop space shortcuts are currently supported only on Windows"))
    }
    #[cfg(windows)]
    {
        let desktop = dirs::desktop_dir().filter(|path| path.is_dir())
            .ok_or_else(|| ShortcutFailure::new("desktop_unavailable", "Cannot locate the Windows desktop directory"))?;
        let exe = std::env::current_exe().map_err(|error| ShortcutFailure::new("executable_unavailable", error.to_string()))?;
        let path = desktop.join(shortcut_name(name, home_id));
        if path.exists() { return Err(ShortcutFailure::new("shortcut_exists", "A shortcut for this space already exists")); }
        write_shortcut(&path, &exe, &home_arguments(home)?, name)?;
        Ok(SpaceShortcut { home_id: home_id.to_string(), path: path.to_string_lossy().into_owned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_names_and_colors_are_shared_with_backend() {
        assert_eq!(preset_metadata("kiki").unwrap()["name"].as_str(), Some("Kiki"));
        assert!(preset_metadata("kiki").unwrap().get("color").is_none());
        assert_eq!(preset_metadata("future").unwrap()["name"].as_str(), Some("Kiki"));
    }

    #[test]
    fn filenames_cannot_escape_the_desktop() {
        assert_eq!(shortcut_name("../A:Bot?", "h-test"), "Kiki - .._A_Bot_ (h-test).lnk");
        assert_eq!(shortcut_name("  . ", "main"), "Kiki - Space (main).lnk");
    }

    #[test]
    fn launch_arguments_reject_relative_and_embedded_quotes() {
        assert!(home_arguments(Path::new("relative")).is_err());
        #[cfg(windows)]
        {
            assert_eq!(home_arguments(Path::new("C:\\Example Home\\")).unwrap(), "--home \"C:\\Example Home\\\\\"");
            assert!(home_arguments(Path::new("C:\\a\"b")).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn writes_a_real_lnk_and_verifies_its_target_without_touching_desktop() {
        let root = std::env::temp_dir().join(format!("kiki-shortcut-test-{}-{}", std::process::id(), crate::unix_epoch_millis().unwrap()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("Example.lnk");
        let exe = std::env::current_exe().unwrap();
        let home = root.join("Space with ' quote & symbols");
        let args = home_arguments(&home).unwrap();
        write_shortcut(&path, &exe, &args, "Example space").unwrap();
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:KIKI_SHORTCUT_PATH); @{target=$s.TargetPath;arguments=$s.Arguments} | ConvertTo-Json -Compress"])
            .env("KIKI_SHORTCUT_PATH", &path).output().unwrap();
        assert!(output.status.success());
        let values: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(values["target"].as_str().unwrap().to_lowercase(), exe.to_string_lossy().to_lowercase());
        assert_eq!(values["arguments"].as_str(), Some(args.as_str()));
        assert!(write_shortcut(&path, &exe, &args, "Example").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
