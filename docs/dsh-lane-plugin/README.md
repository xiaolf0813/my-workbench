# DSH lane plugin — design record

Internal notes for the `--dsh` lane plugin. **Not shipped**: `package.json`'s `files` whitelist covers `bin/`, `agents/prompts/` and `agents/backends/` only, so everything here stays in the repository.

| File | What it is |
| --- | --- |
| `FEASIBILITY.md` | The investigation behind the design: the plugin-package contract, how client halves are discovered and served, how `name:` resolves for a preset row versus a profile row, the settings-persistence contract, and how prompts ship — each claim with a file:line citation from the installed deployment. |
| `PLAN.md` | The chosen form (preset-mounted host half + profile-mounted settings page), package layout, install/verify/rollback steps, variants, and the decisions that were left to the user. Phase-3 amendment at the end. |
| `UPSTREAM-ISSUE.md` | Draft report for the upstream stale-remount leak: the minimal reproduction, the root cause with file:line citations, and how to post it (upstream Issues are off; Discussions Q&A is the channel). |

The shipped code lives beside the composition it belongs to: `agents/backends/dsh/lane-plugin/` (host half) and `agents/backends/dsh/lane-plugin-ui/` (settings page).

## Runtime mechanics that constrain edits

Two deployment behaviours are not visible in the source and routinely surprise a change to the lane plugin.

**Reinstalling re-mounts without disposing the previous mount.** `ensureStanding` (`nm/dsh-agent-presets/lib/index.js:1768-1776`) drops a standing mount whose composition stamp changed and mounts a fresh one *without* disposing the old scope, so the previous `my-workbench-lanes` registration is still live when the new `apply()` runs. `settings.register()` therefore throws on the taken name — the shipped host half catches that, logs it, and reads through the surviving registration, whose schema and base are identical. Removing that tolerance makes `my-workbench --dsh --force` wedge the preset until a DSH restart.

**A host-half change needs a full DSH restart.** The preset row is imported once per process: Node's ESM cache holds the first import, and the loader re-imports the same specifier when it re-mounts a stale composition. So `--dsh --force` alone leaves a running DSH on the previous host code. The settings page is a browser module instead — a page reload picks up a changed bundle.

## Where this sits against DSH's own plugin contract

Verified against the installed harness (`@deepseek-ai/dsh-agent-presets@0.1.5-rc.3`, `dsh-client-modules`, `dsh-plugin-package-inventory-deepseek`). The four load-bearing pieces are the documented contract, not conventions this repo invented:

| Contract | Evidence in the deployment | Our form |
| --- | --- | --- |
| A user preset is a directory under `<DSH_HOME>/.agent-presets/` whose composition file is `agent.cordis.yml`, with optional `preset.yml` display metadata | `dsh-agent-presets/lib/index.js:181` (`COMPOSITION_FILE`), `:36` (`METADATA_FILE`), `:195` (`USER_PRESET_DIR`); the shipped presets are static files this package publishes as data (`package.json` `files: ["presets"]`), not plugins | identical |
| A host plugin is an ESM module exporting `name`/`inject`/`apply`/`Config` | `dsh-tool-jobs/lib/index.js:15-26,353` | identical |
| A client half is discovered only on a **profile** Loader entry, needs `dsh.client.platform === "web"` + `exports["./client"]`, and is a classic script registering through `window.__ModuleLoader__.load` whose `factory(require)` may only require the shell's nine seed modules | `dsh-client-modules/lib/index.js:648-655`, `:775-781`, `lib/client.js:83-101` | identical |
| Settings persist through `ctx.settings.register(ns, schema, { base })` into `<DSH_HOME>/settings.yaml` | `dsh-settings/lib/index.js:281-315`, `dsh-settings-file/lib/index.js:32` | identical |

**Deliberate deviations, and their cost.** These are choices with reasons, not oversights; each is the price of the project's "no downloads, no dependency command" invariant.

1. **The client half is mounted by a `cordis.patch.yml` row instead of being installed with `dsh plugin --profile <p> add <spec>`.** DSH has no manifest field for "this package contributes a client half to whatever mounts it" — a client half is only ever found by scanning the profile Loader's own entries — so a profile row is the only way to reach the browser from a preset-owned feature. `dsh plugin` is a pnpm forwarder that also writes the profile's `package.json` and `pnpm-lock.yaml` (`dsh/lib/plugin-Ddi42qoW.js:96-113`), which would break that invariant. **Cost:** the plugin never appears in DSH's bundle list, and its only trace in DSH's own reporting is the `{name, version}` package inventory described below.
2. **The host half's two imports are baked as absolute `file:` URLs at install time instead of declared as dependencies.** A plugin under `$DSH_HOME/.agent-presets/` cannot resolve a package by bare name — Node's upward walk from there reaches no package carrying it. **Cost:** the installed `src/index.js` is machine-specific, so re-run `--dsh` after DSH is reinstalled or its launcher moves.
3. **Manifests are rendered, not authored.** `--dsh` writes its own version into both installed `package.json` files and into the browser half's header comment, because `dsh_plugin_packages` (which follows the official DeepSeek request path) reports each active package as `{name, version}` from its nearest manifest, while a client package has no manifest field the shell reads at all. The source copies hold the same version as a placeholder so the two can be compared: `assemble --check` fails on a drift, which is the only thing keeping a release from shipping a stale literal.

**Identity.** One name per artifact, in four places: the `LANE_HOST_PACKAGE`/`LANE_UI_PACKAGE` constants in `bin/my-workbench.js`, the source `package.json` `name`, the bundle's module `id`, and the `settings.section` occupant `id`. The occupant id was once the *host* half's settings namespace (`my-workbench-lanes`), which made one nav entry appear to belong to the other package; `assemble --check` now fails if any of the four disagree.

**Known operational constraint.** DSH refuses profile changes while DSH Desktop runs, and a live process keeps the composition it booted with — so an install against a live DSH lands on disk without taking effect. `--dsh` reads the process table and warns before writing (`dshRunning()`); the `DSH_PROFILE_PROBE` override exists so the test suite can exercise every answer without a live DSH.
