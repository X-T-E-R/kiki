use age::secrecy::SecretString;
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Write};

const PASSPHRASE: &str = "synthetic-auth-fixture-passphrase";
const PLAINTEXT: &[u8] = b"{\"version\":1,\"secrets\":{\"example\":\"SYNTHETIC_ONLY\"}}";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args[1].as_str() {
        "canonicalize" => {
            use sha2::{Digest, Sha256};
            let canonical = std::fs::canonicalize(&args[2])
                .unwrap()
                .to_string_lossy()
                .into_owned();
            println!("{canonical}");
            println!("{:x}", Sha256::digest(canonical.as_bytes()));
        }
        "encrypt" => {
            let recipient = age::scrypt::Recipient::new(SecretString::from(PASSPHRASE.to_owned()));
            std::fs::write(&args[2], age::encrypt(&recipient, PLAINTEXT).unwrap()).unwrap();
        }
        "decrypt" => {
            let identity = age::scrypt::Identity::new(SecretString::from(PASSPHRASE.to_owned()));
            let plaintext = age::decrypt(&identity, &std::fs::read(&args[2]).unwrap()).unwrap();
            assert_eq!(plaintext, PLAINTEXT);
            println!("AGE_COMPAT_OK");
        }
        "x25519-encrypt" => {
            let recipients: Vec<age::x25519::Recipient> = args[3..]
                .iter()
                .map(|value| value.trim().parse::<age::x25519::Recipient>().unwrap())
                .collect();
            let encryptor = age::Encryptor::with_recipients(
                recipients.iter().map(|entry| entry as &dyn age::Recipient),
            )
            .unwrap();
            let mut output = Vec::new();
            let mut writer = encryptor.wrap_output(&mut output).unwrap();
            writer.write_all(PLAINTEXT).unwrap();
            writer.finish().unwrap();
            std::fs::write(&args[2], output).unwrap();
        }
        "x25519-decrypt" => {
            let identity = args[3].trim().parse::<age::x25519::Identity>().unwrap();
            let plaintext = age::decrypt(&identity, &std::fs::read(&args[2]).unwrap()).unwrap();
            assert_eq!(plaintext, PLAINTEXT);
            println!("AGE_X25519_COMPAT_OK");
        }
        "hold" => {
            // Independent donor-style holder, not the N-API implementation.
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&args[2])
                .unwrap();
            file.lock_exclusive().unwrap();
            println!("LOCK_READY");
            io::stdout().flush().unwrap();
            let _ = io::stdin().lock().lines().next();
            FileExt::unlock(&file).unwrap();
        }
        "try" => {
            let file = File::options()
                .read(true)
                .write(true)
                .open(&args[2])
                .unwrap();
            match file.try_lock_exclusive() {
                Ok(()) => println!("LOCK_FREE"),
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    println!("LOCK_BUSY")
                }
                Err(error) => panic!("unexpected lock error: {error}"),
            }
        }
        _ => panic!("unknown synthetic fixture command"),
    }
}
