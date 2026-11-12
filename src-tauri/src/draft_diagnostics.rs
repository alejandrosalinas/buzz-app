use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::Manager;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Operation {
    Write,
    Notify,
    Storage,
    Persist,
    Saved,
    Changed,
    Failed,
    Load,
    Reconcile,
    Keep,
    UseSaved,
    SendStart,
    SendStartConflict,
    SendUploadConflict,
    SendPrepareConflict,
    SendPublishConflict,
    WriteMismatch,
    SerializeFailed,
    WriteFailed,
    NotifyFailed,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RevisionKind {
    Unreadable,
    Missing,
    Null,
    String,
    Object,
    Other,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Record {
    sequence: u32,
    draft: u32,
    editor: u32,
    operation: Operation,
    expected: Option<RevisionKind>,
    current: Option<RevisionKind>,
    next: Option<RevisionKind>,
    same_expected: Option<bool>,
    same_next: Option<bool>,
    flags: Option<u8>,
}

#[tauri::command]
pub(crate) fn draft_diagnostics_save<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    records: Vec<Record>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Invalid draft diagnostics request".into());
    }
    let directory = app.path().app_log_dir().map_err(|e| e.to_string())?;
    save(&directory, &app.package_info().version.to_string(), records)
}

fn save(directory: &std::path::Path, version: &str, records: Vec<Record>) -> Result<(), String> {
    if records.is_empty() || records.len() > 100 {
        return Err("Invalid draft diagnostics count".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": version,
        "process": std::process::id(),
        "captured": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?.as_secs(),
        "records": records,
    }))
    .map_err(|e| e.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(directory.join("draft-diagnostics.json"))
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Record {
        serde_json::from_value(serde_json::json!({
            "sequence": 1, "draft": 2, "editor": 3, "operation": "changed",
            "expected": "object", "current": "string", "next": "object",
            "sameExpected": false, "sameNext": false, "flags": 1
        }))
        .unwrap()
    }

    #[test]
    fn saves_bounded_metadata_and_replaces_the_previous_trace() {
        let directory = tempfile::tempdir().unwrap();
        save(directory.path(), "1.2.3", vec![record(), record()]).unwrap();
        save(directory.path(), "1.2.4", vec![record()]).unwrap();
        let path = directory.path().join("draft-diagnostics.json");
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], "1.2.4");
        assert_eq!(saved["records"].as_array().unwrap().len(), 1);
        assert_eq!(saved["records"][0]["operation"], "changed");
        assert_eq!(saved["records"][0]["sameExpected"], false);
        assert!(save(
            directory.path(),
            "1.2.4",
            (0..101).map(|_| record()).collect()
        )
        .is_err());
        assert!(save(directory.path(), "1.2.4", vec![]).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rejects_content_and_free_text_at_the_native_boundary() {
        let mut value = serde_json::to_value(record()).unwrap();
        value["text"] = "private draft".into();
        assert!(serde_json::from_value::<Record>(value).is_err());
        let mut value = serde_json::to_value(record()).unwrap();
        value["operation"] = "private draft".into();
        assert!(serde_json::from_value::<Record>(value).is_err());
        let mut value = serde_json::to_value(record()).unwrap();
        value["current"] = "private draft".into();
        assert!(serde_json::from_value::<Record>(value).is_err());
    }
}
