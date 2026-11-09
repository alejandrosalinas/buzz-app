//! What the desktop app lends the Mesh plugin: the signed-in identity and its
//! authenticated relay client. Keys never leave the app.
use std::{future::Future, pin::Pin, sync::Arc};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// An unsigned event for the app identity to sign.
pub struct EventTemplate {
    pub kind: u16,
    pub created_at: u64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
}

pub trait AppIdentity: Send + Sync + 'static {
    /// The signed-in user's public key.
    fn viewer(&self) -> BoxFuture<'_, Result<String, String>>;
    /// Signs Mesh member status as the signed-in user; hosts reject other kinds.
    fn sign(&self, event: EventTemplate) -> BoxFuture<'_, Result<serde_json::Value, String>>;
    /// Authenticated relay read: NIP-11 with no filter, else one `/query` filter.
    fn relay_read<'a>(
        &'a self,
        community: &'a str,
        filter: Option<serde_json::Value>,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>>;
    /// Publishes an event this identity signed.
    fn relay_publish<'a>(
        &'a self,
        community: &'a str,
        event: serde_json::Value,
    ) -> BoxFuture<'a, Result<(), String>>;
}

pub type Identity = Arc<dyn AppIdentity>;

/// Relay access requires an HTTPS origin without credentials or a path.
pub fn relay_origin(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid relay origin")?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Relay access requires an HTTPS origin without credentials or a path".into());
    }
    Ok(())
}

/// A signed-in viewer with no keys or relay, for tests.
#[cfg(test)]
pub struct FixtureIdentity(pub String);

#[cfg(test)]
impl AppIdentity for FixtureIdentity {
    fn viewer(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
    fn sign(&self, _: EventTemplate) -> BoxFuture<'_, Result<serde_json::Value, String>> {
        Box::pin(async { Err("fixture cannot sign".into()) })
    }
    fn relay_read<'a>(
        &'a self,
        _: &'a str,
        _: Option<serde_json::Value>,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(async { Err("fixture has no relay".into()) })
    }
    fn relay_publish<'a>(
        &'a self,
        _: &'a str,
        _: serde_json::Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("fixture has no relay".into()) })
    }
}
