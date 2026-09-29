//! Skill management (PLAN.md §5): install / update / delete ZCode-style
//! skills from GitHub repositories into a skill root (default
//! `~/.agents/skills/`), with a per-file hash snapshot for safe updates.
//!
//! # Binding design constraints
//!
//! - **GitHub only, hard allowlist.** Sources are user-added `owner/repo`
//!   refs; the only hosts this module ever contacts are `api.github.com`,
//!   `codeload.github.com` and `raw.githubusercontent.com`. Every request URL
//!   is host-validated before it is issued — both here at the core layer (so
//!   even a custom [`GitHubClient`] is constrained) and again inside the
//!   production [`UreqGitHubClient`], which re-validates every redirect hop.
//! - **The PAT never leaks.** The token arrives as an `Option<&str>`
//!   parameter, is only forwarded as an `Authorization: Bearer` header, and is
//!   redacted from every error this module produces. It is never logged,
//!   written to disk or echoed back. Keyring storage is the shell's job
//!   (SPEC.md §6.2).
//! - **All HTTP is injectable.** Everything testable goes through the
//!   [`GitHubClient`] trait; [`UreqGitHubClient`] (10 s timeout, blocking,
//!   allowlist-checked redirects) is the only implementation that touches the
//!   network. Tests inject fixture responses and fixture tarballs built
//!   in-process with `tar` + `flate2` — the suite is fully offline.
//! - **Stateless core.** Caching, offline mode and config-directory placement
//!   are the SHELL's job (SPEC.md §5.4, PLAN.md §5 "results cached locally").
//!   This module touches only the paths it is given — the skill root plus a
//!   per-run `.workbench-tmp-<name>` staging directory inside it — and keeps
//!   no process-global state.
//!
//! # Manifest
//!
//! `<root>/.workbench-skills.json`:
//!
//! ```json
//! {
//!   "version": 1,
//!   "skills": {
//!     "<name>": {
//!       "repo": "owner/repo",
//!       "commit": "<40-hex sha>",
//!       "branch": "<requested ref, or null>",
//!       "installedAtMs": 1730000000000,
//!       "files": { "<relpath>": "<sha256 hex>" }
//!     }
//!   }
//! }
//! ```
//!
//! A corrupt manifest is treated as empty WITH a warning — never a panic,
//! never silent. Where a function receives a sink the warning is emitted as a
//! `Warn` log event; the sink-less [`list_installed`] / [`delete_skill`]
//! print it to stderr, the only diagnostic channel their frozen signatures
//! allow.
//!
//! # Event flow (frozen [`EventSink`] / [`InstallEvent`] vocabulary)
//!
//! Plain `Log` lines first (resolving / downloading — `total_files` is only
//! known once the tarball has been validated), then `Started`, one `Progress`
//! per extracted file, the manifest log, and `Finished` last. Cancellation is
//! cooperative and cancel-safe: extraction is staged into
//! `.workbench-tmp-<name>` and promoted with a final rename, so a cancelled
//! install/update never leaves a half-written skill directory, and an update
//! keeps the old version when cancelled (backup or not).
//!
//! # Deliberate behaviours (documented deviations from the raw brief)
//!
//! - The tarball is downloaded **by the resolved commit SHA** (not the moving
//!   ref), so the recorded commit always matches the extracted bytes.
//! - `skills.json` entries whose explicit `path` lies outside the configured
//!   subdir are filtered from listings (install extracts `<subdir>/<name>/`,
//!   so such entries could never be installed).
//! - A bare string in `skills.json` is interpreted as the skill name; its
//!   `path` is derived as `<subdir>/<name>`.
//! - [`SkillChange::LocalModified`] also lists files ADDED locally since the
//!   install (on disk but absent from the snapshot) — an update would lose
//!   those too.
//! - [`update`] on an up-to-date skill reinstalls it (the backend for the
//!   UI's 重装 button); bulk flows can pre-check with [`check_update`].
//! - An install whose tarball contains no files under `<subdir>/<name>/` is
//!   an error, not an empty success.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::{EventSink, InstallEvent, LogLevel};
use crate::WorkbenchError;

// ---------------------------------------------------------------- constants

/// Hard network allowlist (PLAN.md §5): nothing else is ever contacted.
const ALLOWED_HOSTS: [&str; 3] = [
    "api.github.com",
    "codeload.github.com",
    "raw.githubusercontent.com",
];

/// The manifest lives at the skill root (`<root>/.workbench-skills.json`).
pub const MANIFEST_FILE: &str = ".workbench-skills.json";

const MANIFEST_VERSION: u32 = 1;
/// Optional listing index at the repo ROOT (PLAN.md §5: preferred listing).
const SKILLS_INDEX_FILE: &str = "skills.json";
/// Update backups go here, as `<root>/.backups/<name>-<epoch-ms>/`.
const BACKUPS_DIR: &str = ".backups";
/// Staging directory for atomic extraction; promoted by rename on success.
const TMP_PREFIX: &str = ".workbench-tmp-";

const PHASE_INSTALL: &str = "skill-install";
const PHASE_UPDATE: &str = "skill-update";
const USER_AGENT: &str = "my-workbench-desktop (workbench-core)";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 5;
/// Safety cap for any single GitHub response body (tarballs included).
const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;

// ------------------------------------------------------------- public types

/// Where a skill comes from: `owner/repo`, an optional branch/ref, and the
/// repo subdirectory the skills live under (default `skills`; empty means the
/// repo root). This is the shell's per-source configuration record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub repo: String,
    pub r#ref: Option<String>,
    pub subdir: String,
}

impl SkillSource {
    /// The ref used in every URL: the configured one, or GitHub's `HEAD`
    /// pseudo-ref when unset.
    pub fn effective_ref(&self) -> String {
        match &self.r#ref {
            Some(r) if !r.trim().is_empty() => r.trim().to_string(),
            _ => "HEAD".to_string(),
        }
    }
}

/// One skill offered by a remote source. `path` is informational
/// (`<subdir>/<name>` for tree-derived and derived-index entries); install
/// always extracts `<subdir>/<name>/` from the tarball.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkill {
    pub name: String,
    pub path: String,
}

/// GitHub API rate-limit counters read from `x-ratelimit-*` headers when the
/// server sent them (`None` for raw.githubusercontent.com responses).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RateLimit {
    pub remaining: Option<u64>,
    pub limit: Option<u64>,
}

/// A remote listing: the index path (`from_index = true`) or the Trees API
/// fallback, plus the rate-limit counters observed on the deciding response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListing {
    pub skills: Vec<RemoteSkill>,
    pub rate: RateLimit,
    pub from_index: bool,
}

/// One installed skill as recorded in the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub name: String,
    pub repo: String,
    pub branch: Option<String>,
    pub commit: String,
    pub installed_at_ms: u64,
    pub file_count: usize,
}

/// Update verdict for one installed skill (mirrors the frozen `InstallEvent`
/// tagging style: `event` tag + kebab-case variants + camelCase fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum SkillChange {
    UpToDate,
    Updatable { new_commit: String },
    LocalModified { new_commit: String, modified: Vec<String> },
}

// ------------------------------------------------------------ HTTP plumbing

/// One GitHub HTTP response, status included (4xx/5xx are data, not errors —
/// the caller decides, e.g. the skills.json 404 → Trees API fallback).
#[derive(Debug, Clone)]
pub struct GitHubResponse {
    pub status: u16,
    /// Header name/value pairs; names lowercased by the production client.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The injectable HTTP boundary (PLAN.md §5: everything testable offline).
/// Implementations must NOT follow redirects across hosts on their own —
/// redirect handling belongs to the caller so the allowlist holds per hop.
pub trait GitHubClient: Send + Sync {
    fn get(&self, url: &str, token: Option<&str>) -> Result<GitHubResponse, WorkbenchError>;
}

/// Production [`GitHubClient`] over blocking `ureq`: 10 s timeout, redirects
/// followed manually hop-by-hop so every hop is allowlist-validated.
pub struct UreqGitHubClient {
    agent: ureq::Agent,
}

impl UreqGitHubClient {
    pub fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(REQUEST_TIMEOUT)
                .redirects(0)
                .build(),
        }
    }
}

impl Default for UreqGitHubClient {
    fn default() -> Self {
        Self::new()
    }
}

impl GitHubClient for UreqGitHubClient {
    fn get(&self, url: &str, token: Option<&str>) -> Result<GitHubResponse, WorkbenchError> {
        validate_url_host(url)?;
        let mut current = url.to_string();
        for _hop in 0..=MAX_REDIRECTS {
            let mut request = self.agent.get(current.as_str());
            request = request.set("User-Agent", USER_AGENT);
            request = request.set("Accept", "*/*");
            if let Some(token) = token {
                request = request.set("Authorization", &format!("Bearer {token}"));
            }
            let response = match request.call() {
                Ok(resp) => resp,
                // Non-2xx (and, with redirects(0), 3xx) come back as errors —
                // they are still data for the caller.
                Err(ureq::Error::Status(_, resp)) => resp,
                Err(e) => {
                    return Err(WorkbenchError::Message(format!(
                        "GitHub request to {} failed: {e}",
                        host_of(&current).unwrap_or_else(|| current.clone())
                    )));
                }
            };
            let status = response.status();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                let location = response.header("location").map(|s| s.to_string());
                match location {
                    Some(location) => {
                        current = resolve_redirect(&current, &location)?;
                        continue;
                    }
                    None => {
                        return Err(WorkbenchError::Message(
                            "GitHub redirect without a Location header".to_string(),
                        ));
                    }
                }
            }
            return read_ureq_response(response);
        }
        Err(WorkbenchError::Message(format!(
            "too many redirects (>{MAX_REDIRECTS}) starting at {url}"
        )))
    }
}

fn read_ureq_response(response: ureq::Response) -> Result<GitHubResponse, WorkbenchError> {
    let status = response.status();
    let headers: Vec<(String, String)> = response
        .headers_names()
        .into_iter()
        .filter_map(|name| response.header(&name).map(|v| (name, v.to_string())))
        .collect();
    let mut reader = response.into_reader().take(MAX_BODY_BYTES as u64 + 1);
    let mut body = Vec::new();
    reader
        .read_to_end(&mut body)
        .map_err(|e| WorkbenchError::Message(format!("failed to read the GitHub response body: {e}")))?;
    if body.len() > MAX_BODY_BYTES {
        return Err(WorkbenchError::Message(format!(
            "GitHub response exceeds the {} MiB safety cap",
            MAX_BODY_BYTES / (1024 * 1024)
        )));
    }
    Ok(GitHubResponse { status, headers, body })
}

/// Resolve one redirect target. Same-host relative locations reuse the (already
/// allowlisted) origin; everything else must be an https:// URL whose host
/// passes the allowlist.
fn resolve_redirect(current: &str, location: &str) -> Result<String, WorkbenchError> {
    let rejected = |why: &str| {
        WorkbenchError::Message(format!("refusing redirect to '{location}': {why}"))
    };
    if location.starts_with("https://") {
        validate_url_host(location)?;
        return Ok(location.to_string());
    }
    if location.starts_with("http://") {
        return Err(rejected("insecure http:// redirect"));
    }
    if location.starts_with('/') {
        let scheme_end = current
            .find("://")
            .map(|i| i + 3)
            .ok_or_else(|| rejected("unresolvable relative redirect"))?;
        let authority_end = current[scheme_end..]
            .find('/')
            .map(|i| scheme_end + i)
            .ok_or_else(|| rejected("unresolvable relative redirect"))?;
        let next = format!("{}{location}", &current[..authority_end]);
        validate_url_host(&next)?;
        return Ok(next);
    }
    Err(rejected("path-only relative redirect is not supported"))
}

/// The host portion of a URL, for error text only (never carries a token).
fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let end = rest.find('/').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// HARD ALLOWLIST (PLAN.md §5): only the three GitHub hosts, https only.
/// Userinfo (`https://token@api.github.com/`) is stripped before the check —
/// the real host is everything after the last `@`. Exact host match also
/// rejects lookalikes (`api.github.com.evil.com`) and explicit ports.
fn validate_url_host(url: &str) -> Result<(), WorkbenchError> {
    let invalid = |why: String| {
        WorkbenchError::Message(format!("rejected GitHub URL '{url}': {why}"))
    };
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| invalid("only https:// URLs are allowed".to_string()))?;
    let end = rest
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    if host.is_empty() {
        return Err(invalid("empty host".to_string()));
    }
    let host = host.to_ascii_lowercase();
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(invalid(format!(
            "host '{host}' is not in the GitHub allowlist ({})",
            ALLOWED_HOSTS.join(", ")
        )));
    }
    Ok(())
}

/// Every GitHub call from the core goes through here: allowlist check first
/// (applies to any injected client), then the client, then token redaction of
/// whatever error comes back.
fn gh_get(
    client: &dyn GitHubClient,
    url: &str,
    token: Option<&str>,
) -> Result<GitHubResponse, WorkbenchError> {
    validate_url_host(url).map_err(|e| redact_error(e, token))?;
    client.get(url, token).map_err(|e| redact_error(e, token))
}

fn redact_error(err: WorkbenchError, token: Option<&str>) -> WorkbenchError {
    match err {
        WorkbenchError::Message(text) => WorkbenchError::Message(redact_token(&text, token)),
        other => other,
    }
}

/// Replace any occurrence of the token with `***`. Applied to every error
/// this module produces from a network path; the token never appears in logs,
/// returned data, or on disk.
fn redact_token(text: &str, token: Option<&str>) -> String {
    match token {
        Some(t) if !t.is_empty() => text.replace(t, "***"),
        _ => text.to_string(),
    }
}

// ----------------------------------------------------------------- manifest

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillManifest {
    version: u32,
    skills: BTreeMap<String, ManifestEntry>,
}

impl Default for SkillManifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION,
            skills: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    repo: String,
    commit: String,
    /// The REQUESTED ref (`SkillSource::r#ref`), not the resolved branch.
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    installed_at_ms: u64,
    /// relpath (forward slashes) → sha256 hex, snapshot at install time.
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// Read the manifest. Missing file → fresh manifest, no warning. Corrupt or
/// unsupported-version manifest → fresh manifest PLUS a warning string (the
/// caller decides the channel). Never panics.
fn read_manifest(root: &Path) -> (SkillManifest, Option<String>) {
    let path = manifest_path(root);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return (SkillManifest::default(), None), // missing = fresh
    };
    match serde_json::from_slice::<SkillManifest>(&bytes) {
        Ok(manifest) if manifest.version == MANIFEST_VERSION => (manifest, None),
        Ok(manifest) => (
            SkillManifest::default(),
            Some(format!(
                "skill manifest at {} has unsupported version {} (expected {MANIFEST_VERSION}); treating as empty — installing will overwrite it",
                path.display(),
                manifest.version
            )),
        ),
        Err(e) => (
            SkillManifest::default(),
            Some(format!(
                "skill manifest at {} is corrupt ({e}); treating as empty — installing will overwrite it",
                path.display()
            )),
        ),
    }
}

/// Atomic manifest write: serialize to `<manifest>.tmp`, then rename over the
/// target (fs::rename replaces existing files on Windows too).
fn write_manifest(root: &Path, manifest: &SkillManifest) -> Result<(), WorkbenchError> {
    fs::create_dir_all(root)?;
    let path = manifest_path(root);
    let tmp = root.join(format!("{MANIFEST_FILE}.tmp"));
    let mut bytes = serde_json::to_vec_pretty(manifest)?;
    bytes.push(b'\n');
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_FILE)
}

// ------------------------------------------------------------- small helpers

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn short_sha(sha: &str) -> &str {
    &sha[..sha.len().min(8)]
}

/// Warning channel for the sink-less public functions; sink-bearing
/// operations emit `InstallEvent::Log { level: Warn }` instead.
fn warn_stderr(text: &str) {
    eprintln!("workbench-skills: warning: {text}");
}

fn log_event(sink: &dyn EventSink, level: LogLevel, text: String) {
    sink.emit(InstallEvent::Log {
        time_ms: now_ms(),
        target: None,
        level,
        text,
    });
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn rate_from(headers: &[(String, String)]) -> RateLimit {
    RateLimit {
        remaining: header_value(headers, "x-ratelimit-remaining").and_then(|v| v.parse().ok()),
        limit: header_value(headers, "x-ratelimit-limit").and_then(|v| v.parse().ok()),
    }
}

/// Turn a non-2xx response into a descriptive error. 403 + `remaining: 0`
/// gets the dedicated rate-limit text the UI's 限额 banner builds on.
fn expect_ok(resp: &GitHubResponse, what: &str) -> Result<(), WorkbenchError> {
    if (200..300).contains(&resp.status) {
        return Ok(());
    }
    let rate = rate_from(&resp.headers);
    let snippet = String::from_utf8_lossy(&resp.body[..resp.body.len().min(200)]);
    let snippet = snippet.trim();
    if resp.status == 403 && rate.remaining == Some(0) {
        return Err(WorkbenchError::Message(format!(
            "GitHub rate limit exhausted while {what} (0 of {} requests remaining); configure a PAT to raise the limit to 5,000/hour",
            rate.limit.map(|l| l.to_string()).unwrap_or_else(|| "?".to_string())
        )));
    }
    if resp.status == 404 {
        return Err(WorkbenchError::Message(format!(
            "{what}: not found (HTTP 404) — check the repository and ref"
        )));
    }
    let rate_text = match (rate.remaining, rate.limit) {
        (Some(r), Some(l)) => format!(" (rate {r}/{l})"),
        _ => String::new(),
    };
    Err(WorkbenchError::Message(format!(
        "{what}: GitHub returned HTTP {}{rate_text}; body: {snippet}",
        resp.status
    )))
}

// ------------------------------------------------------------- validation

fn validate_source(source: &SkillSource) -> Result<(), WorkbenchError> {
    validate_repo(&source.repo)?;
    if let Some(r) = &source.r#ref {
        validate_ref(r)?;
    }
    validate_subdir(&source.subdir)?;
    Ok(())
}

fn validate_repo(repo: &str) -> Result<(), WorkbenchError> {
    let invalid = || {
        WorkbenchError::Message(format!(
            "invalid skill source repository '{repo}': expected 'owner/repo'"
        ))
    };
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 {
        return Err(invalid());
    }
    for part in parts {
        if part.is_empty() || part == "." || part == ".." {
            return Err(invalid());
        }
        if !part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn validate_ref(git_ref: &str) -> Result<(), WorkbenchError> {
    let invalid = || WorkbenchError::Message(format!("invalid git ref '{git_ref}'"));
    if git_ref.is_empty()
        || git_ref.contains("..")
        || git_ref.starts_with('/')
        || git_ref.starts_with('.')
        || git_ref.ends_with('/')
        || git_ref.ends_with('.')
        || git_ref.ends_with(".lock")
        || git_ref.contains("//")
        || git_ref.contains("@{")
    {
        return Err(invalid());
    }
    if !git_ref
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+'))
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_subdir(subdir: &str) -> Result<(), WorkbenchError> {
    for segment in subdir.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(WorkbenchError::Message(format!(
                "invalid skill subdir '{subdir}': '..' is not allowed"
            )));
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(WorkbenchError::Message(format!(
                "invalid skill subdir '{subdir}': segments may only contain [A-Za-z0-9._-]"
            )));
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), WorkbenchError> {
    let invalid = || {
        WorkbenchError::Message(format!(
            "invalid skill name '{name}': must be a single directory component of \
             [A-Za-z0-9._-] and must not start with '.'"
        ))
    };
    if name.is_empty() || name == "." || name == ".." || name.starts_with('.') {
        return Err(invalid());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(invalid());
    }
    Ok(())
}

/// Normalized subdir segments: empty for the repo root; empty and "." segments
/// dropped; ".." already rejected by [`validate_subdir`].
fn subdir_parts(source: &SkillSource) -> Vec<String> {
    source
        .subdir
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(|s| s.to_string())
        .collect()
}

fn join_subdir(parts: &[String], name: &str) -> String {
    if parts.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parts.join("/"), name)
    }
}

// ------------------------------------------------------------ GitHub fetches

/// Resolve the latest commit of `<repo>` at the effective ref via the commits
/// API: `https://api.github.com/repos/<repo>/commits/<ref or HEAD>`.
fn fetch_head_commit(
    client: &dyn GitHubClient,
    source: &SkillSource,
    token: Option<&str>,
) -> Result<String, WorkbenchError> {
    let git_ref = source.effective_ref();
    let url = format!(
        "https://api.github.com/repos/{}/commits/{git_ref}",
        source.repo
    );
    let resp = gh_get(client, &url, token)?;
    expect_ok(
        &resp,
        &format!("resolving the latest commit of {} at '{git_ref}'", source.repo),
    )?;
    #[derive(Deserialize)]
    struct CommitSha {
        sha: String,
    }
    let parsed: CommitSha = serde_json::from_slice(&resp.body)
        .map_err(|e| WorkbenchError::Message(format!("unexpected commits API response: {e}")))?;
    if parsed.sha.is_empty() {
        return Err(WorkbenchError::Message(
            "commits API returned an empty sha".to_string(),
        ));
    }
    Ok(parsed.sha)
}

/// Download the codeload tarball PINNED to the resolved commit (not the moving
/// ref, so the manifest commit always matches the extracted bytes) and collect
/// the validated `<subdir>/<name>/` file set.
fn fetch_tarball_files(
    client: &dyn GitHubClient,
    source: &SkillSource,
    token: Option<&str>,
    commit: &str,
    name: &str,
) -> Result<Vec<(String, Vec<u8>)>, WorkbenchError> {
    let url = format!("https://codeload.github.com/{}/tar.gz/{commit}", source.repo);
    let resp = gh_get(client, &url, token)?;
    expect_ok(
        &resp,
        &format!("downloading the skill tarball of {} at {commit}", source.repo),
    )?;
    collect_skill_files(&resp.body, source, name)
}

// -------------------------------------------------------------- public API

/// Installed skills from the manifest, sorted by name (BTreeMap order).
/// Offline-safe: this reads ONLY the manifest — the offline listing surface of
/// PLAN.md §8 ("list/delete still work"). Entries whose name starts with `.`
/// (`.backups` and friends) are never listed.
pub fn list_installed(root: &Path) -> Result<Vec<InstalledSkill>, WorkbenchError> {
    let (manifest, warning) = read_manifest(root);
    if let Some(warning) = warning {
        warn_stderr(&warning);
    }
    let mut out = Vec::new();
    for (name, entry) in manifest.skills {
        if name.starts_with('.') {
            warn_stderr(&format!("ignoring suspicious manifest entry '{name}'"));
            continue;
        }
        out.push(InstalledSkill {
            name,
            repo: entry.repo,
            branch: entry.branch,
            commit: entry.commit,
            installed_at_ms: entry.installed_at_ms,
            file_count: entry.files.len(),
        });
    }
    Ok(out)
}

/// Remote listing (PLAN.md §5): prefer the optional `skills.json` index at the
/// repo ROOT (`https://raw.githubusercontent.com/<repo>/<ref>/skills.json`,
/// array of `{name, path}` objects or of strings); on 404/missing — or a
/// 200 body that does not parse as an index — fall back to the Trees API
/// (`https://api.github.com/repos/<repo>/git/trees/<ref or HEAD>?recursive=1`)
/// filtered to top-level directories under `<subdir>/`. The rate-limit
/// counters come from whichever response decided the result.
pub fn list_remote(
    client: &dyn GitHubClient,
    source: &SkillSource,
    token: Option<&str>,
) -> Result<SkillListing, WorkbenchError> {
    validate_source(source)?;
    let git_ref = source.effective_ref();
    let parts = subdir_parts(source);

    let index_url = format!(
        "https://raw.githubusercontent.com/{}/{}/{SKILLS_INDEX_FILE}",
        source.repo, git_ref
    );
    let index_resp = gh_get(client, &index_url, token)?;
    if index_resp.status == 200 {
        if let Some(skills) = skills_from_index(&index_resp.body, &parts) {
            return Ok(SkillListing {
                skills,
                rate: rate_from(&index_resp.headers),
                from_index: true,
            });
        }
    }

    let trees_url = format!(
        "https://api.github.com/repos/{}/git/trees/{git_ref}?recursive=1",
        source.repo
    );
    let resp = gh_get(client, &trees_url, token)?;
    expect_ok(
        &resp,
        &format!("listing skills from the tree of {} at '{git_ref}'", source.repo),
    )?;
    let parsed: TreeApiResponse = serde_json::from_slice(&resp.body)
        .map_err(|e| WorkbenchError::Message(format!("unexpected tree listing response: {e}")))?;
    if parsed.truncated {
        warn_stderr("GitHub tree listing was truncated; the skill list may be incomplete");
    }
    let skills = skill_names_from_tree(&parsed.tree, &parts)
        .into_iter()
        .map(|name| {
            let path = join_subdir(&parts, &name);
            RemoteSkill { name, path }
        })
        .collect();
    Ok(SkillListing {
        skills,
        rate: rate_from(&resp.headers),
        from_index: false,
    })
}

/// Update verdict for one installed skill: latest commit via the commits API,
/// then a sha256 re-scan of the installed files against the manifest snapshot.
pub fn check_update(
    client: &dyn GitHubClient,
    root: &Path,
    source: &SkillSource,
    name: &str,
    token: Option<&str>,
) -> Result<SkillChange, WorkbenchError> {
    validate_source(source)?;
    validate_name(name)?;
    let (manifest, warning) = read_manifest(root);
    if let Some(warning) = warning {
        warn_stderr(&warning);
    }
    let entry = manifest
        .skills
        .get(name)
        .ok_or_else(|| {
            WorkbenchError::Message(format!(
                "skill '{name}' is not installed under {} (no manifest entry)",
                root.display()
            ))
        })?
        .clone();
    let commit = fetch_head_commit(client, source, token)?;
    if entry.commit == commit {
        return Ok(SkillChange::UpToDate);
    }
    let modified = compute_modified(root, name, &entry)?;
    if modified.is_empty() {
        Ok(SkillChange::Updatable { new_commit: commit })
    } else {
        Ok(SkillChange::LocalModified {
            new_commit: commit,
            modified,
        })
    }
}

/// Files that differ from the install-time snapshot: snapshot files whose
/// current hash changed or that were deleted, PLUS files added locally since
/// the install (an update removes the directory, so those would be lost too).
fn compute_modified(
    root: &Path,
    name: &str,
    entry: &ManifestEntry,
) -> Result<Vec<String>, WorkbenchError> {
    let current = hash_installed_files(root, name)?;
    let mut modified: BTreeSet<String> = BTreeSet::new();
    for (rel, old_hash) in &entry.files {
        match current.get(rel) {
            None => {
                modified.insert(rel.clone());
            }
            Some(current_hash) if current_hash != old_hash => {
                modified.insert(rel.clone());
            }
            _ => {}
        }
    }
    for rel in current.keys() {
        if !entry.files.contains_key(rel) {
            modified.insert(rel.clone());
        }
    }
    Ok(modified.into_iter().collect())
}

/// relpath (posix) → sha256 over every file under `<root>/<name>`.
fn hash_installed_files(
    root: &Path,
    name: &str,
) -> Result<BTreeMap<String, String>, WorkbenchError> {
    let base = root.join(name);
    if !base.is_dir() {
        return Err(WorkbenchError::Message(format!(
            "skill directory {} is missing",
            base.display()
        )));
    }
    let mut out = BTreeMap::new();
    walk_and_hash(&base, &base, &mut out)?;
    Ok(out)
}

fn walk_and_hash(
    base: &Path,
    dir: &Path,
    out: &mut BTreeMap<String, String>,
) -> std::io::Result<()> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|e| e.path())
        .collect();
    entries.sort();
    for path in entries {
        // Follows symlinks like fs::read would; a dangling link surfaces as
        // an honest error.
        let meta = fs::metadata(&path)?;
        if meta.is_dir() {
            walk_and_hash(base, &path, out)?;
        } else {
            let bytes = fs::read(&path)?;
            let rel = rel_posix(base, &path);
            out.insert(rel, sha256_hex(&bytes));
        }
    }
    Ok(())
}

fn rel_posix(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Install a skill: resolve the commit SHA, download the codeload tarball
/// (pinned to that SHA), validate and extract ONLY `<subdir>/<name>/` into
/// `<root>/<name>/`, hash every file, write the manifest entry. Refuses when
/// `<root>/<name>` already exists (the caller removes it first, e.g. via
/// [`delete_skill`] for a reinstall-with-cleanup flow). Emits Log/Progress
/// events through the frozen [`EventSink`].
pub fn install(
    client: &dyn GitHubClient,
    root: &Path,
    source: &SkillSource,
    name: &str,
    token: Option<&str>,
    sink: &dyn EventSink,
) -> Result<InstalledSkill, WorkbenchError> {
    validate_source(source)?;
    validate_name(name)?;
    let dest = root.join(name);
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(WorkbenchError::Message(format!(
            "refusing to install skill '{name}': {} already exists; remove it first",
            dest.display()
        )));
    }
    run_install(client, root, source, name, token, PHASE_INSTALL, sink)
}

/// Update a skill: [`check_update`] gate first. Local modifications without
/// `force` → error listing the modified files (the UI's 检测到本地修改
/// dialog). With `backup`, the current directory is copied to
/// `<root>/.backups/<name>-<epoch-ms>/` before the re-install. Up-to-date
/// skills reinstall (the backend for the UI's 重装 button).
pub fn update(
    client: &dyn GitHubClient,
    root: &Path,
    source: &SkillSource,
    name: &str,
    force: bool,
    backup: bool,
    token: Option<&str>,
    sink: &dyn EventSink,
) -> Result<InstalledSkill, WorkbenchError> {
    validate_source(source)?;
    validate_name(name)?;
    log_event(
        sink,
        LogLevel::Info,
        format!("checking '{name}' for updates"),
    );
    match check_update(client, root, source, name, token)? {
        SkillChange::UpToDate => {
            log_event(
                sink,
                LogLevel::Info,
                format!("'{name}' is up to date; reinstalling the latest version"),
            );
        }
        SkillChange::Updatable { new_commit } => {
            log_event(
                sink,
                LogLevel::Info,
                format!(
                    "'{name}' can be updated to commit {}",
                    short_sha(&new_commit)
                ),
            );
        }
        SkillChange::LocalModified { modified, .. } => {
            if !force {
                return Err(WorkbenchError::Message(format!(
                    "skill '{name}' has local modifications; refusing to update without force. \
                     Modified files: {}. Back up and force-update from the UI to discard them.",
                    modified.join(", ")
                )));
            }
            log_event(
                sink,
                LogLevel::Warn,
                format!(
                    "'{name}' has local modifications; the force update will discard: {}",
                    modified.join(", ")
                ),
            );
        }
    }
    if backup {
        backup_existing(root, name, sink)?;
    }
    run_install(client, root, source, name, token, PHASE_UPDATE, sink)
}

/// Copy the current skill directory into `<root>/.backups/<name>-<ms>/`.
fn backup_existing(
    root: &Path,
    name: &str,
    sink: &dyn EventSink,
) -> Result<(), WorkbenchError> {
    let src = root.join(name);
    if !src.is_dir() {
        log_event(
            sink,
            LogLevel::Warn,
            format!("nothing to back up: {} is not a directory", src.display()),
        );
        return Ok(());
    }
    let backups = root.join(BACKUPS_DIR);
    fs::create_dir_all(&backups)?;
    let dest = backups.join(format!("{name}-{}", now_ms()));
    copy_dir_recursive(&src, &dest)?;
    log_event(
        sink,
        LogLevel::Info,
        format!("backed up the current skill to {}", dest.display()),
    );
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    let mut entries: Vec<PathBuf> = fs::read_dir(src)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|e| e.path())
        .collect();
    entries.sort();
    for path in entries {
        let meta = fs::metadata(&path)?; // follows symlinks
        let target = dest.join(path.file_name().unwrap_or_default());
        if meta.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

/// Delete a skill: remove (or trash) `<root>/<name>` and drop its manifest
/// entry. Missing manifest entry → the directory is still removed, with a
/// warning on stderr. Idempotent: deleting something already gone is `Ok`.
pub fn delete_skill(root: &Path, name: &str, trash: bool) -> Result<(), WorkbenchError> {
    validate_name(name)?;
    let dest = root.join(name);
    let (mut manifest, warning) = read_manifest(root);
    if let Some(warning) = warning {
        warn_stderr(&warning);
    }
    let had_entry = manifest.skills.remove(name).is_some();
    let dir_present = fs::symlink_metadata(&dest).is_ok();
    if dir_present {
        if trash {
            trash::delete(&dest).map_err(|e| {
                WorkbenchError::Message(format!(
                    "failed to move {} to the system trash: {e}",
                    dest.display()
                ))
            })?;
        } else {
            fs::remove_dir_all(&dest)?;
        }
    }
    if had_entry {
        // Directory first, manifest second: a failed removal leaves the entry
        // in place so a retry can clean it up.
        write_manifest(root, &manifest)?;
        if !dir_present {
            warn_stderr(&format!(
                "directory {} was already gone; dropped the stale manifest entry",
                dest.display()
            ));
        }
    } else {
        warn_stderr(&format!(
            "no manifest entry for skill '{name}' under {}; the directory (if any) was \
             removed and the manifest was left unchanged",
            root.display()
        ));
    }
    Ok(())
}

/// sha256 of `data` as lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

// ------------------------------------------------------- install machinery

/// Shared body of [`install`] and [`update`] (pre-validated inputs). The
/// target directory may or may not exist — [`write_extracted`] replaces it
/// only AFTER the new version extracted successfully.
fn run_install(
    client: &dyn GitHubClient,
    root: &Path,
    source: &SkillSource,
    name: &str,
    token: Option<&str>,
    phase: &str,
    sink: &dyn EventSink,
) -> Result<InstalledSkill, WorkbenchError> {
    let (mut manifest, warning) = read_manifest(root);
    if let Some(warning) = warning {
        log_event(sink, LogLevel::Warn, warning);
    }
    let git_ref = source.effective_ref();
    log_event(
        sink,
        LogLevel::Info,
        format!("resolving the latest commit of {} at '{git_ref}'", source.repo),
    );
    let commit = fetch_head_commit(client, source, token)?;
    log_event(
        sink,
        LogLevel::Info,
        format!(
            "downloading the tarball of {} at commit {}",
            source.repo,
            short_sha(&commit)
        ),
    );
    let files = fetch_tarball_files(client, source, token, &commit, name)?;
    if files.is_empty() {
        let parts = subdir_parts(source);
        return Err(WorkbenchError::Message(format!(
            "skill '{name}' not found in the tarball of {} at {} — looked under '{}'",
            source.repo,
            short_sha(&commit),
            join_subdir(&parts, name)
        )));
    }
    write_extracted(root, name, &files, phase, sink)?;

    let mut files_map = BTreeMap::new();
    for (rel, bytes) in &files {
        files_map.insert(rel.clone(), sha256_hex(bytes));
    }
    let installed_at_ms = now_ms();
    let entry = ManifestEntry {
        repo: source.repo.clone(),
        commit: commit.clone(),
        branch: source.r#ref.clone(),
        installed_at_ms,
        files: files_map,
    };
    let file_count = entry.files.len();
    manifest.skills.insert(name.to_string(), entry);
    write_manifest(root, &manifest)?;
    log_event(
        sink,
        LogLevel::Info,
        format!(
            "skill '{name}' installed at commit {} ({file_count} files)",
            short_sha(&commit)
        ),
    );
    sink.emit(InstallEvent::Finished { cancelled: false });
    Ok(InstalledSkill {
        name: name.to_string(),
        repo: source.repo.clone(),
        branch: source.r#ref.clone(),
        commit,
        installed_at_ms,
        file_count,
    })
}

/// Cancel-safe extraction: validate-then-stage. Files land in
/// `<root>/.workbench-tmp-<name>`; the final destination is only replaced by
/// rename after EVERY file was written. A cancel or write error removes the
/// staging directory and leaves the destination untouched.
fn write_extracted(
    root: &Path,
    name: &str,
    files: &[(String, Vec<u8>)],
    phase: &str,
    sink: &dyn EventSink,
) -> Result<(), WorkbenchError> {
    fs::create_dir_all(root)?;
    let dest = root.join(name);
    let tmp = root.join(format!("{TMP_PREFIX}{name}"));
    // A stale staging dir from a crashed run is ours by name pattern; clean it.
    if tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    fs::create_dir_all(&tmp)?;

    let total = files.len();
    sink.emit(InstallEvent::Started { total_files: total });
    for (done, (rel, bytes)) in files.iter().enumerate() {
        if sink.is_cancelled() {
            let _ = fs::remove_dir_all(&tmp);
            sink.emit(InstallEvent::Finished { cancelled: true });
            return Err(WorkbenchError::Message(format!(
                "skill install cancelled before writing {rel}; nothing was installed"
            )));
        }
        let target = tmp.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Err(e) = fs::write(&target, bytes) {
            let _ = fs::remove_dir_all(&tmp);
            log_event(
                sink,
                LogLevel::Error,
                format!("error writing {}: {e}", target.display()),
            );
            return Err(e.into());
        }
        log_event(
            sink,
            LogLevel::Info,
            format!("create {}", dest.join(rel).display()),
        );
        sink.emit(InstallEvent::Progress {
            phase: phase.to_string(),
            done: done + 1,
            total,
        });
    }
    if sink.is_cancelled() {
        let _ = fs::remove_dir_all(&tmp);
        sink.emit(InstallEvent::Finished { cancelled: true });
        return Err(WorkbenchError::Message(
            "skill install cancelled after writing files; nothing was installed".to_string(),
        ));
    }
    // Promotion: the old directory is replaced only after the extraction
    // fully succeeded — the window between remove and rename is not
    // cancellation-polled on purpose.
    if fs::symlink_metadata(&dest).is_ok() {
        fs::remove_dir_all(&dest)?;
    }
    fs::rename(&tmp, &dest)?;
    Ok(())
}

/// Walk the gunzipped tarball and collect the file set for
/// `<top>/<subdir>/<name>/…`. Every entry is validated BEFORE anything is
/// written: symlinks/hardlinks, absolute paths, `..` traversal and path
/// components hostile to Windows (`\`, `:`) abort the whole install. Entries
/// outside the requested skill directory are skipped.
fn collect_skill_files(
    tarball: &[u8],
    source: &SkillSource,
    name: &str,
) -> Result<Vec<(String, Vec<u8>)>, WorkbenchError> {
    let gz = GzDecoder::new(tarball);
    let mut archive = tar::Archive::new(gz);
    let mut prefix = subdir_parts(source);
    prefix.push(name.to_string());

    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let entries = archive
        .entries()
        .map_err(|e| WorkbenchError::Message(format!("the downloaded tarball is not a valid gzip/tar archive: {e}")))?;
    for entry in entries {
        let mut entry = entry
            .map_err(|e| WorkbenchError::Message(format!("unreadable tarball entry: {e}")))?;
        let entry_type = entry.header().entry_type();
        if !matches!(
            entry_type,
            tar::EntryType::Regular | tar::EntryType::Directory
        ) {
            let shown = entry
                .path()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            return Err(WorkbenchError::Message(format!(
                "refusing unsafe tarball entry '{shown}': only regular files and directories \
                 are allowed (found {entry_type:?}); symlink/hardlink entries are rejected"
            )));
        }
        let path = entry
            .path()
            .map_err(|e| WorkbenchError::Message(format!("unreadable tarball entry path: {e}")))?
            .into_owned();
        let mut components: Vec<String> = Vec::new();
        for component in path.components() {
            match component {
                Component::Normal(os) => {
                    let segment = os.to_string_lossy().into_owned();
                    if segment.contains('\\') || segment.contains(':') || segment.contains('\0') {
                        return Err(WorkbenchError::Message(format!(
                            "refusing unsafe tarball entry '{}': invalid path component '{segment}'",
                            path.display()
                        )));
                    }
                    components.push(segment);
                }
                Component::ParentDir => {
                    return Err(WorkbenchError::Message(format!(
                        "refusing unsafe tarball entry '{}': '..' path traversal is not allowed",
                        path.display()
                    )));
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(WorkbenchError::Message(format!(
                        "refusing unsafe tarball entry '{}': absolute paths are not allowed",
                        path.display()
                    )));
                }
                Component::CurDir => {}
            }
        }
        if components.is_empty() {
            continue;
        }
        // GitHub tarballs wrap everything in one top-level directory
        // ("owner-repo-ref/"); strip exactly one component.
        components.remove(0);
        if components.len() < prefix.len() || components[..prefix.len()] != prefix[..] {
            continue; // outside the requested skill
        }
        let rel = components[prefix.len()..].join("/");
        if rel.is_empty() {
            continue; // the skill directory entry itself
        }
        if entry_type == tar::EntryType::Directory {
            continue; // materialized implicitly via per-file create_dir_all
        }
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|e| WorkbenchError::Message(format!("failed to read tarball entry '{rel}': {e}")))?;
        files.push((rel, data));
    }
    Ok(files)
}

// -------------------------------------------------------------- index & tree

/// Parse the optional repo-root `skills.json`: an array of `{name, path}`
/// objects or of bare strings (bare string = the skill name; path derived as
/// `<subdir>/<name>`). Returns `None` when the body is not a recognizable
/// index (→ Trees API fallback). Entries with invalid names are skipped;
/// entries with an explicit path outside the configured subdir are skipped
/// (install extracts `<subdir>/<name>/`, so they could never be installed).
fn skills_from_index(body: &[u8], subdir_parts: &[String]) -> Option<Vec<RemoteSkill>> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let array = value.as_array()?;
    let mut by_name: BTreeMap<String, String> = BTreeMap::new();
    for item in array {
        let (name, explicit_path): (String, Option<String>) = match item {
            serde_json::Value::String(s) => (s.clone(), None),
            serde_json::Value::Object(map) => {
                let name = match map.get("name").and_then(|v| v.as_str()) {
                    Some(name) => name.to_string(),
                    None => continue,
                };
                let path = map
                    .get("path")
                    .and_then(|v| v.as_str())
                    .map(|p| p.to_string());
                (name, path)
            }
            _ => continue,
        };
        if validate_name(&name).is_err() {
            continue;
        }
        let path = match explicit_path {
            Some(path) => {
                if !subdir_parts.is_empty()
                    && !path.starts_with(&format!("{}/", subdir_parts.join("/")))
                {
                    continue;
                }
                path
            }
            None => join_subdir(subdir_parts, &name),
        };
        by_name.insert(name, path);
    }
    Some(
        by_name
            .into_iter()
            .map(|(name, path)| RemoteSkill { name, path })
            .collect(),
    )
}

#[derive(Deserialize)]
struct TreeApiResponse {
    tree: Vec<TreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

/// Top-level directories under `<subdir>/` are skills: keep `tree` entries
/// whose path starts with the subdir prefix and take the first path segment
/// below it. Blobs (plain files) never count.
fn skill_names_from_tree(entries: &[TreeEntry], subdir_parts: &[String]) -> Vec<String> {
    let prefix = if subdir_parts.is_empty() {
        String::new()
    } else {
        format!("{}/", subdir_parts.join("/"))
    };
    let mut names: BTreeSet<String> = BTreeSet::new();
    for entry in entries {
        if entry.kind != "tree" {
            continue;
        }
        let Some(rest) = entry.path.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() {
            continue; // the subdir itself
        }
        if let Some(first) = rest.split('/').next() {
            if !first.is_empty() {
                names.insert(first.to_string());
            }
        }
    }
    names.into_iter().collect()
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    const REPO: &str = "owner/repo";
    const REF: &str = "main";
    const SHA1: &str = "1111111111111111111111111111111111111111";
    const SHA2: &str = "2222222222222222222222222222222222222222";
    const TOKEN: &str = "ghp_supersecrettokenvalue123456";
    const NAME: &str = "hello";

    // ----------------------------------------------------------- fixtures

    fn source() -> SkillSource {
        SkillSource {
            repo: REPO.to_string(),
            r#ref: Some(REF.to_string()),
            subdir: "skills".to_string(),
        }
    }

    fn url_commits(git_ref: &str) -> String {
        format!("https://api.github.com/repos/{REPO}/commits/{git_ref}")
    }

    fn url_codeload(sha: &str) -> String {
        format!("https://codeload.github.com/{REPO}/tar.gz/{sha}")
    }

    fn url_index(git_ref: &str) -> String {
        format!("https://raw.githubusercontent.com/{REPO}/{git_ref}/{SKILLS_INDEX_FILE}")
    }

    fn url_trees(git_ref: &str) -> String {
        format!("https://api.github.com/repos/{REPO}/git/trees/{git_ref}?recursive=1")
    }

    fn resp(status: u16, headers: Vec<(&str, &str)>, body: Vec<u8>) -> GitHubResponse {
        GitHubResponse {
            status,
            headers: headers
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body,
        }
    }

    fn resp_json(status: u16, value: serde_json::Value) -> GitHubResponse {
        resp(status, vec![], serde_json::to_vec(&value).unwrap())
    }

    struct FixtureClient {
        routes: BTreeMap<String, GitHubResponse>,
    }

    impl GitHubClient for FixtureClient {
        fn get(&self, url: &str, _token: Option<&str>) -> Result<GitHubResponse, WorkbenchError> {
            self.routes
                .get(url)
                .cloned()
                .ok_or_else(|| WorkbenchError::Message(format!("fixture: no route for {url}")))
        }
    }

    /// Simulates a client whose error text leaks the token — the module must
    /// redact it before the error escapes.
    struct LeakingClient;

    impl GitHubClient for LeakingClient {
        fn get(&self, _url: &str, token: Option<&str>) -> Result<GitHubResponse, WorkbenchError> {
            Err(WorkbenchError::Message(format!(
                "upstream exploded: Authorization: Bearer {}",
                token.unwrap_or_default()
            )))
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
        fn events(&self) -> Vec<InstallEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    fn root_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    enum TarKind {
        File,
        Dir,
        Symlink,
    }

    struct TarEntry {
        path: String,
        data: Vec<u8>,
        kind: TarKind,
    }

    fn tf(path: &str, data: &str) -> TarEntry {
        TarEntry {
            path: path.to_string(),
            data: data.as_bytes().to_vec(),
            kind: TarKind::File,
        }
    }

    fn build_tarball(entries: &[TarEntry]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for entry in entries {
            let mut header = tar::Header::new_gnu();
            match entry.kind {
                TarKind::File => {
                    header.set_size(entry.data.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, &entry.path, entry.data.as_slice())
                        .unwrap();
                }
                TarKind::Dir => {
                    header.set_entry_type(tar::EntryType::Directory);
                    header.set_size(0);
                    header.set_mode(0o755);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, &entry.path, std::io::empty())
                        .unwrap();
                }
                TarKind::Symlink => {
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_size(0);
                    header.set_mode(0o777);
                    header.set_link_name(Path::new("target")).unwrap();
                    header.set_cksum();
                    builder
                        .append_data(&mut header, &entry.path, std::io::empty())
                        .unwrap();
                }
            }
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn v1_tarball() -> Vec<u8> {
        build_tarball(&[
            TarEntry {
                path: "owner-repo-x/README.md".to_string(),
                data: b"repo readme".to_vec(),
                kind: TarKind::File,
            },
            TarEntry {
                path: "owner-repo-x/skills/hello".to_string(),
                data: Vec::new(),
                kind: TarKind::Dir,
            },
            TarEntry {
                path: "owner-repo-x/skills/hello/lib".to_string(),
                data: Vec::new(),
                kind: TarKind::Dir,
            },
            tf("owner-repo-x/skills/hello/SKILL.md", "# hello v1\n"),
            tf("owner-repo-x/skills/hello/lib/util.txt", "util v1\n"),
            tf("owner-repo-x/skills/other/SKILL.md", "# other\n"),
        ])
    }

    fn v2_tarball() -> Vec<u8> {
        build_tarball(&[
            tf("owner-repo-x/skills/hello/SKILL.md", "# hello v2\n"),
            tf("owner-repo-x/skills/hello/lib/util.txt", "util v2\n"),
        ])
    }

    fn v1_routes() -> BTreeMap<String, GitHubResponse> {
        let mut routes = BTreeMap::new();
        routes.insert(
            url_commits(REF),
            resp_json(200, serde_json::json!({ "sha": SHA1 })),
        );
        routes.insert(url_codeload(SHA1), resp(200, vec![], v1_tarball()));
        routes
    }

    fn manifest_entry(repo: &str) -> ManifestEntry {
        ManifestEntry {
            repo: repo.to_string(),
            commit: "abc".to_string(),
            branch: None,
            installed_at_ms: 1,
            files: BTreeMap::new(),
        }
    }

    // -------------------------------------------------------- manifest tests

    #[test]
    fn manifest_roundtrip_and_corrupt_tolerance() {
        let root = root_dir();
        fs::create_dir_all(root.path()).unwrap();
        fs::write(root.path().join(MANIFEST_FILE), b"not json {{{").unwrap();

        // Corrupt → treated as empty with a warning, never a panic.
        assert_eq!(list_installed(root.path()).unwrap().len(), 0);
        let (manifest, warning) = read_manifest(root.path());
        assert!(warning.is_some(), "corrupt manifest must produce a warning");
        assert!(manifest.skills.is_empty());

        // Roundtrip preserves every field and the JSON shape.
        let mut entry = manifest_entry("o/r");
        entry.commit = "abc".to_string();
        entry.branch = Some("dev".to_string());
        entry.installed_at_ms = 42;
        entry
            .files
            .insert("SKILL.md".to_string(), "deadbeef".to_string());
        let mut written = SkillManifest::default();
        written.skills.insert("hello".to_string(), entry);
        write_manifest(root.path(), &written).unwrap();
        let (read_back, warning) = read_manifest(root.path());
        assert!(warning.is_none());
        assert_eq!(read_back, written);
        assert_eq!(read_back.version, 1);
        let raw = fs::read_to_string(root.path().join(MANIFEST_FILE)).unwrap();
        assert!(raw.contains("\"installedAtMs\""), "{raw}");
        assert!(raw.contains("\"branch\""), "{raw}");
    }

    #[test]
    fn list_installed_skips_dot_entries_and_sorts() {
        let root = root_dir();
        let mut manifest = SkillManifest::default();
        manifest
            .skills
            .insert("zzz".to_string(), manifest_entry("o/r"));
        manifest
            .skills
            .insert(".backups".to_string(), manifest_entry("o/r"));
        manifest
            .skills
            .insert("aaa".to_string(), manifest_entry("o/r"));
        write_manifest(root.path(), &manifest).unwrap();
        let listed = list_installed(root.path()).unwrap();
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["aaa", "zzz"]);
        assert_eq!(listed[0].file_count, 0);
    }

    // -------------------------------------------------------- listing tests

    #[test]
    fn list_remote_index_objects() {
        let mut routes = BTreeMap::new();
        routes.insert(
            url_index(REF),
            resp(
                200,
                vec![],
                br#"[
                    {"name": "docx", "path": "skills/docx"},
                    {"name": "xlsx", "path": "skills/xlsx"}
                ]"#
                .to_vec(),
            ),
        );
        let listing = list_remote(&FixtureClient { routes }, &source(), None).unwrap();
        assert!(listing.from_index);
        assert_eq!(listing.skills.len(), 2);
        assert_eq!(listing.skills[0].name, "docx");
        assert_eq!(listing.skills[0].path, "skills/docx");
        // raw.githubusercontent.com carries no rate-limit headers.
        assert_eq!(listing.rate, RateLimit::default());
    }

    #[test]
    fn list_remote_index_strings_derive_path() {
        let mut routes = BTreeMap::new();
        routes.insert(
            url_index(REF),
            resp(200, vec![], br#"["docx", "xlsx"]"#.to_vec()),
        );
        let listing = list_remote(&FixtureClient { routes }, &source(), None).unwrap();
        assert!(listing.from_index);
        let paths: Vec<(&str, &str)> = listing
            .skills
            .iter()
            .map(|s| (s.name.as_str(), s.path.as_str()))
            .collect();
        assert_eq!(paths, vec![("docx", "skills/docx"), ("xlsx", "skills/xlsx")]);
    }

    #[test]
    fn list_remote_index_path_outside_subdir_skipped() {
        let mut routes = BTreeMap::new();
        routes.insert(
            url_index(REF),
            resp(
                200,
                vec![],
                br#"[{"name": "a", "path": "skills/a"}, {"name": "b", "path": "tools/b"}]"#
                    .to_vec(),
            ),
        );
        let listing = list_remote(&FixtureClient { routes }, &source(), None).unwrap();
        assert!(listing.from_index);
        assert_eq!(listing.skills.len(), 1);
        assert_eq!(listing.skills[0].name, "a");
    }

    #[test]
    fn list_remote_missing_index_falls_back_to_tree() {
        let mut routes = BTreeMap::new();
        routes.insert(url_index(REF), resp(404, vec![], b"not found".to_vec()));
        routes.insert(
            url_trees(REF),
            resp(
                200,
                vec![("x-ratelimit-remaining", "42"), ("x-ratelimit-limit", "60")],
                serde_json::to_vec(&serde_json::json!({
                    "truncated": false,
                    "tree": [
                        {"path": "skills/docx", "type": "tree"},
                        {"path": "skills/docx/SKILL.md", "type": "blob"},
                        {"path": "skills/docx/scripts", "type": "tree"},
                        {"path": "skills/xlsx", "type": "tree"},
                        {"path": "README.md", "type": "blob"},
                        {"path": "tools/other", "type": "tree"}
                    ]
                }))
                .unwrap(),
            ),
        );
        let listing = list_remote(&FixtureClient { routes }, &source(), None).unwrap();
        assert!(!listing.from_index);
        let names: Vec<&str> = listing.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["docx", "xlsx"]);
        assert_eq!(listing.skills[0].path, "skills/docx");
        // Rate headers from the Trees API response surface in the listing.
        assert_eq!(listing.rate.remaining, Some(42));
        assert_eq!(listing.rate.limit, Some(60));
    }

    #[test]
    fn list_remote_broken_index_falls_back_to_tree() {
        let mut routes = BTreeMap::new();
        routes.insert(url_index(REF), resp(500, vec![], b"boom".to_vec()));
        routes.insert(
            url_trees(REF),
            resp(
                200,
                vec![],
                serde_json::to_vec(&serde_json::json!({
                    "tree": [{"path": "skills/only", "type": "tree"}]
                }))
                .unwrap(),
            ),
        );
        let listing = list_remote(&FixtureClient { routes }, &source(), None).unwrap();
        assert!(!listing.from_index);
        assert_eq!(listing.skills.len(), 1);
        assert_eq!(listing.skills[0].name, "only");
    }

    #[test]
    fn tree_filtering_top_level_dirs_with_empty_subdir() {
        let mut routes = BTreeMap::new();
        routes.insert(url_index(REF), resp(404, vec![], b"no".to_vec()));
        routes.insert(
            url_trees(REF),
            resp(
                200,
                vec![],
                serde_json::to_vec(&serde_json::json!({
                    "tree": [
                        {"path": "docx", "type": "tree"},
                        {"path": "docx/sub", "type": "tree"},
                        {"path": "loose.md", "type": "blob"},
                        {"path": "xlsx", "type": "tree"}
                    ]
                }))
                .unwrap(),
            ),
        );
        let root_source = SkillSource {
            repo: REPO.to_string(),
            r#ref: Some(REF.to_string()),
            subdir: String::new(),
        };
        let listing = list_remote(&FixtureClient { routes }, &root_source, None).unwrap();
        assert!(!listing.from_index);
        let names: Vec<&str> = listing.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["docx", "xlsx"]);
        assert_eq!(listing.skills[0].path, "docx");
    }

    // -------------------------------------------------------- install tests

    #[test]
    fn install_happy_path_files_manifest_and_events() {
        let root = root_dir();
        let client = FixtureClient {
            routes: v1_routes(),
        };
        let sink = CollectSink::default();
        let installed = install(&client, root.path(), &source(), NAME, None, &sink).unwrap();

        // Extracted files: only the `<subdir>/<name>/` prefix.
        assert_eq!(
            fs::read_to_string(root.path().join(NAME).join("SKILL.md")).unwrap(),
            "# hello v1\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join(NAME).join("lib").join("util.txt")).unwrap(),
            "util v1\n"
        );
        assert!(!root.path().join("other").exists());
        assert!(!root.path().join("README.md").exists());
        assert!(!root.path().join(".workbench-tmp-hello").exists());

        // Returned record.
        assert_eq!(installed.name, NAME);
        assert_eq!(installed.repo, REPO);
        assert_eq!(installed.branch.as_deref(), Some(REF));
        assert_eq!(installed.commit, SHA1);
        assert_eq!(installed.file_count, 2);

        // Manifest JSON shape (camelCase, version 1) + per-file hashes.
        let raw = fs::read_to_string(root.path().join(MANIFEST_FILE)).unwrap();
        assert!(raw.contains("\"version\": 1"), "{raw}");
        assert!(raw.contains("\"repo\": \"owner/repo\""), "{raw}");
        assert!(raw.contains("\"branch\": \"main\""), "{raw}");
        assert!(raw.contains("\"installedAtMs\""), "{raw}");
        assert!(
            raw.contains(&format!("\"commit\": \"{SHA1}\"")),
            "{raw}"
        );
        let (manifest, warning) = read_manifest(root.path());
        assert!(warning.is_none());
        let entry = manifest.skills.get(NAME).unwrap();
        assert_eq!(entry.files.len(), 2);
        assert_eq!(
            entry.files.get("SKILL.md").map(String::as_str),
            Some(sha256_hex(b"# hello v1\n").as_str())
        );
        assert_eq!(
            entry.files.get("lib/util.txt").map(String::as_str),
            Some(sha256_hex(b"util v1\n").as_str())
        );

        // Event flow: Logs → Started(2) → Progress×2 → … → Finished last.
        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, InstallEvent::Started { total_files: 2 })),
            "{events:?}"
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, InstallEvent::Progress { .. }))
                .count(),
            2
        );
        assert!(events.iter().all(|e| match e {
            InstallEvent::Progress { phase, .. } => phase == PHASE_INSTALL,
            _ => true,
        }));
        assert!(matches!(
            events.last(),
            Some(InstallEvent::Finished { cancelled: false })
        ));
    }

    /// Handcrafted ustar entry. tar-rs refuses to WRITE `..` paths
    /// (writer-side hardening), but a hostile archive can still contain one,
    /// so the fixture crafts the raw 512-byte header to exercise the
    /// reader-side guard in `collect_skill_files`.
    fn append_raw_entry(tar: &mut Vec<u8>, path: &str, data: &[u8]) {
        let mut header = [0u8; 512];
        assert!(path.len() <= 100, "fixture path too long for ustar name");
        header[..path.len()].copy_from_slice(path.as_bytes());
        header[100..108].copy_from_slice(b"0000644\0"); // mode
        header[108..116].copy_from_slice(b"0000000\0"); // uid
        header[116..124].copy_from_slice(b"0000000\0"); // gid
        let size_field = format!("{:011o}\0", data.len());
        header[124..136].copy_from_slice(size_field.as_bytes()); // size
        header[136..148].copy_from_slice(b"00000000000\0"); // mtime
        header[156] = b'0'; // typeflag: regular file
        header[257..263].copy_from_slice(b"ustar\0"); // magic
        header[263..265].copy_from_slice(b"00"); // version
        // Checksum over all 512 bytes with the chksum field blanked to spaces.
        let mut sum: u64 = 0;
        for (i, byte) in header.iter().enumerate() {
            sum += if (148..156).contains(&i) { 0x20 } else { *byte as u64 };
        }
        let chksum = format!("{sum:06o}\0 ");
        header[148..156].copy_from_slice(chksum.as_bytes());
        tar.extend_from_slice(&header);
        tar.extend_from_slice(data);
        let pad = (512 - data.len() % 512) % 512;
        tar.extend(std::iter::repeat_n(0u8, pad));
    }

    /// A tarball whose single entry escapes the skill directory via `..`.
    fn hostile_tarball() -> Vec<u8> {
        use std::io::Write as _;
        let mut raw = Vec::new();
        append_raw_entry(
            &mut raw,
            "owner-repo-x/skills/hello/../../../evil.txt",
            b"evil\n",
        );
        raw.extend_from_slice(&[0u8; 1024]); // end-of-archive marker
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&raw).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn install_rejects_parent_traversal_entry() {
        let root = root_dir();
        let mut routes = v1_routes();
        routes.insert(url_codeload(SHA1), resp(200, vec![], hostile_tarball()));
        let client = FixtureClient { routes };
        let sink = CollectSink::default();
        let err = install(&client, root.path(), &source(), NAME, None, &sink).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("'..'") && text.contains("traversal"), "{text}");
        // Nothing was written: validation happens before the first byte lands.
        assert!(!root.path().join(NAME).exists());
        assert!(!root.path().join("evil.txt").exists());
        assert!(!root.path().join(".workbench-tmp-hello").exists());
    }

    #[test]
    fn install_rejects_symlink_entry() {
        let root = root_dir();
        let mut routes = v1_routes();
        routes.insert(
            url_codeload(SHA1),
            resp(
                200,
                vec![],
                build_tarball(&[
                    tf("owner-repo-x/skills/hello/SKILL.md", "# hello v1\n"),
                    TarEntry {
                        path: "owner-repo-x/skills/hello/evil-link".to_string(),
                        data: Vec::new(),
                        kind: TarKind::Symlink,
                    },
                ]),
            ),
        );
        let client = FixtureClient { routes };
        let sink = CollectSink::default();
        let err = install(&client, root.path(), &source(), NAME, None, &sink).unwrap_err();
        assert!(err.to_string().contains("unsafe tarball entry"), "{err}");
        assert!(!root.path().join(NAME).exists());
    }

    #[test]
    fn install_refuses_existing_directory() {
        let root = root_dir();
        fs::create_dir_all(root.path().join(NAME)).unwrap();
        let client = FixtureClient {
            routes: BTreeMap::new(),
        };
        let err = install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
    }

    // ---------------------------------------------------- check_update tests

    #[test]
    fn check_update_up_to_date_and_updatable() {
        let root = root_dir();
        let mut client = FixtureClient {
            routes: v1_routes(),
        };
        install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap();

        assert_eq!(
            check_update(&client, root.path(), &source(), NAME, None).unwrap(),
            SkillChange::UpToDate
        );

        client.routes.insert(
            url_commits(REF),
            resp_json(200, serde_json::json!({ "sha": SHA2 })),
        );
        assert_eq!(
            check_update(&client, root.path(), &source(), NAME, None).unwrap(),
            SkillChange::Updatable {
                new_commit: SHA2.to_string()
            }
        );
    }

    #[test]
    fn check_update_local_modified_detects_tamper_and_extras() {
        let root = root_dir();
        let mut client = FixtureClient {
            routes: v1_routes(),
        };
        install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap();
        // Tamper one snapshot file and add one file the snapshot never had.
        fs::write(root.path().join(NAME).join("SKILL.md"), "# local edit\n").unwrap();
        fs::write(root.path().join(NAME).join("EXTRA.md"), "extra\n").unwrap();
        client.routes.insert(
            url_commits(REF),
            resp_json(200, serde_json::json!({ "sha": SHA2 })),
        );

        let change = check_update(&client, root.path(), &source(), NAME, None).unwrap();
        match change {
            SkillChange::LocalModified { new_commit, modified } => {
                assert_eq!(new_commit, SHA2);
                assert_eq!(modified, vec!["EXTRA.md", "SKILL.md"]);
            }
            other => panic!("expected LocalModified, got {other:?}"),
        }
    }

    // ---------------------------------------------------------- update tests

    #[test]
    fn update_creates_backup_dir() {
        let root = root_dir();
        let mut client = FixtureClient {
            routes: v1_routes(),
        };
        install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap();
        fs::write(root.path().join(NAME).join("SKILL.md"), "# local edit\n").unwrap();
        client.routes.insert(
            url_commits(REF),
            resp_json(200, serde_json::json!({ "sha": SHA2 })),
        );
        client
            .routes
            .insert(url_codeload(SHA2), resp(200, vec![], v2_tarball()));

        let sink = CollectSink::default();
        let updated = update(&client, root.path(), &source(), NAME, true, true, None, &sink).unwrap();
        assert_eq!(updated.commit, SHA2);

        // New content in place, manifest refreshed.
        assert_eq!(
            fs::read_to_string(root.path().join(NAME).join("SKILL.md")).unwrap(),
            "# hello v2\n"
        );
        let (manifest, _) = read_manifest(root.path());
        assert_eq!(manifest.skills.get(NAME).unwrap().commit, SHA2);

        // Exactly one backup, holding the MODIFIED old version.
        let backups = root.path().join(BACKUPS_DIR);
        let mut entries = fs::read_dir(&backups).unwrap();
        let backup = entries.next().unwrap().unwrap().path();
        assert!(entries.next().is_none(), "exactly one backup expected");
        assert!(
            backup
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("hello-"),
            "{backup:?}"
        );
        assert_eq!(
            fs::read_to_string(backup.join("SKILL.md")).unwrap(),
            "# local edit\n"
        );
    }

    #[test]
    fn update_force_discards_local_modifications() {
        let root = root_dir();
        let mut client = FixtureClient {
            routes: v1_routes(),
        };
        install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap();
        fs::write(root.path().join(NAME).join("SKILL.md"), "# local edit\n").unwrap();
        client.routes.insert(
            url_commits(REF),
            resp_json(200, serde_json::json!({ "sha": SHA2 })),
        );
        client
            .routes
            .insert(url_codeload(SHA2), resp(200, vec![], v2_tarball()));

        let updated = update(
            &client,
            root.path(),
            &source(),
            NAME,
            true,
            false,
            None,
            &CollectSink::default(),
        )
        .unwrap();
        assert_eq!(updated.commit, SHA2);
        assert_eq!(
            fs::read_to_string(root.path().join(NAME).join("SKILL.md")).unwrap(),
            "# hello v2\n"
        );
        // No backup was requested.
        assert!(!root.path().join(BACKUPS_DIR).exists());
    }

    #[test]
    fn update_without_force_errors_on_local_modifications() {
        let root = root_dir();
        let mut client = FixtureClient {
            routes: v1_routes(),
        };
        install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap();
        fs::write(root.path().join(NAME).join("SKILL.md"), "# local edit\n").unwrap();
        client.routes.insert(
            url_commits(REF),
            resp_json(200, serde_json::json!({ "sha": SHA2 })),
        );

        let err = update(
            &client,
            root.path(),
            &source(),
            NAME,
            false,
            true,
            None,
            &CollectSink::default(),
        )
        .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("local modifications"), "{text}");
        assert!(text.contains("SKILL.md"), "{text}");
        // The old version is untouched.
        assert_eq!(
            fs::read_to_string(root.path().join(NAME).join("SKILL.md")).unwrap(),
            "# local edit\n"
        );
    }

    #[test]
    fn update_on_up_to_date_reinstalls() {
        let root = root_dir();
        let client = FixtureClient {
            routes: v1_routes(),
        };
        install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap();
        let updated = update(
            &client,
            root.path(),
            &source(),
            NAME,
            false,
            false,
            None,
            &CollectSink::default(),
        )
        .unwrap();
        assert_eq!(updated.commit, SHA1);
        assert_eq!(
            fs::read_to_string(root.path().join(NAME).join("SKILL.md")).unwrap(),
            "# hello v1\n"
        );
    }

    // ---------------------------------------------------------- delete tests

    #[test]
    fn delete_removes_dir_and_manifest_entry() {
        let root = root_dir();
        let client = FixtureClient {
            routes: v1_routes(),
        };
        install(
            &client,
            root.path(),
            &source(),
            NAME,
            None,
            &CollectSink::default(),
        )
        .unwrap();

        delete_skill(root.path(), NAME, false).unwrap();
        assert!(!root.path().join(NAME).exists());
        let (manifest, _) = read_manifest(root.path());
        assert!(manifest.skills.is_empty());
        assert_eq!(list_installed(root.path()).unwrap().len(), 0);
    }

    #[test]
    fn delete_without_manifest_entry_still_removes_dir() {
        let root = root_dir();
        fs::create_dir_all(root.path().join(NAME)).unwrap();
        fs::write(root.path().join(NAME).join("SKILL.md"), b"x").unwrap();
        let mut manifest = SkillManifest::default();
        manifest
            .skills
            .insert("other".to_string(), manifest_entry("o/r"));
        write_manifest(root.path(), &manifest).unwrap();

        // Missing entry → still removes the directory (warning on stderr),
        // leaves the unrelated manifest entry alone. trash=true is only
        // exercised for a MISSING dir so the test never touches the OS
        // recycle bin.
        delete_skill(root.path(), NAME, false).unwrap();
        assert!(!root.path().join(NAME).exists());
        let (manifest, _) = read_manifest(root.path());
        assert!(manifest.skills.contains_key("other"));

        delete_skill(root.path(), "never-existed", true).unwrap();
        delete_skill(root.path(), NAME, false).unwrap(); // idempotent
    }

    // ------------------------------------------------------ security tests

    #[test]
    fn allowlist_rejects_non_github_hosts() {
        let client = UreqGitHubClient::new();
        let err = client.get("https://evil.example.com/x", None).unwrap_err();
        assert!(err.to_string().contains("allowlist"), "{err}");
        // Only https.
        let err = client.get("http://api.github.com/x", None).unwrap_err();
        assert!(err.to_string().contains("https"), "{err}");
        // Userinfo trick: the real host is after the last '@'.
        let err = client
            .get("https://api.github.com@evil.com/x", None)
            .unwrap_err();
        assert!(err.to_string().contains("allowlist"), "{err}");
        // Host suffix lookalike and explicit port.
        let err = client
            .get("https://api.github.com.evil.com/x", None)
            .unwrap_err();
        assert!(err.to_string().contains("allowlist"), "{err}");
        let err = client
            .get("https://api.github.com:8443/x", None)
            .unwrap_err();
        assert!(err.to_string().contains("allowlist"), "{err}");
        // The three real hosts pass (offline: validation precedes any dial).
        assert!(validate_url_host("https://API.GITHUB.com/repos/o/r").is_ok());
        assert!(validate_url_host("https://codeload.github.com/o/r/tar.gz/x").is_ok());
        assert!(
            validate_url_host("https://raw.githubusercontent.com/o/r/main/skills.json").is_ok()
        );
    }

    #[test]
    fn token_never_appears_in_errors() {
        let root = root_dir();
        let mut manifest = SkillManifest::default();
        manifest
            .skills
            .insert(NAME.to_string(), manifest_entry(REPO));
        write_manifest(root.path(), &manifest).unwrap();

        let err = check_update(&LeakingClient, root.path(), &source(), NAME, Some(TOKEN))
            .unwrap_err();
        let text = err.to_string();
        assert!(!text.contains(TOKEN), "token leaked: {text}");
        assert!(text.contains("***"), "{text}");

        let err = install(
            &LeakingClient,
            root.path(),
            &source(),
            NAME,
            Some(TOKEN),
            &CollectSink::default(),
        )
        .unwrap_err();
        assert!(!err.to_string().contains(TOKEN), "{err}");
    }

    #[test]
    fn rate_limit_exhausted_message() {
        let response = resp(
            403,
            vec![("x-ratelimit-remaining", "0"), ("x-ratelimit-limit", "60")],
            b"{}".to_vec(),
        );
        let err = expect_ok(&response, "resolving the latest commit").unwrap_err();
        let text = err.to_string();
        assert!(text.contains("rate limit"), "{text}");
        assert!(text.contains("5,000/hour"), "{text}");
        // A normal 403 keeps its own message.
        let response = resp(404, vec![], b"{}".to_vec());
        let err = expect_ok(&response, "listing skills").unwrap_err();
        assert!(err.to_string().contains("404"), "{err}");
    }
}
