# AGENTS.md

`agents/` is this repository's only content source: the generated agent files, backend assets, installed targets, and bundled Subagent Config runtime are assembled from it by the zero-dependency Node CLI (`bin/`). Validation is `node bin/my-workbench.js assemble --check` (which also renders the DSH preset declarations and lane plugin and syntax-checks its module) plus `npm test`; changes to Subagent Config also run its package-local build and tests. The npm package itself builds nothing. The retired Tauri desktop app is preserved on the `desktop` branch and is not maintained on `main`. Keep this file structural and lean: record where things live and what may not change, not how a mechanism works.

## Targets

| Target | Flag | Where it installs |
| --- | --- | --- |
| opencode (native) | default set | `.opencode/` — core config plus native `.opencode/agents/*.md` |
| claude | default set | `.claude/` — `settings.json` plus `.claude/agents/*.md`; identical in every target |
| user level | `--user` | the same opencode + claude assets under `~/.config/opencode/` + `~/.claude/` |
| zcode | `--zcode` | `~/.zcode/AGENTS.md` (the orchestrator prompt as ZCode's global instruction file) + `~/.zcode/agents/*.md` |
| ChatGPT / Codex (local) | `--chatgpt`, `--codex` | A managed loader block in the active `<CODEX_HOME>/AGENTS.override.md` or `AGENTS.md`, plus `my-workbench-orchestrator.md`, `agents/*.toml`, `my-workbench-solutions/`, and the offline `my-workbench-plugin-marketplace/` carrying Subagent Config; defaults to `~/.codex/`, always user-level |
| dsh | `--dsh` | A marked block in `<DSH_HOME>/cordis.patch.yml` declaring eight `@deepseek-ai/dsh-agent-preset` rows (orchestrator + one child preset per lane), plus `<DSH_HOME>/my-workbench/lane-plugin/`, `my-workbench-solutions/`, `presets.generated.patch.yml`, and the optional `<DSH_HOME>/my-workbench-lanes.json` (`DSH_HOME`, else `~/.dsh`); requires an existing DSH home |

Every target downloads nothing and writes nothing inside a project except the version stamp; existing files are skipped unless `--force`, and a `--force` overwrite first snapshots and restores the user's model settings (the per-backend `model`/`effort`/`thoughtLevel` frontmatter lines of every `agents/*.md`). Codex's active global AGENTS file is the deliberate exception: one marked loader block is added or refreshed while every byte outside it remains user-owned. The two JSON files it deploys are seed stubs, not owned files: a `--force` overwrite reconciles only the stub's own keys (derived from the stub bytes — `agent` in `.claude/settings.json`, `$schema` in `opencode.jsonc`) into an existing file and never touches any other byte of it (an unparseable file is left completely untouched). Every install and assemble stamps `my-workbench.version` once per deployment realm (`<cwd>/my-workbench.version` for project deploys, `~/.my-workbench.version` for shared user-level deploys, and `<CODEX_HOME>/my-workbench.version` for Codex) — written unconditionally, never subject to skip/`--force`. `--upgrade` compares those stamps with the npm registry latest and, when one is behind, auto-upgrades by redeploying via `npx my-workbench@latest --force` — the one deliberate download, and it overwrites deployed files by design.

**opencode** requires an `opencode` binary on PATH.

**zcode** has no configurable main agent and no project-level subagents, so `~/.zcode/` is the whole install.

**dsh** reads presets ONLY from declarations: an ordinary `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` is the preset's plugin list. The former `<DSH_HOME>/.agent-presets/<id>/` directory format is not read by any 0.2.x code path, and a preset child row's `name` resolves from the declaring tree (a profile), so the lane plugin is named by an absolute `file:` URL. `--dsh` maintains ONE marked, managed block in the home-level patch layer `<DSH_HOME>/cordis.patch.yml`, which DSH applies after every profile's own patch — one block serves `dsh web`, DSH Desktop, and any other profile. It declares eight presets: the orchestrator **MyWorkbench** and one child preset per lane carrying that lane's persona and restricted tool set (0.2.x has no per-request `persona`/`toolFilter`). Per-lane model pins are rendered from the user's `<DSH_HOME>/my-workbench-lanes.json` into the lane plugin row's `pins`. The target supports DSH `>= 0.2.1-rc.2 < 0.3.0` and refuses to write when no detected installation is in that window; `bin/dsh-version.js` owns detection. `agents/backends/dsh/` and `docs/dsh-lane-plugin/` carry the details.

## Layout

| Path | Role |
| --- | --- |
| `bin/my-workbench.js`, `bin/dsh-version.js` | The CLI and its DSH installation/version gate (zero dependencies, ESM). |
| `bin/codex-agent.js` | Native Codex TOML rendering and model-setting preservation. |
| `agents/backends/codex/subagent-config/` | Bundled Subagent Config source/runtime; the CLI deploys its offline marketplace and registers it through the official Codex plugin command. |
| `agents/roster.json` | Agent descriptions and backend frontmatter; the only authored agent list (eleven agents — `ui-designer` was renamed to `designer`; `intake` is user-invoked only). |
| `agents/prompts/` | Agent prompt bodies — the single source, each opening with the omos attribution notice. |
| `agents/prompts_cn/` | Chinese reference translations of the prompt bodies — never packaged. |
| `agents/solutions/` | GUI-test guides and the shared `task-queue.mjs` helper, deployed as `my-workbench-solutions/` beside each target's agents on every run. |
| `agents/solutions_cn/` | Chinese reference translations of the solution guides — never packaged or deployed. |
| `agents/backends/<name>/` | Backend-specific assets and `slots/` for `{{slot:...}}` text. `dsh/` also has `preset.json` (preset-picker metadata), `lanes.json` (the single authored DSH lane record), `orchestrator-preset.cordis.yml` (the orchestrator preset's plugin list: `{{prompt:<agent>}}` bodies and the `{{lane-plugin}}` URL), and `lane-plugin/` (the packaged, dependency-free plugin). |
| `test/*.test.js` | `npm test` — Codex deployment, DSH version gate/install/plugin behavior, preservation, and `--upgrade`. |
| `docs/` | Reference only, never shipped: the DSH lane plugin's design record (`docs/dsh-lane-plugin/`) and the agent-skill notes (`docs/agents/`). |
| `.github/workflows/` | Tag-triggered (`v*`) trusted-publisher npm release (`npm-publish.yml`). |
| `.claude/`, `.opencode/` | This repo's own live agent setup — generated, gitignored; materialize with `npx my-workbench assemble`. |
| `package.json` | npm package **`my-workbench`**; the `files` whitelist is the tarball contract. |

`.opencode/node_modules/` and `.opencode/package-lock.json` are installed runtime artifacts — never committed or packaged. A fresh clone materializes `.claude/` and `.opencode/` with `npx my-workbench assemble`.

## Single source & generated files

| Source (edit here) | Generated (do not hand-edit) |
| --- | --- |
| `agents/backends/claude/settings.json` | `.claude/settings.json` |
| `agents/backends/opencode/opencode.jsonc` | `.opencode/opencode.jsonc` |
| `agents/roster.json` + `agents/disciplines.md` + `agents/prompts/*.md` + `agents/backends/*/slots/*.md` | `.claude/agents/*.md` and `.opencode/agents/*.md` (targets receive the same files at install time) |
| `agents/backends/dsh/lanes.json` + `agents/prompts/*.md` | installed DSH `roster.generated.js` and `prompts.generated.js`; the rendered home-patch preset declarations |
| `agents/backends/zcode/`, `agents/backends/dsh/` | user-level only, nothing generated inside this repo: `~/.zcode/` and `~/.dsh/my-workbench/` plus the managed block in `~/.dsh/cordis.patch.yml` |
| `agents/roster.json` + `agents/prompts/*.md` + `agents/backends/codex/` | user-level only: `<CODEX_HOME>/agents/*.toml`, managed active-AGENTS block, orchestration policy, solutions, and offline Subagent Config marketplace/runtime; the official plugin CLI owns its `config.toml` registration changes |

Run `npx my-workbench assemble` in the repo root after editing any source (`--check` verifies without writing).

## Commits

- Say what changed: one sentence or a short bullet list.
- Never narrate detailed changes, background, or rationale.
- Subject on one line, each body paragraph or bullet on its own line, never a hard-wrapped body.

## Editing conventions

- **Agent prompts / roster** → edit the agent's record in `agents/roster.json` and its `agents/prompts/<agent>.md`; in the same change update `agents/prompts_cn/<agent>_cn.md`, then assemble. `assemble --check` rejects orphan prompts and missing reference translations in a source checkout. Keep the omos attribution notice that opens each adapted body verbatim and first: `stripAttribution()` drops it from every generated prompt by exact match, so an edited or moved notice ships into the delivered text. `agents/prompts/improver.md` is in-house and deliberately carries none — do not add one.
- **Backend-specific text** → `{{slot:<name>}}` in `agents/prompts/*.md`, filled from `agents/backends/<name>/slots/<name>.md`. A slot referenced by any prompt must exist for every backend with a `slots/` dir (claude, opencode, zcode, codex, dsh); unused slots are reported after every consumer has run. `design-skills` is designer's invoke-installed-skills rule, worded per backend.
- **ChatGPT / Codex** → standalone custom-agent TOML lives under `CODEX_HOME/agents/`; roster `frontmatter.codex` carries native TOML metadata. Prompts inherit session models by default. Force preserves top-level `model` / `model_reasoning_effort` / `model_reasoning_summary` / `model_verbosity` statements. The active global file (`AGENTS.override.md` when it has user instructions, otherwise `AGENTS.md`) carries one marked loader block; the full policy lives in `my-workbench-orchestrator.md` outside automatic discovery's size budget. Every Codex deployment also refreshes `my-workbench-plugin-marketplace/` and registers `subagent-config@my-workbench` with the official `codex plugin` CLI; Node.js and that CLI capability are hard prerequisites, registration failure rolls back managed files and plugin registration state and prevents the CODEX_HOME-local version stamp, and the user must restart ChatGPT / Codex afterward. Hosted ChatGPT chats and GPTs are not this target.
- **Universal behavior rules** → `agents/disciplines.md` is the single authored copy, with `agents/disciplines_cn.md` beside it. Assembly appends the English file to every delivered agent prompt — markdown backends, DSH preset persona, DSH lane personas — so no delegation brief repeats it. One rule per concern.
- **DSH preset declarations** → `agents/backends/dsh/orchestrator-preset.cordis.yml` is the orchestrator preset's `plugins:` list; `preset.json` carries the picker metadata (`name`, `description`, `order`); `lanes.json` drives one generated child preset per lane. A `{{prompt:<agent>}}` placeholder must stand alone on its own line; `{{lane-plugin}}` becomes the installed module's absolute `file:` URL and `{{lane-pins}}` becomes the user's pin mapping. All declarations live in ONE managed block in `<DSH_HOME>/cordis.patch.yml`; the CLI owns that block (`writeManagedBlock`) — do not hand-edit it.
- **DSH lane plugin** → `agents/backends/dsh/lane-plugin/`. `lanes.json` owns lane keys, tool names and restrictions; each lane key must have an agent record and a generated child preset, whose composition is the ONLY enforcement of the lane's read-only/shell restriction (0.2.x has no per-request `persona`/`toolFilter`). Keep every lane a leaf: its preset mounts no delegation tool. `spotter`, `driver` and `intake` are deliberately not DSH lanes — they live in the orchestrator prompt only, and the plugin registers the seven core delegation tools.
- **Lane plugin imports** → only `./roster.generated.js` and `./prompts.generated.js`. The plugin may not import a harness package: a `file:` URL under `<DSH_HOME>` cannot resolve a bare name, and baking one installation's path ties the install to that installation and version. `assemble --check` enforces this, a manifest with no dependencies and no `engines.dsh` (a dependency would need resolution; a prerelease DSH version cannot be expressed as a semver range), and the manifest's version placeholder.
- **DSH runtime window** → `bin/dsh-version.js` owns the supported range (`>= 0.2.1-rc.2 < 0.3.0`), detection (`DSH_INSTALL_DIR`, PATH launchers, the profile module farm), and the refusal to write outside it. A DSH contract change means updating that range, the plugin's flat/nested activation shim, and the declarations together.
- **DSH lane routes** → per-lane pins are user data in `<DSH_HOME>/my-workbench-lanes.json`, rendered into the lane row's `pins`; the CLI reads it and never rewrites it. The shipped source pins nothing: a lane without a usable pin inherits the session's route.
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
