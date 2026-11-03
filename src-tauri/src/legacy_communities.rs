//! The relays installed old Buzz saved, read from its WebKit localStorage so the
//! app can add them once. Old Buzz kept its community list only there, outside
//! its data folder. Never written.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

const COMMUNITIES_KEY: &str = "buzz-communities";

/// One saved community: its relay and the identity it was saved for, when
/// old Buzz recorded one.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Saved {
    relay_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pubkey: Option<String>,
}

/// The onboarding-test branch never reads old Buzz, so testers get the
/// new-user path whatever else is installed.
fn root() -> Option<PathBuf> {
    None
}

fn databases(entries: std::fs::ReadDir, found: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        // `file_type` does not follow symlinks, so a link cannot loop the walk.
        let kind = entry.file_type()?;
        if kind.is_dir() {
            databases(std::fs::read_dir(&path)?, found)?;
        } else if kind.is_file() && entry.file_name() == "localstorage.sqlite3" {
            found.push(path);
        }
    }
    Ok(())
}

/// WebKit stores values as UTF-16LE; UTF-8 is the fallback old Buzz's own reader used.
fn decode(bytes: &[u8]) -> Option<String> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    if rest.is_empty() && pairs.iter().any(|pair| pair[1] == 0) {
        let units: Vec<u16> = pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        if let Ok(value) = String::from_utf16(&units) {
            return Some(value.trim_end_matches('\0').to_owned());
        }
    }
    String::from_utf8(bytes.to_vec()).ok()
}

/// Each saved community with a `relayUrl`; a list that is not one reads as empty.
fn read(path: &Path) -> rusqlite::Result<Vec<Saved>> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let value: Option<Vec<u8>> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [COMMUNITIES_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let list = value
        .and_then(|bytes| decode(&bytes))
        .and_then(|text| serde_json::from_str::<Vec<serde_json::Value>>(&text).ok())
        .unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|entry| {
            Some(Saved {
                relay_url: entry.get("relayUrl")?.as_str()?.to_owned(),
                pubkey: entry
                    .get("pubkey")
                    .and_then(|pubkey| pubkey.as_str())
                    .map(str::to_owned),
            })
        })
        .collect())
}

/// Every saved community once, in saved order. Missing storage reads as none;
/// a traversal or database error fails the whole read so the caller retries.
fn read_all(root: &Path) -> Result<Vec<Saved>, String> {
    let mut found = Vec::new();
    let traversal = match std::fs::read_dir(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        entries => entries,
    };
    traversal
        .and_then(|entries| databases(entries, &mut found))
        .map_err(|error| {
            eprintln!(
                "buzz-desktop: legacy communities: {}: {error}",
                root.display()
            );
            "Could not read old Buzz's communities".to_string()
        })?;
    let mut communities = Vec::new();
    for path in found {
        let saved = read(&path).map_err(|error| {
            eprintln!(
                "buzz-desktop: legacy communities: {}: {error}",
                path.display()
            );
            "Could not read old Buzz's communities".to_string()
        })?;
        for community in saved {
            if !communities.contains(&community) {
                communities.push(community);
            }
        }
    }
    Ok(communities)
}

#[tauri::command]
pub(crate) async fn legacy_communities() -> Result<Vec<Saved>, String> {
    tauri::async_runtime::spawn_blocking(|| root().map_or(Ok(vec![]), |root| read_all(&root)))
        .await
        .map_err(|error| error.to_string())?
}
