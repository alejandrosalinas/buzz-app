//! Host side of the bundled Mesh plugin (`src/bundled/mesh-compute/compute`):
//! lends it the signed-in identity and the authenticated relay client.
use crate::{identity, relay};
use buzz_mesh_compute::desktop::host::{AppIdentity, BoxFuture, EventTemplate, Identity};

pub(crate) use buzz_mesh_compute::desktop::MeshHost;

struct AppHost(identity::IdentityHost);

impl AppIdentity for AppHost {
    fn viewer(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(self.0.viewer())
    }
    /// Signs Mesh member status only; the plugin gets no general signing.
    fn sign(&self, event: EventTemplate) -> BoxFuture<'_, Result<serde_json::Value, String>> {
        if u64::from(event.kind) != buzz_mesh_compute::discovery_types::MESH_STATUS_KIND {
            return Box::pin(async { Err("Mesh may only sign its status event".into()) });
        }
        Box::pin(self.0.sign(identity::EventTemplate {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
        }))
    }
    fn relay_read<'a>(
        &'a self,
        community: &'a str,
        filter: Option<serde_json::Value>,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(relay::plugin_read(&self.0, community, filter))
    }
    fn relay_publish<'a>(
        &'a self,
        community: &'a str,
        event: serde_json::Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(relay::plugin_publish(&self.0, community, event))
    }
}

pub(crate) fn identity(host: identity::IdentityHost) -> Identity {
    std::sync::Arc::new(AppHost(host))
}

/// Loads saved sharing preferences from app data.
pub(crate) fn setup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    app.state::<MeshHost>().initialize_preferences(
        app.path()
            .app_data_dir()
            .map(|root| root.join("mesh-sharing.json"))
            .map_err(|error| error.to_string()),
    );
}

/// The plugin's `mesh_compute_*` commands, routed by prefix in `lib.rs`.
pub(crate) fn commands() -> fn(tauri::ipc::Invoke<tauri::Wry>) -> bool {
    use buzz_mesh_compute::desktop::{self as mesh, agent, sharing, widget};
    tauri::generate_handler![
        mesh::mesh_compute_inventory,
        mesh::mesh_compute_status,
        mesh::mesh_compute_stop,
        mesh::mesh_compute_catalog,
        mesh::mesh_compute_start,
        mesh::mesh_compute_select,
        mesh::mesh_compute_release,
        mesh::mesh_compute_disarm,
        widget::mesh_compute_widget_open,
        widget::mesh_compute_widget_close,
        widget::mesh_compute_widget_status,
        sharing::mesh_compute_share,
        agent::mesh_compute_prepare_inference,
        agent::mesh_compute_inference_current,
        agent::mesh_compute_chat
    ]
}
