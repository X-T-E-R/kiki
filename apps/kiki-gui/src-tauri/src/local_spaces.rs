use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};
#[cfg(not(windows))]
use std::{thread, time::Instant};

use serde::Serialize;

use crate::{
    authenticated_backend_identity, connection_port, http_json_body, parse_http_status_line,
    pid_alive, read_desktop_space, read_instance_records, read_token, unix_epoch_millis,
    DesktopConnection, InstanceRecord, StatusLineParse,
};

/// Heartbeat staleness threshold (3x kap-server's 15s heartbeat interval), matching
/// `packages/kap-server/src/instanceRegistry.ts` (`HEARTBEAT_STALE_MS`).
pub const INSTANCE_HEARTBEAT_STALE_MS: u64 = 45_000;

/// Maximum grace between a recorded `started_at` timestamp and the OS process
/// creation time before treating a matching PID as OS PID reuse.
#[cfg(windows)]
const PID_REUSE_GRACE_MS: u64 = 60_000;

/// Token-free metadata describing one local Kiki space on this computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSpaceEntry {
    pub home_id: String,
    pub name: String,
    pub path: String,
    pub is_primary: bool,
    pub registered: bool,
    pub running: bool,
    pub has_window: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub desktop_managed: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProcessSnapshot {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
    pub command_line: String,
    pub env_kiki_home: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveInstanceMatch {
    pub server_id: String,
    pub pid: u32,
    pub port: u16,
    pub started_at: u64,
    pub heartbeat_at: u64,
}

pub(crate) fn canonical_home_key(path: &Path) -> String {
    let stripped = crate::release_redirect::strip_windows_verbatim_prefix(path);
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

pub(crate) fn normalize_home_path(path: &Path) -> PathBuf {
    let stripped = crate::release_redirect::strip_windows_verbatim_prefix(path);
    let mut text = stripped.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        text = text.replace('/', "\\");
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
    PathBuf::from(text)
}

pub(crate) fn short_home_hash(path: &Path) -> String {
    let key = canonical_home_key(path);
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x00000100000001b3);
    }
    format!("{hash:016x}")
}

/// Tokenize a command line preserving quoted substrings (supports both `"` and `'`).
fn split_command_tokens(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut in_token = false;
    let chars = cmd.chars().peekable();
    for ch in chars {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                    in_token = true;
                } else if ch.is_whitespace() {
                    if in_token {
                        tokens.push(std::mem::take(&mut current));
                        in_token = false;
                    }
                } else {
                    current.push(ch);
                    in_token = true;
                }
            }
        }
    }
    if in_token {
        tokens.push(current);
    }
    tokens
}

pub(crate) fn extract_explicit_home(cmd: &str) -> Option<PathBuf> {
    let tokens = split_command_tokens(cmd);
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token.eq_ignore_ascii_case("--home") {
            let value = tokens.get(index + 1)?;
            let candidate = PathBuf::from(value);
            if candidate.is_absolute() {
                return Some(normalize_home_path(&candidate));
            }
            return None;
        }
        if let Some(rest) = token
            .strip_prefix("--home=")
            .or_else(|| token.strip_prefix("--HOME="))
        {
            let candidate = PathBuf::from(rest);
            if candidate.is_absolute() {
                return Some(normalize_home_path(&candidate));
            }
            return None;
        }
        index += 1;
    }
    None
}

/// Infer the Kiki space home directory from child worker arguments such as:
/// - `kiki-server.exe __search-indexer D:\666\KikiSpaces\ctf\search-index-v2\index.sqlite`
/// - `kiki-server.exe __plugin_run_node ... C:\Users\x\.kiki\plugins\managed\foo\entry.mjs`
pub(crate) fn extract_inferred_home_from_server_child(cmd: &str) -> Option<PathBuf> {
    let tokens = split_command_tokens(cmd);
    for (idx, token) in tokens.iter().enumerate() {
        if token == "__search-indexer" {
            if let Some(db_arg) = tokens.get(idx + 1) {
                let db_path = Path::new(db_arg);
                if let Some(index_dir) = db_path.parent() {
                    let dir_name = index_dir
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default();
                    if dir_name.eq_ignore_ascii_case("search-index-v2")
                        || dir_name.eq_ignore_ascii_case("search-index")
                    {
                        if let Some(home) = index_dir.parent() {
                            if home.is_absolute() {
                                return Some(normalize_home_path(home));
                            }
                        }
                    }
                }
            }
        }
        if token == "__plugin_run_node" {
            for arg in tokens.iter().skip(idx + 1) {
                let normalized = arg.replace('\\', "/");
                if let Some(pos) = normalized.to_ascii_lowercase().find("/plugins/") {
                    let prefix = &arg[..pos];
                    let home = Path::new(prefix);
                    if home.is_absolute() {
                        return Some(normalize_home_path(home));
                    }
                }
            }
        }
    }
    None
}

#[cfg(any(windows, test))]
pub(crate) fn parse_kiki_home_from_env_block(wide_env: &[u16]) -> Option<String> {
    let mut start = 0;
    while start < wide_env.len() {
        let mut end = start;
        while end < wide_env.len() && wide_env[end] != 0 {
            end += 1;
        }
        if end == start {
            break;
        }
        let entry = String::from_utf16_lossy(&wide_env[start..end]);
        if let Some((key, value)) = entry.split_once('=') {
            if key.eq_ignore_ascii_case("KIKI_HOME") && !value.trim().is_empty() {
                return Some(value.trim().to_string());
            }
        }
        start = end + 1;
    }
    None
}

pub(crate) fn is_heartbeat_fresh(record: &InstanceRecord, now_ms: u64) -> bool {
    let reference = record.heartbeat_at.max(record.started_at);
    if reference == 0 || now_ms <= reference {
        return true;
    }
    now_ms.saturating_sub(reference) <= INSTANCE_HEARTBEAT_STALE_MS
}

#[cfg(windows)]
pub(crate) fn process_matches_instance_started_at(pid: u32, started_at_ms: u64) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 || started_at_ms == 0 {
        return true;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // Access denied or transient failure: do not falsely claim PID reuse here;
        // `pid_alive` + heartbeat freshness still govern liveness.
        return true;
    }
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        return true;
    }
    let ticks = ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);
    let Some(created_at_ms) = (ticks / 10_000).checked_sub(11_644_473_600_000) else {
        return true;
    };
    created_at_ms <= started_at_ms.saturating_add(PID_REUSE_GRACE_MS)
}

#[cfg(not(windows))]
pub(crate) fn process_matches_instance_started_at(_pid: u32, _started_at_ms: u64) -> bool {
    true
}

/// Checks PID liveness, heartbeat freshness (`<= 45s`), and Windows process creation
/// time to reject crashed/reused-PID stale instance registrations (`sfind-fdde882e`).
pub(crate) fn is_instance_record_live(
    record: &InstanceRecord,
    now_ms: u64,
    is_alive: impl Fn(u32) -> bool,
) -> bool {
    if record.pid == 0 || !is_alive(record.pid) {
        return false;
    }
    if !is_heartbeat_fresh(record, now_ms) {
        return false;
    }
    process_matches_instance_started_at(record.pid, record.started_at)
}

pub(crate) fn find_live_instance_for_home(
    home: &Path,
    now_ms: u64,
    is_alive: impl Fn(u32) -> bool,
) -> Option<LiveInstanceMatch> {
    let records = read_instance_records(home).ok()?;
    let mut best: Option<LiveInstanceMatch> = None;
    for record in records {
        if !is_instance_record_live(&record, now_ms, &is_alive) {
            continue;
        }
        let Some(candidate) = crate::instance_candidate(record) else {
            continue;
        };
        let Some(server_id) = candidate.server_id else {
            continue;
        };
        let replace = match &best {
            None => true,
            Some(current) => {
                (candidate.heartbeat_at, candidate.started_at)
                    > (current.heartbeat_at, current.started_at)
            }
        };
        if replace {
            best = Some(LiveInstanceMatch {
                server_id,
                pid: candidate.pid,
                port: candidate.port,
                started_at: candidate.started_at,
                heartbeat_at: candidate.heartbeat_at,
            });
        }
    }
    best
}

pub(crate) fn runtime_root_from_current_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let normalized = crate::release_redirect::strip_windows_verbatim_prefix(&exe);
    let parent = normalized.parent()?;
    let dir_name = parent.file_name()?.to_str()?;
    if dir_name.eq_ignore_ascii_case("active") {
        return parent.parent().map(Path::to_path_buf);
    }
    let grand = parent.parent()?;
    if grand
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("releases"))
    {
        return grand.parent().map(Path::to_path_buf);
    }
    #[cfg(windows)]
    {
        dirs::data_local_dir().map(|d| d.join("EasyAgent").join("Kiki"))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn read_ledger_space_homes(runtime_root: Option<&Path>) -> Vec<PathBuf> {
    let Some(root) = runtime_root else {
        return Vec::new();
    };
    let mut homes = Vec::new();
    for file_name in ["hot-switch-report.json", "hot-switch.json"] {
        let path = root.join(file_name);
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
        else {
            continue;
        };
        if let Some(spaces) = value.get("spaces").and_then(serde_json::Value::as_array) {
            for entry in spaces {
                if let Some(raw_home) = entry.get("kikiHome").and_then(serde_json::Value::as_str) {
                    let candidate = PathBuf::from(raw_home);
                    if candidate.is_absolute() && candidate.is_dir() {
                        homes.push(normalize_home_path(&candidate));
                    }
                }
            }
        }
    }
    homes
}

#[cfg(windows)]
mod process_probe {
    use super::*;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;
    const PROCESS_COMMAND_LINE_INFORMATION_CLASS: u32 = 60;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004u32 as i32;
    const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023u32 as i32;
    const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005u32 as i32;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process_handle: HANDLE,
            process_information_class: u32,
            process_information: *mut c_void,
            process_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn ReadProcessMemory(
            h_process: HANDLE,
            lp_base_address: *const c_void,
            lp_buffer: *mut c_void,
            n_size: usize,
            lp_number_of_bytes_read: *mut usize,
        ) -> i32;
    }

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn query_command_line(pid: u32) -> Option<String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let _guard = HandleGuard(handle);

        let mut buf = vec![0u8; 4096];
        let mut needed: u32 = 0;
        let mut status = unsafe {
            NtQueryInformationProcess(
                handle,
                PROCESS_COMMAND_LINE_INFORMATION_CLASS,
                buf.as_mut_ptr() as *mut c_void,
                buf.len() as u32,
                &mut needed,
            )
        };
        if (status == STATUS_INFO_LENGTH_MISMATCH
            || status == STATUS_BUFFER_TOO_SMALL
            || status == STATUS_BUFFER_OVERFLOW)
            && needed > 0
            && (needed as usize) <= 64 * 1024
        {
            buf.resize(needed as usize, 0);
            status = unsafe {
                NtQueryInformationProcess(
                    handle,
                    PROCESS_COMMAND_LINE_INFORMATION_CLASS,
                    buf.as_mut_ptr() as *mut c_void,
                    buf.len() as u32,
                    &mut needed,
                )
            };
        }
        if status < 0 || buf.len() < std::mem::size_of::<UnicodeString>() {
            return None;
        }
        let us = unsafe { &*(buf.as_ptr() as *const UnicodeString) };
        if us.buffer.is_null() || us.length == 0 {
            return Some(String::new());
        }
        let buf_start = buf.as_ptr() as usize;
        let buf_end = buf_start.saturating_add(buf.len());
        let str_start = us.buffer as usize;
        let str_bytes = us.length as usize;
        let str_end = str_start.checked_add(str_bytes)?;
        if str_start < buf_start || str_end > buf_end || !str_bytes.is_multiple_of(2) {
            return None;
        }
        let offset = str_start - buf_start;
        let slice_u8 = &buf[offset..offset + str_bytes];
        let units: Vec<u16> = slice_u8
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        Some(String::from_utf16_lossy(&units))
    }

    #[cfg(target_arch = "x86_64")]
    fn query_env_kiki_home(pid: u32) -> Option<String> {
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let _guard = HandleGuard(handle);

        // PROCESS_BASIC_INFORMATION on x64 is 48 bytes (6 usize fields); index 1 is PebBaseAddress.
        let mut pbi = [0usize; 6];
        let mut needed: u32 = 0;
        let status = unsafe {
            NtQueryInformationProcess(
                handle,
                PROCESS_BASIC_INFORMATION_CLASS,
                pbi.as_mut_ptr() as *mut c_void,
                std::mem::size_of_val(&pbi) as u32,
                &mut needed,
            )
        };
        if status < 0 {
            return None;
        }
        let peb_addr = pbi[1];
        if peb_addr == 0 {
            return None;
        }

        let mut proc_params: usize = 0;
        let mut read = 0usize;
        let ok = unsafe {
            ReadProcessMemory(
                handle,
                (peb_addr.checked_add(0x20)?) as *const c_void,
                (&mut proc_params as *mut usize) as *mut c_void,
                std::mem::size_of::<usize>(),
                &mut read,
            )
        };
        if ok == 0 || read != std::mem::size_of::<usize>() || proc_params == 0 {
            return None;
        }

        let mut env_ptr: usize = 0;
        read = 0;
        let ok = unsafe {
            ReadProcessMemory(
                handle,
                (proc_params.checked_add(0x80)?) as *const c_void,
                (&mut env_ptr as *mut usize) as *mut c_void,
                std::mem::size_of::<usize>(),
                &mut read,
            )
        };
        if ok == 0 || read != std::mem::size_of::<usize>() || env_ptr == 0 {
            return None;
        }

        // Read bounded 4 KiB chunks up to 64 KiB until double-NUL UTF-16 terminator.
        let mut all_units: Vec<u16> = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        let mut offset = 0usize;
        while offset < 64 * 1024 {
            let mut got = 0usize;
            let addr = env_ptr.checked_add(offset)?;
            let ok = unsafe {
                ReadProcessMemory(
                    handle,
                    addr as *const c_void,
                    chunk.as_mut_ptr() as *mut c_void,
                    chunk.len(),
                    &mut got,
                )
            };
            if ok == 0 || got < 2 {
                break;
            }
            let even = got & !1;
            let prev_len = all_units.len();
            for pair in chunk[..even].as_chunks::<2>().0 {
                all_units.push(u16::from_le_bytes(*pair));
            }
            let scan_start = prev_len.saturating_sub(1);
            if all_units[scan_start..].windows(2).any(|w| w == [0, 0]) {
                break;
            }
            offset += even;
        }
        parse_kiki_home_from_env_block(&all_units)
    }

    #[cfg(not(target_arch = "x86_64"))]
    fn query_env_kiki_home(_pid: u32) -> Option<String> {
        None
    }

    pub(crate) fn snapshot_kiki_processes() -> Vec<ProcessSnapshot> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let _guard = HandleGuard(snapshot);

        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32FirstW(snapshot, &mut entry) } == 0 {
            return Vec::new();
        }

        let mut out = Vec::new();
        loop {
            let end = entry
                .szExeFile
                .iter()
                .position(|&ch| ch == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
            let is_server = name.eq_ignore_ascii_case("kiki-server.exe");
            let is_desktop = name.eq_ignore_ascii_case("kiki-desktop.exe");
            if is_server || is_desktop {
                let cmd = query_command_line(entry.th32ProcessID).unwrap_or_default();
                let env_kiki_home = if is_server
                    && extract_explicit_home(&cmd).is_none()
                    && extract_inferred_home_from_server_child(&cmd).is_none()
                {
                    query_env_kiki_home(entry.th32ProcessID)
                } else {
                    None
                };
                out.push(ProcessSnapshot {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    name,
                    command_line: cmd,
                    env_kiki_home,
                });
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
        out
    }
}

#[cfg(target_os = "linux")]
mod process_probe {
    use super::*;

    pub(crate) fn snapshot_kiki_processes() -> Vec<ProcessSnapshot> {
        let Ok(entries) = fs::read_dir("/proc") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
                continue;
            };
            let proc_dir = entry.path();
            let Ok(comm) = fs::read_to_string(proc_dir.join("comm")) else {
                continue;
            };
            let name = comm.trim().to_string();
            let is_server = name == "kiki-server";
            let is_desktop = name == "kiki-desktop";
            if !is_server && !is_desktop {
                continue;
            }
            let cmd = fs::read(proc_dir.join("cmdline"))
                .map(|bytes| {
                    bytes
                        .split(|&b| b == 0)
                        .filter(|part| !part.is_empty())
                        .map(|part| {
                            let s = String::from_utf8_lossy(part);
                            if s.contains(char::is_whitespace) {
                                format!("\"{s}\"")
                            } else {
                                s.into_owned()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let parent_pid = fs::read_to_string(proc_dir.join("stat"))
                .ok()
                .and_then(|stat| {
                    let after = stat.rsplit_once(')')?.1;
                    after.split_whitespace().nth(1)?.parse::<u32>().ok()
                })
                .unwrap_or(0);
            let env_kiki_home = if is_server {
                fs::read(proc_dir.join("environ")).ok().and_then(|bytes| {
                    bytes.split(|&b| b == 0).find_map(|entry| {
                        let s = std::str::from_utf8(entry).ok()?;
                        s.strip_prefix("KIKI_HOME=")
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .map(str::to_string)
                    })
                })
            } else {
                None
            };
            out.push(ProcessSnapshot {
                pid,
                parent_pid,
                name,
                command_line: cmd,
                env_kiki_home,
            });
        }
        out
    }
}

#[cfg(all(not(windows), not(target_os = "linux")))]
mod process_probe {
    use super::*;

    pub(crate) fn snapshot_kiki_processes() -> Vec<ProcessSnapshot> {
        Vec::new()
    }
}

fn is_desktop_process_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("kiki-desktop.exe") || name.eq_ignore_ascii_case("kiki-desktop")
}

fn is_server_process_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("kiki-server.exe") || name.eq_ignore_ascii_case("kiki-server")
}

fn desktop_cmdline_is_windowless(cmd: &str) -> bool {
    let tokens = split_command_tokens(cmd);
    tokens
        .iter()
        .skip(1)
        .any(|arg| arg == "--tray-only" || arg == "--autostart" || arg == "--background" || arg == "--tray" || arg == "--minimized")
}

fn read_homes_json_paths(main_home: &Path) -> Vec<(Option<String>, Option<String>, PathBuf)> {
    let path = main_home.join("homes.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(records) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for record in records {
        let Some(raw_path) = record.get("path").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let home = PathBuf::from(raw_path);
        if !home.is_absolute() {
            continue;
        }
        let id = record
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let name = record
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        out.push((id, name, normalize_home_path(&home)));
    }
    out
}

fn fallback_space_name(home: &Path) -> String {
    home.file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| home.display().to_string())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn discover_local_spaces_with(
    main_home: &Path,
    runtime_root: Option<&Path>,
    processes: &[ProcessSnapshot],
    current_pid: u32,
    current_visible_home: Option<&Path>,
    zh: bool,
    now_ms: u64,
    is_alive: impl Fn(u32) -> bool,
) -> Vec<LocalSpaceEntry> {
    let main_norm = normalize_home_path(main_home);
    let main_key = canonical_home_key(&main_norm);

    let mut ordered_keys: Vec<String> = Vec::new();
    let mut path_by_key: HashMap<String, PathBuf> = HashMap::new();
    let mut registered_keys: HashSet<String> = HashSet::new();
    let mut fallback_meta: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    let mut window_keys: HashSet<String> = HashSet::new();

    let mut add_candidate = |path: PathBuf, registered: bool| {
        let norm = normalize_home_path(&path);
        let key = canonical_home_key(&norm);
        if !path_by_key.contains_key(&key) {
            ordered_keys.push(key.clone());
            path_by_key.insert(key.clone(), norm);
        }
        if registered {
            registered_keys.insert(key);
        }
    };

    // 1. Primary home
    add_candidate(main_norm.clone(), true);

    // 2. Registered spaces in homes.json
    for (id, name, path) in read_homes_json_paths(&main_norm) {
        let key = canonical_home_key(&path);
        add_candidate(path, true);
        fallback_meta.insert(key, (id, name));
    }

    // 3. Live processes (kiki-desktop + kiki-server + child workers)
    let mut inferred_by_parent_pid: HashMap<u32, PathBuf> = HashMap::new();
    for proc in processes {
        if is_server_process_name(&proc.name) {
            if let Some(inferred) = extract_inferred_home_from_server_child(&proc.command_line) {
                if proc.parent_pid > 0 {
                    inferred_by_parent_pid.insert(proc.parent_pid, inferred.clone());
                }
                add_candidate(inferred, false);
            }
            if let Some(explicit) = extract_explicit_home(&proc.command_line) {
                add_candidate(explicit, false);
            }
            if let Some(env_home) = &proc.env_kiki_home {
                let candidate = PathBuf::from(env_home);
                if candidate.is_absolute() {
                    add_candidate(candidate, false);
                }
            }
        } else if is_desktop_process_name(&proc.name) {
            let desktop_home = extract_explicit_home(&proc.command_line)
                .unwrap_or_else(|| main_norm.clone());
            let key = canonical_home_key(&desktop_home);
            add_candidate(desktop_home, false);
            if proc.pid != current_pid && !desktop_cmdline_is_windowless(&proc.command_line) {
                window_keys.insert(key);
            }
        }
    }
    if let Some(visible_home) = current_visible_home {
        window_keys.insert(canonical_home_key(visible_home));
    }
    // Propagate child-inferred home hints for any server processes whose parent matched.
    for proc in processes {
        if is_server_process_name(&proc.name) {
            if let Some(inferred) = inferred_by_parent_pid.get(&proc.pid) {
                add_candidate(inferred.clone(), false);
            }
        }
    }

    // 4. Runtime hot-switch ledger homes (only existing dirs)
    for ledger_home in read_ledger_space_homes(runtime_root) {
        add_candidate(ledger_home, false);
    }

    // Build final LocalSpaceEntry list; keep registered spaces always, and unregistered
    // spaces only when running or currently attached to a desktop window.
    let mut entries = Vec::new();
    for key in ordered_keys {
        let Some(home) = path_by_key.get(&key) else {
            continue;
        };
        let is_primary = key == main_key;
        let registered = registered_keys.contains(&key);
        let live = find_live_instance_for_home(home, now_ms, &is_alive);
        let running = live.is_some();
        let has_window = window_keys.contains(&key);
        if !registered && !running && !has_window {
            continue;
        }
        let (home_id, name) = if is_primary {
            (
                "main".to_string(),
                if zh {
                    "主空间".to_string()
                } else {
                    "Main space".to_string()
                },
            )
        } else if let Ok(Some(space)) = read_desktop_space(home) {
            (space.home_id, space.name)
        } else {
            let (reg_id, reg_name) = fallback_meta.get(&key).cloned().unwrap_or((None, None));
            let id = reg_id.unwrap_or_else(|| format!("local-{}", short_home_hash(home)));
            let label = reg_name.unwrap_or_else(|| fallback_space_name(home));
            (id, label)
        };
        entries.push(LocalSpaceEntry {
            home_id,
            name,
            path: home.to_string_lossy().into_owned(),
            is_primary,
            registered,
            running,
            has_window,
            pid: live.as_ref().map(|m| m.pid),
            port: live.as_ref().map(|m| m.port),
            desktop_managed: None,
        });
    }
    entries
}

pub fn discover_local_spaces(
    main_home: &Path,
    current_visible_home: Option<&Path>,
    zh: bool,
) -> Vec<LocalSpaceEntry> {
    let processes = process_probe::snapshot_kiki_processes();
    let runtime_root = runtime_root_from_current_exe();
    let now_ms = unix_epoch_millis().unwrap_or(0);
    discover_local_spaces_with(
        main_home,
        runtime_root.as_deref(),
        &processes,
        std::process::id(),
        current_visible_home,
        zh,
        now_ms,
        pid_alive,
    )
}

pub(crate) fn is_home_registered(main_home: &Path, candidate_home: &Path) -> bool {
    let target_key = canonical_home_key(candidate_home);
    if canonical_home_key(main_home) == target_key {
        return true;
    }
    read_homes_json_paths(main_home)
        .into_iter()
        .any(|(_, _, path)| canonical_home_key(&path) == target_key)
}

fn has_live_server_process_for_home(home: &Path) -> bool {
    let target_key = canonical_home_key(home);
    let processes = process_probe::snapshot_kiki_processes();
    let mut inferred_by_parent: HashMap<u32, PathBuf> = HashMap::new();
    for proc_info in &processes {
        if is_server_process_name(&proc_info.name) {
            if let Some(inferred) = extract_inferred_home_from_server_child(&proc_info.command_line)
            {
                if proc_info.parent_pid > 0 {
                    inferred_by_parent
                        .entry(proc_info.parent_pid)
                        .or_insert(inferred);
                }
            }
        }
    }
    for proc_info in &processes {
        if !is_server_process_name(&proc_info.name) {
            continue;
        }
        let detected = extract_explicit_home(&proc_info.command_line)
            .or_else(|| proc_info.env_kiki_home.as_deref().map(PathBuf::from))
            .or_else(|| inferred_by_parent.get(&proc_info.pid).cloned());
        if detected
            .as_deref()
            .is_some_and(|p| canonical_home_key(p) == target_key)
        {
            return true;
        }
    }
    false
}

/// Gracefully stop the live local `kiki-server` belonging to `home`.
/// Reads the target space's token strictly for this authenticated loopback call
/// and never stores or exposes it outside this function.
pub fn stop_local_space_server(home: &Path) -> Result<(), String> {
    let now_ms = unix_epoch_millis().unwrap_or(0);
    let Some(live) = find_live_instance_for_home(home, now_ms, pid_alive) else {
        if has_live_server_process_for_home(home) {
            return Err(format!(
                "A kiki-server process for {} is still running, but its instance record is missing or stale; could not send a graceful loopback stop.",
                home.display()
            ));
        }
        return Ok(());
    };
    let token = read_token(home)?
        .ok_or_else(|| format!("No authentication token found for space {}", home.display()))?;
    let identity = authenticated_backend_identity(live.port, &token)
        .map_err(|failure| failure.message)?;
    if identity.server_id != live.server_id {
        return Err("The target space service identity changed; no stop request was sent".to_string());
    }

    #[cfg(windows)]
    let exit_probe = crate::BackendExitProbe::open(live.pid, live.started_at)?;

    let connection = DesktopConnection {
        url: format!("http://127.0.0.1:{}", live.port),
        token,
    };
    let port = connection_port(&connection)?;

    if identity.desktop_managed {
        let body = serde_json::json!({
            "action": "quit",
            "server_id": identity.server_id,
            "consent": true,
            "interrupt_work": true
        })
        .to_string();
        let response = http_json_body(port, "/api/desktop-lifecycle", &connection.token, &body, 64 * 1024)?;
        let boundary = response
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .ok_or("The lifecycle response is incomplete")?;
        let envelope: serde_json::Value =
            serde_json::from_slice(&response[boundary + 4..]).map_err(|e| e.to_string())?;
        if envelope.get("code").and_then(serde_json::Value::as_i64) != Some(0) {
            return Err(envelope
                .get("msg")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("The service refused the stop request")
                .to_string());
        }
    } else {
        // Headless / unmanaged local server: call POST /api/shutdown, falling back to
        // /api/desktop-lifecycle on HTTP 404 (matching desktop-hot-switch.ps1).
        let response = http_json_body(port, "/api/shutdown", &connection.token, "{}", 64 * 1024)?;
        let status_end = response
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(response.len());
        let status = parse_http_status_line(&response[..status_end]);
        if matches!(status, StatusLineParse::Complete(404)) {
            let body = serde_json::json!({
                "action": "quit",
                "server_id": identity.server_id,
                "consent": true,
                "interrupt_work": true
            })
            .to_string();
            let _ = http_json_body(port, "/api/desktop-lifecycle", &connection.token, &body, 64 * 1024)?;
        } else if !matches!(status, StatusLineParse::Complete(200..=299)) {
            return Err("The background server refused /api/shutdown".to_string());
        }
    }

    #[cfg(windows)]
    {
        exit_probe.wait_for_shutdown(Duration::from_secs(30))?;
    }
    #[cfg(not(windows))]
    {
        let deadline = Instant::now() + Duration::from_secs(30);
        while pid_alive(live.pid) {
            if Instant::now() >= deadline {
                return Err("The background server did not exit within 30s".to_string());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    // Remove leftover instance file if the server exited without cleaning it.
    let stale_file = home
        .join("server")
        .join("instances")
        .join(format!("{}.json", live.server_id));
    if let Err(err) = fs::remove_file(&stale_file) {
        if err.kind() != io::ErrorKind::NotFound {
            eprintln!("Kiki could not clean stopped instance file {}: {err}", stale_file.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kiki-local-spaces-{label}-{}-{}",
            std::process::id(),
            unix_epoch_millis().unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extracts_home_from_explicit_args_and_child_workers() {
        assert_eq!(
            extract_explicit_home(r#""C:\Kiki\kiki-desktop.exe" --home "D:\666\KikiSpaces\ctf""#),
            Some(normalize_home_path(Path::new(r"D:\666\KikiSpaces\ctf")))
        );
        assert_eq!(
            extract_explicit_home(r#"kiki-server.exe serve --home=D:\Space\One --port 0"#),
            Some(normalize_home_path(Path::new(r"D:\Space\One")))
        );
        assert_eq!(
            extract_inferred_home_from_server_child(
                r#"C:\Users\x\active\kiki-server.exe __search-indexer D:\666\KikiSpaces\ctf\search-index-v2\index.sqlite"#
            ),
            Some(normalize_home_path(Path::new(r"D:\666\KikiSpaces\ctf")))
        );
        assert_eq!(
            extract_inferred_home_from_server_child(
                r#"C:\Users\x\active\kiki-server.exe __plugin_run_node C:\runtime\hostRunner.mjs C:\Users\x\.kiki\plugins\managed\foo\entry.mjs"#
            ),
            Some(normalize_home_path(Path::new(r"C:\Users\x\.kiki")))
        );
    }

    #[test]
    fn parses_kiki_home_from_windows_peb_env_block() {
        let env_str = "PATH=C:\\Windows\0kiki_home=D:\\666\\KikiSpaces\\ctf\0TEMP=C:\\Temp\0\0";
        let units: Vec<u16> = env_str.encode_utf16().collect();
        assert_eq!(
            parse_kiki_home_from_env_block(&units).as_deref(),
            Some(r"D:\666\KikiSpaces\ctf")
        );
    }

    #[test]
    fn rejects_stale_heartbeat_even_when_pid_appears_alive() {
        let now = 200_000u64;
        let fresh = InstanceRecord {
            server_id: Some("srv-fresh".into()),
            url: None,
            pid: 4242,
            host: Some("127.0.0.1".into()),
            port: Some(50001),
            started_at: now - 10_000,
            heartbeat_at: now - 5_000,
            workspaces: vec![],
            build_id: None,
            build_channel: None,
        };
        let stale = InstanceRecord {
            server_id: Some("srv-stale".into()),
            url: None,
            pid: 4242,
            host: Some("127.0.0.1".into()),
            port: Some(50002),
            started_at: now - 120_000,
            heartbeat_at: now - (INSTANCE_HEARTBEAT_STALE_MS + 5_000),
            workspaces: vec![],
            build_id: None,
            build_channel: None,
        };
        assert!(is_instance_record_live(&fresh, now, |_| true));
        assert!(!is_instance_record_live(&stale, now, |_| true));
    }

    #[test]
    fn discovers_unregistered_live_headless_ctf_space_and_hides_stopped_unregistered_spaces() {
        let root = temp_dir("discover");
        let main_home = root.join("main");
        let reg_home = root.join("tavern");
        let ctf_home = root.join("ctf");
        let dead_unreg = root.join("dead-temp");
        for dir in [&main_home, &reg_home, &ctf_home, &dead_unreg] {
            fs::create_dir_all(dir.join("server").join("instances")).unwrap();
        }
        fs::write(
            reg_home.join("home.toml"),
            format!(
                "schema = 1\nid = \"h-tavern\"\nname = \"Tavern\"\nbase = {:?}\n",
                main_home.to_string_lossy()
            ),
        )
        .unwrap();
        fs::write(
            ctf_home.join("home.toml"),
            format!(
                "schema = 1\nid = \"h-ctf\"\nname = \"CTF\"\nbase = {:?}\n",
                main_home.to_string_lossy()
            ),
        )
        .unwrap();
        fs::write(
            main_home.join("homes.json"),
            serde_json::json!([
                { "id": "h-tavern", "name": "Tavern", "path": reg_home.to_string_lossy() }
            ])
            .to_string(),
        )
        .unwrap();

        let now = 500_000u64;
        fs::write(
            ctf_home.join("server").join("instances").join("srv-ctf.json"),
            serde_json::json!({
                "server_id": "srv-ctf",
                "pid": 46848,
                "host": "127.0.0.1",
                "port": 58627,
                "started_at": now - 10_000,
                "heartbeat_at": now - 2_000
            })
            .to_string(),
        )
        .unwrap();
        // Dead unregistered space has a stale heartbeat
        fs::write(
            dead_unreg.join("server").join("instances").join("srv-dead.json"),
            serde_json::json!({
                "server_id": "srv-dead",
                "pid": 99999,
                "host": "127.0.0.1",
                "port": 58628,
                "started_at": now - 120_000,
                "heartbeat_at": now - 90_000
            })
            .to_string(),
        )
        .unwrap();

        let indexer_cmd = format!(
            r#""C:\active\kiki-server.exe" __search-indexer "{}\search-index-v2\index.sqlite""#,
            ctf_home.display()
        );
        let dead_cmd = format!(r#"kiki-server.exe serve --home "{}""#, dead_unreg.display());
        let procs = vec![
            ProcessSnapshot {
                pid: 46848,
                parent_pid: 57532,
                name: "kiki-server.exe".into(),
                command_line: "kiki-server.exe serve".into(),
                env_kiki_home: None,
            },
            ProcessSnapshot {
                pid: 60152,
                parent_pid: 46848,
                name: "kiki-server.exe".into(),
                command_line: indexer_cmd,
                env_kiki_home: None,
            },
            ProcessSnapshot {
                pid: 99999,
                parent_pid: 1,
                name: "kiki-server.exe".into(),
                command_line: dead_cmd,
                env_kiki_home: None,
            },
        ];

        let spaces = discover_local_spaces_with(
            &main_home,
            None,
            &procs,
            1000,
            None,
            true,
            now,
            |pid| pid == 46848 || pid == 99999,
        );
        assert_eq!(spaces.len(), 3);
        assert_eq!(spaces[0].home_id, "main");
        assert_eq!(spaces[0].name, "主空间");
        assert!(spaces[0].registered);

        assert_eq!(spaces[1].home_id, "h-tavern");
        assert!(!spaces[1].running);

        assert_eq!(spaces[2].home_id, "h-ctf");
        assert_eq!(spaces[2].name, "CTF");
        assert!(!spaces[2].registered);
        assert!(spaces[2].running);
        assert!(!spaces[2].has_window);
        assert_eq!(spaces[2].pid, Some(46848));
        assert_eq!(spaces[2].port, Some(58627));

        let _ = fs::remove_dir_all(&root);
    }
}
