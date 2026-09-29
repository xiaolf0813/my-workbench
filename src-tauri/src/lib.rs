//! Tauri 2 shell for the my-workbench desktop GUI.
//!
//! IPC wiring only — all deployment/skill business logic lives in
//! `workbench-core` (see `docs/desktop/PLAN.md` §2). This file implements the
//! M1 command surface over the ported engine (`docs/desktop/PLAN.md` §4):
//!
//! - `detect_environment` — engine detection, enriched with real
//!   `opencode --version` / `node --version` probes (the crate never spawns
//!   processes; all process work lives here).
//! - `plan_install` — the zero-write plan phase.
//! - `execute_install` — the plan replay, run off the main thread via
//!   `spawn_blocking`, with the engine's [`EventSink`] bridged to the
//!   `install-log` / `install-progress` frontend channels and a cooperative
//!   cancel flag (`cancel_install`).
//! - `cancel_install` — sets the cooperative cancel flag; harmless when idle.
//! - `check_drift` — engine Tier 1 plus the Tier 2 execution-state checks run
//!   through the local Node (lock 6: absent Node → explicit skip, never a
//!   block).
//! - `validate_custom_source` — the deliberately stricter custom-source
//!   pre-install validation (structural checks + Tier 2 on the custom
//!   source's rendered DSH artifacts).
//!
//! M2 (PLAN.md §5) adds the skill-management surface, all over
//! `workbench_core::skills`:
//!
//! - `skills_list_sources` / `skills_add_source` / `skills_update_source` /
//!   `skills_remove_source` — the configured `owner/repo` source list,
//!   persisted together with the settings in
//!   `<app_config_dir>/settings.json` (atomic tmp+rename writes).
//! - `settings_get` / `settings_set` — `AppSettings` (skill root, default
//!   `<home>/.agents/skills`, and the UI language).
//! - `skills_list_installed` / `skills_list_remote` — the offline manifest
//!   listing and the cached remote listing
//!   (`<app_cache_dir>/skills-listings.json`, one entry per source key;
//!   `refresh=true` re-fetches and overwrites; errors are never masked with
//!   stale cache data).
//! - `skills_check_update` / `skills_install` / `skills_update` /
//!   `skills_delete` — the network/mutating surface; install/update run on
//!   `spawn_blocking` with the core's events bridged to the `skill-progress`
//!   channel and a shared `SkillsState` guard rejecting concurrent
//!   operations.
//! - `pat_status` / `pat_set` / `pat_clear` — GitHub PAT in the OS keyring
//!   (`my-workbench` / `github-pat`); the token never round-trips to the
//!   frontend, never appears in logs or errors, and is never written to disk.
//!
//! Error surfacing: every command rejects with a single-line message string;
//! the frontend's `describeIpcError` renders it directly.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use workbench_core::skills::{
    self, InstalledSkill, SkillChange, SkillListing, SkillSource, UreqGitHubClient,
};
use workbench_core::types::{
    DriftReport, EngineContext, EnvironmentInfo, EventSink, InstallEvent, InstallReport, LogLevel,
    Plan, Selection, StructuralProblem, Tier1Report, Tier2Report, Tier2Status,
};
use workbench_core::{checks, dsh, engine, render, WorkbenchError};

// ---------------------------------------------------------------- constants

/// `opencode --version` / `node --version` probe budget.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Per-check budget for the Tier 2 Node subprocesses.
const TIER2_TIMEOUT: Duration = Duration::from_secs(10);

/// The three authored JS files the CLI parse-checks (`bin/my-workbench.js`
/// :1494-1505), relative to the source root. Two of them are byte-copied into
/// the rendered tree and the third is the render template, so checking the
/// authored bytes is exactly the CLI's `assemble --check` semantics.
const SYNTAX_FILES: [&str; 3] = [
    "agents/backends/dsh/lane-plugin/host-package/src/index.js",
    "agents/backends/dsh/lane-plugin-ui/src/index.js",
    "agents/backends/dsh/lane-plugin-ui/lib/client.js",
];

/// Source-relative dir of the lane settings page package.
const LANE_UI_DIR: &str = "agents/backends/dsh/lane-plugin-ui";

// ------------------------------------------------------------ error helpers

/// Force an error string onto one line for the IPC promise rejection (the
/// frontend renders it inside a banner).
fn single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn error_message(err: WorkbenchError) -> String {
    single_line(&err.to_string())
}

// --------------------------------------------------------------- subprocess

/// One finished subprocess's captured state.
struct ProcessOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Result of one bounded subprocess run.
enum RunOutcome {
    Finished(ProcessOutput),
    /// Killed after the deadline elapsed.
    TimedOut,
    /// The program is not on PATH.
    NotFound,
    /// Any other spawn failure, with its message.
    Spawn(String),
}

/// No console flash on Windows: CREATE_NO_WINDOW (0x08000000).
fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Drain a pipe on its own thread so a chatty child can never deadlock the
/// deadline poller.
fn drain_pipe<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
        }
        buf
    })
}

/// Run `cmd` with piped stdio, killing it after `timeout`. The 20ms poll keeps
/// cancellation latency low; killing the child closes the pipes, so the
/// reader threads always finish.
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> RunOutcome {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(cmd);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == ErrorKind::NotFound => return RunOutcome::NotFound,
        Err(e) => return RunOutcome::Spawn(single_line(&e.to_string())),
    };
    let stdout = drain_pipe(child.stdout.take());
    let stderr = drain_pipe(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let stdout = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned();
    match status {
        Some(status) => RunOutcome::Finished(ProcessOutput {
            success: status.success(),
            code: status.code(),
            stdout,
            stderr,
        }),
        None => RunOutcome::TimedOut,
    }
}

/// Prefer the child's own diagnostic text; fall back to the exit code.
fn captured_diagnostic(out: &ProcessOutput) -> String {
    let stderr = out.stderr.trim();
    let stdout = out.stdout.trim();
    if !stderr.is_empty() {
        single_line(stderr)
    } else if !stdout.is_empty() {
        single_line(stdout)
    } else {
        match out.code {
            Some(code) => format!("exit {code}"),
            None => "exited".to_string(),
        }
    }
}

/// First non-empty line of `--version` output, or `None` when the probe did
/// not produce a usable answer.
fn probe_version(program: &str) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.arg("--version");
    match run_with_timeout(&mut cmd, VERSION_PROBE_TIMEOUT) {
        RunOutcome::Finished(out) if out.success => {
            let raw = if out.stdout.trim().is_empty() {
                out.stderr.trim()
            } else {
                out.stdout.trim()
            };
            let line = raw.lines().next().unwrap_or("").trim();
            if line.is_empty() {
                None
            } else {
                Some(line.to_string())
            }
        }
        _ => None,
    }
}

// ------------------------------------------------------------- host context

/// The user home (`os.homedir()` equivalent for [`EngineContext::home`]).
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "cannot determine the user home directory".to_string())
}

/// Absolute path to the directory CONTAINING the bundled `agents/` tree.
///
/// Production installers ship `resources: ["../agents"]`, so `agents/` hangs
/// directly below the Tauri resource dir. `tauri dev` and `--no-bundle`
/// builds do not copy bundle resources, so when the resource dir has no
/// `agents/` the repository checkout next to the manifest is used — on an
/// end-user machine that path does not exist and the error surfaces (the
/// installed app always has the resource copy).
fn bundled_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        if resource_dir.join("agents").is_dir() {
            return Ok(resource_dir);
        }
    }
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if repo_root.join("agents").is_dir() {
        return Ok(repo_root);
    }
    Err("bundled agents/ resources not found (neither the resource dir nor the repository checkout contains agents/)".to_string())
}

/// Engine context for this host; the authoritative project dir now arrives via `Selection.project_dir` (deserialized from the frontend), so the `project_dir` resolved below is only a legacy fallback kept for the frozen contract.
fn engine_context(app: &AppHandle) -> Result<EngineContext, String> {
    let home = home_dir()?;
    let project_dir = std::env::current_dir().unwrap_or_else(|_| home.clone());
    let bundled_root = bundled_root(app)?;
    Ok(EngineContext {
        project_dir,
        home,
        bundled_root,
        version: workbench_core::VERSION.to_string(),
    })
}

// ------------------------------------------------------------ event bridge

/// The engine's [`InstallEvent`] re-serialized into the exact camelCase
/// shapes `ui/src/lib/ipc.ts`'s `parseInstallEvent` accepts. The frozen
/// `types.rs` enum only renames variants (`rename_all`), not variant fields,
/// so raw serde output would carry `time_ms` / `total_files` and the
/// frontend's defensive parser would silently drop every event — the shell
/// normalizes here instead of touching the frozen contract.
fn event_payload(event: &InstallEvent) -> Value {
    match event {
        InstallEvent::Started { total_files } => {
            json!({ "event": "started", "totalFiles": total_files })
        }
        InstallEvent::Log {
            time_ms,
            target,
            level,
            text,
        } => json!({
            "event": "log",
            "timeMs": time_ms,
            "target": target,
            "level": level,
            "text": text,
        }),
        InstallEvent::Progress { phase, done, total } => json!({
            "event": "progress",
            "phase": phase,
            "done": done,
            "total": total,
        }),
        InstallEvent::Finished { cancelled } => {
            json!({ "event": "finished", "cancelled": cancelled })
        }
    }
}

/// Bridges the engine's [`EventSink`] to the frontend channels: `Log` events
/// go to `install-log`, everything else (Started / Progress / Finished) to
/// `install-progress`. Cancellation is the shared atomic the
/// `cancel_install` command sets; the engine polls it between files only
/// (design decision 1: stop before the next file).
struct TauriSink {
    app: AppHandle,
    cancel: Arc<AtomicBool>,
}

impl EventSink for TauriSink {
    fn emit(&self, event: InstallEvent) {
        let (channel, payload) = match &event {
            InstallEvent::Log { .. } => ("install-log", event_payload(&event)),
            _ => ("install-progress", event_payload(&event)),
        };
        if let Err(err) = self.app.emit(channel, payload) {
            eprintln!("failed to emit {channel}: {err}");
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

/// Shared install-execution state: `running` rejects a second concurrent
/// execute; `cancel` is the cooperative stop flag the active run observes.
#[derive(Default)]
struct InstallState {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

// -------------------------------------------------------- tier 2: node JS

/// The UI host half check (`laneUiHostProblem`, CLI :938-957) as a `node -e`
/// script. The file path and expected package name arrive via argv (never
/// interpolated into the script text). Prints the CLI's problem text and
/// exits 1 on failure; exits 0 silently when the host half is valid.
const HOST_CHECK_SCRIPT: &str = r#"
const file = process.argv[1];
const expectedName = process.argv[2];
const { pathToFileURL } = require("url");
(async () => {
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    console.log("the host half does not import: " + err.message);
    process.exit(1);
  }
  if (mod.name !== expectedName) {
    console.log("the host half exports name " + JSON.stringify(mod.name) + ", which does not match the package name");
    process.exit(1);
  }
  if (!Array.isArray(mod.inject) || mod.inject.length !== 0) {
    console.log("the host half must inject nothing (got " + JSON.stringify(mod.inject) + "); the profile row must not wait on a service");
    process.exit(1);
  }
  if (typeof mod.apply !== "function") {
    console.log("the host half exports no apply function");
    process.exit(1);
  }
  try {
    const result = mod.apply({});
    if (result !== undefined) {
      console.log("the host half's apply must be inert, but it returned a value");
      process.exit(1);
    }
  } catch (err) {
    console.log("the host half's apply is not inert: " + err.message);
    process.exit(1);
  }
})();
"#;

/// The rendered prompts module check (`lanePromptsProblem`, CLI :1356-1372)
/// as a `node -e` script template. `%B64%` is the base64 of the RENDERED
/// `prompts.generated.js` source (checked from a `data:` URL — the exact
/// rendered bytes, not a re-render); `%KEYS%` is the JSON array of authored
/// lane keys. Prints the CLI's problem text and exits 1 on failure.
const PROMPTS_CHECK_SCRIPT: &str = r#"
const keys = %KEYS%;
(async () => {
  let mod;
  try {
    mod = await import("data:text/javascript;base64,%B64%");
  } catch (err) {
    console.log("the rendered prompt module does not evaluate: " + err.message);
    process.exit(1);
  }
  const prompts = mod.LANE_PROMPTS;
  if (prompts === null || typeof prompts !== "object") {
    console.log("the rendered prompt module exports no LANE_PROMPTS object");
    process.exit(1);
  }
  for (const key of keys) {
    const value = prompts[key];
    if (typeof value !== "string" || value.trim() === "") {
      console.log("lane '" + key + "' has an empty prompt");
      process.exit(1);
    }
  }
  const extra = Object.keys(prompts).filter((key) => !keys.includes(key));
  if (extra.length > 0) {
    console.log("the rendered prompt module carries unknown lane(s): " + extra.join(", "));
    process.exit(1);
  }
})();
"#;

/// Standard base64 (RFC 4648, padded) — implemented locally so the shell adds
/// no new crates.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ------------------------------------------------------------ tier 2 checks

/// True when a runnable `node` answered `node --version` within the probe
/// budget. Any failure here (absent, wedged, non-zero) means Tier 2 cannot
/// run — the locked skip-with-notice behavior, never a block (lock 6).
fn node_available() -> bool {
    let mut cmd = Command::new("node");
    cmd.arg("--version");
    matches!(
        run_with_timeout(&mut cmd, VERSION_PROBE_TIMEOUT),
        RunOutcome::Finished(out) if out.success
    )
}

/// Tier 2, check 1 — `node --check` on the three authored JS files. Parse
/// only: nothing executes, no import resolves (CLI :1343-1348). Failure text
/// carries the file plus the captured SyntaxError output.
fn tier2_syntax_problems(source_root: &Path, problems: &mut Vec<String>) {
    for rel in SYNTAX_FILES {
        let file = source_root.join(rel);
        if !file.is_file() {
            problems.push(format!("{rel} is missing"));
            continue;
        }
        let mut cmd = Command::new("node");
        cmd.arg("--check").arg(&file);
        match run_with_timeout(&mut cmd, TIER2_TIMEOUT) {
            RunOutcome::Finished(out) if out.success => {}
            RunOutcome::Finished(out) => {
                problems.push(format!("{rel}: node --check failed: {}", captured_diagnostic(&out)));
            }
            RunOutcome::TimedOut => {
                problems.push(format!("{rel}: node --check timed out after 10s"));
            }
            RunOutcome::NotFound => {
                problems.push(format!("{rel}: node is no longer runnable"));
            }
            RunOutcome::Spawn(err) => {
                problems.push(format!("{rel}: could not run node: {err}"));
            }
        }
    }
}

/// Tier 2, check 2 — import the lane settings page's host half through the
/// local Node and assert the inert-host contract (CLI :938-957, called at
/// :1480-1487 with `manifest.exports["."]`). The host half is byte-copied
/// into the rendered tree, so importing the authored file is importing the
/// rendered bytes. Skipped silently when the manifest declares no `"."`
/// export, exactly like the CLI.
fn tier2_host_problem(source_root: &Path, problems: &mut Vec<String>) {
    let prefix = "lane-plugin-ui: ";
    let manifest_path = source_root.join(LANE_UI_DIR).join("package.json");
    let manifest_text = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(err) => {
            problems.push(format!("{prefix}{err}"));
            return;
        }
    };
    let manifest: Value = match serde_json::from_str(&manifest_text) {
        Ok(value) => value,
        Err(err) => {
            problems.push(format!("{prefix}{err}"));
            return;
        }
    };
    let Some(name) = manifest.get("name").and_then(Value::as_str) else {
        problems.push(format!("{prefix}package.json declares no name"));
        return;
    };
    // The CLI only imports the host half when exports["."] is a string.
    let Some(host_rel) = manifest
        .get("exports")
        .and_then(|exports| exports.get("."))
        .and_then(Value::as_str)
    else {
        return;
    };
    let host_file = source_root.join(LANE_UI_DIR).join(host_rel);
    if !host_file.is_file() {
        problems.push(format!("{prefix}{host_rel} is missing"));
        return;
    }

    let mut cmd = Command::new("node");
    cmd.arg("-e")
        .arg(HOST_CHECK_SCRIPT)
        .arg(&host_file)
        .arg(name);
    match run_with_timeout(&mut cmd, TIER2_TIMEOUT) {
        RunOutcome::Finished(out) if out.success => {}
        RunOutcome::Finished(out) => {
            let text = captured_diagnostic(&out);
            problems.push(format!("{prefix}{text}"));
        }
        RunOutcome::TimedOut => {
            problems.push(format!("{prefix}the host half import check timed out after 10s"));
        }
        RunOutcome::NotFound => {
            problems.push(format!("{prefix}node is no longer runnable"));
        }
        RunOutcome::Spawn(err) => {
            problems.push(format!("{prefix}could not run node: {err}"));
        }
    }
}

/// Tier 2, check 3 — import the RENDERED prompts module from a
/// `data:text/javascript;base64,…` URL and assert `LANE_PROMPTS` keys exactly
/// equal the authored lane keys with non-empty string values (CLI
/// :1356-1372). Rendering goes through `workbench_core::render` the same way
/// `dsh_outputs` does, so the checked bytes are the bytes an install would
/// write.
fn tier2_prompts_problem(source_root: &Path, problems: &mut Vec<String>) {
    let prefix = "lane-plugin prompts.generated.js: ";
    let lanes = match dsh::lanes(source_root) {
        Ok(lanes) => lanes,
        Err(err) => {
            problems.push(format!("{prefix}{}", error_message(err)));
            return;
        }
    };
    let rendered = match render::render_lane_prompts(source_root, &lanes) {
        Ok(text) => text,
        Err(err) => {
            problems.push(format!("{prefix}{}", error_message(err)));
            return;
        }
    };
    let keys: Vec<String> = lanes.iter().map(|lane| lane.key.clone()).collect();
    let keys_json = serde_json::to_string(&keys).unwrap_or_else(|_| "[]".to_string());
    let script = PROMPTS_CHECK_SCRIPT
        .replace("%KEYS%", &keys_json)
        .replace("%B64%", &base64_encode(rendered.as_bytes()));

    let mut cmd = Command::new("node");
    cmd.arg("-e").arg(&script);
    match run_with_timeout(&mut cmd, TIER2_TIMEOUT) {
        RunOutcome::Finished(out) if out.success => {}
        RunOutcome::Finished(out) => {
            let text = captured_diagnostic(&out);
            problems.push(format!("{prefix}{text}"));
        }
        RunOutcome::TimedOut => {
            problems.push(format!("{prefix}the prompt module check timed out after 10s"));
        }
        RunOutcome::NotFound => {
            problems.push(format!("{prefix}node is no longer runnable"));
        }
        RunOutcome::Spawn(err) => {
            problems.push(format!("{prefix}could not run node: {err}"));
        }
    }
}

/// The full Tier 2 pass over one source root's DSH artifacts (PLAN §4, lock
/// 6): Node absent → `Skipped` with no problems (the UI renders the locked
/// skip notice); any check failing → `Fail` with the captured error text; all
/// passing → `Pass`.
fn run_tier2(source_root: &Path) -> Tier2Report {
    if !node_available() {
        return Tier2Report {
            status: Tier2Status::Skipped,
            problems: Vec::new(),
        };
    }
    let mut problems = Vec::new();
    tier2_syntax_problems(source_root, &mut problems);
    tier2_host_problem(source_root, &mut problems);
    tier2_prompts_problem(source_root, &mut problems);
    let status = if problems.is_empty() {
        Tier2Status::Pass
    } else {
        Tier2Status::Fail
    };
    Tier2Report { status, problems }
}

// ---------------------------------------------------------------- commands

/// Detect the local environment for the Deploy page (PLAN §4): engine
/// detection (target homes, omos presence, PATH probes) enriched with real
/// `opencode --version` / `node --version` output. An absent binary keeps
/// `present: false` and no version; a present binary whose probe fails keeps
/// `version: null` — detection never blocks anything (design decision 4).
#[tauri::command]
async fn detect_environment(app: AppHandle) -> Result<EnvironmentInfo, String> {
    let ctx = engine_context(&app)?;
    let mut info = engine::detect_environment(&ctx);
    if info.opencode.present {
        info.opencode.version = probe_version("opencode");
    }
    if info.node.present {
        info.node.version = probe_version("node");
    }
    Ok(info)
}

/// Phase 1 of the install (PLAN §4): per-file decisions (`create` | `skip` |
/// `overwrite` | `managed-block`) plus realm stamps and notes. Zero writes —
/// the preview pane renders this directly. Prerequisite gates and the
/// source-repo guard fail here with the CLI's friendly text.
#[tauri::command]
async fn plan_install(app: AppHandle, selection: Selection) -> Result<Plan, String> {
    let ctx = engine_context(&app)?;
    engine::plan(&selection, &ctx).map_err(error_message)
}

/// Phase 2 (PLAN §4): replay a plan, streaming `install-log` /
/// `install-progress` events to the frontend and returning the final report.
/// Runs on a blocking worker thread (the engine's file work must never sit on
/// the main thread). A second execute while one is running is rejected with a
/// clear message; `cancel_install` sets the cooperative flag the sink
/// exposes, and the engine stops before the next file.
#[tauri::command]
async fn execute_install(
    app: AppHandle,
    plan: Plan,
    selection: Selection,
    state: State<'_, InstallState>,
) -> Result<InstallReport, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(single_line(
            "another install is already running; wait for it to finish or cancel it first",
        ));
    }
    // A stale cancel from a previous run must not poison this one.
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();

    let ctx = match engine_context(&app) {
        Ok(ctx) => ctx,
        Err(err) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(err);
        }
    };
    let sink = TauriSink { app, cancel };
    let joined = tauri::async_runtime::spawn_blocking(move || {
        engine::execute(&plan, &selection, &ctx, &sink)
    })
    .await;

    state.running.store(false, Ordering::SeqCst);
    match joined {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(err)) => Err(error_message(err)),
        Err(err) => Err(single_line(&format!("install worker failed: {err}"))),
    }
}

/// Set the cooperative cancel flag (PLAN §4 / design decision 1). Harmless
/// when nothing is running; the engine observes it only between file
/// operations, so a cancelled run always stops before the next file and
/// before the stamps.
#[tauri::command]
fn cancel_install(state: State<'_, InstallState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Health check (PLAN §4): Tier 1 — engine render-and-byte-compare drift plus
/// every structural check — then Tier 2 filled in by this shell: the three
/// execution-state checks through the local Node on the source's rendered
/// DSH artifacts. Node absent → `tier2.status = "skipped"` with the locked
/// skip notice; never blocks.
#[tauri::command]
async fn check_drift(app: AppHandle, selection: Selection) -> Result<DriftReport, String> {
    let ctx = engine_context(&app)?;
    let source = selection.source.clone();
    let mut report = engine::check_drift(&source, &selection, &ctx).map_err(error_message)?;
    report.tier2 = Some(run_tier2(&ctx.source_root(&source)));
    Ok(report)
}

/// Custom-source pre-install validation (PLAN §4 "deliberately stricter than
/// the CLI install path"): structural checks on the chosen `agents/` tree
/// plus Tier 2 on ITS rendered DSH artifacts — no byte comparison is
/// possible before an install, so `tier1.compared` stays 0. Every problem is
/// reported; nothing is written.
#[tauri::command]
async fn validate_custom_source(app: AppHandle, source_root: String) -> Result<DriftReport, String> {
    let root = PathBuf::from(source_root.trim());
    if !root.is_dir() {
        return Err(single_line(&format!(
            "source root is not a directory: {}",
            root.display()
        )));
    }
    // The app handle is only needed for the general context contract; this
    // command validates a user-chosen tree, so no bundled resolution happens.
    let _ = &app;

    let mut problems: Vec<StructuralProblem> = checks::agent_source_problems(&root)
        .into_iter()
        .map(|detail| StructuralProblem {
            check: "agentSourceProblems".to_string(),
            detail,
        })
        .collect();
    problems.extend(checks::lane_plugin_problems(&root).into_iter().map(|detail| {
        StructuralProblem {
            check: "lanePluginProblems".to_string(),
            detail,
        }
    }));
    problems.extend(
        checks::lane_ui_plugin_problems(&root)
            .into_iter()
            .map(|detail| StructuralProblem {
                check: "laneUiPluginProblems".to_string(),
                detail,
            }),
    );

    let tier2 = run_tier2(&root);
    Ok(DriftReport {
        tier1: Tier1Report {
            compared: 0,
            drifted: Vec::new(),
            problems,
        },
        tier2: Some(tier2),
    })
}

// -------------------------------------------------- skills management (M2)

/// Default subdirectory inside a skill repo (PLAN.md §5: "default skill
/// subdirectory `skills/`"), used when a command receives no subdir. An
/// explicit empty subdir is kept — it means the repo root (the core's
/// documented semantics).
const DEFAULT_SKILL_SUBDIR: &str = "skills";

/// Settings + skill sources live in one file under the app config dir.
const SETTINGS_FILE: &str = "settings.json";

/// Remote-listing cache under the app cache dir (PLAN.md §5: "results cached
/// locally" — the unauthenticated GitHub rate limit is 60 req/h).
const LISTINGS_CACHE_FILE: &str = "skills-listings.json";
const LISTINGS_CACHE_VERSION: u32 = 1;

/// Frontend event channel for skill install/update progress (M1 bridge
/// style, one unified payload per event).
const SKILL_PROGRESS_CHANNEL: &str = "skill-progress";

/// OS-keyring identity of the GitHub PAT (SPEC.md §6.2: never on disk in
/// plaintext).
const KEYRING_SERVICE: &str = "my-workbench";
const KEYRING_USER: &str = "github-pat";

/// User settings (PLAN.md §5): the skill root (default
/// `<home>/.agents/skills`) and the UI language. Serialized camelCase
/// (`skillsRoot`); missing fields fall back to the defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    skills_root: String,
    language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            skills_root: default_skills_root(),
            language: "zh".to_string(),
        }
    }
}

/// One configured skill source. The JSON key of `ref_` is `ref` (explicit
/// serde rename — `ref` alone is a Rust keyword).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillSourceConfig {
    repo: String,
    #[serde(rename = "ref")]
    ref_: Option<String>,
    subdir: String,
}

/// `settings.json` on disk: settings and skill sources in one place. A
/// missing file means defaults; a corrupt one means defaults WITH a warning
/// (never a panic, never silent) — mirroring the core's manifest handling.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct SettingsFile {
    settings: AppSettings,
    sources: Vec<SkillSourceConfig>,
}

/// One cached remote listing (`<repo>@<ref|HEAD>:<subdir>` → listing + time).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedListing {
    listing: SkillListing,
    cached_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ListingsCacheFile {
    version: u32,
    listings: BTreeMap<String, CachedListing>,
}

/// `skills_list_remote` result: the listing plus the moment it was fetched
/// (Some for both a fresh fetch and a cache hit — the UI renders the
/// 上次更新 timestamp from it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillsListingResult {
    listing: SkillListing,
    cached_at_ms: Option<u64>,
}

/// `pat_status` result — deliberately carries ONLY the boolean; the token
/// value never round-trips to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PatStatus {
    configured: bool,
}

/// Shared skills-mutation state: `running` rejects a second concurrent
/// install/update/delete (mirrors [`InstallState`]). Read-only operations
/// (`skills_list_remote`, `skills_check_update`, `skills_list_installed`)
/// deliberately do not take the guard — they must stay usable while an
/// install runs.
#[derive(Default)]
struct SkillsState {
    running: Arc<AtomicBool>,
}

/// RAII guard over [`SkillsState::running`]: acquired at the start of a
/// mutating skills command and released on drop, so every early-return path
/// (bad source, keyring failure, worker crash) clears the flag.
struct SkillsGuard(Arc<AtomicBool>);

impl SkillsGuard {
    fn acquire(state: &SkillsState) -> Result<Self, String> {
        if state.running.swap(true, Ordering::SeqCst) {
            return Err(single_line(
                "another skills operation (install/update/delete) is already running; \
                 wait for it to finish first",
            ));
        }
        Ok(Self(state.running.clone()))
    }
}

impl Drop for SkillsGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Bridges the skills engine's [`EventSink`] events to the `skill-progress`
/// channel. Every event becomes the SAME five-key camelCase payload
/// `{ skill, phase, done, total, text }` — the frozen shape the Skills page
/// parses — so the [`InstallEvent`] variants are pattern-matched here, never
/// serialized raw. Phase vocabulary:
///
/// - `started` — [`InstallEvent::Started`], `total` = file count
/// - `skill-install` / `skill-update` — [`InstallEvent::Progress`] (the
///   core's phase strings), `done`/`total` = extraction progress
/// - `log` / `log-warn` / `log-error` — [`InstallEvent::Log`], the line in
///   `text` (the level is folded into the phase; the frozen payload has no
///   separate level key)
/// - `finished` / `cancelled` — [`InstallEvent::Finished`]
struct SkillsSink {
    app: AppHandle,
    skill: String,
}

impl EventSink for SkillsSink {
    fn emit(&self, event: InstallEvent) {
        let (phase, done, total, text) = match &event {
            InstallEvent::Started { total_files } => ("started", 0, *total_files, String::new()),
            InstallEvent::Log { level, text, .. } => (
                match level {
                    LogLevel::Info => "log",
                    LogLevel::Warn => "log-warn",
                    LogLevel::Error => "log-error",
                },
                0,
                0,
                text.clone(),
            ),
            InstallEvent::Progress { phase, done, total } => {
                (phase.as_str(), *done, *total, String::new())
            }
            InstallEvent::Finished { cancelled } => (
                if *cancelled { "cancelled" } else { "finished" },
                0,
                0,
                String::new(),
            ),
        };
        let payload = json!({
            "skill": self.skill,
            "phase": phase,
            "done": done,
            "total": total,
            "text": text,
        });
        if let Err(err) = self.app.emit(SKILL_PROGRESS_CHANNEL, payload) {
            eprintln!("failed to emit {SKILL_PROGRESS_CHANNEL}: {err}");
        }
    }
}

// ------------------------------------------------------------ skills paths

fn default_skills_root() -> String {
    match home_dir() {
        Ok(home) => home
            .join(".agents")
            .join("skills")
            .to_string_lossy()
            .into_owned(),
        // Practically unreachable (USERPROFILE/HOME always exist on the
        // supported platforms); the core surfaces an honest error later.
        Err(_) => ".agents/skills".to_string(),
    }
}

fn app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| single_line(&format!("cannot resolve the app config directory: {e}")))
}

fn app_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|e| single_line(&format!("cannot resolve the app cache directory: {e}")))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join(SETTINGS_FILE))
}

fn listings_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_cache_dir(app)?.join(LISTINGS_CACHE_FILE))
}

/// The configured skill root, or the default when unset/empty.
fn skills_root_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = read_settings_file(&settings_path(app)?).settings.skills_root;
    if root.trim().is_empty() {
        return Ok(PathBuf::from(default_skills_root()));
    }
    Ok(PathBuf::from(root))
}

// ------------------------------------------------------- JSON file helpers

/// Atomically replace `path` with the serialization of `value` (tmp file +
/// rename; the tmp name is process-unique so two concurrent writers can never
/// interleave on one temp file).
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| single_line(&format!("cannot create {}: {e}", parent.display())))?;
    }
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| single_line(&format!("cannot serialize {}: {e}", path.display())))?;
    bytes.push(b'\n');
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!("{stem}.{}.{}.tmp", std::process::id(), nanos));
    fs::write(&tmp, &bytes).map_err(|e| single_line(&format!("cannot write {}: {e}", tmp.display())))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(single_line(&format!("cannot replace {}: {e}", path.display())));
    }
    Ok(())
}

fn read_settings_file(path: &Path) -> SettingsFile {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return SettingsFile::default(), // missing = fresh defaults
    };
    match serde_json::from_slice(&bytes) {
        Ok(file) => file,
        Err(e) => {
            eprintln!(
                "my-workbench: settings file at {} is corrupt ({e}); using defaults",
                path.display()
            );
            SettingsFile::default()
        }
    }
}

fn read_listings_cache(path: &Path) -> ListingsCacheFile {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return ListingsCacheFile::default(), // missing = empty cache
    };
    match serde_json::from_slice::<ListingsCacheFile>(&bytes) {
        Ok(file) if file.version == LISTINGS_CACHE_VERSION => file,
        Ok(_) => {
            eprintln!(
                "my-workbench: skills listing cache at {} has an unsupported version; ignoring it",
                path.display()
            );
            ListingsCacheFile::default()
        }
        Err(e) => {
            eprintln!(
                "my-workbench: skills listing cache at {} is corrupt ({e}); ignoring it",
                path.display()
            );
            ListingsCacheFile::default()
        }
    }
}

// -------------------------------------------------------- small M2 helpers

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build the core's [`SkillSource`] from the command args: strings are
/// trimmed, an empty ref becomes `None` (→ the core's `HEAD` pseudo-ref), a
/// missing subdir becomes the default `skills`.
fn skill_source(repo: String, ref_: Option<String>, subdir: Option<String>) -> SkillSource {
    let repo = repo.trim().to_string();
    let ref_ = ref_.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    let subdir = match subdir {
        Some(s) => s.trim().to_string(),
        None => DEFAULT_SKILL_SUBDIR.to_string(),
    };
    SkillSource {
        repo,
        r#ref: ref_,
        subdir,
    }
}

/// [`SkillSource`] → the persisted [`SkillSourceConfig`] shape.
fn source_config(repo: String, ref_: Option<String>, subdir: Option<String>) -> SkillSourceConfig {
    let source = skill_source(repo, ref_, subdir);
    SkillSourceConfig {
        repo: source.repo,
        ref_: source.r#ref,
        subdir: source.subdir,
    }
}

/// Light shell-side shape check for the source-mutation commands: the repo
/// must be `owner/repo` with non-empty parts. The authoritative validation
/// (charset, ref and subdir rules) lives in the core and runs again on every
/// use — this only keeps obvious garbage out of settings.json.
fn check_repo_shape(repo: &str) -> Result<(), String> {
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
        return Err(single_line(&format!(
            "invalid skill source repository '{repo}': expected 'owner/repo'"
        )));
    }
    Ok(())
}

/// Cache key of one source: `<repo>@<ref|HEAD>:<subdir>`.
fn cache_key(source: &SkillSource) -> String {
    format!("{}@{}:{}", source.repo, source.effective_ref(), source.subdir)
}

/// Expand a leading `~` to the user home and reject an empty skills root.
fn normalize_skills_root(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(single_line("skillsRoot must not be empty"));
    }
    let expanded = match trimmed.strip_prefix('~') {
        Some("") => home_dir()?.to_string_lossy().into_owned(),
        Some(rest) if rest.starts_with('/') || rest.starts_with('\\') => {
            let home = home_dir()?;
            home.join(rest.trim_start_matches(['/', '\\']))
                .to_string_lossy()
                .into_owned()
        }
        _ => trimmed.to_string(),
    };
    Ok(expanded)
}

// -------------------------------------------------- settings & sources (M2)

/// The user settings (skill root + UI language).
#[tauri::command]
fn settings_get(app: AppHandle) -> Result<AppSettings, String> {
    Ok(read_settings_file(&settings_path(&app)?).settings)
}

/// Persist the settings part; the source list is preserved. Returns the
/// normalized settings actually stored (trimmed skills root with `~`
/// expanded, non-empty language defaulting to "zh").
#[tauri::command]
fn settings_set(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    let mut file = read_settings_file(&path);
    let language = {
        let trimmed = settings.language.trim();
        if trimmed.is_empty() {
            "zh".to_string()
        } else {
            trimmed.to_string()
        }
    };
    file.settings = AppSettings {
        skills_root: normalize_skills_root(&settings.skills_root)?,
        language,
    };
    write_json_atomic(&path, &file)?;
    Ok(file.settings)
}

#[tauri::command]
fn skills_list_sources(app: AppHandle) -> Result<Vec<SkillSourceConfig>, String> {
    Ok(read_settings_file(&settings_path(&app)?).sources)
}

/// Append one source and return the updated list.
#[tauri::command]
fn skills_add_source(
    app: AppHandle,
    repo: String,
    ref_: Option<String>,
    subdir: Option<String>,
) -> Result<Vec<SkillSourceConfig>, String> {
    let path = settings_path(&app)?;
    let mut file = read_settings_file(&path);
    let config = source_config(repo, ref_, subdir);
    check_repo_shape(&config.repo)?;
    file.sources.push(config);
    write_json_atomic(&path, &file)?;
    Ok(file.sources)
}

/// Replace the source at `index` and return the updated list.
#[tauri::command]
fn skills_update_source(
    app: AppHandle,
    index: usize,
    repo: String,
    ref_: Option<String>,
    subdir: Option<String>,
) -> Result<Vec<SkillSourceConfig>, String> {
    let path = settings_path(&app)?;
    let mut file = read_settings_file(&path);
    if index >= file.sources.len() {
        return Err(single_line(&format!(
            "source index {index} is out of range (0..{})",
            file.sources.len()
        )));
    }
    let config = source_config(repo, ref_, subdir);
    check_repo_shape(&config.repo)?;
    file.sources[index] = config;
    write_json_atomic(&path, &file)?;
    Ok(file.sources)
}

/// Remove the source at `index` and return the updated list.
#[tauri::command]
fn skills_remove_source(app: AppHandle, index: usize) -> Result<Vec<SkillSourceConfig>, String> {
    let path = settings_path(&app)?;
    let mut file = read_settings_file(&path);
    if index >= file.sources.len() {
        return Err(single_line(&format!(
            "source index {index} is out of range (0..{})",
            file.sources.len()
        )));
    }
    file.sources.remove(index);
    write_json_atomic(&path, &file)?;
    Ok(file.sources)
}

// ------------------------------------------------------------ skills ops (M2)

/// Installed skills from `<skills_root>/.workbench-skills.json` —
/// offline-safe (the manifest is the only thing read; PLAN.md §8 "list/delete
/// still work").
#[tauri::command]
fn skills_list_installed(app: AppHandle) -> Result<Vec<InstalledSkill>, String> {
    let root = skills_root_path(&app)?;
    skills::list_installed(&root).map_err(error_message)
}

/// Remote listing of one source. `refresh=false` serves the per-source cache
/// when present; anything else — no cache yet, or `refresh=true` — goes to
/// the network and overwrites the cache entry. Errors are NEVER masked with
/// stale cache data: the UI renders its offline state from the rejection and
/// retries with `refresh=false`.
#[tauri::command]
async fn skills_list_remote(
    app: AppHandle,
    repo: String,
    ref_: Option<String>,
    subdir: Option<String>,
    refresh: bool,
) -> Result<SkillsListingResult, String> {
    let source = skill_source(repo, ref_, subdir);
    let key = cache_key(&source);
    let cache_path = listings_cache_path(&app)?;
    if !refresh {
        let cache = read_listings_cache(&cache_path);
        if let Some(hit) = cache.listings.get(&key) {
            return Ok(SkillsListingResult {
                listing: hit.listing.clone(),
                cached_at_ms: Some(hit.cached_at_ms),
            });
        }
    }
    let token = load_pat()?;
    let client = UreqGitHubClient::new();
    let listing = tauri::async_runtime::spawn_blocking(move || {
        skills::list_remote(&client, &source, token.as_deref())
    })
    .await
    .map_err(|e| single_line(&format!("skills listing worker failed: {e}")))?
    .map_err(error_message)?;
    let cached_at_ms = now_ms();
    // A cache write failure is non-fatal: the fresh listing still reaches the
    // UI; only the NEXT offline attempt loses its fallback. (An error here
    // must not look like a network error — that is the UI's 离线 signal.)
    let mut cache = read_listings_cache(&cache_path);
    cache.version = LISTINGS_CACHE_VERSION;
    cache
        .listings
        .insert(key, CachedListing { listing: listing.clone(), cached_at_ms });
    if let Err(err) = write_json_atomic(&cache_path, &cache) {
        eprintln!("my-workbench: could not update the skills listing cache: {err}");
    }
    Ok(SkillsListingResult {
        listing,
        cached_at_ms: Some(cached_at_ms),
    })
}

/// Update verdict for one installed skill (up-to-date / updatable /
/// locally-modified). Read-only; deliberately no operation guard.
#[tauri::command]
async fn skills_check_update(
    app: AppHandle,
    repo: String,
    ref_: Option<String>,
    subdir: Option<String>,
    name: String,
) -> Result<SkillChange, String> {
    let source = skill_source(repo, ref_, subdir);
    let root = skills_root_path(&app)?;
    let token = load_pat()?;
    let client = UreqGitHubClient::new();
    tauri::async_runtime::spawn_blocking(move || {
        skills::check_update(&client, &root, &source, &name, token.as_deref())
    })
    .await
    .map_err(|e| single_line(&format!("skills update-check worker failed: {e}")))?
    .map_err(error_message)
}

/// Install one skill into the configured skill root, streaming progress to
/// `skill-progress`. Guarded: a second concurrent mutating skills operation
/// is rejected with a clear message.
#[tauri::command]
async fn skills_install(
    app: AppHandle,
    state: State<'_, SkillsState>,
    repo: String,
    ref_: Option<String>,
    subdir: Option<String>,
    name: String,
) -> Result<InstalledSkill, String> {
    let _guard = SkillsGuard::acquire(&state)?;
    let source = skill_source(repo, ref_, subdir);
    let root = skills_root_path(&app)?;
    let token = load_pat()?;
    let sink = SkillsSink {
        app,
        skill: name.clone(),
    };
    let client = UreqGitHubClient::new();
    tauri::async_runtime::spawn_blocking(move || {
        skills::install(&client, &root, &source, &name, token.as_deref(), &sink)
    })
    .await
    .map_err(|e| single_line(&format!("skills install worker failed: {e}")))?
    .map_err(error_message)
}

/// Update (or reinstall) one skill; `force` discards local modifications,
/// `backup` copies the current directory into `<root>/.backups/` first.
#[tauri::command]
async fn skills_update(
    app: AppHandle,
    state: State<'_, SkillsState>,
    repo: String,
    ref_: Option<String>,
    subdir: Option<String>,
    name: String,
    force: bool,
    backup: bool,
) -> Result<InstalledSkill, String> {
    let _guard = SkillsGuard::acquire(&state)?;
    let source = skill_source(repo, ref_, subdir);
    let root = skills_root_path(&app)?;
    let token = load_pat()?;
    let sink = SkillsSink {
        app,
        skill: name.clone(),
    };
    let client = UreqGitHubClient::new();
    tauri::async_runtime::spawn_blocking(move || {
        skills::update(
            &client, &root, &source, &name, force, backup, token.as_deref(), &sink,
        )
    })
    .await
    .map_err(|e| single_line(&format!("skills update worker failed: {e}")))?
    .map_err(error_message)
}

/// Delete one skill: remove (or trash) the directory and drop the manifest
/// entry. Idempotent in the core.
#[tauri::command]
async fn skills_delete(
    app: AppHandle,
    state: State<'_, SkillsState>,
    name: String,
    trash: bool,
) -> Result<(), String> {
    let _guard = SkillsGuard::acquire(&state)?;
    let root = skills_root_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || skills::delete_skill(&root, &name, trash))
        .await
        .map_err(|e| single_line(&format!("skills delete worker failed: {e}")))?
        .map_err(error_message)
}

// ---------------------------------------------------------------- PAT (M2)

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| single_line(&format!("cannot access the OS keyring: {e}")))
}

/// Read the PAT from the OS keyring. No entry (or an empty one) → `None`;
/// any real keyring failure surfaces as an error — never a plaintext-on-disk
/// fallback. The value only ever flows into the core's `token` parameter,
/// which the core redacts from every error it produces.
fn load_pat() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(token) if token.trim().is_empty() => Ok(None),
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(single_line(&format!(
            "cannot read the GitHub PAT from the OS keyring: {e}"
        ))),
    }
}

/// Whether a PAT is configured — the ONLY information about the token that
/// ever reaches the frontend.
#[tauri::command]
fn pat_status() -> Result<PatStatus, String> {
    Ok(PatStatus {
        configured: load_pat()?.is_some(),
    })
}

/// Store the PAT in the OS keyring (service `my-workbench`, user
/// `github-pat`). Validation is deliberately loose: any non-empty token is
/// accepted; one matching neither the `gh[pousr]_` prefix nor the 40-hex
/// classic shape only produces a stderr note. The value is never echoed,
/// logged or written anywhere else.
#[tauri::command]
fn pat_set(token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err(single_line("the GitHub PAT must not be empty"));
    }
    let looks_like_github_pat = trimmed.starts_with("ghp_")
        || trimmed.starts_with("gho_")
        || trimmed.starts_with("ghu_")
        || trimmed.starts_with("ghs_")
        || trimmed.starts_with("ghr_")
        || (trimmed.len() == 40 && trimmed.chars().all(|c| c.is_ascii_hexdigit()));
    if !looks_like_github_pat {
        eprintln!(
            "my-workbench: the GitHub PAT matches neither the gh[pousr]_ prefix nor the 40-hex classic shape; storing it anyway"
        );
    }
    keyring_entry()?
        .set_password(trimmed)
        .map_err(|e| single_line(&format!("cannot store the GitHub PAT in the OS keyring: {e}")))
}

/// Remove the PAT. Idempotent: clearing a missing entry is `Ok`.
#[tauri::command]
fn pat_clear() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(single_line(&format!(
            "cannot remove the GitHub PAT from the OS keyring: {e}"
        ))),
    }
}

// --------------------------------------------------------------------- run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .manage(InstallState::default())
        .manage(SkillsState::default())
        .invoke_handler(tauri::generate_handler![
            detect_environment,
            plan_install,
            execute_install,
            cancel_install,
            check_drift,
            validate_custom_source,
            skills_list_sources,
            skills_add_source,
            skills_update_source,
            skills_remove_source,
            settings_get,
            settings_set,
            skills_list_installed,
            skills_list_remote,
            skills_check_update,
            skills_install,
            skills_update,
            skills_delete,
            pat_status,
            pat_set,
            pat_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
