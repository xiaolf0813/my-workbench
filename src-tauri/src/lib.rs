//! Tauri 2 shell for the my-workbench desktop GUI.
//!
//! IPC wiring only — all deployment business logic lives in
//! `workbench-core`. This file implements the
//! M1 command surface over the ported engine:
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
//!   block). The bundled `agents/` tree is the only content source.
//! - `deployed_overview` / `deployed_list_agents` /
//!   `deployed_save_agent` — the deployed-agent read/edit surface.
//! - `settings_get` / `settings_set` — `AppSettings` (the UI language and
//!   the Deploy page's context: project directory + `--user` toggle),
//!   persisted in `<app_config_dir>/settings.json` (atomic tmp+rename
//!   writes). Unknown keys in an existing file (e.g. the removed
//!   `skillsRoot`/`sources`) are ignored by serde.
//!
//! Error surfacing: every command rejects with a single-line message string;
//! the frontend's `describeIpcError` renders it directly.

use std::collections::{BTreeMap, HashMap};
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

use workbench_core::deployed::{self, DeployedAgent, DeployedParams, DeployedTargetState};
use workbench_core::types::{
    DriftReport, EngineContext, EnvironmentInfo, EventSink, InstallEvent, InstallReport, Plan,
    Selection, Target, Tier2Report, Tier2Status,
};
use workbench_core::{dsh, engine, render, WorkbenchError};

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

/// The full Tier 2 pass over one source root's DSH artifacts (lock 6):
/// Node absent → `Skipped` with no problems (the UI renders the locked
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

/// Detect the local environment for the Deploy page: engine
/// detection (target homes, PATH probes) enriched with real
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

/// Phase 1 of the install: per-file decisions (`create` | `skip` |
/// `overwrite` | `managed-block`) plus realm stamps and notes. Zero writes —
/// the preview pane renders this directly. Prerequisite gates and the
/// source-repo guard fail here with the CLI's friendly text.
#[tauri::command]
async fn plan_install(app: AppHandle, selection: Selection) -> Result<Plan, String> {
    let ctx = engine_context(&app)?;
    engine::plan(&selection, &ctx).map_err(error_message)
}

/// Phase 2: replay a plan, streaming `install-log` /
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

/// Set the cooperative cancel flag (design decision 1). Harmless
/// when nothing is running; the engine observes it only between file
/// operations, so a cancelled run always stops before the next file and
/// before the stamps.
#[tauri::command]
fn cancel_install(state: State<'_, InstallState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Health check: Tier 1 — engine render-and-byte-compare drift plus
/// every structural check — then Tier 2 filled in by this shell: the three
/// execution-state checks through the local Node on the source's rendered
/// DSH artifacts. Node absent → `tier2.status = "skipped"` with the locked
/// skip notice; never blocks.
#[tauri::command]
async fn check_drift(app: AppHandle, selection: Selection) -> Result<DriftReport, String> {
    let ctx = engine_context(&app)?;
    let mut report = engine::check_drift(&selection, &ctx).map_err(error_message)?;
    report.tier2 = Some(run_tier2(&ctx.source_root()));
    Ok(report)
}

// ------------------------------------------------------- deployed agents

/// The project directory argument, trimmed; an empty/whitespace string is
/// "not set" (the core then refuses project-level opencode/claude scopes).
fn trimmed_project_dir(raw: Option<String>) -> Option<PathBuf> {
    raw.map(|dir| dir.trim().to_string())
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

/// `deployed_*` shared inputs: the user home, the ambient DSH home (resolved
/// exactly like the engine: `$DSH_HOME` wins over `<home>/.dsh`), the
/// trimmed project directory argument and the `--user` toggle.
fn deployed_params<'a>(
    home: &'a Path,
    dsh_home: &'a Path,
    project_dir: Option<&'a Path>,
    user_level: bool,
) -> DeployedParams<'a> {
    DeployedParams {
        project_dir,
        user_level,
        home,
        dsh_home,
    }
}

/// Per-target deployed state for ALL four targets (APPLY_ORDER): whether an
/// install left content behind (opencode/claude/zcode: at least one
/// `<scope>/agents/*.md` other than `AGENTS.md`; dsh: the preset root
/// exists) and the human-readable scope root for display (`""` when the
/// scope cannot resolve — project level without a project directory).
#[tauri::command]
fn deployed_overview(
    project_dir: Option<String>,
    user_level: bool,
) -> Result<Vec<DeployedTargetState>, String> {
    let home = home_dir()?;
    let dsh_home = dsh::dsh_home(&home);
    let project = trimmed_project_dir(project_dir);
    let params = deployed_params(&home, &dsh_home, project.as_deref(), user_level);
    Ok(deployed::deployed_overview(&params))
}

/// Every deployed agent of one target, sorted by file name — name,
/// description, verbatim body and the backend's current model-setting
/// values. dsh lists nothing (deployed state only).
#[tauri::command]
fn deployed_list_agents(
    target: Target,
    project_dir: Option<String>,
    user_level: bool,
) -> Result<Vec<DeployedAgent>, String> {
    let home = home_dir()?;
    let dsh_home = dsh::dsh_home(&home);
    let project = trimmed_project_dir(project_dir);
    let params = deployed_params(&home, &dsh_home, project.as_deref(), user_level);
    deployed::list_deployed_agents(&params, target).map_err(error_message)
}

/// Rewrite ONE deployed agent file: the body is replaced verbatim, the
/// backend's model-setting keys are set/updated (`Some`) or cleared
/// (`None`), every other frontmatter line survives. Path-safe: `fileName`
/// must name an existing `.md` file inside the target's `agents/` directory
/// (no separators, no `..`, no symlink escape). Returns the saved state.
#[tauri::command]
fn deployed_save_agent(
    target: Target,
    project_dir: Option<String>,
    user_level: bool,
    file_name: String,
    body: String,
    settings: HashMap<String, Option<String>>,
) -> Result<DeployedAgent, String> {
    let home = home_dir()?;
    let dsh_home = dsh::dsh_home(&home);
    let project = trimmed_project_dir(project_dir);
    let params = deployed_params(&home, &dsh_home, project.as_deref(), user_level);
    // BTreeMap: the core reads per backend key; order never matters.
    let settings = settings.into_iter().collect::<BTreeMap<_, _>>();
    deployed::save_deployed_agent(&params, target, &file_name, &body, &settings)
        .map_err(error_message)
}

// ------------------------------------------------------------- settings

/// Settings live in one file under the app config dir.
const SETTINGS_FILE: &str = "settings.json";

/// User settings: the UI language and the Deploy page's context (the picked
/// project directory and the `--user` toggle, persisted so the page restores
/// and the deployed-agent commands receive the same values). Serialized
/// camelCase (`language`, `projectDir`, `userLevel`); missing fields fall
/// back to the defaults, so existing settings files load unchanged. Unknown
/// keys in an existing file (e.g. the removed `skillsRoot`/`sources`) are
/// ignored by serde.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    language: String,
    /// The Deploy page's project directory (`None` = not picked yet).
    #[serde(default)]
    project_dir: Option<String>,
    /// The Deploy page's user-level toggle.
    #[serde(default)]
    user_level: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "zh".to_string(),
            project_dir: None,
            user_level: false,
        }
    }
}

/// `settings.json` on disk. A missing file means defaults; a corrupt one
/// means defaults WITH a warning (never a panic, never silent) — mirroring
/// the core's manifest handling.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct SettingsFile {
    settings: AppSettings,
}

fn app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| single_line(&format!("cannot resolve the app config directory: {e}")))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join(SETTINGS_FILE))
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

// ---------------------------------------------------------------- settings

/// The user settings (UI language + Deploy page context).
#[tauri::command]
fn settings_get(app: AppHandle) -> Result<AppSettings, String> {
    Ok(read_settings_file(&settings_path(&app)?).settings)
}

/// Persist the settings. Returns the normalized settings actually stored
/// (non-empty language defaulting to "zh", trimmed project directory
/// defaulting to absent, user-level toggle as given).
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
    let project_dir = settings
        .project_dir
        .map(|dir| dir.trim().to_string())
        .filter(|dir| !dir.is_empty());
    file.settings = AppSettings {
        language,
        project_dir,
        user_level: settings.user_level,
    };
    write_json_atomic(&path, &file)?;
    Ok(file.settings)
}

// --------------------------------------------------------------------- run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(InstallState::default())
        .invoke_handler(tauri::generate_handler![
            detect_environment,
            plan_install,
            execute_install,
            cancel_install,
            check_drift,
            deployed_overview,
            deployed_list_agents,
            deployed_save_agent,
            settings_get,
            settings_set
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

