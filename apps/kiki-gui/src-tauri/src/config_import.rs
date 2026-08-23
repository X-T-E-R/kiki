use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use toml_edit::{DocumentMut, Item, Table};

pub const IMPORT_CATEGORIES: [&str; 9] = [
    "providers",
    "models",
    "services",
    "default_model",
    "default_provider",
    "thinking",
    "secondary_model",
    "disabled_builtin_profiles",
    "disabled_named_profiles",
];

const MAP_CATEGORIES: [&str; 3] = ["providers", "models", "services"];
const REPLACE_CATEGORIES: [&str; 6] = [
    "default_model",
    "default_provider",
    "thinking",
    "secondary_model",
    "disabled_builtin_profiles",
    "disabled_named_profiles",
];
const COGNITION_SLOTS: [&str; 3] = ["overlay", "steering", "anchor"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigImportResult {
    pub status: &'static str,
    pub source: String,
    pub target: String,
    pub updated_categories: Vec<String>,
}

#[derive(Clone, Debug)]
struct CognitionAsset {
    relative: PathBuf,
    needs_copy: bool,
}

pub struct ConfigImportPlan {
    source_home: PathBuf,
    target_home: PathBuf,
    source_path: PathBuf,
    target_path: PathBuf,
    updated_categories: Vec<String>,
    cognition_assets: Vec<CognitionAsset>,
    rendered: Option<String>,
}

impl ConfigImportPlan {
    pub fn has_changes(&self) -> bool {
        self.rendered.is_some() || self.cognition_assets.iter().any(|asset| asset.needs_copy)
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
    plan_config_import_with_homes(
        source_home,
        target_home,
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
    let source_home = source_path.parent().ok_or_else(|| {
        format!(
            "Kimi config source {} has no parent directory",
            source_path.display()
        )
    })?;
    let target_home = target_path.parent().ok_or_else(|| {
        format!(
            "Kiki config target {} has no parent directory",
            target_path.display()
        )
    })?;
    plan_config_import_with_homes(source_home, target_home, source_path, target_path)
}

fn plan_config_import_with_homes(
    source_home: &Path,
    target_home: &Path,
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
    let source_value = toml::from_str::<toml::Value>(&source_raw).map_err(|_| {
        format!(
            "Cannot parse Kimi config at {} as TOML",
            source_path.display()
        )
    })?;
    let cognition_assets = collect_cognition_assets(&source_value, source_home, target_home)?;
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

    for category in REPLACE_CATEGORIES {
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
        source_home: source_home.to_path_buf(),
        target_home: target_home.to_path_buf(),
        source_path: source_path.to_path_buf(),
        target_path: target_path.to_path_buf(),
        updated_categories,
        cognition_assets,
        rendered,
    })
}

pub fn apply_config_import(plan: ConfigImportPlan) -> Result<ConfigImportResult, String> {
    apply_config_import_with_rename(plan, |from, to| fs::rename(from, to))
}

fn apply_config_import_with_rename(
    plan: ConfigImportPlan,
    rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<ConfigImportResult, String> {
    let result = plan.result();
    let mut writes: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for asset in &plan.cognition_assets {
        let content = read_cognition_asset(&plan.source_home, &asset.relative)?;
        ensure_target_asset_confined(&plan.target_home, &asset.relative)?;
        let target = plan.target_home.join(&asset.relative);
        let target_matches = fs::read(&target).is_ok_and(|existing| existing == content);
        if !target_matches {
            if writes
                .iter()
                .any(|(existing, _)| paths_collide(existing, &target))
            {
                return Err(format!(
                    "Multiple cognition assets resolve to the same Kiki target {}",
                    target.display()
                ));
            }
            writes.push((target, content));
        }
    }
    if let Some(rendered) = plan.rendered {
        if writes
            .iter()
            .any(|(target, _)| paths_collide(target, &plan.target_path))
        {
            return Err(format!(
                "A cognition asset collides with the Kiki config target {}",
                plan.target_path.display()
            ));
        }
        writes.push((plan.target_path.clone(), rendered.into_bytes()));
    }

    let mut staged = Vec::with_capacity(writes.len());
    for (target, content) in writes {
        match stage_write(&target, &content) {
            Ok(write) => staged.push(write),
            Err(error) => {
                cleanup_staged_writes(&staged);
                return Err(error);
            }
        }
    }
    activate_staged_writes(&mut staged, rename)?;
    Ok(result)
}

fn collect_cognition_assets(
    source: &toml::Value,
    source_home: &Path,
    target_home: &Path,
) -> Result<Vec<CognitionAsset>, String> {
    let mut references = BTreeSet::new();
    let Some(models) = source.get("models").and_then(toml::Value::as_table) else {
        return Ok(Vec::new());
    };
    for (model_name, model) in models {
        let Some(cognition) = model
            .as_table()
            .and_then(|model| model.get("cognition"))
            .and_then(toml::Value::as_table)
        else {
            continue;
        };
        for slot in COGNITION_SLOTS {
            let Some(value) = cognition.get(slot) else {
                continue;
            };
            match value {
                toml::Value::String(reference) => {
                    references.insert(normalize_cognition_reference(reference)?);
                }
                toml::Value::Array(values) => {
                    for value in values {
                        let Some(reference) = value.as_str() else {
                            return Err(format!(
                                "Kimi model {model_name} cognition.{slot} must contain only string paths"
                            ));
                        };
                        references.insert(normalize_cognition_reference(reference)?);
                    }
                }
                _ => {
                    return Err(format!(
                        "Kimi model {model_name} cognition.{slot} must be a string path or an array of string paths"
                    ))
                }
            }
        }
    }

    references
        .into_iter()
        .map(|relative| {
            let content = read_cognition_asset(source_home, &relative)?;
            ensure_target_asset_confined(target_home, &relative)?;
            let target = target_home.join(&relative);
            let needs_copy = !fs::read(&target).is_ok_and(|existing| existing == content);
            Ok(CognitionAsset {
                relative,
                needs_copy,
            })
        })
        .collect()
}

fn normalize_cognition_reference(reference: &str) -> Result<PathBuf, String> {
    let bytes = reference.as_bytes();
    let looks_like_windows_absolute =
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if reference.starts_with('/') || reference.starts_with('\\') || looks_like_windows_absolute {
        return Err(format!(
            "Cognition asset reference {reference:?} must be relative to the selected Kimi Home"
        ));
    }
    let portable = reference.replace('\\', "/");
    let mut normalized = PathBuf::new();
    for component in Path::new(&portable).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!(
                        "Cognition asset reference {reference:?} escapes the selected Kimi Home"
                    ));
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!(
                    "Cognition asset reference {reference:?} must be relative to the selected Kimi Home"
                ))
            }
        }
    }
    let Some(first) = normalized.components().next() else {
        return Err("Cognition asset reference must name a file".to_string());
    };
    if first
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case("credentials")
    {
        return Err("Cognition assets cannot be imported from credentials".to_string());
    }
    if normalized.components().count() == 1
        && first
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("config.toml")
    {
        return Err("Cognition assets cannot target the Kiki config.toml".to_string());
    }
    Ok(normalized)
}

fn paths_collide(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        let left = left.to_string_lossy();
        let right = right.to_string_lossy();
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn read_cognition_asset(source_home: &Path, relative: &Path) -> Result<Vec<u8>, String> {
    let canonical_home = fs::canonicalize(source_home).map_err(|error| {
        format!(
            "Cannot inspect selected Kimi Home {} for cognition assets: {error}",
            source_home.display()
        )
    })?;
    let source = source_home.join(relative);
    let canonical_source = fs::canonicalize(&source).map_err(|error| {
        format!(
            "Cannot read referenced cognition asset {}: {error}",
            source.display()
        )
    })?;
    if !canonical_source.starts_with(&canonical_home) {
        return Err(format!(
            "Referenced cognition asset {} escapes the selected Kimi Home",
            source.display()
        ));
    }
    if canonical_path_is_in_credentials(&canonical_home, &canonical_source) {
        return Err(format!(
            "Referenced cognition asset {} resolves inside credentials",
            source.display()
        ));
    }
    let metadata = fs::metadata(&canonical_source).map_err(|error| {
        format!(
            "Cannot inspect referenced cognition asset {}: {error}",
            source.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Referenced cognition asset {} is not a regular file",
            source.display()
        ));
    }
    fs::read(&canonical_source).map_err(|error| {
        format!(
            "Cannot read referenced cognition asset {}: {error}",
            source.display()
        )
    })
}

fn ensure_target_asset_confined(target_home: &Path, relative: &Path) -> Result<(), String> {
    if !target_home.exists() {
        return Ok(());
    }
    let canonical_home = fs::canonicalize(target_home).map_err(|error| {
        format!(
            "Cannot inspect Kiki Home {} for cognition assets: {error}",
            target_home.display()
        )
    })?;
    let target = target_home.join(relative);
    let mut existing = target.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or_else(|| {
            format!(
                "Cognition asset target {} has no existing parent directory",
                target.display()
            )
        })?;
    }
    let canonical_existing = fs::canonicalize(existing).map_err(|error| {
        format!(
            "Cannot inspect cognition asset target {}: {error}",
            target.display()
        )
    })?;
    if !canonical_existing.starts_with(&canonical_home) {
        return Err(format!(
            "Cognition asset target {} escapes Kiki Home",
            target.display()
        ));
    }
    if canonical_path_is_in_credentials(&canonical_home, &canonical_existing) {
        return Err(format!(
            "Cognition asset target {} resolves inside credentials",
            target.display()
        ));
    }
    match fs::symlink_metadata(&target) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!(
                "Cognition asset target {} is not a regular file",
                target.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Cannot inspect cognition asset target {}: {error}",
                target.display()
            ));
        }
    }
    Ok(())
}

fn canonical_path_is_in_credentials(canonical_home: &Path, canonical_path: &Path) -> bool {
    canonical_path
        .strip_prefix(canonical_home)
        .ok()
        .and_then(|relative| relative.components().next())
        .is_some_and(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("credentials")
        })
}

struct StagedWrite {
    target: PathBuf,
    temporary: PathBuf,
    backup: PathBuf,
    had_target: bool,
    original_staged: bool,
    activated: bool,
}

fn stage_write(target: &Path, content: &[u8]) -> Result<StagedWrite, String> {
    let parent = target.parent().ok_or_else(|| {
        format!(
            "Kiki import target {} has no parent directory",
            target.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot prepare Kiki import directory {}: {error}",
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
                "Cannot create temporary Kiki import file {}: {error}",
                temporary.display()
            )
        })?;
    if let Err(error) = file.write_all(content).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Cannot write temporary Kiki import file {}: {error}",
            temporary.display()
        ));
    }
    drop(file);
    Ok(StagedWrite {
        target: target.to_path_buf(),
        temporary,
        backup,
        had_target: target.exists(),
        original_staged: false,
        activated: false,
    })
}

fn activate_staged_writes(
    staged: &mut [StagedWrite],
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    for index in 0..staged.len() {
        if staged[index].had_target {
            if let Err(error) = rename(&staged[index].target, &staged[index].backup) {
                return Err(compensate_failed_activation(
                    staged,
                    &mut rename,
                    format!(
                        "Cannot stage existing Kiki import target from {} to {}: {error}",
                        staged[index].target.display(),
                        staged[index].backup.display()
                    ),
                ));
            }
            staged[index].original_staged = true;
        }
        if let Err(error) = rename(&staged[index].temporary, &staged[index].target) {
            return Err(compensate_failed_activation(
                staged,
                &mut rename,
                format!(
                    "Cannot activate Kiki import from {} to {}: {error}",
                    staged[index].temporary.display(),
                    staged[index].target.display()
                ),
            ));
        }
        staged[index].activated = true;
    }
    for write in staged {
        if write.original_staged {
            let _ = fs::remove_file(&write.backup);
        }
    }
    Ok(())
}

fn compensate_failed_activation(
    staged: &mut [StagedWrite],
    rename: &mut impl FnMut(&Path, &Path) -> std::io::Result<()>,
    activation_error: String,
) -> String {
    let compensation_errors = rollback_staged_writes(staged, rename);
    if compensation_errors.is_empty() {
        format!("{activation_error}; all earlier target changes were restored")
    } else {
        format!(
            "Partial Kiki config import: {activation_error}; compensation also failed: {}",
            compensation_errors.join("; ")
        )
    }
}

fn rollback_staged_writes(
    staged: &mut [StagedWrite],
    rename: &mut impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Vec<String> {
    let mut errors = Vec::new();
    for write in staged.iter_mut().rev() {
        if write.activated {
            if let Err(error) = fs::remove_file(&write.target) {
                errors.push(format!(
                    "cannot remove imported target {}: {error}",
                    write.target.display()
                ));
            }
        }
        if write.original_staged {
            if let Err(error) = rename(&write.backup, &write.target) {
                errors.push(format!(
                    "cannot restore original target {}: {error}",
                    write.target.display()
                ));
            }
        }
        if let Err(error) = fs::remove_file(&write.temporary) {
            if error.kind() != std::io::ErrorKind::NotFound {
                errors.push(format!(
                    "cannot remove staged import file {}: {error}",
                    write.temporary.display()
                ));
            }
        }
    }
    errors
}

fn cleanup_staged_writes(staged: &[StagedWrite]) {
    for write in staged {
        let _ = fs::remove_file(&write.temporary);
    }
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

    #[cfg(windows)]
    fn create_dir_link(target: &Path, link: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cannot create test junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn create_dir_link(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
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
disabled_builtin_profiles = ["explore", "reviewer"]
disabled_named_profiles = ["local-agent"]

[providers.shared]
type = "openai"
api_key = "SOURCE_SECRET"

[providers.shared.oauth]
storage = "file"
key = "oauth/kimi-code"

[providers.source_only]
type = "kimi"

[models.shared]
provider = "shared"
model = "source-model"

[services.web]
url = "https://source.example.test"

[services.web.oauth]
storage = "file"
key = "oauth/kimi-code"

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
        fs::create_dir_all(source_home.join("credentials")).unwrap();
        fs::write(
            source_home.join("credentials").join("kimi-code.json"),
            "CREDENTIAL_FILE_MUST_NOT_BE_COPIED",
        )
        .unwrap();
        fs::write(
            target_home.join("config.toml"),
            r#"# target comment
default_model = "old/default"
disabled_builtin_profiles = ["agent"]
disabled_named_profiles = ["old-local"]

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
                "disabled_builtin_profiles",
                "disabled_named_profiles",
            ]
        );
        let imported = fs::read_to_string(target_home.join("config.toml")).unwrap();
        assert!(imported.contains("# target comment"));
        assert!(imported.contains("[providers.kiki_only]"));
        assert!(imported.contains("[providers.source_only]"));
        assert!(imported.contains("SOURCE_SECRET"));
        assert!(!imported.contains("TARGET_SECRET"));
        assert!(imported.contains("[providers.shared.oauth]"));
        assert!(imported.contains("[services.web.oauth]"));
        assert!(!target_home.join("credentials").exists());
        assert!(imported.contains("[models.kiki_only]"));
        assert!(imported.contains("source-model"));
        assert!(imported.contains("[mcp.kiki]"));
        assert!(imported.contains("[agents]"));
        assert!(!imported.contains("[mcp.secret]"));
        let imported_value = toml::from_str::<toml::Value>(&imported).unwrap();
        assert_eq!(
            imported_value["disabled_builtin_profiles"],
            toml::Value::Array(vec![
                toml::Value::String("explore".to_string()),
                toml::Value::String("reviewer".to_string()),
            ])
        );
        assert_eq!(
            imported_value["disabled_named_profiles"],
            toml::Value::Array(vec![toml::Value::String("local-agent".to_string())])
        );

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
disabled_builtin_profiles = ["keep-builtin"]
disabled_named_profiles = ["keep-named"]
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
        assert!(imported.contains("disabled_builtin_profiles = [\"keep-builtin\"]"));
        assert!(imported.contains("disabled_named_profiles = [\"keep-named\"]"));
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
    fn imports_cognition_assets_with_config_and_is_idempotent() {
        let root = temp_root("cognition-success");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        let source_assets = source_home.join("cognition");
        fs::create_dir_all(&source_assets).unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"[models.shared]
provider = "shared"
model = "source-model"

[models.shared.cognition]
overlay = "cognition/overlay.md"
steering = ["cognition/steering-a.md", "cognition/steering-b.md"]
anchor = ["cognition/anchor-a.md", "cognition/anchor-b.md"]

[models.second]
provider = "shared"
model = "second-model"

[models.second.cognition]
overlay = ["cognition/overlay.md", "cognition/steering-a.md"]
"#,
        )
        .unwrap();
        for (name, content) in [
            ("overlay.md", "OVERLAY"),
            ("steering-a.md", "STEERING A"),
            ("steering-b.md", "STEERING B"),
            ("anchor-a.md", "ANCHOR A"),
            ("anchor-b.md", "ANCHOR B"),
        ] {
            fs::write(source_assets.join(name), content).unwrap();
        }

        let first = import_config_homes(&source_home, &target_home).unwrap();
        assert_eq!(first.status, "imported");
        for (name, content) in [
            ("overlay.md", "OVERLAY"),
            ("steering-a.md", "STEERING A"),
            ("steering-b.md", "STEERING B"),
            ("anchor-a.md", "ANCHOR A"),
            ("anchor-b.md", "ANCHOR B"),
        ] {
            assert_eq!(
                fs::read_to_string(target_home.join("cognition").join(name)).unwrap(),
                content
            );
        }
        assert!(fs::read_to_string(target_home.join("config.toml"))
            .unwrap()
            .contains("second-model"));

        let second = import_config_homes(&source_home, &target_home).unwrap();
        assert_eq!(second.status, "noop");
        assert!(second.updated_categories.is_empty());
        assert_eq!(
            fs::read_to_string(target_home.join("cognition/anchor-b.md")).unwrap(),
            "ANCHOR B"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_config_activation_restores_assets_and_config() {
        let root = temp_root("transaction-compensation");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        let source_assets = source_home.join("cognition");
        let target_assets = target_home.join("cognition");
        fs::create_dir_all(&source_assets).unwrap();
        fs::create_dir_all(&target_assets).unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"[models.shared]
provider = "shared"
model = "source-model"

[models.shared.cognition]
overlay = ["cognition/existing.md", "cognition/new.md"]
"#,
        )
        .unwrap();
        fs::write(source_assets.join("existing.md"), b"NEW EXISTING").unwrap();
        fs::write(source_assets.join("new.md"), b"NEW FILE").unwrap();
        fs::write(target_assets.join("existing.md"), b"ORIGINAL ASSET").unwrap();
        let config_target = target_home.join("config.toml");
        fs::write(&config_target, b"default_model = \"original/model\"\n").unwrap();

        let plan = plan_config_import_homes(&source_home, &target_home).unwrap();
        let mut injected = false;
        let error = apply_config_import_with_rename(plan, |from, to| {
            let is_config_activation = to == config_target
                && from
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with(".tmp"));
            if !injected && is_config_activation {
                injected = true;
                Err(io::Error::other("injected config activation failure"))
            } else {
                fs::rename(from, to)
            }
        })
        .unwrap_err();

        assert!(injected);
        assert!(error.contains("injected config activation failure"));
        assert!(error.contains("all earlier target changes were restored"));
        assert_eq!(
            fs::read(target_assets.join("existing.md")).unwrap(),
            b"ORIGINAL ASSET"
        );
        assert!(!target_assets.join("new.md").exists());
        assert_eq!(
            fs::read(&config_target).unwrap(),
            b"default_model = \"original/model\"\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cognition_references_reject_escape_absolute_credentials_and_missing_files() {
        let root = temp_root("cognition-invalid-paths");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        fs::create_dir_all(&source_home).unwrap();
        fs::create_dir_all(&target_home).unwrap();
        fs::write(root.join("outside.md"), "OUTSIDE").unwrap();
        fs::create_dir_all(source_home.join("credentials")).unwrap();
        fs::write(source_home.join("credentials/secret.md"), "SECRET").unwrap();
        let target_config = target_home.join("config.toml");
        fs::write(&target_config, "default_model = \"keep/model\"\n").unwrap();

        for (reference, expected) in [
            ("../outside.md", "escapes"),
            ("..\\outside.md", "escapes"),
            ("/absolute.md", "must be relative"),
            ("C:\\absolute.md", "must be relative"),
            (
                "credentials/secret.md",
                "cannot be imported from credentials",
            ),
            (
                "cognition/missing.md",
                "Cannot read referenced cognition asset",
            ),
        ] {
            fs::write(
                source_home.join("config.toml"),
                format!(
                    "[models.shared]\nprovider = \"shared\"\nmodel = \"source-model\"\n[models.shared.cognition]\nanchor = '{reference}'\n"
                ),
            )
            .unwrap();
            let error = plan_config_import_homes(&source_home, &target_home)
                .err()
                .unwrap();
            assert!(
                error.contains(expected),
                "reference {reference:?} returned {error:?}"
            );
            assert_eq!(
                fs::read_to_string(&target_config).unwrap(),
                "default_model = \"keep/model\"\n"
            );
            assert!(!target_home.join("cognition").exists());
        }
        assert_eq!(
            fs::read_to_string(source_home.join("credentials/secret.md")).unwrap(),
            "SECRET"
        );

        fs::create_dir_all(source_home.join("cognition")).unwrap();
        let disappearing = source_home.join("cognition/disappearing.md");
        fs::write(&disappearing, "PRESENT DURING PLAN").unwrap();
        fs::write(
            source_home.join("config.toml"),
            "[models.shared]\nprovider = \"shared\"\nmodel = \"source-model\"\n[models.shared.cognition]\nanchor = \"cognition/disappearing.md\"\n",
        )
        .unwrap();
        let plan = plan_config_import_homes(&source_home, &target_home).unwrap();
        fs::remove_file(&disappearing).unwrap();
        let apply_error = apply_config_import(plan).unwrap_err();
        assert!(apply_error.contains("Cannot read referenced cognition asset"));
        assert_eq!(
            fs::read_to_string(&target_config).unwrap(),
            "default_model = \"keep/model\"\n"
        );
        assert!(!target_home.join("cognition/disappearing.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cognition_config_target_collision_is_rejected_before_writes() {
        let root = temp_root("config-collision");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        fs::create_dir_all(&source_home).unwrap();
        fs::create_dir_all(&target_home).unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"[models.shared]
provider = "shared"
model = "source-model"

[models.shared.cognition]
anchor = "config.toml"
"#,
        )
        .unwrap();
        let config_target = target_home.join("config.toml");
        fs::write(&config_target, b"default_model = \"original/model\"\n").unwrap();

        let error = plan_config_import_homes(&source_home, &target_home)
            .err()
            .unwrap();
        assert!(error.contains("cannot target the Kiki config.toml"));
        assert_eq!(
            fs::read(&config_target).unwrap(),
            b"default_model = \"original/model\"\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cognition_directory_target_is_rejected_without_mutation() {
        let root = temp_root("directory-target");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        let source_assets = source_home.join("cognition");
        let blocked_target = target_home.join("cognition").join("blocked.md");
        fs::create_dir_all(&source_assets).unwrap();
        fs::create_dir_all(&blocked_target).unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"[models.shared]
provider = "shared"
model = "source-model"

[models.shared.cognition]
anchor = "cognition/blocked.md"
"#,
        )
        .unwrap();
        fs::write(source_assets.join("blocked.md"), b"SOURCE ASSET").unwrap();
        fs::write(blocked_target.join("marker.txt"), b"ORIGINAL DIRECTORY").unwrap();
        let config_target = target_home.join("config.toml");
        fs::write(&config_target, b"default_model = \"original/model\"\n").unwrap();

        let error = plan_config_import_homes(&source_home, &target_home)
            .err()
            .unwrap();
        assert!(error.contains("is not a regular file"));
        assert!(blocked_target.is_dir());
        assert_eq!(
            fs::read(blocked_target.join("marker.txt")).unwrap(),
            b"ORIGINAL DIRECTORY"
        );
        assert_eq!(
            fs::read(&config_target).unwrap(),
            b"default_model = \"original/model\"\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_cognition_link_into_credentials_is_rejected_without_mutation() {
        let root = temp_root("source-credentials-link");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        let source_credentials = source_home.join("credentials");
        fs::create_dir_all(&source_credentials).unwrap();
        fs::create_dir_all(&target_home).unwrap();
        fs::write(source_credentials.join("secret.md"), b"CREDENTIAL CONTENT").unwrap();
        create_dir_link(&source_credentials, &source_home.join("cognition"));
        fs::write(
            source_home.join("config.toml"),
            r#"[models.shared]
provider = "shared"
model = "source-model"

[models.shared.cognition]
steering = "cognition/secret.md"
"#,
        )
        .unwrap();
        let config_target = target_home.join("config.toml");
        fs::write(&config_target, b"default_model = \"original/model\"\n").unwrap();

        let error = plan_config_import_homes(&source_home, &target_home)
            .err()
            .unwrap();
        assert!(error.contains("resolves inside credentials"));
        assert_eq!(
            fs::read(&config_target).unwrap(),
            b"default_model = \"original/model\"\n"
        );
        assert!(!target_home.join("cognition").exists());
        assert_eq!(
            fs::read(source_credentials.join("secret.md")).unwrap(),
            b"CREDENTIAL CONTENT"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_cognition_link_into_credentials_is_rejected_without_mutation() {
        let root = temp_root("target-credentials-link");
        let source_home = root.join("kimi");
        let target_home = root.join("kiki");
        let source_assets = source_home.join("cognition");
        let target_credentials = target_home.join("credentials");
        fs::create_dir_all(&source_assets).unwrap();
        fs::create_dir_all(&target_credentials).unwrap();
        fs::write(source_assets.join("asset.md"), b"SOURCE ASSET").unwrap();
        fs::write(
            source_home.join("config.toml"),
            r#"[models.shared]
provider = "shared"
model = "source-model"

[models.shared.cognition]
anchor = "cognition/asset.md"
"#,
        )
        .unwrap();
        fs::write(
            target_credentials.join("marker.txt"),
            b"ORIGINAL CREDENTIAL DIRECTORY",
        )
        .unwrap();
        create_dir_link(&target_credentials, &target_home.join("cognition"));
        let config_target = target_home.join("config.toml");
        fs::write(&config_target, b"default_model = \"original/model\"\n").unwrap();

        let error = plan_config_import_homes(&source_home, &target_home)
            .err()
            .unwrap();
        assert!(error.contains("resolves inside credentials"));
        assert_eq!(
            fs::read(&config_target).unwrap(),
            b"default_model = \"original/model\"\n"
        );
        assert!(!target_credentials.join("asset.md").exists());
        assert_eq!(
            fs::read(target_credentials.join("marker.txt")).unwrap(),
            b"ORIGINAL CREDENTIAL DIRECTORY"
        );
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
