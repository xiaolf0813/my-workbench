# SPEC — My Workbench 桌面版 UI 设计规范

> Companion to `app.html`. **`app.html` is the visual contract** — open it in a browser at
> any window size; every state referenced below is reachable through the dashed
> “演示控制” panel (bottom-left, mockup scaffolding only — NOT product UI).
> Sample data (versions `1.4.2`, SHAs, paths like `D:\dev\acme-web`, log timestamps)
> are placeholders for realistic content, not requirements.

## 0. Design language (summary)

1. **Professional dev-tool, dark-first.** Deep blue-charcoal surfaces, hairline borders, no decorative chrome — hierarchy comes from typography, spacing and one accent, not from color noise.
2. **One accent: 钢青 steel-cyan** (`#3ccfdb`). Accent means *actionable/active* (primary buttons, active nav, focus, selection, progress). It never means success — green is reserved for *healthy*.
3. **Mono for everything the machine owns.** Paths, versions, SHAs, commands, log output, target names use the mono stack; UI prose uses the sans stack. Tabular numbers everywhere counts appear.
4. **Status is a dot + word, always explicit.** Environment detection, tiers, skills, network — every state is visible text plus a colored dot; nothing is communicated by color alone, and absence (Node missing, target not found) is shown, never hidden.
5. **Density where work happens, air where decisions happen.** Left config column breathes; the preview table and log viewer are compact (12–13px, 32px rows) because they are the product.

## 1. Tokens (CSS variables)

### 1.1 Color — dark (default)

| Token | Value | Usage |
| --- | --- | --- |
| `--bg-base` | `#0c0f14` | App background, sidebar |
| `--bg-surface` | `#12161d` | Cards, panels, dialogs |
| `--bg-raised` | `#181d26` | Hover fill, active nav, secondary buttons |
| `--bg-inset` | `#0a0d12` | Input wells, log background, segmented track |
| `--border` | `#1e2530` | Hairline card/row borders |
| `--border-strong` | `#2c3545` | Input borders, hover borders |
| `--text-1` | `#e7ecf4` | Primary text |
| `--text-2` | `#9aa5b8` | Secondary text, log body (≥ 7:1 on surface) |
| `--text-3` | `#6d7889` | Hints, labels (auxiliary only, ≥ 4.5:1) |
| `--accent` | `#3ccfdb` | The single brand accent |
| `--accent-hover / -down` | `#66dfe9` / `#2fb6c8` | Primary button hover/active |
| `--accent-text` | `#06222a` | Text on accent fills |
| `--accent-tint / -border` | `rgba(60,207,219,.10)` / `.38` | Selected card bg / accent outlines |
| `--ok` (+`-tint`,`-border`) | `#46d68c` | Healthy: create-badge, detected, 通过， 已安装·最新 |
| `--warn` (+`-tint`,`-border`) | `#f0b429` | Caution: overwrite-badge, local-modified **[变更 2026-10 十次修订：原 drift / Tier-2-skip 用例随健康检查 UI 一并移除]** |
| `--err` (+`-tint`,`-border`,`-solid`) | `#f5716f` / `#c94a48` | Failure text / solid danger button |
| `--vio` (+`-tint`,`-border`) | `#a78bfa` | Managed-block (受管块) only |

**Semantic rule (do not drift):** cyan = actionable · green = healthy · amber = caution/loss-risk · red = error/destructive · violet = managed-block · gray = static/skip.

### 1.2 Color — light (stretch goal; tokens shipped, demo-toggleable)

| Token | Value |
| --- | --- |
| `--bg-base / surface / raised / inset` | `#f4f6f9` / `#ffffff` / `#eef1f6` / `#f5f7fa` |
| `--border / -strong` | `#e4e8ef` / `#ccd4e0` |
| `--text-1 / 2 / 3` | `#182130` / `#57637a` / `#8b96a8` |
| `--accent` (+`-text`) | `#0b93a8` (white on fills) |
| `--ok / warn / err / err-solid / vio` | `#178a4c` / `#a16207` / `#d43d3b` / `#d43d3b` / `#6d4fd4` |

Light is implemented purely by variable overrides (`html[data-theme="light"]`); no component changes. **Decision (locked): dark-only ships in M1; the light-theme pixel pass moves to M3 polish.** Tokens above remain the contract; the demo theme toggle exists for review and is labeled `主题 · M3`.

### 1.3 Spacing / radius / elevation

- **Spacing scale (4px base):** `2 · 4 · 6 · 8 · 12 · 14 · 16 · 20 · 24`. Card inner padding 14–16; column gap 16; page padding 20/24.
- **Radius:** inputs & buttons `7`, small buttons `6`, cards & panels `10`, dialogs `12`, badges `5`, dots/knobs `50%`.
- **Shadow:** `--shadow-1` (subtle, raised chips) · `--shadow-2` (popovers/toasts) · `--shadow-3` (dialogs). Dark theme leans on borders; shadows are depth accents only.

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

`:focus-visible` = two-layer ring: `0 0 0 2px <surface>, 0 0 0 4px accent@65%`. Never removed, never replaced by color change alone.

## 2. Layout & navigation

- **Window:** default 1200×800, resizable, min 1024×680. **Frameless (`decorations: false`) — no OS title bar, and no in-app substitute:** there is no dedicated title-bar strip anywhere in the layout. The Windows-style 最小化 / 最大化·还原 / 关闭 controls (§3.18) are an **integrated fixed cluster floating over the window's top-right corner**, on top of the page-header area — they consume no layout height. **Dragging without a bar:** the sidebar brand row and the three page-header containers (部署 / 技能 / 设置) carry `data-tauri-drag-region`; Tauri starts a drag only when the mousedown target is the element bearing the attribute, so the **empty background areas of those rows** drag the window (double-click there toggles maximize) while child buttons/text stay fully interactive. Page-header action clusters keep right padding (§3.18) so they never sit under the controls. Alt+F4 and the system menu keep working natively.
- **Shell:** left sidebar 232px fixed + main content. Sidebar: brand (28px gradient tile + name), 3 nav items (部署 / 技能 / 设置)， footer **version card** (内置源 version only — the app's own bundled-source/app version). **[变更 2026-10 十一次修订]** third-party tool versions (Node, opencode, dsh) are no longer shown — the app is not their manager; `detect_environment` still runs at start and feeds the deploy page (scope bar, dialogs) and 设置.
- **Nav item:** 36px tall, icon + label + right meta slot; active = raised bg + 3px accent bar on the sidebar edge + accent icon. `aria-current="page"`.
- **Deploy page (v2 — amended 2026-10, §4):** backend tab bar + realm scope bar + a **single fluid content column** that fills the content area with the window (full-fluid, no width cap, scrolls) **[变更 2026-10 七次修订：原 max-width 900px 上限移除 — 技能 / 设置页保持各自较窄的栏宽上限]**. The former 2-column workspace (config 384px + preview panel, <1080px stacking) is retired — per-target deploy machinery moved into the target-scoped deploy dialog (§4.6); the min window (1024×680) is served by the fluid column. The Skills / Settings columns are unchanged.
- **Skills / Settings pages:** single scrolling column (max 760–1080px), same page-header pattern.
- **Page header:** title 20 + sub 12.5 muted; right-aligned primary actions.

## 3. Component inventory (anatomy + states)

### 3.1 Buttons — tiers
| Tier | Look | Use |
| --- | --- | --- |
| Primary (`.btn-primary`) | accent fill, dark text, 600 | 开始安装， 保存， 覆盖重装 |
| Secondary (`.btn`) | raised fill + strong border | 生成预览， 全部更新， 浏览… |
| Ghost (`.btn-ghost`) | transparent | 取消， low-emphasis actions |
| Accent outline (`.btn-acc-o`) | accent tint bg + accent border | 安装 (skill), empty-state CTA |
| Warn outline / Warn solid | amber | 更新 with local modifications / 备份后强制更新 |
| Danger outline / Danger solid | red | 清除 PAT, 删除 |

Sizes: 32px (default) / 26px small. Disabled = 42% opacity, `cursor:not-allowed`, keeps tooltip explaining why (e.g. 开始安装 disabled reasons: 未生成预览 / 预览已过期 / 预校验未通过 / 正在安装).

### 3.2 Badges (`.bd-*`) — one visual language everywhere
`新建` green · `跳过` neutral · `覆盖` amber · `受管块` violet · `未安装` neutral outline · `已安装·最新` green · `有本地修改` amber (+warn icon) · `可更新` cyan (+arrow icon, shows `→ vX.Y.Z` next to version). 11px/600, tint bg + border.

### 3.3 Status dot
7px circle. `.ok` = green fill + tint halo (detected) · `.off` = hollow gray ring (not found / not detected) · `.acc` = cyan (live/bundled source). Always paired with a text label; a target “未检测到” remains selectable — detection ≠ eligibility.

### 3.4 Radio card (content source) / Target checkbox card
Selectable cards: 1px border → accent border + accent tint when on; custom radio dot / 15px checkbox with white tick; mono 600 label; 11px muted status line under (detection text or “与 opencode 互斥”). Hover = raised bg. Keyboard: space/enter toggles; native checkbox input is visually hidden but focusable — focus ring on the card.

### 3.5 Switch (`.sw`)
34×20 pill, 16px knob, accent when on. Used for 覆盖已存在文件 / 自动滚动 (the former Deploy 用户级 switch became the 安装方式 segmented control, §4.1). `role="switch"` + `aria-checked`. Consequences appear immediately as hint lines (overwrite swaps hint to amber “已开启 — 已存在的文件将被直接覆盖”).

### 3.6 Segmented control (`.seg`)
Inset track + raised active segment. Used for the deploy dialog's step tabs (预览 / 安装日志 **[变更 2026-10 十次修订：健康检查步随健康检查 UI 移除 — 原三段为 预览 / 安装日志 / 健康检查]**) and the Deploy 安装方式 scope toggle (目录级安装 / 用户级安装 — a two-line variant: icon + label + subtitle, same tokens, §4.1; two buttons with `aria-pressed` in a labelled group, §9). The 日志 segment gains a pulsing cyan dot while installing. (The demo panel is the other user.)

### 3.7 Filter chips (`.chip`)
Label + tabular count. Active = accent tint/border. Used for plan-status filters and skill-status filters.

### 3.8 Plan preview table
Header 状态(88px) / 目标文件(flex) / 说明(230px). Path renders as muted mono directory + bright basename (`.dir`/`.nm` split) — scannability detail that matters. Row hover raised. `<thead>` sticky. Footer: summary `X 新建 · Y 跳过 · Z 覆盖 · N 受管块 · 共 M 个文件` (bold numbers) + right side `生成于 hh:mm:ss` + regenerate icon. Top-right of panel header: `项目级 · 0 写入` reminder. Filter chips above table; count chips update with data.

### 3.9 Log viewer
- **Header:** status chip (未开始 gray / 运行中 cyan+pulse / 已完成 green / 已失败 red / **已取消 amber**) + **停止** button (secondary, enabled only while running; tooltip `协作取消：将在当前文件写完后停止（已写入的文件保留）`) + right: 自动滚动 mini-switch (default on), 复制 icon, 导出 icon (disabled, tooltip “计划于 M3 提供”).
- **Progress row:** 4px bar (cyan gradient + shimmer while running; turns green on success, red on failure) + phase text `正在安装 claude · 12/15 · 80%`.
- **2px live bar** across the very top of the whole panel while running — visible from any tab.
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
info(cyan) / warn(amber) / err(red) / ok(green) / mut(neutral). Icon + title 12.5/600 + body 11.5 + optional right actions. Used for: Tier-2 pre-validation (checking/pass/blocked), rate-limit warning, offline notice.

### 3.13 Dialog (`.dlg`)
520px (640 for diff), radius 12, shadow-3, header (30px tinted icon square + 15px title + close) / body (12.5, `--text-2`, forms & lists) / footer right-aligned buttons. Open = backdrop blur-fade + panel rise; Esc and backdrop click close; focus moves in on open and returns to the invoker on close. Dialogs in scope: 添加/编辑技能源 · 检测到本地修改 · 删除技能 · 删除技能源 **[变更 2026-10 十次修订：漂移详情 dialog 随健康检查 UI 移除 — the 640px diff width is currently unused]**.

### 3.14 Toast
Bottom-right stack, 3.8s auto-dismiss, icon-colored by kind, optional mono sub-line. Used for command acknowledgements (安装完成 / 已删除 / 已保存源 …). Max ~3; newest at bottom.

### 3.15 Empty states
Centered: 44px rounded icon square → bold title → muted explanation (with mono keyword) → optional ghost CTA. Instances: preview empty (先选择目标生成预览)， log idle (尚未开始安装…), skill list no-match (没有匹配的技能 + 清除筛选).

### 3.16 Settings row
230px label column (title + hint) + fluid control column; separated by hairlines inside a card. Controls: path input + 浏览 + 恢复默认； masked PAT + 更新/清除； disabled select/buttons for M3 features with “计划于 M3 提供” hints.

### 3.17 Skill row
Grid: main (mono name + muted zh description) / source 170px (git icon + owner/repo) / version 150px mono (— for uninstalled) / status badge 110px / actions (status-dependent; see §5). Header row uses the same grid in 11px caps.

### 3.18 Window controls (frameless, integrated — `.win-ctl` / `.win-btn`)
No bar, no strip: `.win-ctl` is `position: fixed; top: 0; right: 0; height: 40px` (page-header rhythm), a floating cluster **over the page-header area** — z-index above page content, below the dialog scrim and toasts. It draws no background of its own: buttons sit directly on the page surface, hover provides the only fill. **46px-wide** hit targets, hairline inline SVG glyphs (`.ic`, 14px):
- **最小化** — hover = `--bg-raised` fill, text brightens.
- **最大化 / 还原** — icon swaps with window state (restore = double-square glyph); same hover as minimize.
- **关闭** (`.win-close`) — hover = `--err-solid` fill, white glyph (reuses the existing error token set; no new token).

**No collisions:** every page-header action cluster (`.ph-actions`) carries `padding-right: 150px` — wider than the 138px (3 × 46px) control cluster — so 生成预览/开始安装 (部署) and 全部更新/添加源 (技能) never render under the controls; 设置 has no header actions.

**Dragging without a bar:** `data-tauri-drag-region` sits on exactly four containers — the sidebar brand row and the three `.page-head` headers. Tauri's drag script fires only when the mousedown target is the element bearing the attribute, so dragging happens from the **empty background areas of those rows** (double-click there toggles maximize); child buttons/text and all content below the headers are unaffected.

Real `<button>`s: `aria-label` 最小化 / 最大化 / 还原 (swaps with state) / 关闭； §1.6 focus ring. **Browser degradation:** without Tauri IPC the cluster is **not rendered at all** (no dead controls, clean tab order).

### 3.19 Backend tab bar (deploy page, v2)
Pill tabs, mono 12.5px (machine names), 32px tall, radius 999, gap 8. Rest: transparent bg + `--border-strong` border + `--text-2`; hover = raised fill + `--text-1`; **selected = accent fill + `--accent-text`, weight 600** (accent = active, §0.2). `role="tablist"/"tab"`, `aria-selected`, `aria-controls`, Left/Right arrow navigation; each tab's `aria-label`/`title` carries deployment status — `{target}（已部署）` / `{target}（未部署）`. No status dot inside the pills: the selected target's state is spelled out as **dot + word** at the bar's right end (`未部署` hollow · `已部署 · {n} 个智能体` · `已部署 · 预设 {name}`), per §0.4. Tabs switch the whole main view.

### 3.20 Agent card
A full-width `<button>` (left-aligned): row 1 = mono agent name 13/600 + right-aligned value chips (§3.21); row 2 = mono deployed-file path 11px `--text-3`; row 3 = prompt-body preview, mono 12, **clamped to 2 lines** (line-clamp). States: rest (surface + border) → hover (raised + strong border). **[变更 2026-10 详情页化]** No open/closed card state — the card is a plain navigation trigger (no `aria-expanded`/`aria-controls`): clicking it opens the detail page (§3.22), which replaces the deploy content area, so the list is not visible while a detail page is open. Focus ring §1.6; the hover title carries the wireframe annotation copy (§8).

### 3.21 Value chips (`.achip`)
Mono 11px/500, radius 999, raised bg + strong border, `--text-2` **[变更 2026-10：open-card surface flip removed with the card open state]**. Chips render **machine-owned values verbatim** (`glm`, `high`) — never zh-translated, never status-colored (§0.3); the human label (模型 / 思考等级|推理强度|变体) lives in the `title` tooltip and the detail page's select label. These are *settings* chips, distinct from §3.2 status badges.

### 3.22 Agent detail page (deploy page) — full-page view
**[变更 2026-10：原下方内嵌的详情编辑器改为整页视图；细节修订同月：页面头部一并让位]** Clicking a card replaces the deploy page's entire content area **including its header row** — the 部署 title, subtitle, contextual header actions, tab bar, scope bar and card list all give way; the detail page's own header (返回 + agent name) **is the title**. Only the app frame stays (sidebar, floating window controls; the deploy page's drag surface returns with the header on 返回). Two view states per target: **roster** (default) ↔ **detail page**; 返回 routes back to the roster with the same tab + scope. Anatomy: a **page-level title row** — 返回 back button (ghost tier + arrow-left icon; focus lands here when the page opens; **[变更 2026-10 六次修订]** its glyph sits **flush-left on the textarea frame's left edge** in the rest state — the ghost button's padding is cancelled by a negative margin with a matching clip-boundary shift, so hover/focus pill and focus ring paint unclipped) + the mono agent name, **nothing else** **[变更 2026-10 三次修订：zh 描述 / 只读 chips / 部署文件路径 trimmed from the title area — the path still lives on the roster cards (§3.20) and the model/reasoning values are the editable selects below]** — sitting on the page background; below it the **chromeless editor column** that fills the remaining viewport height **[变更 2026-10 四次修订：外层卡片边框整体移除 — 选择行与页脚直接置于页面背景，与标题行左对齐，页脚保留上侧发丝线；仅提示词 textarea 保留自身边框；卡片入场动画随之移除]**. **Meta row:** field groups on **one horizontal line** **[变更 2026-10 五次修订：原标签叠在 selects 上方，现内联 — 标签位于各自 select 左侧，两组同一行]** — the 模型 label left of its select, and the per-backend reasoning label (`zcode` 思考等级 / `claude` 推理强度 / `opencode` 变体) left of its select, groups side by side; values render verbatim, e.g. `high` (dsh has no reasoning group — the lone 模型 group keeps the same row rhythm). **A select change writes immediately** — no 保存 button **[变更 2026-10 十四次修订：模型/思考等级随选择即时写入已部署文件；失败 toast 并回退显示值]**. **Body:** mono **text block** (`<pre>`, inset well, min-height 230 floor — the only framed element) **[变更 2026-10 十二次修订：提示词正文不是编辑框 — 纯文本展示，无编辑语义、无聚焦/全选效果；my-workbench 部署提示词而不管理提示词，正文随部署更新，仅模型设置可编辑，保存/还原/未保存守卫仅作用于设置]** that **flexes to fill the space between the field row and the bottom-pinned footer**; long content scrolls inside the block (the manual resize handle is retired); on very short windows the floor kicks in and the page scrolls instead **[变更 2026-10 八次修订：详情页纵向充满视口 — 标题/字段行在上、正文块弹性占据剩余高度、页脚钉在内容区底部；正文块为内部滚动面，缩放柄移除，极矮窗口回退为页面滚动；十二次修订后为纯文本块]**. **Footer:** none **[变更 2026-10 十四次修订：保存按钮与底部发丝线分割线移除 — 模型/思考等级随选择即时写入，失败经 toast 并回退显示值；详情页不再产生未保存状态，放弃未保存的更改 守卫对话框随之退出详情页（基础设施保留为惰性）]**. The former footer hairline, 保存 / 保存中… / 状态行 / 还原 are all retired — [移除 2026-10 十四次修订]（§8）. The toast 已保存 {agent} 的设置 · 已写入已部署文件 confirms a write.

### 3.23 Deploy empty states (v2)
- **Not deployed:** §3.15 anatomy — icon, `{target} 尚未部署`, explanation naming the install location in mono, plus a **部署 primary CTA**. Delta vs §3.15's ghost CTA: allowed because the CTA is the screen's only actionable element (accent = actionable).
- **dsh preset summary:** same anatomy; title `dsh 已部署`, explanation that dsh deploys as a preset with **no per-agent files**, plus a key-value summary card (预设 / 主目录 / profile / 部署文件 / 部署时间 — mono values, `--border` hairlines). The 更新 action stays in the page header.

### 3.24 Deploy dialog (§3.13 instance, 720px)
Scoped to the **one selected target**. Header: accent icon square + `{部署|更新} · {target}` + close. Body top: internal tablist **配置 / 预览 / 安装日志** (same `.seg` vocabulary as the former preview panel; **[变更 2026-10 十次修订：健康检查步移除，需要时再按原契约加回 — §10 尾注]**) + amber `覆盖已开启` badge + meta `{项目级|用户级} · 0 写入`; the 2px live bar sits across the dialog top while running (§3.9). Footer is contextual: config/preview = 取消 + 生成预览/重新生成 + 开始安装 (primary, gated by §4.2); log = 关闭. Panes reuse the existing component contract verbatim: 内容源 radios + 本地源 hints, 安装位置 (scope seg + project dir for opencode/claude; fixed-location line for zcode/dsh), 覆盖 switch, plan table + stale strip (§3.8, no filter chips — the scoped plan has ≤ ~6 rows), log viewer + terminal reports (§3.9).

## 4. Area 1 — 部署 (v2 — amended 2026-10)

> Rewritten for the 2026-10 wireframe: the page is organized **per backend target** — a tab bar switches the whole main view, deployed agents render as editable cards, and the entire deploy machinery is unchanged but lives in a **target-scoped deploy dialog** (§3.24). Former §4.1 (config column) → dialog config pane; former §4.3–4.5 (preview states / install flow / health tab) → dialog panes (§4.6). All §10 locked decisions carry over; explicit deltas are listed in §4.7 and §10.

### 4.1 Page frame
1. **Header** — unchanged: title 部署 + sub, `data-tauri-drag-region`, win-ctl clearance (§3.18). Sub copy [变更]: `管理各后端已部署的智能体与提示词 · 预览与安装均不访问网络`. **[变更 2026-10 详情页化]** This whole row is **not rendered while an agent detail page is open** (§3.22) — the detail page's 返回 + name header is the title; the row (with its drag surface and contextual actions) returns on 返回.
2. **Backend tab bar** (§3.19) — one pill per target: `opencode / claude / zcode / dsh`; selected = filled accent; switches the whole main view; per-tab `aria-label` carries deployment status; the selected target's status shows as dot + word at the bar's right end. Status derives from the **deployed-overview** read (whether the target has deployed files), *not* from environment detection.
3. **Realm scope bar** (§4.3) — one compact row under the tabs.
4. Body = the selected target's state (§4.4/§4.5), in a single **full-fluid** column that fills the content area and scrolls (no width cap — §2/§10 tail note). **[变更 2026-10]** While an agent detail page is open (§3.22) it takes over the whole page — **header row included** (§4.1): title, subtitle, header actions, tab bar, scope bar and card list give way until 返回; the detail content gains a 20px top clearance for the floating window controls (§3.18).

### 4.2 Stale-preview rule (unchanged, now dialog-scoped)
Any config change (source mode/path validity, scope, 覆盖) after a plan exists marks the dialog's preview stale: amber strip `选择已更改 — 预览可能过期，请重新生成` and 开始安装 disables until 重新生成. The plan is a pure function of the selection — never install from a stale plan. Scope changes made in the **page scope bar** while the dialog holds a preview also mark it stale (single shared scope state).

### 4.3 Realm scope bar (below the tab bar)
- **opencode / claude:** compact one-line segmented **项目级 / 用户级** (`aria-pressed` buttons in a labelled group) + project directory input + 浏览… (display + pick). Hint `项目目录 = opencode / claude 项目级安装根目录`; 用户级 swaps the picker for `安装到用户配置目录而非项目目录`. This is **one app-wide persisted state** shared 1:1 with the deploy dialog's 安装位置 section (and sent as `userLevel`/`projectDir` in the Selection).
- **zcode:** no toggle — fixed location line `部署位置` + mono `~\.zcode` + `固定` chip.
- **dsh:** fixed location line `部署位置` + mono `DSH_HOME → {home} · profile {name}` + the `DSH_HOME 已覆盖` chip when `homeSource='env'` (§10.5 payload).
- Changing scope/path invalidates a held dialog preview (§4.2).

### 4.4 Body — not deployed / deployed
- **Not deployed (§3.23):** centered empty state — `{target} 尚未部署` + explanation naming the install location + prominent **部署** primary CTA (opens the deploy dialog). Header shows a persistent 部署 primary too (§4.2 header-actions table).
- **Deployed, agent targets (opencode/claude/zcode):** two view states **[变更 2026-10]** —
  **roster** (default): the **agent card list** (§3.20) — one card per deployed agent file: mono name, model chip (`glm`), reasoning-level chip (backend term §3.21), mono deployed-file path, 2-line clamped prompt preview. Click → the **detail page** (§3.22) replaces the whole page including the header row (title/subtitle/actions, tab bar, scope bar and list give way); **返回** routes back to the roster in the same tab + scope.
- **Deployed, dsh (§3.23):** **preset summary** — no cards (dsh has no per-agent files), and no detail page: key rows 预设 / 主目录 / profile / 部署文件 / 部署时间 + hint to use the header 更新.

### 4.5 Per-target actions (contextual, `.dep-acts` in the deploy toolbar — **[变更 2026-10 九次修订]**: moved out of the page header; deployment is per-backend, so the actions live in the selected backend's own toolbar row, right of the status line)
| Selected target state | Toolbar actions |
| --- | --- |
| not deployed | **部署** (primary → deploy dialog) |
| deployed | **更新** (primary → dialog with **覆盖 preset ON**) **[变更 2026-10 十次修订：原二级操作 健康检查 移除，已部署态仅余 更新 — §10 尾注]** |

Neither action renders while an agent detail page is open — the whole content area gives way (§3.22/§4.1); exits run through 返回 / the guarded paths of §3.22. The page header carries no actions anymore (title + subtitle only). The not-deployed empty state keeps its own prominent **部署** CTA (§4.4).

### 4.6 Deploy dialog (§3.24)
Opened by 部署 / 更新 **[变更 2026-10 十次修订：原 健康检查 入口移除]**; scoped to the selected target (the former multi-target 安装目标 grid is gone — one run touches one target). Internal tablist **配置 / 预览 / 安装日志**.
1. **配置** — former config column, verbatim: 内容源 radios (内置源 version chip / 本地源 + path + validity hints); 安装位置: scope seg + project dir (**opencode/claude only**; zcode/dsh render the fixed-location line instead); 覆盖已存在文件 switch with amber consequence hint; pre-validation banner for 本地源 + dsh (§10.2, unchanged states). **Invoked from 更新, 覆盖 presets to ON** (badge + amber hint + preview re-plans 跳过→覆盖). Footer: 取消 + 生成预览 + 开始安装.
2. **预览** — target-scoped plan table (状态 / 目标文件 / 说明) + stale strip + footer summary; no filter chips (scoped plans are small). Former §4.3 preview states hold: empty (`尚未生成预览`) → ready → stale → regenerate; 覆盖 and 用户级 transitions render live. Footer: 取消 + 重新生成 + 开始安装.
3. **安装日志** — former §4.4 install flow verbatim (§3.9): live bar + progress + streaming lines + 停止 cooperative cancel (§10.1) + terminal reports ok/err/cancelled. Footer reduces to 关闭 — closing mid-run keeps the run going; reopening shows the live state.
4. ~~**健康检查**~~ — **[移除 2026-10 十次修订：健康检查/漂移 UI 待需要时再加回]** The former health step (context line 检查对象：… + 重新检查 + tier cards §3.10 + drift list §3.11 + 漂移详情 dialog with 覆盖重装, §10.3) is removed from the UI; the backend `check_drift` command is retained (§7). Re-add with the original contract when a need re-emerges.

### 4.7 Locked-decision deltas (see §10 tail note)
- **§10.3 drift repair** — mechanism unchanged (no ad-hoc write, no recycle-bin backup); it now routes **inside the deploy dialog**. **[变更 2026-10 十次修订：随健康检查 UI 一并移除 — §10 尾注]**
- **§10.4 detection inform-only** — the 安装目标 checkbox cards are removed; detection surfaces at plan/execute time and on the deploy page's fixed-location lines (the sidebar card now shows only the bundled-source version — 十一次修订). The tab/status **deployment** dot reports whether a target has deployed files — it is not detection.
- **§10.5 dsh payload** — states render in the fixed location lines (page scope bar + dialog) and the preset summary; the sidebar version card no longer renders detection rows (十一次修订).
- **§10.1/§10.2** — unchanged; 停止 and the pre-validation banner now live in the dialog's 安装日志 / 配置 views.

## 5. Area 2 — 技能

### 5.1 Layout
Header: title + install-root sub + actions 全部更新 (with count chip) / 添加源 / refresh icon. Below: network banner slot → 技能源 card (source chips) → toolbar (search with `/` shortcut kbd, status filter chips, cache label) → skill list.

### 5.2 Source chips
Mono `owner/repo` + meta line (`@main · 8 个技能 · 公开` / lock icon + `@v2 · 4 个技能 · 私有 · PAT`) + hover actions 编辑 (opens 添加/编辑 dialog in edit mode) and 删除 (confirm dialog: “已安装的技能不受影响，仅解除关联”). Click chip = filter list by that source (accent state); dashed 添加源 chip at the end. Add/edit dialog fields: 仓库 `owner/repo` (mono, required), 分支/Ref (可选)， 技能子目录 (可选， placeholder `skills/`), keyring/PAT note.

### 5.3 Skill rows & actions
| Status | Badge | Actions |
| --- | --- | --- |
| 未安装 | neutral | 安装 (accent outline) · 删除 (icon) |
| 已安装·最新 | green | 重装 (ghost) · 删除 |
| 有本地修改 | amber | 更新 (warn outline) · 删除 |
| 可更新 | cyan (+`→ vNext`) | 更新 (secondary) · 删除 |

删除 → confirm dialog with **备份到回收站** checkbox (default on) → toast `已删除 docx · 已备份到回收站 · 清单已更新`. 更新 on a modified skill → 检测到本地修改 dialog: modified-file list (本地文件与安装时内容对比), warning 强制更新将丢失这些修改， backup path hint `~\.agents\skills\.backups\<skill>-<timestamp>\`, actions 取消 / 备份后强制更新 (warn solid).

### 5.4 Network states (demo: 最新 / 缓存 / 限流 / 离线)
- **最新：** cache label `刚刚刷新 · 14:32`.
- **缓存：** label `列表缓存于 12 分钟前 · 上次刷新 14:08` (default state).
- **限流：** amber banner `GitHub API 限额提醒 — 未认证限额 60 次/小时… 配置 PAT 后提升至 5,000 次/小时` + 前往设置 link.
- **离线：** neutral banner `离线 — 无法连接 GitHub…安装与更新不可用；删除与查看不受影响`; install/update buttons disabled with tooltips; cache label becomes `离线 · 显示本地清单（12 个技能）`; refresh toast explains. List/delete/search still work off the local manifest.

## 6. Area 3 — 设置

1. **技能存储** — 技能根目录 path (`~\.agents\skills\`, 浏览 / 恢复默认) + hint naming the manifest: `<root>\.workbench-skills.json` + 打开技能目录 link.
2. **GitHub 访问** — configured state shown: masked `ghp_••••…` (never re-displayed), 更新 / 清除 buttons, green keyring note `已存入系统钥匙串 · 保存后不再显示完整令牌`, rate-limit hint. Unconfigured state: password input + 保存 (primary) + required-scope hint `repo`.
3. **通用** — 界面语言 select (English marked 计划于 M3， disabled option), 日志导出 disabled (计划于 M3).
4. **关于** — brand tile + `My Workbench 桌面版 · 版本 1.4.2 (stable) · Tauri 2`; **内置 agents 源版本** row: version + chip `与 npm 版本一致` (mismatch → amber chip `与 npm 版本不一致`); repo link; 检查更新 disabled (计划于 M3).

## 7. Backend command mapping

### Deploy (M1)
| UI | Command | Notes |
| --- | --- | --- |
| App start (deploy page scope bar/dialog + 设置 source version); 安装目标 ⭯; target dots | `detect_environment` | Returns per-target presence/version, Node presence/version, dsh home. Never blocks; results render as dots + text. |
| 生成预览 (header, empty state, stale strip, ↻) | `plan_install(selection, opts)` | Pure; returns per-file create/skip/overwrite/managed-block. Frontend must re-invoke on any selection change (stale rule §4.2). |
| 开始安装 | `execute_install(plan, opts)` | Events `install-log` (line: time/target/level/text) and `install-progress` (phase/count/percent) → log viewer + progress + live bar; final report from the command's return value. On cancel the report is flagged `cancelled: true` with completed counts. |
| 停止 (log header, running only) | `cancel_install` | Cooperative cancellation (locked): stops before starting the next file, never mid-file; already-written files are kept. UI renders the 已取消 terminal state (§3.9). |
| **[移除 2026-10 十次修订]** 健康检查 重新检查； post-install 运行健康检查 — UI entry removed (§10 tail note) | `check_drift(source, dir)` | Backend command **retained**; Tier 1 always; Tier 2 via local Node → pass / **skip-with-notice** / fail. Drift list from byte-compare results. Re-wire the UI from this row when the surface returns. |
| Pre-validation banner (本地源 + DSH) | `validate_custom_source(source_dir)` (locked — dedicated command, **not** a `check_drift` flag) | Returns `{tier1, tier2 \| skipped-notice, problems[]}`; blocks `execute_install` until it passes. UI states unchanged: checking / pass / fail-with-reasons. |

### Skills (M2 — proposed IPC shape)
`list_sources` · `add_source({repo, ref?, subdir?})` · `update_source` · `remove_source` · `list_skills({source?, cache_ok})` · `refresh_skills` (network, respects rate limit) · `install_skill({name, source})` · `update_skills({scope: 'all'|names, force, backup})` → progress events (`skill-progress`, confirmed — mirrors `install-log`/`install-progress`; exact phases fixed in the M2 skill-repo spec doc) · `delete_skill({name, trash})` · `set_pat` / `clear_pat` / `pat_status` (OS keyring; token value never round-trips to the UI).

## 8. Copy list (zh — authoritative strings)

> **Copy rule (2026-09 sweep):** UI copy carries no command names, no CLI flags
> and no mechanism explanations. Internal tier vocabulary survives only as the
> zh labels 结构检查 / 执行状态检查. What surfaces from the backend (log lines,
> warnings, detection details) is short zh status + counts + paths + recovery
> hints. `[新增]` / `[变更]` / `[移除]` mark deltas from the previous list.

**Global:** 部署 / 技能 / 设置 · 生成预览 · 开始安装 · 浏览… · 取消 · 保存 · 删除 · 刷新 · 查看详情 · 重新生成 · 重新检查 · 重新校验 · 关闭 · 稍后 · 计划于 M3 提供。 **[新增]** 窗口控制（无障碍标签，非可见文案）：最小化 / 最大化 / 还原（随窗口状态切换）/ 关闭。 **[移除 2026-10 十次修订：查看详情（漂移行）与 重新检查 随健康检查 UI 移除]**

**Deploy:** 内容源； 内置源 / **[变更]** 随应用打包（移除「经发布流水线预校验」）； 本地源 / 选择包含 agents/ 的目录（维护者工作流）； agents/ 树有效 · 检测到 4 个后端 · dsh 插件结构完整； 未找到 agents/ 目录 — 请选择包含 agents/ 的上层目录； 安装方式（合并原 安装位置 + 选项 两块为一卡）； 项目目录 = opencode / claude 项目级安装根目录； 安装目标； 已选 N 个； 未找到 DSH 主目录 · 仍可安装； **[变更]** 未找到唯一 profile（共 {n} 个候选）· 仍可安装（移除「补丁行将跳过并打印说明」尾注）； profile：{name}； DSH_HOME 已覆盖； **[移除 2026-10 十一次修订]** dsh profile（侧栏环境卡标签）—— 侧栏版本卡仅保留 内置源 行，Node / opencode / dsh profile 行随「我们不是其他程序的管理器」移除； **[变更]** 未检测到仍可安装。（移除「点状态圆点表示环境检测结果」半句）； 目录级安装 / 安装到项目目录； 用户级安装 / 安装到用户配置目录； **[变更]** 用户级提示：安装到用户配置目录而非项目目录（移除「（等效 CLI --user）」尾注）； 覆盖已存在文件 / **[变更]** 默认跳过已存在的文件（移除「（等效 CLI --force）」尾注）/ 已开启 — 已存在的文件将被直接覆盖，请确认； 先选择目标生成预览； **[变更]** 在左侧勾选安装目标，然后点击「生成预览」。预览不会写入任何文件。（移除「预览由 plan 命令生成」）； 选择已更改 — 预览可能过期，请重新生成； 预览不会写入任何文件； 新建 · 跳过 · 覆盖 · 受管块； `{X} 新建 · {Y} 跳过 · {Z} 覆盖 · {N} 受管块 · 共 {M} 个文件`； 生成于 {hh:mm:ss}； **[变更]** 预览面板元信息：{项目级|用户级} · 0 写入（移除 plan_install 前缀）； 安装日志； 未开始 / 运行中 / 已完成 / 已失败 / 已取消； 停止（tooltip：协作取消：将在当前文件写完后停止（已写入的文件保留））； 安装已取消； 第 {n} 个文件后停止； 已写入的文件保留； 自动滚动； 回到底部； 正在安装 {target} · {i}/{n} · {p}%； 安装完成 / 安装失败； 安装已中止 · 未写入任何文件； 重试安装； 运行健康检查； 健康检查； 检查对象：…； **[新增]** 日志目标标签 系统（引擎/版本标记行的来源标签，替代 core）； 渲染字节对比 11 / 11 一致； **[变更]** 结构检查（始终可用）— 卡题（移除 TIER 1 徽标与「纯 Rust · 始终可用」副行）； **[变更]** 结构检查全部通过 · 槽位与源结构完整； **[变更]** 执行状态检查（需要本地 Node）— 卡题（移除 TIER 2 徽标）； **[变更]** 执行检查通过 · 3 项（移除 node --check 与模块导入验证 注记）； **[变更]** 本地 Node v22.14.0 · 全部执行检查通过。（移除「与 CLI assemble --check 同语义」）； **[变更]** 执行状态检查已跳过：未检测到 Node（原「Tier 2 已跳过：未检测到 Node」）； **[新增]** 安装本地 Node 后点击「重新检查」。； **[新增]** 3 项执行检查未执行； **[新增]** 缺失 Node 不会阻塞安装。； **[移除]** 「此项从不静默通过」「缺失 Node 不会阻塞安装，也不会静默通过（锁定行为）」； 漂移报告； {N} 个文件与渲染期望不一致； 本地与渲染期望不一致； 漂移详情； 期望（渲染结果）/ 本地文件； 覆盖重装； 覆盖已开启； **[变更]** 将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。（移除「与 CLI --force 语义一致」尾句）； 已开启覆盖模式并重新生成预览（toast 标题）； **[变更]** 请确认预览后点击「开始安装」（toast 副行，移除「与 CLI --force 语义一致」）； **[变更]** 正在预校验本地源…（移除「（Tier 2 · DSH 渲染产物）」）； 本地源 + DSH 目标：安装前必须先通过执行状态检查。； 预校验通过 · 3 项执行检查； **[变更]** 本地源渲染的 DSH 工件通过全部执行检查 — 可以开始安装。； 预校验未通过 · 安装已阻止； **[变更]** 本地源需先通过预校验：（原「自定义源未经发布流水线校验，必须先通过 Tier 2」）； **[新增]** 预校验暂不可用。（预校验通道降级文案）。

**Deploy v2 — 部署页重构（2026-10，页面级文案；对话框内沿用上方 Deploy 列表）:** **[变更]** 页面副标题：管理各后端已部署的智能体与提示词 · 预览与安装均不访问网络； **[新增]** 标签/悬停状态（非可见文案）：{target}（已部署）/ {target}（未部署）； **[新增]** 状态行：未部署 / 已部署 · {n} 个智能体 / 已部署 · 预设 {name}； **[新增]** 头部操作：部署 / 更新（重新部署当前目标）/ 健康检查； **[新增]** 未部署空态：{target} 尚未部署 / 从内置源渲染并写入 {target} 的安装位置（{位置}），安装前可预览每个文件。/ 部署； **[变更]** 范围分段：项目级 / 用户级（原 目录级安装 / 用户级安装 的紧凑单行变体，副行文案移除）； 项目目录 / 浏览… / 项目目录 = opencode / claude 项目级安装根目录 / 安装到用户配置目录而非项目目录（保留）； **[新增]** 固定安装位置：部署位置 / 固定 / DSH_HOME → {home} · profile {name}； **[新增]** 智能体卡：模型（chip 标签）/ 思考等级（zcode）/ 推理强度（claude）/ 变体（opencode）/ 卡片悬停标题：点击打开提示词详情，可编辑、保存； **[变更 2026-10 详情页化：原「详情编辑器」改为整页详情页]** **[新增]** 返回（详情页返回按钮，ghost 层级 + 左箭头图标）； **[变更 同月二次修订]** 详情页标题行精简为 返回 / {agent}（mono 名称）— 描述 / 部署文件路径 / 只读 chips 不再出现于详情页标题区（路径仍在智能体卡上；模型 / 思考等级值即正文可编辑下拉）； 详情页正文（沿用原编辑器；**[变更 2026-10 十二次修订：提示词内容只读 — 随部署更新，保存/还原/未保存守卫仅作用于模型设置]**）：模型 / {思考等级|推理强度|变体} / 提示词内容（只读，随部署更新） / 还原 / 保存 / 保存中… / 提示词内容（只读，随部署更新） / **[移除 2026-10 十四次修订]** 保存 / 保存中…（保存按钮与底部分割线移除 — 选择即保存；**[移除 2026-10 十三次修订]** 与部署一致 / 未保存的更改（状态行）/ 已保存 · {hh:mm:ss} / 保存失败 — {原因}（状态行）/ 还原）； **[变更 2026-10 十四次修订]** toast：已保存 {agent} 的设置 · 已写入已部署文件； **[移除]** 详情 ✕ 关闭按钮及其无障碍标签 关闭提示词详情（返回 取而代之）； **[新增]** 未保存守卫：放弃未保存的更改？ / 关闭后将丢失对 {agent} 提示词的修改。 / 取消 / 放弃更改； **[新增]** dsh 预设摘要：dsh 已部署 / dsh 以预设为单位部署 — 没有单独的智能体文件。点击右上角「更新」从内置源重新部署。/ 预设 / 主目录 / profile / 部署文件 / 部署时间； **[新增]** 部署对话框标题：部署 · {target} / 更新 · {target}； **[新增]** 对话框页签：配置（预览 / 安装日志 保留）**[变更 2026-10 十次修订：健康检查 页签移除]**； **[变更]** 对话框内 安装位置 分组（原页面级 安装方式 卡移入；zcode / dsh 显示固定安装位置）； **[变更]** 对话框预览空态：尚未生成预览 / 点击「生成预览」查看将要写入的文件。预览不会写入任何文件。； **[移除]** 页面级 生成预览 / 开始安装 头部按钮（两者只存在于部署对话框）； **[移除]** 安装目标 多选卡片及其检测行（环境检测保留在侧栏环境卡，部署状态另见状态行）； **[移除 2026-10 十次修订：健康检查/漂移 UI — 待需要时按原契约加回，后端 `check_drift` 保留]** 头部/工具栏操作 健康检查（已部署态仅余 更新）； 对话框 健康检查 页签及其全部文案：重新检查 / 运行健康检查 / 尚未运行健康检查 / 正在检查… / {标题} — 健康检查（错误横幅）/ 检查对象：… / 上次检查 {相对时间} / 渲染字节对比 {n} / {m} 一致 / {n} 个文件漂移 / 结构检查（始终可用）/ 结构检查全部通过 · 槽位与源结构完整 / 槽位计数 … / 执行状态检查（需要本地 Node）/ 执行检查通过 · 3 项 / 执行状态检查已跳过：未检测到 Node / 安装本地 Node 后点击「重新检查」。/ 3 项执行检查未执行 / 缺失 Node 不会阻塞安装。/ 本地 Node {v} · 全部执行检查通过。/ 存在失败的执行检查 — 若为本地源 + DSH 目标，安装将被阻止。/ 漂移报告 / 无漂移 — 全部文件与渲染期望一致 / {N} 个文件与渲染期望不一致 / 本地与渲染期望不一致 / 查看详情（漂移行）/ 漂移详情 / 期望（渲染结果）/ 本地文件 / 覆盖重装 / 将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。/ 已开启覆盖模式并重新生成预览（toast 标题）/ 请确认预览后点击「开始安装」（toast 副行）。注：预校验（本地源 + DSH）文案 — 正在预校验本地源… / 预校验通过 · 3 项执行检查 / 本地源 + DSH 目标：安装前必须先通过执行状态检查。等 — 属 `validate_custom_source`（§10.2），**保留不变**。

**Skills:** 从 GitHub 仓库安装与管理技能 · 安装位置 ~\.agents\skills\; 全部更新； 添加源； 技能源； {n} 个源 · 公开 {n} · 私有 {n}; 点击按该源筛选； 编辑源 / 删除源； 仓库 / owner/repo; 分支 / Ref（可选）； 技能子目录（可选）skills/; 私有仓库将使用已配置的 GitHub PAT（设置 → GitHub 访问）。公开仓库无需认证。； 移除源； 已安装的技能不受影响，仅解除关联（无法再更新）。； 搜索技能…; 列表缓存于 {n} 分钟前 · 上次刷新 {hh:mm}; 刚刚刷新； GitHub API 限额提醒 / 未认证限额 60 次/小时，即将用尽。配置 PAT 后提升至 5,000 次/小时。/ 前往设置； 离线 — 无法连接 GitHub / 当前显示本地清单，安装与更新不可用；删除与查看不受影响。恢复网络后点击刷新。； 离线 · 显示本地清单（{n} 个技能）； 未安装 / 已安装 · 最新 / 有本地修改 / 可更新； 安装 / 更新 / 重装； 全部更新； 没有匹配的技能 / 清除筛选； 检测到本地修改； **[变更]** 技能 {name} 的以下文件自安装后被修改过：（移除「（与安装时哈希快照不符）」）； 已修改的文件 · {n}; 强制更新将丢失这些修改。选择「备份后强制更新」会先把当前目录完整备份，再应用远端最新版本。； 备份位置：~\.agents\skills\.backups\{skill}-{timestamp}\; 备份后强制更新； 删除技能； 将从 ~\.agents\skills\ 移除 {name} 及其清单条目。此操作不可撤销（除非勾选备份）。； 备份到回收站（删除前复制整个技能目录到系统回收站）； 离线状态：安装与更新不可用； **[变更]** 已保存源 {repo} · 技能源已刷新（toast 副行，原「list_sources 已刷新」）。

**Settings:** 技能存储； 技能根目录； **[变更]** 技能安装位置。默认 ~\.agents\skills\。（移除「（ZCode 与 npx skills 生态均读取此布局）」）； 技能清单存储于 <root>\.workbench-skills.json。**[变更]**（移除「· 记录来源仓库、ref、commit SHA、安装时间与逐文件哈希快照」）； 打开技能目录； 恢复默认； GitHub 访问； GitHub PAT（个人访问令牌）； 公开仓库无需令牌；私有仓库读取需要 repo 权限的 PAT。； **[变更]** 已存入系统钥匙串 · 保存后不再显示完整令牌。（移除「绝不以明文写入磁盘」）； 配置 PAT 后，GitHub API 限额由 60 次/小时（未认证）提升至 5,000 次/小时。； 更新 / 清除； 通用； 界面语言； English（计划于 M3）; 日志导出； **[移除]** 与 npm 包同标签发布，应始终一致。； 关于； My Workbench 桌面版； 版本 {v} (stable) · Tauri 2; 内置 agents 源版本； 与 npm 版本一致 / 与 npm 版本不一致； 源代码仓库； 检查更新。

## 9. Accessibility

- Full keyboard path: nav → deploy tab bar (Left/Right) → scope bar → agent cards → detail-page fields → dialogs. Radio cards respond to Space/Enter; switches are `role="switch"`; **[变更 2026-10：详情页化]** agent cards are plain navigation buttons (no `aria-expanded` — the list is not visible while a detail page is open); the detail page is a labelled region (`提示词详情 · {agent}`), focus lands on its 返回 button when it opens and returns to the originating card on 返回； chips are buttons. [变更 2026-10：部署页 target checkboxes removed with the 安装目标 grid; 生成预览/开始安装 moved into the deploy dialog.]
- `aria-current` on nav; `role="tablist"/tab/tabpanel` on the backend tab bar and the deploy dialog's step tabs (v2); `role="log"` + `aria-live="polite"` on the log viewer (report card is the polite announcement; individual lines are not each announced); `aria-modal` + label on dialogs; toasts container `aria-live="polite"`; the detail page's dirty/saved status line is `aria-live="polite"` (dot + word, never color-only).
- Contrast: body text ≥ 7:1, secondary ≥ 4.5:1 on all surfaces (both themes); status is never color-only (dot shape/fill + text); focus ring is a 2px-offset 2px accent ring, visible on every interactive element.
- Shortcuts: **no shortcuts layer in v1 (locked)** — no page shortcuts; `/` is kept only as focus-search on the Skills page, guarded against input/typing contexts and open dialogs.
- Frameless window controls (§3.18): the window-control buttons are real `<button>`s — tabbable, §1.6 focus ring; the drag surfaces (sidebar brand row / page-header empty background areas) are not focusable (no tab stop) and are not keyboard surfaces; double-click on a header's empty area toggles maximize (native); closing via Alt+F4 keeps working natively.
- `prefers-reduced-motion` disables pulse/shimmer/entrance animations.

## 10. Decisions (locked by orchestrator)

Replaces the former open-questions list; §10 numbering retained for references. Design language and tokens are frozen — these decisions amend behavior/copy only. **Note (2026-09 copy sweep):** where a decision entry quotes UI copy, §8 is the authoritative wording; quoted strings that carry command names or CLI flags were superseded by the sweep and are kept here only as decision history.

1. **Cancel — YES.** 停止 button in the log header next to the status chip, enabled only while running. Cancellation is cooperative: the backend stops before starting the next file, never mid-file. New terminal state 已取消 with report copy 「安装已取消 · 第 {n} 个文件后停止 · 已写入的文件保留」+ 重试安装 action. Backend contract: new command `cancel_install`; `execute_install` returns a report flagged `cancelled: true` with completed counts. (§3.9, §4.4, §7, §8)
2. **Pre-validation — dedicated command** `validate_custom_source(source_dir)` returning `{tier1, tier2 | skipped-notice, problems[]}`; blocks `execute_install` for 本地源 + DSH. UI unchanged from the mockup. Explicitly **not** modeled as a `check_drift` flag. (§7)
3. **Drift repair — via plan/execute, no ad-hoc write, NO recycle-bin backup.** Drift dialog footer is 「覆盖重装」 → closes the dialog, opens the normal preview flow with 覆盖 toggle forced ON (amber `覆盖已开启` badge in the panel header), copy 「将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。与 CLI --force 语义一致。」 期望/本地 diff view unchanged. (§3.11, §8)
4. **Detection = inform-only — confirmed.** Undetected targets stay selectable; prerequisite errors surface at plan/execute time. Original mockup assumption stands. (§4.1)
5. **DSH detection data.** `detect_environment` payload for dsh: `{home, homeSource:'env'|'default', exists, profile:{name}|null, profilesCount}`. Row hint states: 未找到 DSH 主目录 · 仍可安装 / 未找到唯一 profile（共 {n} 个候选）· 仍可安装（补丁行将跳过并打印说明）/ profile：{name}; plus 「DSH_HOME 已覆盖」 chip when `homeSource='env'`. States live on the dsh target card, the sidebar env card, and the demo panel (dsh 检测). (§4.1, §8)
6. **Skills progress — confirmed:** event `skill-progress` mirroring `install-log`/`install-progress`; exact phases fixed in the M2 skill-repo spec doc. Mockup unchanged. (§7)
7. **Window min size — 1024×680** (default 1200×800); the <1080px stacking breakpoint stands. If the M0 scaffold wrote 960×640, the implementation lane reconciles to this spec — the spec is the contract. (§2)
8. **Light theme — dark-only ships in M1**; tokens stay, light pass moves to M3 polish; demo theme toggle labeled `主题 · M3`. (§1.2)
9. **Shortcuts — cut from v1.** No Ctrl+1/2/3 page shortcuts; `/` kept only as focus-search on the Skills page (guarded against inputs). (§9)
10. **Sample data — noted.** Versions/SHAs/paths/timestamps in the mockup are placeholders; wiring is the implementation lane's job.

**Deploy-page redesign deltas (2026-10) — decisions unchanged, surfaces moved.** (1) 停止/cooperative cancel and (2) pre-validation keep their contracts; they render in the deploy dialog's 安装日志 / 配置 views (§4.6). (3) Drift repair still writes only through plan/execute with no recycle-bin backup; 覆盖重装 now closes only the 漂移详情 dialog and lands on the deploy dialog's 预览 view with 覆盖 ON. (4) Detection stays inform-only; the former 安装目标 checkbox cards are removed from the page, detection surfaces on the deploy page's fixed-location lines, and the tab-bar/status-line dot reports **deployment** status (files deployed), not detection. (5) The dsh detection payload renders in the sidebar env card, the fixed 安装位置/部署位置 lines (page scope bar + dialog), and the dsh preset summary. (7) Window min size 1024×680 unchanged; the <1080px stacking breakpoint is obsolete (single fluid column). References in earlier sections to former §4.1/§4.3–§4.5 resolve to §4.1/§4.6. (9) **2026-10 detail-page pass, layout delta:** the deploy page's content column is **full-fluid** — the former single-column `max-width: 900px` cap is removed (roster `.dep-wrap` and the detail view alike; the detail view's 返回 clip-boundary compensation keeps its −18/+18 margin/padding pair), so the deploy content follows the window width; the **Skills / Settings columns keep their narrower caps** (760–1080px).

**2026-10 十次修订 — 健康检查/漂移 UI 移除（待需要时再加回）。** The health-check/drift feature surface is removed from the UI: the toolbar 健康检查 entry (§4.5 — deployed state shows **更新** only), the deploy dialog's 健康检查 step (§4.6 — steps are 配置 / 预览 / 安装日志), the tier cards + drift list (§3.10/§3.11, texts retained above as re-add reference), the 漂移详情 dialog and the 覆盖重装 drift-repair flow (§10.3 decision history above is retained verbatim). No use case emerged; re-add the surface with its original contract if a need re-emerges. **Backend unchanged:** the `check_drift` Tauri command and engine stay (§7 row annotated, not deleted). **Unaffected:** `validate_custom_source` (§10.2) and its pre-validation UI/flow are a separate feature and keep their §8 copy; `DriftReport`/`DriftFile`/`Tier1Report`/`Tier2*` contract types remain in `ui/src/lib/ipc.ts` for it.
