use std::fs::{File, OpenOptions};
use std::io::{self, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use age::secrecy::SecretString;
use fs2::FileExt;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Task};
use napi_derive::napi;
use zeroize::Zeroizing;

pub struct AgeTask {
    bytes: Zeroizing<Vec<u8>>,
    passphrase: SecretString,
    encrypt: bool,
}

impl Task for AgeTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.encrypt {
            let recipient = age::scrypt::Recipient::new(self.passphrase.clone());
            age::encrypt(&recipient, &self.bytes)
                .map_err(|_| Error::from_reason("Age encryption failed"))
        } else {
            let identity = age::scrypt::Identity::new(self.passphrase.clone());
            age::decrypt(&identity, &self.bytes).map_err(|_| {
                Error::from_reason("Age decryption failed (invalid ciphertext or passphrase)")
            })
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi]
pub fn age_encrypt(bytes: Buffer, passphrase: String) -> Result<AsyncTask<AgeTask>> {
    age_task(bytes, passphrase, true)
}

#[napi]
pub fn age_decrypt(bytes: Buffer, passphrase: String) -> Result<AsyncTask<AgeTask>> {
    age_task(bytes, passphrase, false)
}

fn age_task(bytes: Buffer, passphrase: String, encrypt: bool) -> Result<AsyncTask<AgeTask>> {
    if passphrase.is_empty() {
        return Err(Error::from_reason("Age passphrase must not be empty"));
    }
    Ok(AsyncTask::new(AgeTask {
        bytes: Zeroizing::new(bytes.to_vec()),
        passphrase: SecretString::from(passphrase),
        encrypt,
    }))
}

pub struct CanonicalizeTask(String);

impl Task for CanonicalizeTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        std::fs::canonicalize(&self.0)
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| {
                Error::from_reason(format!("Original home canonicalization failed: {error}"))
            })
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn canonicalize_original_home(path: String) -> AsyncTask<CanonicalizeTask> {
    AsyncTask::new(CanonicalizeTask(path))
}

// Adapted from xai-grok-login manager/lock.rs, Apache-2.0, SpaceXAI 2023-2026.
// The lock file stays in place: neither timeout nor release unlinks it.
fn write_holder_info(file: &mut File) -> io::Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    file.set_len(0)?;
    file.seek(io::SeekFrom::Start(0))?;
    write!(file, "{}:{timestamp}", std::process::id())?;
    file.sync_all()
}

fn same_inode(file: &File, path: &Path) -> io::Result<bool> {
    let held = same_file::Handle::from_file(file.try_clone()?)?;
    let live = same_file::Handle::from_path(path)?;
    Ok(held == live)
}

struct HeldLock {
    file: std::sync::Arc<std::sync::Mutex<File>>,
    stop: Sender<()>,
    heartbeat: Option<JoinHandle<io::Result<()>>>,
}

impl HeldLock {
    fn new(file: File) -> io::Result<Self> {
        let file = std::sync::Arc::new(std::sync::Mutex::new(file));
        // Windows LockFileEx ownership requires writes through the locking handle.
        let heartbeat_file = std::sync::Arc::clone(&file);
        let (stop, ticks) = mpsc::channel();
        let heartbeat = std::thread::Builder::new()
            .name("kiki-auth-lock-heartbeat".into())
            .spawn(move || {
                while let Err(mpsc::RecvTimeoutError::Timeout) =
                    ticks.recv_timeout(Duration::from_secs(5))
                {
                    let mut file = heartbeat_file
                        .lock()
                        .map_err(|_| io::Error::other("Auth lock mutex poisoned"))?;
                    write_holder_info(&mut file)?;
                }
                Ok(())
            })?;
        Ok(Self {
            file,
            stop,
            heartbeat: Some(heartbeat),
        })
    }

    fn close(&mut self) -> io::Result<()> {
        let _ = self.stop.send(());
        let heartbeat_result = self
            .heartbeat
            .take()
            .map(|heartbeat| {
                heartbeat
                    .join()
                    .unwrap_or_else(|_| Err(io::Error::other("Auth lock heartbeat panicked")))
            })
            .unwrap_or(Ok(()));
        let file = self
            .file
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let unlock_result = FileExt::unlock(&*file);
        heartbeat_result.and(unlock_result)
    }
}

impl Drop for HeldLock {
    fn drop(&mut self) {
        if self.heartbeat.is_some() {
            let _ = self.close();
        }
    }
}

#[napi]
pub struct GrokAuthLock {
    held: Option<HeldLock>,
    lock_path: PathBuf,
}

#[napi]
impl GrokAuthLock {
    #[napi]
    pub fn is_current(&self) -> Result<bool> {
        let Some(held) = &self.held else {
            return Ok(false);
        };
        let file = held
            .file
            .lock()
            .map_err(|_| Error::from_reason("Auth lock mutex poisoned"))?;
        match same_inode(&file, &self.lock_path) {
            Ok(current) => Ok(current),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(Error::from_reason(format!(
                "Auth advisory lock identity check failed: {error}"
            ))),
        }
    }

    #[napi]
    pub fn release(&mut self) -> Result<()> {
        if let Some(mut held) = self.held.take() {
            held.close().map_err(|error| {
                Error::from_reason(format!("Auth advisory lock release failed: {error}"))
            })?;
        }
        Ok(())
    }
}

fn try_acquire(lock_path: &Path) -> io::Result<Option<HeldLock>> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    match file.try_lock_exclusive() {
        Ok(()) => {
            match same_inode(&file, lock_path) {
                Ok(true) => {}
                Ok(false) => return Ok(None),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            }
            write_holder_info(&mut file)?;
            HeldLock::new(file).map(Some)
        }
        Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[napi]
pub fn try_acquire_grok_auth_lock(auth_json_path: String) -> Result<Option<GrokAuthLock>> {
    let auth_path = PathBuf::from(auth_json_path);
    let lock_path = auth_path.with_file_name("auth.json.lock");
    try_acquire(&lock_path)
        .map(|held| {
            held.map(|held| GrokAuthLock {
                held: Some(held),
                lock_path,
            })
        })
        .map_err(|error| Error::from_reason(format!("Auth advisory lock failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_inode_is_not_accepted() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.tmp/auth-native-build")
            .join(format!("kiki-auth-inode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("auth.json.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .unwrap();
        file.try_lock_exclusive().unwrap();
        assert!(same_inode(&file, &path).unwrap());
        // Unix unlink can occur while a flock is held. Windows may deny replacing an open file.
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            File::create(&path).unwrap();
            assert!(!same_inode(&file, &path).unwrap());
        }
        #[cfg(windows)]
        {
            let other = dir.join("other.lock");
            File::create(&other).unwrap();
            assert!(!same_inode(&file, &other).unwrap());
        }
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
