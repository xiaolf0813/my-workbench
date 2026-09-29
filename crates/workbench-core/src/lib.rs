//! my-workbench core engine — pure Rust port of the Node CLI engine plus the
//! skill manager, usable by the Tauri shell, tests and any other host.
//!
//! Port contract, milestones and golden-test rules live in
//! `docs/desktop/PLAN.md` (§3 DSH split, §4 core API, §6 golden gate).
//! This crate must never depend on `tauri`.

/// Crate version, mirrored from `Cargo.toml`; surfaced in the GUI About /
/// health-check page so the embedded source version is visible.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod checks;
pub mod dsh;
pub mod dsh_deps;
pub mod engine;
pub mod error;
pub mod render;
pub mod roster;
pub mod skills;
pub mod types;

pub use error::WorkbenchError;
