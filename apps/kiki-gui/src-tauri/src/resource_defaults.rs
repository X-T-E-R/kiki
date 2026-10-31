pub fn main_heap_mb(total_memory_bytes: u64) -> u64 {
    (total_memory_bytes / 1_048_576 / 4).max(8192)
}

#[cfg(windows)]
fn total_memory_bytes() -> std::io::Result<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut memory: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(memory.ullTotalPhys)
}

#[cfg(unix)]
fn total_memory_bytes() -> std::io::Result<u64> {
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if pages <= 0 || page_size <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(pages as u64 * page_size as u64)
}

pub fn node_options(existing: &str) -> std::io::Result<String> {
    let normalized = existing.replace('_', "-");
    if normalized.contains("--max-old-space-size") {
        return Ok(existing.to_string());
    }
    Ok(format!("{} --max-old-space-size={}", existing, main_heap_mb(total_memory_bytes()?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_main_heap_and_preserves_explicit_limits() {
        assert_eq!(main_heap_mb(16 * 1024 * 1024 * 1024), 8192);
        assert_eq!(main_heap_mb(64 * 1024 * 1024 * 1024), 16384);
        assert_eq!(node_options("--max_old_space_size=1024").unwrap(), "--max_old_space_size=1024");
        assert_eq!(node_options("--max-old-space-size-percentage=10").unwrap(), "--max-old-space-size-percentage=10");
        let options = node_options("--trace-warnings").unwrap();
        assert!(options.starts_with("--trace-warnings --max-old-space-size="));
    }
}
