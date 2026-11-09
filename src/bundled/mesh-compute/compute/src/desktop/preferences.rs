//! Donor mesh-sharing.json checkpoints, bound to the selected viewer and community.
use super::sharing::Share;
use std::{io::Write, path::PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Config {
    pub viewer: String,
    pub community: String,
    pub model: String,
    pub max_vram_gb: Option<u64>,
    pub enabled: bool,
    #[serde(default)]
    pub auto: bool,
}
impl Config {
    pub fn pending(viewer: String, community: String, share: &Share) -> Self {
        Self {
            viewer,
            community,
            model: share.model.clone(),
            max_vram_gb: share.max_vram_gb,
            enabled: false,
            auto: false,
        }
    }
}

// Preserve older/unparseable checkpoints; only the bound schema can restore consent.
fn checkpoint_path(path: PathBuf) -> Result<PathBuf, String> {
    match std::fs::read(&path) {
        Ok(bytes) if serde_json::from_slice::<Config>(&bytes).is_ok() => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        _ => Ok(path.with_file_name("mesh-sharing-viewer.json")),
    }
}

#[derive(Default)]
pub(super) struct Preferences {
    path: Option<PathBuf>,
    config: Option<Config>,
    selected: Option<(String, String)>,
    error: Option<String>,
}
impl Preferences {
    pub fn initialize(&mut self, path: Result<PathBuf, String>) {
        match path.and_then(checkpoint_path).and_then(|path| {
            let config = match std::fs::read(&path) {
                Ok(bytes) => {
                    let mut config: Config = serde_json::from_slice(&bytes)
                        .map_err(|e| format!("Invalid Mesh sharing settings: {e}"))?;
                    let legacy = serde_json::from_slice::<serde_json::Value>(&bytes)
                        .map_err(|e| e.to_string())?
                        .get("auto")
                        .is_none();
                    if legacy {
                        config.auto = crate::catalog::is_legacy_recommendation(&config.model);
                    }
                    config.model =
                        crate::catalog::canonical_curated_model_id(&config.model).to_owned();
                    if config.viewer.is_empty()
                        || config.community.is_empty()
                        || config.model.is_empty()
                        || config.max_vram_gb == Some(0)
                    {
                        return Err("Invalid Mesh sharing settings".into());
                    }
                    Some(config)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("Could not read Mesh sharing settings: {error}")),
            };
            Ok((path, config))
        }) {
            Ok((path, config)) => {
                self.path = Some(path);
                self.config = config;
            }
            Err(error) => self.error = Some(error),
        }
    }
    pub fn viewer_changed(&self, viewer: &str) -> bool {
        self.selected
            .as_ref()
            .is_some_and(|(selected, _)| selected != viewer)
    }
    // A revoked lease is not a pristine launch: prior consumers may still need cleanup.
    pub fn requires_retirement(&self, bound: Option<&str>, community: &str, viewer: &str) -> bool {
        self.viewer_changed(viewer)
            || bound.is_some_and(|current| current != community)
            || (bound.is_none() && self.selected.is_some())
    }
    pub fn select(&mut self, viewer: String, community: String) {
        self.selected = Some((viewer, community));
    }
    pub fn hint(&self) -> Option<&Config> {
        self.config.as_ref().filter(|config| {
            self.selected.as_ref() == Some(&(config.viewer.clone(), config.community.clone()))
        })
    }
    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
    }
    pub fn clear_runtime_error(&mut self) {
        if self.error.as_ref().is_some_and(|error| {
            error.starts_with("Shared compute could not restart after membership changed:")
        }) {
            self.error = None;
        }
    }
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    pub fn checkpoint(&mut self, config: Config) -> Result<(), String> {
        let result = self.write(&config);
        match result {
            Ok(()) => {
                self.config = Some(config);
                self.error = None;
                Ok(())
            }
            Err(error) => {
                self.error = Some(error.clone());
                Err(error)
            }
        }
    }
    fn write(&self, config: &Config) -> Result<(), String> {
        let path = self
            .path
            .as_ref()
            .ok_or("Mesh settings storage unavailable")?;
        let parent = path.parent().ok_or("Mesh settings directory unavailable")?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create Mesh settings directory: {e}"))?;
        let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
        // Same atomic tempfile/rename pattern as agent-controller; never truncate the old file.
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| {
                "Mesh settings were replaced but durability is uncertain; reload before retrying"
            })?;
        Ok(())
    }
    pub fn disarm(&mut self) -> Result<(), String> {
        if let Some(mut config) = self.hint().cloned() {
            config.enabled = false;
            self.checkpoint(config)?;
        }
        Ok(())
    }
    pub fn phase(
        &mut self,
        expected: &Config,
        phase: &crate::lifecycle::Phase,
        reached_ready: bool,
    ) -> Result<(), String> {
        if self.hint().is_none_or(|current| {
            current.viewer != expected.viewer
                || current.community != expected.community
                || current.model != expected.model
                || current.max_vram_gb != expected.max_vram_gb
        }) {
            return Ok(());
        }
        // Normal shutdown deliberately leaves enabled armed for restore through Mesh.
        if *phase == crate::lifecycle::Phase::Ready
            || (matches!(phase, crate::lifecycle::Phase::Failed(_)) && !reached_ready)
        {
            let mut config = self.hint().cloned().ok_or("Mesh selection expired")?;
            config.enabled = *phase == crate::lifecycle::Phase::Ready;
            self.checkpoint(config)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn first_selection_preserves_restore_but_revoked_binding_requires_retirement() {
        let mut prefs = super::Preferences::default();
        assert!(!prefs.requires_retirement(None, "a", "viewer"));
        prefs.select("viewer".into(), "a".into());
        assert!(!prefs.requires_retirement(Some("a"), "a", "viewer"));
        assert!(prefs.requires_retirement(Some("a"), "b", "viewer"));
        // Revocation removed the lease, not proof that all old consumers stopped.
        assert!(prefs.requires_retirement(None, "b", "viewer"));
        assert!(prefs.requires_retirement(None, "a", "viewer"));
        assert!(prefs.requires_retirement(Some("a"), "a", "other-viewer"));
    }

    use super::*;
    use crate::lifecycle::Phase;
    fn config() -> Config {
        Config::pending(
            "viewer".into(),
            "https://fixture.example".into(),
            &Share {
                model: "fixture".into(),
                max_vram_gb: None,
            },
        )
    }
    fn store(path: PathBuf) -> Preferences {
        let mut store = Preferences::default();
        store.initialize(Ok(path));
        store.select("viewer".into(), "https://fixture.example".into());
        store
    }
    #[test]
    fn ready_arms_quit_preserves_failed_disarms_and_model_hint_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let mut prefs = store(path.clone());
        prefs.checkpoint(config()).unwrap();
        assert!(!store(path.clone()).hint().unwrap().enabled);
        prefs.phase(&config(), &Phase::Ready, false).unwrap();
        prefs.phase(&config(), &Phase::Stopped, false).unwrap();
        assert!(store(path.clone()).hint().unwrap().enabled);
        prefs
            .phase(&config(), &Phase::Failed("runtime crash".into()), true)
            .unwrap();
        assert!(store(path.clone()).hint().unwrap().enabled);
        prefs
            .phase(&config(), &Phase::Failed("load failed".into()), false)
            .unwrap();
        let reopened = store(path.clone());
        assert!(!reopened.hint().unwrap().enabled);
        assert_eq!(reopened.hint().unwrap().model, "fixture");
        prefs.phase(&config(), &Phase::Ready, false).unwrap();
        prefs.disarm().unwrap();
        assert!(!store(path).hint().unwrap().enabled);
    }
    #[test]
    fn different_viewer_or_community_cannot_restore_or_rearm_old_intent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let mut prefs = store(path);
        prefs.checkpoint(config()).unwrap();
        for (viewer, community) in [
            ("other", "https://fixture.example"),
            ("viewer", "https://other.example"),
        ] {
            prefs.select(viewer.into(), community.into());
            assert!(prefs.hint().is_none());
            prefs.phase(&config(), &Phase::Ready, false).unwrap();
            assert!(!prefs.config.as_ref().unwrap().enabled);
        }
    }
    #[test]
    fn failed_write_preserves_prior_checkpoint_and_old_model_cannot_arm_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let mut prefs = store(path.clone());
        prefs.checkpoint(config()).unwrap();
        let mut replacement = config();
        replacement.model = "replacement".into();
        prefs.checkpoint(replacement.clone()).unwrap();
        prefs.phase(&config(), &Phase::Ready, false).unwrap();
        assert!(!store(path.clone()).hint().unwrap().enabled);
        assert_eq!(store(path.clone()).hint().unwrap().model, "replacement");
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        prefs.path = Some(blocked.join("mesh-sharing.json"));
        assert!(prefs.phase(&replacement, &Phase::Ready, false).is_err());
        assert!(!prefs.hint().unwrap().enabled);
        assert!(!store(path).hint().unwrap().enabled);
    }
    #[test]
    fn donor_settings_are_preserved_and_never_bind_or_resume_without_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let legacy = br#"{"enabled":true,"startOnNextLaunch":true,"modelId":"old","maxVramGb":null,"relayUrl":"wss://fixture.example"}"#;
        std::fs::write(&path, legacy).unwrap();
        let mut prefs = store(path.clone());
        assert!(prefs.error().is_none());
        assert!(prefs.hint().is_none());
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert!(!dir.path().join("mesh-sharing-viewer.json").exists());
        prefs.checkpoint(config()).unwrap();
        prefs.phase(&config(), &Phase::Ready, false).unwrap();
        assert!(store(path.clone()).hint().unwrap().enabled);
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        let mut other = store(path);
        other.select("someone-else".into(), "https://fixture.example".into());
        assert!(other.hint().is_none());
    }

    #[test]
    fn empty_legacy_and_older_shapes_allow_explicit_sharing_without_modifying_source() {
        for bytes in [
            r#"{"enabled":false,"startOnNextLaunch":false,"modelId":"","maxVramGb":null,"relayUrl":null}"#,
            r#"{"enabled":false,"modelId":"old","maxVramGb":null}"#,
            "{invalid",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("mesh-sharing.json");
            std::fs::write(&path, bytes).unwrap();
            let mut prefs = store(path.clone());
            assert!(prefs.hint().is_none());
            assert!(prefs.error().is_none());
            prefs.checkpoint(config()).unwrap();
            assert_eq!(std::fs::read_to_string(path).unwrap(), bytes);
        }
    }

    #[test]
    fn invalid_settings_and_failed_write_do_not_silently_arm() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        std::fs::write(&path, b"{invalid").unwrap();
        let mut prefs = store(path);
        assert!(prefs.error().is_none());
        assert!(prefs.hint().is_none());
        prefs.checkpoint(config()).unwrap();
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let mut prefs = store(blocked.join("mesh-sharing.json"));
        assert!(prefs.checkpoint(config()).is_err());
        assert!(prefs.hint().is_none());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::Preferences;
    #[test]
    fn reconnect_clears_runtime_error_without_hiding_storage_failure() {
        let mut prefs = Preferences::default();
        prefs.set_error("Shared compute could not restart after membership changed: offline. Reconnect to retry.".into());
        prefs.clear_runtime_error();
        assert!(prefs.error().is_none());
        prefs.set_error("Could not write sharing settings".into());
        prefs.clear_runtime_error();
        assert_eq!(prefs.error(), Some("Could not write sharing settings"));
    }
}

#[cfg(test)]
mod auto_tests {
    use super::*;
    #[test]
    fn legacy_curated_models_become_auto_but_custom_and_explicit_overrides_do_not() {
        for (model, expected) in [
            ("unsloth/gemma-4-E4B-it-GGUF:Q4_K_M", true),
            ("unsloth/Qwen3.5-9B-GGUF:Q4_K_M", true),
            ("unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", true),
            ("unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL", true),
            ("/models/local.gguf", false),
            ("other/model:Q4", false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("mesh-sharing.json");
            let legacy = serde_json::json!({"viewer":"viewer", "community":"https://fixture.example", "model":model, "maxVramGb":null, "enabled":false});
            std::fs::write(&path, legacy.to_string()).unwrap();
            let mut prefs = Preferences::default();
            prefs.initialize(Ok(path.clone()));
            prefs.select("viewer".into(), "https://fixture.example".into());
            assert_eq!(prefs.hint().unwrap().auto, expected, "{model}");
            assert!(!prefs.hint().unwrap().enabled);
            // Migration is read-only until the next explicit settings write.
            assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy.to_string());
            let mut explicit = prefs.hint().unwrap().clone();
            explicit.auto = false;
            prefs.checkpoint(explicit).unwrap();
            let mut reopened = Preferences::default();
            reopened.initialize(Ok(path));
            reopened.select("viewer".into(), "https://fixture.example".into());
            assert!(!reopened.hint().unwrap().auto);
        }
    }
    #[test]
    fn runtime_checkpoint_cannot_undo_a_reset_to_auto() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let mut prefs = Preferences::default();
        prefs.initialize(Ok(path.clone()));
        prefs.select("viewer".into(), "https://fixture.example".into());
        let config = Config::pending(
            "viewer".into(),
            "https://fixture.example".into(),
            &Share {
                model: "custom".into(),
                max_vram_gb: None,
            },
        );
        prefs.checkpoint(config.clone()).unwrap();
        let mut reset = config.clone();
        reset.auto = true;
        prefs.checkpoint(reset).unwrap();
        prefs
            .phase(&config, &crate::lifecycle::Phase::Ready, false)
            .unwrap();
        assert!(prefs.hint().unwrap().auto);
        assert!(prefs.hint().unwrap().enabled);
        let mut reopened = Preferences::default();
        reopened.initialize(Ok(path));
        reopened.select("viewer".into(), "https://fixture.example".into());
        assert!(reopened.hint().unwrap().auto);
        assert_eq!(reopened.hint().unwrap().model, "custom");
    }
}
