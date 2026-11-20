# AGENTS.md

`agents/` is this repository's only content source: the generated agent files, backend assets, and installed targets are assembled from it by the zero-dependency Node CLI (`bin/`). Validation is `node bin/my-workbench.js assemble --check` plus `npm test`; changes to Subagent Config also run its package-local build and tests. The npm package itself builds nothing. The retired Tauri desktop app is preserved on the `desktop` branch and is not maintained on `main`. Keep this file structural and lean: record where things live and what may not change, not how a mechanism works.

## Targets

| Target | Flag | Where it installs |
| --- | --- | --- |
| opencode (native) | default set (project-only) | `.opencode/` — core config plus native `.opencode/agents/*.md`; rejects `--user` |
| claude | default set | `.claude/` — `settings.json` plus `.claude/agents/*.md`; identical in every target |
| user level | `--user` | Claude Code assets under `~/.claude/`; default target is claude only |
| zcode | `--zcode` | `~/.zcode/AGENTS.md` (the orchestrator prompt as ZCode's global instruction file) + `~/.zcode/agents/*.md` |

Every target downloads nothing and writes nothing inside a project except the version stamp; existing files are skipped unless `--force`, and a `--force` overwrite first snapshots and restores the user's model settings (the per-backend `model`/`effort`/`thoughtLevel` frontmatter lines of every `agents/*.md`). The two JSON files it deploys are seed stubs, not owned files: a `--force` overwrite reconciles only the stub's own keys (derived from the stub bytes — `agent` in `.claude/settings.json`, `$schema` in `opencode.jsonc`) into an existing file and never touches any other byte of it (an unparseable file is left completely untouched). Every install and assemble stamps `my-workbench.version` once per deployment realm (`<cwd>/my-workbench.version` for project deploys and `~/.my-workbench.version` for shared user-level deploys) — written unconditionally, never subject to skip/`--force`. `--upgrade` compares those stamps with the npm registry latest and, when one is behind, auto-upgrades by redeploying via `npx my-workbench@latest --force` — the one deliberate download, and it overwrites deployed files by design.

**opencode** requires an `opencode` binary on PATH.

**zcode** has no configurable main agent and no project-level subagents, so `~/.zcode/` is the whole install.


## Layout

| Path | Role |
| --- | --- |
| `bin/my-workbench.js` | The zero-dependency ESM CLI. |
| `agents/backends/codex/subagent-config/` | Standalone Subagent Config plugin source and runtime, excluded from the npm package. |
| `agents/roster.json` | Agent descriptions and backend frontmatter; the only authored agent list (eleven agents — `ui-designer` was renamed to `designer`; `intake` is user-invoked only). |
| `agents/prompts/` | Agent prompt bodies — the single source, each opening with the omos attribution notice. |
| `agents/prompts_cn/` | Chinese reference translations of the prompt bodies — never packaged. |
| `agents/solutions/` | GUI-test guides and the shared `task-queue.mjs` helper, deployed as `my-workbench-solutions/` beside each target's agents on every run. |
| `agents/solutions_cn/` | Chinese reference translations of the solution guides — never packaged or deployed. |
| `agents/backends/<name>/` | Backend-specific assets and `slots/` for `{{slot:...}}` text. |
| `test/*.test.js` | `npm test` — deployment scope, preservation, and `--upgrade`. |
| `docs/` | Reference only, never shipped: the agent-skill notes (`docs/agents/`). |
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
| `agents/backends/zcode/` | user-level only, nothing generated inside this repo: `~/.zcode/` |

Run `npx my-workbench assemble` in the repo root after editing any source (`--check` verifies without writing).

## Commits

- Say what changed: one sentence or a short bullet list.
- Never narrate detailed changes, background, or rationale.
- Subject on one line, each body paragraph or bullet on its own line, never a hard-wrapped body.

## Editing conventions

- **Agent prompts / roster** → edit the agent's record in `agents/roster.json` and its `agents/prompts/<agent>.md`; in the same change update `agents/prompts_cn/<agent>_cn.md`, then assemble. `assemble --check` rejects orphan prompts and missing reference translations in a source checkout. Keep the omos attribution notice that opens each adapted body verbatim and first: `stripAttribution()` drops it from every generated prompt by exact match, so an edited or moved notice ships into the delivered text. `agents/prompts/improver.md` is in-house and deliberately carries none — do not add one.
- **Backend-specific text** → `{{slot:<name>}}` in `agents/prompts/*.md`, filled from `agents/backends/<name>/slots/<name>.md`. A slot referenced by any prompt must exist for every backend with a `slots/` dir (claude, opencode, zcode); unused slots are reported after every consumer has run. `design-skills` is designer's invoke-installed-skills rule, worded per backend.
- **Universal behavior rules** → `agents/disciplines.md` is the single authored copy, with `agents/disciplines_cn.md` beside it. Assembly appends the English file to every delivered agent prompt so no delegation brief repeats it. One rule per concern.
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
