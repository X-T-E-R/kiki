use std::{env, path::PathBuf, process::ExitCode};

use kiki_lib::config_import::import_config_homes;

fn main() -> ExitCode {
    if env::args()
        .skip(1)
        .any(|arg| arg == "--help" || arg == "-h")
    {
        println!(
            "Usage: import-kimi-config [--source-home <absolute path>] [--target-home <absolute path>]\n\nStop the Kiki backend before using this headless config-only importer."
        );
        return ExitCode::SUCCESS;
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Kimi config import failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let (source_home, target_home) = parse_homes()?;
    let result = import_config_homes(&source_home, &target_home)?;
    println!("status: {}", result.status);
    println!("source: {}", result.source);
    println!("target: {}", result.target);
    println!(
        "updated categories: {}",
        if result.updated_categories.is_empty() {
            "none".to_string()
        } else {
            result.updated_categories.join(", ")
        }
    );
    Ok(())
}

fn parse_homes() -> Result<(PathBuf, PathBuf), String> {
    let mut source_home = None;
    let mut target_home = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--source-home" => {
                source_home =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        "--source-home requires an absolute path".to_string()
                    })?));
            }
            "--target-home" => {
                target_home =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        "--target-home requires an absolute path".to_string()
                    })?));
            }
            "--help" | "-h" => {
                println!(
                    "Usage: import-kimi-config [--source-home <absolute path>] [--target-home <absolute path>]\n\nStop the Kiki backend before using this headless config-only importer."
                );
                return Err("help requested".to_string());
            }
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }
    let source_home = match source_home {
        Some(path) => path,
        None => default_home("KIMI_CODE_HOME", ".kimi-code")?,
    };
    let target_home = match target_home {
        Some(path) => path,
        None => default_home("KIKI_HOME", ".kiki")?,
    };
    if !source_home.is_absolute() {
        return Err("Source Home must be an absolute path".to_string());
    }
    if !target_home.is_absolute() {
        return Err("Target Home must be an absolute path".to_string());
    }
    Ok((source_home, target_home))
}

fn default_home(variable: &str, fallback: &str) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os(variable).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(fallback))
        .ok_or_else(|| format!("Cannot resolve the default Home for {variable}"))
}
