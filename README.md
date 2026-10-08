# my-workbench

English | [简体中文](README_CN.md)

Portable [OpenCode](https://opencode.ai) + Claude Code + ZCode + DeepSeek Harness + OpenBitFun agent setup, installed into your project (or at user level with `--user`; ZCode, DSH and OpenBitFun are always user-level) with one command.

```bash
npx my-workbench
```

`my-workbench` copies a curated multi-agent configuration into the current project:

- **`.opencode/`** — OpenCode core config and native `.opencode/agents/` subagents: eight specialized agents — `orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `observer`, `improver`. Add the separate `--omos` target on top for the [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) plugin scheme (short name: **omos**): multi-model council presets and prompt overrides.
- **`.claude/`** — the same specialists as native Claude Code subagents (`.claude/agents/*.md`). omos-agnostic: installed identically in every target.
- **`~/.zcode/`** — opt-in ZCode support (`--zcode`): user-level global instructions plus the specialist subagents as ZCode user agents (`~/.zcode/agents/*.md`). Nothing is written inside the project.
- **`~/.dsh/`** — opt-in DeepSeek Harness support (`--dsh`): one agent preset under `<DSH_HOME>/.agent-presets/my-workbench/` — the orchestrator prompt as the preset persona, plus a packaged **lane plugin** that owns the seven named specialist tools and a settings page for pinning each lane's model and reasoning effort. The tools are preset-scoped; the settings page needs one inert profile row, the entire profile-level footprint. Nothing is written inside the project.
- **OpenBitFun** — opt-in OpenBitFun support (`--openbitfun`): the eight agents installed into the `agents/` directory of OpenBitFun's per-OS user config. Always user-level; nothing is written inside the project.

## OpenCode targets: native or omos

OpenCode support comes as two independent targets:

- **`--opencode` (native)** — core config (`opencode.jsonc`) plus native `.opencode/agents/*.md` subagents. Requires the OpenCode app (`opencode` on PATH). Nothing is downloaded. The universal behavior rules (`agents/disciplines.md`) are appended to every agent's own prompt at assembly, so each agent carries them and the orchestrator never pastes them into a delegation brief. When a user-level omos install is detected (`~/.config/opencode`), it installs the omos way instead (omits assets, no native agents) to avoid agent conflicts.
- **`--omos` (opt-in plugin scheme)** — copies only the omos project assets (oh-my-opencode-slim.jsonc, prompt overrides, plugin node dependencies) into `.opencode/`. Requires OpenCode **and** an existing user-level omos install (`~/.config/opencode`): the plugin loads from that user level, so my-workbench never pins a `"plugin"` entry and never downloads anything. It cannot be combined with `--opencode`.

There is no consent flow: the explicit `--omos` flag is the explicit choice, and the prerequisite check fails fast if omos is not already installed.

## Usage

```bash
npx my-workbench                    # install both .opencode/ and .claude/
npx my-workbench --opencode         # OpenCode setup only
npx my-workbench --omos             # omos plugin scheme only (no native agents)
npx my-workbench --claude           # Claude Code setup only
npx my-workbench --user             # user-level install: ~/.config/opencode/ + ~/.claude/
npx my-workbench --force            # overwrite files that already exist
npx my-workbench --dry-run          # preview without writing
npx my-workbench --zcode            # ZCode user-level setup only (~/.zcode)
npx my-workbench --dsh              # DSH agent preset only (~/.dsh)
npx my-workbench --openbitfun       # OpenBitFun user-level agents only
npx my-workbench assemble [--check] # in this repo: regenerate .claude/agents/ and .opencode/
```

Existing files are skipped unless `--force` is given, so re-running is safe.

## Version management

Every install — and `assemble` in this repository — writes a small stamp file recording the version of the CLI that deployed there, **one per deployment realm**: `my-workbench.version` in the project root for project-level runs, and `~/.my-workbench.version` for user-level runs (`--user`, or the always-user-level ZCode/DSH/OpenBitFun targets). A mixed run (e.g. `npx my-workbench --claude --zcode`) stamps both. The stamp is refreshed unconditionally on every run, so it always names the running version.

```bash
npx my-workbench --upgrade   # compare deployed versions with the npm latest
```

`--upgrade` compares each selected realm's stamp with the latest version on the npm registry (`npm_config_registry` is respected; it defaults to `https://registry.npmjs.org`). When a stamp is outdated it **auto-upgrades**: it re-runs the install as `npx --yes my-workbench@latest [<targets>] [--user] --force` — the redeploy overwrites the deployed files (intentional for an upgrade) and needs `npm`/`npx` on PATH. A deployment that is numerically newer than the registry latest is left untouched. `--upgrade` exits `0` only when every checked stamp matches the latest after the run; it exits `1` on a registry error, when no stamp exists at all (run the install first), or when the redeploy fails.

## User-level install

`npx my-workbench --user` installs the same assets at user level instead of the current project: OpenCode/omos assets go to `~/.config/opencode/` (its XDG config directory; global agents are read from `~/.config/opencode/agents/`) and Claude Code assets to `~/.claude/` (`settings.json` + `agents/*.md`). User-level files apply to every project and are not meant for version control; on name conflicts project-level agents win over user-level ones. ZCode is always user-level and ignores `--user`.

## ZCode target

`npx my-workbench --zcode` installs ZCode support at **user level only**: `~/.zcode/AGENTS.md` (global instructions for the main agent) and `~/.zcode/agents/*.md` (subagents). ZCode has no configurable main agent and no project-level subagents, so there is nothing to install inside a project.

- The global file is `agents/prompts/orchestrator.md` — the orchestrator prompt drives the main agent, with the ZCode dispatch convention substituted from `agents/backends/zcode/slots/dispatch.md`.
- Subagents run with `injectAgentsMd: false`: the global file is not injected into them, so every delegation brief must carry full context.
- Opt-in only (`--zcode` or `zcode`) — the default targets remain `.opencode/` + `.claude/`. No omos, nothing downloaded. Existing files are skipped unless `--force`. Restart ZCode sessions to pick up changes.

## OpenBitFun target

`npx my-workbench --openbitfun` installs OpenBitFun support at **user level only**: the eight agent files (`orchestrator` plus the seven specialists) into the `agents/` directory of OpenBitFun's per-OS user config directory. Agents are plain markdown files with YAML frontmatter (`schema_version`/`kind`/`id`/`name`/`description`/`tools`/`readonly`; `kind: mode` for the orchestrator, `kind: subagent` for the specialists), so there is nothing to install inside a project.

| OS | Config directory |
| --- | --- |
| Linux | `~/.config/openbitfun` (`$XDG_CONFIG_HOME` respected when set) |
| macOS | `~/Library/Application Support/openbitfun` |
| Windows | `%APPDATA%\openbitfun` (fallback `~/AppData/Roaming/openbitfun`) |

- **Requires an existing OpenBitFun install**: the target refuses to run when the config directory does not exist — it fails fast, before writing anything, and names all three per-OS locations.
- Opt-in only (`--openbitfun` or `openbitfun`) — the default targets remain `.opencode/` + `.claude/`. Nothing is downloaded, and existing files are skipped unless `--force`.
- Restart OpenBitFun to pick up changes.

## DSH target

`npx my-workbench --dsh` installs one [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) **agent preset** at user level: `<DSH_HOME>/.agent-presets/my-workbench/` (`DSH_HOME`, else `~/.dsh`). DSH reads presets from its home, so there is nothing to install inside a project.

- `preset.yml` — display name and description for the preset picker.
- `agent.cordis.yml` — the composition: the orchestrator prompt as the preset's persona, the full standard tool set, and **one row** naming the lane plugin.
- `lane-plugin/` — a packaged plugin the preset mounts. It owns the seven specialist tools and their prompts, so a lane's route can be pinned and persists.
- `lane-plugin-ui/` — the settings page, packaged separately and mounted by **one inert profile row** (see below). This is the whole profile-level footprint.

**Lane plugin layout**

```
lane-plugin/                        # preset row: ./lane-plugin/src/index.js
├── package.json                    # name my-workbench-lanes (host only, no client half)
├── src/index.js                    # host half: the 7 delegation tools + the settings namespace
├── src/roster.generated.js         # host lane fields, rendered from dsh/lanes.json
└── src/prompts.generated.js        # the 7 prompts, rendered from agents/prompts/*.md

lane-plugin-ui/                     # profile row: file:///…/lane-plugin-ui/src/index.js
├── package.json                    # name my-workbench-lanes-ui, exports "./client", dsh.client.platform "web"
├── src/index.js                    # inert host half: registers nothing at all
└── lib/client.js                   # settings page with display labels rendered from dsh/lanes.json
```

- The host row's `name` is **relative** (`./lane-plugin/src/index.js`): a preset row's bare package name resolves from the host composition's base, not from the preset directory, so a package shipped alongside the composition would not be found.
- The host half's two deployment imports (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`) are baked into its installed `src/index.js` as absolute `file:` URLs **at install time**, resolved from your DSH home. That is why no dependency command is ever needed.
- The plugin must be named by this preset **only**: it registers a settings namespace, and DSH refuses a duplicate registration, so a second preset mounting the same row would fail loudly.

**Why one profile row (and what it costs)**

DSH discovers browser ("client") plugin halves by scanning the **profile loader's own entries** — an agent preset is a separate loader tree mounted under a scope, so a row inside it is never scanned, its page is never served, and `clientModules.clientPath(...)` stays `undefined`. The host half mounts and its settings namespace registers; only the page needs the profile. So `--dsh` also maintains **one marked, managed block** in `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` holding a single inert row:

```yaml
# >>> my-workbench lane settings page (managed block - regenerated by `my-workbench --dsh`) >>>
- insert:
    - id: my-workbench-lanes-ui
      name: 'file:///…/.agent-presets/my-workbench/lane-plugin-ui/src/index.js'
# <<< my-workbench lane settings page <<<
```

- The block is replaced **in place** on every run; your own rows and comments are never touched or reordered. `--dry-run` writes nothing.
- The row is inert: `lane-plugin-ui` declares **no dependencies at all**, registers no tool, no prompt section and no service. No bundle layer changes and nothing is installed into any `node_modules`.
- The page is registered **synchronously** from `apply()` and decides inside the component what to show: live controls while the lane host half's `my-workbench-lanes` namespace is registered, an inert placeholder otherwise. Registering after an `await` left the shell's ledger entry `active: false` and the settings panel blank, which is why the decision moved into the component.
- A deployment that never mounts MyWorkbench therefore sees the nav entry with **no controls and no write path**. Once any MyWorkbench session has mounted the host half (the namespace is process-global), the same page is live from every session — it edits pins that only MyWorkbench sessions consume.
- The component re-reads the namespace each time the section is opened, so the page needs **one page reload** to pick up a changed bundle, not to pick up a mounted host half.
- **Changing the lane plugin's HOST half needs a DSH restart, not just a reinstall.** The preset row is imported once per process — Node's ESM cache, and the loader re-imports the SAME specifier when it re-mounts a stale composition — so `--dsh --force` alone leaves the running process on the old code. Worse, the stale mount's settings-namespace registration is never released (`ensureStanding` drops the mount without disposing its scope), so old code that registers unconditionally fails the next mount with `settings namespace "my-workbench-lanes" is already registered`. The shipped host half tolerates that duplicate and reads through the surviving registration; the tolerance takes effect after the next DSH restart. The settings page is a browser module and needs only the page reload.
- If no single profile directory can be found, nothing is written to any profile and the exact row is printed for you to paste by hand.

**Delegation and per-lane routing**

- Delegation is native. The model calls `subagent_explorer`, `subagent_librarian`, `subagent_oracle`, `subagent_designer`, `subagent_fixer`, `subagent_observer`, or `subagent_improver` instead of naming a subagent type in a Task tool. Lanes run in the background by default and answer with a durable child id, which `send_message` continues — that is the session handle the orchestrator prompt talks about.
- Each tool carries that specialist's prompt, rendered from `agents/prompts/*.md`, and restricts the child the way the prompt does: read-only lanes lose `write`/`edit`, `observer` and `improver` also lose the shell, and every lane loses the delegation tools, so lanes cannot spawn lanes.
- **Per-lane model and reasoning effort.** Open the DSH web GUI's settings and pick **MyWorkbench 赛道模型**: one row per lane with a model select and a reasoning-effort select, plus 应用 / 全部改回继承 / 刷新模型目录. Writes go to the plugin's own settings namespace and persist to `<DSH_HOME>/settings.yaml`, so they survive a DSH restart. A fresh install is seeded from a recommended mapping shipped as the namespace's composition base layer; leave a lane on 继承会话模型 to inherit the session's route.
- Opt-in only (`--dsh` or `dsh`) — the default targets remain `.opencode/` + `.claude/`. It requires an existing DSH home, downloads nothing, and skips existing files unless `--force`. Open a new DSH session to pick the preset up.

**Install, verify, roll back**

```bash
npx my-workbench --dsh --force        # (re)write ~/.dsh/.agent-presets/my-workbench/
                                      # + the one managed row in ~/.dsh/profiles/web/cordis.patch.yml
```

Order matters: install → **start a new DSH session** on the MyWorkbench preset (that mounts the lane host half) → **reload the web page** (that runs the page's gate) → check `settings → MyWorkbench 赛道模型` shows seven lanes. Also confirm the seven `subagent_*` tools are listed and that a pinned lane's child session header carries the pinned provider/model/effort.

To roll back: remove the managed block from the profile's `cordis.patch.yml` **and** delete `~/.dsh/.agent-presets/my-workbench` (`rm -rf`). `npx my-workbench --dsh --force` restores both. What remains after a rollback is at most an inert `my-workbench-lanes:` section in `~/.dsh/settings.yaml`.

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
    ├── omos/
    │   ├── oh-my-opencode-slim.jsonc       # omos project config
    │   ├── oh-my-opencode-slim/  # prompt overrides (<agent>_append.md)
    │   └── package.json          # plugin node dependencies
    ├── zcode/
    │   └── slots/          # dispatch.md (every backend has it; not enumerated here)
    ├── openbitfun/
    │   └── slots/          # dispatch.md ({{slot:dispatch}} inside the orchestrator prompt)
    └── dsh/
        ├── lanes.json        # lane keys, tools, labels, permissions and model defaults
        ├── agent.cordis.yml  # preset composition; {{prompt:<agent>}} embeds prompts/<agent>.md
        ├── preset.yml        # preset display metadata (name/description)
        ├── lane-plugin/      # the preset-mounted HOST half (design record: docs/dsh-lane-plugin/)
        │   └── host-package/          # ESM plugin package: 7 lane tools + settings namespace
        │       ├── package.json
        │       └── src/index.js       # {{dep:<alias>}} is resolved to a file: URL at install
        ├── lane-plugin-ui/   # the profile-mounted settings PAGE
        │   ├── package.json           # exports "./client", dsh.client.platform "web"
        │   ├── src/index.js           # inert host half (registers nothing)
        │   └── lib/client.js          # browser half with a rendered lane roster
        └── slots/            # dispatch.md ({{slot:dispatch}} inside the orchestrator prompt)
```

In your project, `.claude/agents/` and `.opencode/` are assembled from it. Edit `agents/`, then run `npx my-workbench assemble` (`--check` detects drift) — the same workflow works in this repository and in any target project. `agents/roster.json` supplies descriptions and backend frontmatter, and the check rejects orphan prompt bodies. Prompt bodies may reference `{{slot:<name>}}` placeholders; each backend supplies their text in `agents/backends/<backend>/slots/`, and a slot referenced by a prompt but missing for a backend fails assembly. The DSH composition embeds `{{prompt:<agent>}}`; `agents/backends/dsh/lanes.json` drives the installed lane prompt module, host roster and settings page labels. `assemble --check` renders these and the eight OpenBitFun agents, checks the page's `dsh.client`/`./client` declaration and browser imports, and imports its inert host half.

## Attribution

Agent prompts are adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (MIT License, © 2025) — except `improver`, which is written in-house. The notice sits at the top of every adapted file under `agents/prompts/` — provenance is kept with the source — and assembly drops it from the prompts it generates, so no agent is given a licence statement. `agents/prompts_cn/` and `agents/disciplines_cn.md` exist for reference only and are never packaged.

## License

MIT.
