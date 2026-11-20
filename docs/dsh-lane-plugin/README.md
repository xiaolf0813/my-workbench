# DSH target — design record

Internal notes for `my-workbench --dsh`. **Not shipped**: `package.json`'s `files` whitelist covers `bin/`, `agents/prompts/`, `agents/backends/` and `agents/solutions/`, so everything here stays in the repository.

## What DSH 0.2.x actually reads

The target was rewritten against DSH `0.2.1-rc.2`…`0.2.x` after the old design (an `<DSH_HOME>/.agent-presets/<id>/` directory with `preset.yml` + `agent.cordis.yml`) stopped working: that directory is not read by any 0.2.x code path (`@deepseek-ai/dsh-agent-preset`'s `dsh-doc` reference states it outright). Four facts shape the current shape:

| Fact | Evidence in the installed harness |
| --- | --- |
| A preset is an ordinary Loader row: `@deepseek-ai/dsh-agent-preset` with `config: { id, name, description, order, plugins }` | `@deepseek-ai/dsh-agent-preset/lib/index.js` (`Config`, `agentPresets.register`); the shipped `@deepseek-ai/dsh-web-app/presets/*.patch.yml` |
| A preset child row's `name` resolves from the **declaring tree's** base URL, not from a preset directory | `dsh-agent-preset-registry`: `mountPreset` → `prepareProfileEntries(ctx, plugins, ctx.baseUrl)` / `scope.ctx.extend({ baseUrl })` |
| A subagent's identity and tools come from the preset it mounts; `SubagentStartRequest` has neither `persona` nor `toolFilter` | `@deepseek-ai/dsh-subagent` README ("Child presets") and the generated `SubagentStartRequest` type; upgrade guide `v0.2.1-alpha.1/subagent-preset-composition` |
| The home-level patch layer `$DSH_HOME/cordis.patch.yml` is applied after every profile's own patch, for every profile | `@deepseek-ai/dsh-app-boot`: `readProfilePatches` concatenates the profile patch and `join(context.home, 'cordis.patch.yml')`; `profile-boot` passes `home: resolveDshHome()`; Desktop boots through the same `runProfile` |

The home layer is what makes one install serve `dsh web`, DSH Desktop, and any other profile: preset declarations are inert until a session selects one, so a home block adds no tool to any other preset. (A profile that does not mount the preset registry leaves the declaration row pending, which is harmless.)

## What the install writes

```
<DSH_HOME>/cordis.patch.yml                     # one marked block: - insert: 8 preset rows
<DSH_HOME>/my-workbench/presets.generated.patch.yml   # the same block, for review/hand-merge
<DSH_HOME>/my-workbench/lane-plugin/package.json      # name my-workbench-lanes, version rendered
<DSH_HOME>/my-workbench/lane-plugin/src/index.js      # the 7 tools; imports only its siblings
<DSH_HOME>/my-workbench/lane-plugin/src/roster.generated.js
<DSH_HOME>/my-workbench/lane-plugin/src/prompts.generated.js
<DSH_HOME>/my-workbench/my-workbench-solutions/       # platform guides
```

Eight presets: `my-workbench` (the orchestrator, order from `preset.json`, currently 5) and `my-workbench-<lane>` for each of the seven `lanes.json` records (order 106+), which exist only to carry a lane's persona and tool set and are selected only by the lane tools. They necessarily appear in the agent-preset picker; their names say `MyWorkbench · <lane>` and their descriptions say not to select them.

## Why a custom plugin still exists

DSH's stock `@deepseek-ai/dsh-tool-subagent` is fire-and-forget: it returns `started subagent <name>` and the report arrives as a completion notice. The whole prompt architecture (orchestrator `Dispatch` rules, `slots/dispatch.md`, queue execution) is synchronous — dispatch lanes, wait for every report, reconcile in the same turn. The plugin keeps that contract by calling `ctx.subagents.startActivation()` directly: `delivery: 'parent'` for a background run, `delivery: 'caller'` plus `await activation.result` for `run_in_background: false`.

It also smooths over one released API difference: `0.2.1-rc.2` takes `{ provider, label, request: {...}, signal, delivery }`, and the next release flattens the task options onto the spec. The plugin tries the flat shape first, falls back to the nested one on a `TypeError`, and remembers the answer for the process. That is why the supported floor is `0.2.1-rc.2` rather than a later release.

## Why the plugin has no package imports

A plugin mounted from a `file:` URL under `<DSH_HOME>` cannot resolve a harness package by bare name, and the earlier design solved that by baking the absolute path of one installation's `dsh-tools` + `schemastery` into the installed module. That tied the install to one DSH installation (this machine had a stale link farm and a second, older global install) and forced a `peerDependencies` range that 0.2.x's compatibility preflight would now reject (`^0.1.5-rc.2` does not match 0.2.x, and a prerelease DSH version cannot be expressed as a semver range).

The current module imports only `./roster.generated.js` and `./prompts.generated.js`, registers plain `ToolDefinition` objects (the registry accepts a raw definition and projects `parameters` as model-facing JSON Schema), and reads its row config as-is. No dependency command ever runs, nothing lands in a `node_modules`, and the manifest declares no dependency or engine range, so the preflight has nothing to refuse.

## Per-lane routes

`<DSH_HOME>/my-workbench-lanes.json` is the user's file:

```json
{ "explorer": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "max" },
  "fixer":   { "provider": "", "model": "", "reasoningEffort": "" } }
```

`--dsh` validates it (known lane keys only, string fields only), renders it into the lane row's `pins`, and never writes the file. Empty strings mean inherit; a lane with no usable pin inherits the session's route. The old settings page is gone: DSH 0.2.x's settings service projects **profile entry** Config fields only, a plugin can no longer register its own persisted namespace, and a preset-scoped plugin is not a profile root entry — so there is no supported way for a page to own pins that a preset-scoped plugin reads. This file is the replacement, and DSH's own Subagent settings still govern which routes a session may use.

## Runtime gate

`bin/dsh-version.js` reads every installation it can find — `DSH_INSTALL_DIR` (set inside a DSH session), each `dsh` launcher on `PATH`, and `<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh` — and the CLI refuses to write when none is inside `>= 0.2.1-rc.2 < 0.3.0`, warning when only some are. "No installation found" is a warning, not a refusal: a Desktop-only machine may expose no launcher, and the declarations are inert if the runtime turns out to be wrong. The ceiling is a release to stop before, so a `0.3.0-*` prerelease is refused even though semver orders it below `0.3.0`.

## Migration and known costs

- `--dsh` removes the pre-0.2 per-profile settings-page row (a Loader row naming the deleted `lane-plugin-ui` package would fail that profile's composition) and deletes `<DSH_HOME>/.agent-presets/my-workbench/`.
- The managed block is ~115 KB: eight full preset compositions, dominated by the eight personas (the orchestrator prompt plus seven lane prompts with the disciplines). DSH parses it once at composition and again on patch reload; there is no way to share a prompt between two presets, because each preset's `plugins` is its complete list.
- `--dsh --force` overwrites the plugin module, its generated modules and the solution guides; a plain re-run refreshes only the version-stamped files and renders the block (which can still change when the pin file changes). A changed plugin module needs a **DSH restart**: the module is imported once per process.
- `no downloads` is intact: no `plugin` entry is pinned, no package is installed, nothing is executed.

## Verifying a change

1. `node bin/my-workbench.js assemble --check` — renders the declarations, checks the plugin's import surface/manifest, syntax-checks the module.
2. `npm test` — the DSH suite installs into a temp home, validates the block shape, idempotency, pins, migration, the version gate, and the installed plugin against a fake context (both activation shapes, background/foreground, abort, error paths).
3. Against a real runtime (read-only): `DSH_HOME=<temp> dsh --profile <name> --from-default-profile web --dump-config` must show the eight `preset-my-workbench*` rows and the `lanes` row's `file:` URL.
4. In a live DSH: restart, pick **MyWorkbench** in a new session, confirm the seven `subagent_*` tools, and run one lane with `run_in_background: false` to see the final report in the same turn.
