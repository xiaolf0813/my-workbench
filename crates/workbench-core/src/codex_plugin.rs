//! Offline Subagent Config deployment plus registration through the official
//! `codex plugin` CLI. My Workbench never edits Codex's plugin state directly.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::WorkbenchError;

pub const MARKETPLACE_DIR: &str = "my-workbench-plugin-marketplace";
pub const MARKETPLACE_NAME: &str = "my-workbench";
pub const PLUGIN_NAME: &str = "subagent-config";
pub const PLUGIN_ID: &str = "subagent-config@my-workbench";

const PLUGIN_FILES: &[&str] = &[
    "plugin.json",
    "mcp.json",
    "runtime/server.mjs",
    "runtime/component.html",
];

/// Bundled source files and their marketplace-relative destinations. These are
/// owned deployment artifacts and therefore refresh on every Codex deployment.
pub fn bundled_files(source_root: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, WorkbenchError> {
    let backend = source_root.join("agents/backends/codex");
    let mut files = vec![(
        PathBuf::from(".agents/plugins/marketplace.json"),
        std::fs::read(
            backend.join("subagent-config-marketplace/.agents/plugins/marketplace.json"),
        )?,
    )];
    for rel in PLUGIN_FILES {
        files.push((
            Path::new("plugins").join(PLUGIN_NAME).join(rel),
            std::fs::read(backend.join("subagent-config").join(rel))?,
        ));
    }
    Ok(files)
}

fn codex_program() -> std::ffi::OsString {
    // Integration/golden tests need a deterministic fake and must never touch
    // the developer's real Codex installation. Production leaves this unset.
    std::env::var_os("MY_WORKBENCH_TEST_CODEX_BIN").unwrap_or_else(|| "codex".into())
}

fn run(root: &Path, args: &[&str]) -> std::io::Result<Output> {
    let mut command = Command::new(codex_program());
    if let Some(script) = std::env::var_os("MY_WORKBENCH_TEST_CODEX_SCRIPT") {
        command.arg(script);
    }
    command.args(args).env("CODEX_HOME", root);
    if root.is_dir() {
        command.current_dir(root);
    }
    command.output()
}

fn output_detail(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else {
        stdout
    }
}

pub fn check_prerequisites(root: &Path) -> Result<(), WorkbenchError> {
    let node = Command::new("node").arg("--version").output().map_err(|_| {
        WorkbenchError::Message(
            "ChatGPT / Codex deployment requires Node.js on PATH for the bundled Subagent Config plugin"
                .to_string(),
        )
    })?;
    if !node.status.success() {
        return Err(WorkbenchError::Message(
            "ChatGPT / Codex deployment requires Node.js on PATH for the bundled Subagent Config plugin"
                .to_string(),
        ));
    }

    let output = run(root, &["plugin", "--help"]).map_err(|_| {
        WorkbenchError::Message(
            "ChatGPT / Codex deployment requires a Codex CLI with 'codex plugin' support on PATH"
                .to_string(),
        )
    })?;
    if !output.status.success() {
        return Err(WorkbenchError::Message(
            "ChatGPT / Codex deployment requires a Codex CLI with 'codex plugin' support on PATH"
                .to_string(),
        ));
    }
    Ok(())
}

fn checked_run(root: &Path, args: &[&str]) -> Result<(), WorkbenchError> {
    let output = run(root, args).map_err(|err| {
        WorkbenchError::Message(format!("codex {} failed: {err}", args.join(" ")))
    })?;
    if output.status.success() {
        return Ok(());
    }
    let detail = output_detail(&output);
    Err(WorkbenchError::Message(format!(
        "codex {} failed{}",
        args.join(" "),
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )))
}

pub fn add_marketplace(root: &Path, marketplace_root: &Path) -> Result<(), WorkbenchError> {
    let marketplace = marketplace_root.to_string_lossy();
    checked_run(
        root,
        &["plugin", "marketplace", "add", &marketplace, "--json"],
    )
}

pub fn add_plugin(root: &Path) -> Result<(), WorkbenchError> {
    checked_run(root, &["plugin", "add", PLUGIN_ID, "--json"])
}
