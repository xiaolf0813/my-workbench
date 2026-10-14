# M3 Refresh — Port Map (`ui/src/index.css` + `ui/src/icons.tsx`) — 三稿 (final values)

Companion to the `[变更 2026-10 M3 刷新]` pass over `app.html` / `SPEC.md`.

**三稿 headline: LIGHT is the default presentation** (高级纯净 = light/airy/pure).
The mockup ships `data-theme="light"`; **the implementation flips its default theme
at port time — fixer lane**: restructure `index.css` so `:root` holds the LIGHT
tokens and `html[data-theme="dark"]` overrides them (exact values below), and set
the app shell's initial theme to light. Dark stays a maintained secondary variant
re-derived from the same azure seed.

Two lanes, as before:

- **Lane A — layout reconciliation (no port needed):** the mockup's product
  surface is structurally 1:1 with `ui/src` (round-2 restoration list in §0 —
  unchanged and still in force).
- **Lane B — visual restyle (this is the port):** light-first palette, state
  layers, pill/tonal treatment, icon redraw + new brand mark, brand constants.

Port rule (unchanged): `index.css` mirrors the mockup `<style>` 1:1; `icons.tsx`
`PATHS` mirrors the sprite `<symbol>` block verbatim.

---

## 0. Lane A — round-2 restorations (record; still in force)

Sidebar footer → bare `.env-version` line · `.drag-strip` element · nav meta
(only 技能 carries a count) · tabs-only deploy toolbar · `.dep-inforow` (status ·
位置 · 已部署 v-stamp · 更新至v…) · scope bar renders nothing for zcode/dsh ·
`.adp-wrap` detail wrapper · 空列表/读取失败 demo states + dsh/report/select copy
parity · skills card meta/`.sk-cache`/git chip icon/aria-labels · settings
link-btn/保存/disabled select/repo link · dialog chrome `aria-label` +
labelled close buttons + plain pulse span. Details per round-2 notes; the mockup
diff vs `ui/src` must stay exactly this list (audit gate).

## 1. Token tables — final

### 1.1 Light (DEFAULT; lives in `:root` after the port)

| Token | HEAD (pre-M3) | Final |
| --- | --- | --- |
| `--bg-base` | `#f4f6f9` | `#f3f6fb` (soft cool-neutral scaffold) |
| `--bg-surface` | `#ffffff` | `#ffffff` (pure white cards — the clean layer) |
| `--bg-raised` | `#eef1f6` | `#e8edf6` (containers one step darker than base) |
| `--bg-inset` | `#f5f7fa` | `#f6f9fd` |
| `--bg-hover` | — | `#dee5f1` (on-surface overlay @8%) |
| `--bg-press` | — | `#d1dae9` (@14%) |
| `--tonal-container` | — | `#e3ecfa` (azure-tinted secondary container) |
| `--border` | `#e4e8ef` | `#e3e8f1` |
| `--border-strong` | `#ccd4e0` | `#c6cfdd` |
| `--text-1` | `#182130` | `#1b2230` |
| `--text-2` | `#57637a` | `#3f4d63` (≥7:1 on surface/raised) |
| `--text-3` | `#8b96a8` | `#5e6c81` (≥4.5:1; HEAD missed at ~2.5:1) |
| `--accent` | `#0b93a8` | `#0b57d0` 晴空青 azure (M3 tone ~45, hue 217) |
| `--accent-hover / -down` | `#0a8093` / `#096e80` | `#1f64d4` / `#286bd6` (white @8%/12% on the fill) |
| `--accent-text` | `#ffffff` | `#ffffff` |
| `--accent-tint / -border` | `rgba(11,147,168,.08)` / `.35` | `rgba(11,87,208,.09)` / `.32` |
| `--ok` | `#178a4c` | `#137a46` |
| `--warn` | `#a16207` | `#a16207` |
| `--err` / `--err-solid` | `#d43d3b` | `#c93a37` / `#c93a37` |
| `--err-solid-hover / --warn-hover` | — | `#d74d4b` / `#975d07` |
| `--vio` | `#6d4fd4` | `#6d4fd4` |
| `--ring` | `…rgba(11,147,168,.55)` | `0 0 0 2px var(--bg-surface),0 0 0 4px rgba(11,87,208,.55)` |
| `--shadow-1` | `0 1px 2px rgba(24,33,48,.08)` | `0 1px 2px rgba(23,32,48,.08)` |
| `--shadow-2` | `0 8px 24px rgba(24,33,48,.12)` | `0 2px 8px rgba(23,32,48,.08),0 12px 32px rgba(23,32,48,.12)` (soft diffuse) |
| `--shadow-3` | `0 18px 56px rgba(24,33,48,.22)` | `0 8px 20px rgba(23,32,48,.10),0 28px 72px rgba(23,32,48,.18)` |

Tints/borders: ok `.09/.30` · warn `.09/.32` · err `.08/.32` · vio `.10/.32`.

### 1.2 Dark (maintained secondary variant; `html[data-theme="dark"]` overrides)

| Token | Final |
| --- | --- |
| `--bg-base / surface / raised / inset` | `#0a0e16` / `#121826` / `#1b2334` / `#05080f` |
| `--bg-hover / -press` | `#252f45` / `#2d3952` |
| `--tonal-container` | `#1c2942` |
| `--border / -strong` | `#202b42` / `#364260` |
| `--text-1 / 2 / 3` | `#e9eef5` / `#a3b0c4` / `#8390a6` |
| `--accent` (+hover/-down/-text) | `#a8c7fa` (`#9bb9ec` / `#94b3ed`, on-primary `#041e49`) |
| `--accent-tint / -border` | `rgba(168,199,250,.14)` / `.38` |
| `--ok / warn / err / err-solid (+hover) / vio` | `#5fd8a7` / `#f2c14e` / `#f99b97` / `#cc4b45` (`#d05954`) / `#b9a8f7` |
| `--warn-hover` | `#e2b448` |
| `--ring` | `0 0 0 2px var(--bg-base),0 0 0 4px rgba(168,199,250,.66)` |
| shadows | `0 1px 2px rgba(0,0,0,.30)` / `0 2px 6px rgba(0,0,0,.28),0 10px 28px rgba(0,0,0,.34)` / `0 6px 16px rgba(0,0,0,.34),0 26px 68px rgba(0,0,0,.50)` |

Semantic rule untouched: blue/accent = actionable · green = healthy · amber =
caution · red = destructive · violet = managed-block · gray = static.

## 2. State layers & M3 style moves (light-verified)

1. Hover fills: every `:hover` tonal fill = `--bg-hover` (on light it DARKENS —
   correct M3 light overlay; on dark it lifts). `.btn:disabled:hover` keeps the
   resting `--tonal-container`.
2. Press rule: `.nav-item:active,.icon-btn:active,.tb:active,.chip:active,.seg-b:active{background:var(--bg-press)}`;
   filled buttons press via `--accent-hover/-down`, `--err-solid-hover`, `--warn-hover`.
3. Pills: `.btn`/`.btn-sm`/`.icon-btn`/`.nav-item` `border-radius:999px` (+ nav
   focus ::after 999, padding 0 12px); no nav edge bar — the tonal pill is the
   active indicator.
4. Tonal secondary-container: `.btn` (secondary tier) bg `--tonal-container`,
   borderless; `.achip` tonal borderless; `.seg-b.is-on` tonal. Outlined tiers
   and `.tb` keep their accent/strong borders.
5. `.oback` scrim: light `rgba(23,32,48,.40)` (now the base rule), dark override
   `rgba(5,9,15,.55)` via `html[data-theme="dark"] .oback`.
6. Progress/live gradient tip: `#a7d0f9` (dark lane) — on light the gradient is
   `linear-gradient(90deg,var(--accent),#a7d0f9)` verbatim from the mockup
   (azure → pale azure reads clean on white).

## 3. Shape scale — unchanged from round 2

Tokens `--r-xs 4 · --r-sm 6 · --r-md 8 · --r-lg 12 · --r-xl 16` + pills `999`
(`.btn`, `.btn-sm`, `.icon-btn`, `.nav-item`); inputs `8`, cards/banners/toasts
`12`, dialogs `16` (livebar top `16 16 0 0`), report `12`; dots/knobs `50%`.
Full per-selector table: mockup CSS is the source of truth.

## 4. Icons — redraw kept; NEW `mark` brand symbol

- The round-2 redraw stands (stroke-only, 24 grid, `stroke-width:1.8` base rule,
  round caps/joins). On light it reads crisply; no further stroke tuning needed.
- **NEW sprite symbol `i-mark`** (hub-and-spoke orchestration: center node wired
  to three specialist nodes — the agent-workbench identity). Copy it verbatim
  into `icons.tsx`: add `"mark"` to `IconName` and the JSX paths to `PATHS`.
- **`App.tsx` fixer lane:** swap the sidebar brand tile icon from `term` to
  `mark` (`<Icon name="mark" />`); the 关于 tile swaps its inline `term` SVG the
  same way (mockup tiles already use `#i-mark`).

## 5. Brand constants + app icon

- `.brand-tile` / `.about-tile`: container **`#0b57d0`**, glyph **`#ffffff`**,
  `box-shadow:inset 0 0 0 1px rgba(255,255,255,.30),var(--shadow-1)`.
  Theme-independent — do NOT swap for tokens.
- `app-icon.svg`: azure container `#0B57D0` + white hub-and-spoke mark (stroke
  4.4/48, round caps), radius 22.5%, transparent corners — holds its edge on
  light AND dark launchers; the in-app tile mirrors it 1:1.
- Launcher PNG/ICO/ICNS regeneration is implementation lane: export the SVG to a
  1024×1024 PNG (transparent corners) and run `npx tauri icon <png> -o src-tauri/icons`.

## 6. Contrast spot-checks (final, light-first)

| Pair | Ratio |
| --- | --- |
| light text-1 on surface / raised | ≥12:1 |
| light text-2 on surface / raised / inset | ~9 / 7.3 / ~8 |
| light text-3 on surface / raised | ~5.5 / 4.5 |
| light `#ffffff` on `--accent` | 6.4 |
| light accent as text on surface / raised | 6.4 / 5.4 |
| light status text on own tint | ok 5.0 · warn 4.6 · err 4.7 · vio 5.2 |
| light `#fff` on err-solid | 5.1 |
| dark `#041e49` on `#a8c7fa` | 9.5 |
| dark text-2/3 on raised | 7.3 / 4.9 |

## 7. Explicitly unchanged

The round-2 layout reconciliations (§0), DOM anatomy, dimensions, spacing,
layout mechanics, reachable states, demo panel scaffolding, motion tokens,
typography stacks, icon names (+ the one `mark` addition), semantic color rule,
focus-ring structure, radius tokens/state-layer mechanics.
