//! Diagnostic stage markers for Mesh startup latency: wall-clock timestamp, stage
//! name and the stage's own duration only. No attempt correlation is claimed, and
//! nothing sensitive (prompts, keys, config, addresses) is ever logged.
use std::time::{SystemTime, UNIX_EPOCH};

/// Log a timestamped stage marker.
pub fn stage(name: &str, detail: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("mesh-startup ts_ms={ts} stage={name} {detail}");
}
