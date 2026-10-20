# gui-test toolkit — build spec

The build spec for the project's `gui-test/` toolkit: what to build, in what
order, and how to accept each step. Platform-neutral: pair it with the
matching `*-gui-test.md` platform guide, which carries that platform's tree
acquisition, identity keys, and action channel.

## Layout

    gui-test/
      README.md                  # the recipe: how to launch, dump, and act on THIS app
      registry/<screen>.yaml     # per screen: alias -> locator chain + screen signature
      gui                        # thin CLI: locate / assert-screen / dump

- **`README.md`** — one page: launching the app, the tree acquisition
  command(s), the action commands, and surface facts (adb serial, dev-server
  URL, debug port). Acceptance: an agent can go from "launch the app" to
  "dump + act by identity" following only this file.
- **`registry/<screen>.yaml`** — per screen, alias → locator chain (platform
  identity key first, then text, then content-desc, then hierarchy path; list
  rows carry a scope), plus a **screen signature** (the expected identity set,
  for wrong-screen detection). Hand-write it for the screens under test;
  automate later.

  ```yaml
  screen: Login
  signature: [login/username_input, login/submit_button]
  controls:
    - alias: submit_button
      locate: { id: "login/submit_button" }   # raw Compose testTag
      fallback: { text: "@string/login_submit" }
    - alias: order_row
      scope: order_list
      locate: { id: "order_row/{biz_id}" }   # runtime parameter in a Compose testTag
  ```

- **`gui` CLI** — thin, text-in/text-out:
  `locate <screen> <alias> [--scope k=v]` prints bounds + center resolved
  fresh; `assert-screen <screen>` exits nonzero off-screen and zero on-screen;
  `dump` prints the text tree (identity + bounds per node).

## Iron rules

- Coordinates are never stored; bounds are always resolved fresh from the
  current tree at action time. Window size, density, rotation, and font scale
  stop mattering by construction.
- Identity tags are app-source edits; the registry references them, never
  duplicates them.
- Same-screen steps reuse the acquired tree; re-acquire after navigation,
  scroll, or any layout change.

## Build order

1. **Recipe** (`gui-test/README.md`) — see acceptance above.
2. **Identity tags** on the interactive nodes tests need (per the matching
   platform guide). Acceptance: a manual dump shows the identity on those nodes.
3. **Registry + `gui` CLI**. Acceptance: `assert-screen` exits nonzero
   off-screen and zero on-screen; `locate` prints bounds + center.
4. **Generator + CI drift check** — regenerate the registry from source; CI
   fails naming dangling aliases. Acceptance: renaming a locator fails CI
   with the dangling alias named.
5. **Optional** — in-app semantics dump hook as the ground-truth backend.

After the toolkit lands, copy the convention into the project's own
instructions (its root AGENTS.md) so future sessions inherit it without this
deployment.
