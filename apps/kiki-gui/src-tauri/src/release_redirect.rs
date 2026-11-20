use std::{
    env,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

use serde::Deserialize;

pub const NO_RELEASE_REDIRECT_ENV: &str = "KIKI_NO_RELEASE_REDIRECT";
pub const NO_RELEASE_REDIRECT_FLAG: &str = "--no-release-redirect";

#[cfg(windows)]
const DESKTOP_EXE_NAME: &str = "kiki-desktop.exe";
#[cfg(not(windows))]
const DESKTOP_EXE_NAME: &str = "kiki-desktop";

#[cfg(windows)]
const SERVER_EXE_NAME: &str = "kiki-server.exe";
#[cfg(not(windows))]
const SERVER_EXE_NAME: &str = "kiki-server";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentReleaseManifest {
    schema_version: u64,
    release_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReleaseLayout {
    runtime_root: PathBuf,
    release_id: String,
    release_dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PromotedRelease {
    release_id: String,
    release_dir: PathBuf,
    desktop_exe: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RedirectPlan {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub working_dir: Option<PathBuf>,
}

/// If the current executable lives inside `<RuntimeRoot>/releases/<oldId>/kiki-desktop(.exe)`
/// and `<RuntimeRoot>/current.json` points to a different, valid release, spawn the promoted
/// executable with the exact original arguments and exit this process immediately.
///
/// Must run at the very beginning of `run()`, before single-instance locking, window creation,
/// or sidecar startup.
pub fn maybe_redirect_to_current_release() {
    let Ok(current_exe) = env::current_exe() else {
        return;
    };
    let current_dir = env::current_dir().ok();
    let args: Vec<OsString> = env::args_os().collect();
    let no_redirect_env = env::var_os(NO_RELEASE_REDIRECT_ENV);
    let Some(plan) = resolve_redirect(
        &current_exe,
        current_dir.as_deref(),
        &args,
        no_redirect_env.as_deref(),
    ) else {
        return;
    };
    match build_redirect_command(&plan).spawn() {
        Ok(_child) => std::process::exit(0),
        Err(error) => {
            eprintln!(
                "Kiki could not redirect to promoted release {}: {error}",
                plan.executable.display()
            );
        }
    }
}

/// Resolve the executable path to use when launching sibling windows or creating shortcuts.
/// When the running binary resides under `<RuntimeRoot>/releases/<id>/` and `<RuntimeRoot>/current.json`
/// points to an existing, non-empty promoted release, returns that promoted executable; otherwise
/// falls back to the normalized `current_exe()`.
pub fn resolve_launch_executable() -> io::Result<PathBuf> {
    let current = env::current_exe()?;
    Ok(resolve_launch_executable_for(&current))
}

/// Prepare a child `kiki-desktop` `Command` spawned by an already-running desktop window
/// (such as `open_space` or `open_mode_window`):
/// - removes any inherited `KIKI_NO_RELEASE_REDIRECT` loop-breaker env var, and
/// - updates `current_dir` to the target release directory if the parent's `cwd` was its own
///   old release directory.
pub fn prepare_child_command(command: &mut Command, target_exe: &Path) {
    let current_exe = env::current_exe().ok();
    let current_dir = env::current_dir().ok();
    prepare_child_command_with(
        command,
        current_exe.as_deref(),
        current_dir.as_deref(),
        target_exe,
    );
}

pub(crate) fn prepare_child_command_with(
    command: &mut Command,
    current_exe: Option<&Path>,
    current_dir: Option<&Path>,
    target_exe: &Path,
) {
    command.env_remove(NO_RELEASE_REDIRECT_ENV);
    let (Some(current_exe), Some(current_dir)) = (current_exe, current_dir) else {
        return;
    };
    if let Some(dir) = child_working_dir(current_exe, current_dir, target_exe) {
        command.current_dir(dir);
    }
}

pub(crate) fn resolve_launch_executable_for(current_exe: &Path) -> PathBuf {
    let normalized = strip_windows_verbatim_prefix(current_exe);
    let Some(layout) = parse_release_layout(&normalized) else {
        return normalized;
    };
    let Some(target) = resolve_promoted_release(&layout) else {
        return normalized;
    };
    target.desktop_exe
}

pub(crate) fn resolve_redirect(
    current_exe: &Path,
    current_dir: Option<&Path>,
    args: &[OsString],
    no_redirect_env: Option<&OsStr>,
) -> Option<RedirectPlan> {
    if env_disables_redirect(no_redirect_env) || args_disable_redirect(args) {
        return None;
    }
    let normalized_exe = strip_windows_verbatim_prefix(current_exe);
    let layout = parse_release_layout(&normalized_exe)?;
    let target = resolve_promoted_release(&layout)?;
    if target.release_id == layout.release_id {
        return None;
    }
    let working_dir = current_dir.and_then(|cwd| {
        if paths_equal(cwd, &layout.release_dir) {
            Some(target.release_dir.clone())
        } else {
            None
        }
    });
    Some(RedirectPlan {
        executable: target.desktop_exe,
        args: args.iter().skip(1).cloned().collect(),
        working_dir,
    })
}

pub(crate) fn build_redirect_command(plan: &RedirectPlan) -> Command {
    let mut command = Command::new(&plan.executable);
    command.args(&plan.args);
    if let Some(dir) = &plan.working_dir {
        command.current_dir(dir);
    }
    command.env(NO_RELEASE_REDIRECT_ENV, "1");
    command
}

pub(crate) fn child_working_dir(
    current_exe: &Path,
    current_dir: &Path,
    target_exe: &Path,
) -> Option<PathBuf> {
    let normalized_current = strip_windows_verbatim_prefix(current_exe);
    let layout = parse_release_layout(&normalized_current)?;
    if !paths_equal(current_dir, &layout.release_dir) {
        return None;
    }
    let normalized_target = strip_windows_verbatim_prefix(target_exe);
    let target_dir = normalized_target.parent()?;
    if paths_equal(target_dir, &layout.release_dir) {
        return None;
    }
    Some(target_dir.to_path_buf())
}

pub(crate) fn is_valid_release_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 49
        && bytes[24] == b'-'
        && bytes[..24]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        && bytes[25..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

pub(crate) fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        if units.len() >= 4
            && units[0] == b'\\' as u16
            && units[1] == b'\\' as u16
            && units[2] == b'?' as u16
            && units[3] == b'\\' as u16
        {
            let rest = &units[4..];
            if rest.len() >= 4
                && (rest[0] == b'U' as u16 || rest[0] == b'u' as u16)
                && (rest[1] == b'N' as u16 || rest[1] == b'n' as u16)
                && (rest[2] == b'C' as u16 || rest[2] == b'c' as u16)
                && rest[3] == b'\\' as u16
            {
                let mut unc = Vec::with_capacity(2 + rest.len() - 4);
                unc.push(b'\\' as u16);
                unc.push(b'\\' as u16);
                unc.extend_from_slice(&rest[4..]);
                return PathBuf::from(OsString::from_wide(&unc));
            }
            if rest.len() >= 2
                && rest[0] <= 0x7f
                && (rest[0] as u8).is_ascii_alphabetic()
                && rest[1] == b':' as u16
            {
                return PathBuf::from(OsString::from_wide(rest));
            }
        }
        path.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        if let Some(text) = path.to_str() {
            if let Some(rest) = text.strip_prefix(r"\\?\") {
                if rest.len() >= 4
                    && rest[..3].eq_ignore_ascii_case("UNC")
                    && rest.as_bytes()[3] == b'\\'
                {
                    return PathBuf::from(format!(r"\\{}", &rest[4..]));
                }
                let bytes = rest.as_bytes();
                if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                    return PathBuf::from(rest);
                }
            }
        }
        path.to_path_buf()
    }
}

fn env_disables_redirect(value: Option<&OsStr>) -> bool {
    let Some(raw) = value.and_then(OsStr::to_str) else {
        return false;
    };
    let trimmed = raw.trim();
    trimmed == "1" || trimmed.eq_ignore_ascii_case("true")
}

fn args_disable_redirect(args: &[OsString]) -> bool {
    let mut index = 1;
    while index < args.len() {
        let Some(arg) = args[index].to_str() else {
            index += 1;
            continue;
        };
        match arg {
            "--" => break,
            "--home" | "--preset" | "--remote-connection" => {
                index += 2;
                continue;
            }
            NO_RELEASE_REDIRECT_FLAG => return true,
            _ => {}
        }
        index += 1;
    }
    false
}

fn parse_release_layout(normalized_exe: &Path) -> Option<ReleaseLayout> {
    let file_name = normalized_exe.file_name()?.to_str()?;
    if !names_match(file_name, DESKTOP_EXE_NAME) {
        return None;
    }
    let release_dir = normalized_exe.parent()?;
    let release_id = release_dir.file_name()?.to_str()?;
    if !is_valid_release_id(release_id) {
        return None;
    }
    let releases_dir = release_dir.parent()?;
    let releases_name = releases_dir.file_name()?.to_str()?;
    if !names_match(releases_name, "releases") {
        return None;
    }
    let runtime_root = releases_dir.parent()?;
    if runtime_root.as_os_str().is_empty() {
        return None;
    }
    Some(ReleaseLayout {
        runtime_root: runtime_root.to_path_buf(),
        release_id: release_id.to_string(),
        release_dir: release_dir.to_path_buf(),
    })
}

fn resolve_promoted_release(layout: &ReleaseLayout) -> Option<PromotedRelease> {
    let manifest_path = layout.runtime_root.join("current.json");
    let raw = fs::read_to_string(&manifest_path).ok()?;
    let manifest: CurrentReleaseManifest =
        serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    if manifest.schema_version != 1 || !is_valid_release_id(&manifest.release_id) {
        return None;
    }
    let release_dir = layout
        .runtime_root
        .join("releases")
        .join(&manifest.release_id);
    let desktop_exe = release_dir.join(DESKTOP_EXE_NAME);
    let server_exe = release_dir.join(SERVER_EXE_NAME);
    if !is_non_empty_file(&desktop_exe) || !is_non_empty_file(&server_exe) {
        return None;
    }
    Some(PromotedRelease {
        release_id: manifest.release_id,
        release_dir,
        desktop_exe,
    })
}

fn is_non_empty_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

fn names_match(actual: &str, expected: &str) -> bool {
    if cfg!(windows) {
        actual.eq_ignore_ascii_case(expected)
    } else {
        actual == expected
    }
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    canonical_comparison_key(left) == canonical_comparison_key(right)
}

fn canonical_comparison_key(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let stripped = strip_windows_verbatim_prefix(&resolved);
    let mut text = stripped.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        text = text.replace('/', "\\").to_lowercase();
        while text.len() > 3 && text.ends_with('\\') {
            text.pop();
        }
    }
    #[cfg(not(windows))]
    {
        while text.len() > 1 && text.ends_with('/') {
            text.pop();
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const OLD_RELEASE_ID: &str = "111111111111111111111111-222222222222222222222222";
    const NEW_RELEASE_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb";
    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TempRuntime {
        root: PathBuf,
    }

    impl TempRuntime {
        fn new() -> Self {
            let seq = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let root = env::temp_dir().join(format!(
                "kiki-release-redirect-test-{}-{}-{}",
                std::process::id(),
                crate::unix_epoch_millis().unwrap_or(0),
                seq
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn create_release(&self, release_id: &str, desktop_bytes: &[u8], server_bytes: &[u8]) -> PathBuf {
            let dir = self.root.join("releases").join(release_id);
            fs::create_dir_all(&dir).unwrap();
            if !desktop_bytes.is_empty() {
                fs::write(dir.join(DESKTOP_EXE_NAME), desktop_bytes).unwrap();
            }
            if !server_bytes.is_empty() {
                fs::write(dir.join(SERVER_EXE_NAME), server_bytes).unwrap();
            }
            dir
        }

        fn write_current_json(&self, content: &str) {
            fs::write(self.root.join("current.json"), content).unwrap();
        }

        fn write_current_release(&self, release_id: &str) {
            let json = format!(
                r#"{{"schemaVersion":1,"releaseId":"{release_id}","gitSha":"{}"}}"#,
                "a".repeat(40)
            );
            self.write_current_json(&json);
        }
    }

    impl Drop for TempRuntime {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn os_args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn redirects_old_release_rewrites_old_cwd_forwards_args_and_sets_loop_guard() {
        let rt = TempRuntime::new();
        let old_dir = rt.create_release(OLD_RELEASE_ID, b"old-gui", b"old-srv");
        let new_dir = rt.create_release(NEW_RELEASE_ID, b"new-gui", b"new-srv");
        rt.write_current_release(NEW_RELEASE_ID);

        let old_exe = old_dir.join(DESKTOP_EXE_NAME);
        let args = os_args(&[
            "kiki-desktop.exe",
            "--home",
            r"C:\Users\alice\Space One",
            "--preset",
            "work",
            "--background",
        ]);
        let plan = resolve_redirect(&old_exe, Some(&old_dir), &args, None)
            .expect("expected redirect plan from old release to new release");

        assert_eq!(plan.executable, new_dir.join(DESKTOP_EXE_NAME));
        assert_eq!(plan.working_dir, Some(new_dir.clone()));
        assert_eq!(
            plan.args,
            os_args(&[
                "--home",
                r"C:\Users\alice\Space One",
                "--preset",
                "work",
                "--background",
            ])
        );

        let cmd = build_redirect_command(&plan);
        assert_eq!(cmd.get_program(), new_dir.join(DESKTOP_EXE_NAME).as_os_str());
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("--home"),
                OsStr::new(r"C:\Users\alice\Space One"),
                OsStr::new("--preset"),
                OsStr::new("work"),
                OsStr::new("--background"),
            ]
        );
        assert_eq!(cmd.get_current_dir(), Some(new_dir.as_path()));
        assert_eq!(
            cmd.get_envs().collect::<Vec<_>>(),
            vec![(OsStr::new(NO_RELEASE_REDIRECT_ENV), Some(OsStr::new("1")))]
        );
    }

    #[test]
    fn preserves_custom_workspace_cwd_when_different_from_old_release_dir() {
        let rt = TempRuntime::new();
        let old_dir = rt.create_release(OLD_RELEASE_ID, b"old-gui", b"old-srv");
        let new_dir = rt.create_release(NEW_RELEASE_ID, b"new-gui", b"new-srv");
        rt.write_current_release(NEW_RELEASE_ID);

        let custom_cwd = rt.root.join("custom-workspace");
        fs::create_dir_all(&custom_cwd).unwrap();

        let old_exe = old_dir.join(DESKTOP_EXE_NAME);
        let args = os_args(&["kiki-desktop.exe", "--background"]);
        let plan = resolve_redirect(&old_exe, Some(&custom_cwd), &args, None)
            .expect("expected redirect plan");

        assert_eq!(plan.executable, new_dir.join(DESKTOP_EXE_NAME));
        assert_eq!(plan.working_dir, None);
        let cmd = build_redirect_command(&plan);
        assert_eq!(cmd.get_current_dir(), None);
    }

    #[test]
    fn skips_when_already_on_current_release_or_guarded_by_env_or_flag() {
        let rt = TempRuntime::new();
        let old_dir = rt.create_release(OLD_RELEASE_ID, b"old-gui", b"old-srv");
        let new_dir = rt.create_release(NEW_RELEASE_ID, b"new-gui", b"new-srv");
        rt.write_current_release(NEW_RELEASE_ID);

        // Already on current release.
        let new_exe = new_dir.join(DESKTOP_EXE_NAME);
        assert!(resolve_redirect(&new_exe, Some(&new_dir), &os_args(&["kiki-desktop.exe"]), None).is_none());

        // Loop-breaker env set to 1 or true skips redirect; 0 does not skip.
        let old_exe = old_dir.join(DESKTOP_EXE_NAME);
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &os_args(&["kiki-desktop.exe"]), Some(OsStr::new("1"))).is_none());
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &os_args(&["kiki-desktop.exe"]), Some(OsStr::new("true"))).is_none());
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &os_args(&["kiki-desktop.exe"]), Some(OsStr::new("0"))).is_some());

        // Explicit CLI flag skips redirect, unless after `--`.
        assert!(resolve_redirect(
            &old_exe,
            Some(&old_dir),
            &os_args(&["kiki-desktop.exe", "--home", r"C:\space", "--no-release-redirect"]),
            None,
        )
        .is_none());
        assert!(resolve_redirect(
            &old_exe,
            Some(&old_dir),
            &os_args(&["kiki-desktop.exe", "--", "--no-release-redirect"]),
            None,
        )
        .is_some());
    }

    #[test]
    fn skips_safely_when_target_binaries_or_manifest_are_missing_empty_or_invalid() {
        let rt = TempRuntime::new();
        let old_dir = rt.create_release(OLD_RELEASE_ID, b"old-gui", b"old-srv");
        let old_exe = old_dir.join(DESKTOP_EXE_NAME);
        let args = os_args(&["kiki-desktop.exe"]);

        // Missing current.json.
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_none());

        // Target directory missing.
        rt.write_current_release(NEW_RELEASE_ID);
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_none());

        // Target missing kiki-server.
        let new_dir = rt.create_release(NEW_RELEASE_ID, b"new-gui", b"");
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_none());

        // Target has empty 0-byte kiki-server.
        fs::write(new_dir.join(SERVER_EXE_NAME), b"").unwrap();
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_none());

        // Target has empty 0-byte kiki-desktop.
        fs::write(new_dir.join(SERVER_EXE_NAME), b"new-srv").unwrap();
        fs::write(new_dir.join(DESKTOP_EXE_NAME), b"").unwrap();
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_none());

        // Restore valid target, then test bad schemaVersion and invalid releaseId.
        fs::write(new_dir.join(DESKTOP_EXE_NAME), b"new-gui").unwrap();
        rt.write_current_json(&format!(r#"{{"schemaVersion":2,"releaseId":"{NEW_RELEASE_ID}"}}"#));
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_none());

        rt.write_current_json(r#"{"schemaVersion":1,"releaseId":"../escape"}"#);
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_none());

        // Valid manifest with UTF-8 BOM works cleanly.
        rt.write_current_json(&format!(
            "\u{feff}{{\"schemaVersion\":1,\"releaseId\":\"{NEW_RELEASE_ID}\"}}"
        ));
        assert!(resolve_redirect(&old_exe, Some(&old_dir), &args, None).is_some());
    }

    #[test]
    fn skips_when_running_outside_releases_layout() {
        let rt = TempRuntime::new();
        let dev_dir = rt.root.join("target").join("debug");
        fs::create_dir_all(&dev_dir).unwrap();
        let dev_exe = dev_dir.join(DESKTOP_EXE_NAME);
        fs::write(&dev_exe, b"dev-gui").unwrap();
        rt.create_release(NEW_RELEASE_ID, b"new-gui", b"new-srv");
        rt.write_current_release(NEW_RELEASE_ID);

        assert!(resolve_redirect(&dev_exe, Some(&dev_dir), &os_args(&["kiki-desktop.exe"]), None).is_none());
        assert_eq!(resolve_launch_executable_for(&dev_exe), dev_exe);

        // Non-release directory name under releases/ is also ignored.
        let invalid_dir = rt.root.join("releases").join("not-a-valid-release-id");
        fs::create_dir_all(&invalid_dir).unwrap();
        let invalid_exe = invalid_dir.join(DESKTOP_EXE_NAME);
        fs::write(&invalid_exe, b"other-gui").unwrap();
        assert!(resolve_redirect(&invalid_exe, Some(&invalid_dir), &os_args(&["kiki-desktop.exe"]), None).is_none());
    }

    #[test]
    fn normalizes_windows_verbatim_prefixes_identically() {
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\C:\Users\alice\Kiki\kiki-desktop.exe")),
            PathBuf::from(r"C:\Users\alice\Kiki\kiki-desktop.exe")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\UNC\fileserver\share\Kiki\kiki-desktop.exe")),
            PathBuf::from(r"\\fileserver\share\Kiki\kiki-desktop.exe")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\Volume{12345678-1234-1234-1234-1234567890ab}\kiki-desktop.exe")),
            PathBuf::from(r"\\?\Volume{12345678-1234-1234-1234-1234567890ab}\kiki-desktop.exe")
        );

        let rt = TempRuntime::new();
        let old_dir = rt.create_release(OLD_RELEASE_ID, b"old-gui", b"old-srv");
        let new_dir = rt.create_release(NEW_RELEASE_ID, b"new-gui", b"new-srv");
        rt.write_current_release(NEW_RELEASE_ID);

        let old_exe = old_dir.join(DESKTOP_EXE_NAME);
        let verbatim_exe = if cfg!(windows) {
            PathBuf::from(format!(r"\\?\{}", strip_windows_verbatim_prefix(&old_exe).display()))
        } else {
            old_exe.clone()
        };
        let verbatim_cwd = if cfg!(windows) {
            PathBuf::from(format!(r"\\?\{}", strip_windows_verbatim_prefix(&old_dir).display()))
        } else {
            old_dir.clone()
        };

        let plan = resolve_redirect(
            &verbatim_exe,
            Some(&verbatim_cwd),
            &os_args(&["kiki-desktop.exe", "--home", r"C:\space"]),
            None,
        )
        .expect("verbatim exe path should resolve redirect identically");

        assert_eq!(plan.executable, strip_windows_verbatim_prefix(&new_dir.join(DESKTOP_EXE_NAME)));
        assert_eq!(plan.working_dir, Some(strip_windows_verbatim_prefix(&new_dir)));
        assert_eq!(
            resolve_launch_executable_for(&verbatim_exe),
            strip_windows_verbatim_prefix(&new_dir.join(DESKTOP_EXE_NAME))
        );
    }

    #[test]
    fn resolve_launch_executable_and_child_working_dir_follow_promoted_release() {
        let rt = TempRuntime::new();
        let old_dir = rt.create_release(OLD_RELEASE_ID, b"old-gui", b"old-srv");
        let new_dir = rt.create_release(NEW_RELEASE_ID, b"new-gui", b"new-srv");
        let old_exe = old_dir.join(DESKTOP_EXE_NAME);
        let new_exe = new_dir.join(DESKTOP_EXE_NAME);

        // Before current.json exists, falls back to current_exe.
        assert_eq!(resolve_launch_executable_for(&old_exe), strip_windows_verbatim_prefix(&old_exe));

        // After current.json points to new release, resolves directly to new exe.
        rt.write_current_release(NEW_RELEASE_ID);
        assert_eq!(resolve_launch_executable_for(&old_exe), strip_windows_verbatim_prefix(&new_exe));

        // child_working_dir rewrites old release cwd -> new release dir, preserves custom cwd.
        assert_eq!(
            child_working_dir(&old_exe, &old_dir, &new_exe),
            Some(strip_windows_verbatim_prefix(&new_dir))
        );
        let custom_cwd = rt.root.join("project");
        fs::create_dir_all(&custom_cwd).unwrap();
        assert_eq!(child_working_dir(&old_exe, &custom_cwd, &new_exe), None);
        assert_eq!(child_working_dir(&old_exe, &old_dir, &old_exe), None);

        // prepare_child_command_with strips loop-guard env and updates cwd from old -> new.
        let mut cmd = Command::new(&new_exe);
        prepare_child_command_with(&mut cmd, Some(&old_exe), Some(&old_dir), &new_exe);
        assert_eq!(
            cmd.get_envs().collect::<Vec<_>>(),
            vec![(OsStr::new(NO_RELEASE_REDIRECT_ENV), None)]
        );
        assert_eq!(cmd.get_current_dir(), Some(strip_windows_verbatim_prefix(&new_dir).as_path()));

        let mut custom_cmd = Command::new(&new_exe);
        prepare_child_command_with(&mut custom_cmd, Some(&old_exe), Some(&custom_cwd), &new_exe);
        assert_eq!(custom_cmd.get_current_dir(), None);
    }

    #[test]
    fn spawns_redirected_child_with_loop_guard_and_rewritten_or_preserved_cwd() {
        let rt = TempRuntime::new();
        let old_dir = rt.create_release(OLD_RELEASE_ID, b"old-gui", b"old-srv");
        let new_dir = rt.root.join("releases").join(NEW_RELEASE_ID);
        fs::create_dir_all(&new_dir).unwrap();
        let new_exe = new_dir.join(DESKTOP_EXE_NAME);
        let test_bin = env::current_exe().unwrap();
        if fs::hard_link(&test_bin, &new_exe).is_err() {
            fs::copy(&test_bin, &new_exe).unwrap();
        }
        fs::write(new_dir.join(SERVER_EXE_NAME), b"new-srv").unwrap();
        rt.write_current_release(NEW_RELEASE_ID);

        let old_exe = old_dir.join(DESKTOP_EXE_NAME);
        let probe_args = os_args(&[
            "kiki-desktop.exe",
            "--ignored",
            "--exact",
            "release_redirect::tests::redirect_child_probe",
        ]);

        // Case 1: cwd == old release dir -> child runs with cwd == new release dir and KIKI_NO_RELEASE_REDIRECT=1.
        let out_rewritten = rt.root.join("probe-rewritten.json");
        let plan = resolve_redirect(&old_exe, Some(&old_dir), &probe_args, None).unwrap();
        let mut cmd = build_redirect_command(&plan);
        cmd.env("KIKI_REDIRECT_PROBE_OUT", &out_rewritten)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let status = cmd.status().unwrap();
        assert!(status.success(), "redirected probe failed with {status}");
        let report: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&out_rewritten).unwrap()).unwrap();
        assert_eq!(report["noRedirectEnv"].as_str(), Some("1"));
        assert!(paths_equal(Path::new(report["cwd"].as_str().unwrap()), &new_dir));
        assert!(paths_equal(Path::new(report["exe"].as_str().unwrap()), &new_exe));

        // Case 2: cwd == custom workspace -> plan leaves working_dir None so child inherits custom cwd unchanged.
        let custom_cwd = rt.root.join("custom-workspace");
        fs::create_dir_all(&custom_cwd).unwrap();
        let out_preserved = rt.root.join("probe-preserved.json");
        let plan_custom = resolve_redirect(&old_exe, Some(&custom_cwd), &probe_args, None).unwrap();
        assert_eq!(plan_custom.working_dir, None);
        let mut cmd_custom = build_redirect_command(&plan_custom);
        assert_eq!(cmd_custom.get_current_dir(), None);
        cmd_custom
            .current_dir(&custom_cwd)
            .env("KIKI_REDIRECT_PROBE_OUT", &out_preserved)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let status_custom = cmd_custom.status().unwrap();
        assert!(status_custom.success(), "custom cwd probe failed with {status_custom}");
        let report_custom: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&out_preserved).unwrap()).unwrap();
        assert_eq!(report_custom["noRedirectEnv"].as_str(), Some("1"));
        assert!(paths_equal(
            Path::new(report_custom["cwd"].as_str().unwrap()),
            &custom_cwd
        ));
    }

    #[test]
    #[ignore]
    fn redirect_child_probe() {
        let Some(out_path) = env::var_os("KIKI_REDIRECT_PROBE_OUT") else {
            return;
        };
        let payload = serde_json::json!({
            "cwd": strip_windows_verbatim_prefix(&env::current_dir().unwrap()).to_string_lossy(),
            "exe": strip_windows_verbatim_prefix(&env::current_exe().unwrap()).to_string_lossy(),
            "noRedirectEnv": env::var(NO_RELEASE_REDIRECT_ENV).ok(),
        });
        fs::write(out_path, payload.to_string()).unwrap();
    }

    #[test]
    fn validates_release_id_format_strictly() {
        assert!(is_valid_release_id(OLD_RELEASE_ID));
        assert!(is_valid_release_id(NEW_RELEASE_ID));
        assert!(!is_valid_release_id("11111111111111111111111-222222222222222222222222"));
        assert!(!is_valid_release_id("111111111111111111111111_222222222222222222222222"));
        assert!(!is_valid_release_id("AAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBB"));
        assert!(!is_valid_release_id("11111111111111111111111g-222222222222222222222222"));
    }
}
