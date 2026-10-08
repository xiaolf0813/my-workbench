# AGENTS.md

`agents/` is this repository's only content source: everything else — the generated agent files, the backend assets, the installed targets — is assembled from it. Validation is `node bin/my-workbench.js assemble --check` (which also renders the DSH composition and lane plugin, and loads the settings page's inert host half) plus, for CLI changes, running the CLI. `npm test` covers DSH dependency resolution and an isolated DSH install. There is no build. Keep this file structural and lean: record where things live and what may not change, not how a mechanism works.

## Targets

| Target | Flag | Where it installs |
| --- | --- | --- |
| opencode (native) | default set | `.opencode/` — core config plus native `.opencode/agents/*.md` |
| claude | default set | `.claude/` — `settings.json` plus `.claude/agents/*.md`; omos-agnostic, identical in every target |
| omos | `--omos` | `.opencode/` project assets only; exclusive with `--opencode` |
| user level | `--user` | the same opencode/omos + claude assets under `~/.config/opencode/` + `~/.claude/` |
| zcode | `--zcode` | `~/.zcode/AGENTS.md` (the orchestrator prompt as ZCode's global instruction file) + `~/.zcode/agents/*.md` |
| dsh | `--dsh` | `<DSH_HOME>/.agent-presets/my-workbench/` (`DSH_HOME`, else `~/.dsh`); requires an existing DSH home |
| openbitfun | `--openbitfun` | `<OpenBitFun config>/agents/*.md` — Linux `~/.config/openbitfun` (`$XDG_CONFIG_HOME` respected), macOS `~/Library/Application Support/openbitfun`, Windows `%APPDATA%\openbitfun`; requires an existing OpenBitFun install |

Every target downloads nothing and writes nothing inside a project except the version stamp; existing files are skipped unless `--force`. Every install and assemble stamps `my-workbench.version` once per deployment realm (`<cwd>/my-workbench.version` for project deploys, `~/.my-workbench.version` for user-level deploys) — written unconditionally, never subject to skip/`--force`. `--upgrade` compares those stamps with the npm registry latest and, when one is behind, auto-upgrades by redeploying via `npx my-workbench@latest --force` — the one deliberate download, and it overwrites deployed files by design.

**opencode** requires an `opencode` binary on PATH. When a user-level omos install is detected, it installs the omos way instead (omits assets, no native agents) to avoid agent conflicts.

**omos** requires OpenCode **and** a pre-existing user-level omos install in `~/.config/opencode`: the plugin loads from that user level, so my-workbench never pins a `"plugin"` entry. Its `orchestrator_append.md` restates the orchestrator's role boundary (analyze, orchestrate, and review — never implement), Skill awareness, Task persistence, and worktree path discipline rules, the subagent dispatch discipline (synchronous dispatch, wait in-turn), and the Response Convention, plus the universal Disciplines (kept in sync with `agents/prompts/orchestrator.md`), for the plugin-provided omos orchestrator prompt. Task-orchestration rules (delegation contract, lane interruption) are not restated — omos has its own task orchestration.

**zcode** has no configurable main agent and no project-level subagents, so `~/.zcode/` is the whole install.

**openbitfun** is user-level only and installs nothing but the eight agent files, so `<OpenBitFun config>/agents/` is the whole install; it requires an existing OpenBitFun install.

**dsh** needs one deliberate exception, because the tools and the settings page mount at different levels: the preset owns the seven `subagent_*` tools and the `my-workbench-lanes` settings namespace (seeded from a recommended model mapping), while the page can only be served from a profile row — client halves are discovered on the profile loader's entries, never inside a preset, and a DSH process composes exactly one profile. `--dsh` therefore also maintains ONE marked, managed block holding one inert row in the `cordis.patch.yml` of EVERY profile it finds: no profile name is hardcoded (DSH Desktop names its own — `desktop` on the machine this was written for, beside `web` for `dsh web`), a profile being any directory under `<DSH_HOME>/profiles/` that carries `cordis.yml` or `cordis.patch.yml`, with `node_modules` never one of them. A profile-less `profiles/` gets the row printed, not guessed at, and `--dsh-profile <name>` narrows the write to one profile. `agents/backends/dsh/` and `docs/dsh-lane-plugin/` carry the details.

## Layout

| Path | Role |
| --- | --- |
| `bin/my-workbench.js`, `bin/dsh-deps.js` | The CLI and its DSH dependency resolver (zero dependencies, ESM). |
| `agents/roster.json` | Agent descriptions and backend frontmatter; the only authored agent list. |
| `agents/prompts/` | Agent prompt bodies — the single source, each opening with the omos attribution notice. |
| `agents/prompts_cn/` | Chinese reference translations of the prompt bodies — never packaged. |
| `agents/backends/<name>/` | Backend-specific assets and `slots/` for `{{slot:...}}` text. `dsh/` also has `lanes.json`, the single authored DSH lane record; `agent.cordis.yml` pulls the orchestrator body with `{{prompt:<agent>}}`, `lane-plugin/` is the packaged host half, and `lane-plugin-ui/` is the settings page. |
| `docs/` | Reference only, never shipped: the DSH lane plugin's design record (`docs/dsh-lane-plugin/`) and the agent-skill notes (`docs/agents/`). |
| `.claude/`, `.opencode/` | This repo's own live agent setup — generated, gitignored; materialize with `npx my-workbench assemble`. |
| `package.json` | npm package **`my-workbench`**; the `files` whitelist is the tarball contract. |

`.opencode/node_modules/` and `.opencode/package-lock.json` are installed runtime artifacts — never committed or packaged. A fresh clone materializes `.claude/` and `.opencode/` with `npx my-workbench assemble`.

## Single source & generated files

| Source (edit here) | Generated (do not hand-edit) |
| --- | --- |
| `agents/backends/claude/settings.json` | `.claude/settings.json` |
| `agents/backends/opencode/opencode.jsonc` | `.opencode/opencode.jsonc` |
| `agents/backends/omos/oh-my-opencode-slim.jsonc` | `.opencode/oh-my-opencode-slim.jsonc` |
| `agents/backends/omos/oh-my-opencode-slim/` | `.opencode/oh-my-opencode-slim/` |
| `agents/backends/omos/package.json` | `.opencode/package.json` |
| `agents/roster.json` + `agents/disciplines.md` + `agents/prompts/*.md` + `agents/backends/*/slots/*.md` | `.claude/agents/*.md`, target `.opencode/agents/*.md` |
| `agents/backends/dsh/lanes.json` + `agents/prompts/*.md` | installed DSH `roster.generated.js`, `prompts.generated.js`, and lane settings page roster |
| `agents/backends/zcode/`, `agents/backends/dsh/`, `agents/backends/openbitfun/` | user-level only, nothing generated inside this repo: `~/.zcode/`, `~/.dsh/.agent-presets/my-workbench/`, and `<OpenBitFun config>/agents/` |

Run `npx my-workbench assemble` in the repo root after editing any source (`--check` verifies without writing).

## Commits

- Say what changed: one sentence or a short bullet list.
- Never narrate detailed changes, background, or rationale.
- Subject on one line, each body paragraph or bullet on its own line, never a hard-wrapped body.

## Editing conventions

- **Agent prompts / roster** → edit the agent's record in `agents/roster.json` and its `agents/prompts/<agent>.md`; in the same change update `agents/prompts_cn/<agent>_cn.md`, then assemble. `assemble --check` rejects orphan prompts and missing reference translations in a source checkout. Keep the omos attribution notice that opens each adapted body verbatim and first: `stripAttribution()` drops it from every generated prompt by exact match, so an edited or moved notice ships into the delivered text. `agents/prompts/improver.md` is in-house and deliberately carries none — do not add one.
- **Backend-specific text** → `{{slot:<name>}}` in `agents/prompts/*.md`, filled from `agents/backends/<name>/slots/<name>.md`. A slot referenced by any prompt must exist for every backend or assembly fails.
- **Universal behavior rules** → `agents/disciplines.md` is the single authored copy, with `agents/disciplines_cn.md` beside it. Assembly appends the English file to every delivered agent prompt — markdown backends, DSH preset persona and DSH lane personas — so no delegation brief repeats it. One rule per concern.
- **DSH preset composition** → `agents/backends/dsh/agent.cordis.yml` is the template: the orchestrator persona plus ONE row (`- id: lanes`) naming the lane plugin with a `./`-relative `name`. A `{{prompt:<agent>}}` placeholder must stand alone on its own line.
- **DSH lane plugin (host half)** → `agents/backends/dsh/lane-plugin/`. `agents/backends/dsh/lanes.json` owns lane keys, tool names, display labels, restrictions and recommended routes. The CLI renders the host roster, browser roster and prompt module from it; each lane key must have an agent record. `tools.restrict()` rejects unknown names, so keep every lane a leaf. `assemble --check` validates the authored records and render; reinstall with `npx my-workbench --dsh`.
- **DSH lane settings page** → `agents/backends/dsh/lane-plugin-ui/`, mounted by a profile row, NOT by the preset. `src/index.js` stays inert — no tools, no services, no settings namespace — and `lib/client.js` uses only the shipped Remote wire (`ctx.remote.settings.describe()/update()`, `ctx.remote.session.modelCatalog()`), never a package-private RPC. Its registration stays SYNCHRONOUS in `apply()`. The CLI owns the profile row (`writeLaneUiPatchRow`); do not hand-edit the installed `cordis.patch.yml`. Rationale for each of these sits in `docs/dsh-lane-plugin/` and the package's own `README.md`.
- **Lane artifact identity** → the package name lives once per artifact in `bin/my-workbench.js` (`LANE_HOST_PACKAGE`, `LANE_UI_PACKAGE`) and appears in four places that must agree: that constant, the source `package.json` name, the bundle's `window.__ModuleLoader__.load({ id })`, and its `settings.section` occupant id. `assemble --check` fails on any disagreement. Both manifests' `version` is a placeholder equal to `package.json`'s version, because `--dsh` renders that field from its own version at install time and the check rejects a drift; the browser half carries the same version in its header comment, since a client package has no manifest field the shell reads. Those three files are the only installed ones that **refresh on every run** (`regenerate: true` in `writeAgent`) instead of skipping: a version frozen by skip-if-exists names the wrong release forever.
- **Bare imports in the lane plugin are forbidden** except through a `{{dep:<alias>}}` placeholder declared in `DSH_LANE_PLUGIN_DEPS` (`bin/my-workbench.js`), which `--dsh` bakes into an absolute `file:` URL at install time — a plugin under `$DSH_HOME/.agent-presets/` cannot resolve a package by name. The settings page declares no dependencies, and its browser half may only `require` the shell's nine seed modules; `assemble --check` enforces both plus the `dsh.client`/`exports["./client"]` pair DSH scans for.
- **Model / variant / council presets** → `agents/backends/omos/oh-my-opencode-slim.jsonc`. Keep JSONC parseable (comments and trailing commas allowed).
- **Prompt tuning** → append-only, via `agents/backends/omos/oh-my-opencode-slim/<agent>_append.md` (`orchestrator_append.md` is the working example). A full `<agent>.md` replacement must restate the entire bundled prompt and is a last resort.
- **Terminology**: in prose and docs, call the plugin **omos**; keep the full name `oh-my-opencode-slim` in paths and filenames.
- **No downloads**: my-workbench never pins a `"plugin"` entry and never downloads or executes anything. The omos target only copies project assets and requires a pre-existing user-level omos install; never widen it silently.

## Target projects

After `npx my-workbench`, the target owns the same tree: edit its `agents/` source and run `npx my-workbench assemble` there; `assemble --check` detects drift. Retune the model mapping to the providers and budget available in the target, and replace this root file with the target project's own instructions.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (xiaolf0813/my-workbench) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` (created lazily) + `docs/adr/`. See `docs/agents/domain.md`.
