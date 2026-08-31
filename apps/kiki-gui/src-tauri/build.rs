use std::{
    env, fs,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

include!("src/app_commands.rs");

macro_rules! command_names {
    ($($command:ident),* $(,)?) => {
        &[$(stringify!($command)),*]
    };
}

const APP_COMMANDS: &[&str] = app_commands!(command_names);
const MAIN_CAPABILITY_PATH: &str = "capabilities/main.json";
const SIDECAR_MANIFEST_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarManifest {
    schema_version: u32,
    target: String,
    bytes: u64,
    sha256: String,
    server_version: String,
}

fn sha256_file(path: &Path) -> String {
    let mut file = File::open(path).unwrap_or_else(|error| {
        panic!(
            "Cannot open Kiki desktop sidecar {}: {error}",
            path.display()
        )
    });
    let mut hash = Sha256::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let bytes = file.read(&mut chunk).unwrap_or_else(|error| {
            panic!(
                "Cannot hash Kiki desktop sidecar {}: {error}",
                path.display()
            )
        });
        if bytes == 0 {
            break;
        }
        hash.update(&chunk[..bytes]);
    }
    format!("{:x}", hash.finalize())
}

fn validate_main_capability() {
    let raw = fs::read_to_string(MAIN_CAPABILITY_PATH)
        .expect("Cannot read the main Tauri capability");
    let capability: serde_json::Value =
        serde_json::from_str(&raw).expect("The main Tauri capability is invalid JSON");
    let windows = capability["windows"]
        .as_array()
        .expect("The main Tauri capability must declare its windows");
    assert_eq!(windows, &[serde_json::Value::String("main".to_string())]);
    let permissions = capability["permissions"]
        .as_array()
        .expect("The main Tauri capability must declare permissions");

    for command in APP_COMMANDS {
        let permission = format!("allow-{}", command.replace('_', "-"));
        assert!(
            permissions
                .iter()
                .any(|entry| entry.as_str() == Some(permission.as_str())),
            "The main Tauri capability must grant {permission}"
        );
    }
}

fn main() {
    println!("cargo:rerun-if-changed={MAIN_CAPABILITY_PATH}");
    println!("cargo:rerun-if-changed=src/app_commands.rs");
    validate_main_capability();

    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let sidecar = PathBuf::from("binaries").join(format!("kiki-server-{target}{extension}"));
    let manifest_path = sidecar.with_file_name(format!(
        "{}.manifest.json",
        sidecar.file_name().unwrap().to_string_lossy()
    ));

    let metadata = fs::metadata(&sidecar).unwrap_or_else(|_| {
        panic!(
            "Kiki desktop sidecar is missing at {}. Run `pnpm desktop:prepare` from apps/kiki-gui (set KIKI_SIDECAR_SOURCE when using a non-default SEA build).",
            sidecar.display()
        )
    });
    assert!(
        metadata.is_file() && metadata.len() > 0,
        "Kiki desktop sidecar must be a non-empty file at {}. Run `pnpm desktop:prepare` from apps/kiki-gui.",
        sidecar.display()
    );

    let manifest_raw = fs::read_to_string(&manifest_path).unwrap_or_else(|_| {
        panic!(
            "Kiki desktop sidecar manifest is missing at {}. Run `pnpm desktop:prepare` from apps/kiki-gui.",
            manifest_path.display()
        )
    });
    let manifest: SidecarManifest = serde_json::from_str(&manifest_raw).unwrap_or_else(|error| {
        panic!(
            "Kiki desktop sidecar manifest is invalid at {}: {error}. Run `pnpm desktop:prepare` from apps/kiki-gui.",
            manifest_path.display()
        )
    });
    assert_eq!(
        manifest.schema_version, SIDECAR_MANIFEST_VERSION,
        "Kiki desktop sidecar manifest version is unsupported; run `pnpm desktop:prepare` from apps/kiki-gui"
    );
    assert_eq!(
        manifest.target, target,
        "Kiki desktop sidecar manifest target does not match Cargo TARGET; run `pnpm desktop:prepare` from apps/kiki-gui"
    );
    assert_eq!(
        manifest.bytes,
        metadata.len(),
        "Kiki desktop sidecar size does not match its manifest; run `pnpm desktop:prepare` from apps/kiki-gui"
    );
    assert_eq!(
        manifest.sha256.to_ascii_lowercase(),
        sha256_file(&sidecar),
        "Kiki desktop sidecar hash does not match its manifest; run `pnpm desktop:prepare` from apps/kiki-gui"
    );
    assert!(
        !manifest.server_version.is_empty()
            && manifest.server_version.trim() == manifest.server_version
            && !manifest.server_version.contains(['\r', '\n']),
        "Kiki desktop sidecar manifest has an invalid serverVersion; run `pnpm desktop:prepare` from apps/kiki-gui"
    );

    println!("cargo:rerun-if-changed={}", sidecar.display());
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!(
        "cargo:rustc-env=KIKI_SIDECAR_SERVER_VERSION={}",
        manifest.server_version
    );
    println!("cargo:rerun-if-env-changed=KIKI_UPDATER_PUBLIC_KEY");
    if let Ok(public_key) = env::var("KIKI_UPDATER_PUBLIC_KEY") {
        println!("cargo:rustc-env=KIKI_UPDATER_PUBLIC_KEY={}", public_key.trim());
    }
    println!("cargo:rerun-if-env-changed=KIKI_UPDATE_CHANNEL");
    println!(
        "cargo:rustc-env=KIKI_UPDATE_CHANNEL={}",
        env::var("KIKI_UPDATE_CHANNEL").unwrap_or_else(|_| "stable".to_string())
    );
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Tauri application manifest");
}
