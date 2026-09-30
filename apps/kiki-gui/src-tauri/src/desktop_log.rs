use std::{fs::{self, File, OpenOptions}, io::{self, Write}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};

pub const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const LOG_BACKUPS: usize = 3;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopLogLevel {
    Trace,
    Debug,
    Info,
    #[default]
    Warn,
    Error,
    Fatal,
    Silent,
}
impl DesktopLogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace", Self::Debug => "debug", Self::Info => "info",
            Self::Warn => "warn", Self::Error => "error", Self::Fatal => "fatal", Self::Silent => "silent",
        }
    }
}

pub struct RotatingLog {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    limit: u64,
    backups: usize,
}
impl RotatingLog {
    pub fn open(path: &Path, limit: u64, backups: usize) -> io::Result<Self> {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        let mut log = Self { path: path.to_path_buf(), file: Some(file), size, limit, backups };
        if size >= limit { log.rotate()?; }
        Ok(log)
    }
    fn backup(&self, number: usize) -> PathBuf {
        let mut name = self.path.as_os_str().to_os_string();
        name.push(format!(".{number}"));
        PathBuf::from(name)
    }
    fn rotate(&mut self) -> io::Result<()> {
        self.file.take();
        if self.backups > 0 {
            match fs::remove_file(self.backup(self.backups)) {
                Ok(()) => (), Err(error) if error.kind() == io::ErrorKind::NotFound => (), Err(error) => return Err(error),
            }
            for number in (1..self.backups).rev() {
                match fs::rename(self.backup(number), self.backup(number + 1)) {
                    Ok(()) => (), Err(error) if error.kind() == io::ErrorKind::NotFound => (), Err(error) => return Err(error),
                }
            }
            fs::rename(&self.path, self.backup(1))?;
        }
        self.file = Some(OpenOptions::new().create(true).write(true).truncate(true).open(&self.path)?);
        self.size = 0;
        Ok(())
    }
    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        // A single oversized line must not bypass the disk budget; retain its UTF-8 tail.
        let max_line = self.limit.saturating_sub(1) as usize;
        let mut start = line.len().saturating_sub(max_line);
        while start < line.len() && !line.is_char_boundary(start) { start += 1; }
        let line = &line[start..];
        let bytes = line.len() as u64 + 1;
        if self.size + bytes > self.limit { self.rotate()?; }
        let file = self.file.as_mut().ok_or_else(|| io::Error::other("log file is closed"))?;
        writeln!(file, "{line}")?;
        self.size += bytes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("kiki-log-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }
    #[test]
    fn rotates_during_writes_and_bounds_backups_and_large_utf8_lines() {
        let root = root();
        let path = root.join("desktop-backend.log");
        let mut log = RotatingLog::open(&path, 16, 2).unwrap();
        for _ in 0..10 { log.write_line("123456789012345").unwrap(); }
        log.write_line(&"测试".repeat(100)).unwrap();
        drop(log);
        for path in [&path, &root.join("desktop-backend.log.1"), &root.join("desktop-backend.log.2")] {
            assert!(fs::metadata(path).unwrap().len() <= 16);
            assert!(fs::read_to_string(path).is_ok());
        }
        assert!(!root.join("desktop-backend.log.3").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preserves_existing_small_logs_and_rotates_existing_oversized_logs() {
        let root = root(); fs::create_dir_all(&root).unwrap();
        let path = root.join("desktop-backend.log"); fs::write(&path, "old\n").unwrap();
        let mut log = RotatingLog::open(&path, 16, 2).unwrap(); log.write_line("new").unwrap(); drop(log);
        assert_eq!(fs::read_to_string(&path).unwrap(), "old\nnew\n");
        fs::write(&path, "x".repeat(30)).unwrap();
        drop(RotatingLog::open(&path, 16, 2).unwrap());
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        assert_eq!(fs::metadata(root.join("desktop-backend.log.1")).unwrap().len(), 30);
        assert!(RotatingLog::open(&root, 16, 2).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn validates_log_levels() {
        assert_eq!(serde_json::from_str::<DesktopLogLevel>("\"debug\"").unwrap().as_str(), "debug");
        assert!(serde_json::from_str::<DesktopLogLevel>("\"verbose\"").is_err());
        assert_eq!(DesktopLogLevel::default().as_str(), "warn");
    }
}
