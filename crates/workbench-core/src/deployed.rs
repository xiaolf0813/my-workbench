//! Read/rewrite access to the agents an install has already deployed —
//! `<scope>/agents/*.md` for opencode, claude and zcode, deployed-state-only
//! for DSH (its presets have no per-agent markdown).
//!
//! Everything here rides on the ENGINE's own scope derivation
//! ([`crate::engine::opencode_scope_for`], [`crate::engine::claude_scope_for`],
//! [`crate::engine::zcode_root`]) — the deployed files are exactly the
//! destinations the engine plans, so there is no second copy of the path
//! logic. The frontmatter splice reuses [`crate::preserve`]'s key
//! inventories and key-line rules: the per-backend model keys this module
//! reads and rewrites are the same keys a force overwrite preserves.
//!
//! File shape (the engine's rendered agents): YAML-ish frontmatter between
//! two `---` fence lines, then the markdown body. The dialect is the same
//! one [`crate::preserve`] already parses — fence detection, `key:` lines,
//! first-occurrence-wins — never a full YAML parse. `name` and `description`
//! are read for display, the backend's model keys are read and rewritten,
//! every other frontmatter line survives a save verbatim, and the body is
//! everything after the closing fence, byte-exact (CRLF included).
//!
//! Path safety: a save resolves ONE plain existing `.md` file name strictly
//! inside the target's `agents/` directory — separators, `..`, absolute
//! paths, non-`.md` names, unknown files and symlinks resolving outside the
//! directory are hard errors.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::{
    claude_scope_for, opencode_scope_for, scope_join, scope_root_path, write_bytes, zcode_root,
    Scope, HOME_VERSION_FILE, VERSION_FILE,
};
use crate::error::WorkbenchError;
use crate::preserve::{
    frontmatter_key_of, CLAUDE_AGENT_KEYS, OPENCODE_AGENT_KEYS, ZCODE_AGENT_KEYS,
};
use crate::types::{APPLY_ORDER, Target};

/// The orchestrator file inside an `agents/` directory — deployed, but not
/// an agent, so it never counts as one.
const AGENTS_MD: &str = "AGENTS.md";

// ------------------------------------------------------------------ inputs

/// Where deployed files resolve from for one call — the same inputs the
/// engine's scope derivation consumes, in plain form. `project_dir` is the
/// user's picked project directory (`None` = not set: project-level
/// opencode/claude scopes cannot resolve, DSH/zcode/user-level never need
/// it). `dsh_home` is the caller-resolved DSH home (`$DSH_HOME` else
/// `<home>/.dsh`, via [`crate::dsh::dsh_home`]).
pub struct DeployedParams<'a> {
    pub project_dir: Option<&'a Path>,
    pub user_level: bool,
    pub home: &'a Path,
    pub dsh_home: &'a Path,
}

// ------------------------------------------------------------------- types

/// One target's row of the deployed overview. `scope_label` is the
/// human-readable scope root for display (`""` when the scope cannot
/// resolve — project level without a project directory). The two preset
/// fields are populated for the DSH target only (the other targets are
/// agents-directory based): the recursive regular-file count under the DSH
/// preset root and the newest of those files' mtime in millis — both `None`
/// when the preset root is absent or holds no files. `deployed_version` is
/// the target realm's version stamp, trimmed — `None` when the stamp file is
/// missing, unreadable or empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployedTargetState {
    pub target: Target,
    pub deployed: bool,
    pub scope_label: String,
    #[serde(default)]
    pub preset_file_count: Option<usize>,
    #[serde(default)]
    pub deployed_at_ms: Option<i64>,
    #[serde(default)]
    pub deployed_version: Option<String>,
}

/// One deployed agent markdown. `settings` carries EVERY model key of the
/// backend → its current frontmatter value (`None` = the key is absent);
/// ordered by the backend's key inventory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployedAgent {
    pub name: String,
    pub description: Option<String>,
    pub file_name: String,
    /// Everything after the closing fence, verbatim.
    pub body: String,
    pub settings: BTreeMap<String, Option<String>>,
}

// --------------------------------------------------------- scope resolution

/// The target's install scope — the engine's own derivation, shared. `None`
/// when it cannot resolve: the DSH target (no agents scope) and project-level
/// opencode/claude without a project directory (user level ignores the
/// project directory, like the engine).
fn scope_for(params: &DeployedParams<'_>, target: Target) -> Option<Scope> {
    match target {
        Target::Opencode | Target::Claude => {
            let user_level = params.user_level;
            (user_level || params.project_dir.is_some()).then(|| {
                let project = params.project_dir.unwrap_or(Path::new(""));
                match target {
                    Target::Claude => claude_scope_for(project, user_level, params.home),
                    _ => opencode_scope_for(project, user_level, params.home),
                }
            })
        }
        // Always user-level ~/.zcode regardless of the --user toggle
        // (engine parity, CLI :1130-1139).
        Target::Zcode => Some(Scope {
            root: zcode_root(params.home),
            dest: "",
        }),
        Target::Dsh => None,
    }
}

/// The directory holding the target's deployed agents: `<scope>/agents` —
/// the same join the engine plans. `None` like [`scope_for`].
fn agents_dir_for(params: &DeployedParams<'_>, target: Target) -> Option<PathBuf> {
    scope_for(params, target).map(|scope| scope_join(&scope, Path::new("agents")))
}

/// The scope root for display: `<scope>` for the markdown targets, the DSH
/// preset root for dsh, `""` when the scope cannot resolve.
fn scope_label_for(params: &DeployedParams<'_>, target: Target) -> String {
    match target {
        Target::Dsh => crate::dsh::preset_root(params.dsh_home)
            .to_string_lossy()
            .into_owned(),
        _ => scope_for(params, target)
            .map(|scope| scope_root_path(&scope).to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// The target realm's version stamp, read with the engine's own file names
/// ([`VERSION_FILE`] / [`HOME_VERSION_FILE`]) and the same realm split
/// [`crate::engine::stamp_plans`] writes: opencode/claude read the project
/// stamp `<project_dir>/my-workbench.version` at project level and the home
/// stamp `<home>/.my-workbench.version` at user level; zcode/dsh are
/// user-level-only targets and always read the home stamp. `None` when the
/// stamp is missing, unreadable or empty — never an error.
fn stamp_version_for(params: &DeployedParams<'_>, target: Target) -> Option<String> {
    let path = match target {
        Target::Opencode | Target::Claude if params.user_level => {
            params.home.join(HOME_VERSION_FILE)
        }
        Target::Opencode | Target::Claude => params.project_dir?.join(VERSION_FILE),
        Target::Zcode | Target::Dsh => params.home.join(HOME_VERSION_FILE),
    };
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|version| !version.is_empty())
}

/// The backend's model-setting key inventory — the same lists a force
/// overwrite preserves ([`crate::preserve`]).
fn model_keys(target: Target) -> &'static [&'static str] {
    match target {
        Target::Opencode => OPENCODE_AGENT_KEYS,
        Target::Claude => CLAUDE_AGENT_KEYS,
        Target::Zcode => ZCODE_AGENT_KEYS,
        Target::Dsh => &[],
    }
}

// ------------------------------------------------------------ dsh preset data

/// Recursive walk under `dir`, counting regular files and tracking the
/// newest mtime (millis since the Unix epoch). Read-only and best-effort,
/// like every other read here: unreadable entries are skipped and directory
/// symlinks are not followed.
fn count_preset_files(dir: &Path, count: &mut usize, newest_ms: &mut Option<i64>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            count_preset_files(&path, count, newest_ms);
        } else if file_type.is_file() {
            *count += 1;
            let ms = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_millis() as i64);
            if let Some(ms) = ms {
                if newest_ms.map_or(true, |current| ms > current) {
                    *newest_ms = Some(ms);
                }
            }
        }
    }
}

/// The dsh row's preset data: the recursive regular-file count under the dsh
/// preset root and the newest of those files' mtimes (millis). Both `None`
/// when the preset root is absent or holds no files.
fn dsh_preset_stats(dsh_home: &Path) -> (Option<usize>, Option<i64>) {
    let mut count = 0usize;
    let mut newest_ms = None;
    count_preset_files(&crate::dsh::preset_root(dsh_home), &mut count, &mut newest_ms);
    if count == 0 {
        (None, None)
    } else {
        (Some(count), newest_ms)
    }
}

// ------------------------------------------------------------ frontmatter

/// The frontmatter block of `text` under preserve.rs's rule — the first
/// line is exactly `---` and a later line closes it — as the line list plus
/// the closing fence's index. Lines keep their `\r` (if any); rejoining
/// with `\n` is byte-exact.
fn frontmatter_block(text: &str) -> Option<(Vec<&str>, usize)> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.first().copied() != Some("---") {
        return None;
    }
    let close = (1..lines.len()).find(|&i| lines[i] == "---")?;
    Some((lines, close))
}

/// One layer of matching quotes stripped (the deployed set quotes long
/// descriptions). Unterminated quotes stay as-is.
fn unquote(value: &str) -> &str {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        let first = bytes[0];
        let last = bytes[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// The `(key, value)` a frontmatter line opens with — the key per
/// preserve's `frontmatter_key_of`, the value the trimmed rest of the line,
/// unquoted.
fn key_value_of(line: &str) -> Option<(&str, &str)> {
    let key = frontmatter_key_of(line)?;
    let stripped = line.trim_start_matches([' ', '\t']);
    let colon = stripped.find(':')?;
    Some((key, unquote(stripped[colon + 1..].trim())))
}

/// Parse one deployed agent file: `name` / `description` from the
/// frontmatter (first occurrence wins; `name` falls back to
/// `fallback_name`, usually the file stem), every model key of `keys` →
/// its first-occurrence value, and the body — everything after the closing
/// fence, verbatim (the whole text when there is no frontmatter block).
fn parse_deployed_agent(text: &str, fallback_name: &str, file_name: &str, keys: &[&str]) -> DeployedAgent {
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut values: Vec<Option<String>> = vec![None; keys.len()];
    let body;
    if let Some((lines, close)) = frontmatter_block(text) {
        for line in &lines[1..close] {
            let Some(key) = frontmatter_key_of(line) else {
                continue;
            };
            if key == "name" && name.is_none() {
                name = Some(value_of_line(line));
                continue;
            }
            if key == "description" && description.is_none() {
                description = Some(value_of_line(line));
                continue;
            }
            if let Some(idx) = keys.iter().position(|k| *k == key) {
                if values[idx].is_none() {
                    values[idx] = Some(value_of_line(line));
                }
            }
        }
        body = lines[close + 1..].join("\n");
    } else {
        body = text.to_string();
    }
    let settings: BTreeMap<String, Option<String>> = keys
        .iter()
        .enumerate()
        .map(|(i, key)| ((*key).to_string(), values[i].clone()))
        .collect();
    DeployedAgent {
        name: name.unwrap_or_else(|| fallback_name.to_string()),
        description,
        file_name: file_name.to_string(),
        body,
        settings,
    }
}

/// The unquoted value part of a key line, or "" when the line carries none.
fn value_of_line(line: &str) -> String {
    key_value_of(line)
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

// --------------------------------------------------------------- public API

/// Per-target deployed state for ALL four targets, in APPLY_ORDER
/// (opencode → claude → zcode → dsh). Zero writes, read-only. The preset
/// file count / deployment time ride on the dsh row only; the other targets
/// report `None`. Every row carries its realm's version stamp (see
/// [`stamp_version_for`]).
pub fn deployed_overview(params: &DeployedParams<'_>) -> Vec<DeployedTargetState> {
    let dsh_stats = dsh_preset_stats(params.dsh_home);
    APPLY_ORDER
        .iter()
        .map(|target| {
            let (preset_file_count, deployed_at_ms) = if *target == Target::Dsh {
                dsh_stats
            } else {
                (None, None)
            };
            DeployedTargetState {
                target: *target,
                deployed: target_deployed(params, *target),
                scope_label: scope_label_for(params, *target),
                preset_file_count,
                deployed_at_ms,
                deployed_version: stamp_version_for(params, *target),
            }
        })
        .collect()
}

/// Whether the target has deployed content: opencode/claude/zcode carry at
/// least one deployed agent markdown (a direct `.md` file in `<scope>/agents`
/// that is not `AGENTS.md` — the orchestrator, not an agent); dsh when its
/// preset root directory exists. Unresolvable scopes (project level without
/// a project directory) report `false`.
pub fn target_deployed(params: &DeployedParams<'_>, target: Target) -> bool {
    match target {
        Target::Dsh => crate::dsh::preset_root(params.dsh_home).is_dir(),
        _ => match agents_dir_for(params, target) {
            Some(dir) => has_agent_file(&dir),
            None => false,
        },
    }
}

/// At least one direct `.md` file in `dir` other than [`AGENTS_MD`].
fn has_agent_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let path = entry.path();
        path.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            && entry.file_name().to_str() != Some(AGENTS_MD)
    })
}

/// Every deployed agent of the target, sorted by file name. Files that
/// cannot be read as UTF-8 are skipped (the engine only ever renders UTF-8;
/// a foreign byte file has no safe in-place rewrite). dsh → empty (deployed
/// state only, no agent files).
pub fn list_deployed_agents(
    params: &DeployedParams<'_>,
    target: Target,
) -> Result<Vec<DeployedAgent>, WorkbenchError> {
    let keys = model_keys(target);
    let Some(dir) = agents_dir_for(params, target) else {
        return Ok(Vec::new());
    };
    let mut file_names: Vec<String> = match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|entry| {
                let path = entry.path();
                path.is_file()
                    && path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                    && entry.file_name().to_str() != Some(AGENTS_MD)
            })
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .collect(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    file_names.sort();
    let mut agents = Vec::with_capacity(file_names.len());
    for file_name in file_names {
        let Ok(text) = std::fs::read_to_string(dir.join(&file_name)) else {
            continue; // unreadable or non-UTF-8: not a listed agent
        };
        let stem = Path::new(&file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_name.clone());
        agents.push(parse_deployed_agent(&text, &stem, &file_name, keys));
    }
    Ok(agents)
}

/// Rewrite ONE deployed agent file: every existing frontmatter line survives
/// except the backend's model keys, which `settings` drives — a key with
/// `Some(value)` is set/updated/inserted (the new line becomes the block's
/// last line, immediately before the closing fence, in backend key order),
/// a key with `None` has every line carrying it removed, and a key absent
/// from the map is left untouched. `new_body` replaces everything after the
/// closing fence verbatim. A file without a frontmatter block gains one only
/// when at least one setting is set. Other map keys (not of this backend)
/// are ignored. Returns the saved state re-parsed from the final text.
pub fn save_deployed_agent(
    params: &DeployedParams<'_>,
    target: Target,
    file_name: &str,
    new_body: &str,
    settings: &BTreeMap<String, Option<String>>,
) -> Result<DeployedAgent, WorkbenchError> {
    if target == Target::Dsh {
        return Err(WorkbenchError::Message(
            "the DSH target has no per-agent files to save".to_string(),
        ));
    }
    let keys = model_keys(target);
    let dir = agents_dir_for(params, target).ok_or_else(|| {
        WorkbenchError::Message(
            "project directory is not set; the project-level agents directory cannot be resolved"
                .to_string(),
        )
    })?;
    let path = resolve_agent_file(&dir, file_name)?;
    let text = std::fs::read_to_string(&path).map_err(|err| {
        WorkbenchError::Message(format!("cannot read {}: {err}", path.display()))
    })?;
    let final_text = splice_agent_file(&text, keys, new_body, settings);
    write_bytes(&path, final_text.as_bytes())?;
    let fallback_name = file_stem_of(file_name);
    Ok(parse_deployed_agent(&final_text, &fallback_name, file_name, keys))
}

/// The stem of an already-validated `.md` file name.
fn file_stem_of(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_string())
}

/// Resolve `file_name` strictly inside the target's `agents/` directory:
/// a single normal path component naming an existing `.md` file whose
/// canonical location stays inside the canonical directory (symlink escape
/// refused). Anything else is a hard error — unknown names included.
fn resolve_agent_file(dir: &Path, file_name: &str) -> Result<PathBuf, WorkbenchError> {
    let invalid = |why: &str| {
        Err(WorkbenchError::Message(format!(
            "invalid agent file name '{file_name}': {why}"
        )))
    };
    if file_name.is_empty() {
        return invalid("the name is empty");
    }
    if file_name.contains('/') || file_name.contains('\\') {
        return invalid("path separators are not allowed");
    }
    let rel = Path::new(file_name);
    match rel.components().collect::<Vec<_>>()[..] {
        [Component::Normal(_)] => {}
        _ => return invalid("not a plain file name"),
    }
    if !file_name.to_ascii_lowercase().ends_with(".md") {
        return invalid("only .md agent files can be saved");
    }
    let path = dir.join(rel);
    if !path.starts_with(dir) {
        return invalid("the path escapes the agents directory");
    }
    if !path.is_file() {
        return Err(WorkbenchError::Message(format!(
            "unknown deployed agent file '{file_name}' in {}",
            dir.display()
        )));
    }
    // Symlink containment: the file's real location must stay inside the
    // directory's real location.
    let canon_dir = dunce::canonicalize(dir)
        .map_err(|err| WorkbenchError::Message(format!("cannot resolve {}: {err}", dir.display())))?;
    let canon_path = dunce::canonicalize(&path).map_err(|err| {
        WorkbenchError::Message(format!("cannot resolve {}: {err}", path.display()))
    })?;
    if !canon_path.starts_with(&canon_dir) {
        return invalid("the file resolves outside the agents directory");
    }
    Ok(path)
}

/// The rewritten file text (see [`save_deployed_agent`] for the splice
/// semantics). Rejoin is byte-exact: `split('\n')` keeps `\r` on CRLF lines.
fn splice_agent_file(
    text: &str,
    keys: &[&str],
    new_body: &str,
    settings: &BTreeMap<String, Option<String>>,
) -> String {
    // The backend keys this save touches, in backend key order.
    let touched: Vec<(&str, Option<&str>)> = keys
        .iter()
        .filter_map(|key| settings.get(*key).map(|value| (*key, value.as_deref())))
        .collect();

    let mut out: Vec<String> = Vec::new();
    match frontmatter_block(text) {
        Some((lines, close)) => {
            // The opening fence, then every frontmatter line except the
            // touched keys' lines — all other lines verbatim.
            out.push(lines[0].to_string());
            for line in &lines[1..close] {
                let dropped = frontmatter_key_of(line)
                    .is_some_and(|key| touched.iter().any(|(touched_key, _)| *touched_key == key));
                if !dropped {
                    out.push((*line).to_string());
                }
            }
            // Set/updated keys become the block's last lines.
            for (key, value) in &touched {
                if let Some(value) = value {
                    out.push(format!("{key}: {value}"));
                }
            }
            out.push("---".to_string());
        }
        None => {
            // No frontmatter block: synthesize one only when there is
            // something to put into it.
            if touched.iter().any(|(_, value)| value.is_some()) {
                out.push("---".to_string());
                for (key, value) in &touched {
                    if let Some(value) = value {
                        out.push(format!("{key}: {value}"));
                    }
                }
                out.push("---".to_string());
            }
        }
    }
    out.push(new_body.to_string());
    out.join("\n")
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Sandbox {
        _guard: tempfile::TempDir,
        project: PathBuf,
        home: PathBuf,
        dsh_home: PathBuf,
    }

    fn sandbox() -> Sandbox {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let home = dir.path().join("home");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&home).unwrap();
        let dsh_home = home.join(".dsh");
        Sandbox {
            _guard: dir,
            project,
            home,
            dsh_home,
        }
    }

    fn params<'a>(
        sb: &'a Sandbox,
        project_dir: Option<&'a Path>,
        user_level: bool,
    ) -> DeployedParams<'a> {
        DeployedParams {
            project_dir,
            user_level,
            home: &sb.home,
            dsh_home: &sb.dsh_home,
        }
    }

    fn write_agent(sb: &Sandbox, rel: &str, text: &str) -> PathBuf {
        let path = sb.project.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }

    const CLAUDE_ORACLE: &str = "---\nname: oracle\ndescription: \"The oracle agent.\"\ntools: Read, Grep\nmodel: opus\neffort: high\n---\n\nYou are Oracle.\n";

    // ---------------------------------------------------- scope derivation

    #[test]
    fn scopes_match_the_engine_derivation() {
        let sb = sandbox();

        // Project level: <project>/.opencode/agents and <project>/.claude/agents.
        let p = params(&sb, Some(&sb.project), false);
        let oc = agents_dir_for(&p, Target::Opencode).unwrap();
        assert_eq!(oc, sb.project.join(".opencode").join("agents"));
        let cl = agents_dir_for(&p, Target::Claude).unwrap();
        assert_eq!(cl, sb.project.join(".claude").join("agents"));

        // User level: ~/.config/opencode/agents and ~/.claude/agents.
        let u = params(&sb, None, true);
        assert_eq!(
            agents_dir_for(&u, Target::Opencode).unwrap(),
            sb.home.join(".config").join("opencode").join("agents")
        );
        assert_eq!(
            agents_dir_for(&u, Target::Claude).unwrap(),
            sb.home.join(".claude").join("agents")
        );

        // Zcode is always user-level ~/.zcode/agents, user_level or not.
        for user_level in [false, true] {
            let p = params(&sb, Some(&sb.project), user_level);
            assert_eq!(
                agents_dir_for(&p, Target::Zcode).unwrap(),
                sb.home.join(".zcode").join("agents")
            );
        }

        // Project level without a project directory cannot resolve; dsh has
        // no agents scope.
        let n = params(&sb, None, false);
        assert!(agents_dir_for(&n, Target::Opencode).is_none());
        assert!(agents_dir_for(&n, Target::Claude).is_none());
        assert!(agents_dir_for(&n, Target::Dsh).is_none());

        // The scope labels are the engine's scope roots (and the dsh preset
        // root), "" when unresolvable.
        let p = params(&sb, Some(&sb.project), false);
        let rows = deployed_overview(&p);
        let label = |t: Target| {
            rows.iter()
                .find(|r| r.target == t)
                .map(|r| r.scope_label.clone())
                .unwrap()
        };
        assert_eq!(
            label(Target::Opencode),
            sb.project.join(".opencode").to_string_lossy().into_owned()
        );
        assert_eq!(
            label(Target::Claude),
            sb.project.join(".claude").to_string_lossy().into_owned()
        );
        assert_eq!(
            label(Target::Zcode),
            sb.home.join(".zcode").to_string_lossy().into_owned()
        );
        assert_eq!(
            label(Target::Dsh),
            sb.home
                .join(".dsh")
                .join(".agent-presets")
                .join("my-workbench")
                .to_string_lossy()
                .into_owned()
        );
        let none = deployed_overview(&params(&sb, None, false));
        assert!(none
            .iter()
            .find(|r| r.target == Target::Opencode)
            .unwrap()
            .scope_label
            .is_empty());
    }

    // ------------------------------------------------------- deployed state

    #[test]
    fn target_deployed_tracks_agent_files_and_dsh_preset_root() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);

        // Nothing deployed anywhere yet.
        for row in deployed_overview(&p) {
            assert!(!row.deployed, "{:?}", row.target);
        }

        // A non-md file does not count.
        write_agent(&sb, ".claude/agents/notes.txt", "hi\n");
        assert!(!target_deployed(&p, Target::Claude));

        // AGENTS.md alone (the orchestrator) does not count.
        write_agent(&sb, ".claude/AGENTS.md", "---\n---\nbody\n");
        assert!(!target_deployed(&p, Target::Claude));

        // One real agent file counts.
        write_agent(&sb, ".claude/agents/oracle.md", CLAUDE_ORACLE);
        assert!(target_deployed(&p, Target::Claude));
        assert!(!target_deployed(&p, Target::Opencode));

        // dsh: only the preset root directory's existence counts.
        assert!(!target_deployed(&p, Target::Dsh));
        let preset = sb.home.join(".dsh").join(".agent-presets").join("my-workbench");
        fs::create_dir_all(&preset).unwrap();
        assert!(target_deployed(&p, Target::Dsh));

        // Overview reports the whole matrix in APPLY_ORDER.
        let rows = deployed_overview(&p);
        assert_eq!(
            rows.iter().map(|r| r.target).collect::<Vec<_>>(),
            APPLY_ORDER.to_vec()
        );
        let deployed: Vec<Target> = rows.iter().filter(|r| r.deployed).map(|r| r.target).collect();
        assert_eq!(deployed, vec![Target::Claude, Target::Dsh]);
    }

    #[test]
    fn overview_reports_dsh_preset_stats_only_for_dsh() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);

        // Preset root absent: both fields are null on every row.
        for row in deployed_overview(&p) {
            assert!(row.preset_file_count.is_none(), "{:?}", row.target);
            assert!(row.deployed_at_ms.is_none(), "{:?}", row.target);
        }

        // Files under the preset root: the dsh row carries the recursive
        // regular-file count and the newest mtime; the other rows stay null.
        let preset = sb.home.join(".dsh").join(".agent-presets").join("my-workbench");
        fs::create_dir_all(preset.join("nested")).unwrap();
        fs::write(preset.join("preset.yml"), "lane: {}\n").unwrap();
        fs::write(preset.join("nested").join("agent.cordis.yml"), "rows: {}\n").unwrap();
        let modified_ms = |path: &Path| {
            fs::metadata(path)
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
        };
        let newest = modified_ms(&preset.join("preset.yml"))
            .max(modified_ms(&preset.join("nested").join("agent.cordis.yml")));

        for row in deployed_overview(&p) {
            if row.target == Target::Dsh {
                assert_eq!(row.preset_file_count, Some(2));
                assert_eq!(row.deployed_at_ms, Some(newest));
            } else {
                assert!(row.preset_file_count.is_none(), "{:?}", row.target);
                assert!(row.deployed_at_ms.is_none(), "{:?}", row.target);
            }
        }

        // An empty preset root still marks dsh as deployed, but the data
        // fields have nothing to report: both stay null.
        let sb2 = sandbox();
        let p2 = params(&sb2, Some(&sb2.project), false);
        fs::create_dir_all(
            sb2.home
                .join(".dsh")
                .join(".agent-presets")
                .join("my-workbench"),
        )
        .unwrap();
        let dsh = deployed_overview(&p2)
            .into_iter()
            .find(|r| r.target == Target::Dsh)
            .unwrap();
        assert!(dsh.deployed);
        assert!(dsh.preset_file_count.is_none());
        assert!(dsh.deployed_at_ms.is_none());
    }

    #[test]
    fn overview_reads_each_realm_version_stamp() {
        let sb = sandbox();

        // No stamp files anywhere: every row reports null.
        let p = params(&sb, Some(&sb.project), false);
        for row in deployed_overview(&p) {
            assert!(row.deployed_version.is_none(), "{:?}", row.target);
        }

        // The engine's stamp_plans realms (project level): the markdown
        // targets read the project stamp, zcode/dsh the home stamp. The
        // engine writes `format!("{}\n", version)` — the trailing newline
        // trims away.
        fs::write(sb.project.join(VERSION_FILE), "0.14.0\n").unwrap();
        fs::write(sb.home.join(HOME_VERSION_FILE), "0.13.0\n").unwrap();
        let stamped = deployed_overview(&p);
        let version = |t: Target| {
            stamped
                .iter()
                .find(|r| r.target == t)
                .unwrap()
                .deployed_version
                .clone()
                .unwrap()
        };
        assert_eq!(version(Target::Opencode), "0.14.0");
        assert_eq!(version(Target::Claude), "0.14.0");
        assert_eq!(version(Target::Zcode), "0.13.0");
        assert_eq!(version(Target::Dsh), "0.13.0");

        // User level: the markdown targets read the home realm too.
        let u = deployed_overview(&params(&sb, None, true));
        for t in [Target::Opencode, Target::Claude, Target::Zcode, Target::Dsh] {
            assert_eq!(
                u.iter().find(|r| r.target == t).unwrap().deployed_version.as_deref(),
                Some("0.13.0"),
                "{t:?}"
            );
        }

        // Project level without a project directory: the project realm cannot
        // resolve, the home realm still reads.
        let n = deployed_overview(&params(&sb, None, false));
        for t in [Target::Opencode, Target::Claude] {
            assert!(
                n.iter().find(|r| r.target == t).unwrap().deployed_version.is_none(),
                "{t:?}"
            );
        }
        assert_eq!(
            n.iter().find(|r| r.target == Target::Dsh).unwrap().deployed_version.as_deref(),
            Some("0.13.0")
        );

        // An empty / blank stamp carries no version: null, not "".
        fs::write(sb.project.join(VERSION_FILE), "  \n").unwrap();
        assert!(stamp_version_for(&p, Target::Opencode).is_none());
    }

    // ---------------------------------------------------------------- list

    #[test]
    fn list_reads_frontmatter_settings_and_verbatim_body() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);
        write_agent(&sb, ".claude/agents/oracle.md", CLAUDE_ORACLE);
        // Second file: no description, no model keys; exact `---` fences (a
        // fence line must be exactly `---`, the preserve.rs rule) with a
        // CRLF body.
        write_agent(
            &sb,
            ".claude/agents/fixer.md",
            "---\nname: fixer\nmodel: inherit\n---\n\r\nBody line.\r\n",
        );

        let agents = list_deployed_agents(&p, Target::Claude).unwrap();
        assert_eq!(agents.len(), 2);
        // Sorted by file name.
        assert_eq!(agents[0].file_name, "fixer.md");
        assert_eq!(agents[1].file_name, "oracle.md");

        let oracle = &agents[1];
        assert_eq!(oracle.name, "oracle");
        assert_eq!(oracle.description.as_deref(), Some("The oracle agent."));
        assert_eq!(oracle.settings.get("model").and_then(|v| v.as_deref()), Some("opus"));
        assert_eq!(oracle.settings.get("effort").and_then(|v| v.as_deref()), Some("high"));
        // Every backend key is present in the map.
        assert_eq!(oracle.settings.len(), CLAUDE_AGENT_KEYS.len());
        assert_eq!(oracle.body, "\nYou are Oracle.\n");

        let fixer = &agents[0];
        assert_eq!(fixer.name, "fixer");
        assert!(fixer.description.is_none());
        assert_eq!(fixer.settings.get("model").and_then(|v| v.as_deref()), Some("inherit"));
        assert_eq!(fixer.settings.get("effort").and_then(|v| v.as_deref()), None);
        // CRLF round trip: the body keeps its \r bytes.
        assert_eq!(fixer.body, "\r\nBody line.\r\n");
    }

    #[test]
    fn list_falls_back_to_the_file_stem_and_handles_edge_files() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);
        // No frontmatter at all: the whole text is the body, name falls back.
        write_agent(&sb, ".claude/agents/bare.md", "just text\n");
        // Unclosed frontmatter: same rule.
        write_agent(&sb, ".claude/agents/unclosed.md", "---\nname: x\n");
        // AGENTS.md is never listed.
        write_agent(&sb, ".claude/agents/AGENTS.md", "---\nname: orch\n---\nbody\n");

        let agents = list_deployed_agents(&p, Target::Claude).unwrap();
        assert_eq!(
            agents.iter().map(|a| a.file_name.as_str()).collect::<Vec<_>>(),
            vec!["bare.md", "unclosed.md"]
        );
        assert_eq!(agents[0].name, "bare");
        assert_eq!(agents[0].body, "just text\n");
        assert!(agents[0].description.is_none());
        assert!(agents[0].settings.values().all(|v| v.is_none()));

        // Missing agents dir → empty, not an error.
        assert!(list_deployed_agents(&p, Target::Opencode)
            .unwrap()
            .is_empty());
        // dsh lists nothing, deployed state only.
        assert!(list_deployed_agents(&p, Target::Dsh).unwrap().is_empty());
        // Non-UTF-8 bytes are skipped, not fatal.
        fs::write(sb.project.join(".claude/agents/binary.md"), [0x2d, 0x80]).unwrap();
        let agents = list_deployed_agents(&p, Target::Claude).unwrap();
        assert_eq!(agents.len(), 2);
    }

    // ---------------------------------------------------------------- save

    #[test]
    fn save_updates_inserts_and_clears_model_keys_preserving_the_rest() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);
        let path = write_agent(&sb, ".claude/agents/oracle.md", CLAUDE_ORACLE);

        // Update model, clear effort, keep tools/name/description, new body.
        let mut settings = BTreeMap::new();
        settings.insert("model".to_string(), Some("custom/pinned".to_string()));
        settings.insert("effort".to_string(), None);
        let saved = save_deployed_agent(&p, Target::Claude, "oracle.md", "\nNew body.\n", &settings)
            .unwrap();

        assert_eq!(saved.name, "oracle");
        assert_eq!(saved.description.as_deref(), Some("The oracle agent."));
        assert_eq!(saved.settings.get("model").and_then(|v| v.as_deref()), Some("custom/pinned"));
        assert_eq!(saved.settings.get("effort").and_then(|v| v.as_deref()), None);
        assert_eq!(saved.body, "\nNew body.\n");

        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "---\nname: oracle\ndescription: \"The oracle agent.\"\ntools: Read, Grep\nmodel: custom/pinned\n---\n\nNew body.\n"
        );

        // Re-inserting a cleared key appends it before the closing fence.
        let mut settings = BTreeMap::new();
        settings.insert("effort".to_string(), Some("max".to_string()));
        let saved =
            save_deployed_agent(&p, Target::Claude, "oracle.md", &saved.body, &settings).unwrap();
        assert_eq!(saved.settings.get("effort").and_then(|v| v.as_deref()), Some("max"));
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "---\nname: oracle\ndescription: \"The oracle agent.\"\ntools: Read, Grep\nmodel: custom/pinned\neffort: max\n---\n\nNew body.\n"
        );

        // A map without a key leaves that key's line untouched; duplicate
        // key lines collapse to the first when touched, and stay when not.
        write_agent(&sb, ".claude/agents/dup.md", "---\nmodel: a\nmodel: b\n---\nB\n");
        let mut settings = BTreeMap::new();
        settings.insert("model".to_string(), Some("c".to_string()));
        save_deployed_agent(&p, Target::Claude, "dup.md", "B\n", &settings).unwrap();
        assert_eq!(
            fs::read_to_string(sb.project.join(".claude/agents/dup.md")).unwrap(),
            "---\nmodel: c\n---\nB\n"
        );
    }

    #[test]
    fn save_is_a_byte_round_trip_when_nothing_changes() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);
        write_agent(&sb, ".claude/agents/oracle.md", CLAUDE_ORACLE);

        let mut agents = list_deployed_agents(&p, Target::Claude).unwrap();
        let agent = agents.remove(0);
        // Write the read state back: identical bytes.
        save_deployed_agent(&p, Target::Claude, &agent.file_name, &agent.body, &agent.settings)
            .unwrap();
        assert_eq!(
            fs::read_to_string(sb.project.join(".claude/agents/oracle.md")).unwrap(),
            CLAUDE_ORACLE
        );

        // A block with CRLF inner lines and CRLF body round trips except for
        // touched key lines, which are REGENERATED as `key: value` (LF) —
        // untouched lines and the body keep every \r byte.
        write_agent(
            &sb,
            ".claude/agents/crlf.md",
            "---\nname: crlf\nmodel: m\r\n---\n\r\nBody.\r\n",
        );
        let agents = list_deployed_agents(&p, Target::Claude).unwrap();
        let agent = agents.iter().find(|a| a.file_name == "crlf.md").unwrap().clone();
        assert_eq!(agent.settings.get("model").and_then(|v| v.as_deref()), Some("m"));
        save_deployed_agent(&p, Target::Claude, "crlf.md", &agent.body, &agent.settings).unwrap();
        assert_eq!(
            fs::read_to_string(sb.project.join(".claude/agents/crlf.md")).unwrap(),
            "---\nname: crlf\nmodel: m\n---\n\r\nBody.\r\n"
        );

        // A fully-CRLF file has no exact `---` fence line, so it parses as
        // frontmatter-free — and a plain round trip still stays byte-exact.
        write_agent(&sb, ".claude/agents/dos.md", "---\r\nname: dos\r\n---\r\nD\r\n");
        let agents = list_deployed_agents(&p, Target::Claude).unwrap();
        let agent = agents.iter().find(|a| a.file_name == "dos.md").unwrap().clone();
        assert_eq!(agent.body, "---\r\nname: dos\r\n---\r\nD\r\n");
        save_deployed_agent(&p, Target::Claude, "dos.md", &agent.body, &agent.settings).unwrap();
        assert_eq!(
            fs::read_to_string(sb.project.join(".claude/agents/dos.md")).unwrap(),
            "---\r\nname: dos\r\n---\r\nD\r\n"
        );
    }

    #[test]
    fn save_creates_a_frontmatter_block_only_when_a_setting_is_set() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);
        write_agent(&sb, ".claude/agents/bare.md", "just text\n");

        // No settings touched: the file stays frontmatter-free.
        let mut settings = BTreeMap::new();
        settings.insert("model".to_string(), None);
        save_deployed_agent(&p, Target::Claude, "bare.md", "just text\n", &settings).unwrap();
        assert_eq!(
            fs::read_to_string(sb.project.join(".claude/agents/bare.md")).unwrap(),
            "just text\n"
        );

        // A setting set: a minimal block is synthesized.
        let mut settings = BTreeMap::new();
        settings.insert("model".to_string(), Some("sonnet".to_string()));
        let saved = save_deployed_agent(&p, Target::Claude, "bare.md", "just text\n", &settings).unwrap();
        assert_eq!(saved.name, "bare", "no name line yet → stem fallback");
        assert_eq!(
            fs::read_to_string(sb.project.join(".claude/agents/bare.md")).unwrap(),
            "---\nmodel: sonnet\n---\njust text\n"
        );
    }

    #[test]
    fn save_rejects_unknown_names_and_every_escape() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);
        write_agent(&sb, ".claude/agents/oracle.md", CLAUDE_ORACLE);
        fs::create_dir_all(sb.project.join(".claude/agents/sub")).unwrap();
        write_agent(&sb, ".claude/settings.json", "{}\n");
        let settings: BTreeMap<String, Option<String>> = BTreeMap::new();

        // Unknown file names.
        for name in ["missing.md", "oracle.txt", "sub/inner.md"] {
            let err = save_deployed_agent(&p, Target::Claude, name, "b", &settings).unwrap_err();
            let text = err.to_string();
            assert!(
                text.contains("invalid agent file name") || text.contains("unknown deployed agent"),
                "{name}: {text}"
            );
        }

        // Escapes: parent traversal, absolute, empty.
        for name in ["../oracle.md", "..", ".", "", "C:\\evil.md", "/etc/passwd.md"] {
            assert!(
                save_deployed_agent(&p, Target::Claude, name, "b", &settings).is_err(),
                "must reject {name:?}"
            );
        }

        // The surviving file is untouched by the rejected saves.
        assert_eq!(
            fs::read_to_string(sb.project.join(".claude/agents/oracle.md")).unwrap(),
            CLAUDE_ORACLE
        );

        // A symlink escaping the agents directory is refused.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                sb.project.join(".claude/settings.json"),
                sb.project.join(".claude/agents/link.md"),
            )
            .unwrap();
            assert!(save_deployed_agent(&p, Target::Claude, "link.md", "b", &settings).is_err());
        }
    }

    #[test]
    fn save_and_list_refuse_dsh_and_unresolvable_scopes() {
        let sb = sandbox();
        // dsh: listing is empty, saving errors.
        let p = params(&sb, Some(&sb.project), false);
        assert!(list_deployed_agents(&p, Target::Dsh).unwrap().is_empty());
        let err = save_deployed_agent(&p, Target::Dsh, "x.md", "b", &BTreeMap::new()).unwrap_err();
        assert!(err.to_string().contains("DSH"), "{err}");

        // Project-level opencode without a project dir: empty list, save errs.
        let n = params(&sb, None, false);
        assert!(list_deployed_agents(&n, Target::Opencode).unwrap().is_empty());
        let err =
            save_deployed_agent(&n, Target::Claude, "oracle.md", "b", &BTreeMap::new()).unwrap_err();
        assert!(err.to_string().contains("project directory"), "{err}");
    }

    #[test]
    fn save_supports_every_backend_key_inventory() {
        let sb = sandbox();
        let p = params(&sb, Some(&sb.project), false);

        // zcode: ~/.zcode/agents, model + thoughtLevel.
        let zpath = sb.home.join(".zcode").join("agents").join("z.md");
        fs::create_dir_all(zpath.parent().unwrap()).unwrap();
        fs::write(&zpath, "---\nname: z\nmodel: inherit\n---\nZ\n").unwrap();
        let zp = DeployedParams {
            project_dir: Some(&sb.project),
            user_level: false,
            home: &sb.home,
            dsh_home: &sb.dsh_home,
        };
        let agents = list_deployed_agents(&zp, Target::Zcode).unwrap();
        assert_eq!(
            agents[0]
                .settings
                .get("thoughtLevel")
                .and_then(|v| v.as_deref()),
            None
        );
        let mut settings = BTreeMap::new();
        settings.insert("thoughtLevel".to_string(), Some("max".to_string()));
        let saved = save_deployed_agent(&zp, Target::Zcode, "z.md", "Z\n", &settings).unwrap();
        assert_eq!(saved.settings.get("thoughtLevel").and_then(|v| v.as_deref()), Some("max"));
        assert_eq!(
            fs::read_to_string(sb.home.join(".zcode/agents/z.md")).unwrap(),
            "---\nname: z\nmodel: inherit\nthoughtLevel: max\n---\nZ\n"
        );

        // opencode: <project>/.opencode/agents, model + variant.
        write_agent(&sb, ".opencode/agents/o.md", "---\nname: o\nmodel: m\nvariant: v\n---\nO\n");
        let mut settings = BTreeMap::new();
        settings.insert("variant".to_string(), Some("max".to_string()));
        let saved = save_deployed_agent(&p, Target::Opencode, "o.md", "O\n", &settings).unwrap();
        assert_eq!(saved.settings.get("variant").and_then(|v| v.as_deref()), Some("max"));
        assert_eq!(
            fs::read_to_string(sb.project.join(".opencode/agents/o.md")).unwrap(),
            "---\nname: o\nmodel: m\nvariant: max\n---\nO\n"
        );
    }
}
