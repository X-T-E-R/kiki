use std::{env, fs, path::PathBuf};

fn main() {
    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let sidecar = PathBuf::from("binaries").join(format!("kiki-server-{target}{extension}"));

    match fs::metadata(&sidecar) {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
        _ => panic!(
            "Kiki desktop sidecar is missing at {}. Run `pnpm desktop:prepare` from apps/kiki-gui (set KIKI_SIDECAR_SOURCE when using a non-default SEA build).",
            sidecar.display()
        ),
    }

    println!("cargo:rerun-if-changed={}", sidecar.display());
    tauri_build::build();
}
