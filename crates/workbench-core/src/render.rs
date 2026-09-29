//! The render pipeline: prompt bodies, slots, backend assembly and the DSH
//! lane plugin's generated JavaScript modules.
//!
//! Byte-level port of `bin/my-workbench.js` (:565-858). Every function here
//! must produce byte-identical output to its JS counterpart — the golden gate
//! (PLAN.md §6) proves it. Two families of details carry the parity burden:
//!
//! - **`JSON.stringify` escaping** — `serde_json::to_string` must reproduce
//!   V8's escaping exactly; the adversarial suite in this file's tests locks
//!   the whole class table (see `json_escaping_matches_json_stringify`).
//! - **`String.prototype.replace` with a global regex** — replacements are
//!   never rescanned, and a failed match advances one character. The single
//!   scanner below ([`replace_placeholders`]) implements those semantics for
//!   `{{slot:…}}` / `{{prompt:…}}` / `{{dep:…}}` alike.

use crate::roster::load_roster;
use crate::types::{LaneRecord, RecommendedRoute};
use crate::WorkbenchError;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

// ---------------------------------------------------------------- constants

/// The attribution notice every adapted prompt body opens with, verbatim
/// (`bin/my-workbench.js` :579-580).
pub const ATTRIBUTION_NOTICE: &str =
    "> Adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) agent prompts — MIT License, Copyright (c) 2025.";

/// Deployment packages the lane plugin imports, keyed by template alias, in
/// the constant's authored order (`bin/my-workbench.js` :104-107). Only the
/// KEYS drive the two-way check in [`render_lane_host`]; the values live with
/// the caller (baked `file:` URLs for install, bare names for check).
pub const DSH_LANE_PLUGIN_DEP_ALIASES: [&str; 2] = ["dsh-tools", "schemastery"];

// ------------------------------------------------------- JS string semantics

/// ECMAScript `\s`: WhiteSpace + LineTerminator (Unicode Zs as of ES2015+).
/// Deliberately not `char::is_whitespace` — the sets differ (e.g. U+0085).
pub(crate) fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{000B}'
            | '\u{000C}'
            | '\r'
            | ' '
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&c)
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

pub(crate) fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_ws)
}

/// A regex `[\w-]` character: JS `\w` is ASCII `[A-Za-z0-9_]`.
fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// A regex `[\w@/.-]` character (the lane host's leftover-placeholder class).
fn is_generic_value_char(c: char) -> bool {
    is_name_char(c) || matches!(c, '@' | '/' | '.')
}

/// Skip a maximal ECMAScript-`\s` run from byte index `i`.
pub(crate) fn skip_js_ws_from(s: &str, mut i: usize) -> usize {
    while let Some(c) = s[i..].chars().next() {
        if is_js_ws(c) {
            i += c.len_utf8();
        } else {
            break;
        }
    }
    i
}

/// One frontmatter line after `loadBackend`'s mapping: `@description` becomes
/// `description: <JSON.stringify(record.description)>`; everything else is
/// kept verbatim (`String()`-coerced, as `Array.join` would).
fn frontmatter_line(
    line: &Value,
    entry: &crate::roster::AgentEntry,
    backend: &str,
) -> Result<String, WorkbenchError> {
    if line.as_str() == Some("@description") {
        // `description: ${JSON.stringify(record.description)}` — a missing key
        // stringifies as bare `undefined`, as in JS.
        let description = match entry.record.get("description") {
            Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()),
            None => "undefined".to_string(),
        };
        return Ok(format!("description: {description}"));
    }
    match line {
        Value::String(s) => Ok(s.clone()),
        Value::Null => Ok("null".to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(WorkbenchError::Message(format!(
            "agents/roster.json: agent '{}' has a non-scalar {backend} frontmatter line",
            entry.name
        ))),
    }
}

// ----------------------------------------------------------- placeholder scan

/// Replace every `{{<prefix><name>}}` occurrence, with
/// `String.prototype.replace(/…/g)` semantics:
///
/// - the scan walks the INPUT only — replacement text is never rescanned;
/// - a malformed candidate (empty name, missing `}}`) advances the scan one
///   character, exactly like the regex engine backtracking past a position;
/// - `on_match` receives the raw matched text, the captured name and the
///   match's byte offset in the original input.
fn replace_placeholders<F>(input: &str, prefix: &str, mut on_match: F) -> Result<String, WorkbenchError>
where
    F: FnMut(&str, &str, usize) -> Result<String, WorkbenchError>,
{
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    while let Some(at) = input[cursor..].find(prefix) {
        let start = cursor + at;
        let after = start + prefix.len();
        let name: String = input[after..].chars().take_while(|c| is_name_char(*c)).collect();
        let after_name = after + name.len();
        if name.is_empty() || !input[after_name..].starts_with("}}") {
            // Malformed candidate: the regex engine would advance one
            // character — flush the scanned text up to and including it.
            out.push_str(&input[cursor..start + 1]);
            cursor = start + 1;
            continue;
        }
        let raw_end = after_name + 2;
        let raw = &input[start..raw_end];
        out.push_str(&input[cursor..start]);
        out.push_str(&on_match(raw, &name, start)?);
        cursor = raw_end;
    }
    out.push_str(&input[cursor..]);
    Ok(out)
}

/// First occurrence of any `{{<prefix><name>}}` (valid, complete) in `input`,
/// returning the raw matched text — the `.match(/…/)` of the leftover checks.
fn find_first_placeholder(input: &str, prefixes: &[&str]) -> Option<String> {
    for start in 0..input.len() {
        // An ASCII pattern can only start at a char boundary; skip the rest
        // instead of slicing into a multi-byte character.
        if !input.is_char_boundary(start) {
            continue;
        }
        for prefix in prefixes {
            if !input[start..].starts_with(prefix) {
                continue;
            }
            let after = start + prefix.len();
            let name: String = input[after..].chars().take_while(|c| is_name_char(*c)).collect();
            if !name.is_empty() && input[after + name.len()..].starts_with("}}") {
                return Some(input[start..after + name.len() + 2].to_string());
            }
        }
    }
    None
}

/// First `{{name-words:value-words}}` — the lane host's generic leftover
/// pattern `\{\{[\w-]+:[\w@/.-]+\}\}`.
fn find_first_generic_placeholder(input: &str) -> Option<String> {
    for start in 0..input.len() {
        if !input.is_char_boundary(start) || !input[start..].starts_with("{{") {
            continue;
        }
        let mut i = start + 2;
        let name_len = input[i..].chars().take_while(|c| is_name_char(*c)).count();
        if name_len == 0 {
            continue;
        }
        i += name_len;
        if !input[i..].starts_with(':') {
            continue;
        }
        i += 1;
        let value_len = input[i..].chars().take_while(|c| is_generic_value_char(*c)).count();
        if value_len == 0 {
            continue;
        }
        i += value_len;
        if input[i..].starts_with("}}") {
            return Some(input[start..i + 2].to_string());
        }
    }
    None
}

// ----------------------------------------------------------- the primitives

/// Read one shared prompt body verbatim; a backend template may only reference
/// prompts that exist (`promptBody`, :565-571). Missing file = hard error.
fn prompt_body(source_root: &Path, agent_name: &str) -> Result<String, WorkbenchError> {
    let file = source_root.join("agents").join("prompts").join(format!("{agent_name}.md"));
    if !file.exists() {
        return Err(WorkbenchError::Message(format!(
            "agents/prompts/{agent_name}.md is missing (referenced by a backend template)"
        )));
    }
    Ok(std::fs::read_to_string(file)?)
}

/// Drop the attribution notice from the head of a prompt body
/// (`stripAttribution`, :591-594). Only the exact `NOTICE + "\n\n"` prefix
/// goes; a body without it passes through untouched.
pub fn strip_attribution(body: &str) -> &str {
    let head = format!("{ATTRIBUTION_NOTICE}\n\n");
    match body.strip_prefix(&head) {
        Some(rest) => rest,
        None => body,
    }
}

/// Load a backend's slot texts: `agents/backends/<backend>/slots/<name>.md` →
/// trimmed content (`loadSlots`, :597-606). A missing directory is an empty
/// map. Entries are visited in sorted order for determinism (the CLI uses raw
/// `readdirSync` order; see the port notes in the module docs of checks.rs).
fn load_slots(source_root: &Path, backend: &str) -> Result<BTreeMap<String, String>, WorkbenchError> {
    let dir = source_root
        .join("agents")
        .join("backends")
        .join(backend)
        .join("slots");
    let mut slots = BTreeMap::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(slots),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Some(base) = file_name.strip_suffix(".md") else {
            continue;
        };
        let content = std::fs::read_to_string(entry.path())?;
        slots.insert(base.to_string(), js_trim_end(&content).to_string());
    }
    Ok(slots)
}

/// Slot accounting for one assemble run: which backends ran, which slot files
/// each backend provides, and which were actually filled — the input to
/// `warnUnusedSlots` (:626-630).
///
/// `unused_warnings` is idempotent and reports, per backend in first-use
/// order, the backend's slot files that no body of the run referenced. It
/// needs no filesystem access because `fill_slots` snapshots the directory at
/// fill time.
#[derive(Debug, Default, Clone)]
pub struct UsedSlots {
    backends: Vec<String>,
    available: BTreeMap<String, BTreeSet<String>>,
    used: BTreeMap<String, BTreeSet<String>>,
}

impl UsedSlots {
    pub fn new() -> Self {
        Self::default()
    }

    fn note_available(&mut self, backend: &str, names: BTreeSet<String>) {
        if !self.backends.iter().any(|b| b == backend) {
            self.backends.push(backend.to_string());
        }
        self.available.insert(backend.to_string(), names);
    }

    fn note_used(&mut self, backend: &str, name: &str) {
        self.used
            .entry(backend.to_string())
            .or_default()
            .insert(name.to_string());
    }

    /// `warn: unused slot '<name>' in agents/backends/<backend>/slots/` for
    /// every slot file no filled body referenced, per backend in first-use
    /// order, slots sorted within a backend.
    pub fn unused_warnings(&self) -> Vec<String> {
        let mut out = Vec::new();
        for backend in &self.backends {
            let Some(available) = self.available.get(backend) else {
                continue;
            };
            let used = self.used.get(backend);
            for slot in available {
                if !used.is_some_and(|u| u.contains(slot)) {
                    out.push(format!(
                        "warn: unused slot '{slot}' in agents/backends/{backend}/slots/"
                    ));
                }
            }
        }
        out
    }
}

/// Replace `{{slot:<name>}}` placeholders with the backend's slot texts
/// (`fillSlots`, :614-623). A referenced-but-missing slot is a hard error.
fn fill_slots(
    source_root: &Path,
    backend: &str,
    body: &str,
    used: &mut UsedSlots,
) -> Result<String, WorkbenchError> {
    let slots = load_slots(source_root, backend)?;
    used.note_available(backend, slots.keys().cloned().collect());
    replace_placeholders(body, "{{slot:", |_, slot_name, _| match slots.get(slot_name) {
        Some(text) => {
            used.note_used(backend, slot_name);
            Ok(text.clone())
        }
        None => Err(WorkbenchError::Message(format!(
            "agents/backends/{backend}/slots/ is missing slot '{slot_name}' (referenced by agents/prompts/)"
        ))),
    })
}

/// The universal disciplines as delivered text: `agents/disciplines.md`,
/// verbatim, with the blank-line separator (`disciplinesBlock`, :656-660).
/// Trailing whitespace is stripped; the block itself carries no trailing
/// newline.
pub fn disciplines_block(source_root: &Path) -> Result<String, WorkbenchError> {
    let file = source_root.join("agents").join("disciplines.md");
    if !file.exists() {
        return Err(WorkbenchError::Message(
            "agents/disciplines.md is missing (the universal disciplines every agent prompt carries)"
                .to_string(),
        ));
    }
    let content = std::fs::read_to_string(file)?;
    Ok(format!("\n\n{}", js_trim_end(&content)))
}

/// The backend frontmatter lines for one agent, with `@description` swapped
/// for `description: <JSON.stringify(record.description)>` (`loadBackend`,
/// :513-523). Agents without authored frontmatter for this backend are
/// skipped, exactly like the CLI's `continue`.
fn backend_frontmatter(
    source_root: &Path,
    backend: &str,
) -> Result<Vec<(String, Vec<String>)>, WorkbenchError> {
    let mut out = Vec::new();
    for entry in load_roster(source_root)? {
        let Some(lines) = entry.record.get("frontmatter").and_then(|f| f.get(backend)) else {
            continue;
        };
        let Some(lines) = lines.as_array() else {
            return Err(WorkbenchError::Message(format!(
                "agents/roster.json: agent '{}' frontmatter for '{backend}' is not an array",
                entry.name
            )));
        };
        let rendered = lines
            .iter()
            .map(|line| frontmatter_line(line, &entry, backend))
            .collect::<Result<Vec<String>, WorkbenchError>>()?;
        out.push((entry.name, rendered));
    }
    Ok(out)
}

/// Assemble one agent markdown file for a backend (`assembleAgent`, :640-645):
/// frontmatter, then the slot-filled, trimmed shared body, then the universal
/// disciplines. Slot fill happens BEFORE the trim, exactly as in the CLI — a
/// slot value's edge whitespace is subject to the trim.
pub fn assemble_agent(
    source_root: &Path,
    backend: &str,
    agent: &crate::roster::AgentEntry,
    used_slots: &mut UsedSlots,
) -> Result<String, WorkbenchError> {
    let meta = backend_frontmatter(source_root, backend)?
        .into_iter()
        .find(|(name, _)| name == &agent.name);
    let Some((_, frontmatter)) = meta else {
        return Err(WorkbenchError::Message(format!(
            "agents/backends metadata is missing agent '{}'",
            agent.name
        )));
    };
    let raw = prompt_body(source_root, &agent.name)?;
    let stripped = strip_attribution(&raw);
    let filled = fill_slots(source_root, backend, stripped, used_slots)?;
    let body = js_trim(&filled);
    Ok(format!(
        "---\n{}\n---\n\n{}{}",
        frontmatter.join("\n"),
        body,
        disciplines_block(source_root)?
    ))
}

/// Deliver one agent's prompt with the universal disciplines appended, slots
/// filled from `backend` (`agentPromptBody` :682-684 composed with the
/// `fillSlots(agentPromptBody(n), backend, used)` its two callers apply).
///
/// Fill happens over the WHOLE `trimmed body + disciplines` string, matching
/// the CLI call order; the trailing-whitespace strip its callers apply is not
/// part of this function (they do it themselves).
pub fn agent_prompt_body(
    source_root: &Path,
    backend: &str,
    name: &str,
    used_slots: &mut UsedSlots,
) -> Result<String, WorkbenchError> {
    let raw = prompt_body(source_root, name)?;
    let trimmed = js_trim(strip_attribution(&raw)).to_string();
    let with_disciplines = format!("{trimmed}{}", disciplines_block(source_root)?);
    fill_slots(source_root, backend, &with_disciplines, used_slots)
}

/// Replace `{{prompt:<agent>}}` placeholders in a backend template with that
/// agent's prompt body (`fillPrompts`, :734-751).
///
/// The indentation protocol: the placeholder must stand ALONE on its line;
/// the body's first line inherits the placeholder's column untouched, each
/// subsequent non-blank line gets the placeholder line's indentation
/// prepended, blank lines stay truly empty.
fn fill_prompts(
    source_root: &Path,
    template: &str,
    backend: &str,
    used_slots: &mut UsedSlots,
) -> Result<String, WorkbenchError> {
    replace_placeholders(template, "{{prompt:", |raw, agent_name, offset| {
        let line_start = template[..offset].rfind('\n').map_or(0, |i| i + 1);
        let line_end = template[offset..]
            .find('\n')
            .map_or(template.len(), |i| offset + i);
        let line = &template[line_start..line_end];
        if js_trim(line) != raw {
            return Err(WorkbenchError::Message(format!(
                "{{{{prompt:{agent_name}}}}} must stand alone on its own line in agents/backends/{backend}/"
            )));
        }
        let pad = " ".repeat(line.chars().take_while(|c| is_js_ws(*c)).count());
        // The match starts after the placeholder line's own indentation, so
        // the body's first line already sits at `pad` columns.
        let filled = agent_prompt_body(source_root, backend, agent_name, used_slots)?;
        let body = js_trim_end(&filled);
        Ok(body
            .split('\n')
            .enumerate()
            .map(|(index, text)| {
                if js_trim(text).is_empty() {
                    String::new()
                } else if index == 0 {
                    text.to_string()
                } else {
                    format!("{pad}{text}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n"))
    })
}

/// Render the DSH preset composition from its template; an unfilled
/// placeholder is an error (`renderDshComposition`, :754-760). Owns a private
/// [`UsedSlots`] — the CLI's shared-set warning accounting for this render
/// belongs to the assemble caller, which composes via [`assemble_agent`].
pub fn render_dsh_composition(source_root: &Path) -> Result<String, WorkbenchError> {
    let template = std::fs::read_to_string(
        source_root
            .join("agents")
            .join("backends")
            .join("dsh")
            .join("agent.cordis.yml"),
    )?;
    let mut used_slots = UsedSlots::new();
    let rendered = fill_prompts(source_root, &template, "dsh", &mut used_slots)?;
    if let Some(leftover) = find_first_placeholder(&rendered, &["{{prompt:", "{{slot:"]) {
        return Err(WorkbenchError::Message(format!(
            "agents/backends/dsh/agent.cordis.yml left '{leftover}' unfilled"
        )));
    }
    Ok(rendered)
}

// ------------------------------------------------- DSH lane plugin rendering

/// Render the plugin's personas from the authored lane keys and shared prompts
/// (`renderLanePrompts`, :765-771): a generated JS module in lanes.json order.
pub fn render_lane_prompts(
    source_root: &Path,
    lanes: &[LaneRecord],
) -> Result<String, WorkbenchError> {
    let mut used_slots = UsedSlots::new();
    let mut entries = Vec::with_capacity(lanes.len());
    for lane in lanes {
        let filled = agent_prompt_body(source_root, "dsh", &lane.key, &mut used_slots)?;
        let body = js_trim_end(&filled);
        entries.push(format!(
            "  {}: {}",
            serde_json::to_string(&lane.key)?,
            serde_json::to_string(&body)?
        ));
    }
    Ok(format!(
        "export const LANE_PROMPTS = {{\n{}\n}}\n\nexport default LANE_PROMPTS\n",
        entries.join(",\n")
    ))
}

/// The host-only lane fields as a generated JS module (`laneRosterSource`,
/// :774-777). Struct serialization pins the field order (`key, tool,
/// denyWrites, denyShell, recommended`) against serde_json's sorted maps.
pub fn lane_roster_source(lanes: &[LaneRecord]) -> String {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HostLane<'a> {
        key: &'a str,
        tool: &'a str,
        deny_writes: bool,
        deny_shell: bool,
        recommended: &'a RecommendedRoute,
    }
    let host_lanes: Vec<HostLane<'_>> = lanes
        .iter()
        .map(|lane| HostLane {
            key: &lane.key,
            tool: &lane.tool,
            deny_writes: lane.deny_writes,
            deny_shell: lane.deny_shell,
            recommended: &lane.recommended,
        })
        .collect();
    format!(
        "export const LANES = {}\n",
        serde_json::to_string_pretty(&host_lanes).expect("plain structs always serialize")
    )
}

/// Fill `{{dep:<alias>}}` in the lane plugin's host module (`renderLaneHost`,
/// :791-811). `deps` maps each alias to the specifier to import — install
/// passes baked absolute `file:` URLs, check passes bare package names. Every
/// declared alias must be consumed; a leftover generic placeholder is an error.
pub fn render_lane_host(
    source_root: &Path,
    deps: &BTreeMap<String, String>,
) -> Result<String, WorkbenchError> {
    let template = std::fs::read_to_string(
        source_root
            .join("agents")
            .join("backends")
            .join("dsh")
            .join("lane-plugin")
            .join("host-package")
            .join("src")
            .join("index.js"),
    )?;
    let known = DSH_LANE_PLUGIN_DEP_ALIASES.join(", ");
    let mut used: Vec<String> = Vec::new();
    let rendered = replace_placeholders(&template, "{{dep:", |raw, alias, _| {
        match deps.get(alias) {
            Some(specifier) => {
                used.push(alias.to_string());
                Ok(specifier.clone())
            }
            None => Err(WorkbenchError::Message(format!(
                "unknown dependency alias '{raw}' in the lane plugin host module (known: {known})"
            ))),
        }
    })?;
    for alias in DSH_LANE_PLUGIN_DEP_ALIASES {
        if !used.iter().any(|a| a == alias) {
            return Err(WorkbenchError::Message(format!(
                "the lane plugin host module never imports '{alias}'; expected a '{{{{dep:{alias}}}}}' placeholder"
            )));
        }
    }
    if let Some(leftover) = find_first_generic_placeholder(&rendered) {
        return Err(WorkbenchError::Message(format!(
            "the lane plugin host module left '{leftover}' unfilled"
        )));
    }
    Ok(rendered)
}

#[derive(serde::Serialize)]
struct UiLane<'a> {
    key: &'a str,
    zh: &'a str,
}

/// Render the browser page's display names from the same authored lane record
/// (`laneUiClientSource`, :853-858): the client must contain the roster
/// marker EXACTLY once; it is replaced with the compact JSON of
/// `{key, zh}` pairs in lanes.json order.
pub fn lane_ui_client_source(
    source_root: &Path,
    lanes: &[LaneRecord],
) -> Result<String, WorkbenchError> {
    let template = std::fs::read_to_string(
        source_root
            .join("agents")
            .join("backends")
            .join("dsh")
            .join("lane-plugin-ui")
            .join("lib")
            .join("client.js"),
    )?;
    let marker = "\"__MY_WORKBENCH_LANES__\"";
    let first = template.find(marker);
    let last = template.rfind(marker);
    match (first, last) {
        (Some(at), Some(last_at)) if at == last_at => {
            let ui_lanes: Vec<UiLane<'_>> = lanes
                .iter()
                .map(|lane| UiLane {
                    key: &lane.key,
                    zh: &lane.zh,
                })
                .collect();
            let json = serde_json::to_string(&ui_lanes)?;
            // JS `String.replace` with a string pattern replaces the FIRST
            // occurrence; with the exactly-one guarantee above they coincide.
            Ok(template.replacen(marker, &json, 1))
        }
        _ => Err(WorkbenchError::Message(
            "lane UI must contain exactly one roster marker".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap()
            .to_path_buf()
    }

    // ------------------------------------------------------- escaping suite

    /// The highest-priority port risk (PLAN.md §6/§8): `serde_json::to_string`
    /// must equal `JSON.stringify` byte for byte. Each assertion's expected
    /// text is hand-computed from ECMAScript's SerializeJSONProperty table.
    #[test]
    fn json_escaping_matches_json_stringify() {
        let cases: &[(&str, String)] = &[
            // plain ASCII
            ("hello world", "\"hello world\"".to_string()),
            // quote and backslash
            ("a\"b\\c", "\"a\\\"b\\\\c\"".to_string()),
            // the five named escapes
            ("n\nl", "\"n\\nl\"".to_string()),
            ("r\rr", "\"r\\rr\"".to_string()),
            ("t\tt", "\"t\\tt\"".to_string()),
            ("b\u{0008}b", "\"b\\bb\"".to_string()),
            ("f\u{000C}f", "\"f\\ff\"".to_string()),
            // other control chars, lowercase hex, zero-padded
            ("\u{0000}", "\"\\u0000\"".to_string()),
            ("\u{0001}", "\"\\u0001\"".to_string()),
            ("\u{000B}", "\"\\u000b\"".to_string()),
            ("\u{001F}", "\"\\u001f\"".to_string()),
            // CJK passes through raw
            ("代码库导航", "\"代码库导航\"".to_string()),
            // emoji passes through raw (astral plane, no surrogate escapes)
            ("🚀🎉", "\"🚀🎉\"".to_string()),
            // U+2028 / U+2029 are NOT escaped by JSON.stringify
            ("a\u{2028}b\u{2029}c", "\"a\u{2028}b\u{2029}c\"".to_string()),
            // DEL is not a control escape target
            ("x\u{007F}y", "\"x\u{007F}y\"".to_string()),
            // empty string
            ("", "\"\"".to_string()),
            // trailing backslash
            ("a\\", "\"a\\\\\"".to_string()),
            // everything at once
            (
                "mix\"\n\\\u{0001}中🚀\u{2028}",
                "\"mix\\\"\\n\\\\\\u0001中🚀\u{2028}\"".to_string(),
            ),
        ];
        for (input, expected) in cases {
            let actual = serde_json::to_string(input).unwrap();
            assert_eq!(&actual, expected, "input: {input:?}");
        }
    }

    // ------------------------------------------------------------ js trims

    #[test]
    fn js_trim_uses_the_ecmascript_whitespace_set() {
        assert_eq!(js_trim("\u{00A0} x \u{3000}"), "x");
        assert_eq!(js_trim("\u{2028}\nx\n"), "x");
        // U+0085 is NOT JS whitespace (differs from char::is_whitespace)
        assert_eq!(js_trim("\u{0085}x\u{0085}"), "\u{0085}x\u{0085}");
        assert_eq!(js_trim_end("x\u{FEFF}  \t"), "x");
        assert_eq!(js_trim("   "), "");
    }

    // ---------------------------------------------------------- attribution

    #[test]
    fn strip_attribution_removes_only_the_exact_prefix() {
        let body = "Keep this.\n";
        assert_eq!(strip_attribution(body), body);
        // notice present but no trailing blank line: untouched
        assert_eq!(strip_attribution(&format!("{ATTRIBUTION_NOTICE}\nX")), &format!("{ATTRIBUTION_NOTICE}\nX"));
        // exactly the prefix: removed with its blank line
        assert_eq!(strip_attribution(&format!("{ATTRIBUTION_NOTICE}\n\nBody")), "Body");
        // a mid-prompt mention survives
        let mention = format!("Intro\n\n{ATTRIBUTION_NOTICE}\n\nTail");
        assert_eq!(strip_attribution(&mention), mention);
        // a truncated notice (one \n) is not the prefix
        assert_eq!(strip_attribution(&format!("{ATTRIBUTION_NOTICE}\nBody")), &format!("{ATTRIBUTION_NOTICE}\nBody"));
        assert_eq!(strip_attribution(""), "");
    }

    // ------------------------------------------------------------- slots

    #[test]
    fn fill_slots_replaces_and_records_usage() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "agents/backends/claude/slots/tone.md", "Be kind.\n");
        write(dir.path(), "agents/backends/claude/slots/voice-2.md", "  \n");
        write(dir.path(), "agents/backends/claude/slots/notes.txt", "ignored");
        let mut used = UsedSlots::new();
        let out = fill_slots(dir.path(), "claude", "A {{slot:tone}} B {{slot:tone}} C", &mut used).unwrap();
        assert_eq!(out, "A Be kind. B Be kind. C");
        // value's trailing whitespace was stripped at load time
        let out = fill_slots(dir.path(), "claude", "x{{slot:voice-2}}y", &mut used).unwrap();
        assert_eq!(out, "xy");
        let warnings = used.unused_warnings();
        // every slot of the backend is accounted for; nothing unused here
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn fill_slots_missing_slot_is_a_hard_error_with_the_cli_message() {
        let dir = tempfile::tempdir().unwrap();
        let mut used = UsedSlots::new();
        let err = fill_slots(dir.path(), "dsh", "x {{slot:ghost}} y", &mut used).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/backends/dsh/slots/ is missing slot 'ghost' (referenced by agents/prompts/)"
        );
    }

    #[test]
    fn fill_slots_malformed_placeholders_pass_through_unrescanned() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "agents/backends/claude/slots/tone.md", "ok");
        let mut used = UsedSlots::new();
        for literal in [
            "{{slot:}}",
            "{{slot:x",
            "{{slot:x y}}",
            "{{slot:x}y}}",
            "{{slot:",
            "{slot:x}}",
        ] {
            let out = fill_slots(dir.path(), "claude", &format!("a {literal} b"), &mut used).unwrap();
            assert_eq!(out, format!("a {literal} b"), "literal {literal:?}");
        }
        // a replacement containing a placeholder-looking text is NOT rescanned
        write(
            dir.path(),
            "agents/backends/claude/slots/nested.md",
            "{{slot:tone}} inside",
        );
        let out = fill_slots(dir.path(), "claude", "[{{slot:nested}}]", &mut used).unwrap();
        assert_eq!(out, "[{{slot:tone}} inside]");
    }

    #[test]
    fn unused_warnings_report_unfilled_slot_files_in_order() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "agents/backends/claude/slots/b-used.md", "x");
        write(dir.path(), "agents/backends/claude/slots/a-unused.md", "x");
        write(dir.path(), "agents/backends/claude/slots/c-unused.md", "x");
        let mut used = UsedSlots::new();
        fill_slots(dir.path(), "claude", "{{slot:b-used}}", &mut used).unwrap();
        // a second backend's accounting accumulates after the first
        write(dir.path(), "agents/backends/dsh/slots/z.md", "x");
        fill_slots(dir.path(), "dsh", "{{slot:z}}", &mut used).unwrap();
        assert_eq!(
            used.unused_warnings(),
            vec![
                "warn: unused slot 'a-unused' in agents/backends/claude/slots/".to_string(),
                "warn: unused slot 'c-unused' in agents/backends/claude/slots/".to_string(),
            ]
        );
    }

    // --------------------------------------------------------- assembleAgent

    /// Full fixture: roster + prompts + slots + disciplines for agent-a.
    fn assemble_fixture(dir: &tempfile::TempDir) {
        write(
            dir.path(),
            "agents/roster.json",
            r#"{
  "agents": {
    "agent-a": {
      "description": "Desc with \"quotes\" and \\ backslash 中🚀",
      "frontmatter": {
        "claude": ["name: agent-a", "@description", "tools: Read"],
        "opencode": ["@description", "mode: subagent"]
      }
    },
    "agent-b": {
      "description": "b",
      "frontmatter": { "opencode": ["@description"] }
    }
  }
}"#,
        );
        // {{{{ in a format! literal emits {{ — the placeholder braces survive
        write(
            dir.path(),
            "agents/prompts/agent-a.md",
            &format!("{ATTRIBUTION_NOTICE}\n\n  Preamble {{{{slot:tone}}}}.\n  more  \n\n"),
        );
        write(dir.path(), "agents/backends/claude/slots/tone.md", "Be kind.");
        write(dir.path(), "agents/disciplines.md", "Rule one.\nRule two.\n\n \n");
    }

    #[test]
    fn assemble_agent_matches_the_cli_byte_protocol() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        let roster = load_roster(dir.path()).unwrap();
        let agent_a = roster.iter().find(|e| e.name == "agent-a").unwrap();
        let mut used = UsedSlots::new();
        let out = assemble_agent(dir.path(), "claude", agent_a, &mut used).unwrap();
        // description line = JSON.stringify escaping inside YAML frontmatter
        let expected = concat!(
            "---\n",
            "name: agent-a\n",
            "description: \"Desc with \\\"quotes\\\" and \\\\ backslash 中🚀\"\n",
            "tools: Read\n",
            "---\n\n",
            // fill THEN trim: leading "  " and trailing "  \n\n" go
            "Preamble Be kind..\n  more",
            // disciplinesBlock: "\n\n" + trailing-ws-stripped file
            "\n\nRule one.\nRule two."
        );
        assert_eq!(out, expected);
        assert_eq!(out, out.trim_end()); // no trailing newline
    }

    #[test]
    fn assemble_agent_missing_agent_or_backend_is_the_cli_error() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        let roster = load_roster(dir.path()).unwrap();
        let mut used = UsedSlots::new();
        let ghost = crate::roster::AgentEntry {
            name: "ghost".to_string(),
            description: String::new(),
            record: serde_json::Value::Null,
        };
        let err = assemble_agent(dir.path(), "claude", &ghost, &mut used).unwrap_err();
        assert_eq!(err.to_string(), "agents/backends metadata is missing agent 'ghost'");
        // agent-b has no claude frontmatter → absent from the backend's map
        let agent_b = roster.iter().find(|e| e.name == "agent-b").unwrap();
        let err = assemble_agent(dir.path(), "claude", agent_b, &mut used).unwrap_err();
        assert_eq!(err.to_string(), "agents/backends metadata is missing agent 'agent-b'");
    }

    #[test]
    fn assemble_agent_missing_prompt_file_is_the_cli_error() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "agents/roster.json",
            r#"{ "agents": { "x": { "description": "d", "frontmatter": { "claude": ["a"] } } } }"#,
        );
        let roster = load_roster(dir.path()).unwrap();
        let mut used = UsedSlots::new();
        let err = assemble_agent(dir.path(), "claude", &roster[0], &mut used).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/prompts/x.md is missing (referenced by a backend template)"
        );
    }

    #[test]
    fn disciplines_block_strips_trailing_whitespace_and_errors_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = disciplines_block(dir.path()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/disciplines.md is missing (the universal disciplines every agent prompt carries)"
        );
        write(dir.path(), "agents/disciplines.md", "A\nB\n\n\n  \n");
        assert_eq!(disciplines_block(dir.path()).unwrap(), "\n\nA\nB");
    }

    // ------------------------------------------------------ agentPromptBody

    #[test]
    fn agent_prompt_body_trims_then_appends_then_fills() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        let mut used = UsedSlots::new();
        let out = agent_prompt_body(dir.path(), "claude", "agent-a", &mut used).unwrap();
        // trim(strip(prompt)) + "\n\n" + trimmed disciplines, THEN slot fill
        assert_eq!(out, "Preamble Be kind..\n  more\n\nRule one.\nRule two.");
    }

    // ---------------------------------------------------------- fillPrompts

    #[test]
    fn fill_prompts_indentation_protocol() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        let template = "agent:\n      {{prompt:agent-a}}\nnext: 1\n";
        let mut used = UsedSlots::new();
        let out = fill_prompts(dir.path(), template, "claude", &mut used).unwrap();
        // body = trim(strip(prompt)) + disciplines = "Preamble {{slot:tone}}.\n  more\n\nRule one.\nRule two."
        // filled → "Preamble Be kind..\n  more\n\nRule one.\nRule two."
        // first line NOT padded (inherits the column), later non-blank lines get 6 spaces,
        // blank lines stay truly empty
        assert_eq!(
            out,
            "agent:\n      Preamble Be kind..\n        more\n\n      Rule one.\n      Rule two.\nnext: 1\n"
        );
    }

    #[test]
    fn fill_prompts_placeholder_must_stand_alone() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        let mut used = UsedSlots::new();
        for template in [
            "text {{prompt:agent-a}} more",
            "  {{prompt:agent-a}} # trailing comment",
            "pre {{prompt:agent-a}}",
        ] {
            let err = fill_prompts(dir.path(), template, "claude", &mut used).unwrap_err();
            assert_eq!(
                err.to_string(),
                "{{prompt:agent-a}} must stand alone on its own line in agents/backends/claude/"
            );
        }
    }

    #[test]
    fn fill_prompts_edge_positions() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        let mut used = UsedSlots::new();
        // first line of the file, no leading newline
        let out = fill_prompts(dir.path(), "{{prompt:agent-a}}", "claude", &mut used).unwrap();
        assert_eq!(out, "Preamble Be kind..\n  more\n\nRule one.\nRule two.");
        // no trailing newline after the placeholder line
        let out = fill_prompts(dir.path(), "k:\n  {{prompt:agent-a}}", "claude", &mut used).unwrap();
        assert_eq!(
            out,
            "k:\n  Preamble Be kind..\n    more\n\n  Rule one.\n  Rule two."
        );
        // tab indentation pads with SPACES, as JS `" ".repeat` does
        let out = fill_prompts(dir.path(), "k:\n\t{{prompt:agent-a}}", "claude", &mut used).unwrap();
        assert_eq!(
            out,
            "k:\n\tPreamble Be kind..\n   more\n\n Rule one.\n Rule two."
        );
    }

    #[test]
    fn fill_prompts_errors_propagate_with_cli_messages() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        let mut used = UsedSlots::new();
        // prompt file missing
        let err = fill_prompts(dir.path(), "{{prompt:nope}}", "claude", &mut used).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/prompts/nope.md is missing (referenced by a backend template)"
        );
        // slot missing inside the prompt body
        write(dir.path(), "agents/prompts/ghost-slot.md", "x {{slot:missing}}");
        let err = fill_prompts(dir.path(), "{{prompt:ghost-slot}}", "claude", &mut used).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/backends/claude/slots/ is missing slot 'missing' (referenced by agents/prompts/)"
        );
    }

    // ------------------------------------------------- renderDshComposition

    #[test]
    fn render_dsh_composition_happy_path_and_leftover_errors() {
        let dir = tempfile::tempdir().unwrap();
        assemble_fixture(&dir);
        write(dir.path(), "agents/backends/dsh/slots/tone.md", "Be kind.");
        write(
            dir.path(),
            "agents/backends/dsh/agent.cordis.yml",
            "persona: |\n      {{prompt:agent-a}}\nother: 1\n",
        );
        let out = render_dsh_composition(dir.path()).unwrap();
        assert_eq!(
            out,
            "persona: |\n      Preamble Be kind..\n        more\n\n      Rule one.\n      Rule two.\nother: 1\n"
        );

        // a slot VALUE carrying a prompt placeholder survives its own fill and
        // trips the leftover check — replacements are never rescanned
        write(
            dir.path(),
            "agents/backends/dsh/slots/tone.md",
            "text {{prompt:ghost}} end",
        );
        let err = render_dsh_composition(dir.path()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/backends/dsh/agent.cordis.yml left '{{prompt:ghost}}' unfilled"
        );

        write(dir.path(), "agents/backends/dsh/slots/tone.md", "{{slot:other}} x");
        let err = render_dsh_composition(dir.path()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/backends/dsh/agent.cordis.yml left '{{slot:other}}' unfilled"
        );
    }

    // ---------------------------------------------------- renderLanePrompts

    fn lanes_fixture_json() -> &'static str {
        r#"[
  { "key": "explorer", "tool": "subagent_explorer", "zh": "代码库导航", "denyWrites": true, "denyShell": false,
    "recommended": { "provider": "deepseek-official", "model": "deepseek-v4-flash", "reasoningEffort": "low" } },
  { "key": "observer", "tool": "subagent_observer", "zh": "视觉 \"分析\" 🚀", "denyWrites": true, "denyShell": true,
    "recommended": { "provider": "deepseek-official", "model": "deepseek-v4-flash-vision-exp", "reasoningEffort": "low" } }
]"#
    }

    fn lanes_fixture() -> Vec<LaneRecord> {
        serde_json::from_str(lanes_fixture_json()).unwrap()
    }

    #[test]
    fn render_lane_prompts_is_the_exact_js_template() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "agents/disciplines.md", "Rule one.\nRule two.\n");
        write(dir.path(), "agents/backends/dsh/slots/tone.md", "calm");
        write(
            dir.path(),
            "agents/prompts/explorer.md",
            &format!(
                "{ATTRIBUTION_NOTICE}\n\nMap the code.\nQuote: \" and \\\n{{{{slot:tone}}}}\n"
            ),
        );
        write(dir.path(), "agents/prompts/observer.md", "Watch\ttabs\n");
        let lanes = lanes_fixture();
        let out = render_lane_prompts(dir.path(), &lanes).unwrap();
        // each body: trim(strip(prompt)) + disciplines, slot-filled, then
        // JSON.stringify'd; hand-computed JSON text on the right. The body's
        // trailing backslash doubles in JSON and the newline after it escapes
        // separately — `\\` + `\n`.
        let expected = concat!(
            "export const LANE_PROMPTS = {\n",
            "  \"explorer\": \"Map the code.\\nQuote: \\\" and \\\\\\ncalm\\n\\nRule one.\\nRule two.\",\n",
            "  \"observer\": \"Watch\\ttabs\\n\\nRule one.\\nRule two.\"\n",
            "}\n\nexport default LANE_PROMPTS\n",
        );
        assert_eq!(out, expected);
    }

    #[test]
    fn render_lane_prompts_requires_lane_prompt_files() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "agents/roster.json", r#"{ "agents": {} }"#);
        let lanes = lanes_fixture();
        let err = render_lane_prompts(dir.path(), &lanes).unwrap_err();
        assert_eq!(
            err.to_string(),
            "agents/prompts/explorer.md is missing (referenced by a backend template)"
        );
    }

    // ---------------------------------------------------- laneRosterSource

    #[test]
    fn lane_roster_source_is_the_exact_js_pretty_json() {
        let lanes = lanes_fixture();
        let out = lane_roster_source(&lanes);
        let expected = concat!(
            "export const LANES = [\n",
            "  {\n",
            "    \"key\": \"explorer\",\n",
            "    \"tool\": \"subagent_explorer\",\n",
            "    \"denyWrites\": true,\n",
            "    \"denyShell\": false,\n",
            "    \"recommended\": {\n",
            "      \"provider\": \"deepseek-official\",\n",
            "      \"model\": \"deepseek-v4-flash\",\n",
            "      \"reasoningEffort\": \"low\"\n",
            "    }\n",
            "  },\n",
            "  {\n",
            "    \"key\": \"observer\",\n",
            "    \"tool\": \"subagent_observer\",\n",
            "    \"denyWrites\": true,\n",
            "    \"denyShell\": true,\n",
            "    \"recommended\": {\n",
            "      \"provider\": \"deepseek-official\",\n",
            "      \"model\": \"deepseek-v4-flash-vision-exp\",\n",
            "      \"reasoningEffort\": \"low\"\n",
            "    }\n",
            "  }\n",
            "]\n",
        );
        assert_eq!(out, expected);
        // zh is dropped (host-only fields)
        assert!(!out.contains("代码库导航"));
    }

    // ------------------------------------------------------ renderLaneHost

    fn host_template(dir: &tempfile::TempDir, body: &str) {
        write(dir.path(), "agents/backends/dsh/lane-plugin/host-package/src/index.js", body);
    }

    fn bare_deps() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("dsh-tools".to_string(), "@deepseek-ai/dsh-tools".to_string()),
            ("schemastery".to_string(), "@deepseek-ai/schemastery".to_string()),
        ])
    }

    #[test]
    fn render_lane_host_fills_both_directions() {
        let dir = tempfile::tempdir().unwrap();
        host_template(
            &dir,
            "import { defineTool } from '{{dep:dsh-tools}}'\nimport z from '{{dep:schemastery}}'\n",
        );
        let out = render_lane_host(dir.path(), &bare_deps()).unwrap();
        assert_eq!(
            out,
            "import { defineTool } from '@deepseek-ai/dsh-tools'\nimport z from '@deepseek-ai/schemastery'\n"
        );
        // file: URL values pass through untouched
        host_template(&dir, "a '{{dep:dsh-tools}}' b '{{dep:schemastery}}'");
        let file_deps = BTreeMap::from([
            ("dsh-tools".to_string(), "file:///C:/x/dsh-tools".to_string()),
            ("schemastery".to_string(), "file:///C:/x/schemastery".to_string()),
        ]);
        assert_eq!(
            render_lane_host(dir.path(), &file_deps).unwrap(),
            "a 'file:///C:/x/dsh-tools' b 'file:///C:/x/schemastery'"
        );
    }

    #[test]
    fn render_lane_host_unknown_alias_and_never_imported_errors() {
        let dir = tempfile::tempdir().unwrap();
        host_template(&dir, "import x from '{{dep:typo-name}}'\nimport z from '{{dep:schemastery}}'");
        let err = render_lane_host(dir.path(), &bare_deps()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "unknown dependency alias '{{dep:typo-name}}' in the lane plugin host module (known: dsh-tools, schemastery)"
        );
        // template uses only one of the two declared aliases
        host_template(&dir, "import { defineTool } from '{{dep:dsh-tools}}'");
        let err = render_lane_host(dir.path(), &bare_deps()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "the lane plugin host module never imports 'schemastery'; expected a '{{dep:schemastery}}' placeholder"
        );
        // a {{dep:…}}-looking but malformed fragment is left alone
        host_template(
            &dir,
            "import { defineTool } from '{{dep:dsh-tools}}'\nimport z from '{{dep:schemastery}}'\nkeep {{dep:}} here",
        );
        let out = render_lane_host(dir.path(), &bare_deps()).unwrap();
        assert!(out.contains("keep {{dep:}} here"));
    }

    #[test]
    fn render_lane_host_leftover_generic_placeholder_errors() {
        let dir = tempfile::tempdir().unwrap();
        host_template(
            &dir,
            "import { defineTool } from '{{dep:dsh-tools}}'\nimport z from '{{dep:schemastery}}'\n// {{some:thing}}",
        );
        let err = render_lane_host(dir.path(), &bare_deps()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "the lane plugin host module left '{{some:thing}}' unfilled"
        );
        // value class includes @ / . and - ; the NAME class does not, so
        // {{a/b:…}} is not a match (in JS either) and must not error…
        host_template(
            &dir,
            "import { defineTool } from '{{dep:dsh-tools}}'\nimport z from '{{dep:schemastery}}'\nkeep {{a/b:c.d-e}} here",
        );
        let out = render_lane_host(dir.path(), &bare_deps()).unwrap();
        assert!(out.contains("keep {{a/b:c.d-e}} here"));
        // …while a full name:value placeholder does match
        host_template(
            &dir,
            "import { defineTool } from '{{dep:dsh-tools}}'\nimport z from '{{dep:schemastery}}'\n// {{a:c.d-e@/x}} ok?",
        );
        let err = render_lane_host(dir.path(), &bare_deps()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "the lane plugin host module left '{{a:c.d-e@/x}}' unfilled"
        );
    }

    // --------------------------------------------------- laneUiClientSource

    #[test]
    fn lane_ui_client_source_replaces_the_single_marker() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/lib/client.js",
            "const LANES = \"__MY_WORKBENCH_LANES__\"\nregister(LANES)\n",
        );
        let out = lane_ui_client_source(dir.path(), &lanes_fixture()).unwrap();
        assert_eq!(
            out,
            concat!(
                "const LANES = [{\"key\":\"explorer\",\"zh\":\"代码库导航\"},",
                "{\"key\":\"observer\",\"zh\":\"视觉 \\\"分析\\\" 🚀\"}]\nregister(LANES)\n"
            )
        );
    }

    #[test]
    fn lane_ui_client_source_requires_exactly_one_marker() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "agents/backends/dsh/lane-plugin-ui/lib/client.js", "none");
        let err = lane_ui_client_source(dir.path(), &lanes_fixture()).unwrap_err();
        assert_eq!(err.to_string(), "lane UI must contain exactly one roster marker");
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/lib/client.js",
            "\"__MY_WORKBENCH_LANES__\" and \"__MY_WORKBENCH_LANES__\"",
        );
        let err = lane_ui_client_source(dir.path(), &lanes_fixture()).unwrap_err();
        assert_eq!(err.to_string(), "lane UI must contain exactly one roster marker");
    }

    // --------------------------------------------------------- real-tree smoke

    #[test]
    fn real_source_tree_renders_clean() {
        let root = repo_root();
        let roster = load_roster(&root).expect("roster loads");
        assert!(roster.len() >= 8, "expected the full roster");
        let lanes: Vec<LaneRecord> =
            serde_json::from_str(&std::fs::read_to_string(root.join("agents/backends/dsh/lanes.json")).unwrap())
                .expect("lanes parse");
        render_dsh_composition(&root).expect("dsh composition renders");
        render_lane_prompts(&root, &lanes).expect("lane prompts render");
        render_lane_host(&root, &bare_deps()).expect("lane host renders");
        lane_ui_client_source(&root, &lanes).expect("client source renders");
    }
}
