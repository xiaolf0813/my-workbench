//! Golden anti-drift gate — the hard byte-identity contract
//! between the Node CLI (`bin/my-workbench.js`) and the Rust port
//! (`workbench-core`).
//!
//! For every scenario in its matrix the gate builds two sibling sandbox
//! trees with IDENTICAL relative layout (`home/`, `project/`, `dsh-home/`):
//! sandbox A is installed into by the real CLI (`node bin/my-workbench.js …`,
//! spawned with a fully sandboxed environment), sandbox B by
//! `workbench-core::engine` (`plan` + `execute`). Afterwards both trees must
//! hold the same relative file set, and every file must be byte-identical
//! after sandbox-path normalization: occurrences of the sandbox home path are
//! replaced with `{{HOME}}` and of the sandbox root with `{{SB}}` — each in
//! its backslash and forward-slash form, because the DSH lane plugin bakes
//! `file:` URLs (forward slashes) while the managed-block row and stamps
//! carry plain paths.
//!
//! Walk rules: both trees are walked recursively including dotfiles — the
//! home-realm stamp `.my-workbench.version` is a dotfile both sides write and
//! must be compared — while the never-written members of the CLI's
//! `isSkipped` set (`node_modules`, `package-lock.json`,
//! `settings.local.json`) are pruned. Fixtures that merely stand in for a
//! pre-existing tool install (the DSH module closure) all
//! live under `node_modules` or are seeded identically on both sides, so the
//! walk never sees engine-irrelevant bytes.
//!
//! Environment: the Rust engine reads the AMBIENT `DSH_HOME`, `PATH`,
//! `MY_WORKBENCH_DSH_NODE_MODULES`, `APPDATA` and `XDG_CONFIG_HOME`, so the
//! whole matrix runs inside ONE `#[test]` function, sequentially, with the
//! ambient variables pointed at the Rust-side sandbox per case and restored
//! on exit. (This file is its own test binary: the lib's unit tests run in a
//! separate process and can never observe these mutations.)
//!
//! A failure here is a SUCCESS of the gate: it names the case, the diverging
//! file and the first divergent byte offset. Divergences must be fixed in the
//! engine or CLI — never weakened away in this file.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use workbench_core::engine::{check_drift, execute, plan};
use workbench_core::types::{
    EngineContext, EventSink, Plan, Selection, Source, StampRealm, Target,
};

/// Per-CLI-spawn watchdog (the CLI must never hang the gate).
const CLI_TIMEOUT: Duration = Duration::from_secs(60);

/// The install-relevant members of the CLI's `isSkipped` (bin/my-workbench.js
/// :145-152). Its dotfile rule is deliberately NOT applied here: the home
/// stamp `.my-workbench.version` is a dotfile both sides write.
const WALK_SKIP: [&str; 3] = ["node_modules", "package-lock.json", "settings.local.json"];

fn repo_root() -> PathBuf {
    // The crate lives at <repo>/crates/workbench-core.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

// ----------------------------------------------------------------- sandbox

/// One side's sandbox tree: sibling roots share the layout, never the bytes.
struct Sandbox {
    root: PathBuf,
    home: PathBuf,
    project: PathBuf,
    dsh_home: PathBuf,
}

impl Sandbox {
    fn create(base: &Path) -> Sandbox {
        let sandbox = Sandbox {
            root: base.to_path_buf(),
            home: base.join("home"),
            project: base.join("project"),
            dsh_home: base.join("dsh-home"),
        };
        fs::create_dir_all(&sandbox.home).unwrap();
        fs::create_dir_all(&sandbox.project).unwrap();
        sandbox
    }
}

/// No-op event sink: `execute` needs one; the gate compares trees, not logs.
struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: workbench_core::types::InstallEvent) {}
}

// ---------------------------------------------------------------- fixtures

struct Fixtures {
    /// Directory holding the fake `opencode` launcher, prepended to PATH on
    /// both sides so the install gate is deterministic on any host.
    bin: PathBuf,
}

fn make_fixtures(run_dir: &Path) -> Fixtures {
    let bin = run_dir.join("fixtures").join("bin");
    fs::create_dir_all(&bin).unwrap();
    if cfg!(windows) {
        // The CLI probes `opencode --version` through cmd.exe on Windows
        // (npm-shim style), so the fake is a .cmd batch file.
        fs::write(
            bin.join("opencode.cmd"),
            "@echo off\r\necho opencode 1.0.0\r\nexit /b 0\r\n",
        )
        .unwrap();
    } else {
        let launcher = bin.join("opencode");
        fs::write(&launcher, "#!/bin/sh\necho opencode 1.0.0\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    Fixtures { bin }
}

/// Fake DSH home: TWO initialized profiles (`web` and `cli`, so the row
/// maintenance must find and write both), and the profile-root module closure
/// carrying the two packages the lane plugin imports (fixture style of
/// test/dsh-deps.test.js `packageAt`). Identically seeded on both sides; the
/// node_modules subtree is pruned from the walk.
fn seed_dsh_home(root: &Path) {
    let dsh = root.join("dsh-home");
    let web = dsh.join("profiles").join("web");
    let cli = dsh.join("profiles").join("cli");
    fs::create_dir_all(&web).unwrap();
    fs::create_dir_all(&cli).unwrap();
    fs::write(web.join("cordis.yml"), "root: web\n").unwrap();
    fs::write(cli.join("cordis.yml"), "root: cli\n").unwrap();
    for name in ["@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery"] {
        let pkg = dsh.join("profiles").join("node_modules").join(name);
        fs::create_dir_all(&pkg).unwrap();
        fs::write(
            pkg.join("package.json"),
            r#"{"version":"1.0.0","exports":{".":"./index.mjs"}}"#,
        )
        .unwrap();
        fs::write(pkg.join("index.mjs"), "export default {}\n").unwrap();
    }
}

/// Destinations both sides touch in the force/skip scenarios, seeded with the
/// same arbitrary bytes on both sides.
const PRESEED: [(&str, &str); 4] = [
    (".opencode/opencode.jsonc", "copied config"),
    (".claude/settings.json", "copied settings"),
    (".claude/agents/orchestrator.md", "assembled agent"),
    ("my-workbench.version", "project stamp"),
];

fn preseed(project: &Path, content: &str) {
    for (rel, _) in PRESEED {
        let dest = project.join(rel);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, content).unwrap();
    }
}

/// User-retuned files seeded identically into both sandboxes for the
/// `preserve` cases — the exact hand edits a `--force` overwrite must honor:
/// * agent markdown (frontmatter legs, unchanged): per-backend replace +
///   insert — the render's `model:` line is replaced while the backend's
///   reasoning key (`effort` / `variant` / `thoughtLevel`) is absent from the
///   render and therefore inserted before the closing fence;
/// * the two JSON seed stubs (ownership legs): user-realistic files (comments,
///   env with token-like values, hooks, user model keys) where the stub's own
///   key is user-MODIFIED in settings.json (reset to canonical, replace path)
///   and DELETED from opencode.jsonc (re-inserted, insert path).
/// Plus the same shapes at the user-level paths for the `preserve_user` case
/// (see [`seed_preserve_user`]).
fn seed_preserve(project: &Path, home: &Path) {
    let claude_agents = project.join(".claude").join("agents");
    fs::create_dir_all(&claude_agents).unwrap();
    fs::write(
        claude_agents.join("oracle.md"),
        "---\nname: oracle\ndescription: \"old description\"\ntools: Read\nmodel: custom/pinned-claude\neffort: high\n---\n\nold body\n",
    )
    .unwrap();
    fs::write(
        project.join(".claude").join("settings.json"),
        "{\n  \"$schema\": \"https://json.schemastore.org/claude-code-settings.json\",\n  \"agent\": \"user-pinned-orchestrator\",\n  \"model\": \"sonnet\",\n  \"effortLevel\": \"high\",\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-user-example-token\",\n    \"MAX_THINKING_TOKENS\": \"32000\"\n  },\n  \"hooks\": {\n    \"PostToolUse\": [\n      { \"matcher\": \"Write\", \"hooks\": [ { \"type\": \"command\", \"command\": \"echo user-hook\" } ] }\n    ]\n  }\n}\n",
    )
    .unwrap();
    let oc_agents = project.join(".opencode").join("agents");
    fs::create_dir_all(&oc_agents).unwrap();
    fs::write(
        project.join(".opencode").join("opencode.jsonc"),
        "{\n  // tuned by hand\n  \"model\": \"custom/pinned-oc\",\n  \"small_model\": \"custom/small-pin\",\n  \"agent\": {\n    \"orchestrator\": { \"model\": \"custom/oc-lead\" }\n  }\n}\n",
    )
    .unwrap();
    fs::write(
        oc_agents.join("oracle.md"),
        "---\ndescription: \"old\"\nmode: subagent\nmodel: custom/old-pin\nvariant: max\n---\n\nold body\n",
    )
    .unwrap();
    fs::write(
        oc_agents.join("observer.md"),
        "---\ndescription: \"old\"\nmode: subagent\nmodel: custom/observer-pin$high\nvariant: max\n---\n\nold body\n",
    )
    .unwrap();
    let zcode_agents = home.join(".zcode").join("agents");
    fs::create_dir_all(&zcode_agents).unwrap();
    fs::write(
        zcode_agents.join("oracle.md"),
        "---\nname: oracle\ndescription: \"old description\"\nmodel: custom/pinned-zcode\nthoughtLevel: max\ninjectAgentsMd: false\n---\n\nold body\n",
    )
    .unwrap();
}

/// The same hand edits at the USER-level destinations (`~/.claude/…`,
/// `~/.config/opencode/…`) for the `preserve_user` case — the flipped stub
/// shapes: settings.json without the owned `agent` key (deleted → the stub's
/// member must be re-inserted) and opencode.jsonc with `$schema` present but
/// user-modified (reset to canonical, replace path). The agent markdown legs
/// ride the unchanged frontmatter preservation.
fn seed_preserve_user(home: &Path) {
    let claude_agents = home.join(".claude").join("agents");
    fs::create_dir_all(&claude_agents).unwrap();
    fs::write(
        claude_agents.join("oracle.md"),
        "---\nname: oracle\ndescription: \"old description\"\ntools: Read\nmodel: custom/user-claude\neffort: max\n---\n\nold body\n",
    )
    .unwrap();
    fs::write(
        home.join(".claude").join("settings.json"),
        "{\n  \"model\": \"sonnet\",\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-user-home-token\"\n  }\n}\n",
    )
    .unwrap();
    let oc_agents = home.join(".config").join("opencode").join("agents");
    fs::create_dir_all(&oc_agents).unwrap();
    fs::write(
        home.join(".config").join("opencode").join("opencode.jsonc"),
        "{\n  // mine\n  \"$schema\": \"https://example.com/user-schema.json\",\n  \"model\": \"custom/user-oc\"\n}\n",
    )
    .unwrap();
    fs::write(
        oc_agents.join("oracle.md"),
        "---\ndescription: \"old\"\nmode: subagent\nmodel: custom/user-oc-agent\nvariant: high\n---\n\nold body\n",
    )
    .unwrap();
}

// --------------------------------------------------------------------- env

/// Restores every ambient variable the gate mutates when the test ends.
struct EnvGuard {
    saved: Vec<(&'static str, Option<OsString>)>,
}

impl EnvGuard {
    fn take(names: &[&'static str]) -> EnvGuard {
        EnvGuard {
            saved: names.iter().map(|n| (*n, std::env::var_os(n))).collect(),
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// Point the AMBIENT environment (what `workbench-core` reads) at the Rust
/// side's sandbox. `APPDATA` and `XDG_CONFIG_HOME` are set unconditionally so
/// no ambient home-relative resolution leaks out of the sandbox; the unused
/// one is simply never read.
fn set_ambient_env(sandbox: &Sandbox, dsh: bool) {
    if dsh {
        std::env::set_var("DSH_HOME", &sandbox.dsh_home);
        std::env::set_var(
            "MY_WORKBENCH_DSH_NODE_MODULES",
            sandbox.dsh_home.join("profiles").join("node_modules"),
        );
    } else {
        std::env::remove_var("DSH_HOME");
        std::env::remove_var("MY_WORKBENCH_DSH_NODE_MODULES");
    }
    std::env::set_var("APPDATA", sandbox.home.join("AppData"));
    std::env::set_var("XDG_CONFIG_HOME", sandbox.home.join(".config"));
}

/// The CLI child's sandboxed environment: every home-affecting variable points
/// into sandbox A; DSH-only variables exist only when the case needs them.
fn cli_env(sandbox: &Sandbox, dsh: bool) -> (Vec<(String, String)>, Vec<&'static str>) {
    let mut set = vec![
        (
            "HOME".to_string(),
            sandbox.home.to_string_lossy().into_owned(),
        ),
        (
            "USERPROFILE".to_string(),
            sandbox.home.to_string_lossy().into_owned(),
        ),
        (
            "APPDATA".to_string(),
            sandbox
                .home
                .join("AppData")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "XDG_CONFIG_HOME".to_string(),
            sandbox.home.join(".config").to_string_lossy().into_owned(),
        ),
    ];
    if dsh {
        set.push((
            "DSH_HOME".to_string(),
            sandbox.dsh_home.to_string_lossy().into_owned(),
        ));
        set.push((
            "MY_WORKBENCH_DSH_NODE_MODULES".to_string(),
            sandbox
                .dsh_home
                .join("profiles")
                .join("node_modules")
                .to_string_lossy()
                .into_owned(),
        ));
    }
    let remove: Vec<&'static str> = if dsh {
        Vec::new()
    } else {
        vec!["DSH_HOME", "MY_WORKBENCH_DSH_NODE_MODULES"]
    };
    (set, remove)
}

// ------------------------------------------------------------------ CLI run

struct CliRun {
    status: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Spawn `node <repo>/bin/my-workbench.js <flags>` in the given cwd with the
/// given sandboxed env (PATH gains the fixture bin in front), watchdogged at
/// [`CLI_TIMEOUT`].
fn run_cli(
    repo: &Path,
    flags: &[&str],
    cwd: &Path,
    env_set: &[(String, String)],
    env_remove: &[&str],
    fixture_bin: &Path,
) -> Result<CliRun, String> {
    let mut cmd = Command::new("node");
    cmd.arg(repo.join("bin").join("my-workbench.js"));
    cmd.args(flags);
    cmd.current_dir(cwd);
    for (name, value) in env_set {
        cmd.env(name, value);
    }
    for name in env_remove {
        cmd.env_remove(name);
    }
    let mut path_parts: Vec<PathBuf> = vec![fixture_bin.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        path_parts.extend(std::env::split_paths(&path));
    }
    cmd.env(
        "PATH",
        std::env::join_paths(&path_parts).map_err(|e| e.to_string())?,
    );
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("could not spawn node: {e}"))?;
    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("CLI run exceeded the 60s watchdog and was killed".to_string());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("could not wait for the CLI: {e}")),
        }
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut stream) = child.stdout.take() {
        let _ = stream.read_to_string(&mut stdout);
    }
    if let Some(mut stream) = child.stderr.take() {
        let _ = stream.read_to_string(&mut stderr);
    }
    Ok(CliRun {
        status: status.and_then(|s| s.code()),
        stdout,
        stderr,
    })
}

// ------------------------------------------------------- tree normalization

fn replace_all(haystack: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    if needle.is_empty() {
        return haystack.to_vec();
    }
    let mut out = Vec::with_capacity(haystack.len());
    let mut i = 0;
    while i < haystack.len() {
        if haystack[i..].starts_with(needle) {
            out.extend_from_slice(replacement);
            i += needle.len();
        } else {
            out.push(haystack[i]);
            i += 1;
        }
    }
    out
}

/// Replace every sandbox-specific absolute path with `{{HOME}}` / `{{SB}}`.
/// The home is replaced before the root it sits under, and each root is
/// replaced in backslash and forward-slash form (plain paths vs `file:` URLs).
fn normalize(bytes: &[u8], root: &str, home: &str) -> Vec<u8> {
    let mut out = bytes.to_vec();
    for (needle, tag) in [
        (home.as_bytes(), &b"{{HOME}}"[..]),
        (home.replace('\\', "/").as_bytes(), b"{{HOME}}"),
        (root.as_bytes(), b"{{SB}}"),
        (root.replace('\\', "/").as_bytes(), b"{{SB}}"),
    ] {
        out = replace_all(&out, needle, tag);
    }
    out
}

fn collect_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn rec(dir: &Path, base: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if WALK_SKIP.contains(&name.as_str()) {
                continue;
            }
            if path.is_dir() {
                rec(&path, base, out);
            } else {
                let rel = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    rec(root, root, &mut out);
    out
}

fn context_window(bytes: &[u8], offset: usize) -> String {
    let start = offset.saturating_sub(48);
    let end = (offset + 48).min(bytes.len());
    String::from_utf8_lossy(&bytes[start..end])
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

/// The §6 hard gate: identical relative file sets, byte-identical content
/// after sandbox-path normalization. Panics with the case, path and first
/// divergent offset.
fn compare_trees(cli: &Sandbox, core: &Sandbox, case: &str) {
    let cli_tree = collect_tree(&cli.root);
    let core_tree = collect_tree(&core.root);

    let only_cli: Vec<&String> = cli_tree.keys().filter(|k| !core_tree.contains_key(*k)).collect();
    let only_core: Vec<&String> = core_tree.keys().filter(|k| !cli_tree.contains_key(*k)).collect();
    assert!(
        only_cli.is_empty() && only_core.is_empty(),
        "case {case}: the sandbox trees hold different file sets\n  only CLI wrote: {only_cli:?}\n  only core wrote: {only_core:?}"
    );

    for (rel, cli_bytes) in &cli_tree {
        let core_bytes = &core_tree[rel];
        let cli_norm = normalize(cli_bytes, &cli.root.to_string_lossy(), &cli.home.to_string_lossy());
        let core_norm = normalize(
            core_bytes,
            &core.root.to_string_lossy(),
            &core.home.to_string_lossy(),
        );
        if cli_norm != core_norm {
            let offset = cli_norm
                .iter()
                .zip(core_norm.iter())
                .position(|(a, b)| a != b)
                .unwrap_or(cli_norm.len().min(core_norm.len()));
            panic!(
                "case {case}: {rel} diverges at byte offset {offset} after sandbox normalization \
                 (CLI len {}, core len {})\n  CLI  around offset: …{}\n  core around offset: …{}",
                cli_norm.len(),
                core_norm.len(),
                context_window(&cli_norm, offset),
                context_window(&core_norm, offset),
            );
        }
    }
}

// ------------------------------------------------------------- case matrix

struct Case {
    name: &'static str,
    cli_flags: &'static [&'static str],
    targets: &'static [Target],
    user_level: bool,
    force: bool,
    dsh: bool,
    /// Some(content) pre-seeds both projects with every PRESEED destination.
    preseed: Option<&'static str>,
    /// Pre-seed both sandboxes with the user-retuned files of [`seed_preserve`]
    /// (the preserve cases: `--force` must snapshot and restore them).
    preserve_seed: bool,
    /// Pre-seed both homes with the user-retuned user-level files of
    /// [`seed_preserve_user`] (the `preserve_user` case).
    preserve_seed_user: bool,
    /// `--dsh-profile <name>` narrowing (CLI-only flag; None means every
    /// profile).
    dsh_profile: Option<&'static str>,
    /// Run the install TWICE in both engines (see [`RERUN_TAMPER`]).
    rerun: bool,
}

/// Destinations tampered with identical bytes on BOTH sides between the two
/// runs of a `rerun` case: the regenerate trio must be repaired by the second
/// run, while the plain byte-copy `preset.yml` must survive it untouched —
/// locking the regenerate-vs-skip parity of a re-run.
const RERUN_TAMPER: [&str; 3] = [
    "dsh-home/.agent-presets/my-workbench/preset.yml",
    "dsh-home/.agent-presets/my-workbench/lane-plugin/package.json",
    "dsh-home/.agent-presets/my-workbench/lane-plugin-ui/lib/client.js",
];

/// Install the case via the CLI into sandbox A and via plan+execute into
/// sandbox B; returns both sandboxes plus the core-side plan (the SECOND
/// plan, when `case.rerun`) for extra per-case assertions.
fn run_install_case(
    case: &Case,
    repo: &Path,
    fixtures: &Fixtures,
    base: &Path,
) -> (Sandbox, Sandbox, Plan) {
    let cli = Sandbox::create(&base.join("cli"));
    let core = Sandbox::create(&base.join("core"));

    for sandbox in [&cli, &core] {
        if case.dsh {
            seed_dsh_home(&sandbox.root);
        }
        if let Some(content) = case.preseed {
            preseed(&sandbox.project, content);
        }
        if case.preserve_seed {
            seed_preserve(&sandbox.project, &sandbox.home);
        }
        if case.preserve_seed_user {
            seed_preserve_user(&sandbox.home);
        }
    }

    set_ambient_env(&core, case.dsh);

    let (env_set, env_remove) = cli_env(&cli, case.dsh);
    let run = run_cli(repo, case.cli_flags, &cli.project, &env_set, &env_remove, &fixtures.bin)
        .unwrap_or_else(|e| panic!("case {}: {e}", case.name));
    assert_eq!(
        run.status,
        Some(0),
        "case {}: the CLI exited with an error\n--- stderr ---\n{}\n--- stdout ---\n{}",
        case.name,
        run.stderr,
        run.stdout
    );

    let selection = Selection {
        source: Source::Bundled,
        project_dir: core.project.clone(),
        targets: case.targets.to_vec(),
        user_level: case.user_level,
        force: case.force,
        dsh_profile: case.dsh_profile.map(str::to_owned),
    };
    let ctx = EngineContext {
        project_dir: core.project.clone(),
        home: core.home.clone(),
        bundled_root: repo.to_path_buf(),
        version: workbench_core::VERSION.to_string(),
    };
    let run_core = |selection: &Selection| -> Plan {
        let planned = plan(selection, &ctx)
            .unwrap_or_else(|e| panic!("case {}: workbench-core plan failed: {e}", case.name));
        execute(&planned, selection, &ctx, &NullSink)
            .unwrap_or_else(|e| panic!("case {}: workbench-core execute failed: {e}", case.name));
        planned
    };
    let mut planned = run_core(&selection);

    // A second invocation of both engines: identical tampering on both sides,
    // then CLI again and a fresh plan+execute. The tree compare then proves
    // the regenerate trio was repaired and the skip-rest survived, on both
    // engines, with the same bytes.
    if case.rerun {
        for sandbox in [&cli, &core] {
            for rel in RERUN_TAMPER {
                fs::write(sandbox.root.join(rel), "TAMPERED-BY-GATE\n").unwrap();
            }
        }
        let rerun = run_cli(repo, case.cli_flags, &cli.project, &env_set, &env_remove, &fixtures.bin)
            .unwrap_or_else(|e| panic!("case {} (rerun): {e}", case.name));
        assert_eq!(
            rerun.status,
            Some(0),
            "case {} (rerun): the CLI exited with an error\n--- stderr ---\n{}\n--- stdout ---\n{}",
            case.name,
            rerun.stderr,
            rerun.stdout
        );
        planned = run_core(&selection);
    }
    (cli, core, planned)
}

/// Focused per-case assertions beyond the tree compare. `side` runs the same
/// checks against each sandbox: for the preserve cases the pinned frontmatter
/// values must have survived and the JSON stubs must have reconciled exactly,
/// in BOTH engines' trees.
fn extra_asserts(case: &Case, repo: &Path, cli: &Sandbox, core: &Sandbox, planned: &Plan) {
    let assert_preserved = |side: &Sandbox| {
        // ── frontmatter legs (unchanged) ─────────────────────────────────
        // Every pinned value survived the --force overwrite…
        let claude_oracle =
            fs::read_to_string(side.project.join(".claude/agents/oracle.md")).unwrap();
        assert!(
            claude_oracle.contains("model: custom/pinned-claude"),
            "the claude agent's retuned model line must survive --force"
        );
        // …and the render carries no `effort:` line, so the saved one must be
        // INSERTED as the frontmatter block's new last line.
        assert!(
            claude_oracle.contains("effort: high\n---"),
            "the claude agent's effort line must be inserted before the closing fence"
        );
        let oc_oracle =
            fs::read_to_string(side.project.join(".opencode/agents/oracle.md")).unwrap();
        assert!(oc_oracle.contains("model: custom/old-pin"));
        assert!(
            oc_oracle.contains("variant: max\n---"),
            "the opencode agent's variant line must be inserted before the closing fence"
        );
        // The observer render carries neither `model:` nor `variant:`, so both
        // saved lines must be INSERTED as the block's new last lines, in
        // saved order.
        let observer =
            fs::read_to_string(side.project.join(".opencode/agents/observer.md")).unwrap();
        assert!(
            observer.contains("bash: false\nmodel: custom/observer-pin$high\nvariant: max\n---"),
            "the added model and variant lines must be inserted before the closing fence"
        );
        // …while every non-model byte came from the render, not the preseed.
        assert!(claude_oracle.contains("Strategic technical advisor"));
        assert!(!claude_oracle.contains("old description"));
        assert!(!claude_oracle.contains("old body"));
        assert!(oc_oracle.contains("Strategic technical advisor"));
        assert!(observer.contains("Visual analysis specialist"));

        // ── JSON stub ownership legs ─────────────────────────────────────
        // settings.json: the stub owns ONLY `agent` — the user-modified value
        // is reset to canonical, and EVERY other user byte survives verbatim
        // (schema, model, effortLevel, env incl. the token-like value, hooks).
        let settings = fs::read_to_string(side.project.join(".claude/settings.json")).unwrap();
        assert_eq!(
            settings,
            "{\n  \"$schema\": \"https://json.schemastore.org/claude-code-settings.json\",\n  \"agent\": \"orchestrator\",\n  \"model\": \"sonnet\",\n  \"effortLevel\": \"high\",\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-user-example-token\",\n    \"MAX_THINKING_TOKENS\": \"32000\"\n  },\n  \"hooks\": {\n    \"PostToolUse\": [\n      { \"matcher\": \"Write\", \"hooks\": [ { \"type\": \"command\", \"command\": \"echo user-hook\" } ] }\n    ]\n  }\n}\n",
            "settings.json must reset only the owned agent key and keep every user byte"
        );
        // opencode.jsonc: the stub owns ONLY `$schema` — deleted here, so its
        // full member span is inserted before the closing brace; the comment
        // and the user's own model/small_model/agent keys survive verbatim.
        let jsonc = fs::read_to_string(side.project.join(".opencode/opencode.jsonc")).unwrap();
        assert_eq!(
            jsonc,
            "{\n  // tuned by hand\n  \"model\": \"custom/pinned-oc\",\n  \"small_model\": \"custom/small-pin\",\n  \"agent\": {\n    \"orchestrator\": { \"model\": \"custom/oc-lead\" }\n  },\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n",
            "opencode.jsonc must re-insert the owned $schema key and keep every user byte"
        );
    };
    match case.name {
        "default" => {
            assert_eq!(
                planned.stamps.len(),
                1,
                "default install stamps the project realm only"
            );
            assert_eq!(planned.stamps[0].realm, StampRealm::Project);
            assert_eq!(
                planned.stamps[0].path,
                core.project.join("my-workbench.version")
            );
        }
        "user" => {
            assert_eq!(
                planned.stamps.len(),
                1,
                "--user stamps the Home realm only"
            );
            assert_eq!(planned.stamps[0].realm, StampRealm::Home);
            assert_eq!(
                planned.stamps[0].path,
                core.home.join(".my-workbench.version")
            );
        }
        "zcode" => {
            let agents_md = fs::read_to_string(core.home.join(".zcode").join("AGENTS.md")).unwrap();
            assert!(!agents_md.contains("{{slot:"), "zcode slots must be filled");
        }
        "dsh" => {
            // Both profiles are maintained: the row lands in web AND cli.
            for name in ["web", "cli"] {
                let row = fs::read_to_string(
                    core.dsh_home.join("profiles").join(name).join("cordis.patch.yml"),
                )
                .unwrap();
                assert!(
                    row.contains("id: my-workbench-lanes-ui"),
                    "the managed block row must land in the {name} profile"
                );
            }
        }
        "dsh_rerun" => {
            let preset = core
                .dsh_home
                .join(".agent-presets")
                .join("my-workbench");
            // The regenerate trio was tampered with identically on both sides
            // and must come back as the fresh render…
            assert_eq!(
                fs::read(preset.join("lane-plugin/package.json")).unwrap(),
                fs::read(repo.join("agents/backends/dsh/lane-plugin/host-package/package.json"))
                    .unwrap()
            );
            assert_eq!(
                fs::read(preset.join("lane-plugin-ui/lib/client.js")).unwrap(),
                workbench_core::render::lane_ui_client_source(
                    repo,
                    &workbench_core::dsh::lanes(repo).unwrap(),
                    workbench_core::VERSION
                )
                .unwrap()
                .into_bytes()
            );
            // …while the plain preset.yml keeps its skip semantics.
            assert_eq!(
                fs::read_to_string(preset.join("preset.yml")).unwrap(),
                "TAMPERED-BY-GATE\n",
                "a non-regenerate file must survive a re-run without --force"
            );
            // And the second plan said exactly that.
            let kind_of = |rel: &str| {
                planned
                    .items
                    .iter()
                    .find(|i| i.path == preset.join(rel))
                    .unwrap_or_else(|| panic!("no plan item for {rel}"))
                    .kind
            };
            assert_eq!(kind_of("preset.yml"), workbench_core::types::PlanKind::Skip);
            assert_eq!(
                kind_of("lane-plugin/package.json"),
                workbench_core::types::PlanKind::Overwrite
            );
            assert_eq!(
                kind_of("lane-plugin-ui/package.json"),
                workbench_core::types::PlanKind::Overwrite
            );
            assert_eq!(
                kind_of("lane-plugin-ui/lib/client.js"),
                workbench_core::types::PlanKind::Overwrite
            );
        }
        "dsh_profile" => {
            let web_row = fs::read_to_string(
                core.dsh_home
                    .join("profiles")
                    .join("web")
                    .join("cordis.patch.yml"),
            )
            .unwrap();
            assert!(
                web_row.contains("id: my-workbench-lanes-ui"),
                "the named profile gets the row"
            );
            assert!(
                !core
                    .dsh_home
                    .join("profiles")
                    .join("cli")
                    .join("cordis.patch.yml")
                    .exists(),
                "the unselected profile must stay untouched"
            );
        }
        "force" => {
            // The pre-seeded bytes are not JSON at all: stub reconciliation
            // must leave the user's files COMPLETELY untouched even under
            // --force — user content is never overwritten with the stub.
            let jsonc = fs::read_to_string(core.project.join(".opencode/opencode.jsonc")).unwrap();
            assert_eq!(
                jsonc, "TAMPERED\n",
                "--force must not overwrite an unparseable user file with the stub"
            );
            let settings =
                fs::read_to_string(core.project.join(".claude/settings.json")).unwrap();
            assert_eq!(settings, "TAMPERED\n");
        }
        "preserve" => {
            assert_preserved(cli);
            assert_preserved(core);
        }
        "preserve_zcode" => {
            for side in [cli, core] {
                let oracle =
                    fs::read_to_string(side.home.join(".zcode/agents/oracle.md")).unwrap();
                assert!(
                    oracle.contains("model: custom/pinned-zcode"),
                    "the zcode agent's retuned model line must survive --force"
                );
                // The render carries no `thoughtLevel:` line, so the saved one
                // must be INSERTED as the block's new last line.
                assert!(
                    oracle.contains("thoughtLevel: max\n---"),
                    "the zcode agent's thoughtLevel line must be inserted before the closing fence"
                );
                // Non-model bytes came from the render, not the preseed.
                assert!(oracle.contains("Strategic technical advisor"));
                assert!(!oracle.contains("old body"));
            }
        }
        "preserve_user" => {
            for side in [cli, core] {
                // ── frontmatter legs (unchanged) ──
                let claude_oracle =
                    fs::read_to_string(side.home.join(".claude/agents/oracle.md")).unwrap();
                assert!(claude_oracle.contains("model: custom/user-claude"));
                assert!(claude_oracle.contains("effort: max\n---"));
                assert!(claude_oracle.contains("Strategic technical advisor"));
                assert!(!claude_oracle.contains("old body"));
                let oc_oracle = fs::read_to_string(
                    side.home.join(".config/opencode/agents/oracle.md"),
                )
                .unwrap();
                assert!(oc_oracle.contains("model: custom/user-oc-agent"));
                assert!(oc_oracle.contains("variant: high\n---"));
                assert!(oc_oracle.contains("Strategic technical advisor"));
                assert!(!oc_oracle.contains("old body"));
                // ── JSON stub ownership legs ──
                // ~/.claude/settings.json: the owned `agent` key was DELETED —
                // its full member span is re-inserted before the closing
                // brace; every user byte (model, env token) survives.
                let settings =
                    fs::read_to_string(side.home.join(".claude/settings.json")).unwrap();
                assert_eq!(
                    settings,
                    "{\n  \"model\": \"sonnet\",\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-user-home-token\"\n  },\n  \"agent\": \"orchestrator\"\n}\n",
                    "the deleted agent key must be re-inserted whole"
                );
                // ~/.config/opencode/opencode.jsonc: `$schema` present but
                // user-modified — reset to canonical; comment and model key
                // survive.
                let jsonc = fs::read_to_string(
                    side.home.join(".config/opencode/opencode.jsonc"),
                )
                .unwrap();
                assert_eq!(
                    jsonc,
                    "{\n  // mine\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"model\": \"custom/user-oc\"\n}\n",
                    "the user-modified $schema value must reset to canonical"
                );
            }
        }
        "skip" => {
            // Proves both sides actually SKIPPED instead of rewriting. The
            // version stamp is deliberately absent here: it is always
            // restamped (never skip-gated) on both sides.
            for (rel, _) in PRESEED.iter().take(3) {
                let content = fs::read_to_string(core.project.join(rel)).unwrap();
                assert_eq!(content, "SEEDED\n", "{rel} must survive untouched without --force");
            }
        }
        _ => {}
    }
}

// ------------------------------------------------------------------- test

#[test]
fn golden_end_to_end_cli_vs_workbench_core() {
    // CI always has node; a bare dev box without it skips the gate loudly.
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("golden_end_to_end: node is not on PATH — skipping the golden gate");
        return;
    }

    let _env = EnvGuard::take(&[
        "PATH",
        "APPDATA",
        "XDG_CONFIG_HOME",
        "DSH_HOME",
        "MY_WORKBENCH_DSH_NODE_MODULES",
    ]);

    let repo = repo_root();

    // Version alignment is part of the gate: the CLI stamps package.json's
    // version, the engine stamps ctx.version — here pinned to crate::VERSION.
    let package_json: Value =
        serde_json::from_str(&fs::read_to_string(repo.join("package.json")).unwrap()).unwrap();
    let cli_version = package_json
        .get("version")
        .and_then(Value::as_str)
        .expect("package.json carries a version");
    assert_eq!(
        cli_version,
        workbench_core::VERSION,
        "npm package version and workbench-core VERSION drifted; the golden stamps could never match"
    );

    let run_dir = tempfile::Builder::new()
        .prefix("wb-golden-")
        .tempdir()
        .unwrap();
    let fixtures = make_fixtures(run_dir.path());

    // Ambient PATH: the fake opencode launcher goes first so the engine's
    // find_on_path probe is deterministic regardless of the host.
    let mut path_parts: Vec<PathBuf> = vec![fixtures.bin.clone()];
    path_parts.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    std::env::set_var("PATH", std::env::join_paths(&path_parts).unwrap());

    let cases: &[Case] = &[
        Case { // 1
            name: "default",
            cli_flags: &[],
            targets: &[Target::Opencode, Target::Claude],
            user_level: false,
            force: false,
            dsh: false,
            preseed: None,
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 2
            name: "user",
            cli_flags: &["--user"],
            targets: &[Target::Opencode, Target::Claude],
            user_level: true,
            force: false,
            dsh: false,
            preseed: None,
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 3
            name: "zcode",
            cli_flags: &["--zcode"],
            targets: &[Target::Zcode],
            user_level: false,
            force: false,
            dsh: false,
            preseed: None,
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 4
            name: "dsh",
            cli_flags: &["--dsh"],
            targets: &[Target::Dsh],
            user_level: false,
            force: false,
            dsh: true,
            preseed: None,
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 5
            // Runs --dsh TWICE in both engines with identical tampering in
            // between: locks the regenerate-trio refresh plus skip-the-rest
            // parity of a re-run.
            name: "dsh_rerun",
            cli_flags: &["--dsh"],
            targets: &[Target::Dsh],
            user_level: false,
            force: false,
            dsh: true,
            preseed: None,
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: true,
        },
        Case { // 6
            name: "dsh_profile",
            cli_flags: &["--dsh", "--dsh-profile", "web"],
            targets: &[Target::Dsh],
            user_level: false,
            force: false,
            dsh: true,
            preseed: None,
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: Some("web"),
            rerun: false,
        },
        Case { // 7
            name: "force",
            cli_flags: &["--force"],
            targets: &[Target::Opencode, Target::Claude],
            user_level: false,
            force: true,
            dsh: false,
            preseed: Some("TAMPERED\n"),
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 8
            name: "skip",
            cli_flags: &[],
            targets: &[Target::Opencode, Target::Claude],
            user_level: false,
            force: false,
            dsh: false,
            preseed: Some("SEEDED\n"),
            preserve_seed: false,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 9
            // --force over user-retuned files: agent markdown must snapshot
            // the user's model lines and write them back into the fresh
            // renders, while the two JSON stubs reconcile the stub's own keys
            // into the user's files — all byte-identically (see seed_preserve
            // for the rule paths and shapes covered).
            name: "preserve",
            cli_flags: &["--force"],
            targets: &[Target::Opencode, Target::Claude],
            user_level: false,
            force: true,
            dsh: false,
            preseed: None,
            preserve_seed: true,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 10
            // The same contract at the zcode user-level target: ~/.zcode/agents
            // is an `agents/` destination, so its pins survive --force too.
            name: "preserve_zcode",
            cli_flags: &["--zcode", "--force"],
            targets: &[Target::Zcode],
            user_level: false,
            force: true,
            dsh: false,
            preseed: None,
            preserve_seed: true,
            preserve_seed_user: false,
            dsh_profile: None,
            rerun: false,
        },
        Case { // 11
            // The overwrite contract at the --user destinations: ~/.claude
            // (agents + settings.json, stub-owned `agent` key re-inserted) and
            // ~/.config/opencode (opencode.jsonc, user-modified `$schema`
            // reset + agents) ride a user-level --force overwrite —
            // byte-identically in both engines.
            name: "preserve_user",
            cli_flags: &["--user", "--force"],
            targets: &[Target::Opencode, Target::Claude],
            user_level: true,
            force: true,
            dsh: false,
            preseed: None,
            preserve_seed: false,
            preserve_seed_user: true,
            dsh_profile: None,
            rerun: false,
        },
    ];

    for (index, case) in cases.iter().enumerate() {
        let base = run_dir.path().join(format!("{:02}-{}", index + 1, case.name));
        let (cli, core, planned) = run_install_case(case, &repo, &fixtures, &base);
        extra_asserts(case, &repo, &cli, &core, &planned);
        compare_trees(&cli, &core, case.name);
    }

    // 9 — tamper-drift (Rust-side only): install via the CLI, tamper one
    // file, then check_drift must report exactly that file.
    {
        let base = run_dir.path().join("09-tamper-drift");
        let sandbox = Sandbox::create(&base.join("cli"));
        set_ambient_env(&sandbox, false);
        let (env_set, env_remove) = cli_env(&sandbox, false);
        let run = run_cli(&repo, &[], &sandbox.project, &env_set, &env_remove, &fixtures.bin)
            .unwrap_or_else(|e| panic!("tamper-drift: {e}"));
        assert_eq!(
            run.status,
            Some(0),
            "tamper-drift: the CLI exited with an error\n--- stderr ---\n{}\n--- stdout ---\n{}",
            run.stderr,
            run.stdout
        );

        let tampered = sandbox.project.join(".claude").join("settings.json");
        let mut body = fs::read_to_string(&tampered).unwrap();
        body.push_str("\nTAMPERED BY THE GOLDEN GATE\n");
        fs::write(&tampered, body).unwrap();

        let selection = Selection {
            source: Source::Bundled,
            project_dir: sandbox.project.clone(),
            targets: vec![Target::Opencode, Target::Claude],
            user_level: false,
            force: false,
            dsh_profile: None,
        };
        let ctx = EngineContext {
            project_dir: sandbox.project.clone(),
            home: sandbox.home.clone(),
            bundled_root: repo.clone(),
            version: workbench_core::VERSION.to_string(),
        };
        let drift = check_drift(&Source::Bundled, &selection, &ctx).unwrap();
        assert_eq!(
            drift.tier1.drifted.len(),
            1,
            "exactly the tampered file must be reported as drift: {:?}",
            drift.tier1.drifted
        );
        assert_eq!(drift.tier1.drifted[0].path, tampered);
        assert_eq!(drift.tier1.drifted[0].target, Target::Claude);
        assert!(
            !drift
                .tier1
                .drifted
                .iter()
                .any(|f| f.source_rel == "opencode.jsonc"),
            "untouched files must not be reported as drift"
        );
    }
}
