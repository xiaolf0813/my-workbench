//! Golden anti-drift gate (PLAN.md §6) — the hard byte-identity contract
//! between the Node CLI (`bin/my-workbench.js`) and the Rust port
//! (`workbench-core`).
//!
//! For every scenario in the §6 matrix the gate builds two sibling sandbox
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
//! pre-existing tool install (the omos marker, the DSH module closure) all
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

/// Fake user-level omos install: the marker directory the CLI's
/// `omosUserLevelPresent` gate requires. Lives under `node_modules`, so the
/// tree walk never sees it.
fn seed_omos_marker(home: &Path) {
    let dir = home
        .join(".config")
        .join("opencode")
        .join("node_modules")
        .join("oh-my-opencode-slim");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("package.json"),
        r#"{"name":"oh-my-opencode-slim","version":"1.0.0"}"#,
    )
    .unwrap();
}

/// Fake OpenBitFun install: its per-OS config directory must exist for the
/// CLI's prerequisite gate. Empty on both sides — nothing inside is written.
fn seed_openbitfun_config(home: &Path) {
    let dir = if cfg!(windows) {
        home.join("AppData").join("openbitfun")
    } else {
        home.join(".config").join("openbitfun")
    };
    fs::create_dir_all(dir).unwrap();
}

/// Fake DSH home: TWO profiles (`web` with a cordis.yml plus a second one, so
/// `findProfileDir` must pick `web`), and the profile-root module closure
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
/// side's sandbox. `openbitfun` resolves through `APPDATA` on Windows and
/// `XDG_CONFIG_HOME` elsewhere; both are set unconditionally, the unused one
/// is simply never read.
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
    omos_marker: bool,
    dsh: bool,
    openbitfun: bool,
    /// Some(content) pre-seeds both projects with every PRESEED destination.
    preseed: Option<&'static str>,
}

/// Install the case via the CLI into sandbox A and via plan+execute into
/// sandbox B; returns both sandboxes plus the core-side plan for extra
/// per-case assertions.
fn run_install_case(
    case: &Case,
    repo: &Path,
    fixtures: &Fixtures,
    base: &Path,
) -> (Sandbox, Sandbox, Plan) {
    let cli = Sandbox::create(&base.join("cli"));
    let core = Sandbox::create(&base.join("core"));

    for sandbox in [&cli, &core] {
        if case.omos_marker {
            seed_omos_marker(&sandbox.home);
        }
        if case.dsh {
            seed_dsh_home(&sandbox.root);
        }
        if case.openbitfun {
            seed_openbitfun_config(&sandbox.home);
        }
        if let Some(content) = case.preseed {
            preseed(&sandbox.project, content);
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
    };
    let ctx = EngineContext {
        project_dir: core.project.clone(),
        home: core.home.clone(),
        bundled_root: repo.to_path_buf(),
        version: workbench_core::VERSION.to_string(),
    };
    let planned = plan(&selection, &ctx)
        .unwrap_or_else(|e| panic!("case {}: workbench-core plan failed: {e}", case.name));
    execute(&planned, &selection, &ctx, &NullSink)
        .unwrap_or_else(|e| panic!("case {}: workbench-core execute failed: {e}", case.name));
    (cli, core, planned)
}

/// Focused per-case assertions beyond the tree compare.
fn extra_asserts(case: &Case, core: &Sandbox, planned: &Plan) {
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
        "omos" => {
            let append = core
                .project
                .join(".opencode")
                .join("oh-my-opencode-slim")
                .join("orchestrator_append.md");
            let body = fs::read_to_string(&append).unwrap();
            assert!(
                !body.contains("{{disciplines}}"),
                "the omos append must render its disciplines marker"
            );
        }
        "zcode" => {
            let agents_md = fs::read_to_string(core.home.join(".zcode").join("AGENTS.md")).unwrap();
            assert!(!agents_md.contains("{{slot:"), "zcode slots must be filled");
        }
        "dsh" => {
            let web_row = core
                .dsh_home
                .join("profiles")
                .join("web")
                .join("cordis.patch.yml");
            let row = fs::read_to_string(&web_row).unwrap();
            assert!(
                row.contains("id: my-workbench-lanes-ui"),
                "the managed block row must land in the web profile"
            );
            assert!(
                !core
                    .dsh_home
                    .join("profiles")
                    .join("cli")
                    .join("cordis.patch.yml")
                    .exists(),
                "the second profile must stay untouched"
            );
        }
        "openbitfun" => {
            let dir = if cfg!(windows) {
                core.home.join("AppData").join("openbitfun").join("agents")
            } else {
                core.home.join(".config").join("openbitfun").join("agents")
            };
            assert!(fs::read_dir(&dir).unwrap().count() > 0, "openbitfun agents must be installed");
        }
        "force" => {
            let jsonc = fs::read_to_string(core.project.join(".opencode/opencode.jsonc")).unwrap();
            assert_ne!(jsonc, "TAMPERED\n", "--force must overwrite the pre-seeded file");
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
            omos_marker: false,
            dsh: false,
            openbitfun: false,
            preseed: None,
        },
        Case { // 2
            name: "user",
            cli_flags: &["--user"],
            targets: &[Target::Opencode, Target::Claude],
            user_level: true,
            force: false,
            omos_marker: false,
            dsh: false,
            openbitfun: false,
            preseed: None,
        },
        Case { // 3
            name: "omos",
            cli_flags: &["--omos"],
            targets: &[Target::Omos],
            user_level: false,
            force: false,
            omos_marker: true,
            dsh: false,
            openbitfun: false,
            preseed: None,
        },
        Case { // 4
            name: "zcode",
            cli_flags: &["--zcode"],
            targets: &[Target::Zcode],
            user_level: false,
            force: false,
            omos_marker: false,
            dsh: false,
            openbitfun: false,
            preseed: None,
        },
        Case { // 5
            name: "dsh",
            cli_flags: &["--dsh"],
            targets: &[Target::Dsh],
            user_level: false,
            force: false,
            omos_marker: false,
            dsh: true,
            openbitfun: false,
            preseed: None,
        },
        Case { // 6
            name: "openbitfun",
            cli_flags: &["--openbitfun"],
            targets: &[Target::Openbitfun],
            user_level: false,
            force: false,
            omos_marker: false,
            dsh: false,
            openbitfun: true,
            preseed: None,
        },
        Case { // 7
            name: "force",
            cli_flags: &["--force"],
            targets: &[Target::Opencode, Target::Claude],
            user_level: false,
            force: true,
            omos_marker: false,
            dsh: false,
            openbitfun: false,
            preseed: Some("TAMPERED\n"),
        },
        Case { // 8
            name: "skip",
            cli_flags: &[],
            targets: &[Target::Opencode, Target::Claude],
            user_level: false,
            force: false,
            omos_marker: false,
            dsh: false,
            openbitfun: false,
            preseed: Some("SEEDED\n"),
        },
    ];

    for (index, case) in cases.iter().enumerate() {
        let base = run_dir.path().join(format!("{:02}-{}", index + 1, case.name));
        let (cli, core, planned) = run_install_case(case, &repo, &fixtures, &base);
        extra_asserts(case, &core, &planned);
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

    // 10 — the --opencode/--omos mutex, on both sides (no tree compare).
    {
        let base = run_dir.path().join("10-opencode-omos-mutex");
        let sandbox = Sandbox::create(&base.join("cli"));
        set_ambient_env(&sandbox, false);
        let (env_set, env_remove) = cli_env(&sandbox, false);
        let run = run_cli(
            &repo,
            &["--opencode", "--omos"],
            &sandbox.project,
            &env_set,
            &env_remove,
            &fixtures.bin,
        )
        .unwrap_or_else(|e| panic!("mutex: {e}"));
        assert_ne!(
            run.status,
            Some(0),
            "the CLI must reject --opencode --omos; stdout:\n{}",
            run.stdout
        );
        assert!(
            run.stderr.contains("--omos cannot be combined with --opencode"),
            "the CLI's rejection must name the mutex; stderr:\n{}",
            run.stderr
        );

        let selection = Selection {
            source: Source::Bundled,
            project_dir: sandbox.project.clone(),
            targets: vec![Target::Opencode, Target::Omos],
            user_level: false,
            force: false,
        };
        let ctx = EngineContext {
            project_dir: sandbox.project.clone(),
            home: sandbox.home.clone(),
            bundled_root: repo.clone(),
            version: workbench_core::VERSION.to_string(),
        };
        let err = plan(&selection, &ctx)
            .expect_err("workbench-core must reject --opencode --omos");
        assert!(
            err.to_string()
                .contains("--omos cannot be combined with --opencode"),
            "core rejection must name the mutex: {err}"
        );
    }
}
