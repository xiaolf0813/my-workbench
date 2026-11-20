# my-workbench

English | [简体中文](README_CN.md)

Portable [OpenCode](https://opencode.ai) + Claude Code + ZCode + ChatGPT / Codex + DeepSeek Harness agent setup, installed into your project (or at user level with `--user`; ZCode, Codex and DSH are always user-level) with one command.

The retired first-party Tauri desktop app is preserved on the [`desktop`](https://github.com/xiaolf0813/my-workbench/tree/desktop) branch and is not maintained on `main`.

```bash
npx my-workbench
```

`my-workbench` copies a curated multi-agent configuration into the current project:

- **`.opencode/`** — OpenCode core config and native `.opencode/agents/` subagents: eleven agents — `orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `observer`, `spotter`, `driver`, `improver`, `intake`.
- **`.claude/`** — the same specialists as native Claude Code subagents (`.claude/agents/*.md`). Installed identically in every target.
- **`~/.zcode/`** — opt-in ZCode support (`--zcode`): user-level global instructions plus the specialist subagents as ZCode user agents (`~/.zcode/agents/*.md`). Nothing is written inside the project.
- **`~/.codex/`** — opt-in local ChatGPT / Codex support (`--chatgpt` or `--codex`): a short global entrypoint, the orchestration policy, ten native TOML custom agents, solution guides, and the bundled **Subagent Config** plugin; honors `CODEX_HOME`.
- **`~/.dsh/`** — opt-in DeepSeek Harness support (`--dsh`): a marked block in `<DSH_HOME>/cordis.patch.yml` declaring **eight agent presets** — the orchestrator **MyWorkbench** plus one child preset per specialist (persona and restricted tool set) — and a packaged **lane plugin** under `<DSH_HOME>/my-workbench/lane-plugin/` that owns the seven named delegation tools. The home-level patch serves every DSH profile (`dsh web`, DSH Desktop, …), so there is no per-profile write; per-lane model pins live in `<DSH_HOME>/my-workbench-lanes.json`. Nothing is written inside the project.

The orchestrator prompt also carries a persistent task queue: the `intake` specialist — invoked only when you explicitly ask, by name or @-mention — turns your raw input into confirmed task files under the project's `.oxbench/` directory, and the orchestrator presents that queue whenever it finishes work, sits idle, or is woken. Pick a task, or it auto-starts the first one after two minutes where the platform has a timer (ZCode); every task runs in an independent new session and is marked done only after the orchestrator accepts the result.

## OpenCode target

- **`--opencode` (native)** — core config (`opencode.jsonc`) plus native `.opencode/agents/*.md` subagents. Requires the OpenCode app (`opencode` on PATH). Nothing is downloaded. The universal behavior rules (`agents/disciplines.md`) are appended to every agent's own prompt at assembly, so each agent carries them and the orchestrator never pastes them into a delegation brief. New sessions start on OpenCode's built-in `build` agent — switch to `orchestrator` in the agent selector, or set `"default_agent": "orchestrator"` in `opencode.jsonc`, to run the orchestration.

## Usage

```bash
npx my-workbench                    # install both .opencode/ and .claude/
npx my-workbench --opencode         # OpenCode setup only
npx my-workbench --claude           # Claude Code setup only
npx my-workbench --user             # user-level install: ~/.config/opencode/ + ~/.claude/
npx my-workbench --force            # overwrite files that already exist
npx my-workbench --dry-run          # preview without writing
npx my-workbench --zcode            # ZCode user-level setup only (~/.zcode)
npx my-workbench --dsh              # DSH presets + lane plugin (~/.dsh)
npx my-workbench assemble [--check] # in this repo: regenerate .claude/agents/ and .opencode/
```

Existing files are skipped unless `--force` is given, so re-running is safe. A `--force` overwrite snapshots and restores your model settings — the `model`/`effort`/`thoughtLevel` lines of every `agents/*.md` (per backend; on OpenCode the model reference `provider/model#variant` rides the `model:` line) — so your retuned pins survive upgrades. The two JSON files it deploys are seed stubs, not owned files: `--force` reconciles only the stub's own keys (`agent` in `.claude/settings.json`, `$schema` in `opencode.jsonc`) into an existing file and never touches any other byte of it.

## Version management

Every install — and `assemble` in this repository — writes a small stamp file recording the version of the CLI that deployed there, **one per deployment realm**: `my-workbench.version` in the project root for project-level runs, `~/.my-workbench.version` for shared user-level runs (`--user`, ZCode or DSH), and `<CODEX_HOME>/my-workbench.version` for each Codex home. A mixed run (e.g. `npx my-workbench --claude --zcode`) stamps both applicable realms. The stamp is refreshed unconditionally on every run, so it always names the running version.

```bash
npx my-workbench --upgrade   # compare deployed versions with the npm latest
```

`--upgrade` compares each selected realm's stamp with the latest version on the npm registry (`npm_config_registry` is respected; it defaults to `https://registry.npmjs.org`). When a stamp is outdated it **auto-upgrades**: it re-runs the install as `npx --yes my-workbench@latest [<targets>] [--user] --force` — the redeploy overwrites the deployed files (intentional for an upgrade) and needs `npm`/`npx` on PATH. A deployment that is numerically newer than the registry latest is left untouched. `--upgrade` exits `0` only when every checked stamp matches the latest after the run; it exits `1` on a registry error, when no stamp exists at all (run the install first), or when the redeploy fails.

## User-level install

`npx my-workbench --user` installs the same assets at user level instead of the current project: OpenCode assets go to `~/.config/opencode/` (its XDG config directory; global agents are read from `~/.config/opencode/agents/`) and Claude Code assets to `~/.claude/` (`settings.json` + `agents/*.md`). User-level files apply to every project and are not meant for version control; on name conflicts project-level agents win over user-level ones. ZCode is always user-level and ignores `--user`.

## ZCode target

`npx my-workbench --zcode` installs ZCode support at **user level only**: `~/.zcode/AGENTS.md` (global instructions for the main agent) and `~/.zcode/agents/*.md` (subagents). ZCode has no configurable main agent and no project-level subagents, so there is nothing to install inside a project.

- The global file is `agents/prompts/orchestrator.md` — the orchestrator prompt drives the main agent, with the ZCode dispatch convention substituted from `agents/backends/zcode/slots/dispatch.md`.
- Subagents run with `injectAgentsMd: false`: the global file is not injected into them, so every delegation brief must carry full context.
- Opt-in only (`--zcode` or `zcode`) — the default targets remain `.opencode/` + `.claude/`. Nothing is downloaded. Existing files are skipped unless `--force`. Restart ZCode sessions to pick up changes.

## ChatGPT / Codex target

`npx my-workbench --chatgpt` (alias: `--codex`) installs native local custom agents into **CODEX_HOME**, defaulting to `~/.codex/`. This targets the current ChatGPT desktop app's local Codex runtime and Codex CLI; hosted chats and custom GPTs do not read these local files.

- active global AGENTS file — deployment maintains one marked loader block in `AGENTS.override.md` when that file contains user instructions, otherwise in `AGENTS.md`; all surrounding user content is preserved. The block loads `my-workbench-orchestrator.md`, keeping the full policy outside the automatic AGENTS.md size budget.
- `agents/*.toml` — ten specialists, each with native `name`, `description`, and `developer_instructions`, assembled from the same roster, prompts and disciplines. Models inherit from the current session unless you tune them in the deployed TOML or Subagent Config.
- `my-workbench-plugin-marketplace/` — an offline local marketplace containing **Subagent Config**, which edits only the deployed agents' model fields. Deployment registers the marketplace and plugin through `codex plugin`; it never edits Codex plugin state directly.
- `my-workbench-solutions/` — the platform guides, refreshed on every install.

User-level only, opt-in, with no downloads or project writes. Node.js and a Codex CLI that supports `codex plugin` are required. Existing agent files skip unless `--force`; force preserves the agents' top-level `model`, `model_reasoning_effort`, `model_reasoning_summary`, and `model_verbosity` settings, while the active AGENTS loader block, bundled marketplace and plugin runtime refresh on every deployment. Plugin registration uses the official CLI, which owns the necessary `config.toml` changes. A registration failure restores the pre-deployment managed files, `config.toml`, and plugin cache and does not write the CODEX_HOME-local version stamp. Restart ChatGPT / Codex after success. Disabling subagents in your own settings can still prevent dispatch. Role instructions do not grant tools or create a separate sandbox.

Schema and discovery follow official OpenAI documentation: [custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## DSH target

`npx my-workbench --dsh` installs the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) agent setup at user level (`DSH_HOME`, else `~/.dsh`). DSH reads presets only from declarations — an `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` is the preset's plugin list — so the install is **YAML in the home-level patch layer plus one plugin module**, and nothing is written inside a project:

- **`<DSH_HOME>/cordis.patch.yml`** — one marked, managed block declaring eight presets: the orchestrator **MyWorkbench** (order 5) and one child preset per specialist (`my-workbench-explorer` … `my-workbench-improver`, order 106+), which carries that lane's persona and its restricted tool set. DSH applies the home layer after every profile's own patch, for **every** profile, so this one block serves `dsh web`, DSH Desktop, and any other profile on the machine. There is no per-profile write and no profile name to guess.
- **`<DSH_HOME>/my-workbench/lane-plugin/`** — the packaged plugin the orchestrator preset mounts. It owns the seven delegation tools (`subagent_explorer` … `subagent_improver`), each of which starts its child under `my-workbench-<lane>`, so the persona and the read-only restriction come from the child's preset — DSH 0.2.x has no per-request `persona`/`toolFilter`.
- **`<DSH_HOME>/my-workbench/my-workbench-solutions/`** — the platform solution guides, as for every other target.
- **`<DSH_HOME>/my-workbench/presets.generated.patch.yml`** — a copy of the rendered block: easy to review, diff, or merge by hand when `cordis.patch.yml` is not a plain patch list.
- **`<DSH_HOME>/my-workbench-lanes.json`** — optional per-lane route pins (see below). The CLI reads it and never rewrites it.

```
<DSH_HOME>/
├── cordis.patch.yml                            # the managed preset block (one insert, eight rows)
├── my-workbench-lanes.json                     # optional: per-lane provider/model/reasoningEffort
└── my-workbench/
    ├── presets.generated.patch.yml             # rendered copy of the block
    ├── lane-plugin/
    │   ├── package.json                        # name my-workbench-lanes, version rendered at install
    │   └── src/index.js                        # the 7 tools: no package imports, no dependency command
    │   └── src/roster.generated.js             # lane keys/tools/labels from dsh/lanes.json
    │   └── src/prompts.generated.js            # one persona per lane from agents/prompts/*.md
    └── my-workbench-solutions/                 # platform GUI-test guides
```

**Why declarations.** The former `<DSH_HOME>/.agent-presets/<id>/` directory format (`preset.yml` + `agent.cordis.yml`) is not read by any DSH 0.2.x code path: presets are ordinary Loader rows, and a preset's children resolve from the tree that declares them, so the lane plugin row is named by an **absolute `file:` URL** rather than a preset-directory-relative path. `--dsh` removes a directory left by an older release, and removes the old per-profile settings-page row from every profile that still has one (a Loader row naming a missing module would fail that profile's composition).

**One plugin, no package imports.** `lane-plugin/src/index.js` imports only its two generated sibling modules. A plugin mounted from a `file:` URL under `<DSH_HOME>` cannot resolve a harness package by bare name, and baking an absolute path to one installation's `dsh-tools` would tie the install to that installation and version. The tool definitions are therefore plain `ToolDefinition` objects — the registry accepts a raw definition and projects `parameters` as model-facing JSON Schema — and the row config is read as-is. The manifest declares **no** dependencies, so no dependency command runs, nothing is installed into any `node_modules`, and DSH's plugin-compatibility preflight has nothing to refuse. Its `version` is rendered from the CLI's own version at install time, so DSH's plugin inventory names the release that produced the deployed copy; `assemble --check` fails if the authored placeholder drifts.

**Delegation and per-lane routing**

- The model calls `subagent_explorer`, `subagent_librarian`, `subagent_oracle`, `subagent_designer`, `subagent_fixer`, `subagent_observer`, or `subagent_improver` instead of naming a subagent type in a Task tool. With no `run_in_background` field the tool starts the child and returns `started subagent <name> — …`; the orchestrator sets `run_in_background: false` explicitly and waits for the final report in the same turn.
- Each tool starts a child under that lane's preset: the specialist prompt, the writes/shell restrictions, and no delegation tool at all (lanes are leaves). The plugin itself grants nothing — the composition is the enforcement.
- `send_message` / `list_agents` / `interrupt_agent` / `wait_agent` come from DSH's subagent-control row, mounted once in the orchestrator preset.
- **Per-lane model and reasoning effort** live in `<DSH_HOME>/my-workbench-lanes.json`, which the CLI renders into the lane plugin's row config:

  ```json
  { "explorer": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "max" },
    "fixer":   { "provider": "", "model": "", "reasoningEffort": "" } }
  ```

  Empty strings mean inherit. A lane with no usable pin inherits the session's route, which is the default for a fresh install. Edit the file and re-run `--dsh`; DSH's own Subagent settings page still governs which routes a session may use.

**Runtime window and failure modes**

- Supported DSH: **`>= 0.2.1-rc.2 < 0.3.0`**. The CLI reads every installation it can find — `DSH_INSTALL_DIR`, each `dsh` launcher on `PATH`, and `<DSH_HOME>/profiles/node_modules` — and **refuses to write** when no detected installation is in the window (the presets would never be read), or warns when only some are. When no version can be determined at all it warns and installs.
- Installs are idempotent: the managed block is replaced in place, your own rows and comments are never touched, and a re-run is byte-identical. `--dry-run` writes nothing.
- A live DSH is reported before writing. DSH reloads the home patch, but the lane plugin module is imported once per process, so **restart DSH** after a run that changes the plugin; a new session is enough to see new or changed presets.
- DSH refuses profile changes while its desktop app is running, so close DSH Desktop while installing; the CLI warns when it sees a live process.
- When `cordis.patch.yml` is not a plain patch list (for example a YAML mapping), the CLI leaves it untouched and points at `my-workbench/presets.generated.patch.yml` to merge by hand.

**Install, verify, roll back**

```bash
npx my-workbench --dsh --force        # rewrite ~/.dsh/cordis.patch.yml block + ~/.dsh/my-workbench/
```

Order matters: install → **restart DSH** (the plugin module is imported once per process) → start a new session and pick the **MyWorkbench** preset → confirm the seven `subagent_*` tools are listed and that a pinned lane's child runs on the pinned route. The eight presets appear in the agent-preset picker; the seven `MyWorkbench · <lane>` entries are internal child presets — select **MyWorkbench**, not a lane.

To roll back: remove the marked block from `<DSH_HOME>/cordis.patch.yml` and delete `~/.dsh/my-workbench` (and `<DSH_HOME>/my-workbench-lanes.json` if you created it). `npx my-workbench --dsh --force` restores the block and the plugin.

## Single source, assembled output

Everything is generated from one tree, `agents/`:

```
agents/
├── disciplines.md    # the universal disciplines, appended to every agent prompt at assembly
├── disciplines_cn.md # Chinese reference translation of disciplines.md (never packaged)
├── roster.json       # agent descriptions and backend frontmatter, authored once
├── prompts/          # each agent prompt body, once (attribution notice kept here, dropped when assembled)
├── prompts_cn/       # Chinese reference translations (never packaged)
└── backends/         # everything backend-specific; each backend may carry slots/*.md
                      # (per-backend text substituted for {{slot:...}} placeholders in agents/prompts/)
    ├── claude/
    │   ├── settings.json   # main-thread agent setting
    │   └── slots/          # Claude-specific prompt text
    ├── opencode/
    │   ├── slots/                # OpenCode-specific prompt text
    │   └── opencode.jsonc        # core config
    ├── zcode/
    │   └── slots/          # dispatch.md (every backend has it; not enumerated here)
    └── dsh/
        ├── lanes.json              # lane keys, tools, labels and permissions
        ├── preset.json             # preset-picker metadata (name/description/order)
        ├── orchestrator-preset.cordis.yml  # the orchestrator preset's plugin list
        │                                   # ({{prompt:<agent>}} embeds prompts/<agent>.md;
        │                                   #  {{lane-plugin}} becomes the installed file: URL)
        ├── lane-plugin/            # the preset-mounted plugin (design: docs/dsh-lane-plugin/)
        │   ├── package.json               # no dependencies: imports only its siblings
        │   └── src/index.js               # the 7 tools, started against each lane's preset
        └── slots/                  # dispatch.md, solutions-dir.md, queue-*, goal-guidance
```

In your project, `.claude/agents/` and `.opencode/` are assembled from it. Edit `agents/`, then run `npx my-workbench assemble` (`--check` detects drift) — the same workflow works in this repository and in any target project. `agents/roster.json` supplies descriptions and backend frontmatter, and the check rejects orphan prompt bodies. Prompt bodies may reference `{{slot:<name>}}` placeholders; each backend supplies their text in `agents/backends/<backend>/slots/`, and a slot referenced by a prompt but missing for a backend fails assembly. The DSH target renders the home-patch preset declarations (orchestrator template + one generated child preset per lane) and the lane plugin's prompt/roster modules; `assemble --check` verifies those renders, the plugin's no-dependency contract, and its import surface.

## Attribution

Agent prompts are adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (MIT License, © 2025) — except `improver` and `intake`, which are written in-house. The notice sits at the top of every adapted file under `agents/prompts/` — provenance is kept with the source — and assembly drops it from the prompts it generates, so no agent is given a licence statement. `agents/prompts_cn/` and `agents/disciplines_cn.md` exist for reference only and are never packaged.

## License

MIT.
