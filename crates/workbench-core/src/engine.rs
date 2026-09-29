//! The two-phase install engine: `plan` / `execute` / `check_drift` /
//! `detect_environment` — a semantic port of the Node CLI's install path
//! (`bin/my-workbench.js`).
//!
//! Source-root convention (shared with `roster`/`render`/`checks`): the
//! `source_root` passed across lanes is the directory CONTAINING `agents/`
//! (the package root), i.e. `agents/` hangs below it. `EngineContext::source_root`
//! supplies it for both bundled and local sources.
//!
//! Phase split (PLAN.md §4): `plan` performs zero writes and returns one
//! [`PlanItem`] per file (`create` | `skip` | `overwrite`; DSH managed blocks
//! pass through) plus realm stamps and notes. `execute` replays a plan and
//! writes exactly what plan decided — dry-run is not a flag here. Rendering is
//! done once per entry point (into [`Action`]s); execution never re-decides
//! kinds, it only consults the plan.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::*;
use crate::WorkbenchError;
use crate::{checks, dsh, dsh_deps, render, roster};

// ---------------------------------------------------------------- constants

/// Stamp file written once per deployment realm (CLI :26).
const VERSION_FILE: &str = "my-workbench.version";
/// The user-realm stamp, hidden in the home directory (CLI :29).
const HOME_VERSION_FILE: &str = ".my-workbench.version";
/// npm package name of the omos plugin (CLI :35).
const OMOS_PACKAGE: &str = "oh-my-opencode-slim";
/// The ONE rendered asset: the omos orchestrator append (CLI :478).
const OMOS_APPEND_REL: &str = "oh-my-opencode-slim/orchestrator_append.md";
/// Progress phase label carried on [`InstallEvent::Progress`].
/// Progress-line phase shown verbatim in the GUI progress row (`正在安装 · i/n · p%`).
const PROGRESS_PHASE: &str = "正在安装";

/// A copy set: source dir under `agents/backends/` plus its entries (CLI :38-57).
struct CopySet {
    /// Subdirectory of `agents/backends/` the entries come from.
    backend_dir: &'static str,
    /// Destination subdirectory at project level (".opencode"/".claude").
    dest: &'static str,
    /// Entries copied as-is; directories are walked recursively.
    entries: &'static [&'static str],
    /// The omos set renders exactly one asset (the orchestrator append).
    is_omos: bool,
}

const SET_OPENCODE: CopySet = CopySet {
    backend_dir: "opencode",
    dest: ".opencode",
    entries: &["opencode.jsonc"],
    is_omos: false,
};

const SET_OMOS: CopySet = CopySet {
    backend_dir: "omos",
    dest: ".opencode",
    entries: &[
        "oh-my-opencode-slim.jsonc",
        "oh-my-opencode-slim",
        "package.json",
    ],
    is_omos: true,
};

const SET_CLAUDE: CopySet = CopySet {
    backend_dir: "claude",
    dest: ".claude",
    entries: &["settings.json"],
    is_omos: false,
};

// --------------------------------------------------------------- traversal

/// One unit of work the traversal produced: either file bytes to copy
/// byte-for-byte, or already-rendered text to write.
struct Action {
    target: Target,
    dest: PathBuf,
    /// Source-relative origin, for display (forward slashes).
    source_rel: String,
    content: ActionContent,
}

enum ActionContent {
    Bytes(Vec<u8>),
    Text(String),
}

impl ActionContent {
    fn bytes(&self) -> &[u8] {
        match self {
            ActionContent::Bytes(b) => b,
            ActionContent::Text(t) => t.as_bytes(),
        }
    }
}

/// Ordered traversal output. `notes` keeps every note and warning in CLI
/// emission order; `warning_idx` marks which entries are warnings so `execute`
/// can log them at warn level and count them into the report.
#[derive(Default)]
struct Traversal {
    actions: Vec<Action>,
    notes: Vec<String>,
    warning_idx: Vec<usize>,
}

impl Traversal {
    fn push_warning(&mut self, text: String) {
        self.warning_idx.push(self.notes.len());
        self.notes.push(text);
    }
}

/// Per-target install scope (CLI :1726-1739). `dest` is "" at user level
/// (files land directly in the scope root); `display` only feeds note text.
struct Scope {
    root: PathBuf,
    dest: &'static str,
    display: String,
}

fn is_project_target(t: &Target) -> bool {
    matches!(t, Target::Opencode | Target::Omos | Target::Claude)
}

fn is_user_level_only_target(t: &Target) -> bool {
    matches!(t, Target::Zcode | Target::Dsh | Target::Openbitfun)
}

fn opencode_scope(sel: &Selection, ctx: &EngineContext) -> Scope {
    if sel.user_level {
        Scope {
            root: ctx.home.join(".config").join("opencode"),
            dest: "",
            display: "~/.config/opencode/".to_string(),
        }
    } else {
        Scope {
            // The user's picked project directory (Selection) is authoritative.
            root: sel.project_dir.clone(),
            dest: ".opencode",
            display: ".opencode/".to_string(),
        }
    }
}

fn claude_scope(sel: &Selection, ctx: &EngineContext) -> Scope {
    if sel.user_level {
        Scope {
            root: ctx.home.join(".claude"),
            dest: "",
            display: "~/.claude/".to_string(),
        }
    } else {
        Scope {
            // The user's picked project directory (Selection) is authoritative.
            root: sel.project_dir.clone(),
            dest: ".claude",
            display: ".claude/".to_string(),
        }
    }
}

/// Join a destination under a scope: `root/<dest>/<rel>`, where `dest` is ""
/// at user level and the scope's root already IS the config root.
fn scope_join(scope: &Scope, rel: &Path) -> PathBuf {
    let mut p = scope.root.clone();
    if !scope.dest.is_empty() {
        p.push(scope.dest);
    }
    p.join(rel)
}

/// Forward-slash form of a relative path, for `source_rel` display strings.
fn path_to_posix(p: &Path) -> String {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Never copied, no matter where they appear (CLI :145-152).
fn is_skipped(name: &str) -> bool {
    name == "node_modules"
        || name == "package-lock.json"
        || name == "settings.local.json"
        || name.starts_with('.')
}

/// Deterministic recursive walk collecting files (CLI :374-381; entries are
/// visited in sorted order where the CLI uses `readdirSync` order).
fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|e| e.path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if is_skipped(&name) {
            continue;
        }
        if path.is_dir() {
            walk_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

// -------------------------------------------------------- JS text helpers

/// JS `\s` character class (used by the CLI's regexes and `.replace(/\s+$/)`).
fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{000B}'
            | '\u{000C}'
            | '\r'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

fn trim_end_js(s: &str) -> &str {
    s.trim_end_matches(is_js_ws)
}

fn trim_js(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// JS `str.replace(/\s+/g, " ")`: collapse every whitespace run to one space.
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_ws(c) {
            in_ws = true;
            continue;
        }
        if in_ws && !out.is_empty() {
            out.push(' ');
        }
        in_ws = false;
        out.push(c);
    }
    out
}

fn heading_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^#{1,6}\s+Response Convention\s*$").unwrap())
}

fn next_heading_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^#{1,6}(\s|$)").unwrap())
}

fn placeholder_line_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^\s*\{\{[\w:-]+\}\}\s*$").unwrap())
}

fn list_item_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^\s*(?:[-*+]|\d+[.)])[ \t]").unwrap())
}

// -------------------------------------------------- the one rendered asset

/// Whitespace-normalized body of the one `Response Convention` section in one
/// file (CLI :1256-1274): after the heading until the next ATX heading,
/// placeholder lines removed, whitespace collapsed — except list-item-opening
/// lines carry a `\0` sentinel so list structure changes still fail.
fn response_convention_body(source_root: &Path, rel: &str) -> Result<String, WorkbenchError> {
    let text = fs::read_to_string(source_root.join(rel))?;
    let lines: Vec<&str> = text.split('\n').collect();
    let heading_re = heading_regex();
    let at: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| heading_re.is_match(l))
        .map(|(i, _)| i)
        .collect();
    if at.is_empty() {
        return Err(WorkbenchError::Message(format!(
            "{rel} has no 'Response Convention' heading"
        )));
    }
    if at.len() > 1 {
        return Err(WorkbenchError::Message(format!(
            "{rel} has {} 'Response Convention' headings; expected exactly one",
            at.len()
        )));
    }
    let next_re = next_heading_regex();
    let placeholder_re = placeholder_line_regex();
    let list_re = list_item_regex();
    let mut body: Vec<String> = Vec::new();
    for line in lines.iter().skip(at[0] + 1) {
        if next_re.is_match(line) {
            break;
        }
        if placeholder_re.is_match(line) {
            continue;
        }
        if list_re.is_match(line) {
            body.push(format!("\u{0}{line}"));
        } else {
            body.push((*line).to_string());
        }
    }
    let joined = body.join(" ");
    let collapsed = collapse_ws(&joined);
    let text = trim_js(&collapsed);
    if text.is_empty() {
        return Err(WorkbenchError::Message(format!(
            "{rel} has an empty 'Response Convention' section"
        )));
    }
    Ok(text.to_string())
}

/// Fail unless both authored copies of the convention agree (CLI :1277-1283).
fn assert_response_convention_sync(source_root: &Path) -> Result<(), WorkbenchError> {
    const PROMPT: &str = "agents/prompts/orchestrator.md";
    const APPEND: &str = "agents/backends/omos/oh-my-opencode-slim/orchestrator_append.md";
    if response_convention_body(source_root, PROMPT)? != response_convention_body(source_root, APPEND)? {
        return Err(WorkbenchError::Message(format!(
            "'Response Convention' diverges between {PROMPT} and {APPEND} \
             (heading depth, line wrapping and blank lines are ignored); align the two copies"
        )));
    }
    Ok(())
}

/// Render the omos orchestrator append (CLI :1290-1302): substitute
/// `{{disciplines}}` with the trimmed universal disciplines. JS
/// `String.replace(string, …)` replaces the FIRST occurrence only.
fn render_omos_append(source_root: &Path, source: &str) -> Result<String, WorkbenchError> {
    assert_response_convention_sync(source_root)?;
    const MARKER: &str = "{{disciplines}}";
    if !source.contains(MARKER) {
        return Err(WorkbenchError::Message(
            "agents/backends/omos/oh-my-opencode-slim/orchestrator_append.md must contain {{disciplines}}"
                .to_string(),
        ));
    }
    let raw = fs::read_to_string(source_root.join("agents").join("disciplines.md"))?;
    let disciplines = trim_end_js(&raw);
    let mut out = source.to_string();
    if let Some(at) = source.find(MARKER) {
        out.replace_range(at..at + MARKER.len(), disciplines);
    }
    Ok(out)
}

// -------------------------------------------------------------- collection

fn collect_copy_entries(
    set: &CopySet,
    target: Target,
    scope: &Scope,
    source_root: &Path,
    t: &mut Traversal,
) -> Result<(), WorkbenchError> {
    let from = source_root
        .join("agents")
        .join("backends")
        .join(set.backend_dir);
    if !from.is_dir() {
        t.notes.push(format!(
            "warn: source directory for '{}' is missing in this installation, skipped",
            set.dest
        ));
        return Ok(());
    }
    for entry in set.entries {
        let src = from.join(entry);
        if !src.exists() {
            t.notes.push(format!(
                "warn: missing entry '{}' in {} source, skipped",
                entry, set.dest
            ));
            continue;
        }
        if src.is_dir() {
            let mut files = Vec::new();
            walk_files(&src, &mut files)?;
            for file in files {
                let rel = file
                    .strip_prefix(&src)
                    .expect("walked file lives under the entry");
                let dest_rel = Path::new(entry).join(rel);
                push_copy_action(set, target, &file, &dest_rel, scope, source_root, t)?;
            }
        } else {
            push_copy_action(set, target, &src, Path::new(entry), scope, source_root, t)?;
        }
    }
    Ok(())
}

/// Copy one asset (CLI :476-483): ONLY the omos orchestrator append is
/// rendered; everything else copies byte-for-byte.
fn push_copy_action(
    set: &CopySet,
    target: Target,
    src: &Path,
    dest_rel: &Path,
    scope: &Scope,
    source_root: &Path,
    t: &mut Traversal,
) -> Result<(), WorkbenchError> {
    let source_rel = path_to_posix(dest_rel);
    let dest = scope_join(scope, dest_rel);
    let content = if set.is_omos && source_rel == OMOS_APPEND_REL {
        ActionContent::Text(render_omos_append(source_root, &fs::read_to_string(src)?)?)
    } else {
        ActionContent::Bytes(fs::read(src)?)
    };
    t.actions.push(Action {
        target,
        dest,
        source_rel,
        content,
    });
    Ok(())
}

/// Assemble every agent of a backend into `out_dir` with copyOne semantics
/// (CLI :693-700): the backend's roster agents, sorted by name.
fn collect_backend_agents(
    backend: &'static str,
    out_dir: PathBuf,
    target: Target,
    source_root: &Path,
    t: &mut Traversal,
    slots: &mut render::UsedSlots,
) -> Result<(), WorkbenchError> {
    let entries = roster::load_roster(source_root)?;
    let mut agents: Vec<&roster::AgentEntry> = entries
        .iter()
        .filter(|e| {
            e.record
                .get("frontmatter")
                .and_then(|f| f.get(backend))
                .is_some()
        })
        .collect();
    agents.sort_by(|a, b| a.name.cmp(&b.name));
    for agent in agents {
        let content = render::assemble_agent(source_root, backend, agent, slots)?;
        t.actions.push(Action {
            target,
            dest: out_dir.join(format!("{}.md", agent.name)),
            source_rel: format!("{}.md", agent.name),
            content: ActionContent::Text(content),
        });
    }
    Ok(())
}

/// Surface unused-slot warnings once per backend. The frozen `unused_warnings()`
/// signature emits complete CLI-format lines (`warn: unused slot '…'`); reword
/// them for the GUI log and pass anything else through unchanged.
fn push_slot_warnings(t: &mut Traversal, backend: &str, slots: &render::UsedSlots) {
    for raw in slots.unused_warnings() {
        let slot = raw
            .strip_prefix("warn: unused slot '")
            .and_then(|rest| rest.strip_suffix(&format!("' in agents/backends/{backend}/slots/")));
        let text = match slot {
            Some(slot) => format!("未使用的槽位 {slot}（agents/backends/{backend}/slots/）"),
            None => raw,
        };
        t.push_warning(text);
    }
}

/// True when an omos install already exists at user level (CLI :486-494).
fn omos_user_level_present(home: &Path) -> bool {
    let cfg_dir = home.join(".config").join("opencode");
    if cfg_dir.join("node_modules").join(OMOS_PACKAGE).exists() {
        return true;
    }
    for name in ["opencode.json", "opencode.jsonc"] {
        let file = cfg_dir.join(name);
        if file.exists() {
            // The CLI would crash on an unreadable file; the port treats it as
            // not mentioning the package (lenient on purpose).
            if let Ok(text) = fs::read_to_string(&file) {
                if text.contains(OMOS_PACKAGE) {
                    return true;
                }
            }
        }
    }
    false
}

/// Targets before the DSH position in APPLY_ORDER: opencode → omos → claude →
/// zcode (CLI :1756-1763).
fn collect_before_dsh(
    sel: &Selection,
    ctx: &EngineContext,
    source_root: &Path,
    t: &mut Traversal,
) -> Result<(), WorkbenchError> {
    if sel.targets.contains(&Target::Opencode) {
        let scope = opencode_scope(sel, ctx);
        collect_copy_entries(&SET_OPENCODE, Target::Opencode, &scope, source_root, t)?;
        if omos_user_level_present(&ctx.home) {
            // CLI :1092-1103: switch wholesale to the omos assets — native
            // agents would conflict with omos-provided agents.
            t.notes.push(
                "user-level omos install detected; installing the omos way: omos config + prompt overrides copied, native agents/ skipped to avoid agent conflicts (the plugin loads from user level)"
                    .to_string(),
            );
            collect_copy_entries(&SET_OMOS, Target::Opencode, &scope, source_root, t)?;
        } else {
            let mut slots = render::UsedSlots::new();
            collect_backend_agents(
                "opencode",
                scope_join(&scope, Path::new("agents")),
                Target::Opencode,
                source_root,
                t,
                &mut slots,
            )?;
            push_slot_warnings(t, "opencode", &slots);
        }
    }

    if sel.targets.contains(&Target::Omos) {
        // omos shares the opencode scope (CLI :1735).
        let scope = opencode_scope(sel, ctx);
        collect_copy_entries(&SET_OMOS, Target::Omos, &scope, source_root, t)?;
        let agents_dir = scope_join(&scope, Path::new("agents"));
        if agents_dir.exists() {
            t.notes.push(format!(
                "existing {}agents/ files may conflict with omos-provided agents; review them",
                scope.display
            ));
        }
    }

    if sel.targets.contains(&Target::Claude) {
        let scope = claude_scope(sel, ctx);
        collect_copy_entries(&SET_CLAUDE, Target::Claude, &scope, source_root, t)?;
        let mut slots = render::UsedSlots::new();
        collect_backend_agents(
            "claude",
            scope_join(&scope, Path::new("agents")),
            Target::Claude,
            source_root,
            t,
            &mut slots,
        )?;
        push_slot_warnings(t, "claude", &slots);
    }

    if sel.targets.contains(&Target::Zcode) {
        // Always user-level ~/.zcode regardless of --user (CLI :1130-1139).
        let zroot = ctx.home.join(".zcode");
        let mut slots = render::UsedSlots::new(); // shared: agents + AGENTS.md
        collect_backend_agents(
            "zcode",
            zroot.join("agents"),
            Target::Zcode,
            source_root,
            t,
            &mut slots,
        )?;
        // AGENTS.md = the orchestrator body with the zcode dispatch slot
        // substituted (CLI :1116-1123).
        let agents_md =
            render::agent_prompt_body(source_root, "zcode", "orchestrator", &mut slots)?;
        t.actions.push(Action {
            target: Target::Zcode,
            dest: zroot.join("AGENTS.md"),
            source_rel: "AGENTS.md".to_string(),
            content: ActionContent::Text(agents_md),
        });
        push_slot_warnings(t, "zcode", &slots);
        t.notes.push(
            "ZCode reads user-level subagents only; restart ZCode sessions to pick up changes"
                .to_string(),
        );
    }
    Ok(())
}

/// Targets after the DSH position in APPLY_ORDER: openbitfun (CLI :1148-1161).
fn collect_after_dsh(
    sel: &Selection,
    ctx: &EngineContext,
    source_root: &Path,
    t: &mut Traversal,
) -> Result<(), WorkbenchError> {
    if sel.targets.contains(&Target::Openbitfun) {
        let config_dir = openbitfun_config_dir(&ctx.home);
        let mut slots = render::UsedSlots::new();
        collect_backend_agents(
            "openbitfun",
            config_dir.join("agents"),
            Target::Openbitfun,
            source_root,
            t,
            &mut slots,
        )?;
        push_slot_warnings(t, "openbitfun", &slots);
        t.notes
            .push("restart OpenBitFun to pick up changes".to_string());
    }
    Ok(())
}

// ------------------------------------------------------- environment fns

/// OpenBitFun's per-OS user config directory (CLI :715-724), rooted at the
/// context home instead of `os.homedir()`.
fn openbitfun_config_dir(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("openbitfun")
    } else if cfg!(windows) {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        base.join("openbitfun")
    } else {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        base.join("openbitfun")
    }
}

/// The alias→package map the lane plugin imports (CLI :104-107). The
/// canonical copy lives with the DSH lane (`dsh::lane_plugin_dep_map`).
fn dsh_lane_plugin_deps() -> BTreeMap<String, String> {
    dsh::lane_plugin_dep_map()
}

/// PATH probe: is an executable of this name reachable? On Windows the npm
/// shims are `.cmd`/`.bat`, so those extensions are probed too. The crate
/// never spawns processes — version detection stays in the host shell.
fn find_on_path(name: &str) -> bool {
    #[cfg(test)]
    {
        // Test-only override so gate tests never depend on the host machine.
        let forced = PATH_PROBE_OVERRIDE.with(|c| c.get());
        if let Some(present) = forced {
            return present;
        }
    }
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path_var) {
        let mut candidates = vec![dir.join(name)];
        if cfg!(windows) {
            candidates.push(dir.join(format!("{name}.exe")));
            candidates.push(dir.join(format!("{name}.cmd")));
            candidates.push(dir.join(format!("{name}.bat")));
        }
        for candidate in candidates {
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

// -------------------------------------------------------------- selection

fn validate_selection(sel: &Selection) -> Result<(), WorkbenchError> {
    if sel.targets.is_empty() {
        return Err(WorkbenchError::Message(
            "no install target selected".to_string(),
        ));
    }
    let has_opencode = sel.targets.contains(&Target::Opencode);
    let has_omos = sel.targets.contains(&Target::Omos);
    if has_opencode && has_omos {
        // CLI parseArgs (:355-357).
        return Err(WorkbenchError::Message(
            "--omos cannot be combined with --opencode; --opencode already installs the omos way when a user-level omos install is detected"
                .to_string(),
        ));
    }
    Ok(())
}

/// Prerequisite gates (CLI :1689-1710): fail fast, zero writes, first failing
/// selected target wins with the CLI's friendly text.
fn check_prerequisites(sel: &Selection, ctx: &EngineContext) -> Result<(), WorkbenchError> {
    if sel.targets.contains(&Target::Opencode) && !find_on_path("opencode") {
        return Err(WorkbenchError::Message(
            "OpenCode is not installed (no 'opencode' on PATH); install OpenCode first".to_string(),
        ));
    }
    if sel.targets.contains(&Target::Omos) {
        if !find_on_path("opencode") {
            return Err(WorkbenchError::Message(
                "OpenCode is not installed (no 'opencode' on PATH); install OpenCode first"
                    .to_string(),
            ));
        }
        if !omos_user_level_present(&ctx.home) {
            return Err(WorkbenchError::Message(
                "omos is not installed at user level (~/.config/opencode); install omos first, then rerun with --omos"
                    .to_string(),
            ));
        }
    }
    if sel.targets.contains(&Target::Dsh) {
        let home = dsh::dsh_home(&ctx.home);
        if !home.exists() {
            return Err(WorkbenchError::Message(format!(
                "DSH is not installed (no {}); install DeepSeek Harness first, then rerun with --dsh",
                home.display()
            )));
        }
    }
    if sel.targets.contains(&Target::Openbitfun) {
        let dir = openbitfun_config_dir(&ctx.home);
        if !dir.exists() {
            return Err(WorkbenchError::Message(
                "OpenBitFun is not installed (none of its expected config dirs exists: \
                 ~/.config/openbitfun, ~/Library/Application Support/openbitfun, \
                 %APPDATA%\\openbitfun); install OpenBitFun first, then rerun with --openbitfun"
                    .to_string(),
            ));
        }
    }
    Ok(())
}

/// Source-repo guard (CLI :1716-1720): project-level targets must not install
/// into the content source itself. The project directory compared against the
/// source root is the user's picked `Selection::project_dir`.
fn check_source_repo_guard(
    sel: &Selection,
    source_root: &Path,
) -> Result<(), WorkbenchError> {
    let touches_project_targets = sel.targets.iter().any(is_project_target);
    if !sel.user_level && touches_project_targets {
        let project =
            dunce::canonicalize(&sel.project_dir).unwrap_or_else(|_| sel.project_dir.clone());
        let source = dunce::canonicalize(source_root).unwrap_or_else(|_| source_root.to_path_buf());
        if project == source {
            return Err(WorkbenchError::Message(
                "current directory is the my-workbench source repository; nothing to copy. \
                 Use \"my-workbench assemble\" to regenerate .claude/agents/ from agents/ source."
                    .to_string(),
            ));
        }
    }
    Ok(())
}

// ----------------------------------------------------------------- stamps

/// Realm stamps for this selection (CLI :1770-1773), in CLI write order:
/// project first, then home.
fn stamp_plans(sel: &Selection, ctx: &EngineContext) -> Vec<StampPlan> {
    let project_selected = sel.targets.iter().any(is_project_target);
    let user_only_selected = sel.targets.iter().any(is_user_level_only_target);
    let mut stamps = Vec::new();
    if project_selected && !sel.user_level {
        stamps.push(StampPlan {
            realm: StampRealm::Project,
            // Project-realm stamp lands in the user's picked project directory.
            path: sel.project_dir.join(VERSION_FILE),
            version: ctx.version.clone(),
        });
    }
    if (project_selected && sel.user_level) || user_only_selected {
        stamps.push(StampPlan {
            realm: StampRealm::Home,
            path: ctx.home.join(HOME_VERSION_FILE),
            version: ctx.version.clone(),
        });
    }
    stamps
}

fn stamp_rel_name(realm: StampRealm) -> &'static str {
    match realm {
        StampRealm::Project => VERSION_FILE,
        StampRealm::Home => HOME_VERSION_FILE,
    }
}

/// Which target a stamp drift report is attributed to: the first selected
/// target (in APPLY_ORDER) that belongs to the realm's trigger set.
fn stamp_drift_target(sel: &Selection, realm: StampRealm) -> Target {
    let mut selected: Vec<Target> = sel.targets.clone();
    selected.sort_by_key(|t| APPLY_ORDER.iter().position(|o| o == t).unwrap_or(usize::MAX));
    if realm == StampRealm::Project {
        return selected
            .into_iter()
            .find(is_project_target)
            .unwrap_or(Target::Opencode);
    }
    let user_only = selected.iter().copied().find(is_user_level_only_target);
    let fallback = selected.iter().copied().find(is_project_target);
    user_only.or(fallback).unwrap_or(Target::Zcode)
}

/// Install next-notes (CLI :1775-1788) — only when at least one file would be
/// created.
fn append_next_notes(sel: &Selection, items: &[PlanItem], notes: &mut Vec<String>) {
    if !items.iter().any(|i| i.kind == PlanKind::Create) {
        return;
    }
    if sel.targets.iter().any(is_project_target) {
        notes.push(if sel.user_level {
            "next: restart OpenCode / Claude Code so the user-level config is picked up."
                .to_string()
        } else {
            "next: restart OpenCode / Claude Code so the new config is picked up, then commit the copied files."
                .to_string()
        });
    }
    if sel.targets.contains(&Target::Zcode) {
        notes.push(
            "next: restart ZCode sessions to pick up the new AGENTS.md and subagents.".to_string(),
        );
    }
    if sel.targets.contains(&Target::Dsh) {
        notes.push(
            "next: open a new DSH session and pick the installed preset (DSH reads presets at session start)."
                .to_string(),
        );
    }
}

// -------------------------------------------------------------- plan kind

fn plan_kind(dest: &Path, force: bool) -> PlanKind {
    if dest.exists() {
        if force {
            PlanKind::Overwrite
        } else {
            PlanKind::Skip
        }
    } else {
        PlanKind::Create
    }
}

fn plan_item(action: &Action, force: bool) -> PlanItem {
    PlanItem {
        target: action.target,
        path: action.dest.clone(),
        source_rel: action.source_rel.clone(),
        kind: plan_kind(&action.dest, force),
    }
}

// ----------------------------------------------------------------- events

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log_event(sink: &dyn EventSink, target: Option<Target>, level: LogLevel, text: String) {
    sink.emit(InstallEvent::Log {
        time_ms: now_ms(),
        target,
        level,
        text,
    });
}

fn write_bytes(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest, bytes)
}

// -------------------------------------------------------------- public API

/// Phase 1 — decide everything, write nothing (PLAN.md §4). Prerequisite
/// gates and the source-repo guard fail here with the CLI's friendly text.
pub fn plan(sel: &Selection, ctx: &EngineContext) -> Result<Plan, WorkbenchError> {
    validate_selection(sel)?;
    let source_root = ctx.source_root(&sel.source);
    check_prerequisites(sel, ctx)?;
    check_source_repo_guard(sel, &source_root)?;

    let mut t = Traversal::default();
    collect_before_dsh(sel, ctx, &source_root, &mut t)?;
    let mut items: Vec<PlanItem> = t.actions.iter().map(|a| plan_item(a, sel.force)).collect();
    let mut notes = std::mem::take(&mut t.notes);

    if sel.targets.contains(&Target::Dsh) {
        // Fail-early: resolve the lane plugin's deployment imports before any
        // plan output exists (CLI :1185 semantics), then merge the DSH
        // module's contribution (items + notes; managed blocks pass through).
        let dsh_home = dsh::dsh_home(&ctx.home);
        let deps = dsh_deps::resolve_lane_dependencies(&dsh_home, &dsh_lane_plugin_deps())?;
        let outcome = dsh::plan_dsh(&source_root, ctx, sel, &deps)?;
        items.extend(outcome.items);
        notes.extend(outcome.notes);
    }

    // Only the actions collected after the DSH splice (openbitfun) are new —
    // t.actions still holds everything collected before it.
    let n_before_openbitfun = t.actions.len();
    collect_after_dsh(sel, ctx, &source_root, &mut t)?;
    items.extend(
        t.actions[n_before_openbitfun..]
            .iter()
            .map(|a| plan_item(a, sel.force)),
    );
    notes.append(&mut t.notes);

    let stamps = stamp_plans(sel, ctx);
    append_next_notes(sel, &items, &mut notes);
    Ok(Plan {
        items,
        stamps,
        notes,
    })
}

/// Phase 2 — replay a plan. Writes exactly what plan decided: skipped items
/// are skipped, planned creates write (an error-safe overwrite if the file
/// appeared meanwhile), planned overwrites write unconditionally. Cancellation
/// is polled between files only; a cancelled run stops before the stamps.
pub fn execute(
    plan: &Plan,
    sel: &Selection,
    ctx: &EngineContext,
    sink: &dyn EventSink,
) -> Result<InstallReport, WorkbenchError> {
    validate_selection(sel)?;
    let source_root = ctx.source_root(&sel.source);

    let mut t = Traversal::default();
    collect_before_dsh(sel, ctx, &source_root, &mut t)?;
    let n_before = t.actions.len();
    collect_after_dsh(sel, ctx, &source_root, &mut t)?;

    let kinds: HashMap<PathBuf, PlanKind> = plan
        .items
        .iter()
        .map(|i| (i.path.clone(), i.kind))
        .collect();
    let total = plan.items.len();
    sink.emit(InstallEvent::Started { total_files: total });

    let mut report = InstallReport {
        cancelled: false,
        created: 0,
        skipped: 0,
        overwritten: 0,
        managed_blocks: 0,
        stamps: Vec::new(),
        warnings: Vec::new(),
    };
    let mut done = 0usize;
    let mut cancelled = false;

    // Replay the pre-DSH items (opencode → omos → claude → zcode).
    for action in &t.actions[..n_before] {
        if replay_action(action, &kinds, sink, &mut report, &mut done, total)? {
            cancelled = true;
            break;
        }
    }

    // DSH stage: executed wholesale by the DSH module, which re-resolves its
    // dependencies before its first write (CLI :1185) and emits its own logs.
    if !cancelled && sel.targets.contains(&Target::Dsh) {
        if sink.is_cancelled() {
            cancelled = true;
        } else {
            let outcome = dsh::execute_dsh(&source_root, ctx, sel, sink)?;
            report.created += outcome.created;
            report.skipped += outcome.skipped;
            report.overwritten += outcome.overwritten;
            report.managed_blocks += outcome.managed_blocks;
            for note in &outcome.notes {
                log_event(sink, Some(Target::Dsh), LogLevel::Info, note.clone());
            }
            done += plan.items.iter().filter(|i| i.target == Target::Dsh).count();
            sink.emit(InstallEvent::Progress {
                phase: PROGRESS_PHASE.to_string(),
                done,
                total,
            });
        }
    }

    // Replay the post-DSH items (openbitfun).
    if !cancelled {
        for action in &t.actions[n_before..] {
            if replay_action(action, &kinds, sink, &mut report, &mut done, total)? {
                cancelled = true;
                break;
            }
        }
    }

    // Stamps come after all targets (CLI order) — a cancelled run stops
    // before them.
    if !cancelled {
        for stamp in &plan.stamps {
            if sink.is_cancelled() {
                cancelled = true;
                break;
            }
            if let Err(e) = write_bytes(&stamp.path, format!("{}\n", stamp.version).as_bytes()) {
                log_event(
                    sink,
                    None,
                    LogLevel::Error,
                    format!("写入 {} 失败：{e}", stamp.path.display()),
                );
                return Err(e.into());
            }
            report.stamps.push(stamp.path.clone());
            log_event(
                sink,
                None,
                LogLevel::Info,
                format!("版本标记 {}（{}）", stamp.path.display(), stamp.version),
            );
        }
    }

    // Slot-accounting warnings, in CLI emission order.
    for idx in &t.warning_idx {
        let text = t.notes[*idx].clone();
        log_event(sink, None, LogLevel::Warn, text.clone());
        report.warnings.push(text);
    }

    report.cancelled = cancelled;
    sink.emit(InstallEvent::Finished { cancelled });
    Ok(report)
}

/// Write one planned action. Returns `true` when the sink asked to cancel
/// before this file. Only the plan decides what happens: `Skip` stays
/// skipped, `Create`/`Overwrite` write.
fn replay_action(
    action: &Action,
    kinds: &HashMap<PathBuf, PlanKind>,
    sink: &dyn EventSink,
    report: &mut InstallReport,
    done: &mut usize,
    total: usize,
) -> Result<bool, WorkbenchError> {
    if sink.is_cancelled() {
        return Ok(true);
    }
    match kinds.get(&action.dest) {
        None => {
            // The source tree changed since plan(); never write an unplanned file.
            log_event(
                sink,
                Some(action.target),
                LogLevel::Warn,
                format!("跳过 {}（源已更改，不在预览中）", action.dest.display()),
            );
        }
        Some(PlanKind::Skip) => {
            log_event(
                sink,
                Some(action.target),
                LogLevel::Info,
                format!("跳过 {}（已存在）", action.dest.display()),
            );
            report.skipped += 1;
        }
        Some(PlanKind::Create) | Some(PlanKind::Overwrite) => {
            let overwrite = matches!(kinds.get(&action.dest), Some(PlanKind::Overwrite));
            if let Err(e) = write_bytes(&action.dest, action.content.bytes()) {
                log_event(
                    sink,
                    Some(action.target),
                    LogLevel::Error,
                    format!("写入 {} 失败：{e}", action.dest.display()),
                );
                return Err(e.into());
            }
            if overwrite {
                report.overwritten += 1;
                log_event(
                    sink,
                    Some(action.target),
                    LogLevel::Info,
                    format!("覆盖 {}", action.dest.display()),
                );
            } else {
                report.created += 1;
                log_event(
                    sink,
                    Some(action.target),
                    LogLevel::Info,
                    format!("新建 {}", action.dest.display()),
                );
            }
        }
        // Only DSH produces managed blocks, and DSH is executed wholesale by
        // its module; defensive no-op for anything else.
        Some(PlanKind::ManagedBlock) => {}
    }
    *done += 1;
    sink.emit(InstallEvent::Progress {
        phase: PROGRESS_PHASE.to_string(),
        done: *done,
        total,
    });
    Ok(false)
}

/// Tier 1 health check (PLAN.md §4): render-and-byte-compare drift for every
/// file the plan WOULD write that already exists (version stamps included),
/// the DSH preset's own byte-compare when that target is selected, plus the
/// structural checks on the source. Tier 2 is the host shell's job — always
/// `None` here.
pub fn check_drift(
    source: &Source,
    sel: &Selection,
    ctx: &EngineContext,
) -> Result<DriftReport, WorkbenchError> {
    validate_selection(sel)?;
    let source_root = ctx.source_root(source);

    let mut t = Traversal::default();
    collect_before_dsh(sel, ctx, &source_root, &mut t)?;
    collect_after_dsh(sel, ctx, &source_root, &mut t)?;

    let mut compared = 0usize;
    let mut drifted = Vec::new();
    for action in &t.actions {
        let Ok(on_disk) = fs::read(&action.dest) else {
            continue; // not installed → nothing to compare
        };
        compared += 1;
        if on_disk != action.content.bytes() {
            drifted.push(DriftFile {
                path: action.dest.clone(),
                source_rel: action.source_rel.clone(),
                target: action.target,
            });
        }
    }
    for stamp in stamp_plans(sel, ctx) {
        let Ok(on_disk) = fs::read(&stamp.path) else {
            continue;
        };
        compared += 1;
        if on_disk != format!("{}\n", stamp.version).into_bytes() {
            drifted.push(DriftFile {
                path: stamp.path.clone(),
                source_rel: stamp_rel_name(stamp.realm).to_string(),
                target: stamp_drift_target(sel, stamp.realm),
            });
        }
    }

    let mut problems = Vec::new();
    for detail in checks::agent_source_problems(&source_root) {
        problems.push(StructuralProblem {
            check: "agentSourceProblems".to_string(),
            detail,
        });
    }
    for detail in checks::lane_plugin_problems(&source_root) {
        problems.push(StructuralProblem {
            check: "lanePluginProblems".to_string(),
            detail,
        });
    }
    for detail in checks::lane_ui_plugin_problems(&source_root) {
        problems.push(StructuralProblem {
            check: "laneUiPluginProblems".to_string(),
            detail,
        });
    }
    if sel.targets.contains(&Target::Dsh) {
        // DSH plan failure (e.g. deps unresolved) stays a structural problem so
        // a broken DSH target is still visible. When it plans cleanly, the
        // installed preset files byte-compare through the DSH module's drift
        // pass — the same renders the install would write — and their count
        // joins `compared`.
        let dsh_home = dsh::dsh_home(&ctx.home);
        let planned = dsh_deps::resolve_lane_dependencies(&dsh_home, &dsh_lane_plugin_deps())
            .and_then(|deps| dsh::plan_dsh(&source_root, ctx, sel, &deps));
        match planned {
            Err(e) => {
                problems.push(StructuralProblem {
                    check: "dshPlan".to_string(),
                    detail: e.to_string(),
                });
            }
            Ok(_) => {
                let (dsh_drifted, dsh_compared) =
                    dsh::drift_dsh_with_compared(&source_root, &dsh_home, sel.force)?;
                compared += dsh_compared;
                drifted.extend(dsh_drifted);
            }
        }
    }

    Ok(DriftReport {
        tier1: Tier1Report {
            compared,
            drifted,
            problems,
        },
        tier2: None,
    })
}

/// Environment detection for the UI's status dots (design decision 4:
/// inform-only, never a gate). Binaries are detected by PATH presence only —
/// the crate never spawns processes, so versions stay `None` (the shell runs
/// `opencode --version` / `node` itself).
pub fn detect_environment(ctx: &EngineContext) -> EnvironmentInfo {
    let dsh_info = dsh::detect_dsh(&ctx.home);
    let obf_dir = openbitfun_config_dir(&ctx.home);
    let omos_present = omos_user_level_present(&ctx.home);
    let opencode_present = find_on_path("opencode");
    let targets = APPLY_ORDER
        .iter()
        .map(|t| TargetStatus {
            target: *t,
            detail: target_status_detail(
                *t,
                &dsh_info,
                &obf_dir,
                omos_present,
                opencode_present,
            ),
        })
        .collect();
    EnvironmentInfo {
        home: ctx.home.clone(),
        // The embedded content source version (PLAN §2 version alignment) —
        // the crate's own VERSION, not the context's (golden tests pin that
        // to keep byte-identity with the CLI stamps).
        source_version: crate::VERSION.to_string(),
        opencode: ToolStatus {
            present: opencode_present,
            version: None,
        },
        node: ToolStatus {
            present: find_on_path("node"),
            version: None,
        },
        omos_user_level: omos_present,
        dsh: dsh_info,
        openbitfun: OpenBitFunInfo {
            config_dir: obf_dir.clone(),
            exists: obf_dir.is_dir(),
        },
        targets,
    }
}

/// Per-target status detail strings — short zh status copy shown verbatim on
/// the UI's target cards (detection is inform-only).
fn target_status_detail(
    target: Target,
    dsh: &DshInfo,
    openbitfun_dir: &Path,
    omos_present: bool,
    opencode_present: bool,
) -> String {
    match target {
        Target::Opencode => {
            if opencode_present {
                "已检测到".to_string()
            } else {
                "未检测到".to_string()
            }
        }
        Target::Omos => {
            if omos_present {
                "已检测到用户级 omos".to_string()
            } else {
                "未检测到".to_string()
            }
        }
        Target::Claude => "无前置要求".to_string(),
        Target::Zcode => "无前置要求".to_string(),
        Target::Dsh => {
            if dsh.exists {
                "已找到 DSH 主目录".to_string()
            } else {
                "未找到 DSH 主目录".to_string()
            }
        }
        Target::Openbitfun => {
            if openbitfun_dir.is_dir() {
                "已找到配置目录".to_string()
            } else {
                "未找到配置目录".to_string()
            }
        }
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
thread_local! {
    /// Test-only override for `find_on_path` so gate behaviour never depends
    /// on the host machine. Thread-local (not a mutex): the probe runs on the
    /// same thread while the guard is alive, so a lock would deadlock.
    static PATH_PROBE_OVERRIDE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Force every PATH probe to a fixed answer for the duration of the guard.
#[cfg(test)]
fn force_path_probe(present: bool) -> PathProbeGuard {
    PATH_PROBE_OVERRIDE.with(|c| c.set(Some(present)));
    PathProbeGuard
}

#[cfg(test)]
struct PathProbeGuard;

#[cfg(test)]
impl Drop for PathProbeGuard {
    fn drop(&mut self) {
        PATH_PROBE_OVERRIDE.with(|c| c.set(None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    fn repo_root() -> PathBuf {
        // The crate lives at <repo>/crates/workbench-core; the bundled source
        // root is the repository root (the directory containing agents/).
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
    }

    struct Sandbox {
        _guard: tempfile::TempDir,
        /// The user-picked project directory — the authoritative one the
        /// engine must read (`Selection::project_dir`).
        project_dir: PathBuf,
        ctx: EngineContext,
    }

    fn sandbox() -> Sandbox {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let home = dir.path().join("home");
        let legacy_ctx_project_dir = dir.path().join("legacy-ctx-project-dir");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&home).unwrap();
        Sandbox {
            project_dir: project.clone(),
            _guard: dir,
            // The frozen contract still carries `project_dir` on the context
            // (legacy); the engine must read the Selection's instead, so the
            // sandbox points the legacy field at an unused decoy — any engine
            // read of `ctx.project_dir` fails this suite loudly.
            ctx: EngineContext {
                project_dir: legacy_ctx_project_dir,
                home,
                bundled_root: repo_root(),
                version: "9.9.9-test".to_string(),
            },
        }
    }

    impl Sandbox {
        /// A Selection picking this sandbox's project directory.
        fn sel(&self, targets: Vec<Target>, user_level: bool, force: bool) -> Selection {
            Selection {
                source: Source::Bundled,
                project_dir: self.project_dir.clone(),
                targets,
                user_level,
                force,
            }
        }
    }

    #[derive(Default)]
    struct CollectSink {
        events: StdMutex<Vec<InstallEvent>>,
    }

    impl EventSink for CollectSink {
        fn emit(&self, event: InstallEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    impl CollectSink {
        fn last(&self) -> Option<InstallEvent> {
            self.events.lock().unwrap().last().cloned()
        }

        #[allow(dead_code)]
        fn log_texts(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    InstallEvent::Log { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .collect()
        }
    }

    /// Cancels once more than `cancel_after` emissions have gone through.
    struct CancellingSink {
        events: StdMutex<Vec<InstallEvent>>,
        emissions: AtomicUsize,
        cancel_after: usize,
    }

    impl CancellingSink {
        fn new(cancel_after: usize) -> Self {
            Self {
                events: StdMutex::new(Vec::new()),
                emissions: AtomicUsize::new(0),
                cancel_after,
            }
        }

        fn finished_cancelled(&self) -> bool {
            self.events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, InstallEvent::Finished { cancelled: true }))
        }
    }

    impl EventSink for CancellingSink {
        fn emit(&self, event: InstallEvent) {
            self.emissions.fetch_add(1, Ordering::SeqCst);
            self.events.lock().unwrap().push(event);
        }

        fn is_cancelled(&self) -> bool {
            self.emissions.load(Ordering::SeqCst) > self.cancel_after
        }
    }

    #[test]
    fn plan_default_install_zero_writes_then_execute() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let s = sb.sel(vec![Target::Opencode, Target::Claude], false, false);
        let p = plan(&s, &sb.ctx).unwrap();

        // plan performs zero writes.
        assert!(!sb.project_dir.join(".opencode").exists());
        assert!(!sb.project_dir.join(".claude").exists());

        // opencode core config + claude settings, as Creates.
        let jsonc_path = sb.project_dir.join(".opencode").join("opencode.jsonc");
        let jsonc = p.items.iter().find(|i| i.path == jsonc_path).unwrap();
        assert_eq!(jsonc.kind, PlanKind::Create);
        assert_eq!(jsonc.target, Target::Opencode);
        assert_eq!(jsonc.source_rel, "opencode.jsonc");
        let settings_path = sb.project_dir.join(".claude").join("settings.json");
        let settings = p.items.iter().find(|i| i.path == settings_path).unwrap();
        assert_eq!(settings.source_rel, "settings.json");
        assert_eq!(settings.target, Target::Claude);

        // Assembled agents on both sides (the roster carries 8 agents, all
        // with claude + opencode frontmatter).
        let claude_agents = p
            .items
            .iter()
            .filter(|i| i.path.starts_with(sb.project_dir.join(".claude").join("agents")))
            .count();
        let opencode_agents = p
            .items
            .iter()
            .filter(|i| i.path.starts_with(sb.project_dir.join(".opencode").join("agents")))
            .count();
        assert!(claude_agents >= 8, "expected >= 8 claude agents");
        assert!(opencode_agents >= 8, "expected >= 8 opencode agents");
        assert!(p.items.iter().all(|i| i.kind == PlanKind::Create));

        // Project-realm stamp only.
        assert_eq!(p.stamps.len(), 1);
        assert_eq!(p.stamps[0].realm, StampRealm::Project);
        assert_eq!(
            p.stamps[0].path,
            sb.project_dir.join("my-workbench.version")
        );
        assert_eq!(p.stamps[0].version, "9.9.9-test");

        // execute writes everything and the stamp.
        let sink = CollectSink::default();
        let report = execute(&p, &s, &sb.ctx, &sink).unwrap();
        assert!(!report.cancelled);
        assert_eq!(report.created, p.items.len());
        assert_eq!(report.skipped, 0);
        assert_eq!(report.overwritten, 0);
        assert!(jsonc_path.is_file());
        assert!(settings_path.is_file());
        assert_eq!(
            fs::read_dir(sb.project_dir.join(".claude").join("agents"))
                .unwrap()
                .count(),
            claude_agents
        );
        assert_eq!(
            fs::read_to_string(sb.project_dir.join("my-workbench.version")).unwrap(),
            "9.9.9-test\n"
        );
        assert_eq!(
            report.stamps,
            vec![sb.project_dir.join("my-workbench.version")]
        );
        assert!(matches!(
            sink.last(),
            Some(InstallEvent::Finished { cancelled: false })
        ));
    }

    #[test]
    fn user_level_install_layout_and_home_stamp() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let s = sb.sel(vec![Target::Opencode, Target::Claude], true, false);
        let p = plan(&s, &sb.ctx).unwrap();

        let oc = sb.ctx.home.join(".config").join("opencode");
        let cl = sb.ctx.home.join(".claude");
        assert!(
            p.items.iter().any(|i| i.path == oc.join("opencode.jsonc")),
            "opencode core config lands in ~/.config/opencode"
        );
        assert!(
            p.items.iter().any(|i| i.path == cl.join("settings.json")),
            "claude settings lands in ~/.claude"
        );
        assert!(
            p.items
                .iter()
                .any(|i| i.path.starts_with(cl.join("agents"))),
            "claude agents land in ~/.claude/agents"
        );
        assert!(
            p.items
                .iter()
                .any(|i| i.path.starts_with(oc.join("agents"))),
            "opencode agents land in ~/.config/opencode/agents"
        );
        // User-level run stamps the home realm only.
        assert_eq!(p.stamps.len(), 1);
        assert_eq!(p.stamps[0].realm, StampRealm::Home);
        assert_eq!(p.stamps[0].path, sb.ctx.home.join(".my-workbench.version"));

        let report = execute(&p, &s, &sb.ctx, &CollectSink::default()).unwrap();
        assert!(oc.join("opencode.jsonc").is_file());
        assert!(cl.join("settings.json").is_file());
        assert_eq!(
            fs::read_to_string(sb.ctx.home.join(".my-workbench.version")).unwrap(),
            "9.9.9-test\n"
        );
        assert!(!report.cancelled);
    }

    #[test]
    fn skip_and_force_semantics() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let jsonc = sb.project_dir.join(".opencode").join("opencode.jsonc");
        fs::create_dir_all(jsonc.parent().unwrap()).unwrap();
        fs::write(&jsonc, b"old contents").unwrap();

        // Without force: existing file is skipped, the rest created.
        let s = sb.sel(vec![Target::Opencode, Target::Claude], false, false);
        let p = plan(&s, &sb.ctx).unwrap();
        let item = p.items.iter().find(|i| i.path == jsonc).unwrap();
        assert_eq!(item.kind, PlanKind::Skip);
        let sink = CollectSink::default();
        let report = execute(&p, &s, &sb.ctx, &sink).unwrap();
        assert_eq!(report.skipped, 1);
        assert_eq!(fs::read(&jsonc).unwrap(), b"old contents");
        assert!(sink
            .log_texts()
            .iter()
            .any(|t| t.contains("跳过") && t.contains("opencode.jsonc")));

        // With force: every existing file is overwritten, the jsonc among them.
        let sf = sb.sel(vec![Target::Opencode, Target::Claude], false, true);
        let pf = plan(&sf, &sb.ctx).unwrap();
        let item = pf.items.iter().find(|i| i.path == jsonc).unwrap();
        assert_eq!(item.kind, PlanKind::Overwrite);
        let report = execute(&pf, &sf, &sb.ctx, &CollectSink::default()).unwrap();
        assert_eq!(report.overwritten, pf.items.len());
        let expected = fs::read(
            repo_root()
                .join("agents")
                .join("backends")
                .join("opencode")
                .join("opencode.jsonc"),
        )
        .unwrap();
        assert_eq!(fs::read(&jsonc).unwrap(), expected);
    }

    #[test]
    fn replan_after_install_reports_all_skip() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let s = sb.sel(vec![Target::Opencode, Target::Claude], false, false);
        let p = plan(&s, &sb.ctx).unwrap();
        execute(&p, &s, &sb.ctx, &CollectSink::default()).unwrap();

        let p2 = plan(&s, &sb.ctx).unwrap();
        assert_eq!(p2.items.len(), p.items.len());
        assert!(p2
            .items
            .iter()
            .all(|i| i.kind == PlanKind::Skip || i.kind == PlanKind::ManagedBlock));
        // Stamps are never skip-gated.
        assert_eq!(p2.stamps.len(), 1);
    }

    #[test]
    fn drift_detection_flags_tampered_file_and_stamp() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let s = sb.sel(vec![Target::Opencode, Target::Claude], false, false);
        let p = plan(&s, &sb.ctx).unwrap();
        execute(&p, &s, &sb.ctx, &CollectSink::default()).unwrap();

        // Untampered: no drift anywhere.
        let clean = check_drift(&Source::Bundled, &s, &sb.ctx).unwrap();
        assert!(clean.tier1.drifted.is_empty(), "{:?}", clean.tier1.drifted);
        assert!(clean.tier2.is_none());
        let files_compared = clean.tier1.compared;

        // Tamper one installed file and the stamp.
        let settings = sb.project_dir.join(".claude").join("settings.json");
        let mut body = fs::read_to_string(&settings).unwrap();
        body.push_str("\ntampered\n");
        fs::write(&settings, body).unwrap();
        let stamp = sb.project_dir.join("my-workbench.version");
        fs::write(&stamp, "0.0.1\n").unwrap();

        let dr = check_drift(&Source::Bundled, &s, &sb.ctx).unwrap();
        assert_eq!(dr.tier1.compared, files_compared);
        assert!(dr.tier1.drifted.iter().any(|f| f.path == settings
            && f.target == Target::Claude
            && f.source_rel == "settings.json"));
        assert!(dr.tier1.drifted.iter().any(|f| f.path == stamp));
        assert!(!dr
            .tier1
            .drifted
            .iter()
            .any(|f| f.source_rel == "opencode.jsonc"));
    }

    #[test]
    fn source_repo_guard_errors() {
        let _probe = force_path_probe(true);
        let dir = tempfile::tempdir().unwrap();
        let root = repo_root();
        let ctx = EngineContext {
            // Legacy context field points nowhere; the guard must key off the
            // Selection's picked project directory alone.
            project_dir: dir.path().join("legacy-ctx-project-dir"),
            home: dir.path().join("home"),
            bundled_root: root.clone(),
            version: "9.9.9-test".to_string(),
        };
        fs::create_dir_all(&ctx.home).unwrap();
        let into_source = Selection {
            source: Source::Bundled,
            project_dir: root.clone(),
            targets: vec![Target::Claude],
            user_level: false,
            force: false,
        };
        let err = plan(&into_source, &ctx).unwrap_err();
        assert!(err.to_string().contains("source repository"), "{err}");
        // User-level runs are safe from anywhere, including the source repo.
        let user_level = Selection {
            user_level: true,
            ..into_source.clone()
        };
        assert!(plan(&user_level, &ctx).is_ok());
    }

    #[test]
    fn user_picked_project_dir_is_authoritative() {
        let _probe = force_path_probe(true);
        // The GUI's directory picker hands the project dir over via Selection;
        // the context's legacy field points somewhere else entirely and must
        // never be read.
        let ambient = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let ctx = EngineContext {
            project_dir: ambient.path().join("decoy-project"),
            home: ambient.path().join("home"),
            bundled_root: repo_root(),
            version: "9.9.9-test".to_string(),
        };
        fs::create_dir_all(&ctx.home).unwrap();
        let s = Selection {
            source: Source::Bundled,
            project_dir: picked.path().to_path_buf(),
            targets: vec![Target::Claude],
            user_level: false,
            force: false,
        };

        // Scopes and the project stamp follow the picked dir.
        let p = plan(&s, &ctx).unwrap();
        let settings = picked.path().join(".claude").join("settings.json");
        assert!(p.items.iter().any(|i| i.path == settings));
        assert!(
            !p.items
                .iter()
                .any(|i| i.path.starts_with(&ctx.project_dir)),
            "nothing may be planned under the legacy context project dir"
        );
        assert_eq!(p.stamps.len(), 1);
        assert_eq!(p.stamps[0].realm, StampRealm::Project);
        assert_eq!(
            p.stamps[0].path,
            picked.path().join("my-workbench.version")
        );
        assert_eq!(p.stamps[0].version, "9.9.9-test");

        // execute writes only into the picked dir.
        execute(&p, &s, &ctx, &CollectSink::default()).unwrap();
        assert!(settings.is_file());
        assert_eq!(
            fs::read_to_string(picked.path().join("my-workbench.version")).unwrap(),
            "9.9.9-test\n"
        );
        assert!(!ctx.project_dir.join(".claude").exists());
        assert!(!ctx.project_dir.join("my-workbench.version").exists());

        // The guard compares the picked dir against the source root: picking
        // the repo itself errors even though the context points elsewhere.
        let into_source = Selection {
            project_dir: repo_root(),
            ..s.clone()
        };
        let err = plan(&into_source, &ctx).unwrap_err();
        assert!(err.to_string().contains("source repository"), "{err}");
    }

    #[test]
    fn selection_validation_mutex_and_empty() {
        let sb = sandbox();
        let err = plan(
            &sb.sel(vec![Target::Opencode, Target::Omos], false, false),
            &sb.ctx,
        )
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("--omos cannot be combined with --opencode"),
            "{err}"
        );
        let err = plan(&sb.sel(Vec::new(), false, false), &sb.ctx).unwrap_err();
        assert!(err.to_string().contains("no install target selected"));
    }

    #[test]
    fn stamp_realms() {
        let _probe = force_path_probe(true);
        let sb = sandbox();

        // Mixed project + user-level-only targets stamp BOTH realms.
        let p = plan(
            &sb.sel(vec![Target::Claude, Target::Zcode], false, false),
            &sb.ctx,
        )
        .unwrap();
        let realms: Vec<StampRealm> = p.stamps.iter().map(|s| s.realm).collect();
        assert_eq!(realms, vec![StampRealm::Project, StampRealm::Home]);

        // User-level-only targets alone stamp Home only.
        let p = plan(&sb.sel(vec![Target::Zcode], false, false), &sb.ctx).unwrap();
        assert_eq!(p.stamps.len(), 1);
        assert_eq!(p.stamps[0].realm, StampRealm::Home);

        // Project targets with --user stamp Home only.
        let p = plan(&sb.sel(vec![Target::Opencode], true, false), &sb.ctx).unwrap();
        assert_eq!(p.stamps.len(), 1);
        assert_eq!(p.stamps[0].realm, StampRealm::Home);

        // Project targets without --user stamp Project only.
        let p = plan(
            &sb.sel(vec![Target::Opencode, Target::Claude], false, false),
            &sb.ctx,
        )
        .unwrap();
        assert_eq!(p.stamps.len(), 1);
        assert_eq!(p.stamps[0].realm, StampRealm::Project);
    }

    #[test]
    fn zcode_target_installs_user_level() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let s = sb.sel(vec![Target::Zcode], false, false);
        let p = plan(&s, &sb.ctx).unwrap();
        let zroot = sb.ctx.home.join(".zcode");
        assert!(p.items.iter().any(|i| i.path == zroot.join("AGENTS.md")));
        assert!(
            p.items
                .iter()
                .any(|i| i.path.starts_with(zroot.join("agents"))),
            "zcode subagents planned under ~/.zcode/agents"
        );
        // Zcode ignores --user: still ~/.zcode.
        let pu = plan(&sb.sel(vec![Target::Zcode], true, false), &sb.ctx).unwrap();
        assert!(pu.items.iter().any(|i| i.path == zroot.join("AGENTS.md")));

        execute(&p, &s, &sb.ctx, &CollectSink::default()).unwrap();
        let agents_md = fs::read_to_string(zroot.join("AGENTS.md")).unwrap();
        assert!(!agents_md.is_empty());
        assert!(!agents_md.contains("{{slot:"), "slots must be filled");
        assert!(fs::read_dir(zroot.join("agents")).unwrap().count() > 0);
        assert_eq!(
            fs::read_to_string(sb.ctx.home.join(".my-workbench.version")).unwrap(),
            "9.9.9-test\n"
        );
    }

    #[test]
    fn execute_cancellation_stops_before_stamps() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let s = sb.sel(vec![Target::Opencode, Target::Claude], false, false);
        let p = plan(&s, &sb.ctx).unwrap();
        assert!(p.items.len() > 4, "need several files for a mid-run cancel");

        // Started(1) + 2 events per file: the cancel lands between files.
        let sink = CancellingSink::new(4);
        let report = execute(&p, &s, &sb.ctx, &sink).unwrap();
        assert!(report.cancelled);
        assert!(report.created > 0);
        assert!(report.created + report.skipped < p.items.len());
        assert!(report.stamps.is_empty(), "cancelled run writes no stamps");
        assert!(!sb.project_dir.join("my-workbench.version").exists());
        assert!(sink.finished_cancelled());
    }

    #[test]
    fn omos_way_opencode_switch() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        // Simulate a user-level omos install in the sandbox home.
        let omos_marker = sb
            .ctx
            .home
            .join(".config")
            .join("opencode")
            .join("node_modules")
            .join(OMOS_PACKAGE);
        fs::create_dir_all(&omos_marker).unwrap();

        let s = sb.sel(vec![Target::Opencode], false, false);
        let p = plan(&s, &sb.ctx).unwrap();

        // omos assets instead of native agents.
        let opencode_dir = sb.project_dir.join(".opencode");
        assert!(
            p.items
                .iter()
                .any(|i| i.path == opencode_dir.join("oh-my-opencode-slim.jsonc"))
        );
        assert!(
            p.items
                .iter()
                .any(|i| i.path == opencode_dir.join("package.json"))
        );
        let append_path = opencode_dir
            .join("oh-my-opencode-slim")
            .join("orchestrator_append.md");
        assert!(p.items.iter().any(|i| i.path == append_path));
        assert!(
            !p.items
                .iter()
                .any(|i| i.path.starts_with(opencode_dir.join("agents"))),
            "native agents/ must be skipped in the omos way"
        );
        assert!(p
            .notes
            .iter()
            .any(|n| n.contains("user-level omos install detected")));

        execute(&p, &s, &sb.ctx, &CollectSink::default()).unwrap();
        let append = fs::read_to_string(&append_path).unwrap();
        assert!(
            !append.contains("{{disciplines}}"),
            "marker must be rendered"
        );
        let disciplines_raw =
            fs::read_to_string(repo_root().join("agents").join("disciplines.md")).unwrap();
        let disciplines = trim_end_js(&disciplines_raw);
        assert!(append.contains(&disciplines), "disciplines must be inlined");
        // Everything else copies byte-for-byte.
        assert_eq!(
            fs::read(opencode_dir.join("oh-my-opencode-slim.jsonc")).unwrap(),
            fs::read(
                repo_root()
                    .join("agents")
                    .join("backends")
                    .join("omos")
                    .join("oh-my-opencode-slim.jsonc")
            )
            .unwrap()
        );
    }

    #[test]
    fn omos_user_level_present_heuristics() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!omos_user_level_present(dir.path()));

        // node_modules marker.
        fs::create_dir_all(
            dir.path()
                .join(".config")
                .join("opencode")
                .join("node_modules")
                .join(OMOS_PACKAGE),
        )
        .unwrap();
        assert!(omos_user_level_present(dir.path()));

        // opencode.json mention.
        let dir2 = tempfile::tempdir().unwrap();
        let cfg = dir2.path().join(".config").join("opencode");
        fs::create_dir_all(&cfg).unwrap();
        fs::write(
            cfg.join("opencode.json"),
            format!(r#"{{ "plugin": [] }} // {OMOS_PACKAGE}"#),
        )
        .unwrap();
        assert!(omos_user_level_present(dir2.path()));

        // Config file without the package.
        let dir3 = tempfile::tempdir().unwrap();
        let cfg3 = dir3.path().join(".config").join("opencode");
        fs::create_dir_all(&cfg3).unwrap();
        fs::write(cfg3.join("opencode.jsonc"), r#"{}"#).unwrap();
        assert!(!omos_user_level_present(dir3.path()));
    }

    #[test]
    fn next_notes_present() {
        let _probe = force_path_probe(true);
        let sb = sandbox();
        let p = plan(
            &sb.sel(vec![Target::Opencode, Target::Claude], false, false),
            &sb.ctx,
        )
        .unwrap();
        assert_eq!(
            p.notes.last().map(String::as_str),
            Some(
                "next: restart OpenCode / Claude Code so the new config is picked up, then commit the copied files."
            )
        );

        let pz = plan(&sb.sel(vec![Target::Zcode], false, false), &sb.ctx).unwrap();
        assert!(pz
            .notes
            .iter()
            .any(|n| n == "next: restart ZCode sessions to pick up the new AGENTS.md and subagents."));

        // A plan that creates nothing carries no next-notes.
        let s = sb.sel(vec![Target::Zcode], false, false);
        execute(&pz, &s, &sb.ctx, &CollectSink::default()).unwrap();
        let pz2 = plan(&s, &sb.ctx).unwrap();
        assert!(!pz2.notes.iter().any(|n| n.starts_with("next:")));
    }

    #[test]
    fn drift_detection_covers_the_dsh_target() {
        // The engine derives the DSH home from the ambient DSH_HOME; only run
        // where it is unset so the sandbox home stays authoritative.
        if std::env::var("DSH_HOME").is_ok_and(|value| !value.is_empty()) {
            return;
        }
        let sb = sandbox();
        let dsh_home = sb.ctx.home.join(".dsh");
        // Minimal deployment closure in the profile root (the first search
        // root), so dependency resolution never leaves the sandbox.
        let modules = dsh_home.join("profiles").join("node_modules");
        for name in ["@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery"] {
            let pkg = modules.join(name);
            fs::create_dir_all(&pkg).unwrap();
            fs::write(
                pkg.join("package.json"),
                r#"{"version":"1.0.0","exports":"./index.mjs"}"#,
            )
            .unwrap();
            fs::write(pkg.join("index.mjs"), "export default {}\n").unwrap();
        }
        // Exactly one profile, so the managed row has a target.
        fs::create_dir_all(dsh_home.join("profiles").join("web")).unwrap();
        fs::write(dsh_home.join("profiles").join("web").join("cordis.yml"), "root: y\n").unwrap();

        let s = sb.sel(vec![Target::Dsh], false, false);
        // Nothing installed yet: the plan still succeeds, there are no
        // structural problems, and the only drift is the missing managed row
        // (a rerun would add it).
        let before = check_drift(&Source::Bundled, &s, &sb.ctx).unwrap();
        assert!(
            before.tier1.problems.is_empty(),
            "{:?}",
            before.tier1.problems
        );
        assert!(
            before
                .tier1
                .drifted
                .iter()
                .all(|f| f.source_rel == "cordis.patch.yml (managed block)"),
            "{:?}",
            before.tier1.drifted
        );

        let p = plan(&s, &sb.ctx).unwrap();
        execute(&p, &s, &sb.ctx, &CollectSink::default()).unwrap();

        // Untouched install: no drift; the nine preset files (plus the managed
        // row and the home stamp) all count into `compared`.
        let clean = check_drift(&Source::Bundled, &s, &sb.ctx).unwrap();
        assert!(clean.tier1.drifted.is_empty(), "{:?}", clean.tier1.drifted);
        assert!(
            clean.tier1.problems.is_empty(),
            "{:?}",
            clean.tier1.problems
        );
        let compared = clean.tier1.compared;
        assert!(compared >= 9, "installed preset files are compared: {compared}");

        // Tamper one installed preset file → a Dsh-targeted drift entry.
        let preset_yml = dsh_home
            .join(".agent-presets")
            .join("my-workbench")
            .join("preset.yml");
        fs::write(&preset_yml, b"tampered\n").unwrap();
        let dr = check_drift(&Source::Bundled, &s, &sb.ctx).unwrap();
        assert_eq!(dr.tier1.compared, compared);
        assert_eq!(dr.tier1.drifted.len(), 1, "{:?}", dr.tier1.drifted);
        assert_eq!(dr.tier1.drifted[0].path, preset_yml);
        assert_eq!(dr.tier1.drifted[0].target, Target::Dsh);
        assert_eq!(
            dr.tier1.drifted[0].source_rel,
            "agents/backends/dsh/preset.yml"
        );
    }
}
