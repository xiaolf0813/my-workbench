//! Shared error type for the workbench-core engine (fleshed out in M1).

/// Errors surfaced by the ported engine.
#[derive(Debug, thiserror::Error)]
pub enum WorkbenchError {
    /// Filesystem failures.
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// JSON (de)serialization failures.
    #[error(transparent)]
    Json(#[from] serde_json::Error),

    /// Plain message carrying the context itself.
    #[error("{0}")]
    Message(String),
}
