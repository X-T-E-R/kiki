#[tauri::command]
pub fn read_clipboard_file_paths(app: tauri::AppHandle) -> Result<Option<Vec<String>>, String> {
    use tauri_plugin_fs::FsExt;
    let paths = read_file_paths()?;
    if let Some(paths) = &paths {
        for path in paths {
            app.fs_scope().allow_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(paths)
}

#[cfg(not(windows))]
fn read_file_paths() -> Result<Option<Vec<String>>, String> {
    Ok(None)
}

#[cfg(windows)]
fn read_file_paths() -> Result<Option<Vec<String>>, String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    const CF_HDROP: u32 = 15;
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(None);
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("Could not open the file clipboard. Try pasting again.".to_string());
        }
        struct ClipboardGuard;
        impl Drop for ClipboardGuard {
            fn drop(&mut self) { unsafe { CloseClipboard(); } }
        }
        let _guard = ClipboardGuard;
        let drop = GetClipboardData(CF_HDROP);
        if drop.is_null() {
            return Err("Could not read the copied file paths.".to_string());
        }
        drop_paths(drop).map(Some)
    }
}

#[cfg(windows)]
unsafe fn drop_paths(drop: windows_sys::Win32::UI::Shell::HDROP) -> Result<Vec<String>, String> {
    use windows_sys::Win32::UI::Shell::DragQueryFileW;
    let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
    let mut paths = Vec::new();
    for index in 0..count {
        let length = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
        let mut wide = vec![0u16; length as usize + 1];
        if DragQueryFileW(drop, index, wide.as_mut_ptr(), wide.len() as u32) != length {
            return Err("Could not read a copied file path.".to_string());
        }
        let path = String::from_utf16(&wide[..length as usize])
            .map_err(|_| "The copied file path is not valid Unicode.".to_string())?;
        if !std::path::Path::new(&path).is_absolute() {
            return Err("The clipboard did not provide an absolute file path.".to_string());
        }
        paths.push(path);
    }
    Ok(paths)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::UI::Shell::DROPFILES;

    #[test]
    fn reads_owned_windows_drop_handle_without_accessing_user_clipboard() {
        let root = std::env::temp_dir().join(format!("kiki-clipboard-fixture-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("large 世界 file.bin");
        let fixture = std::fs::File::create(&file).unwrap();
        fixture.set_len(60 * 1024 * 1024).unwrap();
        let paths = vec![file.to_str().unwrap().to_string(), root.to_str().unwrap().to_string()];
        let wide: Vec<u16> = paths.iter().flat_map(|path| path.encode_utf16().chain([0])).chain([0]).collect();
        unsafe {
            let header = std::mem::size_of::<DROPFILES>();
            let handle = GlobalAlloc(GMEM_MOVEABLE, header + wide.len() * 2);
            assert!(!handle.is_null());
            let memory = GlobalLock(handle);
            assert!(!memory.is_null());
            std::ptr::write(memory as *mut DROPFILES, DROPFILES {
                pFiles: header as u32, pt: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
                fNC: 0, fWide: 1,
            });
            std::ptr::copy_nonoverlapping(wide.as_ptr(), (memory as *mut u8).add(header) as *mut u16, wide.len());
            GlobalUnlock(handle);
            assert_eq!(drop_paths(handle).unwrap(), paths);
            GlobalFree(handle);
        }
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
