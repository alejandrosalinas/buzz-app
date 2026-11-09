//! Native agent identities, signing, credential custody and read-only legacy import.
//! Plugin runtimes own execution; this crate does not launch agent processes.
mod app_agent;
mod config;
#[cfg(any(target_os = "macos", test))]
mod connection;
mod create;
mod credentials;
mod import;
mod legacy;
mod port;
mod profile;
mod secret;

pub use app_agent::{
    bounded, framed, AppAgent, AppAgents, NewAppAgent, Published, Removal, CANVAS_MAX_EVENT_BYTES,
    JOINED, LIVE_CANVAS_BYTES,
};
mod protection;
pub use create::CreationProfile;
pub use credentials::{LegacyHumanError, PlatformCredentials, BUSY as CREDENTIALS_BUSY};
pub use import::LegacySource;
pub use legacy::delete_local_agent_keys;
pub use port::{
    inline_picture, Carry, OldMember, OldStores, OldTeam, PortSource, Portable, Portables,
};
pub use protection::{ProtectionBinding, ProtectionDefaults};
pub use secret::{validate_snapshot_memory_envelope, Credentials, Secret};
type Result<T> = std::result::Result<T, String>;
