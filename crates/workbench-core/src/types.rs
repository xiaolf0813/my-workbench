//! Frozen shared contract for workbench-core (PLAN.md §4 "Core API").
//!
//! Data types every port lane compiles against. Lane-local types live in the
//! lane's own module; changes to this file go through the orchestrator.
//! UI-facing structs serialize as camelCase for the Tauri bridge.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------------------------------------------------------- targets

/// The six install targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Opencode,
    Omos,
    Claude,
    Zcode,
    Dsh,
    Openbitfun,
}

/// Fixed apply order, identical to the CLI:
/// opencode → omos → claude → zcode → dsh → openbitfun.
pub const APPLY_ORDER: [Target; 6] = [
    Target::Opencode,
    Target::Omos,
    Target::Claude,
    Target::Zcode,
    Target::Dsh,
    Target::Openbitfun,
];

// -------------------------------------------------------- source & selection

/// Content source mode (PLAN.md §4 "two modes"). `Bundled` resolves through
/// [`EngineContext::bundled_root`]; `Local` carries the user-chosen root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Source {
    Bundled,
    Local {
        root: PathBuf,
    },
}

/// The GUI's install control state, mirroring the CLI flag matrix
/// (`--opencode`/`--omos` mutex, `--user`, `--force`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub source: Source,
    /// Project directory for project-level targets (the GUI's directory
    /// picker). User-level-only selections (zcode) ignore it but it is
    /// always present; the source-repo guard compares against it.
    pub project_dir: PathBuf,
    /// Must not contain both `Opencode` and `Omos`; must not be empty.
    pub targets: Vec<Target>,
    pub user_level: bool,
    pub force: bool,
}

// ---------------------------------------------------------- engine context

/// Host-provided environment facts. The host (Tauri shell or a test) resolves
/// the bundled resource dir; this crate never locates Tauri resources itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineContext {
    /// Project directory — the CLI's CWD equivalent.
    pub project_dir: PathBuf,
    /// User home — the `os.homedir()` equivalent.
    pub home: PathBuf,
    /// Absolute path to the directory CONTAINING the bundled `agents/` tree
    /// (the Tauri resource dir in the shell; the repo root in tests). The
    /// ported `load_roster` joins `agents/…` under it, mirroring the CLI's
    /// `PKG_ROOT`.
    pub bundled_root: PathBuf,
    /// Version stamps are written with this (the crate's own `VERSION` in
    /// production; golden tests pin it to keep byte-identity with the CLI).
    pub version: String,
}

impl EngineContext {
    /// Effective source root for this selection.
    pub fn source_root(&self, source: &Source) -> PathBuf {
        match source {
            Source::Bundled => self.bundled_root.clone(),
            Source::Local { root } => root.clone(),
        }
    }
}

// ------------------------------------------------------------ plan / report

/// One planned file operation. `plan` performs zero writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub target: Target,
    /// Absolute destination path.
    pub path: PathBuf,
    /// Source-relative origin, for display.
    pub source_rel: String,
    pub kind: PlanKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanKind {
    Create,
    Skip,
    Overwrite,
    /// The DSH `cordis.patch.yml` managed block would be added or rewritten;
    /// an already-identical block is reported as a note, not an item.
    ManagedBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StampRealm {
    /// `<project>/my-workbench.version` for project-level deploys.
    Project,
    /// `~/.my-workbench.version` for user-level deploys.
    Home,
}

/// A version-stamp write. Stamps are always applied — never skip/force-gated
/// and never subject to dry-run suppression of the plan itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampPlan {
    pub realm: StampRealm,
    pub path: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub items: Vec<PlanItem>,
    pub stamps: Vec<StampPlan>,
    /// Plan-time notes: prerequisite risks, unchanged/skipped managed blocks,
    /// omos-over-existing-agents warnings, install next-notes.
    pub notes: Vec<String>,
}

/// Per-module outcome — one target's (e.g. DSH's) contribution to a
/// [`Plan`] / [`InstallReport`], forwarded opaquely by the engine.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleOutcome {
    pub items: Vec<PlanItem>,
    pub notes: Vec<String>,
    pub created: usize,
    pub skipped: usize,
    pub overwritten: usize,
    pub managed_blocks: usize,
}

// ---------------------------------------------------------------- events

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// Events streamed during `execute`; the Tauri shell forwards them to the
/// frontend as `install-log` / `install-progress` (PLAN.md §4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum InstallEvent {
    Started { total_files: usize },
    Log {
        time_ms: u64,
        target: Option<Target>,
        level: LogLevel,
        text: String,
    },
    Progress {
        phase: String,
        done: usize,
        total: usize,
    },
    Finished { cancelled: bool },
}

/// Event outlet + cooperative cancellation, implemented by the host. The
/// engine polls `is_cancelled()` only between file operations, never
/// mid-file (design decision 1: stop before the next file).
pub trait EventSink: Send + Sync {
    fn emit(&self, event: InstallEvent);
    fn is_cancelled(&self) -> bool {
        false
    }
}

/// Final `execute` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub cancelled: bool,
    pub created: usize,
    pub skipped: usize,
    pub overwritten: usize,
    pub managed_blocks: usize,
    pub stamps: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

// --------------------------------------------------------- drift & health

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftFile {
    /// Installed file that differs from its fresh render.
    pub path: PathBuf,
    pub source_rel: String,
    pub target: Target,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralProblem {
    /// Check name, matching the CLI's function names
    /// (`agentSourceProblems`, `lanePluginProblems`, `laneUiPluginProblems`).
    pub check: String,
    pub detail: String,
}

/// Tier 1 — always available, pure Rust: render byte-compare plus every
/// structural check (PLAN.md §4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier1Report {
    pub compared: usize,
    pub drifted: Vec<DriftFile>,
    pub problems: Vec<StructuralProblem>,
}

/// Tier 2 execution happens in the host shell (local Node, lock 6 — the
/// crate never spawns processes). The shell renders the three execution-state
/// artifacts via the crate, runs Node, and reports back through this shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier2Report {
    pub status: Tier2Status,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier2Status {
    Pass,
    Skipped,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub tier1: Tier1Report,
    /// `None` when the host did not run Tier 2 for this check.
    pub tier2: Option<Tier2Report>,
}

// -------------------------------------------------------- environment info

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub present: bool,
    pub version: Option<String>,
}

/// DSH detection (design decision 5): home, where it came from, existence,
/// the single profile the managed-block row would target, candidate count.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshInfo {
    pub home: PathBuf,
    pub home_source: DshHomeSource,
    pub exists: bool,
    pub profile: Option<String>,
    pub profiles_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DshHomeSource {
    Env,
    Default,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBitFunInfo {
    pub config_dir: PathBuf,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub home: PathBuf,
    /// Version of the embedded content source (the crate's `VERSION`) —
    /// surfaced in the GUI About / health-check page (PLAN §2 version
    /// alignment).
    pub source_version: String,
    pub opencode: ToolStatus,
    pub node: ToolStatus,
    /// User-level omos present (the CLI's `omosUserLevelPresent` heuristics).
    pub omos_user_level: bool,
    pub dsh: DshInfo,
    pub openbitfun: OpenBitFunInfo,
    /// Per-target advisory status dots — inform-only, never a gate
    /// (design decision 4).
    pub targets: Vec<TargetStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    pub target: Target,
    pub detail: String,
}

// ------------------------------------------------------- DSH lane record

/// One authored lane from `agents/backends/dsh/lanes.json`, in file order.
/// Shared by the render module (JS generation) and the DSH module
/// (validation + install); field names mirror the JSON exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneRecord {
    pub key: String,
    pub tool: String,
    pub zh: String,
    pub deny_writes: bool,
    pub deny_shell: bool,
    pub recommended: RecommendedRoute,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedRoute {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: String,
}
