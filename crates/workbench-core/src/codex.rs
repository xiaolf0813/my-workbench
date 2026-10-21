//! Native ChatGPT/Codex standalone custom agents. config.toml is user-owned.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::{render, roster, WorkbenchError};

pub const MODEL_KEYS: &[&str] = &[
    "model",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
];

pub fn root(home: &Path) -> PathBuf {
    let root = std::env::var_os("CODEX_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    if root.is_absolute() {
        root
    } else {
        std::env::current_dir().unwrap_or_default().join(root)
    }
}

pub fn outputs(
    source: &Path,
    root: &Path,
    slots: &mut render::UsedSlots,
) -> Result<Vec<(String, String)>, WorkbenchError> {
    let backend = source.join("agents/backends/codex");
    let leaf = std::fs::read_to_string(backend.join("leaf.md"))?;
    let mut entries = roster::load_roster(source)?;
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let mut out = Vec::new();
    for entry in entries {
        let Some(lines) = entry
            .record
            .get("frontmatter")
            .and_then(|f| f.get("codex"))
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        let mut text = String::new();
        for line in lines {
            let line = line
                .as_str()
                .ok_or_else(|| WorkbenchError::Message("invalid codex metadata line".into()))?;
            if line == "@description" {
                text.push_str(&format!(
                    "description = {}\n",
                    serde_json::to_string(&entry.description)?
                ));
            } else {
                text.push_str(line);
                text.push('\n');
            }
        }
        let raw = std::fs::read_to_string(
            source
                .join("agents/prompts")
                .join(format!("{}.md", entry.name)),
        )?;
        let body = render::fill_slots(
            source,
            "codex",
            render::js_trim(render::strip_attribution(&raw)),
            slots,
        )?;
        let instructions = format!(
            "{}\n\n{}{}\n",
            render::js_trim(&body),
            render::js_trim(&leaf),
            render::disciplines_block(source)?
        );
        text.push_str(&format!(
            "developer_instructions = {}\n",
            serde_json::to_string(&instructions)?
        ));
        // Parse exactly what we ship, including quotes and multiline prompt bodies.
        let doc = parse(&text)?;
        if doc.get("name").and_then(|v| v.as_str()) != Some(entry.name.as_str()) {
            return Err(WorkbenchError::Message(format!(
                "Codex agent '{}' must declare its roster name",
                entry.name
            )));
        }
        out.push((format!("agents/{}.toml", entry.name), text));
    }
    out.push((
        "my-workbench-orchestrator.md".into(),
        render::agent_prompt_body(source, "codex", "orchestrator", slots)?,
    ));
    out.push((
        "AGENTS.md".into(),
        std::fs::read_to_string(backend.join("AGENTS.md"))?.replace(
            "{{policy-path}}",
            &root
                .join("my-workbench-orchestrator.md")
                .to_string_lossy()
                .replace('\\', "/"),
        ),
    ));
    Ok(out)
}

fn parse(text: &str) -> Result<toml_edit::DocumentMut, WorkbenchError> {
    text.parse()
        .map_err(|e| WorkbenchError::Message(format!("invalid Codex agent TOML: {e}")))
}

pub fn read_agent(
    text: &str,
    fallback: &str,
    file: &str,
) -> Result<crate::deployed::DeployedAgent, WorkbenchError> {
    let doc = parse(text)?;
    Ok(crate::deployed::DeployedAgent {
        name: doc
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(fallback)
            .into(),
        description: doc
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        file_name: file.into(),
        body: doc
            .get("developer_instructions")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        settings: MODEL_KEYS
            .iter()
            .map(|k| {
                (
                    (*k).into(),
                    doc.get(k).and_then(|v| v.as_str()).map(str::to_owned),
                )
            })
            .collect(),
    })
}

pub fn edit_agent(
    text: &str,
    body: &str,
    settings: &BTreeMap<String, Option<String>>,
) -> Result<String, WorkbenchError> {
    let mut doc = parse(text)?;
    for key in MODEL_KEYS {
        if let Some(value) = settings.get(*key) {
            match value {
                Some(value) => {
                    doc[*key] = toml_edit::value(value);
                }
                None => {
                    doc.remove(key);
                }
            }
        }
    }
    if doc.get("developer_instructions").and_then(|v| v.as_str()) != Some(body) {
        doc["developer_instructions"] = toml_edit::value(body);
    }
    Ok(doc.to_string())
}

// Same statement scanner as bin/codex-agent.js. Raw values survive --force;
// names inside developer_instructions, comments and tables are never settings.
fn statements(text: &str) -> Vec<(Option<String>, &str)> {
    let b = text.as_bytes();
    let (mut start, mut i, mut quote, mut triple, mut depth, mut comment) =
        (0, 0, 0u8, false, 0i32, false);
    let mut out = Vec::new();
    let key_re = regex::Regex::new(r#"^[ \t]*(?:([\w-]+)|"([\w-]+)"|'([\w-]+)')[ \t]*="#).unwrap();
    while i <= b.len() {
        let c = b.get(i).copied().unwrap_or(0);
        if comment {
            if c != b'\n' && i != b.len() {
                i += 1;
                continue;
            }
            comment = false;
        } else if quote != 0 {
            if quote == b'"' && c == b'\\' {
                i += 2;
                continue;
            }
            let closes = if triple {
                b.get(i..i + 3) == Some(&[quote, quote, quote])
            } else {
                c == quote
            };
            if closes {
                if triple {
                    while b.get(i + 1) == Some(&quote) {
                        i += 1;
                    }
                }
                quote = 0;
            }
            i += 1;
            continue;
        } else if c == b'"' || c == b'\'' {
            quote = c;
            triple = b.get(i..i + 3) == Some(&[c, c, c]);
            if triple {
                i += 2;
            }
            i += 1;
            continue;
        } else if c == b'#' {
            comment = true;
            i += 1;
            continue;
        } else if c == b'[' || c == b'{' {
            depth += 1;
        } else if c == b']' || c == b'}' {
            depth -= 1;
        }
        if (c == b'\n' || i == b.len()) && depth == 0 {
            let raw = text[start..i].strip_suffix('\r').unwrap_or(&text[start..i]);
            if raw.trim_start_matches([' ', '\t']).starts_with('[') {
                break;
            }
            if !raw.trim().is_empty() {
                let key = key_re.captures(raw).and_then(|cap| {
                    (1..=3).find_map(|n| cap.get(n).map(|v| v.as_str().to_owned()))
                });
                out.push((key, raw));
            }
            start = i + 1;
        }
        i += 1;
    }
    out
}

pub fn preserve_settings(previous: &str, fresh: &str) -> String {
    let old = statements(previous);
    let saved: Vec<_> = old
        .iter()
        .filter(|(key, _)| key.as_deref().is_some_and(|k| MODEL_KEYS.contains(&k)))
        .collect();
    if saved.is_empty() {
        return fresh.into();
    }
    let mut lines: Vec<&str> = saved.iter().map(|(_, raw)| *raw).collect();
    for (key, raw) in statements(fresh) {
        if !saved.iter().any(|(k, _)| key.is_some() && *k == key) {
            lines.push(raw);
        }
    }
    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_preservation_ignores_prompt_literals_and_nested_settings() {
        let old = "# model = \"comment\"\ndeveloper_instructions = '''\nmodel = \"prompt\"\n'''\nmodel = \"\"\"custom/model\"\"\" # pinned\nmodel_reasoning_effort = 'high'\n[features]\nmodel_verbosity = \"nested\"\n";
        let fresh =
            "name = \"observer\"\nfeatures.shell_tool = false\ndeveloper_instructions = \"new\"\n";
        let actual = preserve_settings(old, fresh);
        assert!(actual.starts_with(
            "model = \"\"\"custom/model\"\"\" # pinned\nmodel_reasoning_effort = 'high'\n"
        ));
        assert!(actual.contains("features.shell_tool = false"));
        assert!(
            !actual.contains("nested") && !actual.contains("prompt") && !actual.contains("comment")
        );
        parse(&actual).unwrap();
        let with_quotes = "developer_instructions = \"\"\"ends with a quote\"\"\"\"\nmodel = 'custom/after-prompt'\n";
        assert!(
            preserve_settings(with_quotes, fresh).starts_with("model = 'custom/after-prompt'\n")
        );
    }

    #[test]
    fn editor_roundtrips_and_changes_only_the_requested_settings() {
        let original = "# retained\nname = 'observer'\ndescription = '描述'\nmodel = 'custom/model' # pin\nmodel_reasoning_summary = 'detailed'\ndeveloper_instructions = 'Read only'\n[features]\nshell_tool = false\n";
        assert_eq!(
            edit_agent(original, "Read only", &BTreeMap::new()).unwrap(),
            original
        );
        let settings = BTreeMap::from([
            ("model".into(), None),
            ("model_reasoning_effort".into(), Some("high".into())),
            ("not_a_setting".into(), Some("ignored".into())),
        ]);
        let edited = edit_agent(original, "Updated\nwith \"quotes\"", &settings).unwrap();
        let agent = read_agent(&edited, "fallback", "observer.toml").unwrap();
        assert_eq!(agent.body, "Updated\nwith \"quotes\"");
        assert_eq!(agent.settings["model"], None);
        assert_eq!(
            agent.settings["model_reasoning_effort"].as_deref(),
            Some("high")
        );
        assert_eq!(
            agent.settings["model_reasoning_summary"].as_deref(),
            Some("detailed")
        );
        assert!(!edited.contains("not_a_setting"));
        assert!(edited.contains("# retained") && edited.contains("shell_tool = false"));
    }
}
