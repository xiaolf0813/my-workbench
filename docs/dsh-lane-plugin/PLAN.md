# PLAN — the formal MyWorkbench lane plugin (variant B: mounted by the MyWorkbench preset)

> **STATUS: implemented.** Phase 2 built this plan and Phase 3 amended it; all decisions
> were locked by the user before implementation. Where this document and the code
> disagree, the code wins — the shipped files are `host-package/src/index.js`,
> `../lane-plugin-ui/{src/index.js,lib/client.js}`, `../lanes.json`,
> `bin/{my-workbench,dsh-deps}.js` and `agents/backends/dsh/agent.cordis.yml`, with `README.md` /
> `README_CN.md` / `AGENTS.md` describing the result.
>
> What each lock changed against the draft below:
>
> | # | Locked | Effect on this document |
> | --- | --- | --- |
> | 1 | tool names stay `subagent_*` | §8 as written |
> | 2 | relative row `name: ./lane-plugin/src/index.js` | §1, §2, §9 Form R is the shipped form; Form P is the documented escape hatch |
> | 3 | the CLI **bakes absolute `file:` URLs** at install time | §5's junction recipe is now the documented manual fallback, not the mechanism |
> | 4 | recommended mapping ships as the settings `base` layer | §4 as written; the page keeps 全部改回继承 and drops 套用推荐映射 |
> | 5 | Chinese UI | §6 — page labels are Chinese |
> | 6 | no extra `systemPrompt.section` | §8 and the host half's closing comment |
> | 7 | **the settings page ships as its own PROFILE-mounted package** (`lane-plugin-ui/`) | §1, §6, §7, §9 — see the phase-3 amendment below |
>
> **Phase-3 amendment — why the page left the preset.** Verified in the live process:
> `dsh-client-modules` discovers client halves by scanning the profile Loader's own
> entries (`nm/dsh-client-modules/lib/index.js:775-781`), and an agent preset is a
> separate Loader tree mounted under a scope, so a preset row is never scanned —
> `clientModules.clientPath('my-workbench-lanes')` stays `undefined` and no page is
> served. `locatePkgJson` (`:679-709`) does support `./`-relative and `file:` row names,
> so the Loader tree is the blocker, not the name form. The host half was never at
> fault: `standingsKeyFor('my-workbench')` mounted and the settings namespace registered
> with the recommended base mapping.
>
> So the page now ships as `agents/backends/dsh/lane-plugin-ui/` (an inert host half plus
> the browser half), mounted by ONE inert row inside a marked, CLI-managed block in
> `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`. §6's client half, §7's scope
> discussion and §9's install steps below still describe the page as if it lived in the
> preset; the shipped truth is the phase-3 layout, and `../lane-plugin-ui/README.md`
> documents the footprint, the conditional registration and the rollback.

Companion to `FEASIBILITY.md` (evidence). The dynamic-Cordis prototype this plan was proven against, and the follow-up backlog, were both deleted once the packaged form shipped; where the text below still reasons about "the prototype", it refers to that removed dump. All citations below are `file:line` into the installed deployment, using the same shorthands as `FEASIBILITY.md`: `nm/` = the deployment's `@deepseek-ai/dsh/node_modules/@deepseek-ai/`, `DSH_HOME/` = the DSH home (`$DSH_HOME`, else `~/.dsh`).

## Decision recorded

**Mount level: preset only.** The plugin is named by **one row inside `agents/backends/dsh/agent.cordis.yml`** (installed as `DSH_HOME/.agent-presets/my-workbench/agent.cordis.yml`) and replaces the seven `@deepseek-ai/dsh-tool-subagent` rows. Nothing is added to `DSH_HOME/profiles/web/cordis.patch.yml`, and no bundle or profile layer gains a row. The shipped presets `standard`, `ptc`, `minimal`, `cordis` are untouched — no extra tools, no extra prompt section, no extra UI behaviour.

That this is sufficient is proven by the mount semantics: the preset composition is mounted **once per preset id per process** (`nm/dsh-agent-presets/lib/index.js:1768-1776` single-flight `ensureStanding`, the only `mountPreset` call site at `:1789`), and sessions join it by scope binding (`:1499-1505` `bindScopeParent(agentKey, standing.key)`); child lanes join the same instance (`:1533-1539`). So the plugin's tools, prompt section and settings namespace exist for MyWorkbench sessions only.

---

## 1. Package layout

Source of truth in this repository (template-only, next to the composition template):

```
agents/backends/dsh/
  agent.cordis.yml               # composition template: persona + ONE row naming the lane plugin
  lanes.json                     # authored lane keys, tools, labels, permissions and model routes
  preset.yml                     # picker metadata
  slots/dispatch.md              # the {{slot:dispatch}} text inside the orchestrator prompt
  lane-plugin/                   # the packaged HOST half (preset row: ./lane-plugin/src/index.js)
    host-package/
      package.json
      src/index.js               # host half; {{dep:<alias>}} -> file: URL at install
  lane-plugin-ui/                # the settings PAGE (profile row: file:///…/lane-plugin-ui/src/index.js)
    package.json                 # exports "./client", dsh.client.platform "web"
    src/index.js                 # inert host half — registers nothing
    lib/client.js                # hand-written classic-script bundle (no build step)
```

Installed shape, written by `my-workbench --dsh` — the package directory is copied verbatim, so the repo layout and the installed layout are identical:

```
<DSH_HOME>/.agent-presets/my-workbench/
  preset.yml                     # picker metadata (unchanged)
  agent.cordis.yml               # the row:  name: ./lane-plugin/src/index.js
  lane-plugin/
    package.json                 # copied from host-package/package.json
    src/index.js                 # copied from host-package/src/index.js
    src/prompts.generated.js     # rendered from agents/prompts/*.md (see §3)
    lib/client.js                # copied from client-half/lib/
    node_modules/@deepseek-ai/{schemastery,dsh-tools}   # links created at install time (§5)
```

Why the plugin lives **inside the preset directory** rather than in the profile's `node_modules`: a row named `./lane-plugin/src/index.js` is classified `preset` (`nm/dsh-agent-presets/lib/index.js:140-143`) and imported against the composition's own `baseUrl`, which `Include` set to the composition directory (`nm/cordis-plugin-include/lib/index.js:138`; doc at `nm/dsh-agent-presets/lib/index.js:112`). That resolution is deterministic and needs **no install, no pnpm, and no profile write** — and it travels with the preset, so uninstall is a directory delete.

---

## 2. `package.json` (host-package)

```json
{
  "name": "my-workbench-lanes",
  "version": "0.1.0",
  "private": true,
  "description": "MyWorkbench specialist lanes as a packaged DSH agent-preset plugin.",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": []
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  }
}
```

(`host-package/package.json` is shipped as this file. Its two `peerDependencies` are documentation of what the baked `file:` URLs point at — nothing installs them; §5 has the mechanism.)

Field-by-field justification:

| Field | Why | Evidence |
| --- | --- | --- |
| `"type": "module"` | the row's import goes through Node's ESM loader | `nm/cordis-plugin-loader/src/config/tree.ts:155` |
| `"main"` / `"exports"."."` | the row's `name` resolves to a module entry | `nm/dsh-tool-jobs/package.json` |
| `"exports"."./client"` | **mandatory** for the client half; the key is fixed, the target is free | `nm/dsh-client-modules/lib/index.js:158`, `:654-655` |
| `"dsh"."client"."platform": "web"` | without it the client scan skips the package | `nm/dsh-client-modules/lib/index.js:648-650` |
| `"private": true` | it is never published; the install is a directory copy | — |

The host module exports `name`, `inject`, `apply`, `Config` — the shipped convention, with no default export (`nm/dsh-tool-jobs/lib/index.js:15-26,353`; `nm/dsh-tool-todo/lib/index.js:196`; loader interop at `nm/cordis-plugin-loader/src/index.ts:193-198`).

**One row replaces seven.** In the composition template the whole `delegation` group's seven `@deepseek-ai/dsh-tool-subagent` rows (`agents/backends/dsh/agent.cordis.yml:183-261`) collapse to:

```yaml
- id: lanes
  name: ./lane-plugin/src/index.js
```

The group wrapper may stay for readability. `tool-subagent-control` (`:174-178`) stays as-is — it is a different package and still needed for `send_message`/`list_agents`/`interrupt_agent`.

---

## 3. How the prompts ship

`agents/prompts/*.md` stays the prompt source. `agents/backends/dsh/lanes.json` supplies the lane keys; the CLI renders each corresponding prompt into `src/prompts.generated.js` with `JSON.stringify`, and renders the host and page rosters from the same record. The DSH composition still embeds the orchestrator with `{{prompt:orchestrator}}`. The former `prompts.template.js` and its second handwritten key list were removed.

**Alternative considered and rejected:** shipping the seven `*.md` files beside the plugin and reading them with `node:fs` at runtime. It works, but it needs runtime file I/O and a path resolved from `import.meta.url`, and it puts a second copy of the prompt text on disk that `assemble --check` cannot verify.

**Why not keep scraping the installed composition** (what the deleted prototype did): it re-parses YAML in the plugin, it silently degrades to "no persona found" when the preset is edited, and it makes the preset the prompt source instead of `agents/prompts/*.md`. The generated module removes all three problems and lets the CLI fail loudly at install time.

---

## 4. How the pins persist — the settings namespace

**Namespace:** `my-workbench-lanes` (matches `/^[a-z][a-z0-9-]*$/`, `nm/dsh-settings/lib/index.js:82-84`).

**Registration** (inside `apply`, once, on the plugin's fiber):

```js
import z from '@deepseek-ai/schemastery'   // nm/dsh-tool-jobs/lib/index.js:1

const LanePinSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default('')
})
const LaneSettingsSchema = z.dict(LanePinSchema).default({})

const scope = ctx.settings.register(LANE_NS, LaneSettingsSchema, { applies: 'live' })
const pins = () => scope.get()
ctx.effect(() => scope.watch(() => { /* nothing to do: pins() is read per spawn */ }))
```

Contract facts this relies on:

- `register(ns, schema, options)` returns `{ get, watch, update, replace }` and installs the registration as a **fiber effect**, so it unwinds with the mount (`nm/dsh-settings/lib/index.js:281-314`, effect at `:294-297`).
- Duplicate registration throws (`:283`). Safe here because the preset composition is mounted once per preset id per process (`nm/dsh-agent-presets/lib/index.js:1768-1776`). **Constraint to write down in the code:** this plugin must be named by exactly one preset; adding the row to a second composition would make the second mount fail.
- Resolution is schema defaults → `base` → user layer (`nm/dsh-settings/lib/index.js:509-513`).
- `applies: 'live'` is already the default (`:288`), so a GUI write takes effect on the next lane spawn with no restart — matching the prototype's behaviour but now durable.
- Storage: `<DSH_HOME>/settings.yaml` (`nm/dsh-settings-file/lib/index.js:32`, `:27`; atomic + file-locked at `:164-171`). Today that file exists (2086 bytes).

**Read path in the host half:** `scope.get()[laneKey]`, defaulting to *inherit* when the entry is missing or `provider`/`model` is empty. It is read at spawn time, not cached, so a GUI write applies to the next delegation.

**Write path from the GUI:** `ctx.remote.settings.update('my-workbench-lanes', patch, revision)` — the generated Remote signature is `update: (ns, patch, expectedRevision) => Promise<RemoteResult<SettingsNamespaceView>>` (`nm/dsh-api-settings-controller/lib/typert.remote-client.d.ts`), host side at `nm/dsh-api-settings-controller/lib/index.js:532-547`, real client usage at `nm/dsh-client-ui-agent-preset/lib/client.js:416-419`. Resetting a lane to *inherit* is a write of `{ provider: '', model: '', reasoningEffort: '' }`, not an `unset` — the schema admits empty strings, which keeps the client on the simpler `update`/`replace` pair.

**No package-private RPC.** The prototype's `host.call('get-state' | 'set-lanes')` exists only for dynamic Cordis packages; a packaged plugin has no such channel. Everything the page needs is already on the shipped wire:

- pins: `ctx.remote.settings.describe()` → `namespaces[].value` + `revision` (`nm/dsh-settings/lib/types/types.d.ts`).
- model/effort catalog: `ctx.remote.session.modelCatalog()` (`nm/dsh-api-session-controller/lib/typert.remote-client.d.ts:23`), whose `groups[].models[].reasoning.efforts[]` is the per-model effort list (`nm/dsh-api-session-controller/lib/types/types.d.ts`, `ModelReasoning`/`ModelReasoningEffort`). `ctx.remote.llm.listProviders()` returns only `{id, name}` and is **not** a source of models or efforts (`nm/dsh-llm/lib/types/types.d.ts:180-185`).

---

## 5. The two bare imports (the only install-time step)

The host half imports two packages by bare name:

```js
import { defineTool } from '@deepseek-ai/dsh-tools'   // nm/dsh-tool-jobs/lib/index.js:4
import z from '@deepseek-ai/schemastery'              // nm/dsh-tool-jobs/lib/index.js:1
```

A plugin at `<preset dir>/lane-plugin/src/index.js` cannot reach either: Node's upward walk goes to `.agent-presets/node_modules`, `DSH_HOME/node_modules` (does not exist — verified), the home directory's `node_modules`, then the filesystem root's.

**As shipped, the CLI bakes absolute `file:` URLs.** The host module carries two `{{dep:<alias>}}` placeholders (declared in `DSH_LANE_PLUGIN_DEPS`, `bin/my-workbench.js`), and `--dsh` replaces each with the resolved entry URL of the deployment's own copy:

```js
import { defineTool } from 'file:///…/dsh-tools/lib/index.js'
import z from 'file:///…/schemastery/lib/index.mjs'
```

Resolution order (`dshModuleRoots` → `resolveDshPackage`), most specific first:

1. `<DSH_HOME>/profiles/node_modules` — DSH's own installation dependency closure. **Both packages resolve here on this machine** (verified: each is a Junction into the harness install).
2. `<DSH_HOME>/profiles/<profile>/node_modules` and `<DSH_HOME>/profiles/<profile>/.dsh-module-fallback/node_modules` — on this machine only `schemastery` is present in the first (a real pnpm-managed directory); `dsh-tools` is absent, so step 1 is what makes `defineTool` importable here.
3. `MY_WORKBENCH_DSH_NODE_MODULES` — an explicit override for other layouts.
4. The `dsh` launcher's own npm install, located on PATH and never executed — the last resort (`dshLauncherModuleRoots`). The harness ships its dependency closure bundled inside the package, so `<install>/node_modules/@deepseek-ai/dsh/node_modules` carries both packages even before DSH's first start heals `<DSH_HOME>/profiles/node_modules`. Both layouts are covered: an npm shim beside `node_modules/` (Windows) and a symlink resolved into the package tree (unix). Added after a fresh deployment hit the gap: `~/.dsh` existed (the "DSH is not installed" prereq passed) but DSH had never started there, so 1–3 were all empty and the install refused.

The entry file comes from the package's own manifest (`exports["."]`, preferring `default` then `import` then `require`, else `module`/`main`), which is what selects schemastery's ESM build rather than its CJS one. When nothing resolves, the install **fails before the first write**, names every path it searched, and reports whether a `dsh` launcher was found on PATH at all.

This is why the user runs no dependency command, and why the install tree is self-contained: the only machine-specific text in it is those two URLs.

**Documented manual fallback (PLAN §5, superseded).** If a deployment cannot resolve the packages and the user prefers links over baked URLs, create junctions (symlinks on POSIX) at `<preset dir>/lane-plugin/node_modules/@deepseek-ai/{schemastery,dsh-tools}` pointing at the same roots, restore the bare specifiers, and DSH resolves them the ordinary way. Two links are enough: Node resolves a symlinked package to its real path, and from there the package's own bare imports resolve through the harness's dependency closure.

**Rejected alternative:** hand-rolling a schema object — the host only needs `schema(value)` and `schema.toJSON()`, but `describe()` serializes every registration's schema for the *shipped* settings page, which rehydrates it with `new Schema(json)` (`nm/dsh-settings/lib/types/types.d.ts`, `SettingsNamespaceView.schema`); a fake envelope risks breaking a shipped surface.

---

## 6. The client half — a hand-written classic script

**Feasibility verdict: feasible here.** The host concatenates the file verbatim (`nm/dsh-client-modules/lib/index.js:292-293`) and `profile/node_modules/dsh-remote/lib/client.js` is a shipped, hand-written, bundler-free client half (`:22`, `:25`, `:28`, `:2474-2476`). No `tsdown`, no `pnpm` build, no DSH checkout.

Required shape — one file, `lib/client.js`:

```js
window.__ModuleLoader__.load({
  id: 'my-workbench-lanes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')          // the ONLY allowed bare specifier we need

    function LaneSection() { /* React.createElement only — no JSX */ }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'my-workbench-lanes', order: 25, label: 'MyWorkbench 赛道模型' },
        LaneSection
      ))
    }

    exports.name = 'my-workbench-lanes-ui'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
```

The factory's `require` is answered from a frozen **9-specifier** table — exactly `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit` — verified in the shipped shell bundle `nm/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js:114` (`function by(){return{react:ec,"react/jsx-runtime":ic,…}}`, consumed as `r.create({boot:t.__DSH_BOOT__,staticModules:by(),…})`). Anything else throws (`nm/dsh-client-modules/lib/client.js:308`). `require('react')` + `React.createElement` — what the prototype already did — stays inside the allowlist; no CSS-in-JS package is needed because the page injects a plain `<style>`-equivalent string through the ctx's `styles` helper.

The registration pattern is the shipped one: `nm/dsh-client-ui-agent-preset/lib/client.js:1519-1526` `ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: …, order: …, label: … }, Section))`.

The React logic and the recommended mapping were ported over from the prototype, with these substitutions:

| Prototype | Packaged form (shipped) |
| --- | --- |
| `host.call('get-state', …)` / `host.call('set-lanes', …)` | `ctx.remote.settings.describe()` and `ctx.remote.settings.update(ns, patch, revision)` |
| no catalog channel | `ctx.remote.session.modelCatalog()` for the provider/model/effort options |
| four buttons, including 套用推荐映射 | three buttons: 应用 / 全部改回继承 / 刷新模型目录 — the recommended mapping now ships as the namespace's `base` layer (§4), so there is nothing to "apply" |
| applies every lane | writes only lanes whose draft differs from the resolved value, so untouched lanes stay inherited |

Because `describe()` returns only **registered** namespaces (`nm/dsh-settings/lib/index.js:351-352`), the page detects "this session does not mount the plugin" by its namespace being absent, and must render an inert empty state — see §7.

**HMR:** `dsh-client-hmr` stat-polls every boot-graph bundle path (`nm/dsh-client-hmr/lib/index.js:22`, `:93`, `:106`) and re-hashes the bytes (`nm/dsh-client-modules/lib/index.js:541-562`), so saving a hand-edited `lib/client.js` is picked up without any build step. The package README's `pnpm run dev:web` / tsdown watch workflow (`nm/dsh-client-hmr/README.md:32`) is only the *rebuild* half, which a hand-authored bundle does not need. Whether the browser swap needs a page refresh was not determined without executing; expect to refresh.

---

## 7. Client-half scope in other presets

`settings.section` is declared `{ kind: "list", scope: "root" }` by the shipped settings shell (`nm/dsh-client-ui-settings-general/lib/client.js:621-624`), so the section renders in **every** session's settings page, including `standard` / `ptc` / `minimal` / `cordis`. That is the shell's scope and cannot be narrowed from a plugin.

Intended behaviour, so the user's "don't pollute other presets" requirement holds for the UI too:

1. On mount, load `ctx.remote.settings.describe()` and `ctx.remote.session.modelCatalog()`.
2. If `namespaces` contains no `my-workbench-lanes` entry → render a neutral placeholder ("此会话未挂载 MyWorkbench 预设 — 赛道模型设置仅在 MyWorkbench 会话中可用"), **no selects and no buttons**. Nothing is written; no error is shown.
3. If the namespace is present but `writable === false` (`SettingsDescribeValue.writable`), render the values read-only with a note.
4. Otherwise render the lane rows as today.
5. A failed write is reported by the returned `RemoteResult` (`response.ok === false → response.error.message`), matching `nm/dsh-client-ui-agent-preset/lib/client.js:416-419`.

This is why the empty state is not optional: without it, opening settings in a `standard` session would either show dead controls or throw.

---

## 8. How the read-only `toolFilter` returns

`toolFilter` is a first-class field of the subagent request and is enforced by the spawn driver, not by the plugin:

- `nm/dsh-tool-subagent/lib/index.js:518` passes it into the start request.
- `nm/dsh-subagent/lib/index.js:554` `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);`
- `nm/dsh-tools/lib/index.js:2790-2804` — restrict requires a scoped context (`:2792`) and throws on names outside `view(scope).restrictableNames` (`:2801-2803`).

**Why it works now and did not in the prototype.** `restrict()` only accepts names the child inherits — the global layer plus every *ancestor* layer on its scope chain, never its own:

- `nm/dsh-tools/lib/index.js:2865-2868` — `knownNames.add(name); restrictableNames.add(name)` inside the loop over `inherited`; own-layer names are added to `knownNames` and `visible` only (`:2870-2873`).
- `nm/dsh-tools/lib/index.js:2839-2850` documents the rule: "A restriction filters what a scope inherits — the global layer and every ancestor layer on its chain — and never what its OWN layer registers", and explains that this is exactly why a preset-plane tool is an **ancestor** contribution and therefore IS constrained again.

A lane child joins its parent's standing composition (`nm/dsh-agent-presets/lib/index.js:1533-1539` `composeFrom`), so the tools this plugin registers in that standing scope are an ancestor contribution to the child: restrictable and effective. The prototype's `restrict()` call failed only because its own session ran on a preset that registered none of these names (prototype README, "Known limits", item 2).

Reproduce the deny lists exactly from `agents/backends/dsh/agent.cordis.yml:192,203,214,227,239,250,261`:

```js
const LANE_TOOLS = ['subagent_explorer','subagent_librarian','subagent_oracle',
                    'subagent_designer','subagent_fixer','subagent_observer','subagent_improver']
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'   // evaluated in-process

const TOOL_FILTER = {
  explorer:      { deny: ['write','edit', ...LANE_TOOLS.filter(n => n !== 'subagent_explorer')] },
  librarian:     { deny: ['write','edit', ...LANE_TOOLS.filter(n => n !== 'subagent_librarian')] },
  oracle:        { deny: ['write','edit', ...LANE_TOOLS.filter(n => n !== 'subagent_oracle')] },
  'designer': { deny: LANE_TOOLS.filter(n => n !== 'subagent_designer') },
  fixer:         { deny: LANE_TOOLS.filter(n => n !== 'subagent_fixer') },
  observer:      { deny: ['write','edit', SHELL, ...LANE_TOOLS.filter(n => n !== 'subagent_observer')] },
  improver:      { deny: ['write','edit', SHELL, ...LANE_TOOLS.filter(n => n !== 'subagent_improver')] }
}
```

The platform conditional is now a plain runtime expression evaluated once at registration — strictly safer than the template's `!!js` (`agent.cordis.yml:250`), because it runs in the process that will actually spawn the child, so the deny list can never name the other platform's shell and make `restrict()` throw.

Each lane's persona comes from `LANE_PROMPTS[laneKey]` (§3). The `persona` and `toolFilter` fields go into the same request object the prototype already built.

---

## 9. Install, verify, rollback — for the user to run

Nothing below was executed in this phase (no DSH restart, no installer, no write under `DSH_HOME`).

### Install (variant B, shipped form)

```powershell
# 1. In the repository: render + install the preset (the plugin ships inside it)
cd <repo>                                      # the my-workbench checkout
node bin/my-workbench.js assemble --check      # must pass
npx my-workbench --dsh --force                 # rewrites .agent-presets\my-workbench\ (plugin included)

# 2. Confirm the preset directory
Get-ChildItem "$env:USERPROFILE\.dsh\.agent-presets\my-workbench" -Recurse -Depth 3
#    expect: preset.yml, agent.cordis.yml,
#            lane-plugin\{package.json, src\index.js, src\prompts.generated.js, lib\client.js}

# 3. Confirm the two baked imports point at real files
Select-String -Path "$env:USERPROFILE\.dsh\.agent-presets\my-workbench\lane-plugin\src\index.js" -Pattern '^import '
#    the two file: URLs must both exist on disk; if the install refused instead
#    (it names every path it searched), boot DSH once so it heals
#    <DSH_HOME>/profiles/node_modules, then re-run.
```

`--dry-run` is safe to try first: it prints the same lines and writes nothing.

Then **start a new DSH session** on the MyWorkbench preset — presets are read at session start.

### Verify

1. The session starts at all. A preset row that fails to import or apply fails the mount loudly (`nm/dsh-agent-presets/lib/index.js:918-921`, `:928-937`).
2. The seven `subagent_*` tools are listed and no `lane_*` tools are — and, in a session on any other preset, **neither** appears.
3. No `my-workbench-lanes: lane "…" has no persona` warnings: that warning means `src/prompts.generated.js` was not rendered or not shipped (§3).
4. `settings → MyWorkbench 赛道模型` shows seven lanes with a model select and an effort select; the effort options come from `session.modelCatalog()`.
5. Pin `oracle` to a route + effort, run a delegation, and check the child's session log: its first `request/header` should carry the pinned provider/model/effort (this is exactly how the prototype was validated).
6. Restart DSH and re-open the page: the pins are still there and present under `my-workbench-lanes:` in `~/.dsh/settings.yaml`.
7. A read-only lane that tries to write must be refused (`write`/`edit` denied), and a lane must be unable to delegate (`subagent_*` denied in its scope). If a spawn instead fails with `tools.restrict() names unknown global tool …`, the plugin's tool names and its deny lists have drifted apart (§8).
8. Open settings in a `standard` session: the section shows the inert placeholder (§7), not live controls.

### Rollback

Fully contained — nothing at profile level was changed:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\.agent-presets\my-workbench\lane-plugin"
# then re-install the previous composition (or the whole preset) from a checkout at the previous commit:
cd <repo>                                      # the my-workbench checkout
git stash list   # nothing was committed by this work
npx my-workbench --dsh --force
```

Optionally delete the `my-workbench-lanes:` block from `<DSH_HOME>/settings.yaml` to forget the pins; leaving it is harmless (an unregistered namespace is simply not read).

### Fallback form P, if the relative row name proves unusable

Only relevant if verification step 2 fails (row import, or client-half discovery):

```powershell
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\.agent-presets\my-workbench\lane-plugin"
# row in agent.cordis.yml becomes:   name: my-workbench-lanes
dsh plugin --profile web remove my-workbench-lanes   # rollback
```

This also removes the need for the §5 links: an installed package sits in `DSH_HOME/profiles/web/node_modules/`, from where Node reaches both the profile's own `node_modules` and the `DSH_HOME/profiles/node_modules` junction farm. `dsh plugin` forwards to `pnpm` with `cwd` = the profile directory (`dsh/lib/plugin-Ddi42qoW.js:102-113`) and installs a **dependency only** — it inserts no row, so no other preset or surface is affected. It does write `DSH_HOME/profiles/web/package.json` and `pnpm-lock.yaml`, which is the cost of this fallback. See `FEASIBILITY.md` §2 for the resolution reasoning and its residual uncertainty.

---

## 10. Variants

| | Mount point | Tool names | Install cost | Status |
| --- | --- | --- | --- | --- |
| **A** | one row in `DSH_HOME/profiles/web/cordis.patch.yml` (profile level) | must be `lane_*` — a root-realm registration would collide with the preset's `subagent_*` names and would add tools to every preset | `dsh plugin --profile web add` | **rejected by the user** — pollutes every preset and every session |
| **B** | one row inside the MyWorkbench preset composition | `subagent_*` (replaces the seven rows; no collision possible, `slots/dispatch.md` unchanged) | none by default; two dependency links inside the preset dir | **recommended — this plan** |
| **C** | keep the prototype's `lane_*` tools and leave the preset's seven rows alone | `lane_*` | the prototype's persistence problem is fixed the same way | viable, but keeps two tools per specialist, doubles the tool catalog, and forces an edit to `slots/dispatch.md`; superseded by B |

Why A is wrong, concretely: a profile-level row registers into the **root** realm, so its tools, prompt section and settings namespace exist for `standard`/`ptc`/`minimal`/`cordis` sessions too — exactly what the user ruled out. B gets the same functionality through the standing-mount scope, which only MyWorkbench binds to (`nm/dsh-agent-presets/lib/index.js:1499-1505`).

---

## 11. Decisions — all six LOCKED and implemented

1. **Tool names → `subagent_*`** (locked). `agents/backends/dsh/slots/dispatch.md` and every deny list stay unchanged, and the names cannot collide because they are preset-scoped.
2. **Row form → relative** (locked): `name: ./lane-plugin/src/index.js`. No pnpm, no profile write. The residual worry — whether `dsh-client-modules` finds the plugin's `package.json` for a relative row name (`nm/dsh-client-modules/lib/index.js:637-679`) — is now verification step 2 in §9; Form P remains the escape hatch.
3. **Dependency mechanism → baked `file:` URLs** (locked). The CLI resolves both packages under the DSH home and writes absolute URLs into the installed host module, so the user runs no dependency command. The junction/symlink recipe survives as the manual fallback in §5.
4. **Recommended lane mapping → the settings `base` layer** (locked): `settings.register(ns, schema, { base: RECOMMENDED })` (`nm/dsh-settings/lib/index.js:287`). It shows as inherited-but-not-overridden in `describe()`, which the shipped settings surface understands, and 全部改回继承 writes empty strings into the user layer to override it lane by lane.
5. **UI language → Chinese** (locked), consistent with the shipped preset names. The strings are hard-coded rather than registered as a locale namespace.
6. **Prompt section → dropped** (locked). `slots/dispatch.md` already names the seven lanes, so the prototype's `systemPrompt.section` is gone and the orchestrator prompt stays byte-identical for request caching.

One decision this plan did **not** settle, resolved during implementation:

7. **Effort vocabulary when the pinned route is not in the catalog.** The page drives the effort select from `session.modelCatalog()`, so a pin whose route/model has disappeared has no catalog entry. Implemented as: the stored provider/model (and the stored effort) stay **visible as an extra, marked option** ("（目录中已不存在）") rather than being silently rewritten or cleared, and 全部改回继承 remains the explicit way out.

## 12. Not covered by this plan

- `agents/prompts_cn/*` and the other backends: unaffected, since the lane plugin is a DSH backend artifact only.
- Deployment of the built plugin into the **real** DSH home: the user owns that run (`npx my-workbench --dsh --force`) and the DSH session restart that picks it up.
