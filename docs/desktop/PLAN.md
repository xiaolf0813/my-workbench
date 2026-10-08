# PLAN — the Tauri desktop GUI (deployment + skill management)

> **STATUS: plan locked, not implemented.** All decision locks below were made by the
> user before any implementation. Milestones M0–M3 describe future work; nothing in
> this plan exists in the tree yet. Where this document and future code disagree, the
> code wins, and this document gets amended the way `../dsh-lane-plugin/PLAN.md` was.

## Decision locks

| # | Locked | Effect on this plan |
| --- | --- | --- |
| 1 | **Rust native port** of the CLI engine (not a Node sidecar) | `workbench-core` is a pure Rust library; no Node runtime ships with the app |
| 2 | **The DSH plugin stays authored JavaScript** | `lane-plugin/`, `lane-plugin-ui/` and `agent.cordis.yml` are rendered and copied, never rewritten; see §3 |
| 3 | **Skills: GitHub public/private repos only** | No skills.sh / open-ecosystem index integration; sources are user-added `owner/repo` refs |
| 4 | **Frontend: React + Vite + TypeScript** | `ui/` scaffold; visual design is commissioned from the designer lane before page implementation |
| 5 | **The Node CLI stays, unchanged** | Same content source, same behaviour, its JS-executing assemble validators included |
| 6 | **Tier 2 checks use the local Node only** | No Node-free engine ever (the former M3 item is cut). Missing Node → explicit "Tier 2 skipped" notice, never a block |
| 7 | **GUI covers consumers AND custom-source maintainers** | Health check incl. Tier 2 and custom-source pre-install validation are GUI features; the CLI remains the authoritative source-maintenance tool (repo-internal `assemble` regeneration, release gate) |

## 1. Goals and non-goals

Two features in one Tauri 2 desktop app:

1. **Deployment** — the existing multi-agent orchestration install, GUI-driven, semantically identical to the CLI.
2. **Skill management** — install / update / delete skills from GitHub repositories into `~/.agents/skills/`.

Non-goals: rewriting the DSH plugin in Rust (lock 2), skills.sh integration (lock 3), replacing the CLI (lock 5), any network behaviour in the deployment path (the CLI downloads nothing and the GUI keeps that invariant).

## 2. Architecture

```
my-workbench/                  # single repo (monorepo)
├── agents/                    # UNCHANGED: the only content source
├── bin/                       # UNCHANGED: Node CLI
├── test/                      # existing suite + golden fixtures (§6)
├── crates/workbench-core/     # Rust library: the ported engine + skill manager.
│                              #   No tauri dependency — usable by tests and any host
├── src-tauri/                 # Tauri 2 shell: IPC wiring only, no business logic
├── ui/                        # Vite + React + TS frontend
└── .github/workflows/desktop.yml  # three-platform build matrix, tag-triggered
```

- Cargo workspace at the repo root: `members = ["crates/*", "src-tauri"]`.
- The `agents/` tree ships inside the installer as **Tauri resources** — that is the GUI's bundled content source.
- **Version alignment**: npm package and desktop installers are released from the same tag with the same version; the embedded source version is visible in the GUI (About / health-check page).
- `package.json`'s `files` whitelist is untouched, so the npm tarball never contains the GUI.

## 3. The DSH constraint, split three ways

Lock 2 ("the DSH plugin stays Node") resolves to a precise split:

| DSH artifact | Nature | Destination |
| --- | --- | --- |
| `agents/backends/dsh/lane-plugin/**`, `lane-plugin-ui/**`, `agent.cordis.yml` | The plugin itself, runs inside DSH's module loader | **Stays JavaScript, byte-for-byte.** Rust only renders templates (`__MY_WORKBENCH_LANES__` marker, `{{dep:…}}` substitution) and copies files, exactly as the CLI does |
| Render/install logic: `lanes.json` validation, roster/prompts rendering, the `cordis.patch.yml` managed block (`writeLaneUiPatchRow`), `findProfileDirs`, `dsh-deps.js` dependency resolution (PATH shims, realpath walk, `file:` URL baking) | Pure file/JSON operations, no JS execution | **Ported to Rust.** `dsh-deps.js` never executes code; the existing `test/dsh-deps.test.js` is its port spec |
| The three execution-state self-checks: `syntaxProblem` (`node --check` on three authored JS files), `laneUiHostProblem` (dynamic `import()` of the inert host half), `lanePromptsProblem` (`import()` of the rendered prompts module from a `data:` URL) | Developer self-checks against bad escaping / broken modules; they live in `assemble --check`, NOT in the plain install path | **GUI health check, Tier 2, via the local Node** (lock 6). The CLI keeps running them unchanged |

`roster.generated.js` / `prompts.generated.js` remain generated JS modules; Rust writes the strings, golden tests (§6) prove the bytes.

## 4. Feature 1 — deployment

### Target matrix (GUI ⇄ CLI, no new semantics)

| GUI control | CLI equivalent |
| --- | --- |
| Project directory picker | CWD; default targets opencode + claude into that project |
| Target checkboxes | `--opencode` / `--omos` (mutually exclusive — the GUI disables the combination) / `--zcode` / `--dsh` / `--openbitfun` |
| User-level toggle | `--user` (`~/.config/opencode` + `~/.claude`, etc.) |
| Overwrite toggle (default off) | `--force`; existing files are skipped otherwise |
| Health check (status area) | `assemble --check` equivalent: drift = byte compare + structural + Tier 2 |

Fixed apply order as in the CLI: opencode → omos → claude → zcode → dsh → openbitfun. The source-repo guard (don't install project targets into the source root itself) is ported.

### Content sources — two modes

- **Bundled source** (default): the `agents/` resources packed with the app. For "install the orchestration system into my project" users.
- **Local source**: a user-chosen directory containing an `agents/` tree — the "target owns the tree" workflow from the repo's AGENTS.md. Deploy and drift-check render from it.

### Core API (GUI-friendly two-phase design)

```
plan(selection, opts) -> Plan           // per file: create | skip | overwrite | managed-block; zero writes
execute(plan, opts, |event|) -> Report // streaming log/progress events; Tauri emit → frontend
check(source, dir) -> DriftReport
```

Dry-run is not a flag here; the preview pane is `plan`'s output directly.

### Health check tiers

- **Tier 1 — always available, pure Rust**: render-and-byte-compare drift, plus all structural checks (`lanePluginProblems`, `laneUiPluginProblems` export/registration/module-id/seed-allowlist checks, `agentSourceProblems`, slot accounting).
- **Tier 2 — requires local Node**: the three execution-state checks (§3), same semantics as the CLI. **Node absent → the tier is skipped with an explicit notice** ("Tier 2 skipped: no Node detected"); never blocks, never silently passes.
- **Custom-source installs validate before writing** when the DSH target is selected: Tier 2 runs on the rendered DSH artifacts first. This is deliberately stricter than the CLI install path — npm-bundled sources were pre-validated by `assemble --check` at release; a custom source has no such guarantee.

### Tauri surface

Commands: `detect_environment`, `plan_install`, `execute_install`, `check_drift`. Events: `install-log`, `install-progress`.

Capabilities (least privilege): fs scopes = the target homes (`~/.claude`, `~/.config/opencode`, `~/.zcode`, `~/.dsh`, `~/.agents`, OpenBitFun config dir) + the runtime-selected project directory; shell allowlist = `opencode --version` (detection) and `node` (Tier 2 only); http allowlist = GitHub domains (§5). No arbitrary command execution is surfaced.

### UI

Three areas — Deploy / Skills / Settings — per the information architecture agreed in discussion. Visual design (layout, hierarchy, log-stream presentation) is commissioned from the designer lane before implementation; fixer implements from that mockup. The design half precedes each milestone's page work.

## 5. Feature 2 — skill management (GitHub repos only)

- **Sources**: a configured list of `owner/repo` refs (optional branch/ref, default skill subdirectory `skills/`). Public repos need no auth; private repos need a PAT stored in the OS keyring, never on disk in plaintext.
- **Listing**: prefer an optional `skills.json` index at the repo root; fall back to the GitHub Trees API; results cached locally (the unauthenticated rate limit is 60 req/h).
- **Install**: download the codeload tarball, extract the single skill directory into the skill root — **default `~/.agents/skills/`** (the layout ZCode and the `npx skills` ecosystem already read), configurable. Record into `<root>/.workbench-skills.json`: source repo, ref, commit SHA, install time, per-file hash snapshot.
- **Update**: compare remote latest SHA → local-modification check against the install-time hash snapshot (modified skills warn and offer backup-then-force) → apply → refresh the manifest. Bulk "update all" included.
- **Delete**: confirmation → remove directory + manifest entry, optional trash backup.
- **Network allowlist**: `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com` only.

## 6. Golden anti-drift tests (hard CI gate from M1 on)

The Node CLI and `workbench-core` are two implementations of one engine; golden tests keep them byte-identical.

- **End-to-end**: CI installs via the Node CLI and via `workbench-core` into two sandbox trees, `diff -r` must be empty. Scenario matrix: default install, `--user`, `--omos`, `--zcode`, `--dsh` (fake `DSH_HOME` with multiple profiles and every managed-block shape), `--openbitfun` (fake config dir), `--force`, existing-file skip, tampered-file drift detection.
- **Renderer unit goldens**: checked-in expected output per render function, generated by the CLI and locked.
- **Escaping adversarial cases**: CJK, emoji, quotes, backslashes — the `renderLanePrompts` path embeds prompt bodies via `JSON.stringify`; serde_json's escaping must match it exactly. This is the single most fragile point of the port.
- **Windows-specific**: `dsh-deps` port tested against the existing node:test suite as spec, with fake `.cmd` / `.exe` / `.ps1` shim fixtures.

## 7. Milestones

| Phase | Contents | Exit criteria |
| --- | --- | --- |
| M0 scaffold | Monorepo layout, Cargo workspace, `ui/` scaffold, Tauri 2 shell, `desktop.yml` build matrix | Three-platform empty installers build green; `assemble --check` and `npm test` unaffected; `npm pack --dry-run` clean |
| M1 deploy | `workbench-core` port + golden gate in CI; Deploy page (both source modes, full target matrix — opencode/claude/zcode/user first, dsh/openbitfun last); health check Tier 1 + Tier 2 (local Node, skip-with-notice); custom-source pre-install validation | GUI install output byte-identical to CLI; drift check usable |
| M2 skills | Skill-repo spec doc, source management, tarball install, manifest + hash snapshots, update (modification detection + backup), delete, PAT in keyring | Full flow works against own public and private repos |
| M3 polish | Tauri updater, zh/en i18n, log export | 1.0 release |

(The former M3 item "Node-free Tier 2 engines" was cut by lock 6.)

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| serde_json vs `JSON.stringify` escaping divergence | Adversarial golden cases as a hard CI gate (§6) — highest-priority risk of the port |
| `dsh-deps.js` Windows shim/symlink resolution port | Existing node:test suite as spec + shim fixtures on the Windows CI leg |
| Desktop/npm content skew (bundled `agents/` vs npm tarball) | Same-tag dual release; embedded version surfaced in the GUI |
| GitHub rate limits / network failure | Index caching; offline fallback reads the local manifest (list/delete still work) |
| Local skill modifications overwritten by update | Hash snapshot detection + backup-before-force |
| WSL2 development | Tauri dev under WSLg; Windows installer verified on the CI matrix + a manual pass |

## 9. Responsibility split

- **GUI** = consumer features (deploy, skills) **plus** custom-source maintainers' install and health-check needs (lock 7).
- **CLI** = the authoritative content-source tool: repo-internal `assemble` regeneration (`.claude/`, `.opencode/`, version stamps) and the release gate. Its JS-executing validators never move.
- Both render from the same `agents/` single source; the golden gate is the contract between them.
