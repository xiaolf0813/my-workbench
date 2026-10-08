# lane-plugin-ui — the MyWorkbench lane settings page

A tiny DSH **client** plugin (plus a deliberately inert host half) that renders *settings → MyWorkbench 赛道模型*: one row per specialist lane with a model select and a reasoning-effort select, plus 应用 / 全部改回继承 / 刷新模型目录.

It owns no state. The pins themselves live in the `my-workbench-lanes` settings namespace, registered by the lane host half in the MyWorkbench agent preset (`../lane-plugin/`). This package only reads that namespace through `ctx.remote.settings.describe()` and writes it through `ctx.remote.settings.update(ns, patch, revision)` — there is no host RPC, and the inert host half exists solely because the loader needs a module to mount.

## Why this is a profile row and not part of the preset

`dsh-client-modules` discovers client halves by scanning the **profile Loader's own entries**:

- `nm/dsh-client-modules/lib/index.js:775-781` — `processOne()` iterates `this.ctx.loader.entries()`.
- An agent preset is a separate Loader tree mounted under a scope, so its rows are never scanned and `clientModules.clientPath('my-workbench-lanes')` stays `undefined`.
- `locatePkgJson` (`:679-709`) *does* support `./`-relative and `file:` row names — the Loader tree is the blocker, not the name form.

The lane host half therefore mounts correctly and its settings namespace is registered, but no page is served from inside the preset. One profile row is the only way in, and that row is this package's entire profile-level footprint.

## Footprint

| Where | What |
| --- | --- |
| `<DSH_HOME>/.agent-presets/my-workbench/lane-plugin-ui/` | this package, copied by `my-workbench --dsh` |
| `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` | ONE marked, managed block per profile, each containing one `insert:` row (`id: my-workbench-lanes-ui`, `name: file:///…/lane-plugin-ui/src/index.js`) |

A profile is a separate composition per DSH process, so the row is per profile and not per DSH home: `my-workbench --dsh` writes it into **every** profile it finds under `<DSH_HOME>/profiles/` — `web` for `dsh web`, `desktop` for DSH Desktop — using the structure rather than a name list (a profile is a directory carrying `cordis.yml` or `cordis.patch.yml`; `node_modules` there is DSH's shared dependency root and never a profile), and into the single profile named by `--dsh-profile <name>`. With no profile directory to write to, the row is printed instead. Installing while DSH runs is reported first: DSH refuses profile changes while its desktop app is up, and a live process keeps the composition it booted with.

Nothing else: no tools, no prompt sections, no services, no packages installed into any `node_modules`, no dependencies at all (`package.json` declares none).

## Identity

One name, three places — the package name, the browser module id the bundle registers under, and the id its `settings.section` occupant carries — all `my-workbench-lanes-ui`, so one nav entry names one package. The occupant id used to be the *host* half's settings namespace (`my-workbench-lanes`), which pointed a reader at the wrong package. The version in `package.json` is rendered from the CLI's own version at install time, and the same version is written into this file's header, because a client package has no manifest field the shell reads: `dsh-client-modules` accepts only `id/url/rev/inject/external/immediately` on a boot-graph entry.

## Registration

`apply()` registers the `settings.section` page **synchronously** — no probe, no `await` before `slots.register`. The component decides what to show:

- **Namespace present** → the specialist lanes with a model select and an effort select.
- **Namespace absent** → an inert placeholder: no selects, no writes.

Why the gate moved into the component: registering *after* an `await` (the first implementation probed `describe()` up to six times, 500 ms apart, before registering) left the shell's ledger entry for this section `active: false` while every other section was `active: true`. The nav entry appeared, the panel rendered blank, and `clientPath(...)` was fine — the registration itself was the problem, not discovery.

Consequences: a deployment that never mounts MyWorkbench shows the nav entry with no controls and no write path; once any MyWorkbench session has mounted the host half the namespace is process-global, so the page is live from every session (it edits pins only MyWorkbench sessions consume). The component re-reads the namespace every time the section is opened, so a page reload is only needed to pick up a changed bundle.

A class error boundary (`RenderGuard`) wraps the page, so a throw in its render pass shows the message in place instead of a blank panel.

## Verifying and rolling back

```powershell
# after `npx my-workbench --dsh --force` and a page refresh:
#   settings → MyWorkbench 赛道模型 shows the specialist lanes
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"     -Pattern 'my-workbench-lanes-ui'
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern 'my-workbench-lanes-ui'

# rollback: remove the preset directory AND every marked block
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\.agent-presets\my-workbench"
```

`my-workbench --dsh --force` restores the preset and each block. The desktop app composes the `desktop` profile, so a page that appears in the browser but not in DSH Desktop means that profile has no block — re-run the install (or `--dsh-profile desktop`) with the desktop app closed, since DSH refuses profile changes while it runs.
