//! Overwrite semantics — what a `--force` install may touch, per destination.
//!
//! Two regimes, byte-identical to the CLI's preservation and stub-ownership
//! sections in `bin/my-workbench.js` (the golden gate is the arbiter):
//!
//! * **User model-setting preservation** — `agents/*.md` destinations. An
//!   overwrite would otherwise clobber the model settings a user retuned by
//!   hand, so the user's per-backend frontmatter key lines are snapshotted
//!   from the bytes on disk and spliced back into the fresh render. There is
//!   no model logic here — no validation, no defaults, no merging: a pure
//!   byte-level save and restore of what the user had.
//! * **JSON stub ownership** — `.claude/settings.json` and `opencode.jsonc`
//!   are seed stubs: the deploy's intent for them is to place the stub
//!   content, never to own the file. The keys my-workbench owns are exactly
//!   those present in the stub — derived by parsing the stub bytes (`agent`
//!   in settings.json, `$schema` in opencode.jsonc today), never hardcoded.
//!   A force overwrite reconciles those keys into the existing file (a
//!   canonical value replaces the value span; a missing key is inserted
//!   whole) and every other byte of the user's file survives verbatim. This
//!   is NOT snapshot-based: the canonical values always come from the stub.
//!
//! An unparseable file (or stub) is left COMPLETELY untouched — user content
//! is never overwritten with the stub. DSH destinations match nothing —
//! their lane pins live in `<DSH_HOME>/settings.yaml`, which this tool never
//! writes. Both regimes fire only on `execute` overwrites (`plan` stays
//! zero-write) and are not part of `check_drift`: after a preserved or
//! reconciled overwrite the file intentionally differs from the render,
//! exactly like a hand-edited file.

use std::borrow::Cow;
use std::path::Path;

// ------------------------------------------------------------------ rules

/// The per-backend frontmatter key inventories (zcode's thinking knob is
/// `thoughtLevel`, a Claude Code subagent's only reasoning knob is `effort`,
/// and OpenCode's reasoning selector is `variant`). Shared with the
/// deployed-agent reader (`crate::deployed`), which reads and rewrites the
/// same keys of the same files.
pub(crate) const ZCODE_AGENT_KEYS: &[&str] = &["model", "thoughtLevel"];
pub(crate) const CLAUDE_AGENT_KEYS: &[&str] = &["model", "effort"];
pub(crate) const OPENCODE_AGENT_KEYS: &[&str] = &["model", "variant"];

/// Which user-retuned model settings a destination carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rule {
    /// Agent markdown: the backend's frontmatter key list (`.zcode` →
    /// `model`/`thoughtLevel`, `.claude` → `model`/`effort`,
    /// `.opencode`/`opencode` → `model`/`variant`).
    Frontmatter(&'static [&'static str]),
}

/// The preserve rule for a destination path, or `None` when it carries no
/// user model settings (CLI `modelSettingsRule`). The two JSON stub
/// destinations (`.claude/settings.json`, `opencode.jsonc`) are NOT here —
/// they are reconciled, not preserved (see `is_json_stub_dest`).
fn rule_for(dest: &Path) -> Option<Rule> {
    let base = dest.file_name()?.to_str()?;
    let parent = dest
        .parent()
        .and_then(Path::file_name)
        .and_then(|n| n.to_str());
    if base.ends_with(".md") && parent == Some("agents") {
        let grandparent = dest
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|n| n.to_str());
        let keys = match grandparent {
            Some(".zcode") => ZCODE_AGENT_KEYS,
            Some(".claude") => CLAUDE_AGENT_KEYS,
            Some(".opencode") | Some("opencode") => OPENCODE_AGENT_KEYS,
            _ => return None,
        };
        return Some(Rule::Frontmatter(keys));
    }
    None
}

// --------------------------------------------- frontmatter: per-backend keys

/// A frontmatter line carries `key` when it is `<key>:` after optional
/// spaces/tabs (the per-key `/^[ \t]*<key>:.*$/` rule). Shared with
/// [`crate::deployed`]'s read/rewrite of the same frontmatter.
pub(crate) fn is_key_line(line: &str, key: &str) -> bool {
    line.trim_start_matches([' ', '\t'])
        .starts_with(&format!("{key}:"))
}

/// The key a frontmatter line opens with (`^[ \t]*<key>:`), or `None`.
/// Shared with [`crate::deployed`].
pub(crate) fn frontmatter_key_of(line: &str) -> Option<&str> {
    let stripped = line.trim_start_matches([' ', '\t']);
    let colon = stripped.find(':')?;
    Some(&stripped[..colon])
}

/// One saved frontmatter line with the key it carries; both borrowed from the
/// snapshotted text.
struct SavedLine<'a> {
    key: &'a str,
    line: &'a str,
}

/// The user's frontmatter lines for the rule's keys — the FIRST line per key,
/// collected in old-file order. Absent keys contribute nothing; a file
/// without a frontmatter block saves nothing (CLI
/// `snapshotFrontmatterKeys`).
fn snapshot_frontmatter_keys<'a>(text: &'a str, keys: &[&str]) -> Vec<SavedLine<'a>> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.first().copied() != Some("---") {
        return Vec::new();
    }
    let Some(close) = (1..lines.len()).find(|&i| lines[i] == "---") else {
        return Vec::new();
    };
    let mut saved: Vec<SavedLine<'a>> = Vec::new();
    for line in &lines[1..close] {
        let Some(key) = frontmatter_key_of(line) else {
            continue;
        };
        if keys.contains(&key) && !saved.iter().any(|s| s.key == key) {
            saved.push(SavedLine { key, line });
        }
    }
    saved
}

/// Write the saved lines into the fresh render's frontmatter block, per key
/// independently and in saved order: replace the FIRST line carrying that
/// key, or insert the saved line as the block's new last line (immediately
/// before the closing `---`) when the render carries none — a model-only file
/// still restores model, a thoughtLevel-only file still restores
/// thoughtLevel. A render without a frontmatter block is returned unchanged
/// (CLI `restoreFrontmatterKeys`).
fn restore_frontmatter_keys(saved: &[SavedLine<'_>], text: &str) -> String {
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    if lines.first().map(String::as_str) != Some("---") {
        return text.to_owned();
    }
    let Some(mut close) = (1..lines.len()).find(|&i| lines[i] == "---") else {
        return text.to_owned();
    };
    for saved_line in saved {
        let mut replaced = false;
        for line in &mut lines[1..close] {
            if is_key_line(line, saved_line.key) {
                *line = saved_line.line.to_owned();
                replaced = true;
                break;
            }
        }
        if !replaced {
            lines.insert(close, saved_line.line.to_owned());
            close += 1;
        }
    }
    lines.join("\n")
}

// ----------------------------------------------------- JSONC root: member

/// One JSONC token kind: a structural character, a string, or an "atom" — any
/// other run of characters (numbers, literals).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokKind {
    OpenBrace,
    CloseBrace,
    OpenBracket,
    CloseBracket,
    Comma,
    Colon,
    Str,
    Atom,
}

/// A JSONC token with its source span. Strings keep their raw (unescaped)
/// inner text — the key comparison is on the literal bytes.
struct Tok<'a> {
    kind: TokKind,
    start: usize,
    end: usize,
    text: &'a str,
}

/// Minimal JSONC token stream: whitespace (space, `\t`, `\n`, `\r`) and
/// comments (`// …\n` — the newline is not part of the comment — and
/// `/* … */`, no nesting) are dropped anywhere between tokens; strings scan
/// with `\x` consuming two chars; structural characters stand alone. Returns
/// `None` on an unterminated string or comment — the caller no-ops, never
/// errors (CLI `scanJsoncTokens`).
fn scan_jsonc_tokens(text: &str) -> Option<Vec<Tok<'_>>> {
    let b = text.as_bytes();
    let n = b.len();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        match c {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b'/' if i + 1 < n && b[i + 1] == b'/' => {
                i = match text[i..].find('\n') {
                    Some(nl) => i + nl,
                    None => n,
                };
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                let end = text[i + 2..].find("*/")? + i + 2;
                i = end + 2;
            }
            b'"' => {
                let mut j = i + 1;
                loop {
                    if j >= n {
                        return None; // unterminated string
                    }
                    if b[j] == b'"' {
                        break;
                    }
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                tokens.push(Tok {
                    kind: TokKind::Str,
                    start: i,
                    end: j + 1,
                    text: &text[i + 1..j],
                });
                i = j + 1;
            }
            b'{' | b'}' | b'[' | b']' | b',' | b':' => {
                tokens.push(Tok {
                    kind: match c {
                        b'{' => TokKind::OpenBrace,
                        b'}' => TokKind::CloseBrace,
                        b'[' => TokKind::OpenBracket,
                        b']' => TokKind::CloseBracket,
                        b',' => TokKind::Comma,
                        _ => TokKind::Colon,
                    },
                    start: i,
                    end: i + 1,
                    text: "",
                });
                i += 1;
            }
            _ => {
                let mut j = i;
                while j < n {
                    let c = b[j];
                    if matches!(
                        c,
                        b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'{' | b'}' | b'[' | b']' | b',' | b':'
                    ) {
                        break;
                    }
                    if c == b'/' && j + 1 < n && (b[j + 1] == b'/' || b[j + 1] == b'*') {
                        break;
                    }
                    j += 1;
                }
                tokens.push(Tok {
                    kind: TokKind::Atom,
                    start: i,
                    end: j,
                    text: "",
                });
                i = j;
            }
        }
    }
    Some(tokens)
}

/// One member of a JSONC object: the key and the token span of its value
/// (from the first token after the `:` to the last token before the member's
/// terminator — the next `,` at the member's depth, or the object's closing
/// `}`; nested brackets are skipped with a depth counter), plus the token
/// index of the key itself (the full member span runs from there).
struct Member<'a> {
    key: &'a str,
    /// Token index of the key.
    key_start: usize,
    /// Token index of the value's first token.
    start: usize,
    /// Token index of the value's last token.
    end: usize,
}

/// The members of the object whose opening `{` is the token at `open_idx`:
/// the token index of its closing `}` and its member records — the same
/// shape the root parse yields. Callers only feed it token streams that
/// already passed [`parse_jsonc_root`]'s whole-document validation. Returns
/// `None` for a member list that is not `string ":" value` pairs (CLI
/// `parseObjectMembers`).
fn parse_object_members<'text, 'toks>(
    tokens: &'toks [Tok<'text>],
    open_idx: usize,
) -> Option<(usize, Vec<Member<'text>>)> {
    let mut depth = 0i32;
    let mut close = None;
    for (k, tok) in tokens.iter().enumerate().skip(open_idx) {
        match tok.kind {
            TokKind::OpenBrace => depth += 1,
            TokKind::CloseBrace => {
                depth -= 1;
                if depth == 0 {
                    close = Some(k);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;

    let mut members = Vec::new();
    let mut i = open_idx + 1;
    while i < close {
        if tokens[i].kind != TokKind::Str {
            return None;
        }
        if tokens.get(i + 1).map(|t| t.kind) != Some(TokKind::Colon) {
            return None;
        }
        let mut j = i + 2;
        let mut inner = 0i32;
        let mut start = None;
        let mut end = 0usize;
        while j <= close {
            let kind = tokens[j].kind;
            if inner == 0 && (kind == TokKind::Comma || j == close) {
                break;
            }
            if start.is_none() {
                start = Some(j);
            }
            end = j;
            match kind {
                TokKind::OpenBrace | TokKind::OpenBracket => inner += 1,
                TokKind::CloseBrace | TokKind::CloseBracket => inner -= 1,
                _ => {}
            }
            j += 1;
        }
        let start = start?; // empty value (`,` or `}` right after the colon)
        if j > close {
            return None; // the member never terminated
        }
        members.push(Member {
            key: tokens[i].text,
            key_start: i,
            start,
            end,
        });
        i = j + 1; // past the comma; lands past close when the member list ends
    }
    Some((close, members))
}

/// The root object of a JSONC document, parsed for top-level members only.
/// Returns `None` for anything the scanner rejects — root not an object,
/// unbalanced braces or brackets, tokens after the root closes, or a member
/// list that is not `string ":" value` pairs — and the caller no-ops (CLI
/// `parseJsoncRoot`).
fn parse_jsonc_root(text: &str) -> Option<(Vec<Tok<'_>>, usize, Vec<Member<'_>>)> {
    let tokens = scan_jsonc_tokens(text)?;
    if tokens.first().map(|t| t.kind) != Some(TokKind::OpenBrace) {
        return None;
    }
    let mut braces = 0i32;
    let mut brackets = 0i32;
    let mut root_close = None; // token index of the "}" that closes the root
    for (k, tok) in tokens.iter().enumerate() {
        match tok.kind {
            TokKind::OpenBrace => braces += 1,
            TokKind::OpenBracket => brackets += 1,
            TokKind::CloseBrace => {
                braces -= 1;
                if braces < 0 {
                    return None;
                }
                if braces == 0 && brackets == 0 && root_close.is_none() {
                    root_close = Some(k);
                }
            }
            TokKind::CloseBracket => {
                brackets -= 1;
                if brackets < 0 {
                    return None;
                }
            }
            _ => {}
        }
    }
    if braces != 0 || brackets != 0 {
        return None;
    }
    let root_close = root_close?;
    if root_close != tokens.len() - 1 {
        return None; // tokens after the root closes
    }
    let (close, members) = parse_object_members(&tokens, 0)?;
    Some((tokens, close, members))
}

// ------------------------------------------- JSON stub ownership

/// The two JSON seed-stub destinations whose owned keys an install reconciles
/// on force (CLI `isJsonStubDest`): `settings.json` inside a `.claude/`
/// directory (project and `~/.claude/`) and `opencode.jsonc` in the opencode
/// config roots (project `.opencode/` and `~/.config/opencode/`).
fn is_json_stub_dest(dest: &Path) -> bool {
    let Some(base) = dest.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let parent = dest.parent().and_then(Path::file_name).and_then(|n| n.to_str());
    if base == "settings.json" && parent == Some(".claude") {
        return true;
    }
    base == "opencode.jsonc" && matches!(parent, Some(".opencode") | Some("opencode"))
}

/// One owned member of the stub: its key, the canonical value text (spliced
/// over an existing value span) and the full member span text `"<key>":
/// <value>` (inserted whole when the key is missing); all borrowed from the
/// stub bytes.
struct OwnedMember<'a> {
    key: &'a str,
    value: &'a str,
    member: &'a str,
}

/// The stub's owned top-level keys, derived by parsing the stub — never
/// hardcoded (CLI `stubOwnedMembers`); the first occurrence wins per key.
/// `None` when the stub does not parse — a packaging bug: reconciliation
/// no-ops.
fn stub_owned_members(stub: &str) -> Option<Vec<OwnedMember<'_>>> {
    let (tokens, _close, members) = parse_jsonc_root(stub)?;
    let mut owned: Vec<OwnedMember<'_>> = Vec::new();
    for m in &members {
        if owned.iter().any(|o| o.key == m.key) {
            continue;
        }
        owned.push(OwnedMember {
            key: m.key,
            value: &stub[tokens[m.start].start..tokens[m.end].end],
            member: &stub[tokens[m.key_start].start..tokens[m.end].end],
        });
    }
    Some(owned)
}

/// Splice one owned key into the existing content: replace the value span of
/// the key's first occurrence (the user's key spelling and surrounding
/// whitespace/comments survive), or insert the stub's full member span before
/// the root's closing `}` — after its whitespace run, `,\n  ` prefix, no
/// comma into an empty root. `None` when the content does not parse: the
/// caller leaves the file completely untouched (CLI `reconcileOwnedKey`).
fn reconcile_owned_key(key: &str, value: &str, member_text: &str, text: &str) -> Option<String> {
    let (tokens, close, members) = parse_jsonc_root(text)?;
    if let Some(member) = members.iter().find(|m| m.key == key) {
        let from = tokens[member.start].start;
        let to = tokens[member.end].end;
        return Some(format!("{}{}{}", &text[..from], value, &text[to..]));
    }
    // Immediately before the closing "}"…, back over its whitespace run
    // (ASCII offsets stay on char boundaries).
    let bytes = text.as_bytes();
    let mut at = tokens[close].start;
    while at > 0 && matches!(bytes[at - 1], b' ' | b'\t' | b'\n' | b'\r') {
        at -= 1;
    }
    let comma = if members.is_empty() { "" } else { "," };
    Some(format!(
        "{}{comma}\n  {member_text}{}",
        &text[..at],
        &text[at..]
    ))
}

/// The reconciled content for an overwrite of a stub destination: every
/// stub-owned key spliced into the file currently on disk. Returns `None` —
/// leave the file COMPLETELY untouched — when the existing file cannot be
/// read, either side is not valid UTF-8, or either side does not parse (CLI
/// `reconcileJsonStub`).
fn reconcile_stub(dest: &Path, stub: &[u8]) -> Option<Vec<u8>> {
    let stub_text = std::str::from_utf8(stub).ok()?;
    let Some(owned) = stub_owned_members(stub_text) else {
        return None;
    };
    let existing = std::fs::read(dest).ok()?;
    let existing_text = std::str::from_utf8(&existing).ok()?;
    let mut text = existing_text.to_owned();
    for member in &owned {
        text = reconcile_owned_key(member.key, member.value, member.member, &text)?;
    }
    Some(text.into_bytes())
}

// --------------------------------------------------------------- the entry

/// The bytes to write for an overwrite of `dest` — the fresh bytes, usually
/// with the user's model settings spliced back in, or the stub's own keys
/// reconciled into the user's file — or `None` to leave the file on disk
/// COMPLETELY untouched (a stub destination whose existing content or stub
/// does not parse, an unreadable file, or text that is not valid UTF-8),
/// mirroring the CLI's `copyOne` force path.
pub(crate) fn overwrite_bytes<'a>(dest: &Path, fresh: &'a [u8]) -> Option<Cow<'a, [u8]>> {
    if dest.extension().is_some_and(|ext| ext == "toml")
        && dest.parent().and_then(Path::file_name).is_some_and(|name| name == "agents")
    {
        let Ok(previous) = std::fs::read_to_string(dest) else { return Some(Cow::Borrowed(fresh)); };
        let fresh_text = std::str::from_utf8(fresh).ok()?;
        return Some(Cow::Owned(crate::codex::preserve_settings(&previous, fresh_text).into_bytes()));
    }
    if is_json_stub_dest(dest) {
        return reconcile_stub(dest, fresh).map(Cow::Owned);
    }
    let Some(rule) = rule_for(dest) else {
        return Some(Cow::Borrowed(fresh));
    };
    let existing = match std::fs::read(dest) {
        Ok(bytes) => bytes,
        Err(_) => return Some(Cow::Borrowed(fresh)),
    };
    let Some(existing) = std::str::from_utf8(&existing).ok() else {
        return Some(Cow::Borrowed(fresh));
    };
    let Some(fresh_text) = std::str::from_utf8(fresh).ok() else {
        return Some(Cow::Borrowed(fresh));
    };
    match rule {
        Rule::Frontmatter(keys) => {
            let saved = snapshot_frontmatter_keys(existing, keys);
            if saved.is_empty() {
                return Some(Cow::Borrowed(fresh));
            }
            Some(Cow::Owned(restore_frontmatter_keys(&saved, fresh_text).into_bytes()))
        }
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------- rule table

    #[test]
    fn rules_match_the_preserve_set_only() {
        let rule = |p: &str| rule_for(Path::new(p));
        // Agent markdown: .md under an immediate `agents` parent, keyed by the
        // grandparent directory — project and user level.
        assert_eq!(
            rule(".claude/agents/oracle.md"),
            Some(Rule::Frontmatter(CLAUDE_AGENT_KEYS))
        );
        assert_eq!(
            rule("/home/u/.claude/agents/oracle.md"),
            Some(Rule::Frontmatter(CLAUDE_AGENT_KEYS))
        );
        assert_eq!(
            rule("/home/u/.config/opencode/agents/oracle.md"),
            Some(Rule::Frontmatter(OPENCODE_AGENT_KEYS))
        );
        assert_eq!(
            rule(".opencode/agents/oracle.md"),
            Some(Rule::Frontmatter(OPENCODE_AGENT_KEYS))
        );
        assert_eq!(
            rule("/home/u/.zcode/agents/oracle.md"),
            Some(Rule::Frontmatter(ZCODE_AGENT_KEYS))
        );
        // A `site/` grandparent (or anything unknown) matches nothing.
        assert_eq!(rule("site/agents/oracle.md"), None);
        // The zcode global file's parent is `.zcode`, not `agents`.
        assert_eq!(rule("/home/u/.zcode/AGENTS.md"), None);
        // The two JSON stubs are NOT preservation destinations — they are
        // reconciled seeds (is_json_stub_dest).
        assert_eq!(rule(".opencode/opencode.jsonc"), None);
        assert_eq!(rule("/home/u/.config/opencode/opencode.jsonc"), None);
        assert_eq!(rule(".claude/settings.json"), None);
        assert_eq!(rule("/home/u/.claude/settings.json"), None);
        assert_eq!(rule("project/settings.json"), None);
        // DSH artifacts and everything else carry no user model settings.
        assert_eq!(rule("dsh/.agent-presets/my-workbench/preset.yml"), None);
        assert_eq!(
            rule("dsh/.agent-presets/my-workbench/lane-plugin/package.json"),
            None
        );
        assert_eq!(rule("dsh/profiles/web/cordis.patch.yml"), None);
        assert_eq!(rule(".opencode/package.json"), None);
        assert_eq!(rule("agents.md"), None); // parent is not `agents`
    }

    #[test]
    fn stub_destinations_match_the_four_seed_paths_only() {
        let is_stub = |p: &str| is_json_stub_dest(Path::new(p));
        assert!(is_stub(".claude/settings.json"));
        assert!(is_stub("/home/u/.claude/settings.json"));
        assert!(is_stub(".opencode/opencode.jsonc"));
        assert!(is_stub("/home/u/.config/opencode/opencode.jsonc"));
        // Everywhere else these names are not seed destinations.
        assert!(!is_stub("project/settings.json"));
        assert!(!is_stub("dsh/profiles/web/settings.json"));
        assert!(!is_stub("site/opencode.jsonc"));
        assert!(!is_stub("/home/u/opencode.jsonc"));
        assert!(!is_stub(".opencode/package.json"));
        assert!(!is_stub(".claude/agents/oracle.md"));
    }

    // -------------------------------------------------------- frontmatter

    #[test]
    fn frontmatter_snapshot_is_per_key_in_old_file_order() {
        // Both keys, saved in OLD-FILE order (effort line precedes model).
        let text = "---\nname: oracle\neffort: high\nmodel: custom/pinned\n---\nbody\n";
        let saved = snapshot_frontmatter_keys(text, CLAUDE_AGENT_KEYS);
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].key, "effort");
        assert_eq!(saved[0].line, "effort: high");
        assert_eq!(saved[1].key, "model");
        assert_eq!(saved[1].line, "model: custom/pinned");
        // Only the keys of the destination's backend are saved: a zcode file's
        // `effort` line is not a claude setting, and vice versa.
        let text = "---\nmodel: m\nthoughtLevel: max\nvariant: max\n---\n";
        assert_eq!(snapshot_frontmatter_keys(text, ZCODE_AGENT_KEYS).len(), 2);
        assert_eq!(snapshot_frontmatter_keys(text, CLAUDE_AGENT_KEYS).len(), 1);
        assert_eq!(snapshot_frontmatter_keys(text, OPENCODE_AGENT_KEYS).len(), 2);
        // The FIRST line per key wins.
        let text = "---\nmodel: one\nmodel: two\n---\n";
        let saved = snapshot_frontmatter_keys(text, CLAUDE_AGENT_KEYS);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].line, "model: one");
        // Leading whitespace stays part of the saved line.
        let text = "---\n  model: one\n---\n";
        assert_eq!(snapshot_frontmatter_keys(text, CLAUDE_AGENT_KEYS)[0].line, "  model: one");
        // Near misses do not match: wrong key, key with inner space, bare key.
        let text = "---\nmodels: x\nmodel :x\nmodel\n---\n";
        assert!(snapshot_frontmatter_keys(text, CLAUDE_AGENT_KEYS).is_empty());
        // No frontmatter block / unclosed block / model line only in the body.
        for text in ["model: y\n", "---\nmodel: y\n", "---\nname: x\n---\nmodel: y\n"] {
            assert!(snapshot_frontmatter_keys(text, CLAUDE_AGENT_KEYS).is_empty());
        }
    }

    #[test]
    fn frontmatter_restore_is_per_key_independent() {
        // Replace one, insert the other: the render's model line is replaced
        // while the absent effort line is inserted before the closing fence.
        let render = "---\nname: oracle\ntools: Read\nmodel: opus\n---\nbody\n";
        let saved = snapshot_frontmatter_keys(
            "---\nmodel: custom/pinned\neffort: high\n---\n",
            CLAUDE_AGENT_KEYS,
        );
        assert_eq!(
            restore_frontmatter_keys(&saved, render),
            "---\nname: oracle\ntools: Read\nmodel: custom/pinned\neffort: high\n---\nbody\n"
        );
        // Per-key independence: a model-only save still restores model on a
        // render that carries thoughtLevel; a thoughtLevel-only save inserts
        // without touching the render's model line.
        let render = "---\nname: oracle\nmodel: inherit\n---\n";
        let saved =
            snapshot_frontmatter_keys("---\nmodel: pinned\n---\n", ZCODE_AGENT_KEYS);
        assert_eq!(
            restore_frontmatter_keys(&saved, render),
            "---\nname: oracle\nmodel: pinned\n---\n"
        );
        let render = "---\nname: oracle\nmodel: inherit\n---\n";
        let saved = snapshot_frontmatter_keys(
            "---\nthoughtLevel: max\n---\n",
            ZCODE_AGENT_KEYS,
        );
        assert_eq!(
            restore_frontmatter_keys(&saved, render),
            "---\nname: oracle\nmodel: inherit\nthoughtLevel: max\n---\n"
        );
        // Insert into an empty block (the closing fence is line 2); two saved
        // lines insert in saved order.
        let saved = snapshot_frontmatter_keys(
            "---\nmodel: x\nvariant: max\n---\n",
            OPENCODE_AGENT_KEYS,
        );
        assert_eq!(
            restore_frontmatter_keys(&saved, "---\n---\nbody\n"),
            "---\nmodel: x\nvariant: max\n---\nbody\n"
        );
        // A render without a frontmatter block is returned unchanged.
        assert_eq!(
            restore_frontmatter_keys(&saved, "body only\n"),
            "body only\n"
        );
        // Absent: an unclosed block is returned unchanged too.
        let unclosed = "---\nname: x\n";
        assert_eq!(restore_frontmatter_keys(&saved, unclosed), unclosed);
        // Only the FIRST matching line per key is replaced.
        let render = "---\nmodel: a\nmodel: b\n---\n";
        let saved = snapshot_frontmatter_keys("---\nmodel: kept\n---\n", CLAUDE_AGENT_KEYS);
        assert_eq!(
            restore_frontmatter_keys(&saved, render),
            "---\nmodel: kept\nmodel: b\n---\n"
        );
    }

    // -------------------------------------------------- JSONC scan details

    fn root_member_value(text: &str, key: &str) -> Option<String> {
        let (tokens, _close, members) = parse_jsonc_root(text)?;
        let member = members.iter().find(|m| m.key == key)?;
        Some(text[tokens[member.start].start..tokens[member.end].end].to_owned())
    }

    #[test]
    fn jsonc_scan_details_match_the_cli_scanner() {
        // A line comment at end-of-input without a newline is still a comment.
        assert!(parse_jsonc_root("{\"model\": 1 // tail").is_none());
        // Escaped quotes and backslashes inside strings.
        let text = "{\"model\": \"a\\\"b\", \"x\": \"\\\\\"}";
        assert_eq!(root_member_value(text, "model").unwrap(), "\"a\\\"b\"");
        // Atoms run up to whitespace, structural chars, quotes and comments.
        assert_eq!(root_member_value("{\"model\": 1.5e-3}", "model").unwrap(), "1.5e-3");
        assert_eq!(root_member_value("{\"model\": true}", "model").unwrap(), "true");
        // Comments between tokens are skipped; trailing whitespace before the
        // terminator is excluded from the span.
        let text = "{ /* head */ \"model\" /* k */ : /* v */ 123 /* after */ , \"x\": 1 }";
        assert_eq!(root_member_value(text, "model").unwrap(), "123");
        // Nested objects with their own keys of the same name are NOT the
        // top-level one.
        assert!(root_member_value("{\"agent\": {\"model\": \"inner\"}}", "model").is_none());
        // `\r` is ordinary whitespace to the scanner.
        assert_eq!(
            root_member_value("{\r\n  \"model\": \"x\"\r\n}\r\n", "model").unwrap(),
            "\"x\""
        );
    }

    #[test]
    fn jsonc_malformed_documents_do_not_parse() {
        for text in [
            "{\n  \"model\": \"unterminated\n}\n",
            "{\n  /* unterminated\n}\n",
            "{\n  \"model\": \"x\"\n",          // unbalanced braces
            "[\"not\", \"an\", \"object\"]\n", // root is not an object
            "{} trailing\n",                   // tokens after the root closes
            "{}{}",                            // two root objects
            "{\"model\": ,}\n",                // empty value
            "{model: 1}\n",                    // bare-word key is not a string
        ] {
            assert!(parse_jsonc_root(text).is_none(), "text: {text:?}");
            assert!(stub_owned_members(text).is_none(), "text: {text:?}");
            assert_eq!(
                reconcile_owned_key("agent", "\"x\"", "\"agent\": \"x\"", text),
                None,
                "text: {text:?}"
            );
        }
    }

    // --------------------------------------------------- stub ownership

    #[test]
    fn owned_keys_are_derived_from_the_stub_never_hardcoded() {
        // The actual settings stub owns exactly `agent`.
        let owned = stub_owned_members("{\n  \"agent\": \"orchestrator\"\n}\n").unwrap();
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].key, "agent");
        assert_eq!(owned[0].value, "\"orchestrator\"");
        assert_eq!(owned[0].member, "\"agent\": \"orchestrator\"");
        // The actual opencode stub owns exactly `$schema`.
        let owned =
            stub_owned_members("{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n")
                .unwrap();
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].key, "$schema");
        assert_eq!(owned[0].member, "\"$schema\": \"https://opencode.ai/config.json\"");
        // A multi-key stub derives every key, first occurrence per key.
        let owned = stub_owned_members(
            "{\n  \"a\": 1,\n  \"b\": \"x\",\n  \"a\": \"second\"\n}\n",
        )
        .unwrap();
        assert_eq!(owned.len(), 2);
        assert_eq!(owned[0].key, "a");
        assert_eq!(owned[0].value, "1");
        assert_eq!(owned[1].key, "b");
        // An unparseable stub (packaging bug) derives nothing.
        assert!(stub_owned_members("{ broken").is_none());
    }

    #[test]
    fn reconcile_replaces_only_the_value_span() {
        // The user's key spelling, member spacing and surrounding comments
        // survive; only the value span is reset to the canonical value.
        let text = "{\n  // config\n  \"agent\"  :  \"user-pinned\" , // keep\n  \"model\": \"sonnet\"\n}";
        assert_eq!(
            reconcile_owned_key("agent", "\"orchestrator\"", "\"agent\": \"orchestrator\"", text).unwrap(),
            "{\n  // config\n  \"agent\"  :  \"orchestrator\" , // keep\n  \"model\": \"sonnet\"\n}"
        );
        // The FIRST occurrence wins; duplicates stay untouched.
        let text = "{\"agent\": \"first\", \"agent\": \"second\"}";
        assert_eq!(
            reconcile_owned_key("agent", "\"canonical\"", "\"agent\": \"canonical\"", text).unwrap(),
            "{\"agent\": \"canonical\", \"agent\": \"second\"}"
        );
        // Any value shape is span-replaced (an object here).
        let text = "{\n  \"agent\": { \"old\": true }\n}";
        assert_eq!(
            reconcile_owned_key("agent", "\"orchestrator\"", "\"agent\": \"orchestrator\"", text).unwrap(),
            "{\n  \"agent\": \"orchestrator\"\n}"
        );
    }

    #[test]
    fn reconcile_inserts_the_full_member_span_before_the_closing_brace() {
        // Non-empty root: `,\n  ` prefix, after the whitespace run that
        // precedes the closing brace.
        let text = "{\n  \"model\": \"sonnet\"\n}\n";
        assert_eq!(
            reconcile_owned_key("agent", "\"orchestrator\"", "\"agent\": \"orchestrator\"", text).unwrap(),
            "{\n  \"model\": \"sonnet\",\n  \"agent\": \"orchestrator\"\n}\n"
        );
        // A comment breaks the whitespace run: insertion lands after it.
        let text = "{ \"a\": 1 /* keep */ }";
        assert_eq!(
            reconcile_owned_key("agent", "\"orchestrator\"", "\"agent\": \"orchestrator\"", text).unwrap(),
            "{ \"a\": 1 /* keep */,\n  \"agent\": \"orchestrator\" }"
        );
        // Empty root: no comma.
        assert_eq!(
            reconcile_owned_key("agent", "\"orchestrator\"", "\"agent\": \"orchestrator\"", "{}").unwrap(),
            "{\n  \"agent\": \"orchestrator\"}"
        );
        // Compact root: the member butts against the brace.
        assert_eq!(
            reconcile_owned_key("agent", "\"orchestrator\"", "\"agent\": \"orchestrator\"", "{\"a\":1}").unwrap(),
            "{\"a\":1,\n  \"agent\": \"orchestrator\"}"
        );
    }

    #[test]
    fn reconcile_stub_end_to_end_against_disk() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join(".claude").join("settings.json");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let stub = b"{\n  \"agent\": \"orchestrator\"\n}\n";

        // Not on disk yet: reads fail → untouched (a create writes the stub
        // through the plain-copy path instead).
        assert!(reconcile_stub(&dest, stub).is_none());

        // User file with the owned key's value changed: reset to canonical,
        // every other byte (env with secret-looking values, comments) intact.
        let user = "{\n  // user comment\n  \"agent\": \"user-pinned\",\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-user-example\"\n  }\n}\n";
        std::fs::write(&dest, user).unwrap();
        let out = reconcile_stub(&dest, stub).unwrap();
        assert_eq!(
            &*out,
            &b"{\n  // user comment\n  \"agent\": \"orchestrator\",\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-user-example\"\n  }\n}\n"[..]
        );

        // User file without the owned key: the full member span is inserted.
        std::fs::write(&dest, "{\n  \"model\": \"sonnet\"\n}\n").unwrap();
        let out = reconcile_stub(&dest, stub).unwrap();
        assert_eq!(
            &*out,
            &b"{\n  \"model\": \"sonnet\",\n  \"agent\": \"orchestrator\"\n}\n"[..]
        );

        // A destination that is not a stub destination is never reconciled.
        let plain = dir.path().join("settings.json");
        std::fs::write(&plain, "anything").unwrap();
        assert!(reconcile_stub(&plain, stub).is_none());

        // Malformed user content: untouched (None).
        std::fs::write(&dest, "{ broken").unwrap();
        assert!(reconcile_stub(&dest, stub).is_none());

        // Non-UTF-8 user content: untouched (None).
        std::fs::write(&dest, [0x7b, 0x80, 0x7d]).unwrap();
        assert!(reconcile_stub(&dest, stub).is_none());

        // Malformed stub (packaging bug): untouched (None).
        std::fs::write(&dest, "{\n  \"agent\": \"x\"\n}\n").unwrap();
        assert!(reconcile_stub(&dest, b"{ broken").is_none());
    }

    // ------------------------------------------------------- the entry fn

    #[test]
    fn preserve_model_settings_end_to_end_against_disk() {
        let dir = tempfile::tempdir().unwrap();
        // The rule keys off the grandparent directory: a claude destination.
        let dest = dir.path().join(".claude").join("agents").join("oracle.md");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();

        // Not on disk yet (a create, not an overwrite): nothing to preserve.
        let fresh = b"---\nmodel: opus\n---\nbody\n";
        let out = overwrite_bytes(&dest, fresh).unwrap();
        assert_eq!(&*out, &fresh[..]);

        // User-retuned file on disk: model replaced, effort inserted.
        std::fs::write(&dest, "---\nmodel: custom/pinned\neffort: high\n---\nold body\n").unwrap();
        let out = overwrite_bytes(&dest, fresh).unwrap();
        assert_eq!(
            &*out,
            &b"---\nmodel: custom/pinned\neffort: high\n---\nbody\n"[..]
        );

        // A destination with no rule gets the fresh bytes as-is.
        let plain = dir.path().join("preset.yml");
        std::fs::write(&plain, "model: anything\n").unwrap();
        let out = overwrite_bytes(&plain, b"fresh\n").unwrap();
        assert_eq!(&*out, &b"fresh\n"[..]);

        // Non-UTF-8 existing bytes at a frontmatter destination: no-op, the
        // fresh bytes win (only the stub regime refuses to write).
        let bin = dir.path().join(".claude").join("agents").join("binary.md");
        std::fs::write(&bin, [0x66, 0x6f, 0x80, 0x6f]).unwrap();
        let fresh = b"---\nmodel: opus\n---\n";
        let out = overwrite_bytes(&bin, fresh).unwrap();
        assert_eq!(&*out, &fresh[..]);
    }

    #[test]
    fn overwrite_bytes_reconciles_stub_destinations_from_the_stub() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join(".opencode").join("opencode.jsonc");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let stub = b"{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";

        // User content with the owned key changed: only the value span resets.
        std::fs::write(&dest, "{\n  // mine\n  \"$schema\": \"https://example.com/user.json\",\n  \"model\": \"custom/oc\"\n}\n").unwrap();
        let out = overwrite_bytes(&dest, stub).unwrap();
        assert_eq!(
            &*out,
            &b"{\n  // mine\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"model\": \"custom/oc\"\n}\n"[..]
        );

        // Malformed user content under force: the file is left COMPLETELY
        // untouched — None means the engine never writes.
        std::fs::write(&dest, "TAMPERED\n").unwrap();
        assert!(overwrite_bytes(&dest, stub).is_none());
    }
}
