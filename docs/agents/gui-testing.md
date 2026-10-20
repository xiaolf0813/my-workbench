# GUI testing convention

Agent GUI testing is slow when locating a control means looking at pixels. The fix is structural: freeze control identity at build time, resolve coordinates at run time, and keep screenshots for visual verdicts only. The driver agent consumes this convention; the tested project owns the data.

## Division of labor

- **driver** — operates the surface: resolves aliases against the live text tree, acts, asserts, reports pass/fail. Text in, text out; one whole scenario per dispatch.
- **spotter** — captures pixels and judges appearance only; never locates controls.
- **fixer** — owns identity tags in the app source, the registry generator, and repairs for broken locators reported by driver.

## The three layers

1. **Registry (generated, committed)** — `gui-test/registry/<screen>.yaml`: per screen, alias → locator chain (platform identity key first, then text, then content-desc, then hierarchy path; list rows carry a scope), plus a screen signature (the expected identity set) for wrong-screen detection.
2. **Runtime protocol** — on screen entry: acquire the text tree, verify the signature, resolve alias → bounds computed fresh, act, assert from the tree. Same-screen steps reuse the tree; re-acquire after navigation, scroll, or any layout change.
3. **Drift check (CI)** — the generator reruns on every build and diffs against the committed registry: new controls, renamed/removed locators, dangling aliases. Tests reference aliases only, so a rename is a one-line mapping edit.

Two iron rules: coordinates are never stored; bounds are always resolved fresh. Window size, density, rotation, and font scale stop mattering by construction.

```yaml
# gui-test/registry/order_detail.yaml
screen: OrderDetail            # Activity or navigation route
signature: [topbar, order_status, pay_button]
controls:
  - alias: pay_button
    locate: { id: "com.app:id/btn_pay" }        # View world
  - alias: pay_button_cmp                       # Compose world (tag surfaces as resource-id)
    locate: { id: "com.app:order_detail/pay_button" }
    fallback: { text: "@string/pay_now" }
  - alias: order_row
    scope: order_list                           # container scope for dynamic lists
    locate: { id: "com.app:order_row/{biz_id}" }  # runtime parameter
```

## Toolkit shape

A thin CLI in the tested project (text in, text out — agent-friendly):

- `gui locate <screen> <alias> [--scope k=v]` — print bounds + center for the alias, resolved against a fresh or current tree
- `gui assert-screen <screen>` — signature check; nonzero exit on mismatch
- `gui dump` — acquire and print the text tree (identity + bounds per node)

## Per-platform adaptation

| Platform | Identity key | Text tree | Action channel | Generator input |
| --- | --- | --- | --- | --- |
| Android (Views) | resource-id | `uiautomator dump` | `input tap` (center of bounds) | `res/layout/*.xml` (id, text via strings, contentDescription) |
| Android (Compose) | testTag (needs `testTagsAsResourceId = true`, incl. dialog roots) | `uiautomator dump` (retry on stale) or in-app semantics dump | `input tap` | Kotlin `Modifier.testTag(...)` scan |
| Web | `data-testid` / selector | CDP DOM/ARIA snapshot | Playwright / CDP click | frontend source scan |
| Windows native | UIA AutomationId / Name | UIA tree | UIA Invoke/Pattern (no coordinates) | XAML `x:Name` / source scan |
| Tauri / Electron | DOM testid | CDP (WebView2 debug port / `--remote-debugging-port`) | same as Web | same as Web |
| iOS | accessibilityIdentifier | XCUITest / idb a11y dump | idb / XCUITest | SwiftUI/UIKit source scan |

Prefer semantic actions (UIA Invoke, DOM click, a11y actions) over coordinate taps where the tree API offers them; coordinate tapping is the last resort for tree-less surfaces only.

## Brief contract (driver)

Surface facts (URL / window / device / adb serial) + the scenario as ordered steps with expected states + project paths (recipe `gui-test/README.md`, registry). One scenario per dispatch. Driver's misses route back to fixer (identity tags, generator); recurring driver failures route to improver.

## Bootstrap: what fixer builds

When driver reports "cannot operate", the orchestrator commissions fixer with this section as the spec — the deployable copy travels in `agents/solutions/toolkit-gui-test.md` (platform-neutral) plus the per-platform `*-gui-test.md` guides, so any project can be bootstrapped from zero; no pre-existing convention required. Once the toolkit lands, copy the convention into the target project's own instructions (its root AGENTS.md "Agent skills" section) so future sessions there inherit it without this deployment.

Build order — each step is independently useful, stop after any of them:

1. **Recipe first** — `gui-test/README.md`: the platform's tree acquisition, action commands, and surface facts (adb serial, dev-server URL, debug port). One page. Acceptance: an agent can go from "launch the app" to "dump + tap by resource-id" following only this file.
2. **Identity tags** — add the platform identity key to the interactive nodes tests need (Android Views usually have resource-ids already; Compose needs `Modifier.testTag` + root `testTagsAsResourceId`, dialog roots included). Acceptance: a manual dump shows the identity on those nodes.
3. **Registry + CLI** — `gui-test/registry/<screen>.yaml` (hand-write it for the screens under test; the generator can come later) plus the thin `gui` script. Acceptance: `gui assert-screen` exits nonzero off-screen and zero on-screen; `gui locate` prints bounds + center.
4. **Generator + CI drift check** — automate the registry from source (generator input per the table above); CI fails on dangling aliases. Acceptance: renaming a locator fails CI naming the dangling alias.
5. **Optional in-app hook** — debug-build semantics dump as the ground-truth backend for dialogs and every window.

## Rollout

1. **Phase 0, zero code change**: adopt the runtime protocol — dump once per screen state, locate by text/content-desc fallbacks, screenshots only for verdicts. No toolkit required. (A rollout stage for the human/scripted suite — the deployed driver contract still requires a toolkit and reports cannot-operate without one.)
2. **Phase 1+**: the build order in "Bootstrap" above — identity tags, registry + CLI, generator + CI drift check, optional in-app hook.
