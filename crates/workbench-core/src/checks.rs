//! Structural source checks — Tier 1 of the health check, pure Rust (PLAN.md
//! §4). Ports of `bin/my-workbench.js`:
//!
//! - [`agent_source_problems`] — `agentSourceProblems` (:526-557)
//! - [`lane_plugin_problems`] — `lanePluginProblems` (:828-850)
//! - [`lane_ui_plugin_problems`] — `laneUiPluginProblems` (:874-928)
//!
//! The JS originals throw when a checked file cannot be read at all; these
//! ports turn that into a problem entry (the check must be total — it feeds a
//! GUI status page, not a crash). Messages for all *listed* problems are
//! byte-identical to the CLI's.

use crate::render::{js_trim, lane_ui_client_source, skip_js_ws_from};
use crate::types::LaneRecord;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// The ONLY bare specifiers a client bundle may `require` (:132-142) — the
/// browser shell builds a frozen module table with exactly these entries.
pub(crate) const CLIENT_SEED_MODULES: [&str; 9] = [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-dockkit",
];

// ------------------------------------------------------- agentSourceProblems

/// Orphan prompts and missing reference translations are source errors
/// (:526-557). `prompts_cn` is checked ONLY when the directory exists —
/// bundled resources may lack it, and that is never an error.
pub fn agent_source_problems(source_root: &Path) -> Vec<String> {
    let mut problems = Vec::new();
    let roster = match crate::roster::load_roster(source_root) {
        Ok(roster) => roster,
        Err(e) => {
            problems.push(format!("agents/roster.json could not be read: {e}"));
            return problems;
        }
    };
    let names: HashSet<&str> = roster.iter().map(|entry| entry.name.as_str()).collect();

    for entry in &roster {
        if js_trim(&entry.description).is_empty() {
            problems.push(format!("agent '{}' has no description", entry.name));
        }
        for backend in ["claude", "opencode", "zcode", "openbitfun"] {
            let lines = entry.record.get("frontmatter").and_then(|f| f.get(backend));
            // ZCode uses AGENTS.md as its main agent.
            if entry.name == "orchestrator" && backend == "zcode" && lines.is_none() {
                continue;
            }
            let description_lines = lines
                .and_then(Value::as_array)
                .map_or(0, |a| a.iter().filter(|l| l.as_str() == Some("@description")).count());
            if description_lines != 1 {
                problems.push(format!("agent '{}' has invalid {backend} frontmatter", entry.name));
            }
        }
    }

    let prompt_dir = source_root.join("agents").join("prompts");
    match std::fs::read_dir(&prompt_dir) {
        Err(e) => problems.push(format!("agents/prompts could not be read: {e}")),
        Ok(entries) => {
            let mut files: Vec<String> = entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|f| f.ends_with(".md"))
                .collect();
            files.sort();
            for file in &files {
                let name = &file[..file.len() - 3];
                if !names.contains(name) {
                    problems.push(format!("agents/prompts/{file} has no agent record"));
                }
            }
        }
    }
    for entry in &roster {
        if !prompt_dir.join(format!("{}.md", entry.name)).exists() {
            problems.push(format!("agent '{}' has no prompt body", entry.name));
        }
    }

    // Reference translations are absent from the npm tarball, so check pairs
    // only when the directory is there at all.
    let cn_dir = source_root.join("agents").join("prompts_cn");
    if cn_dir.exists() {
        for entry in &roster {
            if !cn_dir.join(format!("{}_cn.md", entry.name)).exists() {
                problems.push(format!(
                    "agent '{}' has no Chinese reference translation",
                    entry.name
                ));
            }
        }
        match std::fs::read_dir(&cn_dir) {
            Err(e) => problems.push(format!("agents/prompts_cn could not be read: {e}")),
            Ok(entries) => {
                let mut files: Vec<String> = entries
                    .filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|f| f.ends_with("_cn.md"))
                    .collect();
                files.sort();
                for file in &files {
                    let name = &file[..file.len() - 6];
                    if !names.contains(name) {
                        problems.push(format!("agents/prompts_cn/{file} has no agent record"));
                    }
                }
            }
        }
    }
    problems
}

// --------------------------------------------------------- lanePluginProblems

fn read_json(path: &Path) -> Result<Value, crate::WorkbenchError> {
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

/// Parse `agents/backends/dsh/lanes.json` (field names mirror the JSON).
fn load_lanes(source_root: &Path) -> Result<Vec<LaneRecord>, crate::WorkbenchError> {
    let raw = std::fs::read_to_string(
        source_root
            .join("agents")
            .join("backends")
            .join("dsh")
            .join("lanes.json"),
    )?;
    Ok(serde_json::from_str(&raw)?)
}

/// Structural validation of the lane plugin that needs neither a DSH home nor
/// a browser (:828-850): the authored lane keys must refer to agents, and the
/// host package's export targets and generated roster import must exist.
pub fn lane_plugin_problems(source_root: &Path) -> Vec<String> {
    let mut problems = Vec::new();
    let host_pkg = source_root
        .join("agents")
        .join("backends")
        .join("dsh")
        .join("lane-plugin")
        .join("host-package");

    let manifest = match read_json(&host_pkg.join("package.json")) {
        Ok(manifest) => manifest,
        Err(e) => {
            problems.push(format!(
                "agents/backends/dsh/lane-plugin/host-package/package.json could not be read: {e}"
            ));
            return problems;
        }
    };
    let empty = serde_json::Map::new();
    let exports = manifest.get("exports").and_then(Value::as_object).unwrap_or(&empty);
    for (key, target) in exports {
        let Some(target) = target.as_str() else { continue };
        if !host_pkg.join(target).exists() {
            problems.push(format!(
                "host-package/package.json exports '{key}' -> '{target}', which does not exist"
            ));
        }
    }
    // `manifest.dsh !== undefined` — even an explicit null is a violation.
    if manifest.get("dsh").is_some() {
        problems.push(
            "host-package/package.json declares a dsh.client half; the client lives in lane-plugin-ui/ now, and a preset row's client half is never scanned"
                .to_string(),
        );
    }

    let lanes = match load_lanes(source_root) {
        Ok(lanes) => lanes,
        Err(e) => {
            problems.push(format!("agents/backends/dsh/lanes.json could not be read: {e}"));
            return problems;
        }
    };
    match crate::roster::load_roster(source_root) {
        Ok(roster) => {
            let names: HashSet<&str> = roster.iter().map(|entry| entry.name.as_str()).collect();
            for lane in &lanes {
                if !names.contains(lane.key.as_str()) {
                    problems.push(format!("lane '{}' has no agent record", lane.key));
                }
            }
        }
        Err(e) => problems.push(format!("agents/roster.json could not be read: {e}")),
    }

    match std::fs::read_to_string(host_pkg.join("src").join("index.js")) {
        Ok(host) => {
            if !host.contains("from './roster.generated.js'") {
                problems.push("host module does not import the rendered roster".to_string());
            }
        }
        Err(e) => problems.push(format!("the lane plugin host module could not be read: {e}")),
    }
    problems
}

// ------------------------------------------------------- laneUiPluginProblems

/// `JSON.stringify(v)` for problem messages; a missing key stringifies as
/// bare `undefined`, as in JS.
fn json_label(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "undefined".to_string()),
    }
}

/// `${v}` (template-literal coercion) for problem messages.
fn template_label(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(_) => "[object Object]".to_string(),
    }
}

fn is_js_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `/\bfactory\s*:/` — does the bundle declare a factory anywhere?
fn has_factory_pattern(bundle: &str) -> bool {
    let bytes = bundle.as_bytes();
    let mut i = 0usize;
    while let Some(at) = bundle[i..].find("factory") {
        let start = i + at;
        // \b: an ASCII word char must not precede the match
        if (start == 0 || !is_js_word_byte(bytes[start - 1])) && {
            let j = skip_js_ws_from(bundle, start + "factory".len());
            bytes.get(j) == Some(&b':')
        } {
            return true;
        }
        i = start + 1;
    }
    false
}

/// `/id:\s*['"]([^'"]+)['"]/` — the first module id declaration.
fn find_module_id(bundle: &str) -> Option<String> {
    let bytes = bundle.as_bytes();
    let mut i = 0usize;
    while let Some(at) = bundle[i..].find("id:") {
        let start = i + at;
        let j = skip_js_ws_from(bundle, start + 3);
        if matches!(bytes.get(j), Some(b'\'') | Some(b'"')) {
            let mut k = j + 1;
            while k < bytes.len() && bytes[k] != b'\'' && bytes[k] != b'"' {
                k += 1;
            }
            if k < bytes.len() && k > j + 1 {
                return Some(bundle[j + 1..k].to_string());
            }
        }
        i = start + 1;
    }
    None
}

/// `/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g` — every require's specifier.
fn find_requires(bundle: &str) -> Vec<String> {
    let bytes = bundle.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(at) = bundle[i..].find("require") {
        let start = i + at;
        let mut matched_end = None;
        if (start == 0 || !is_js_word_byte(bytes[start - 1]))
            && bytes.get(start + "require".len()) == Some(&b'(')
        {
            let j = skip_js_ws_from(bundle, start + "require".len() + 1);
            if matches!(bytes.get(j), Some(b'\'') | Some(b'"')) {
                let mut k = j + 1;
                while k < bytes.len() && bytes[k] != b'\'' && bytes[k] != b'"' {
                    k += 1;
                }
                if k < bytes.len() && k > j + 1 {
                    let spec = bundle[j + 1..k].to_string();
                    let m = skip_js_ws_from(bundle, k + 1);
                    if bytes.get(m) == Some(&b')') {
                        matched_end = Some((spec, m + 1));
                    }
                }
            }
        }
        match matched_end {
            Some((spec, end)) => {
                out.push(spec);
                i = end;
            }
            None => i = start + 1,
        }
    }
    out
}

/// Structural validation of the lane settings page (:874-928). This is the
/// package that reaches the browser, so the checks are the ones whose failure
/// would only show up in a running GUI: the `dsh-client-modules` declaration,
/// the export it resolves, the classic-script registration seam, a module id
/// that matches the package name, and a `require` list inside the shell's seed
/// table.
pub fn lane_ui_plugin_problems(source_root: &Path) -> Vec<String> {
    let mut problems = Vec::new();
    let ui_src = source_root
        .join("agents")
        .join("backends")
        .join("dsh")
        .join("lane-plugin-ui");
    let manifest = match read_json(&ui_src.join("package.json")) {
        Ok(manifest) => manifest,
        Err(e) => {
            problems.push(format!(
                "agents/backends/dsh/lane-plugin-ui/package.json could not be read: {e}"
            ));
            return problems;
        }
    };

    // dsh-client-modules reads exactly this pair, and throws on a declaration
    // whose "./client" export is missing.
    let client = match manifest.get("dsh") {
        Some(Value::Object(map)) => map.get("client"),
        _ => None,
    };
    if !matches!(client, Some(Value::Object(_))) {
        problems.push(
            "lane-plugin-ui/package.json declares no dsh.client, so the page would never be scanned"
                .to_string(),
        );
    } else {
        let platform = client.and_then(|c| c.get("platform"));
        if platform.and_then(Value::as_str) != Some("web") {
            problems.push(format!(
                "lane-plugin-ui/package.json dsh.client.platform is {}, not \"web\"",
                json_label(platform)
            ));
        }
    }

    let empty = serde_json::Map::new();
    let exports = manifest.get("exports").and_then(Value::as_object).unwrap_or(&empty);
    let client_target = exports.get("./client");
    match client_target.and_then(Value::as_str) {
        Some(target) => {
            if !ui_src.join(target).exists() {
                problems.push(format!(
                    "lane-plugin-ui/package.json exports './client' -> '{target}', which does not exist"
                ));
            } else if target != "./lib/client.js" {
                problems.push(format!(
                    "lane-plugin-ui/package.json exports './client' -> '{target}', but the rendered page installs as './lib/client.js'"
                ));
            }
        }
        None => problems.push(
            "lane-plugin-ui/package.json exports no './client', so dsh-client-modules would refuse the package"
                .to_string(),
        ),
    }
    let host_target = exports.get(".");
    let host_ok = match host_target.and_then(Value::as_str) {
        Some(target) => ui_src.join(target).exists(),
        None => false,
    };
    if !host_ok {
        problems.push(format!(
            "lane-plugin-ui/package.json exports '.' -> {}, which does not exist",
            json_label(host_target)
        ));
    }

    if client_target.and_then(Value::as_str).is_none() {
        return problems;
    }
    let lanes = match load_lanes(source_root) {
        Ok(lanes) => lanes,
        Err(e) => {
            problems.push(format!("agents/backends/dsh/lanes.json could not be read: {e}"));
            return problems;
        }
    };
    let bundle = match lane_ui_client_source(source_root, &lanes) {
        Ok(bundle) => bundle,
        Err(e) => {
            problems.push(e.to_string());
            return problems;
        }
    };

    // The only registration seam the browser module table accepts.
    if !bundle.contains("window.__ModuleLoader__.load(") {
        problems.push(
            "lane-plugin-ui/lib/client.js does not register through window.__ModuleLoader__.load(...)"
                .to_string(),
        );
    }
    if !has_factory_pattern(&bundle) {
        problems.push(
            "lane-plugin-ui/lib/client.js declares no factory, so the module table cannot materialize it"
                .to_string(),
        );
    }

    // The bundle registers under the name the module table keys it by.
    match find_module_id(&bundle) {
        None => problems.push(
            "lane-plugin-ui/lib/client.js does not declare a module id".to_string(),
        ),
        Some(id) => {
            let package_name = template_label(manifest.get("name"));
            if id != package_name {
                problems.push(format!(
                    "lane-plugin-ui/lib/client.js registers id '{id}' but the package is named '{package_name}'"
                ));
            }
        }
    }

    // Only the nine seed specifiers resolve in the browser module table.
    for spec in find_requires(&bundle) {
        if !CLIENT_SEED_MODULES.contains(&spec.as_str()) {
            problems.push(format!(
                "lane-plugin-ui/lib/client.js requires '{spec}', which is not one of the browser shell's {} seed modules (it would fail at runtime with \"missed the module table\")",
                CLIENT_SEED_MODULES.len()
            ));
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// A fully valid synthetic source tree; individual tests mutate one thing.
    fn valid_tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "agents/roster.json",
            r#"{
  "agents": {
    "orchestrator": {
      "description": "The orchestrator.",
      "frontmatter": {
        "claude": ["name: orchestrator", "@description"],
        "opencode": ["@description"],
        "openbitfun": ["@description"]
      }
    },
    "explorer": {
      "description": "Explores.",
      "frontmatter": {
        "claude": ["name: explorer", "@description"],
        "opencode": ["@description"],
        "zcode": ["name: explorer", "@description"],
        "openbitfun": ["@description"]
      }
    }
  }
}"#,
        );
        write(dir.path(), "agents/prompts/orchestrator.md", "Orchestrate.\n");
        write(dir.path(), "agents/prompts/explorer.md", "Explore.\n");
        write(dir.path(), "agents/prompts_cn/orchestrator_cn.md", "编排。\n");
        write(dir.path(), "agents/prompts_cn/explorer_cn.md", "探索。\n");
        write(
            dir.path(),
            "agents/backends/dsh/lanes.json",
            r#"[{ "key": "explorer", "tool": "subagent_explorer", "zh": "探索", "denyWrites": true, "denyShell": false, "recommended": { "provider": "p", "model": "m", "reasoningEffort": "low" } }]"#,
        );
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin/host-package/package.json",
            r#"{ "name": "@wb/lane-plugin", "exports": { ".": "src/index.js", "./roster.generated": "./src/roster.generated.js" } }"#,
        );
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin/host-package/src/index.js",
            "import { LANES } from './roster.generated.js'\nexport { LANES }\n",
        );
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin/host-package/src/roster.generated.js",
            "export const LANES = []\n",
        );
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/package.json",
            r#"{ "name": "@wb/lane-ui", "dsh": { "client": { "platform": "web" } }, "exports": { ".": "lib/host.js", "./client": "./lib/client.js" } }"#,
        );
        write(dir.path(), "agents/backends/dsh/lane-plugin-ui/lib/host.js", "export const name = '@wb/lane-ui'\nexport const inject = []\n");
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/lib/client.js",
            concat!(
                "const LANES = \"__MY_WORKBENCH_LANES__\"\n",
                "window.__ModuleLoader__.load('@wb/lane-ui', {\n",
                "  id: '@wb/lane-ui',\n",
                "  require('react'),\n",
                "  factory: (React) => ({ LANES })\n",
                "})\n",
            ),
        );
        dir
    }

    #[test]
    fn valid_tree_has_no_problems() {
        let dir = valid_tree();
        assert_eq!(agent_source_problems(dir.path()), Vec::<String>::new());
        assert_eq!(lane_plugin_problems(dir.path()), Vec::<String>::new());
        assert_eq!(lane_ui_plugin_problems(dir.path()), Vec::<String>::new());
    }

    // ---------------------------------------------- agentSourceProblems

    #[test]
    fn flags_missing_description_and_bad_frontmatter() {
        let dir = valid_tree();
        write(
            dir.path(),
            "agents/roster.json",
            r#"{
  "agents": {
    "orchestrator": {
      "description": "  ",
      "frontmatter": {
        "claude": ["name: orchestrator", "@description", "@description"],
        "opencode": ["@description"],
        "openbitfun": "@description"
      }
    },
    "explorer": {
      "description": "Explores.",
      "frontmatter": {
        "claude": ["name: explorer", "@description"],
        "opencode": ["@description"],
        "zcode": ["no marker here"],
        "openbitfun": ["@description"]
      }
    }
  }
}"#,
        );
        let problems = agent_source_problems(dir.path());
        assert!(problems.contains(&"agent 'orchestrator' has no description".to_string()), "{problems:?}");
        assert!(problems.contains(&"agent 'orchestrator' has invalid claude frontmatter".to_string()), "{problems:?}");
        assert!(problems.contains(&"agent 'orchestrator' has invalid openbitfun frontmatter".to_string()), "{problems:?}");
        assert!(problems.contains(&"agent 'explorer' has invalid zcode frontmatter".to_string()), "{problems:?}");
        // non-array frontmatter (openbitfun: string) counts as invalid exactly once
        assert_eq!(problems.iter().filter(|p| p.contains("openbitfun frontmatter")).count(), 1);
    }

    #[test]
    fn orchestrator_may_omit_zcode_but_nothing_else() {
        let dir = valid_tree();
        // valid_tree's orchestrator has no zcode frontmatter and passes
        assert!(!agent_source_problems(dir.path()).iter().any(|p| p.contains("orchestrator")));
        // removing opencode IS flagged
        write(
            dir.path(),
            "agents/roster.json",
            r#"{
  "agents": {
    "orchestrator": {
      "description": "d",
      "frontmatter": { "claude": ["@description"], "openbitfun": ["@description"] }
    }
  }
}"#,
        );
        let problems = agent_source_problems(dir.path());
        assert!(problems.contains(&"agent 'orchestrator' has invalid opencode frontmatter".to_string()), "{problems:?}");
    }

    #[test]
    fn orphan_prompts_and_missing_bodies_both_directions() {
        let dir = valid_tree();
        write(dir.path(), "agents/prompts/orphan.md", "nobody references me\n");
        fs::remove_file(dir.path().join("agents/prompts/explorer.md")).unwrap();
        let problems = agent_source_problems(dir.path());
        assert!(problems.contains(&"agents/prompts/orphan.md has no agent record".to_string()), "{problems:?}");
        assert!(problems.contains(&"agent 'explorer' has no prompt body".to_string()), "{problems:?}");
    }

    #[test]
    fn prompts_cn_checked_only_when_present() {
        let dir = valid_tree();
        // directory absent: no Chinese checks at all
        fs::remove_dir_all(dir.path().join("agents/prompts_cn")).unwrap();
        assert!(!agent_source_problems(dir.path()).iter().any(|p| p.contains("Chinese")));
        // directory present again, but the orchestrator pair is missing
        write(dir.path(), "agents/prompts_cn/ghost_cn.md", "orphan\n");
        write(dir.path(), "agents/prompts_cn/explorer_cn.md", "探索。\n");
        let problems = agent_source_problems(dir.path());
        assert!(problems.contains(&"agent 'orchestrator' has no Chinese reference translation".to_string()), "{problems:?}");
        assert!(problems.contains(&"agents/prompts_cn/ghost_cn.md has no agent record".to_string()), "{problems:?}");
        // explorer still has its pair and is not flagged
        assert!(!problems.iter().any(|p| p.contains("agent 'explorer' has no Chinese")), "{problems:?}");
    }

    #[test]
    fn unreadable_roster_becomes_a_problem_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let problems = agent_source_problems(dir.path());
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("agents/roster.json could not be read:"), "{problems:?}");
    }

    // ------------------------------------------------ lanePluginProblems

    #[test]
    fn lane_plugin_checks_exports_dsh_lane_keys_and_roster_import() {
        let dir = valid_tree();
        // export target missing
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin/host-package/package.json",
            r#"{ "name": "@wb/lane-plugin", "exports": { ".": "src/index.js", "./missing": "src/gone.js", "obj": { "import": "./x.js" } } }"#,
        );
        // lane key without an agent record
        write(
            dir.path(),
            "agents/backends/dsh/lanes.json",
            r#"[{ "key": "ghost", "tool": "subagent_ghost", "zh": "x", "denyWrites": true, "denyShell": false, "recommended": { "provider": "p", "model": "m", "reasoningEffort": "low" } }]"#,
        );
        // roster import missing
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin/host-package/src/index.js",
            "import { something } from './elsewhere.js'\n",
        );
        let problems = lane_plugin_problems(dir.path());
        assert!(problems.contains(&"host-package/package.json exports './missing' -> 'src/gone.js', which does not exist".to_string()), "{problems:?}");
        assert!(problems.contains(&"lane 'ghost' has no agent record".to_string()), "{problems:?}");
        assert!(problems.contains(&"host module does not import the rendered roster".to_string()), "{problems:?}");
        assert_eq!(problems.len(), 3, "{problems:?}");
    }

    #[test]
    fn lane_plugin_rejects_any_dsh_declaration_including_null() {
        let dir = valid_tree();
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin/host-package/package.json",
            r#"{ "name": "@wb/lane-plugin", "dsh": null, "exports": { ".": "src/index.js" } }"#,
        );
        let problems = lane_plugin_problems(dir.path());
        assert!(problems.contains(&"host-package/package.json declares a dsh.client half; the client lives in lane-plugin-ui/ now, and a preset row's client half is never scanned".to_string()), "{problems:?}");
    }

    #[test]
    fn lane_plugin_unreadable_manifest_is_a_problem() {
        let dir = valid_tree();
        fs::remove_file(dir.path().join("agents/backends/dsh/lane-plugin/host-package/package.json")).unwrap();
        let problems = lane_plugin_problems(dir.path());
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("agents/backends/dsh/lane-plugin/host-package/package.json could not be read:"), "{problems:?}");
    }

    // ---------------------------------------------- laneUiPluginProblems

    #[test]
    fn lane_ui_flags_declaration_export_and_target_problems() {
        let dir = valid_tree();
        write(dir.path(), "agents/backends/dsh/lane-plugin-ui/lib/other.js", "x\n");
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/package.json",
            r#"{ "name": "@wb/lane-ui", "dsh": { "client": { "platform": "desktop" } }, "exports": { "./client": "./lib/other.js", ".": "lib/gone.js" } }"#,
        );
        let problems = lane_ui_plugin_problems(dir.path());
        assert!(problems.contains(&"lane-plugin-ui/package.json dsh.client.platform is \"desktop\", not \"web\"".to_string()), "{problems:?}");
        assert!(problems.contains(&"lane-plugin-ui/package.json exports './client' -> './lib/other.js', but the rendered page installs as './lib/client.js'".to_string()), "{problems:?}");
        assert!(problems.contains(&"lane-plugin-ui/package.json exports '.' -> \"lib/gone.js\", which does not exist".to_string()), "{problems:?}");
        // non-string ./client and missing '.'
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/package.json",
            r#"{ "name": "@wb/lane-ui", "dsh": { "client": { "platform": "web" } }, "exports": { "./client": 42 } }"#,
        );
        let problems = lane_ui_plugin_problems(dir.path());
        assert!(problems.contains(&"lane-plugin-ui/package.json exports no './client', so dsh-client-modules would refuse the package".to_string()), "{problems:?}");
        assert!(problems.contains(&"lane-plugin-ui/package.json exports '.' -> undefined, which does not exist".to_string()), "{problems:?}");
        // no dsh at all + missing export target file
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/package.json",
            r#"{ "name": "@wb/lane-ui", "exports": { "./client": "./lib/client.js" } }"#,
        );
        let problems = lane_ui_plugin_problems(dir.path());
        assert!(problems.contains(&"lane-plugin-ui/package.json declares no dsh.client, so the page would never be scanned".to_string()), "{problems:?}");
    }

    #[test]
    fn lane_ui_flags_bundle_seam_problems() {
        let dir = valid_tree();
        // no registration, no factory, wrong id, rogue require
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/lib/client.js",
            concat!(
                "const LANES = \"__MY_WORKBENCH_LANES__\"\n",
                "register({ id: 'other-id', require('vue'), require('react-dom') })\n",
            ),
        );
        let problems = lane_ui_plugin_problems(dir.path());
        assert!(problems.contains(&"lane-plugin-ui/lib/client.js does not register through window.__ModuleLoader__.load(...)".to_string()), "{problems:?}");
        assert!(problems.contains(&"lane-plugin-ui/lib/client.js declares no factory, so the module table cannot materialize it".to_string()), "{problems:?}");
        assert!(problems.contains(&"lane-plugin-ui/lib/client.js registers id 'other-id' but the package is named '@wb/lane-ui'".to_string()), "{problems:?}");
        assert!(problems.contains(&"lane-plugin-ui/lib/client.js requires 'vue', which is not one of the browser shell's 9 seed modules (it would fail at runtime with \"missed the module table\")".to_string()), "{problems:?}");
        assert!(!problems.iter().any(|p| p.contains("'react-dom'")), "{problems:?}");
    }

    #[test]
    fn lane_ui_requires_exactly_one_marker_via_the_renderer() {
        let dir = valid_tree();
        write(
            dir.path(),
            "agents/backends/dsh/lane-plugin-ui/lib/client.js",
            "\"__MY_WORKBENCH_LANES__\" \"__MY_WORKBENCH_LANES__\"\nwindow.__ModuleLoader__.load('@wb/lane-ui', { id: '@wb/lane-ui', factory: () => 1 })\n",
        );
        let problems = lane_ui_plugin_problems(dir.path());
        assert!(problems.contains(&"lane UI must contain exactly one roster marker".to_string()), "{problems:?}");
    }

    #[test]
    fn require_and_id_scanners_follow_the_js_regexes() {
        // \b boundary: "grid:" does contain "id:" (no \b in that regex) but
        // "prerequisite(" must not count as require(
        let bundle = "grid: 'x' prerequisite('y') require( 'react' )require('react-dom')xrequire('vue')";
        assert_eq!(find_module_id(bundle), Some("x".to_string()));
        assert_eq!(find_requires(bundle), vec!["react".to_string(), "react-dom".to_string()]);
        // factory: needs \b and optional whitespace before the colon
        assert!(has_factory_pattern("factory: 1"));
        assert!(has_factory_pattern("({factory : f})"));
        assert!(!has_factory_pattern("myfactory: 1"));
        assert!(!has_factory_pattern("factory without colon"));
        // empty specifier does not match ([^'"]+)
        assert_eq!(find_requires("require('')"), Vec::<String>::new());
        assert_eq!(find_requires("require('a'b)"), Vec::<String>::new());
    }

    // ------------------------------------------------------ real-tree smoke

    #[test]
    fn real_source_tree_passes_all_checks() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap();
        assert_eq!(agent_source_problems(root), Vec::<String>::new());
        assert_eq!(lane_plugin_problems(root), Vec::<String>::new());
        assert_eq!(lane_ui_plugin_problems(root), Vec::<String>::new());
    }
}
