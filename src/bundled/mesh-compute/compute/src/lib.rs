//! Native Mesh lifecycle owner. The application retains credentials and relay authority.
//!

pub mod activity;
pub mod config;
pub mod desktop;
pub mod identity;
pub mod lease;
pub mod lifecycle;
mod transport_policy;

pub mod discovery;
pub mod discovery_query;
pub mod discovery_types;

pub mod inventory;
pub mod startup_log;

pub mod roster;

pub mod publication;

pub mod catalog;
mod progress;
