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
| `--warn` (+`-tint`,`-border`) | `#f0b429` | Caution: overwrite-badge, drift, local-modified, Tier-2-skip |
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
- **Shell:** left sidebar 232px fixed + main content. Sidebar: brand (28px gradient tile + name), 3 nav items (部署 / 技能 / 设置)， footer **environment card** (内置源 version, Node, opencode, dsh — fed by `detect_environment`, the always-visible detection surface).
- **Nav item:** 36px tall, icon + label + right meta slot; active = raised bg + 3px accent bar on the sidebar edge + accent icon. `aria-current="page"`.
- **Deploy page** is a 2-column workspace: config column 384px (scrolls) + preview panel (fluid, fills height). Below 1080px width the columns stack (config first).
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
Inset track + raised active segment. Used for preview panel tabs (预览 / 安装日志 / 健康检查), the demo panel, and the Deploy 安装方式 scope toggle (目录级安装 / 用户级安装 — a two-line variant: icon + label + subtitle, same tokens, §4.1; two buttons with `aria-pressed` in a labelled group, §9). The 日志 segment gains a pulsing cyan dot while installing.

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
- **Terminal report card** (in-flow at log end): success = green card, title 安装完成 + count chips + 用时 + secondary action 运行健康检查； failure = red card, title 安装失败 + mono error line + actions 重试安装 / 导出日志(disabled); **cancelled = amber card, title 安装已取消， chips `第 {n} 个文件后停止` + `已写入的文件保留`, action 重试安装**. Progress bar freezes at its last width on cancel (shimmer stops), stays green/red on success/failure.

### 3.10 Tier cards (health check)
Header: title + right status badge (通过 green / 2 处漂移 amber / 已跳过 amber-info / 失败 red). The title doubles as the availability note: **结构检查（始终可用）** / **执行状态检查（需要本地 Node）**. Body = check rows (icon + zh text + mono detail). Footer = one-line semantics.
**执行状态检查 skipped state:** full-width amber note inside the card: title **“执行状态检查已跳过：未检测到 Node”**, body “安装本地 Node 后点击「重新检查」。”; footer states “缺失 Node 不会阻塞安装。”.

### 3.11 Drift list
Section title + count chip `N 个文件与渲染期望不一致`; rows = warn file icon + mono path (dir muted) + one-line reason (byte/size delta) + 查看详情 button → drift dialog: 期望（渲染结果） vs 本地文件 two mono panes with green/red diff lines + footer 关闭 / **覆盖重装** (primary) with the warning copy 「将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。」 Choosing 覆盖重装 closes the dialog and routes into the **normal preview flow** with the 覆盖 toggle forced ON (an amber `覆盖已开启` badge appears in the preview panel header) and regenerates the plan — the write itself happens only through `execute_install`; there is no ad-hoc write and no recycle-bin backup (locked). Diff view unchanged.

### 3.12 Banners (`.bn`)
info(cyan) / warn(amber) / err(red) / ok(green) / mut(neutral). Icon + title 12.5/600 + body 11.5 + optional right actions. Used for: Tier-2 pre-validation (checking/pass/blocked), rate-limit warning, offline notice.

### 3.13 Dialog (`.dlg`)
520px (640 for diff), radius 12, shadow-3, header (30px tinted icon square + 15px title + close) / body (12.5, `--text-2`, forms & lists) / footer right-aligned buttons. Open = backdrop blur-fade + panel rise; Esc and backdrop click close; focus moves in on open and returns to the invoker on close. Dialogs in scope: 添加/编辑技能源 · 检测到本地修改 · 删除技能 · 漂移详情 · 删除技能源.

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

## 4. Area 1 — 部署

### 4.1 Config column (top → bottom)
1. **内容源** — radio cards: 内置源 (accent version chip `v1.4.2`, “随应用打包”) / 本地源 (“选择包含 agents/ 的目录”). Local reveals: path input + 浏览… + validation hint — valid (green): `agents/ 树有效 · 检测到 6 个后端 · dsh 插件结构完整`; invalid (red): `未找到 agents/ 目录 — 请选择包含 agents/ 的上层目录` (blocks 生成预览).
2. **安装方式** — [变更] one card merging the former 安装位置 + 选项 blocks, top → bottom:
   - **Scope segmented control** (`.seg`, two-line variant): **目录级安装** (icon, subtitle `安装到项目目录`; default) / **用户级安装** (icon, subtitle `安装到用户配置目录`). Two buttons with `aria-pressed` inside a labelled group (§9). Maps 1:1 to the `userLevel` Selection field; switching scope invalidates the preview (§4.2). Only opencode / omos / claude follow this toggle — zcode / dsh / openbitfun are always user-level and unaffected by it.
   - 目录级安装 → project directory input + 浏览… + hint `项目目录 = opencode / claude 项目级安装根目录`; 用户级安装 → the picker is hidden and the hint swaps to `安装到用户配置目录而非项目目录`. `projectDir` is still sent in the Selection while 用户级安装 is on (the backend ignores it for user-level targets).
   - **覆盖已存在文件** switch (off; amber consequence hint when on) — moved from the former 选项 card, behavior unchanged.
3. **安装目标** — 2×3 checkbox cards with detection dots (opencode v0.6.3 ✓ / omos 未检测到 / claude ✓ / zcode ✓ / dsh: three states below / openbitfun 未找到配置目录 · 仍可安装) + card-header 重新检测 icon. **Mutual exclusion:** checking opencode disables omos (and vice versa); the disabled card's status line reads `与 opencode 互斥` (amber). Selected count in card header.
   **dsh detection states** (payload: `{home, homeSource:'env'|'default', exists, profile:{name}|null, profilesCount}`):
   - `exists=false` → dot hollow, `未找到 DSH 主目录 · 仍可安装`
   - `profile=null && profilesCount>1` → dot green, `未找到唯一 profile（共 {n} 个候选）· 仍可安装`
   - `profile` present → dot green, `profile：{name}`
   - when `homeSource='env'` the card additionally shows a mono chip **`DSH_HOME 已覆盖`** (accent outline). The sidebar env card mirrors the same payload (`dsh profile · {name|未找到|n 候选}`).
   Detection is **inform-only (locked)**: undetected targets stay selectable; prerequisite errors surface at plan/execute time. Footnote under the card grid states mutual exclusion and that 未检测到 targets remain installable.
4. **Pre-validation banner** (only when 本地源 + dsh selected): checking (spinner, `正在预校验本地源…`), pass (green, `预校验通过 · 3 项执行检查`), fail (red, `预校验未通过 · 安装已阻止` + mono reason list + 重新校验). Fail/checking disables 开始安装.

### 4.2 Stale-preview rule
Any config change (source mode/path validity, targets, 安装方式 scope, 覆盖) after a plan exists marks the preview stale: amber strip above the table `选择已更改 — 预览可能过期，请重新生成` and 开始安装 disables until 重新生成. The plan is a pure function of the selection — never install from a stale plan.

### 4.3 Preview states
Empty (default) → ready (table) → stale → (regenerate). With 覆盖 on, existing-file rows re-plan from 跳过 → 覆盖 (content-identical rows stay skipped); with 用户级 on, opencode/claude/zcode path prefixes swap to `~\.config\opencode\` / `~\.claude\` / `~\.zcode\`. Both transitions are shown live in the mockup.

### 4.4 Install flow
开始安装 → switches to 安装日志 tab → live bar + progress + streaming timestamped lines → terminal state: success report (counts from the plan + 用时) or failure report (mono error + 未写入任何文件 when blocked pre-write). During run, 开始安装 disabled and the **停止** button is enabled in the log header. **Cancellation is cooperative (locked):** 停止 invokes `cancel_install`; the backend stops before starting the next file, never mid-file; `execute_install` returns a report flagged `cancelled: true` with completed counts, rendered as the amber 已取消 report (§3.9). The mockup simulates this via 停止 during 运行中 and the 已取消 demo state.

### 4.5 Health check tab
Context line (`检查对象：内置源 v1.4.2 → D:\dev\acme-web · 上次检查 2 分钟前`) + 重新检查. Two tier cards (§3.10) side by side, then the drift list (§3.11; hides to a single “无漂移” line when clean). 执行状态检查 has three states in the demo: 通过 / 已跳过 (no Node) / 失败 (per-check reasons).

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

### Deploy (M1 — locks per PLAN.md)
| UI | Command | Notes |
| --- | --- | --- |
| App start; sidebar env card; 安装目标 ⭯; target dots | `detect_environment` | Returns per-target presence/version, Node presence/version, dsh home. Never blocks; results render as dots + text. |
| 生成预览 (header, empty state, stale strip, ↻) | `plan_install(selection, opts)` | Pure; returns per-file create/skip/overwrite/managed-block. Frontend must re-invoke on any selection change (stale rule §4.2). |
| 开始安装 | `execute_install(plan, opts)` | Events `install-log` (line: time/target/level/text) and `install-progress` (phase/count/percent) → log viewer + progress + live bar; final report from the command's return value. On cancel the report is flagged `cancelled: true` with completed counts. |
| 停止 (log header, running only) | `cancel_install` | Cooperative cancellation (locked): stops before starting the next file, never mid-file; already-written files are kept. UI renders the 已取消 terminal state (§3.9). |
| 健康检查 重新检查； post-install 运行健康检查 | `check_drift(source, dir)` | Tier 1 always; Tier 2 via local Node → pass / **skip-with-notice** / fail. Drift list from byte-compare results. |
| Pre-validation banner (本地源 + DSH) | `validate_custom_source(source_dir)` (locked — dedicated command, **not** a `check_drift` flag) | Returns `{tier1, tier2 \| skipped-notice, problems[]}`; blocks `execute_install` until it passes. UI states unchanged: checking / pass / fail-with-reasons. |

### Skills (M2 — proposed IPC shape)
`list_sources` · `add_source({repo, ref?, subdir?})` · `update_source` · `remove_source` · `list_skills({source?, cache_ok})` · `refresh_skills` (network, respects rate limit) · `install_skill({name, source})` · `update_skills({scope: 'all'|names, force, backup})` → progress events (`skill-progress`, confirmed — mirrors `install-log`/`install-progress`; exact phases fixed in the M2 skill-repo spec doc) · `delete_skill({name, trash})` · `set_pat` / `clear_pat` / `pat_status` (OS keyring; token value never round-trips to the UI).

## 8. Copy list (zh — authoritative strings)

> **Copy rule (2026-09 sweep):** UI copy carries no command names, no CLI flags
> and no mechanism explanations. Internal tier vocabulary survives only as the
> zh labels 结构检查 / 执行状态检查. What surfaces from the backend (log lines,
> warnings, detection details) is short zh status + counts + paths + recovery
> hints. `[新增]` / `[变更]` / `[移除]` mark deltas from the previous list.

**Global:** 部署 / 技能 / 设置 · 生成预览 · 开始安装 · 浏览… · 取消 · 保存 · 删除 · 刷新 · 查看详情 · 重新生成 · 重新检查 · 重新校验 · 关闭 · 稍后 · 计划于 M3 提供。 **[新增]** 窗口控制（无障碍标签，非可见文案）：最小化 / 最大化 / 还原（随窗口状态切换）/ 关闭。

**Deploy:** 内容源； 内置源 / **[变更]** 随应用打包（移除「经发布流水线预校验」）； 本地源 / 选择包含 agents/ 的目录（维护者工作流）； agents/ 树有效 · 检测到 6 个后端 · dsh 插件结构完整； 未找到 agents/ 目录 — 请选择包含 agents/ 的上层目录； 安装方式（合并原 安装位置 + 选项 两块为一卡）； 项目目录 = opencode / claude 项目级安装根目录； 安装目标； 已选 N 个； 与 opencode 互斥； 未找到 DSH 主目录 · 仍可安装； **[变更]** 未找到唯一 profile（共 {n} 个候选）· 仍可安装（移除「补丁行将跳过并打印说明」尾注）； profile：{name}； DSH_HOME 已覆盖； dsh profile（侧栏环境卡标签）； 未找到配置目录 · 仍可安装； **[变更]** opencode 与 omos 为同一运行时的两种宿主形态，互斥；未检测到仍可安装。（移除「点状态圆点表示环境检测结果」半句）； 目录级安装 / 安装到项目目录； 用户级安装 / 安装到用户配置目录； **[变更]** 用户级提示：安装到用户配置目录而非项目目录（移除「（等效 CLI --user）」尾注）； 覆盖已存在文件 / **[变更]** 默认跳过已存在的文件（移除「（等效 CLI --force）」尾注）/ 已开启 — 已存在的文件将被直接覆盖，请确认； 先选择目标生成预览； **[变更]** 在左侧勾选安装目标，然后点击「生成预览」。预览不会写入任何文件。（移除「预览由 plan 命令生成」）； 选择已更改 — 预览可能过期，请重新生成； 预览不会写入任何文件； 新建 · 跳过 · 覆盖 · 受管块； `{X} 新建 · {Y} 跳过 · {Z} 覆盖 · {N} 受管块 · 共 {M} 个文件`； 生成于 {hh:mm:ss}； **[变更]** 预览面板元信息：{项目级|用户级} · 0 写入（移除 plan_install 前缀）； 安装日志； 未开始 / 运行中 / 已完成 / 已失败 / 已取消； 停止（tooltip：协作取消：将在当前文件写完后停止（已写入的文件保留））； 安装已取消； 第 {n} 个文件后停止； 已写入的文件保留； 自动滚动； 回到底部； 正在安装 {target} · {i}/{n} · {p}%； 安装完成 / 安装失败； 安装已中止 · 未写入任何文件； 重试安装； 运行健康检查； 健康检查； 检查对象：…； **[新增]** 日志目标标签 系统（引擎/版本标记行的来源标签，替代 core）； 渲染字节对比 11 / 11 一致； **[变更]** 结构检查（始终可用）— 卡题（移除 TIER 1 徽标与「纯 Rust · 始终可用」副行）； **[变更]** 结构检查全部通过 · 槽位与源结构完整； **[变更]** 执行状态检查（需要本地 Node）— 卡题（移除 TIER 2 徽标）； **[变更]** 执行检查通过 · 3 项（移除 node --check 与模块导入验证 注记）； **[变更]** 本地 Node v22.14.0 · 全部执行检查通过。（移除「与 CLI assemble --check 同语义」）； **[变更]** 执行状态检查已跳过：未检测到 Node（原「Tier 2 已跳过：未检测到 Node」）； **[新增]** 安装本地 Node 后点击「重新检查」。； **[新增]** 3 项执行检查未执行； **[新增]** 缺失 Node 不会阻塞安装。； **[移除]** 「此项从不静默通过」「缺失 Node 不会阻塞安装，也不会静默通过（锁定行为）」； 漂移报告； {N} 个文件与渲染期望不一致； 本地与渲染期望不一致； 漂移详情； 期望（渲染结果）/ 本地文件； 覆盖重装； 覆盖已开启； **[变更]** 将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。（移除「与 CLI --force 语义一致」尾句）； 已开启覆盖模式并重新生成预览（toast 标题）； **[变更]** 请确认预览后点击「开始安装」（toast 副行，移除「与 CLI --force 语义一致」）； **[变更]** 正在预校验本地源…（移除「（Tier 2 · DSH 渲染产物）」）； 本地源 + DSH 目标：安装前必须先通过执行状态检查。； 预校验通过 · 3 项执行检查； **[变更]** 本地源渲染的 DSH 工件通过全部执行检查 — 可以开始安装。； 预校验未通过 · 安装已阻止； **[变更]** 本地源需先通过预校验：（原「自定义源未经发布流水线校验，必须先通过 Tier 2」）； **[新增]** 预校验暂不可用。（预校验通道降级文案）。

**Skills:** 从 GitHub 仓库安装与管理技能 · 安装位置 ~\.agents\skills\; 全部更新； 添加源； 技能源； {n} 个源 · 公开 {n} · 私有 {n}; 点击按该源筛选； 编辑源 / 删除源； 仓库 / owner/repo; 分支 / Ref（可选）； 技能子目录（可选）skills/; 私有仓库将使用已配置的 GitHub PAT（设置 → GitHub 访问）。公开仓库无需认证。； 移除源； 已安装的技能不受影响，仅解除关联（无法再更新）。； 搜索技能…; 列表缓存于 {n} 分钟前 · 上次刷新 {hh:mm}; 刚刚刷新； GitHub API 限额提醒 / 未认证限额 60 次/小时，即将用尽。配置 PAT 后提升至 5,000 次/小时。/ 前往设置； 离线 — 无法连接 GitHub / 当前显示本地清单，安装与更新不可用；删除与查看不受影响。恢复网络后点击刷新。； 离线 · 显示本地清单（{n} 个技能）； 未安装 / 已安装 · 最新 / 有本地修改 / 可更新； 安装 / 更新 / 重装； 全部更新； 没有匹配的技能 / 清除筛选； 检测到本地修改； **[变更]** 技能 {name} 的以下文件自安装后被修改过：（移除「（与安装时哈希快照不符）」）； 已修改的文件 · {n}; 强制更新将丢失这些修改。选择「备份后强制更新」会先把当前目录完整备份，再应用远端最新版本。； 备份位置：~\.agents\skills\.backups\{skill}-{timestamp}\; 备份后强制更新； 删除技能； 将从 ~\.agents\skills\ 移除 {name} 及其清单条目。此操作不可撤销（除非勾选备份）。； 备份到回收站（删除前复制整个技能目录到系统回收站）； 离线状态：安装与更新不可用； **[变更]** 已保存源 {repo} · 技能源已刷新（toast 副行，原「list_sources 已刷新」）。

**Settings:** 技能存储； 技能根目录； **[变更]** 技能安装位置。默认 ~\.agents\skills\。（移除「（ZCode 与 npx skills 生态均读取此布局）」）； 技能清单存储于 <root>\.workbench-skills.json。**[变更]**（移除「· 记录来源仓库、ref、commit SHA、安装时间与逐文件哈希快照」）； 打开技能目录； 恢复默认； GitHub 访问； GitHub PAT（个人访问令牌）； 公开仓库无需令牌；私有仓库读取需要 repo 权限的 PAT。； **[变更]** 已存入系统钥匙串 · 保存后不再显示完整令牌。（移除「绝不以明文写入磁盘」）； 配置 PAT 后，GitHub API 限额由 60 次/小时（未认证）提升至 5,000 次/小时。； 更新 / 清除； 通用； 界面语言； English（计划于 M3）; 日志导出； **[移除]** 与 npm 包同标签发布，应始终一致。； 关于； My Workbench 桌面版； 版本 {v} (stable) · Tauri 2; 内置 agents 源版本； 与 npm 版本一致 / 与 npm 版本不一致； 源代码仓库； 检查更新。

## 9. Accessibility

- Full keyboard path: nav → config controls → 生成预览/开始安装 → panel tabs → table (native focusable scroll region) / log → dialogs. Radio cards respond to Space/Enter; switches are `role="switch"`; target checkboxes are real inputs (visually hidden); chips are buttons.
- `aria-current` on nav; `role="tablist"/tab/tabpanel` on the preview panel; `role="log"` + `aria-live="polite"` on the log viewer (report card is the polite announcement; individual lines are not each announced); `aria-modal` + label on dialogs; toasts container `aria-live="polite"`.
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
