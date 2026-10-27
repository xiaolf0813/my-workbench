# AGENTS.md

`agents/` is this repository's only content source: everything else — the generated agent files, the backend assets, the installed targets, the desktop app's bundled copy — is assembled from it. Two consumers read that source: the zero-dependency Node CLI (`bin/`) and the Tauri 2 desktop app (`src-tauri/` + `ui/`) running a pure-Rust engine port (`crates/workbench-core/`) that a golden test locks byte-identical to the CLI. Validation is `node bin/my-workbench.js assemble --check` (which also renders the DSH composition and lane plugin, and loads the settings page's inert host half) plus, for CLI changes, running the CLI; `npm test` covers DSH dependency resolution, DSH install behavior, and `--upgrade`; `npm run goldens` and `cargo test --workspace` gate the engine; `npm run desktop:dev` / `desktop:build` drive the GUI. The npm package builds nothing; the desktop app is the only build. Keep this file structural and lean: record where things live and what may not change, not how a mechanism works.

## Targets

| Target | Flag | Where it installs |
| --- | --- | --- |
| opencode (native) | default set | `.opencode/` — core config plus native `.opencode/agents/*.md` |
| claude | default set | `.claude/` — `settings.json` plus `.claude/agents/*.md`; identical in every target |
| user level | `--user` | the same opencode + claude assets under `~/.config/opencode/` + `~/.claude/` |
| zcode | `--zcode` | `~/.zcode/AGENTS.md` (the orchestrator prompt as ZCode's global instruction file) + `~/.zcode/agents/*.md` |
| ChatGPT / Codex (local) | `--chatgpt`, `--codex` | `<CODEX_HOME>/AGENTS.md` (short entrypoint), `my-workbench-orchestrator.md`, `agents/*.toml`, and `my-workbench-solutions/`; defaults to `~/.codex/`, always user-level |
| dsh | `--dsh` | `<DSH_HOME>/.agent-presets/my-workbench/` (`DSH_HOME`, else `~/.dsh`); requires an existing DSH home |

Every target downloads nothing and writes nothing inside a project except the version stamp; existing files are skipped unless `--force`, and a `--force` overwrite first snapshots and restores the user's model settings (the per-backend `model`/`effort`/`variant`/`thoughtLevel` frontmatter lines of every `agents/*.md`). The two JSON files it deploys are seed stubs, not owned files: a `--force` overwrite reconciles only the stub's own keys (derived from the stub bytes — `agent` in `.claude/settings.json`, `$schema` in `opencode.jsonc`) into an existing file and never touches any other byte of it (an unparseable file is left completely untouched). Every install and assemble stamps `my-workbench.version` once per deployment realm (`<cwd>/my-workbench.version` for project deploys, `~/.my-workbench.version` for user-level deploys) — written unconditionally, never subject to skip/`--force`. `--upgrade` compares those stamps with the npm registry latest and, when one is behind, auto-upgrades by redeploying via `npx my-workbench@latest --force` — the one deliberate download, and it overwrites deployed files by design.

**opencode** requires an `opencode` binary on PATH.

**zcode** has no configurable main agent and no project-level subagents, so `~/.zcode/` is the whole install.

**dsh** needs one deliberate exception, because the tools and the settings page mount at different levels: the preset owns the seven `subagent_*` tools and the `my-workbench-lanes` settings namespace (every lane starts on inherit-the-session-route; pin per-lane models there), while the page can only be served from a profile row — client halves are discovered on the profile loader's entries, never inside a preset, and a DSH process composes exactly one profile. `--dsh` therefore also maintains ONE marked, managed block holding one inert row in the `cordis.patch.yml` of EVERY profile it finds: no profile name is hardcoded (DSH Desktop names its own — `desktop` on the machine this was written for, beside `web` for `dsh web`), a profile being any directory under `<DSH_HOME>/profiles/` that carries `cordis.yml`, `cordis.patch.yml`, or a `package.json`, with `node_modules` never one of them; a home whose only profile directory carries none of them still uses it (the layout of a home that has run once). A profile-less `profiles/` gets the row printed, not guessed at, and `--dsh-profile <name>` narrows the write to one profile. `agents/backends/dsh/` and `docs/dsh-lane-plugin/` carry the details.

## Layout

| Path | Role |
| --- | --- |
| `bin/my-workbench.js`, `bin/dsh-deps.js` | The CLI and its DSH dependency resolver (zero dependencies, ESM). |
| `bin/codex-agent.js`, `crates/workbench-core/src/codex.rs` | Native Codex TOML rendering and model-setting preservation; the Rust module also powers deployed-agent editing. |
| `agents/roster.json` | Agent descriptions and backend frontmatter; the only authored agent list (ten agents — `ui-designer` was renamed to `designer`). |
| `agents/prompts/` | Agent prompt bodies — the single source, each opening with the omos attribution notice. |
| `agents/prompts_cn/` | Chinese reference translations of the prompt bodies — never packaged. |
| `agents/solutions/` | Platform solution guides (`*-gui-test.md`), deployed as `my-workbench-solutions/` beside each target's agents on every run; agents keep only a pointer. |
| `agents/solutions_cn/` | Chinese reference translations of the solution guides — never packaged or deployed. |
| `agents/backends/<name>/` | Backend-specific assets and `slots/` for `{{slot:...}}` text. `dsh/` also has `preset.yml` (preset-picker metadata), `lanes.json` (the single authored DSH lane record), `agent.cordis.yml` (pulls the orchestrator body with `{{prompt:<agent>}}`), `lane-plugin/` (the packaged host half), and `lane-plugin-ui/` (the settings page). |
| `crates/workbench-core/` | Pure-Rust port of the CLI's assembly/deploy engine (no Tauri dependency); `tests/golden_end_to_end.rs` is the CLI-parity gate. |
| `src-tauri/` | Tauri 2 desktop shell — IPC wiring only; bundles `agents/` as resources. |
| `ui/` | Desktop frontend **`my-workbench-ui`** (React 19 + Vite 7 + TypeScript): deploy / settings pages, typed IPC in `lib/ipc.ts`. |
| `Cargo.toml`, `Cargo.lock` | Cargo workspace root for `crates/workbench-core` and `src-tauri`. |
| `test/dsh-deps.test.js` | `npm test` — DSH dependency resolution, DSH install behavior, `--upgrade`. |
| `docs/` | Reference only, never shipped: the DSH lane plugin's design record (`docs/dsh-lane-plugin/`), the desktop mockups (`docs/desktop/mockups/`), and the agent-skill notes (`docs/agents/`). |
| `.github/workflows/` | Tag-triggered (`v*`) releases: `desktop.yml` — version check, `npm test`, `cargo test --workspace`, Tauri installers via tauri-action; `npm-publish.yml` — trusted-publisher npm publish plus the GitHub release. |
| `.claude/`, `.opencode/` | This repo's own live agent setup — generated, gitignored; materialize with `npx my-workbench assemble`. |
| `package.json` | npm package **`my-workbench`**; the `files` whitelist is the tarball contract — the tarball never contains the desktop app. |

`.opencode/node_modules/` and `.opencode/package-lock.json` are installed runtime artifacts — never committed or packaged. A fresh clone materializes `.claude/` and `.opencode/` with `npx my-workbench assemble`.

## Desktop app

- `crates/workbench-core/` is a hand-written Rust parallel of `bin/my-workbench.js` reading the same `agents/` tree — no codegen in either direction. `npm run goldens` (`cargo test -p workbench-core --test golden_end_to_end`) runs the real CLI and the Rust engine into sibling sandboxes across the default, `--user`, `--zcode`, `--dsh`, `--force`, preserve, skip, and tamper-drift scenarios and requires byte-identical output; a divergence is fixed in the engine or the CLI, never weakened in the test.
- `src-tauri/` is IPC wiring only — all deploy logic lives in workbench-core — and never spawns the JS CLI: its shell capability allowlist is exactly `opencode --version`, `node --version`, `node --check`, and `node -e`. The GUI drives deploy (plan/execute/cancel), drift checks, and the deployed-agent read/edit surface.
- The desktop app's decision locks — Rust native port, not a Node sidecar; the DSH plugin stays authored JS; React+Vite+TS frontend; the Node CLI stays unchanged; Tier-2 checks via local Node; the bundled `agents/` tree is the only deploy content source engine-wide (no custom-source capability, GUI or backend). (The plan record was deleted; its git history under `docs/desktop/PLAN.md` is the full reference.) `docs/desktop/mockups/` is the UI design contract; `ui/src/index.css` mirrors its tokens.
- Versions move together — `package.json`, `crates/workbench-core/Cargo.toml`, and `src-tauri/tauri.conf.json` are checked against the tag by `desktop.yml` and against each other by the golden test; keep `ui/package.json` in step manually.

## Single source & generated files

| Source (edit here) | Generated (do not hand-edit) |
| --- | --- |
| `agents/backends/claude/settings.json` | `.claude/settings.json` |
| `agents/backends/opencode/opencode.jsonc` | `.opencode/opencode.jsonc` |
| `agents/roster.json` + `agents/disciplines.md` + `agents/prompts/*.md` + `agents/backends/*/slots/*.md` | `.claude/agents/*.md`, target `.opencode/agents/*.md` |
| `agents/backends/dsh/lanes.json` + `agents/prompts/*.md` | installed DSH `roster.generated.js`, `prompts.generated.js`, and lane settings page roster |
| `agents/backends/zcode/`, `agents/backends/dsh/` | user-level only, nothing generated inside this repo: `~/.zcode/` and `~/.dsh/.agent-presets/my-workbench/` |
| `agents/roster.json` + `agents/prompts/*.md` + `agents/backends/codex/` | user-level only: `<CODEX_HOME>/agents/*.toml`, entrypoint and orchestration policy; never modifies `config.toml`, authentication files, or `AGENTS.override.md` |

The Rust engine is a parallel implementation, not a generated artifact — the golden test is the parity lock. Run `npx my-workbench assemble` in the repo root after editing any source (`--check` verifies without writing).

## Commits

- Say what changed: one sentence or a short bullet list.
- Never narrate detailed changes, background, or rationale.
- Subject on one line, each body paragraph or bullet on its own line, never a hard-wrapped body.

## Editing conventions

- **Agent prompts / roster** → edit the agent's record in `agents/roster.json` and its `agents/prompts/<agent>.md`; in the same change update `agents/prompts_cn/<agent>_cn.md`, then assemble. `assemble --check` rejects orphan prompts and missing reference translations in a source checkout. Keep the omos attribution notice that opens each adapted body verbatim and first: `stripAttribution()` drops it from every generated prompt by exact match, so an edited or moved notice ships into the delivered text. `agents/prompts/improver.md` is in-house and deliberately carries none — do not add one.
- **Backend-specific text** → `{{slot:<name>}}` in `agents/prompts/*.md`, filled from `agents/backends/<name>/slots/<name>.md`. A slot referenced by any prompt must exist for every backend with a `slots/` dir (claude, opencode, zcode, codex, dsh); unused slots are reported after every consumer has run. `design-skills` is designer's invoke-installed-skills rule, worded per backend.
- **ChatGPT / Codex** → standalone custom-agent TOML lives under `CODEX_HOME/agents/`; roster `frontmatter.codex` carries native TOML metadata. Prompts inherit session models by default. Force preserves top-level `model` / `model_reasoning_effort` / `model_reasoning_summary` / `model_verbosity` statements. `AGENTS.md` is a short loader; the full policy lives in `my-workbench-orchestrator.md` outside automatic discovery's size budget. Hosted ChatGPT chats and GPTs are not this target.
- **Universal behavior rules** → `agents/disciplines.md` is the single authored copy, with `agents/disciplines_cn.md` beside it. Assembly appends the English file to every delivered agent prompt — markdown backends, DSH preset persona, DSH lane personas — so no delegation brief repeats it. One rule per concern.
- **DSH preset composition** → `agents/backends/dsh/agent.cordis.yml` is the template: the orchestrator persona plus ONE row (`- id: lanes`) naming the lane plugin with a `./`-relative `name`. A `{{prompt:<agent>}}` placeholder must stand alone on its own line. `preset.yml` is the preset-picker metadata (`name`, description, `order`), byte-copied unchanged.
- **DSH lane plugin (host half)** → `agents/backends/dsh/lane-plugin/`. `agents/backends/dsh/lanes.json` owns lane keys, tool names, display labels and restrictions. The CLI renders the host roster, browser roster and prompt module from it; each lane key must have an agent record. `tools.restrict()` rejects unknown names, so keep every lane a leaf. `assemble --check` validates the authored records and render; reinstall with `npx my-workbench --dsh`. `spotter` and `driver` are deliberately not DSH lanes — they are promoted in the orchestrator prompt only, and the plugin registers the seven core delegation tools.
- **DSH lane settings page** → `agents/backends/dsh/lane-plugin-ui/`, mounted by a profile row, NOT by the preset. `src/index.js` stays inert — no tools, no services, no settings namespace — and `lib/client.js` uses only the shipped Remote wire (`ctx.remote.settings.describe()/update()`, `ctx.remote.session.modelCatalog()`), never a package-private RPC. Its registration stays SYNCHRONOUS in `apply()`. The CLI owns the profile row (`writeLaneUiPatchRow`); do not hand-edit the installed `cordis.patch.yml`. Rationale for each of these sits in `docs/dsh-lane-plugin/` and the package's own `README.md`.
- **Lane artifact identity** → the package name lives once per artifact in `bin/my-workbench.js` (`LANE_HOST_PACKAGE`, `LANE_UI_PACKAGE`) and appears in four places that must agree: that constant, the source `package.json` name, the bundle's `window.__ModuleLoader__.load({ id })`, and its `settings.section` occupant id. `assemble --check` fails on any disagreement. Both manifests' `version` is a placeholder equal to `package.json`'s version, because `--dsh` renders that field from its own version at install time and the check rejects a drift; the browser half carries the same version in its header comment, since a client package has no manifest field the shell reads. Those three files are the only installed ones that **refresh on every run** (`regenerate: true` in `writeAgent`) instead of skipping: a version frozen by skip-if-exists names the wrong release forever.
- **Bare imports in the lane plugin are forbidden** except through a `{{dep:<alias>}}` placeholder declared in `DSH_LANE_PLUGIN_DEPS` (`bin/my-workbench.js`), which `--dsh` bakes into an absolute `file:` URL at install time — a plugin under `$DSH_HOME/.agent-presets/` cannot resolve a package by name. The settings page declares no dependencies, and its browser half may only `require` the shell's nine seed modules; `assemble --check` enforces both plus the `dsh.client`/`exports["./client"]` pair DSH scans for.
- **Engine parity** → any change to the CLI's assembly or deploy behavior must land in both `bin/my-workbench.js` and `crates/workbench-core/`, proven by `npm run goldens`.
- **Desktop UI** → visual changes follow `docs/desktop/mockups/SPEC.md`; design tokens live once in `ui/src/index.css`.
- **No downloads**: my-workbench never pins a `"plugin"` entry and never downloads or executes anything.

## Target projects

After `npx my-workbench`, the target owns the same tree: edit its `agents/` source and run `npx my-workbench assemble` there; `assemble --check` detects drift. The shipped source pins no model (frontmatter is `model: inherit`, or absent); add per-agent model lines to match the providers and budget available in the target, and replace this root file with the target project's own instructions.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (xiaolf0813/my-workbench) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` (created lazily) + `docs/adr/`. See `docs/agents/domain.md`.

### GUI testing

GUI-tested target projects ship a `gui-test/` toolkit (registry + generator + thin CLI) that the driver agent operates; the protocol lives in the driver prompt, the per-platform adaptation table in `docs/agents/gui-testing.md`. Per-framework solution guides (tagging, instrumentation, registry generation) live in `agents/solutions/` and deploy as `my-workbench-solutions/` beside every target's agents.
