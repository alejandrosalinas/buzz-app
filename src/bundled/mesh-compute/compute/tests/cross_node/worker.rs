//! Child process for tests/cross_node/run.py; never opens the desktop or Keychain.
use anyhow::{bail, Context, Result};
use buzz_mesh_compute::{
    config::{ClientConfig, ServeConfig},
    identity::ensure_owner_at,
    lifecycle::{Lifecycle, Phase},
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    time::Duration,
};

fn main() -> Result<()> {
    let root = PathBuf::from(std::env::var("BUZZ_MESH_TEST_HOME")?);
    anyhow::ensure!(
        root.is_absolute() && root.join("SMOKE_ONLY").is_file(),
        "isolated test home required"
    );
    anyhow::ensure!(
        std::env::var("HOME")? == root.to_string_lossy(),
        "HOME must be isolated"
    );
    anyhow::ensure!(
        std::env::var("BUZZ_MESH_IROH_RELAYS")? == "0",
        "public relays must be disabled"
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let lifecycle = Lifecycle::default();
    // stdin is the bounded parent/child control channel. EOF always requests shutdown.
    let result = (|| -> Result<()> {
        for line in std::io::stdin().lock().lines() {
            let command: Value = serde_json::from_str(&line?)?;
            let response = runtime.block_on(command_reply(&lifecycle, &root, command));
            let response = match response {
                Ok(value) => json!({"ok": value}),
                Err(error) => json!({"error": format!("{error:#}")}),
            };
            println!("BUZZ_SMOKE {}", response);
            std::io::stdout().flush()?;
        }
        Ok(())
    })();
    let stopped = runtime.block_on(lifecycle.stop_and_wait());
    result.and(stopped)
}

async fn command_reply(
    lifecycle: &Lifecycle,
    root: &std::path::Path,
    command: Value,
) -> Result<Value> {
    match command["op"].as_str().context("op required")? {
        "identity" => Ok(json!(ensure_owner_at(&root.join("owner.json"))?)),
        "start" => {
            let port = |name: &str| -> Result<u16> {
                Ok(u16::try_from(
                    command[name].as_u64().context("port required")?,
                )?)
            };
            let node = ClientConfig {
                api_port: port("api_port")?,
                console_port: port("console_port")?,
                owner_key: root.join("owner.json"),
                owner_id: ensure_owner_at(&root.join("owner.json"))?,
                trusted_owners: serde_json::from_value(command["owners"].clone())?,
                mesh_name: Some(command["mesh"].as_str().context("mesh required")?.into()),
                join_token: None,
            };
            if let Some(model) = command["model"].as_str() {
                lifecycle.serve(ServeConfig {
                    node,
                    model: model.into(),
                    max_vram_gb: None,
                })?;
            } else {
                lifecycle.start(node)?;
            }
            tokio::time::timeout(Duration::from_secs(240), async {
                while lifecycle.phase() == Phase::Starting {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await?;
            anyhow::ensure!(
                lifecycle.phase() == Phase::Ready,
                "startup failed: {:?}",
                lifecycle.phase()
            );
            Ok(json!({"serving": lifecycle.is_serving()}))
        }
        "status" => {
            let status = lifecycle.status().await?;
            Ok(
                json!({"payload": status.payload, "invite": status.invite_token, "api": status.api_base_url}),
            )
        }
        "join" => {
            lifecycle.dial(command["token"].as_str().context("token required")?)?;
            Ok(json!(true))
        }
        "stop" => {
            lifecycle.stop_and_wait().await?;
            Ok(json!(true))
        }
        other => bail!("unknown operation {other}"),
    }
}
