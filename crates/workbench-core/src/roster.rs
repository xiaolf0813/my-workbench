//! The agent roster: `agents/roster.json`, the one authored record per agent.
//!
//! Port of the CLI's `agentRoster` (`bin/my-workbench.js` :508-510): read
//! `agents/roster.json`, return its `agents` member. The Rust port returns a
//! `Vec` so the authored object key order survives — serde_json's `Map` is a
//! sorted `BTreeMap` (no `preserve_order` feature), which would silently
//! reorder agents. The order matters for `agent_source_problems` output parity
//! with the CLI, so [`load_roster`] recovers it with a small key-order scanner.

use crate::WorkbenchError;
use serde_json::Value;
use std::path::Path;

/// One authored agent record from `agents/roster.json`, in file order.
///
/// `record` is the full authored object (`description` + `frontmatter`);
/// `description` is pre-extracted for convenience. A non-string or missing
/// `description` coerces to the empty string here — `checks::agent_source_problems`
/// is the component that reports it, exactly like the CLI's `typeof` check.
#[derive(Debug, Clone)]
pub struct AgentEntry {
    pub name: String,
    pub description: String,
    pub record: serde_json::Value,
}

/// Read `agents/roster.json` and return its `agents` records in authored order.
///
/// Mirrors the CLI's `agentRoster()`: a missing or unparseable file is a hard
/// error (the CLI's `readFileSync`/`JSON.parse` throws). A missing or
/// non-object `agents` member is a hard error too — the CLI would crash on
/// `Object.entries(undefined)`.
pub fn load_roster(source_root: &Path) -> Result<Vec<AgentEntry>, WorkbenchError> {
    let path = source_root.join("agents").join("roster.json");
    let raw = std::fs::read_to_string(&path)?;
    let value: Value = serde_json::from_str(&raw)?;
    let agents = value.get("agents").ok_or_else(|| {
        WorkbenchError::Message("agents/roster.json must contain an 'agents' object".to_string())
    })?;
    let map = agents.as_object().ok_or_else(|| {
        WorkbenchError::Message("agents/roster.json must contain an 'agents' object".to_string())
    })?;

    // Authored key order, recovered from the raw text (see module docs).
    let order =
        ordered_root_member_keys(&raw, "agents").unwrap_or_else(|| map.keys().cloned().collect());

    let mut entries = Vec::with_capacity(order.len());
    for name in order {
        let record = match map.get(&name) {
            Some(record) => record.clone(),
            None => continue,
        };
        let description = record
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        entries.push(AgentEntry {
            name,
            description,
            record,
        });
    }
    Ok(entries)
}

// ---------------------------------------------------------------- key order

/// Recover the authored key order of the root-level member `member` from raw
/// JSON text. serde_json's `Map` sorts keys, so the only way to keep the
/// authored order (and with it byte-parity of problem lists and downstream
/// renders) is to scan the text itself. Returns `None` on any structural
/// surprise; callers fall back to the (sorted) parsed order.
fn ordered_root_member_keys(raw: &str, member: &str) -> Option<Vec<String>> {
    let b = raw.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    loop {
        i = skip_ws(b, i);
        match b.get(i) {
            Some(b'}') => return Some(Vec::new()),
            Some(b'"') => {}
            _ => return None,
        }
        let (key, next) = parse_json_string(raw, i)?;
        i = skip_ws(b, next);
        if b.get(i) != Some(&b':') {
            return None;
        }
        i = skip_ws(b, i + 1);
        if key == member {
            if b.get(i) != Some(&b'{') {
                return None;
            }
            return collect_object_keys(raw, i);
        }
        i = skip_ws(b, skip_value(raw, i)?);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => return Some(Vec::new()),
            _ => return None,
        }
    }
}

/// Collect the keys of the object starting at `open_brace` in file order.
fn collect_object_keys(raw: &str, open_brace: usize) -> Option<Vec<String>> {
    let b = raw.as_bytes();
    let mut i = open_brace + 1;
    let mut keys = Vec::new();
    loop {
        i = skip_ws(b, i);
        match b.get(i) {
            Some(b'}') => return Some(keys),
            Some(b'"') => {}
            _ => return None,
        }
        let (key, next) = parse_json_string(raw, i)?;
        keys.push(key);
        i = skip_ws(b, next);
        if b.get(i) != Some(&b':') {
            return None;
        }
        i = skip_ws(b, i + 1);
        i = skip_ws(b, skip_value(raw, i)?);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => return Some(keys),
            _ => return None,
        }
    }
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while matches!(b.get(i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        i += 1;
    }
    i
}

/// Advance past one JSON value starting at `i`; returns the index after it.
fn skip_value(raw: &str, i: usize) -> Option<usize> {
    let b = raw.as_bytes();
    match b.get(i)? {
        b'"' => parse_json_string(raw, i).map(|(_, next)| next),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut i = i;
            while i < b.len() {
                match b[i] {
                    b'"' => {
                        let (_, next) = parse_json_string(raw, i)?;
                        i = next;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            None
        }
        // number / true / false / null — runs until a delimiter
        _ => {
            let mut i = i;
            while i < b.len() && !matches!(b[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
            {
                i += 1;
            }
            Some(i)
        }
    }
}

/// Parse the JSON string starting at `start` (which must be a `"`), returning
/// the decoded text and the index just past the closing quote.
fn parse_json_string(raw: &str, start: usize) -> Option<(String, usize)> {
    let b = raw.as_bytes();
    debug_assert_eq!(b[start], b'"');
    let mut i = start + 1;
    let mut out = String::new();
    loop {
        match b.get(i)? {
            b'"' => return Some((out, i + 1)),
            b'\\' => {
                i += 1;
                match b.get(i)? {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000C}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hi = parse_hex4(b, i + 1)?;
                        i += 5;
                        let ch = if (0xD800..0xDC00).contains(&hi) {
                            // High surrogate: a `\uXXXX` low surrogate must follow.
                            if b.get(i) == Some(&b'\\') && b.get(i + 1) == Some(&b'u') {
                                let lo = parse_hex4(b, i + 2)?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return None;
                                }
                                i += 6;
                                let c = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                                char::from_u32(c)?
                            } else {
                                return None;
                            }
                        } else if (0xDC00..0xE000).contains(&hi) {
                            return None; // lone low surrogate
                        } else {
                            char::from_u32(hi)?
                        };
                        out.push(ch);
                    }
                    _ => return None,
                }
                i += 1;
            }
            _ => {
                // Any other byte starts a UTF-8 sequence (self-synchronizing:
                // we only ever stop at ASCII specials).
                let c = raw[i..].chars().next()?;
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
}

fn parse_hex4(b: &[u8], start: usize) -> Option<u32> {
    let hex = b.get(start..start + 4)?;
    let mut v = 0u32;
    for &d in hex {
        let d = d as char;
        v = v * 16 + d.to_digit(16)?;
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn loads_records_in_authored_order() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "agents/roster.json",
            r#"{
  "agents": {
    "zeta": { "description": "last authored first", "frontmatter": {} },
    "alpha": { "description": "alphabetically first, authored second", "frontmatter": {} },
    "mid_way-2": { "description": "d", "frontmatter": {} }
  }
}"#,
        );
        let roster = load_roster(dir.path()).unwrap();
        let names: Vec<&str> = roster.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["zeta", "alpha", "mid_way-2"]);
        assert_eq!(roster[0].description, "last authored first");
    }

    #[test]
    fn survives_braces_and_escapes_inside_strings() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "agents/roster.json",
            "{\n  \"agents\": {\n    \"a\\\"b\": { \"description\": \"} not a close { ok\", \"frontmatter\": { \"claude\": [ \"x: {\\\"y}\\\"\" ] } },\n    \"c\": { \"description\": \"\\u4ee3\\u7801\", \"frontmatter\": {} }\n  }\n}\n",
        );
        let roster = load_roster(dir.path()).unwrap();
        let names: Vec<&str> = roster.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["a\"b", "c"]);
        assert_eq!(roster[1].description, "代码");
        assert_eq!(
            roster[0].record["frontmatter"]["claude"][0],
            Value::String("x: {\"y}\"".to_string())
        );
    }

    #[test]
    fn non_string_description_coerces_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "agents/roster.json",
            r#"{ "agents": { "a": { "description": 42, "frontmatter": {} }, "b": { "frontmatter": {} } } }"#,
        );
        let roster = load_roster(dir.path()).unwrap();
        assert_eq!(roster[0].description, "");
        assert_eq!(roster[1].description, "");
        assert_eq!(roster[0].record["description"], Value::from(42));
    }

    #[test]
    fn missing_agents_member_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "agents/roster.json", r#"{ "nope": {} }"#);
        assert!(load_roster(dir.path()).is_err());
    }

    #[test]
    fn missing_file_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_roster(dir.path()).unwrap_err();
        assert!(matches!(err, WorkbenchError::Io(_)));
    }

    #[test]
    fn surrogate_pair_keys_and_values_decode() {
        let dir = tempfile::tempdir().unwrap();
        // key written as an escaped surrogate pair for "🚀"
        write(
            dir.path(),
            "agents/roster.json",
            "{ \"agents\": { \"\\ud83d\\ude80\": { \"description\": \"\\ud83d\\ude80 ok\", \"frontmatter\": {} } } }",
        );
        let roster = load_roster(dir.path()).unwrap();
        assert_eq!(roster[0].name, "🚀");
        assert_eq!(roster[0].description, "🚀 ok");
    }
}
