use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use toml_edit::{DocumentMut, Item, Table};

pub const IMPORT_CATEGORIES: [&str; 7] = [
    "providers",
    "models",
    "services",
    "default_model",
    "default_provider",
    "thinking",
    "secondary_model",
];

const MAP_CATEGORIES: [&str; 3] = ["providers", "models", "services"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigImportResult {
    pub status: &'static str,
    pub source: String,
    pub target: String,
    pub updated_categories: Vec<String>,
}

pub struct ConfigImportPlan {
    source_path: PathBuf,
    target_path: PathBuf,
    updated_categories: Vec<String>,
    rendered: Option<String>,
}

impl ConfigImportPlan {
    pub fn has_changes(&self) -> bool {
        self.rendered.is_some()
    }

    pub fn result(&self) -> ConfigImportResult {
        ConfigImportResult {
            status: if self.has_changes() {
                "imported"
            } else {
                "noop"
            },
            source: self.source_path.display().to_string(),
            target: self.target_path.display().to_string(),
            updated_categories: self.updated_categories.clone(),
        }
    }
}

pub fn plan_config_import_homes(
    source_home: &Path,
    target_home: &Path,
) -> Result<ConfigImportPlan, String> {
    plan_config_import(
        &source_home.join("config.toml"),
        &target_home.join("config.toml"),
    )
}

pub fn import_config_homes(
    source_home: &Path,
    target_home: &Path,
) -> Result<ConfigImportResult, String> {
    apply_config_import(plan_config_import_homes(source_home, target_home)?)
}

pub fn plan_config_import(
    source_path: &Path,
    target_path: &Path,
) -> Result<ConfigImportPlan, String> {
    let source_raw = fs::read_to_string(source_path).map_err(|error| {
        format!(
            "Cannot read Kimi config at {}: {error}",
            source_path.display()
        )
    })?;
    let source = source_raw.parse::<DocumentMut>().map_err(|_| {
        format!(
            "Cannot parse Kimi config at {} as TOML",
            source_path.display()
        )
    })?;
    let target_raw = match fs::read_to_string(target_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "Cannot read Kiki config at {}: {error}",
                target_path.display()
            ))
        }
    };
    let mut target = if target_raw.trim().is_empty() {
        DocumentMut::new()
    } else {
        target_raw.parse::<DocumentMut>().map_err(|_| {
            format!(
                "Cannot parse Kiki config at {} as TOML",
                target_path.display()
            )
        })?
    };
    let original_target = if target_raw.trim().is_empty() {
        toml::Value::Table(toml::map::Map::new())
    } else {
        toml::from_str::<toml::Value>(&target_raw).map_err(|_| {
            format!(
                "Cannot parse Kiki config at {} as TOML",
                target_path.display()
            )
        })?
    };

    for category in MAP_CATEGORIES {
        let Some(source_item) = source.get(category) else {
            continue;
        };
        let Some(source_map) = source_item.as_table_like() else {
            return Err(format!(
                "Kimi config category {category} at {} must be a table",
                source_path.display()
            ));
        };
        if target.get(category).and_then(Item::as_table_like).is_none() {
            target[category] = Item::Table(Table::new());
        }
        let target_map = target[category]
            .as_table_like_mut()
            .expect("table was initialized");
        for (key, value) in source_map.iter() {
            target_map.insert(key, value.clone());
        }
    }

    for category in [
        "default_model",
        "default_provider",
        "thinking",
        "secondary_model",
    ] {
        let Some(source_item) = source.get(category) else {
            continue;
        };
        target[category] = source_item.clone();
    }

    let rendered_target = target.to_string();
    let final_target = if rendered_target.trim().is_empty() {
        toml::Value::Table(toml::map::Map::new())
    } else {
        toml::from_str::<toml::Value>(&rendered_target).map_err(|_| {
            format!(
                "Cannot validate imported Kiki config for {}",
                target_path.display()
            )
        })?
    };
    let updated_categories = IMPORT_CATEGORIES
        .iter()
        .filter(|category| original_target.get(**category) != final_target.get(**category))
        .map(|category| (*category).to_string())
        .collect::<Vec<_>>();
    let rendered = if updated_categories.is_empty() {
        None
    } else {
        Some(rendered_target)
    };
    Ok(ConfigImportPlan {
        source_path: source_path.to_path_buf(),
        target_path: target_path.to_path_buf(),
        updated_categories,
        rendered,
    })
}

pub fn apply_config_import(plan: ConfigImportPlan) -> Result<ConfigImportResult, String> {
    let result = plan.result();
    let Some(rendered) = plan.rendered else {
        return Ok(result);
    };
    write_atomic(&plan.target_path, rendered.as_bytes(), |from, to| {
        fs::rename(from, to)
    })?;
    Ok(result)
}

fn write_atomic(
    target: &Path,
    content: &[u8],
    rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| {
        format!(
            "Kiki config target {} has no parent directory",
            target.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot prepare Kiki config directory {}: {error}",
            parent.display()
        )
    })?;
    let suffix = unique_suffix()?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.toml");
    let temporary = parent.join(format!(".{file_name}.import-{suffix}.tmp"));
    let backup = parent.join(format!(".{file_name}.import-{suffix}.bak"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| {
            format!(
                "Cannot create temporary Kiki config {}: {error}",
                temporary.display()
            )
        })?;
    if let Err(error) = file.write_all(content).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Cannot write temporary Kiki config {}: {error}",
            temporary.display()
        ));
    }
    drop(file);
    activate_atomic(target, &temporary, &backup, rename)
}

fn activate_atomic(
    target: &Path,
    temporary: &Path,
    backup: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let had_target = target.exists();
    if had_target {
        rename(target, backup).map_err(|error| {
            let _ = fs::remove_file(temporary);
            format!(
                "Cannot stage existing Kiki config from {} to {}: {error}",
                target.display(),
                backup.display()
            )
        })?;
    }
    if let Err(error) = rename(temporary, target) {
        let _ = fs::remove_file(temporary);
        if had_target {
            if let Err(compensation_error) = rename(backup, target) {
                return Err(format!(
                    "Partial Kiki config import: activation from {} to {} failed: {error}; compensation from {} back to {} also failed: {compensation_error}",
                    temporary.display(),
                    target.display(),
                    backup.display(),
                    target.display()
                ));
            }
            return Err(format!(
                "Cannot activate imported Kiki config from {} to {}: {error}; original target was restored from {}",
                temporary.display(),
                target.display(),
                backup.display()
            ));
        }
        return Err(format!(
            "Cannot activate imported Kiki config from {} to {}: {error}",
            temporary.display(),
            target.display()
        ));
    }
    if had_target {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn unique_suffix() -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Cannot create a timestamp for the Kiki config import".to_string())?
        .as_millis();
    Ok(format!("{}-{millis}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use std::{env, fs, io};

    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "kiki-config-import-{label}-{}-{}",
            std::process::id(),
            unique_suffix().unwrap()
        ))
    }

    #[test]
    fn imports_allowlist_with_merge_replace_and_idempotent_semantics() {
        let root = temp_root("merge");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        fs::create_dir_all(&source_home).unwrap();
        fs::create_dir_all(&target_home).unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"# source
default_model = "shared/source-model"
default_provider = "shared"

[providers.shared]
type = "openai"
api_key = "SOURCE_SECRET"

[providers.source_only]
type = "kimi"

[models.shared]
provider = "shared"
model = "source-model"

[services.web]
url = "https://source.example.test"

[thinking]
enabled = true
effort = "high"

[secondary_model]
default_model = "shared/source-model"

[mcp.secret]
command = "do-not-import"
"#,
        )
        .unwrap();
        fs::write(
            target_home.join("config.toml"),
            r#"# target comment
default_model = "old/default"

[providers.shared]
type = "anthropic"
api_key = "TARGET_SECRET"

[providers.kiki_only]
type = "openai"

[models.shared]
provider = "shared"
model = "old-model"

[models.kiki_only]
provider = "kiki_only"
model = "keep-model"

[thinking]
enabled = false

[mcp.kiki]
command = "keep-me"

[agents]
enabled = false
"#,
        )
        .unwrap();

        let first = import_config_homes(&source_home, &target_home).unwrap();
        assert_eq!(first.status, "imported");
        assert_eq!(
            first.updated_categories,
            vec![
                "providers",
                "models",
                "services",
                "default_model",
                "default_provider",
                "thinking",
                "secondary_model",
            ]
        );
        let imported = fs::read_to_string(target_home.join("config.toml")).unwrap();
        assert!(imported.contains("# target comment"));
        assert!(imported.contains("[providers.kiki_only]"));
        assert!(imported.contains("[providers.source_only]"));
        assert!(imported.contains("SOURCE_SECRET"));
        assert!(!imported.contains("TARGET_SECRET"));
        assert!(imported.contains("[models.kiki_only]"));
        assert!(imported.contains("source-model"));
        assert!(imported.contains("[mcp.kiki]"));
        assert!(imported.contains("[agents]"));
        assert!(!imported.contains("[mcp.secret]"));

        let second = import_config_homes(&source_home, &target_home).unwrap();
        assert!(
            second.updated_categories.is_empty(),
            "updated categories: {:?}",
            second.updated_categories
        );
        assert_eq!(second.status, "noop");
        assert_eq!(
            fs::read_to_string(target_home.join("config.toml")).unwrap(),
            imported
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_missing_target_and_preserves_categories_absent_from_source() {
        let root = temp_root("missing-target");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        fs::create_dir_all(&source_home).unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"[providers.kimi]
type = "kimi"

[hooks]
enabled = true
"#,
        )
        .unwrap();

        let result = import_config_homes(&source_home, &target_home).unwrap();
        assert_eq!(result.status, "imported");
        assert_eq!(result.updated_categories, vec!["providers"]);
        let imported = fs::read_to_string(target_home.join("config.toml")).unwrap();
        assert!(imported.contains("[providers.kimi]"));
        assert!(!imported.contains("[hooks]"));

        fs::write(
            target_home.join("config.toml"),
            r#"default_provider = "keep"
[thinking]
enabled = false
[permission]
mode = "manual"
"#,
        )
        .unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"default_model = "new/model"
[not_allowed]
value = "ignored"
"#,
        )
        .unwrap();
        let result = import_config_homes(&source_home, &target_home).unwrap();
        assert_eq!(result.updated_categories, vec!["default_model"]);
        let imported = fs::read_to_string(target_home.join("config.toml")).unwrap();
        assert!(imported.contains("default_provider = \"keep\""));
        assert!(imported.contains("[thinking]"));
        assert!(imported.contains("[permission]"));
        assert!(!imported.contains("[not_allowed]"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_without_allowlisted_categories_is_noop() {
        let root = temp_root("noop");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        fs::create_dir_all(&source_home).unwrap();
        fs::write(
            source_home.join("config.toml"),
            "[mcp.example]\ncommand = \"ignored\"\n",
        )
        .unwrap();

        let plan = plan_config_import_homes(&source_home, &target_home).unwrap();
        assert!(!plan.has_changes());
        let result = apply_config_import(plan).unwrap();
        assert_eq!(result.status, "noop");
        assert!(!target_home.join("config.toml").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activation_failure_restores_target_and_reports_compensation_failure_without_values() {
        let root = temp_root("compensation");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("config.toml");
        let temporary = root.join("temporary.toml");
        let backup = root.join("backup.toml");
        fs::write(&target, "api_key = \"ORIGINAL_SECRET\"\n").unwrap();
        fs::write(&temporary, "api_key = \"NEW_SECRET\"\n").unwrap();
        let mut calls = 0;
        let restored = activate_atomic(&target, &temporary, &backup, |from, to| {
            calls += 1;
            match calls {
                1 => fs::rename(from, to),
                2 => Err(io::Error::other("activation failed")),
                3 => fs::rename(from, to),
                _ => unreachable!(),
            }
        })
        .unwrap_err();
        assert!(restored.contains("activation failed"));
        assert!(restored.contains("original target was restored"));
        assert!(!restored.contains("ORIGINAL_SECRET"));
        assert!(!restored.contains("NEW_SECRET"));
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "api_key = \"ORIGINAL_SECRET\"\n"
        );

        fs::write(&temporary, "api_key = \"NEW_SECRET\"\n").unwrap();
        calls = 0;
        let partial = activate_atomic(&target, &temporary, &backup, |from, to| {
            calls += 1;
            match calls {
                1 => fs::rename(from, to),
                2 => Err(io::Error::other("activation failed")),
                3 => Err(io::Error::other("compensation failed")),
                _ => unreachable!(),
            }
        })
        .unwrap_err();
        assert!(partial.contains("Partial Kiki config import"));
        assert!(partial.contains("activation failed"));
        assert!(partial.contains("compensation failed"));
        assert!(!partial.contains("ORIGINAL_SECRET"));
        assert!(!partial.contains("NEW_SECRET"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parse_errors_do_not_echo_secret_values() {
        let root = temp_root("parse-error");
        let source = root.join("source.toml");
        let target = root.join("target.toml");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, "api_key = \"SECRET_VALUE\n").unwrap();
        let error = plan_config_import(&source, &target).err().unwrap();
        assert!(error.contains("Cannot parse Kimi config"));
        assert!(!error.contains("SECRET_VALUE"));
        fs::remove_dir_all(root).unwrap();
    }
}
