# SPEC — My Workbench 桌面版 UI 设计规范

> Companion to `app.html`. **`app.html` is the visual contract** — open it in a browser at
> any window size; every state referenced below is reachable through the dashed
> “演示控制” panel (bottom-left, mockup scaffolding only — NOT product UI).
> Sample data (versions `1.4.2`, SHAs, paths like `D:\dev\acme-web`, log timestamps)
> are placeholders for realistic content, not requirements.

## 0. Design language (summary)

> **[变更 2026-10 M3 刷新·三稿]** 高级纯净 is realized **light-first**: soft cool-neutral scaffold, pure-white cards, gentle tonal containers, azure primary, M3 state layers, pill buttons/nav, tonal secondary containers, soft diffuse shadows. **Layout, anatomy, density and all component contracts are untouched**, and the mockup's product surface stays structurally 1:1 with `ui/src` (restoration list in `m3-refresh-notes.md` §0). The port map for the implementer is `m3-refresh-notes.md`; **the implementation flips its default theme to light at port time (fixer lane)** — §10.8 amended.

1. **Professional dev-tool, light-first, M3-tonal.** A soft cool-neutral ladder — base `#f3f6fb` scaffold → pure-white `#ffffff` cards → containers one gentle step darker (`#e8edf6`) → near-white wells — carries hierarchy through tone; hairlines are minimal and quiet; nothing heavy. **Default presentation is light; the dark theme remains a maintained secondary variant** re-derived from the same seed (§1.2, §10.8).
2. **One accent: 晴空青 azure** (`#0b57d0` light / `#a8c7fa` dark) in the M3 **primary** role (on-primary white / `#041e49`, hover/press as on-color state layers). The azure seed earns its place on white — a confident, airy M3 blue (tone ~45 light / ~80 dark), far from the green channel. Accent means *actionable/active* (primary buttons, active nav, focus, selection, progress). It never means success — green is reserved for *healthy*.
3. **M3 state layers, precomputed as tokens.** Hover on tonal surfaces = `--bg-hover` (on-surface overlay @8%: darkens on light, lifts on dark); press = `--bg-press`; filled buttons shift via on-color overlays (`--accent-hover/-down`, `--err-solid-hover`, `--warn-hover` = 8%/12% overlays). No brightness filters, no hover color swaps.
4. **M3 signature shapes (pure style — geometry untouched).** Buttons and icon buttons are full pills; nav items are full pills and the tonal pill IS the active indicator (the former 3px sidebar edge bar is removed); the secondary button tier is a **tonal secondary-container** fill (`--tonal-container`, borderless), as are value chips and the active segment.
5. **Mono for everything the machine owns.** Paths, versions, SHAs, commands, log output, target names use the mono stack; UI prose uses the sans stack. Tabular numbers everywhere counts appear.
6. **Status is a dot + word, always explicit.** Environment detection, tiers, network — every state is visible text plus a colored dot; nothing is communicated by color alone, and absence (Node missing, target not found) is shown, never hidden.
7. **Density where work happens, air where decisions happen.** Left config column breathes; the preview table and log viewer are compact (12–13px, 32px rows) because they are the product.
8. **Elevation is quiet.** M3 radius scale (`--r-xs 4 / --r-sm 6 / --r-md 8 / --r-lg 12 / --r-xl 16`, buttons/nav/icon-buttons are pills); tonal steps first, shadows soft and diffuse — dialogs/toasts get the two-layer M3 treatment, cards stay flat.

## 1. Tokens (CSS variables)

### 1.1 Color — light (**default presentation**) — **[变更 2026-10 M3 刷新·三稿：light 升为默认；`--bg-*`/`--text-*`/status 为本轮终值；语义规则不变；逐值对照见 `m3-refresh-notes.md`]**

| Token | Value | Usage |
| --- | --- | --- |
| `--bg-base` | `#f3f6fb` | App background, sidebar (soft cool-neutral scaffold) |
| `--bg-surface` | `#ffffff` | Cards, panels, dialogs (pure white — the clean layer) |
| `--bg-raised` | `#e8edf6` | **Resting** selection/fills: active nav pill, `bn.mut`/`bd-skip`, log tag, floating pills (one step darker than base — M3 light containers) |
| `--bg-hover` | `#dee5f1` | **Hover state layer** — every tonal hover fill (on-surface overlay @8%) |
| `--bg-press` | `#d1dae9` | Press state layer (@14%) |
| `--tonal-container` | `#e3ecfa` | **M3 secondary-container**（azure-tinted）: secondary buttons, value chips, active segment |
| `--bg-inset` | `#f6f9fd` | Input wells, log background, segmented track |
| `--border` | `#e3e8f1` | Hairline card/row borders (minimal, quiet) |
| `--border-strong` | `#c6cfdd` | Input borders, tab-pill outlines |
| `--text-1` | `#1b2230` | Primary text |
| `--text-2` | `#3f4d63` | Secondary text, log body (≥ 7:1 on surface & raised) |
| `--text-3` | `#5e6c81` | Hints, labels (auxiliary only, ≥ 4.5:1) |
| `--accent` | `#0b57d0` | 晴空青 azure — M3 primary on light (tone ~45) |
| `--accent-hover / -down` | `#1f64d4` / `#286bd6` | Filled-button hover/press = on-primary white overlay 8% / 12% |
| `--accent-text` | `#ffffff` | On-primary text (6.4:1 on the fill) |
| `--accent-tint / -border` | `rgba(11,87,208,.09)` / `.32` | Selected card bg / accent outlines |
| `--ok` (+`-tint`,`-border`) | `#137a46` | Healthy: create-badge, detected, 通过 |
| `--warn` (+`-tint`,`-border`,`-hover`) | `#a16207` / `#975d07` | Caution: overwrite-badge **[变更 2026-10 十次修订：原 drift / Tier-2-skip 用例随健康检查 UI 一并移除]** |
| `--err` (+`-tint`,`-border`,`-solid`,`-solid-hover`) | `#c93a37` / `#c93a37` / `#d74d4b` | Failure text / solid danger button / its hover overlay |
| `--vio` (+`-tint`,`-border`) | `#6d4fd4` | Managed-block (受管块) only |

**Semantic rule (do not drift):** blue/accent = actionable · green = healthy · amber = caution/loss-risk · red = error/destructive · violet = managed-block · gray = static/skip.

**Brand constants (theme-independent, not tokens):** launcher/brand tile container `#0b57d0` + white hub-and-spoke glyph `#ffffff` (`.brand-tile`, `.about-tile`, `app-icon.svg`; the in-app 24-grid twin is sprite symbol `i-mark` — the port adds `mark` to `icons.tsx` and swaps the tiles' `term` icon, fixer lane).

### 1.2 Color — dark (maintained secondary variant) — **[变更 2026-10 M3 刷新·三稿：dark 不再是默认/头条呈现；同一种子（azure, tone ~80）重推的深色梯，作为维护中的第二主题保留；契约结构与 §1.1 相同]**

| Token | Value |
| --- | --- |
| `--bg-base / surface / raised / inset` | `#0a0e16` / `#121826` / `#1b2334` / `#05080f` |
| `--bg-hover / -press` | `#252f45` / `#2d3952` |
| `--tonal-container` | `#1c2942` |
| `--border / -strong` | `#202b42` / `#364260` |
| `--text-1 / 2 / 3` | `#e9eef5` / `#a3b0c4` / `#8390a6` |
| `--accent` (+`-hover/-down/-text`) | `#a8c7fa` (`#9bb9ec` / `#94b3ed`, on-primary `#041e49`) |
| `--accent-tint / -border` | `rgba(168,199,250,.14)` / `.38` |
| `--ok / warn / err / err-solid (+-hover) / vio` | `#5fd8a7` / `#f2c14e` / `#f99b97` / `#cc4b45` (`#d05954`) / `#b9a8f7` |
| `--warn-hover` | `#e2b448` |

Themes are implemented purely by variable overrides — **`html[data-theme="dark"]`** now overrides the light `:root` (no component changes; the mockup ships `data-theme="light"`). **Decision (§10.8 amended): default presentation = light; dark remains available and maintained.** The demo theme toggle exists for review and is labeled `主题 · M3`. The implementation flips its default theme at port time (fixer lane — see `m3-refresh-notes.md`).

### 1.3 Spacing / radius / elevation

- **Spacing scale (4px base):** `2 · 4 · 6 · 8 · 12 · 14 · 16 · 20 · 24`. Card inner padding 14–16; column gap 16; page padding 20/24. **[不变]**
- **Radius — M3-flavored shape scale [变更 2026-10 M3 刷新·二稿]：** tokens `--r-xs 4 · --r-sm 6 · --r-md 8 · --r-lg 12 · --r-xl 16`. **Buttons (all sizes), icon buttons and nav items are full pills (`999`)** — M3 signature; the active nav pill is the indicator. Mapping from HEAD: inputs `7→8 (--r-md)`; chips/badges/seg segments `5,6→6 (--r-sm)`; micro chips & kbd `4 (--r-xs)`; radio cards, segmented track, dialogs' icon squares `8 (--r-md)`; cards & panels & banners & toasts `9,10,11→12 (--r-lg)`; dialogs `12→16 (--r-xl)`（`dlg-dep` 顶部 livebar 圆角同步 `16 16 0 0`）； empty-state icon square `12 (--r-lg)`; terminal report card `8→12`. Dots/knobs `50%`.
- **Shadow (soft, diffuse — light-first) [变更 2026-10 M3 刷新·三稿]：** `--shadow-1: 0 1px 2px rgba(23,32,48,.08)` (raised chips) · `--shadow-2: 0 2px 8px rgba(23,32,48,.08), 0 12px 32px rgba(23,32,48,.12)` (popovers/toasts) · `--shadow-3: 0 8px 20px rgba(23,32,48,.10), 0 28px 72px rgba(23,32,48,.18)` (dialogs). Tone carries depth; shadows are gentle accents only. The dark variant keeps its own deeper shadow set (§1.2 lane in `m3-refresh-notes.md`).

### 1.4 Typography

| Role | Stack | Size/weight |
| --- | --- | --- |
| UI sans | `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC"` | 13 base |
| Machine mono | `ui-monospace, "Cascadia Code", "SF Mono", "JetBrains Mono", Consolas` | 11–12 |
| Page title `--ph-title` | sans | 20 / 600, letter-spacing −0.01em |
| Card title / row title | sans | 13 / 600 |
| Body / sub | sans | 12–12.5 / 400, `--text-2/3` |
| Micro labels, table headers | sans | 11 / 600, letter-spacing 0.05em |
| Log lines | mono | 12, line-height 1.75 |
| Numbers | `font-variant-numeric: tabular-nums` | all counts, summary, progress |

No webfonts, no external assets — system stacks only (offline-safe desktop app).

### 1.5 Motion

| Token | Value | Used for |
| --- | --- | --- |
| `--t-fast` | 120ms | Hover/press color transitions |
| `--t-med` | 200ms | Switch knob, tab states, backdrop fade |
| `--t-slow` | 280ms | Dialog/toast entrance |
| `--ease` | `cubic-bezier(.16,1,.3,1)` | All transforms |

Specific animations: dialog in = fade + `translateY(10px) scale(.98)`; toast in = slide from right 16px; log line in = fade + 2px rise (120ms); running = pulsing 6px dot (1.2s) on the 日志 tab + progress shimmer sweep (1.3s linear); switch knob slides 14px. **`prefers-reduced-motion` disables all of the above.**

### 1.6 Focus

`:focus-visible` = two-layer ring: `0 0 0 2px <surface>, 0 0 0 4px accent@~55-66%` — light `rgba(11,87,208,.55)` / dark `rgba(168,199,250,.66)` **[变更 2026-10 M3 刷新·三稿：仅 rgba 随主题种子更新，双层结构不变]**. Never removed, never replaced by color change alone.

## 2. Layout & navigation

- **Window:** default 1200×800, resizable, min 1024×680. **Frameless (`decorations: false`) — no OS title bar, and no in-app substitute:** there is no dedicated title-bar strip anywhere in the layout. The Windows-style 最小化 / 最大化·还原 / 关闭 controls (§3.18) are an **integrated fixed cluster floating over the window's top-right corner**, on top of the page-header area — they consume no layout height. **Dragging without a bar:** the sidebar brand row and the two page-header containers (部署 / 设置) carry `data-tauri-drag-region="deep"`; the **whole surface of those rows** drags the window (double-click anywhere on a row toggles maximize) while child buttons/inputs stay fully interactive **[变更 2026-10：原为裸属性 — Tauri 只认属性所在元素本身，标题文字/图标吞掉 mousedown，实际几乎无可拖面积，窗口拖不动；改用 deep 值让整行成为拖拽面，可点击子元素仍自动阻断拖动]**. An **invisible top-edge strip** (`.drag-strip`, full width × 14px, no visual footprint, z-index under the control cluster) carries the bare `data-tauri-drag-region`: the layout padding above the brand row / page headers — the most title-bar-like surface — drags the window, and double-click on the top edge toggles maximize **[变更 2026-10 二次修订：用户反馈顶边窄条无法拖动 — 该区域是容器 padding，不在任何拖拽面内；补一条不可见顶边拖拽条]**. Page-header action clusters keep right padding (§3.18) so they never sit under the controls. Alt+F4 and the system menu keep working natively.
- **Shell:** left sidebar 232px fixed + main content. Sidebar: brand (28px solid indigo-slate tile `#0f1728` + azure terminal glyph `#6cb0f5` — matches `app-icon.svg` **[变更 2026-10 M3 刷新·二稿：纯色品牌容器，常量随二稿色板]** + name), 2 nav items (部署 / 设置)， footer **bare version line** — just the version number (the app's own bundled-source/app version), no card background, no 内置源 label **[变更 2026-10：原为带背景和边框的版本卡片 + 状态点 + 内置源字样；按用户要求精简为纯版本号；mockup 本轮已同步此结构]**. **[变更 2026-10 十一次修订]** third-party tool versions (Node, opencode, dsh) are no longer shown — the app is not their manager; `detect_environment` still runs at start and feeds the deploy page (scope bar, dialogs) and 设置.
- **Nav item:** 36px tall, icon + label; **full-pill item — the tonal pill IS the active indicator** (active = raised pill + accent icon; the former 3px sidebar edge bar is removed **[变更 2026-10 M3 刷新·二稿：M3 导航签名，仅形状/样式，DOM 不变]**). `aria-current="page"`.
- **Deploy page (v2 — amended 2026-10, §4):** backend tab bar + realm scope bar + a **single fluid content column** that fills the content area with the window (full-fluid, no width cap, scrolls) **[变更 2026-10 七次修订：原 max-width 900px 上限移除 — 设置页上限同月一并移除，见下行]**. The former 2-column workspace (config 384px + preview panel, <1080px stacking) is retired — per-target deploy machinery moved into the target-scoped deploy dialog (§4.6); the min window (1024×680) is served by the fluid column. The Settings column is unchanged.
- **Settings page:** single scrolling column, same page-header pattern **[变更 2026-10 用户指令：栏宽上限（760/1080px）移除 — 内容列与部署页同为 full-fluid，随窗口展开]**.
- **Page header:** title 20 + sub 12.5 muted; right-aligned primary actions.

## 3. Component inventory (anatomy + states)

### 3.1 Buttons — tiers **[变更 2026-10 M3 刷新·二稿：全部按钮为 full pill（M3 签名，仅形状）；secondary 层改为 tonal secondary-container 填充（`--tonal-container`，无边框，tone 承载层级）— 尺寸/内边距不变]**
| Tier | Look | Use |
| --- | --- | --- |
| Primary (`.btn-primary`) | accent fill, dark text, 600, pill | 开始安装， 保存， 覆盖重装 **[变更 2026-10 快速更新：信息行 更新至v… 改挂 accent-outline 小尺寸档，见下与 §4.5]** |
| Secondary (`.btn`) | tonal container fill, borderless, pill; hover `--bg-hover` | 生成预览， 全部更新， 浏览… |
| Ghost (`.btn-ghost`) | transparent | 取消， low-emphasis actions |
| Accent outline (`.btn-acc-o`) | accent tint bg + accent border | empty-state CTA, 更新至v… (deploy info row, small size — **[变更 2026-10 快速更新：与信息行 12px meta 同档]** §4.5) |
| Warn outline / Warn solid | amber | 更新 with local modifications / 备份后强制更新 **[移除 2026-10：技能用例随技能管理功能整体移除]** |
| Danger outline / Danger solid | red | 删除 **[移除 2026-10：清除 PAT / 删除技能 用例随技能管理功能整体移除]** |

Sizes: 32px (default) / 26px small. Disabled = 42% opacity, `cursor:not-allowed`, keeps tooltip explaining why (e.g. 开始安装 disabled reasons: 未生成预览 / 预览已过期 / 预校验未通过 / 正在安装).

### 3.2 Badges (`.bd-*`) — one visual language everywhere
`新建` green · `跳过` neutral · `覆盖` amber · `受管块` violet. 11px/600, tint bg + border.

### 3.3 Status dot
7px circle. `.ok` = green fill + tint halo (detected) · `.off` = hollow gray ring (not found / not detected) · `.acc` = cyan (live/bundled source). Always paired with a text label; a target “未检测到” remains selectable — detection ≠ eligibility.

### 3.4 Radio card (content source) / Target checkbox card
Selectable cards: 1px border → accent border + accent tint when on; custom radio dot / 15px checkbox with white tick; mono 600 label; 11px muted status line under (detection text or “与 opencode 互斥”). Hover = `--bg-hover` state layer **[变更 2026-10 M3 刷新：原 raised bg]**. Keyboard: space/enter toggles; native checkbox input is visually hidden but focusable — focus ring on the card.

### 3.5 Switch (`.sw`)
34×20 pill, 16px knob, accent when on. Used for 覆盖已存在文件 / 自动滚动 (the former Deploy 用户级 switch became the 安装方式 segmented control, §4.1). `role="switch"` + `aria-checked`. Consequences appear immediately as hint lines (overwrite swaps hint to amber “已开启 — 已存在的文件将被直接覆盖”).

### 3.6 Segmented control (`.seg`)
Inset track + raised active segment. Used for the deploy dialog's step tabs (预览 / 安装日志 **[变更 2026-10 十次修订：健康检查步随健康检查 UI 移除 — 原三段为 预览 / 安装日志 / 健康检查]**) and the Deploy 安装方式 scope toggle (目录级安装 / 用户级安装 — a two-line variant: icon + label + subtitle, same tokens, §4.1; two buttons with `aria-pressed` in a labelled group, §9). The 日志 segment gains a pulsing cyan dot while installing. (The demo panel is the other user.)

### 3.7 Filter chips (`.chip`) — **[移除 2026-10：随技能管理功能整体移除；计划筛选行此前已随预览流退役]**

### 3.8 Plan preview table
Header 状态(88px) / 目标文件(flex) / 说明(230px). Path renders as muted mono directory + bright basename (`.dir`/`.nm` split) — scannability detail that matters. Row hover raised. `<thead>` sticky. Footer: summary `X 新建 · Y 跳过 · Z 覆盖 · N 受管块 · 共 M 个文件` (bold numbers) + right side `生成于 hh:mm:ss` + regenerate icon. Top-right of panel header: `项目级 · 0 写入` reminder.

### 3.9 Log viewer
- **Header:** status chip (未开始 gray / 运行中 cyan+pulse / 已完成 green / 已失败 red / **已取消 amber**) + **停止** button (secondary, enabled only while running; tooltip `协作取消：将在当前文件写完后停止（已写入的文件保留）`) + right: 自动滚动 mini-switch (default on), 复制 icon, 导出 icon (disabled, tooltip “计划于 M3 提供”).
- **Progress row:** 4px bar (cyan gradient + shimmer while running; turns green on success, red on failure) + phase text `正在安装 claude · 12/15 · 80%`.
- **2px live bar** across the very top of the whole panel while running — visible from any tab **[变更 2026-10 完成态隐藏顶条：RUNNING 指示器 only — 终态（成功/失败/取消）整体隐藏该条；成败由日志内 report card 承载；日志内 4px `.lpfill` 进度条的绿/红/取消冻结状态不变]**.
- **Body:** inset well, mono 12, lines = timestamp (`--text-3`) + target tag chip (neutral mono) + message. Level coloring: `✓` prefix green for create lines, muted for skip, amber for overwrite, violet for managed-block, red bg-tint row for errors. Same target/level vocabulary as the plan badges — one mental model.
- **Autoscroll:** sticks to bottom; scrolling up pauses it (switch flips off) and a floating “回到底部” pill appears. Resume restores stick.
- **Terminal report card** (in-flow at log end): success = green card, title 安装完成 + count chips + 用时 **[变更 2026-10 十次修订：原二级操作 运行健康检查 随健康检查 UI 移除]**； failure = red card, title 安装失败 + mono error line + actions 重试安装 / 导出日志(disabled); **cancelled = amber card, title 安装已取消， chips `第 {n} 个文件后停止` + `已写入的文件保留`, action 重试安装**. Progress bar freezes at its last width on cancel (shimmer stops), stays green/red on success/failure.

### 3.10 Tier cards (health check) — **[移除 2026-10 十次修订]**
> The health-check/drift feature surface is UI-removed pending need (SPEC §10 tail note); the backend `check_drift` command is retained. Text kept as decision/re-add reference — do not re-implement without re-commissioning this section.

Header: title + right status badge (通过 green / 2 处漂移 amber / 已跳过 amber-info / 失败 red). The title doubles as the availability note: **结构检查（始终可用）** / **执行状态检查（需要本地 Node）**. Body = check rows (icon + zh text + mono detail). Footer = one-line semantics.
**执行状态检查 skipped state:** full-width amber note inside the card: title **“执行状态检查已跳过：未检测到 Node”**, body “安装本地 Node 后点击「重新检查」。”; footer states “缺失 Node 不会阻塞安装。”.

### 3.11 Drift list — **[移除 2026-10 十次修订]**
> UI-removed with the health-check surface (§10 tail note); text kept as decision/re-add reference (§10.3 still cites this section).
Section title + count chip `N 个文件与渲染期望不一致`; rows = warn file icon + mono path (dir muted) + one-line reason (byte/size delta) + 查看详情 button → drift dialog: 期望（渲染结果） vs 本地文件 two mono panes with green/red diff lines + footer 关闭 / **覆盖重装** (primary) with the warning copy 「将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。」 Choosing 覆盖重装 closes the dialog and routes into the **normal preview flow** with the 覆盖 toggle forced ON (an amber `覆盖已开启` badge appears in the preview panel header) and regenerates the plan — the write itself happens only through `execute_install`; there is no ad-hoc write and no recycle-bin backup (locked). Diff view unchanged.

### 3.12 Banners (`.bn`)
info(cyan) / warn(amber) / err(red) / ok(green) / mut(neutral). Icon + title 12.5/600 + body 11.5 + optional right actions. Used for: Tier-2 pre-validation (checking/pass/blocked) and deploy page warn/error notices.

### 3.13 Dialog (`.dlg`)
520px (640 for diff), radius 16 (`--r-xl` **[变更 2026-10 M3 刷新：原 12]**)， shadow-3 (two-layer M3 softness), header (30px tinted icon square + 15px title + close) / body (12.5, `--text-2`, forms & lists) / footer right-aligned buttons. Open = backdrop blur-fade + panel rise; Esc and backdrop click close; focus moves in on open and returns to the invoker on close. Dialogs in scope: the deploy/quick-update dialog (§3.24) and the deploy page's 放弃未保存的更改 guard **[变更 2026-10 十次修订：漂移详情 dialog 随健康检查 UI 移除 — the 640px diff width is currently unused；技能四对话（添加/编辑技能源 · 检测到本地修改 · 删除技能 · 删除技能源）随技能管理功能整体移除]**.

### 3.14 Toast
Bottom-right stack, 3.8s auto-dismiss, icon-colored by kind, optional mono sub-line. Used for command acknowledgements (安装完成 / 已保存 …). Max ~3; newest at bottom.

### 3.15 Empty states
Centered: 44px rounded icon square → bold title → muted explanation (with mono keyword) → optional ghost CTA. Instances: preview empty (先选择目标生成预览)， log idle (尚未开始安装…).

### 3.16 Settings row
230px label column (title + hint) + fluid control column; separated by hairlines inside a card. Controls: disabled select/buttons for M3 features with “计划于 M3 提供” hints.

### 3.17 Skill row — **[移除 2026-10：随技能管理功能整体移除]**

### 3.18 Window controls (frameless, integrated — `.win-ctl` / `.win-btn`)
No bar, no strip: `.win-ctl` is `position: fixed; top: 0; right: 0; height: 40px` (page-header rhythm), a floating cluster **over the page-header area** — z-index above page content, below the dialog scrim and toasts. It draws no background of its own: buttons sit directly on the page surface, hover provides the only fill. **46px-wide** hit targets, hairline inline SVG glyphs (`.ic`, 14px):
- **最小化** — hover = `--bg-hover` state-layer fill **[变更 2026-10 M3 刷新：原 `--bg-raised`]**, text brightens.
- **最大化 / 还原** — icon swaps with window state (restore = double-square glyph); same hover as minimize.
- **关闭** (`.win-close`) — hover = `--err-solid` fill, white glyph (reuses the existing error token set; no new token).

**No collisions:** page-header action clusters sit at the header's flex-end (below the 40px control band by rhythm), so they never render under the controls; 部署 and 设置 headers carry no actions **[结构对齐 2026-10 M3 刷新：与实现一致 — `.ph-actions` 无右内边距规则；原 `padding-right:150px` 条款随实现废止，部署页头部动作簇已于 v2 移入空态 CTA 与信息行（§4.5）]**.

**Dragging without a bar:** `data-tauri-drag-region="deep"` sits on exactly four containers — the sidebar brand row and the three `.page-head` headers. Tauri's drag script drags from any mousedown in those containers' subtree that does not land on an interactive element (button, input, tabindex, interactive role), so the **whole row surface** drags the window (double-click there toggles maximize); child buttons/inputs and all content below the headers are unaffected **[变更 2026-10：由裸属性改为 deep — 裸属性要求 mousedown 精确命中属性所在元素，子元素覆盖整行时窗口无从拖动]**.

Real `<button>`s: `aria-label` 最小化 / 最大化 / 还原 (swaps with state) / 关闭； §1.6 focus ring. **Browser degradation:** without Tauri IPC the cluster is **not rendered at all** (no dead controls, clean tab order).

### 3.19 Backend tab bar (deploy page, v2)
Targets follow engine order: `opencode`, `claude`, `zcode`, `codex`, `dsh`. The `codex` tab is labeled **ChatGPT / Codex**, is always user-level (`CODEX_HOME`, otherwise `~/.codex`), and reuses the agent cards/detail page for native TOML files; its reasoning field is 推理强度 (`model_reasoning_effort`). It has no project/user scope control.
Pill tabs, mono 12.5px (machine names), 32px tall, radius 999, gap 8. Rest: transparent bg + `--border-strong` border + `--text-2`; hover = `--bg-hover` state-layer fill + `--text-1` **[变更 2026-10 M3 刷新：原 raised fill]**; **selected = accent fill + `--accent-text`, weight 600** (accent = active, §0.2; selected-pill hover = `--accent-hover` on-color overlay). `role="tablist"/"tab"`, `aria-selected`, `aria-controls`, Left/Right arrow navigation; each tab's `aria-label`/`title` carries deployment status — `{target}（已部署）` / `{target}（未部署）`. No status dot inside the pills: the selected target's state is spelled out as **dot + word** at the bar's right end (`未部署` hollow · `已部署 · {n} 个智能体` · `已部署 · 预设 {name}`), per §0.4. Tabs switch the whole main view.

### 3.20 Agent card
A full-width `<button>` (left-aligned): row 1 = mono agent name 13/600 + right-aligned value chips (§3.21); row 2 = mono deployed-file path 11px `--text-3`; row 3 = prompt-body preview, mono 12, **clamped to 2 lines** (line-clamp). States: rest (surface + border) → hover (`--bg-hover` state layer **[变更 2026-10 M3 刷新：原 raised]** + strong border). **[变更 2026-10 详情页化]** No open/closed card state — the card is a plain navigation trigger (no `aria-expanded`/`aria-controls`): clicking it opens the detail page (§3.22), which replaces the deploy content area, so the list is not visible while a detail page is open. Focus ring §1.6; the hover title carries the wireframe annotation copy (§8).

### 3.21 Value chips (`.achip`)
Mono 11px/500, radius 999, **tonal secondary-container bg, borderless** **[变更 2026-10 M3 刷新·二稿：原 raised bg + strong border]**， `--text-2` **[变更 2026-10：open-card surface flip removed with the card open state]**. Chips render **machine-owned values verbatim** (`glm`, `high`) — never zh-translated, never status-colored (§0.3); the human label (模型 / 思考等级|推理强度|变体) lives in the `title` tooltip and the detail page's select label. These are *settings* chips, distinct from §3.2 status badges.

### 3.22 Agent detail page (deploy page) — full-page view
**[变更 2026-10：原下方内嵌的详情编辑器改为整页视图；细节修订同月：页面头部一并让位]** Clicking a card replaces the deploy page's entire content area **including its header row** — the 部署 title, subtitle, contextual header actions, tab bar, scope bar and card list all give way; the detail page's own header (返回 + agent name) **is the title**. Only the app frame stays (sidebar, floating window controls; the deploy page's drag surface returns with the header on 返回). Two view states per target: **roster** (default) ↔ **detail page**; 返回 routes back to the roster with the same tab + scope. Anatomy: a **page-level title row** — 返回 back button (ghost tier + arrow-left icon; focus lands here when the page opens; **[变更 2026-10 六次修订]** its glyph sits **flush-left on the textarea frame's left edge** in the rest state — the ghost button's padding is cancelled by a negative margin with a matching clip-boundary shift, so hover/focus pill and focus ring paint unclipped) + the mono agent name, **nothing else** **[变更 2026-10 三次修订：zh 描述 / 只读 chips / 部署文件路径 trimmed from the title area — the path still lives on the roster cards (§3.20) and the model/reasoning values are the editable selects below]** — sitting on the page background; below it the **chromeless editor column** that fills the remaining viewport height **[变更 2026-10 四次修订：外层卡片边框整体移除 — 选择行与页脚直接置于页面背景，与标题行左对齐，页脚保留上侧发丝线；仅提示词 textarea 保留自身边框；卡片入场动画随之移除]**. **Meta row:** field groups on **one horizontal line** **[变更 2026-10 五次修订：原标签叠在 selects 上方，现内联 — 标签位于各自 select 左侧，两组同一行]** — the 模型 label left of its select, and the per-backend reasoning label (`zcode` 思考等级 / `claude` 推理强度 / `opencode` 变体) left of its select, groups side by side; values render verbatim, e.g. `high` (dsh has no reasoning group — the lone 模型 group keeps the same row rhythm). **A select change writes immediately** — no 保存 button **[变更 2026-10 十四次修订：模型/思考等级随选择即时写入已部署文件；失败 toast 并回退显示值]**. **Body:** mono **text block** (`<pre>`, inset well, min-height 230 floor — the only framed element) **[变更 2026-10 十二次修订：提示词正文不是编辑框 — 纯文本展示，无编辑语义、无聚焦/全选效果；my-workbench 部署提示词而不管理提示词，正文随部署更新，仅模型设置可编辑，保存/还原/未保存守卫仅作用于设置]** that **flexes to fill the space between the field row and the bottom-pinned footer**; long content scrolls inside the block (the manual resize handle is retired); on very short windows the floor kicks in and the page scrolls instead **[变更 2026-10 八次修订：详情页纵向充满视口 — 标题/字段行在上、正文块弹性占据剩余高度、页脚钉在内容区底部；正文块为内部滚动面，缩放柄移除，极矮窗口回退为页面滚动；十二次修订后为纯文本块]**. **Footer:** none **[变更 2026-10 十四次修订：保存按钮与底部发丝线分割线移除 — 模型/思考等级随选择即时写入，失败经 toast 并回退显示值；详情页不再产生未保存状态，放弃未保存的更改 守卫对话框随之退出详情页（基础设施保留为惰性）]**. The former footer hairline, 保存 / 保存中… / 状态行 / 还原 are all retired — [移除 2026-10 十四次修订]（§8）. The toast 已保存 {agent} 的设置 · 已写入已部署文件 confirms a write.

### 3.23 Deploy empty states (v2)
- **Not deployed:** §3.15 anatomy — icon, `{target} 尚未部署`, explanation naming the install location in mono, plus a **部署 primary CTA**. Delta vs §3.15's ghost CTA: allowed because the CTA is the screen's only actionable element (accent = actionable).
- **dsh preset summary:** same anatomy; title `dsh 已部署`, explanation that dsh deploys as a preset with **no per-agent files**, plus a key-value summary card (预设 / 主目录 / profile / 部署文件 / 部署时间 — mono values, `--border` hairlines). The update action lives in the deployed info row (§4.5) **[结构对齐 2026-10 M3 刷新：原「更新 action stays in the page header」随信息行改造废止]**.
- **Roster empty** **[新增 2026-10 M3 刷新·结构对齐：实现 notes §5.3 的 RosterEmpty 状态入约]** — a target marked deployed whose agent listing came back empty: §3.15 anatomy (file icon), title `未找到已部署的智能体文件`, body `目标已标记为部署，但没有可显示的智能体文件。内置源更新后，上方信息行会出现「更新至…」按钮，点击即可重新部署。`, **no CTA** (the info row's update button is the affordance). Never the generic not-deployed panel.

### 3.24 Deploy dialog (§3.13 instance, 720px)
Scoped to the **one selected target**. Header: accent icon square + `{部署|更新} · {target}` + close; the 2px live bar sits across the dialog top while running — a RUNNING indicator only, terminal states hide it entirely (§3.9 **[变更 2026-10 完成态隐藏顶条]**). **Both entries render the identical minimal body: the 覆盖已存在文件 switch only** **[变更 2026-10 极简部署弹窗：内容源、安装位置（含 项目级/用户级 分段与项目目录输入）、固定位置行与 dsh 预校验横幅全部移出对话框 — 来源恒为内置源，scope 由页面范围条（§4.3）持有；此前的 配置/预览/安装日志 页签、badge、meta 行等随「部署框精简」一并移除]** (preset: 部署=off / 更新=ON, owned page-side; amber consequence hint when on / default hint when off). **Install is one action**: 安装 plans at click time from the page-scope selection (bundled source, no held plan — §4.2 retired) and the run starts directly into the shared 安装日志 view (log viewer + 停止 + terminal reports, §3.9); while planning the body swaps to the preparing indicator（spinner + 正在准备安装…）. Footer is contextual: switch body = 取消 + 安装 (primary, always enabled — run guards live page-side); log = 关闭 — closing mid-run keeps the run going.

## 4. Area 1 — 部署 (v2 — amended 2026-10)

> Rewritten for the 2026-10 wireframe: the page is organized **per backend target** — a tab bar switches the whole main view, deployed agents render as editable cards, and the entire deploy machinery is unchanged but lives in a **target-scoped deploy dialog** (§3.24). Former §4.1 (config column) → dialog config pane; former §4.3–4.5 (preview states / install flow / health tab) → dialog panes (§4.6). All §10 locked decisions carry over; explicit deltas are listed in §4.7 and §10.

### 4.1 Page frame
1. **Header** — unchanged: title 部署 + sub, `data-tauri-drag-region`, win-ctl clearance (§3.18). Sub copy [变更]: `管理各后端已部署的智能体与提示词 · 预览与安装均不访问网络`. **[变更 2026-10 详情页化]** This whole row is **not rendered while an agent detail page is open** (§3.22) — the detail page's 返回 + name header is the title; the row (with its drag surface and contextual actions) returns on 返回.
2. **Backend tab bar** (§3.19) — one pill per target: `opencode / claude / zcode / dsh`; selected = filled accent; switches the whole main view; per-tab `aria-label` carries deployment status; the selected target's status shows as dot + word at the bar's right end. Status derives from the **deployed-overview** read (whether the target has deployed files), *not* from environment detection.
3. **Realm scope bar** (§4.3) — one compact row under the tabs.
4. Body = the selected target's state (§4.4/§4.5), in a single **full-fluid** column that fills the content area and scrolls (no width cap — §2/§10 tail note). **[变更 2026-10]** While an agent detail page is open (§3.22) it takes over the whole page — **header row included** (§4.1): title, subtitle, header actions, tab bar, scope bar and card list give way until 返回; the detail content gains a 20px top clearance for the floating window controls (§3.18).

### 4.2 Stale-preview rule (retired 2026-10)
**[移除 2026-10 部署框精简：部署入口不再持有计划 — 开始安装即席 plan-then-execute（同快速更新的 安装），预览步与 `选择已更改 — 预览可能过期` 条随之退出；原规则 retained below as reference]** Any config change (source mode/path validity, scope, 覆盖) after a plan exists marks the dialog's preview stale: amber strip `选择已更改 — 预览可能过期，请重新生成` and 开始安装 disables until 重新生成. The plan is a pure function of the selection — never install from a stale plan. Scope changes made in the **page scope bar** while the dialog holds a preview also mark it stale (single shared scope state).

### 4.3 Realm scope bar (below the tab bar)
- **opencode / claude:** compact one-line segmented **项目级 / 用户级** (`aria-pressed` buttons in a labelled group) + project directory input + 浏览… (display + pick). Hint `项目目录 = opencode / claude 项目级安装根目录`; 用户级 swaps the picker for `安装到用户配置目录而非项目目录`. This is **one app-wide persisted state** shared 1:1 with the deploy dialog's 安装位置 section (and sent as `userLevel`/`projectDir` in the Selection).
- **zcode:** no scope bar — the location renders in the deployed info row (§4.5) **[变更 2026-10：原 部署位置 ~\.zcode + 固定 chip 固定位置行移除 — 与信息行的 位置 重复]**.
- **dsh:** no scope bar — same **[变更 2026-10：原 部署位置 + `DSH_HOME → {home} · profile {name}` 行及 `DSH_HOME 已覆盖` chip 移除；部署对话框内的 安装位置 分组保留]**.
- ~~Changing scope/path invalidates a held dialog preview (§4.2).~~ **[移除 2026-10 部署框精简：无持有计划]**

### 4.4 Body — not deployed / deployed
- **Not deployed (§3.23):** centered empty state — `{target} 尚未部署` + explanation naming the install location + prominent **部署** primary CTA (opens the deploy dialog). The toolbar carries no actions and no status — the empty-state CTA is the deploy entry **[变更 2026-10：工具栏右侧 未部署 状态与 部署 按钮移除，工具栏仅余标签页]**.
- **Deployed, agent targets (opencode/claude/zcode):** two view states **[变更 2026-10]** —
  **roster** (default): the **agent card list** (§3.20) — one card per deployed agent file: mono name, model chip (`glm`), reasoning-level chip (backend term §3.21), mono deployed-file path, 2-line clamped prompt preview. Click → the **detail page** (§3.22) replaces the whole page including the header row (title/subtitle/actions, tab bar, scope bar and list give way); **返回** routes back to the roster in the same tab + scope.
- **Deployed, dsh (§3.23):** **preset summary** — no cards (dsh has no per-agent files), and no detail page: key rows 预设 / 主目录 / profile / 部署文件 / 部署时间 + hint to use the info row's **更新至v{bundled}** (§4.5) when an update is available **[变更 2026-10：原 header 更新 按钮已移入信息行]**.

### 4.5 Per-target actions (contextual — **[变更 2026-10：信息行改造，用户指令]**: the update action and status line live in a deployed info row inside the content area; **the toolbar carries tabs only**)
| Selected target state | Surface |
| --- | --- |
| not deployed | **no toolbar status/actions and no info row** — the deploy entry is the §4.4 empty-state **部署** CTA |
| deployed | **deployed info row** (`.dep-inforow` — first line of the content area, above the scope bar): status (dot + text), 位置 = resolved scope root (mono, hidden when unresolvable), 已部署 = `v{stamp}` (`v—` when the realm stamp is missing/blank), and **更新至v{bundled}** (**small accent-outline** — `.btn-sm.btn-acc-o`, 26px **[变更 2026-10 快速更新：原 32px primary 改为与信息行 12px meta 同档的 accent-outline 小按钮，动作层级保留]** → **快速更新对话框**，§4.6，**覆盖 preset ON**) only when the deployed stamp differs from the bundled source version (missing stamp counts as behind); current → no button. The toolbar 更新 button is retired **[变更 2026-10 十次修订：原二级操作 健康检查 移除，已部署态仅余 更新 — §10 尾注]** |

The deployed version comes from `deployed_overview`'s `deployedVersion` — read per realm exactly where the engine writes stamps (`stamp_plans`): opencode/claude at 项目级 read `<project_dir>/my-workbench.version`, everything else (用户级, zcode, dsh) reads `~/.my-workbench.version`.

Neither action renders while an agent detail page is open — the whole content area gives way (§3.22/§4.1); exits run through 返回 / the guarded paths of §3.22. The page header carries no actions anymore (title + subtitle only). The not-deployed empty state keeps its own prominent **部署** CTA (§4.4).

### 4.6 Deploy dialog (§3.24)
Opened by 部署 / 更新 **[变更 2026-10 十次修订：原 健康检查 入口移除]** **[变更 2026-10 快速更新：更新 入口改开快速更新对话框（见下）]** **[变更 2026-10 极简部署弹窗：部署 入口与更新入口同形 — 对话框只余 覆盖开关 + 一步安装，来源恒为内置源（无 内容源/安装位置 UI），scope 由页面范围条持有；下列步骤 1/2 的 配置/预览 页签契约 retained as re-add reference]**; scoped to the selected target (the former multi-target 安装目标 grid is gone — one run touches one target). ~~Internal tablist **配置 / 预览 / 安装日志**.~~

**快速更新对话框 [新增 2026-10 快速更新]** — the info row's 更新至v{bundled} entry opens a stripped dialog on the same shell (title 更新 · {target} + close, live bar unchanged): **no tab row**（覆盖已开启 badge 与 realm · 写入 meta 随行隐藏 — 开关副行已表达状态）， no 内容源， no 安装位置， no 预览 pane. Body = the **覆盖已存在文件 switch only** (preset ON, amber consequence hint when on / default hint when off). **[变更 2026-10 极简部署弹窗：此形态现为两个入口的共同契约 — 部署 入口开同一壳体（title 部署 · {target}，覆盖 preset off），正文同为 覆盖开关 only，见 §3.24]** Footer = 取消 (ghost) + **安装** (primary, play icon)， always enabled — bundled source only, no plan gating UI. **安装 = plan-then-execute**: the plan is regenerated at click time from the current scope + switch (bundled source forced) and the run starts **directly into the 安装日志 view** — stale-preview rule (§4.2) N/A here since no plan is ever held for review; while planning the body shows a preparing indicator（spinner + 正在准备安装…）. The log view, its 停止 cooperative cancel and terminal reports (§3.9) are reused verbatim; footer becomes 关闭 as in the full dialog. A failed run's report card keeps 重试安装 — in quick mode it re-runs the quick plan→execute path. Reopening mid-run lands on the live log (Esc/backdrop close never cancels — §3.24 persistence).
1. ~~**配置（部署 入口）**~~ — **[移除 2026-10 极简部署弹窗：内容源（内置源/本地源 radios + 本地源目录面板与校验提示）与 安装位置（项目级/用户级分段 + 项目目录输入；zcode/dsh 固定位置行）全部移出对话框 — 来源恒为内置源，scope 由页面范围条（§4.3）持有；本地源 + dsh 预校验横幅（§10.2）随之移除 — 自定义 agents 源此后全链路不再支持（引擎 `Source::Local` 与 `validate_custom_source` 命令已删除，§7/§10.2）；契约 retained below as re-add reference]** 内容源 radios (内置源 / 本地源 + path + validity hints); 安装位置: scope seg + project dir (**opencode/claude only**; zcode/dsh render the fixed-location line + `固定` chip instead); 覆盖已存在文件 switch with consequence hint; pre-validation banner for 本地源 + dsh (§10.2, unchanged states). 部署 入口默认关闭 覆盖. Footer: 取消 + 开始安装.
2. ~~**预览**~~ — **[移除 2026-10 部署框精简：预览步整体移除 — 无入口再持有计划；契约 retained below as re-add reference]** target-scoped plan table (状态 / 目标文件 / 说明) + stale strip + footer summary; no filter chips (scoped plans are small). Former §4.3 preview states hold: empty (`尚未生成预览`) → ready → stale → regenerate; 覆盖 and 用户级 transitions render live. Footer: 取消 + 重新生成 + 开始安装.
3. **安装日志** — former §4.4 install flow verbatim (§3.9): live bar + progress + streaming lines + 停止 cooperative cancel (§10.1) + terminal reports ok/err/cancelled. Footer reduces to 关闭 — closing mid-run keeps the run going; reopening shows the live state. **[变更 2026-10 部署框精简：部署 与 更新 两入口的运行共用本视图 — 两个入口的重试安装 都即席重新 plan，从不复用旧计划]**
4. ~~**健康检查**~~ — **[移除 2026-10 十次修订：健康检查/漂移 UI 待需要时再加回]** The former health step (context line 检查对象：… + 重新检查 + tier cards §3.10 + drift list §3.11 + 漂移详情 dialog with 覆盖重装, §10.3) is removed from the UI; the backend `check_drift` command is retained (§7). Re-add with the original contract when a need re-emerges.

### 4.7 Locked-decision deltas (see §10 tail note)
- **§10.3 drift repair** — mechanism unchanged (no ad-hoc write, no recycle-bin backup); it now routes **inside the deploy dialog**. **[变更 2026-10 十次修订：随健康检查 UI 一并移除 — §10 尾注]**
- **§10.4 detection inform-only** — the 安装目标 checkbox cards are removed; detection surfaces at plan/execute time and on the deploy page's fixed-location lines (the sidebar card now shows only the bundled-source version — 十一次修订). The tab/status **deployment** dot reports whether a target has deployed files — it is not detection.
- **§10.5 dsh payload** — states render in the fixed location lines (page scope bar + dialog) and the preset summary; the sidebar version card no longer renders detection rows (十一次修订).
- **§10.1** — unchanged; 停止 now lives in the dialog's shared 安装日志 view. **§10.2 — [移除 2026-10 极简部署弹窗：自定义 agents 源不再支持，`validate_custom_source` 命令与引擎 `Source::Local` 删除，预校验横幅随本地源 UI 一并退出]**

## 5. Area 2 — 技能 — **[移除 2026-10：技能管理功能整体移除（页面、IPC 与核心引擎）]**

> Former 技能 page spec (§5.1–§5.4) removed with the feature; §5 numbering retained for references. The section was the skill-source/skill-list page contract over the `skills_*` commands and the `skill-progress` channel (§7) — all gone.

## 6. Area 3 — 设置

1. **通用** — 界面语言 select (English marked 计划于 M3， disabled option), 日志导出 disabled (计划于 M3).
2. **关于** — brand tile + `My Workbench 桌面版 · 版本 1.4.2 (stable) · Tauri 2`; **内置 agents 源版本** row: version + chip `与 npm 版本一致` (mismatch → amber chip `与 npm 版本不一致`); repo link; 检查更新 disabled (计划于 M3).

## 7. Backend command mapping

### Deploy (M1)
| UI | Command | Notes |
| --- | --- | --- |
| App start (deploy page scope bar/dialog + 设置 source version); 安装目标 ⭯; target dots | `detect_environment` | Returns per-target presence/version, Node presence/version, dsh home. Never blocks; results render as dots + text. |
| 生成预览 (header, empty state, stale strip, ↻) | `plan_install(selection, opts)` | Pure; returns per-file create/skip/overwrite/managed-block. Frontend must re-invoke on any selection change (stale rule §4.2). |
| 开始安装 | `execute_install(plan, opts)` | Events `install-log` (line: time/target/level/text) and `install-progress` (phase/count/percent) → log viewer + progress + live bar; final report from the command's return value. On cancel the report is flagged `cancelled: true` with completed counts. |
| 停止 (log header, running only) | `cancel_install` | Cooperative cancellation (locked): stops before starting the next file, never mid-file; already-written files are kept. UI renders the 已取消 terminal state (§3.9). |
| **[移除 2026-10 十次修订]** 健康检查 重新检查； post-install 运行健康检查 — UI entry removed (§10 tail note) | `check_drift(source, dir)` | Backend command **retained**; Tier 1 always; Tier 2 via local Node → pass / **skip-with-notice** / fail. Drift list from byte-compare results. Re-wire the UI from this row when the surface returns. |
| **[移除 2026-10 极简部署弹窗：自定义 agents 源不再支持]** Pre-validation banner (本地源 + DSH) | `validate_custom_source(source_dir)` (was locked — dedicated command, **not** a `check_drift` flag) | Command **deleted** 2026-10 along with the engine's `Source::Local` — the bundled `agents/` tree is the only content source; `check_drift` (retained) keeps the Tier 2 machinery. |

## 8. Copy list (zh — authoritative strings)

> **Copy rule (2026-09 sweep):** UI copy carries no command names, no CLI flags
> and no mechanism explanations. Internal tier vocabulary survives only as the
> zh labels 结构检查 / 执行状态检查. What surfaces from the backend (log lines,
> warnings, detection details) is short zh status + counts + paths + recovery
> hints. `[新增]` / `[变更]` / `[移除]` mark deltas from the previous list.

**Global:** 部署 / 设置 · 生成预览 · 开始安装 · 浏览… · 取消 · 保存 · 删除 · 刷新 · 查看详情 · 重新生成 · 重新检查 · 重新校验 · 关闭 · 稍后 · 计划于 M3 提供。 **[新增]** 窗口控制（无障碍标签，非可见文案）：最小化 / 最大化 / 还原（随窗口状态切换）/ 关闭。 **[移除 2026-10 十次修订：查看详情（漂移行）与 重新检查 随健康检查 UI 移除]**

**Deploy:** 内容源； 内置源 / **[变更]** 随应用打包（移除「经发布流水线预校验」）； 本地源 / 选择包含 agents/ 的目录（维护者工作流）； agents/ 树有效 · 检测到 4 个后端 · dsh 插件结构完整； 未找到 agents/ 目录 — 请选择包含 agents/ 的上层目录； 安装方式（合并原 安装位置 + 选项 两块为一卡）； 项目目录 = opencode / claude 项目级安装根目录； 安装目标； 已选 N 个； 未找到 DSH 主目录 · 仍可安装； **[变更]** 未找到唯一 profile（共 {n} 个候选）· 仍可安装（移除「补丁行将跳过并打印说明」尾注）； profile：{name}； DSH_HOME 已覆盖； **[移除 2026-10 十一次修订]** dsh profile（侧栏环境卡标签）—— 侧栏版本卡仅保留 内置源 行，Node / opencode / dsh profile 行随「我们不是其他程序的管理器」移除； **[变更]** 未检测到仍可安装。（移除「点状态圆点表示环境检测结果」半句）； 目录级安装 / 安装到项目目录； 用户级安装 / 安装到用户配置目录； **[变更]** 用户级提示：安装到用户配置目录而非项目目录（移除「（等效 CLI --user）」尾注）； 覆盖已存在文件 / **[变更]** 默认跳过已存在的文件（移除「（等效 CLI --force）」尾注）/ 已开启 — 已存在的文件将被直接覆盖，请确认； 先选择目标生成预览； **[变更]** 在左侧勾选安装目标，然后点击「生成预览」。预览不会写入任何文件。（移除「预览由 plan 命令生成」）； 选择已更改 — 预览可能过期，请重新生成； 预览不会写入任何文件； 新建 · 跳过 · 覆盖 · 受管块； `{X} 新建 · {Y} 跳过 · {Z} 覆盖 · {N} 受管块 · 共 {M} 个文件`； 生成于 {hh:mm:ss}； **[变更]** 预览面板元信息：{项目级|用户级} · 0 写入（移除 plan_install 前缀）； 安装日志； 未开始 / 运行中 / 已完成 / 已失败 / 已取消； 停止（tooltip：协作取消：将在当前文件写完后停止（已写入的文件保留））； 安装已取消； 第 {n} 个文件后停止； 已写入的文件保留； 自动滚动； 回到底部； 正在安装 {target} · {i}/{n} · {p}%； 安装完成 / 安装失败； 安装已中止 · 未写入任何文件； 重试安装； 运行健康检查； 健康检查； 检查对象：…； **[新增]** 日志目标标签 系统（引擎/版本标记行的来源标签，替代 core）； 渲染字节对比 11 / 11 一致； **[变更]** 结构检查（始终可用）— 卡题（移除 TIER 1 徽标与「纯 Rust · 始终可用」副行）； **[变更]** 结构检查全部通过 · 槽位与源结构完整； **[变更]** 执行状态检查（需要本地 Node）— 卡题（移除 TIER 2 徽标）； **[变更]** 执行检查通过 · 3 项（移除 node --check 与模块导入验证 注记）； **[变更]** 本地 Node v22.14.0 · 全部执行检查通过。（移除「与 CLI assemble --check 同语义」）； **[变更]** 执行状态检查已跳过：未检测到 Node（原「Tier 2 已跳过：未检测到 Node」）； **[新增]** 安装本地 Node 后点击「重新检查」。； **[新增]** 3 项执行检查未执行； **[新增]** 缺失 Node 不会阻塞安装。； **[移除]** 「此项从不静默通过」「缺失 Node 不会阻塞安装，也不会静默通过（锁定行为）」； 漂移报告； {N} 个文件与渲染期望不一致； 本地与渲染期望不一致； 漂移详情； 期望（渲染结果）/ 本地文件； 覆盖重装； 覆盖已开启； **[变更]** 将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。（移除「与 CLI --force 语义一致」尾句）； 已开启覆盖模式并重新生成预览（toast 标题）； **[变更]** 请确认预览后点击「开始安装」（toast 副行，移除「与 CLI --force 语义一致」）； **[变更]** 正在预校验本地源…（移除「（Tier 2 · DSH 渲染产物）」）； 本地源 + DSH 目标：安装前必须先通过执行状态检查。； 预校验通过 · 3 项执行检查； **[变更]** 本地源渲染的 DSH 工件通过全部执行检查 — 可以开始安装。； 预校验未通过 · 安装已阻止； **[变更]** 本地源需先通过预校验：（原「自定义源未经发布流水线校验，必须先通过 Tier 2」）； **[新增]** 预校验暂不可用。（预校验通道降级文案）。

**Deploy v2 — 部署页重构（2026-10，页面级文案；对话框内沿用上方 Deploy 列表）:** **[变更]** 页面副标题：管理各后端已部署的智能体与提示词 · 预览与安装均不访问网络； **[新增]** 标签/悬停状态（非可见文案）：{target}（已部署）/ {target}（未部署）； **[新增]** 状态行：未部署 / 已部署 · {n} 个智能体 / 已部署 · 预设 {name}； **[新增]** 头部操作：部署 / 更新（重新部署当前目标）/ 健康检查； **[新增]** 未部署空态：{target} 尚未部署 / 从内置源渲染并写入 {target} 的安装位置（{位置}），安装前可预览每个文件。/ 部署； **[变更]** 范围分段：项目级 / 用户级（原 目录级安装 / 用户级安装 的紧凑单行变体，副行文案移除）； 项目目录 / 浏览… / 项目目录 = opencode / claude 项目级安装根目录 / 安装到用户配置目录而非项目目录（保留）； **[新增]** 固定安装位置：部署位置 / 固定 / DSH_HOME → {home} · profile {name}； **[新增]** 智能体卡：模型（chip 标签）/ 思考等级（zcode）/ 推理强度（claude）/ 变体（opencode）/ 卡片悬停标题：点击打开提示词详情，可编辑、保存； **[变更 2026-10 详情页化：原「详情编辑器」改为整页详情页]** **[新增]** 返回（详情页返回按钮，ghost 层级 + 左箭头图标）； **[变更 同月二次修订]** 详情页标题行精简为 返回 / {agent}（mono 名称）— 描述 / 部署文件路径 / 只读 chips 不再出现于详情页标题区（路径仍在智能体卡上；模型 / 思考等级值即正文可编辑下拉）； 详情页正文（沿用原编辑器；**[变更 2026-10 十二次修订：提示词内容只读 — 随部署更新，保存/还原/未保存守卫仅作用于模型设置]**）：模型 / {思考等级|推理强度|变体} / 提示词内容（只读，随部署更新） / 还原 / 保存 / 保存中… / 提示词内容（只读，随部署更新） / **[移除 2026-10 十四次修订]** 保存 / 保存中…（保存按钮与底部分割线移除 — 选择即保存；**[移除 2026-10 十三次修订]** 与部署一致 / 未保存的更改（状态行）/ 已保存 · {hh:mm:ss} / 保存失败 — {原因}（状态行）/ 还原）； **[变更 2026-10 十四次修订]** toast：已保存 {agent} 的设置 · 已写入已部署文件； **[移除]** 详情 ✕ 关闭按钮及其无障碍标签 关闭提示词详情（返回 取而代之）； **[新增]** 未保存守卫：放弃未保存的更改？ / 关闭后将丢失对 {agent} 提示词的修改。 / 取消 / 放弃更改； **[新增]** dsh 预设摘要：dsh 已部署 / dsh 以预设为单位部署 — 没有单独的智能体文件。内置源更新后，上方信息行会出现「更新至…」按钮，点击即可从内置源重新部署。**[变更 2026-10：原「点击右上角『更新』…」文案随按钮移除而改写]** / 预设 / 主目录 / profile / 部署文件 / 部署时间； **[新增]** 部署对话框标题：部署 · {target} / 更新 · {target}； **[新增]** 对话框页签：配置（预览 / 安装日志 保留）**[变更 2026-10 十次修订：健康检查 页签移除]**； **[变更]** 对话框内 安装位置 分组（原页面级 安装方式 卡移入；zcode / dsh 显示固定安装位置）； **[变更]** 对话框预览空态：尚未生成预览 / 点击「生成预览」查看将要写入的文件。预览不会写入任何文件。； **[移除]** 页面级 生成预览 / 开始安装 头部按钮（两者只存在于部署对话框）； **[移除]** 安装目标 多选卡片及其检测行（环境检测保留在侧栏环境卡，部署状态另见状态行）； **[移除 2026-10 十次修订：健康检查/漂移 UI — 待需要时按原契约加回，后端 `check_drift` 保留]** 头部/工具栏操作 健康检查（已部署态仅余 更新）； 对话框 健康检查 页签及其全部文案：重新检查 / 运行健康检查 / 尚未运行健康检查 / 正在检查… / {标题} — 健康检查（错误横幅）/ 检查对象：… / 上次检查 {相对时间} / 渲染字节对比 {n} / {m} 一致 / {n} 个文件漂移 / 结构检查（始终可用）/ 结构检查全部通过 · 槽位与源结构完整 / 槽位计数 … / 执行状态检查（需要本地 Node）/ 执行检查通过 · 3 项 / 执行状态检查已跳过：未检测到 Node / 安装本地 Node 后点击「重新检查」。/ 3 项执行检查未执行 / 缺失 Node 不会阻塞安装。/ 本地 Node {v} · 全部执行检查通过。/ 存在失败的执行检查 — 若为本地源 + DSH 目标，安装将被阻止。/ 漂移报告 / 无漂移 — 全部文件与渲染期望一致 / {N} 个文件与渲染期望不一致 / 本地与渲染期望不一致 / 查看详情（漂移行）/ 漂移详情 / 期望（渲染结果）/ 本地文件 / 覆盖重装 / 将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。/ 已开启覆盖模式并重新生成预览（toast 标题）/ 请确认预览后点击「开始安装」（toast 副行）。注：预校验（本地源 + DSH）文案 — 正在预校验本地源… / 预校验通过 · 3 项执行检查 / 本地源 + DSH 目标：安装前必须先通过执行状态检查。等 — 属 `validate_custom_source`（§10.2），**保留不变**； **[移除 2026-10：信息行改造，用户指令]** 工具栏状态行（未部署 / 正在读取部署状态…）与工具栏 部署 / 更新 按钮 — 未部署入口为空态 CTA，已部署操作见 §4.5 信息行； 固定安装位置行（部署位置 / 固定 / DSH_HOME → {home} · profile {name} / DSH_HOME 已覆盖）— 位置由信息行承载（对话框内 安装位置 分组保留）； **[新增]** 信息行竖向发丝分割线（部署状态 | 位置 | 已部署 之间）； **[移除 2026-10 部署框精简]** 对话框页签 配置/预览/安装日志 及其 pulse 标记 / 覆盖已开启 badge / realm · 写入 meta 行 / 生成预览、重新生成 按钮 / 预览空态（尚未生成预览、点击「生成预览」查看将要写入的文件。预览不会写入任何文件。）/ 预览表与 stale 条（选择已更改 — 预览可能过期，请重新生成）/ 内置源版本 chip / 静态提示行（项目目录 = opencode / claude 项目级安装根目录、安装到用户配置目录而非项目目录）/ 对话框内 DSH_HOME 已覆盖 chip / 先生成了预览 等门控文案； **[变更]** 部署入口 开始安装 与更新入口 安装 同为一步安装（计划失败 toast：安装准备失败）； **[移除 2026-10 极简部署弹窗]** 对话框 内容源 分组（内置源 / 随应用打包 / 本地源 / 选择包含 agents/ 的目录（维护者工作流）/ 正在校验本地源… / agents/ 树有效 · 检测到 4 个后端 · dsh 插件结构完整 / 未找到 agents/ 目录 — 请选择包含 agents/ 的上层目录 / 本地源校验不可用 — 后端未就绪 / 重新校验）与 安装位置 分组（项目级 / 用户级 / 项目目录输入与 浏览… / 部署位置固定行与 固定 chip）及 本地源+dsh 预校验横幅全部文案 — 对话框正文只余 覆盖开关，两入口页脚统一为 取消 + 安装，来源恒为内置源（scope 由页面范围条持有）。

**Settings:** **[变更 2026-10：技能存储 与 GitHub 访问 两卡的文案随技能管理功能整体移除]** 通用； 界面语言； English（计划于 M3）; 日志导出； **[移除]** 与 npm 包同标签发布，应始终一致。； 关于； My Workbench 桌面版； 版本 {v} (stable) · Tauri 2; 内置 agents 源版本； 与 npm 版本一致 / 与 npm 版本不一致； 源代码仓库； 检查更新。

## 9. Accessibility

- Full keyboard path: nav → deploy tab bar (Left/Right) → scope bar → agent cards → detail-page fields → dialogs. Radio cards respond to Space/Enter; switches are `role="switch"`; **[变更 2026-10：详情页化]** agent cards are plain navigation buttons (no `aria-expanded` — the list is not visible while a detail page is open); the detail page is a labelled region (`提示词详情 · {agent}`), focus lands on its 返回 button when it opens and returns to the originating card on 返回； chips are buttons. [变更 2026-10：部署页 target checkboxes removed with the 安装目标 grid; 生成预览/开始安装 moved into the deploy dialog.]
- `aria-current` on nav; `role="tablist"/tab/tabpanel` on the backend tab bar and the deploy dialog's step tabs (v2); `role="log"` + `aria-live="polite"` on the log viewer (report card is the polite announcement; individual lines are not each announced); `aria-modal` + label on dialogs; toasts container `aria-live="polite"`; the detail page's dirty/saved status line is `aria-live="polite"` (dot + word, never color-only).
- Contrast: body text ≥ 7:1, secondary ≥ 4.5:1 on all surfaces (both themes); status is never color-only (dot shape/fill + text); focus ring is a 2px-offset 2px accent ring, visible on every interactive element. **[变更 2026-10 M3 刷新：tokens 重推后两主题按此逐对复核达标 — dark `--text-3` 旧值 ~4.06:1 与 light `--text-2/--text-3` 旧值不达标，已分别调至 `#8390a6` / `#3e4c63` / `#5d6b80`; 状态徽标文字于各自 tint 底 ≥ ~4.5:1 且始终带词/图标冗余]**
- Shortcuts: **no shortcuts layer in v1 (locked)** — no page shortcuts.
- Frameless window controls (§3.18): the window-control buttons are real `<button>`s — tabbable, §1.6 focus ring; the drag surfaces (sidebar brand row / the three page headers, whole-row via deep drag-region, plus the invisible top-edge `.drag-strip`) are not focusable (no tab stop) and are not keyboard surfaces; double-click on a header or the top edge toggles maximize (native); closing via Alt+F4 keeps working natively.
- Text selection policy **[变更 2026-10：桌面应用惯例]** — UI chrome is not selectable (`user-select: none` at the root): stray sweeps and drag-region presses never paint a selection across headers, tabs, buttons or labels. Real content surfaces opt back in: form fields (input / textarea / select) and the read-only prompt body (`.edt-ta`).
- `prefers-reduced-motion` disables pulse/shimmer/entrance animations.

## 10. Decisions (locked by orchestrator)

Replaces the former open-questions list; §10 numbering retained for references. Design language and tokens are frozen — these decisions amend behavior/copy only. **Note (2026-09 copy sweep):** where a decision entry quotes UI copy, §8 is the authoritative wording; quoted strings that carry command names or CLI flags were superseded by the sweep and are kept here only as decision history.

1. **Cancel — YES.** 停止 button in the log header next to the status chip, enabled only while running. Cancellation is cooperative: the backend stops before starting the next file, never mid-file. New terminal state 已取消 with report copy 「安装已取消 · 第 {n} 个文件后停止 · 已写入的文件保留」+ 重试安装 action. Backend contract: new command `cancel_install`; `execute_install` returns a report flagged `cancelled: true` with completed counts. (§3.9, §4.4, §7, §8)
2. **Pre-validation — dedicated command** `validate_custom_source(source_dir)` returning `{tier1, tier2 | skipped-notice, problems[]}`; blocks `execute_install` for 本地源 + DSH. UI unchanged from the mockup. Explicitly **not** modeled as a `check_drift` flag. (§7) **[移除 2026-10 极简部署弹窗：决策随「自定义 agents 源不再支持」退役 — 命令与引擎 Source::Local 已删除；本条 retained as decision history，需要时按 §7 行与 §8 文案原样加回]**
3. **Drift repair — via plan/execute, no ad-hoc write, NO recycle-bin backup.** Drift dialog footer is 「覆盖重装」 → closes the dialog, opens the normal preview flow with 覆盖 toggle forced ON (amber `覆盖已开启` badge in the panel header), copy 「将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。与 CLI --force 语义一致。」 期望/本地 diff view unchanged. (§3.11, §8)
4. **Detection = inform-only — confirmed.** Undetected targets stay selectable; prerequisite errors surface at plan/execute time. Original mockup assumption stands. (§4.1)
5. **DSH detection data.** `detect_environment` payload for dsh: `{home, homeSource:'env'|'default', exists, profile:{name}|null, profilesCount}`. Row hint states: 未找到 DSH 主目录 · 仍可安装 / 未找到唯一 profile（共 {n} 个候选）· 仍可安装（补丁行将跳过并打印说明）/ profile：{name}; plus 「DSH_HOME 已覆盖」 chip when `homeSource='env'`. States live on the dsh target card, the sidebar env card, and the demo panel (dsh 检测). (§4.1, §8)
6. **Skills progress — [移除 2026-10：随技能管理功能整体移除]** (was: event `skill-progress` mirroring `install-log`/`install-progress`; retained as decision history only). (§7)
7. **Window min size — 1024×680** (default 1200×800); the <1080px stacking breakpoint stands. If the M0 scaffold wrote 960×640, the implementation lane reconciles to this spec — the spec is the contract. (§2)
8. **Light theme — dark-only ships in M1**; tokens stay, light pass moves to M3 polish; demo theme toggle labeled `主题 · M3`. (§1.2) **[变更 2026-10 M3 刷新·三稿：default presentation = light（高级纯净 = 轻盈纯净），dark 降为维护中的第二主题并保持可用；实现侧在移植时翻转默认主题（fixer lane）]**
9. **Shortcuts — cut from v1.** No Ctrl+1/2/3 page shortcuts. (§9)
10. **Sample data — noted.** Versions/SHAs/paths/timestamps in the mockup are placeholders; wiring is the implementation lane's job.

**Deploy-page redesign deltas (2026-10) — decisions unchanged, surfaces moved.** (1) 停止/cooperative cancel and (2) pre-validation keep their contracts; they render in the deploy dialog's 安装日志 / 配置 views (§4.6). (3) Drift repair still writes only through plan/execute with no recycle-bin backup; 覆盖重装 now closes only the 漂移详情 dialog and lands on the deploy dialog's 预览 view with 覆盖 ON. (4) Detection stays inform-only; the former 安装目标 checkbox cards are removed from the page, detection surfaces on the deploy page's fixed-location lines **[变更 2026-10：页面级固定位置行已移除 — 检测负载现于对话框 安装位置 分组与 §4.5 信息行呈现]**, and the tab-bar/status-line dot reports **deployment** status (files deployed), not detection. (5) The dsh detection payload renders in the sidebar env card, the fixed 安装位置/部署位置 lines (page scope bar + dialog) **[变更 2026-10：页面级部分移除，仅对话框]**, and the dsh preset summary. (7) Window min size 1024×680 unchanged; the <1080px stacking breakpoint is obsolete (single fluid column). References in earlier sections to former §4.1/§4.3–§4.5 resolve to §4.1/§4.6. (9) **2026-10 detail-page pass, layout delta:** the deploy page's content column is **full-fluid** — the former single-column `max-width: 900px` cap is removed (roster `.dep-wrap` and the detail view alike; the detail view's 返回 clip-boundary compensation keeps its −18/+18 margin/padding pair), so the deploy content follows the window width; the **Settings column keeps its narrower cap** (760–1080px).

**2026-10 十次修订 — 健康检查/漂移 UI 移除（待需要时再加回）。** The health-check/drift feature surface is removed from the UI: the toolbar 健康检查 entry (§4.5 — deployed state shows **更新** only), the deploy dialog's 健康检查 step (§4.6 — steps are 配置 / 预览 / 安装日志), the tier cards + drift list (§3.10/§3.11, texts retained above as re-add reference), the 漂移详情 dialog and the 覆盖重装 drift-repair flow (§10.3 decision history above is retained verbatim). No use case emerged; re-add the surface with its original contract if a need re-emerges. **Backend unchanged:** the `check_drift` Tauri command and engine stay (§7 row annotated, not deleted). **Unaffected:** `validate_custom_source` (§10.2) and its pre-validation UI/flow are a separate feature and keep their §8 copy; `DriftReport`/`DriftFile`/`Tier1Report`/`Tier2*` contract types remain in `ui/src/lib/ipc.ts` for it.
