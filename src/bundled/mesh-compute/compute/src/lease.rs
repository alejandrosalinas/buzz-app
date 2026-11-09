//! Native fencing of host-UI intent, not native active-community state.
use std::sync::Mutex;

#[derive(Default)]
pub struct Lease(Mutex<Option<(String, String)>>);
impl Lease {
    pub fn current(&self) -> Result<Option<(String, String)>, String> {
        self.0
            .lock()
            .map(|current| current.clone())
            .map_err(|_| "Mesh selection unavailable".into())
    }

    pub fn for_community(&self, community: &str) -> Result<String, String> {
        let current = self.0.lock().map_err(|_| "Mesh selection unavailable")?;
        current
            .as_ref()
            .filter(|(_, selected)| selected == community)
            .map(|(id, _)| id.clone())
            .ok_or_else(|| "Enable Shared compute in the agent’s community first".into())
    }

    #[cfg(test)]
    pub fn select(&self, community: String) -> Result<String, String> {
        self.select_with(community, || {})
    }
    #[cfg(test)]
    pub fn select_with(&self, community: String, changed: impl FnOnce()) -> Result<String, String> {
        self.try_select_with(community, false, || {
            changed();
            Ok(())
        })
    }
    pub fn try_select_with(
        &self,
        community: String,
        force_change: bool,
        changed: impl FnOnce() -> Result<(), String>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut current = self.0.lock().map_err(|_| "Mesh lease unavailable")?;
        let same = current
            .as_ref()
            .is_some_and(|(_, previous)| previous == &community);
        if !same || force_change {
            changed()?;
        }
        *current = Some((id.clone(), community));
        Ok(id)
    }
    pub fn community(&self, id: &str) -> Result<String, String> {
        self.with_current(id, |community| Ok(community.to_owned()))
    }
    pub fn with_current<T>(
        &self,
        id: &str,
        action: impl FnOnce(&str) -> Result<T, String>,
    ) -> Result<T, String> {
        let current = self.0.lock().map_err(|_| "Mesh lease unavailable")?;
        let (_, community) = current
            .as_ref()
            .filter(|(key, _)| key == id)
            .ok_or("Mesh selection expired")?;
        action(community)
    }
    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let mut current = self.0.lock().map_err(|_| "Mesh lease unavailable")?;
        if current.as_ref().is_some_and(|(key, _)| key == id) {
            *current = None;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub fn restore(&self, previous: Option<(String, String)>) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "Mesh selection unavailable")?;
        if current.is_none() {
            *current = previous;
        }
        Ok(())
    }
    pub fn clear(&self) {
        if let Ok(mut current) = self.0.lock() {
            *current = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[test]
    fn failed_replacement_restores_owner_but_never_overwrites_newer_selection() {
        let lease = Lease::default();
        let old = lease.select("https://a.example".into()).unwrap();
        let prior = lease.current().unwrap();
        lease.clear();
        lease.restore(prior.clone()).unwrap();
        assert_eq!(lease.for_community("https://a.example").unwrap(), old);
        lease.clear();
        let new = lease.select("https://b.example".into()).unwrap();
        lease.restore(prior).unwrap();
        assert_eq!(lease.for_community("https://b.example").unwrap(), new);
        assert!(lease.for_community("https://a.example").is_err());
    }

    #[tokio::test]
    async fn revoked_discovery_cannot_commit_a_start() {
        let lease = Arc::new(Lease::default());
        let id = lease.select("https://fixture.example".into()).unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let (entered, observed) = tokio::sync::oneshot::channel();
        let (release, gate) = tokio::sync::oneshot::channel();
        let task = {
            let lease = lease.clone();
            let id = id.clone();
            let started = started.clone();
            tokio::spawn(async move {
                lease.community(&id)?;
                entered.send(()).unwrap();
                gate.await.unwrap();
                lease.with_current(&id, |_| {
                    started.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        observed.await.unwrap();
        assert!(lease.revoke(&id).unwrap());
        release.send(()).unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!started.load(Ordering::SeqCst));
    }
    #[test]
    fn changing_community_fences_old_start_and_old_cleanup() {
        let lease = Lease::default();
        let old = lease.select("https://old.example".into()).unwrap();
        let new = lease.select("https://new.example".into()).unwrap();
        assert!(lease.community(&old).is_err());
        assert!(!lease.revoke(&old).unwrap());
        assert_eq!(lease.community(&new).unwrap(), "https://new.example");
    }
    #[test]
    fn forced_identity_change_stops_same_community_and_failed_checkpoint_keeps_selection() {
        let lease = Lease::default();
        let old = lease.select("https://same.example".into()).unwrap();
        let changed = AtomicBool::new(false);
        let new = lease
            .try_select_with("https://same.example".into(), true, || {
                changed.store(true, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();
        assert!(changed.load(Ordering::SeqCst));
        assert!(lease.community(&old).is_err());
        assert!(lease
            .try_select_with("https://other.example".into(), false, || Err(
                "disk failed".into()
            ))
            .is_err());
        assert_eq!(lease.community(&new).unwrap(), "https://same.example");
    }
    #[test]
    fn same_community_rotates_lease_without_stopping() {
        let lease = Lease::default();
        let old = lease.select("https://same.example".into()).unwrap();
        let new = lease
            .select_with("https://same.example".into(), || panic!("must not stop"))
            .unwrap();
        assert_ne!(old, new);
        assert!(!lease.revoke(&old).unwrap());
        assert!(lease.community(&new).is_ok());
    }
}

#[cfg(test)]
mod agent_selection_tests {
    use super::*;
    #[test]
    fn agent_can_only_use_the_current_plugin_selection() {
        let lease = Lease::default();
        assert!(lease.for_community("https://one.example").is_err());
        let selected = lease.select("https://one.example".into()).unwrap();
        assert_eq!(
            lease.for_community("https://one.example").unwrap(),
            selected
        );
        assert!(lease.for_community("https://two.example").is_err());
        lease.revoke(&selected).unwrap();
        assert!(lease
            .with_current(&selected, |_| -> Result<(), String> {
                panic!("revoked selection cannot spawn")
            })
            .is_err());
    }
}
