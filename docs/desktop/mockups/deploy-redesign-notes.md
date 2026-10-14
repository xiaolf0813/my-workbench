# Deploy page redesign — implementation notes (v2, 2026-10)

Companion to `app.html` (visual contract) and `SPEC.md` §3.19–§3.24 / §4 (v2).
Scope: redesign of Area 1 (部署) only — the skills/settings areas and the shell
are untouched. Design artifacts only; nothing in `ui/`, `src-tauri/`, `crates/`
was modified for this redesign.

## 1. What changed, in one screen

- The page is now organized **per backend target**: `opencode / claude / zcode / dsh`
  pill tabs switch the whole main view (wireframe top row).
- **Realm scope bar** under the tabs: `项目级/用户级` + project dir for
  opencode/claude only; zcode (`~\.zcode`) and dsh (`DSH_HOME → …`) render a
  fixed-location line instead. App-wide persisted, shared with the dialog.
- Deployed targets show an **agent card list** (name, model chip, reasoning chip,
  file path, 2-line mono prompt preview). Click a card → the **detail page** — a
  full-page view that replaces the whole deploy page, header row included (部署
  title / subtitle / 更新 give way; the detail's 返回 + name header is
  the title): 返回 back row + mono name only, then the mono textarea +
  model/reasoning selects + 保存.
  This is the wireframe's big card, annotated 「点击打开提示词详情，可编辑、保存」.
- Header actions are contextual: not deployed → `部署`; deployed → `更新`
  (primary, presets 覆盖 ON in the dialog). **[变更 2026-10 十次修订：原二级操作
  健康检查 随健康检查 UI 一并移除 — SPEC §10 尾注]**
- The whole former deploy workspace (内容源 / 安装位置 / 覆盖 / plan preview /
  streaming log) moves **unchanged in behavior** into the
  target-scoped **deploy dialog** (`#dlg-deploy`, 720px), opened by 部署/更新.
- dsh has no per-agent files: its deployed state is a **preset summary** empty
  state (预设 / 主目录 / profile / 部署文件 / 部署时间) — no cards, no detail page.

## 2. Component breakdown — mockup → `ui/src`

| Mockup piece | New/changed `ui/src` files | Notes |
| --- | --- | --- |
| Page frame (header + tabs + scope bar + body switch) | `ui/src/pages/DeployPage.tsx` (rewrite) | Drops the 2-col `.dgrid`; renders `BackendTabs`, `ScopeBar`, and the per-state body. Header actions switch on target state. Keep `data-tauri-drag-region` on the header and `.ph-actions` `padding-right:150px` (win-ctl clearance). |
| Backend tab bar | new `ui/src/pages/deploy/BackendTabs.tsx` | `role=tablist/tab`, `aria-selected`, `aria-controls`, ArrowLeft/Right; `aria-label` `{target}（已部署|未部署）`; status line as sibling. |
| Realm scope bar | new `ui/src/pages/deploy/ScopeBar.tsx` | Reuses `Switch`-free compact `.seg` + `.path-in`; zcode/dsh fixed-location variants. |
| Agent card | new `ui/src/pages/deploy/AgentCard.tsx` | Plain navigation `<button>` (no `aria-expanded` — the list is not visible while a detail page is open); mono name, `.achip` chips, path line, 2-line clamp preview. |
| Detail page (v2.1, 2026-10) | `ui/src/pages/deploy/AgentDetailPage.tsx` (reworked from the former `AgentDetailEditor.tsx`, now deleted) | Full-page view replacing the deploy page **including its header row** (the 部署 header is roster-view only; the wrap gets 20px top clearance for the floating win-ctl strip, §3.18): page-level title row — 返回 back button (ghost + arrow-left icon, focus on open, the page's title; glyph flush-left with the textarea frame — negative-margin technique with a matching clip-boundary shift so the hover/focus pill paints unclipped) + mono name only — then a **chromeless editor column** directly on the page background (no outer frame; description / read-only chips / file path trimmed from the title area, path stays on the roster cards; rows left-align with the title row, footer keeps its hairline top; **only the textarea keeps its own frame**): two inline field groups (label left of its select, one row; labels from backend) + the textarea, dirty tracking, 还原/保存, status dot+word (`aria-live=polite`), saving spinner, save-error line. The column **fills the remaining viewport height** (textarea flexes between field row and bottom-pinned footer, scrolling internally; 230px floor + page-scroll fallback on very short windows). The ✕ close is retired; 返回 is guarded. |
| Empty states (not-deployed / dsh preset) | new `ui/src/pages/deploy/DeployEmptyStates.tsx` | `.empty` anatomy; primary CTA on not-deployed. |
| Deploy dialog | new `ui/src/pages/deploy/DeployDialog.tsx` wrapping (mostly) the existing `deploy/PreviewPanel.tsx` | The dialog header + `.seg` step tabs replace the panel header; the existing preview/log panes port nearly as-is, minus plan filter chips (scoped plans are small). Config pane = former config column cards flattened into `.dpane#dp-config`. **[变更 2026-10 十次修订：原 健康检查 pane 及 DriftDialog 映射行移除 — 健康检查/漂移 UI 待需要时再加回（后端 `check_drift` 保留），见 SPEC §10 尾注]** |
| Logic/helpers | `ui/src/pages/deploy/logic.ts` (extend) | Add: `reasoningLabel(target)` (变体/推理强度/思考等级), status derivation from overview, scoped plan formatting. Remove nothing used by the dialog. |
| IPC | `ui/src/lib/ipc.ts` — **already extended (uncommitted, other lane)** | `deployedOverview({projectDir,userLevel}) → DeployedTargetState[]` (`{target,deployed,scopeLabel}`), `deployedListAgents({target,…}) → DeployedAgent[]` (`{name,description,fileName,body,settings}`), `deployedSaveAgent({target,…,fileName,body,settings})`. Settings keys per backend (verified in `crates/workbench-core/src/preserve.rs`): opencode `model`+`variant`, claude `model`+`effort`, zcode `model`+`thoughtLevel`; every key present, `null` = key absent. |
| Styles | `ui/src/index.css` | Port the new blocks from `app.html`: `.dep-*` (wrap/toolbar/scope), `.tabs/.tb`, `.agc*`, `.achip`, `.edt*`, `.preset/.pr-row`, `.dlg-dep/.dlg-tabrow/.dpane/.dsec-t`, `.dot.warn/.dot.err`; delete the retired `.dgrid/.dcol`, `.tck/.tgrid/.tbox/…` target-card block, `.seg-scope*`, `.panel/.panel-h/.panel-hr/.pane` (keep `.envchip` — used by the dsh location line). |

## 3. Page state machine (per selected target)

```
target tab (opencode|claude|zcode|dsh)
  └─ depStatus: loading → notDeployed | deployed | error
       loading     = deployedOverview in flight → status line 「正在读取部署状态…」(off dot)
       notDeployed = overview.deployed === false → empty state + 部署 CTA
       deployed    = agent targets: roster(list_deployed_agents) → cards
                     dsh: preset summary (list_deployed_agents is not called)
       error       = read failed → error banner in body + 重试 (see §5)
  └─ openAgent: name|null   (detail page open; implies the whole content area —
                             tab bar, scope bar, card list — is replaced, §3.22)
  └─ dirty: `${target}/${agent}` → bool   (unsaved guard input)
```

- View state per target: roster (default) ↔ detail page. 返回 routes back to the
  roster in the same tab + scope (focus returns to the originating card); the
  detail page renders exactly where the former below-list editor rendered —
  deployed target whose roster is loading-with-cache or loaded non-empty — so
  the roster-error / empty / not-deployed / overview-loading bodies still own
  the screen when they occur. The detail page also suppresses the deploy
  page-head row (title/subtitle/更新): its own 返回 + name header is
  the title, and with the header gone the page's `data-tauri-drag-region`
  surface is gone for that view (the sidebar brand row still drags); the
  window TitleBar is unaffected.
- Tab switch: if the current detail page is dirty → guard dialog first; then
  switch (and close the deploy dialog if open — it is scoped to the previous
  target). The per-target openAgent survives tab switches, like the mockup.
- Scope (`userLevel`, `projectDir`) is app-wide state (module-level store or
  context), persisted (recommend `localStorage` under one key, restored at boot)
  and shared by ScopeBar and DeployDialog. Changing it refreshes the overview.
- Deployment status comes from `deployed_overview`, **not** detection
  (SPEC §10 delta). Refresh it after a dialog run completes and after 保存.

## 4. Dialog state machine (`DeployDialog`)

```
open(from: 'deploy'|'update', view?: 'config'|'preview'|'log')
  from==='update' → force=true (覆盖 preset ON → badge + amber hint)
view: config ──生成预览──▶ preview ──开始安装──▶ log ──done──▶ report(ok|err|cancel)
        ▲                    │ 重新生成
        └────── tab clicks ──┘
```

> 2026-10 十次修订: the former `health` view (post-install 运行健康检查 →
> tier cards → 查看详情 → 漂移详情 dialog → 覆盖重装 → force ON → preview) is
> UI-removed pending need (SPEC §10 tail note); the backend `check_drift`
> command stays.

- Gating (same semantics as before): 开始安装 enabled only when
  `plan && !stale && run!=='running' && !localInvalid && !prevalBlocking`;
  disabled reasons keep the existing tooltips (先生成预览 / 选择已更改… / 正在预校验本地源… / 预校验未通过…).
- Scope controls in the dialog and the page scope bar mutate the same store;
  any change marks a held plan stale (SPEC §4.2).
- Closing the dialog mid-run must NOT cancel the run (IPC continues; state
  lives above the dialog). Reopening shows the current log/progress state.
- Dialog content is always scoped to the selected target: `plan_install` gets a
  single-target `Selection`; the log keeps the existing `install-log` /
  `install-progress` channels (filter by target tag if needed).

## 5. Edge cases the implementation must cover

> 2026-10 十四次修订: 保存按钮与底部分割线移除 — 模型/思考等级 onChange 即时写入（失败 toast + 回退显示值）；详情页不再有未保存状态，守卫对话框退出详情页（DeployPage 守卫机制保留为惰性，不再有写入方）。

> 2026-10 十三次修订: 详情页页脚仅保留 保存 — 状态行（与部署一致/未保存的更改/已保存·/保存失败—）与 还原 移除；保存失败经 toast；未保存守卫仍作用于模型设置修改。

> 2026-10 十二次修订: 提示词正文 textarea 改为只读 — 应用部署提示词而不管理提示词；正文随部署更新（focus 全选便于复制），仅模型设置可编辑，保存/还原/未保存守卫仅作用于设置（保存仍携带未变更的正文字节）。

> 2026-10 九次修订: 部署/更新 moved from the page header (`ph-actions`, rule retired) into the deploy toolbar's `.dep-acts` (right of the status line) — per-backend actions belong to the selected backend's row. Guarded dialog invocation unchanged (`openDeploy` entry point); the not-deployed empty state keeps its own 部署 CTA. **[十次修订]** the deployed-state 健康检查 action is removed (SPEC §10 tail note) — `.dep-acts` shows 更新 only when deployed.

1. **Loading** — overview in flight: tabs render, status line shows `正在读取部署状态…`
   with a hollow dot; body shows nothing else (no flash of the empty state).
   Roster in flight (after a deployed tab is chosen): skeleton or spinner line
   above the card list; cards must not pop in unclamped. If a detail page is
   open it stays put (draft preserved) — the roster body only re-appears via 返回.
2. **IPC unavailable / error** — overview failure: body shows an error banner
   (`bn.err`): 「部署状态读取失败 — {原因}」 + 重试 button; tabs stay usable.
   Roster failure: error banner inside the deployed body + 重试. Never render the
   not-deployed empty state from an *error* — that would invite a destructive
  -looking 部署 on a possibly-deployed target.
3. **Empty roster** — `deployed=true` but `deployed_list_agents` returns `[]`:
   show a distinct empty state 「未找到已部署的智能体文件 / 目标已标记为部署，但没有可显示的智能体文件。点击「更新」重新部署。」 — not the generic not-deployed state.
4. **Partial deployment** — do not attempt to infer partiality on the page; the
   更新 dialog's plan (创建/跳过/覆盖 counts) is the repair surface. Cards list
   whatever files exist.
5. **Save errors** — `deployed_save_agent` failure: the detail page stays open and dirty,
   status line switches to err dot + 「保存失败 — {原因}」, 保存 re-enabled (retry).
   Toast `err` with the reason. Never close the page on failure.
6. **Unsaved-changes guard** — one guard function wraps every detail-page exit:
   返回， switching backend tab, and switching nav pages (guard at App level too).
   Dialog invocation from the header is also an exit path — decide: guard it as
   well (recommended, cheapest correct default). Clicking another card is no
   longer an exit path (the list is replaced while a detail page is open).
   放弃更改 clears that agent's dirty flag and proceeds; Esc/backdrop on the
   guard dialog = 取消.
7. **Save/write concurrency** — if the file changed on disk since load
   (out-of-band edit), the save command is the authority; on failure surface the
   reason. A cheap improvement: re-read the agent after save and diff body.
8. **Settings `null` values** — a backend key absent from frontmatter arrives as
   `null`: editor shows an empty select state (placeholder 「未设置」); saving a
   value writes the key, saving while 未设置 removes the key lines (matches
   `deployed.rs` splice semantics).
9. **dsh guards** — no detail page, no cards; 目标状态 demo 「详情」 is inert for dsh;
   header still offers 更新 (preset summary).
10. **zcode/dsh scope** — scope seg is hidden, never shown disabled; location
    line renders the resolved root (dsh payload mirrors §10.5).
11. **Run/report to page refresh** — after a successful run in the dialog,
    re-query `deployed_overview` so tab dots/status lines update (the run may
    have *deployed* the currently-open tab).
12. **Window min 1024×680** — single fluid column, **full-fluid (no width cap)** — the former 900px cap was removed in the 2026-10 detail-page pass; the old
    <1080px stacking breakpoint is gone. Dialog 720px fits ≥1024 (max-width 92vw
    fallback already in the contract).

## 6. Requirement → demo-state checklist (app.html 演示控制 panel)

| # | Requirement | Where to see it in the mockup |
| --- | --- | --- |
| 1 | Sidebar keeps 3-item nav, 部署 active | Static shell; nav 部署 highlighted (always visible). |
| 2 | Backend TAB BAR, one pill per target, selected = filled accent, switches the whole view | Demo row **部署页** → opencode/claude/zcode/dsh (or click the pills). Status dot+word right of the bar changes per tab. |
| 3 | Realm scope 项目级/用户级 + project path (opencode/claude only) | Select 部署页=opencode or claude → row under tabs: seg + path input + 浏览…; flipping 用户级 hides the picker and swaps the hint. |
| 4 | Scope inert/hidden for zcode (~\.zcode) and dsh (DSH_HOME) | 部署页=zcode → `部署位置 ~\.zcode 固定`; 部署页=dsh → `DSH_HOME → D:\dsh · profile dev` (+`DSH_HOME 已覆盖` chip via demo row **dsh 检测**=未找到/多候选/唯一). |
| 5 | Not-deployed state: empty panel + prominent 部署 | Demo **目标状态**=未部署 on any tab (e.g. claude default) → centered empty state with primary 部署. Header shows 部署 primary too. |
| 6 | Deployed state: top-right 更新 (sole action — **[十次修订]** 原 secondary 健康检查 entry removed) | Demo **目标状态**=已部署 → header action 更新. |
| 7 | Agent card list: name, model chip, reasoning chip, 2-line mono preview | 已部署 on opencode/claude/zcode → cards (oracle/glm/high matches the wireframe on zcode; per-backend reasoning chip tooltips: 变体/推理强度/思考等级). |
| 8 | dsh deployed = preset summary empty-state (no cards) + 更新 | 部署页=dsh, 目标状态=已部署 → preset summary card; header 更新. |
| 9 | Click card → full-page detail view; editable body/model/reasoning; 保存; 返回 | 已部署 → click any card (or 目标状态=详情) → the detail page replaces the content area (tab bar + scope bar + list give way); edit the textarea or selects → 「未保存的更改」 appears, 保存 enables; 保存 → toast + 「已保存 · hh:mm:ss」; 返回 goes back to the list (guarded when dirty). |
| 10 | Unsaved-changes guard | With a dirty detail page, click 返回 / switch 部署页 (or leave 部署) → 「放弃未保存的更改？」 dialog (取消 / 放弃更改). |
| 11 | Deploy/update dialog scoped to the selected target | Header 部署 (or empty-state CTA) → dialog `部署 · {target}`; only that target's rows in 预览. |
| 12 | Dialog: 内容源 bundled/local + path | Dialog 配置 pane → 内容源 radios; pick 本地源 → path + validity hints (demo rows **本地源**=有效/无效 and **本地源校验**=不适用/校验中/通过/未通过 for the banner). |
| 13 | Dialog: 用户级 toggle / project dir | Dialog 配置 → 安装位置 seg + path (opencode/claude only); shares state with the page scope bar (flip one, the other follows). |
| 14 | Dialog: 覆盖 switch; plan preview items; stale rule | 配置 → toggle 覆盖 → 预览 rows flip 跳过→覆盖; change any config after generating → amber stale strip + 开始安装 disabled. |
| 15 | 更新 presets 覆盖 ON | Click header **更新** → dialog title `更新 · {target}`, 覆盖 switch already on, amber `覆盖已开启` badge in the tab row. |
| 16 | Streaming install log + cancel button | Demo **部署对话框**=日志 then **安装运行**=运行中 (streams; 停止 works → amber 已取消 report); or **安装运行**=成功/失败/已取消 for the three terminal report cards. |
| 17 | ~~Drift health check entry in the dialog~~ — **[移除 2026-10 十次修订]** 健康检查/漂移 UI removed pending need (SPEC §10 tail note; backend `check_drift` retained) | N/A — the demo rows 部署对话框=健康 / 执行状态检查 / 漂移 and the 漂移详情 dialog were removed from the mockup. |
| 18 | dsh variants | 部署页=dsh × 目标状态=未部署/已部署 (详情 inert), plus **dsh 检测** row driving the location line, sidebar env card and preset summary. |
| 19 | zh copy, no CLI flags/commands | All visible strings; §8 v2 list is the authority. |

First paint of the mockup = the wireframe: zcode tab selected, deployed with
oracle's detail page open (详情 state — the full-page view, tab bar + scope bar
hidden), 更新 top-right.

## 7. Validation performed (design lane)

- `node --check` on the extracted inline script: **passes** (no syntax errors).
- Id audit: all 90 script-referenced ids exist in markup (18 are intentionally
  dynamic: header buttons, editor fields, dialog footer, report actions); no
  duplicate ids.
- **Headless-browser run (Edge `--headless --screenshot`)**: rendered the real
  mockup and screenshot-verified every demo state — default (zcode deployed +
  oracle editor open, matching the wireframe), claude not-deployed, opencode
  deployed (scope bar + 3 cards), dsh deployed (preset summary + location line +
  `DSH_HOME 已覆盖` chip), dialog 配置 (zcode fixed 安装位置, `用户级 · 0 写入`),
  dialog 预览 (target-scoped plan + summary + gated footer), dialog 安装日志
  terminal success (green report + chips + 运行健康检查), dialog 健康检查 with
  drift (amber badges + 2-row drift list + 查看详情), and the 更新 invocation
  (title `更新 · {target}`, `覆盖已开启` badge, 覆盖 switch preset ON with amber
  hint). Two runtime defects were caught by an in-page error trap during this run
  and fixed in the mockup: a missing `TARGETS` constant, and `className` writes
  to the SVG `#t1i1` (SVG className is read-only → now `setAttribute`; the same
  latent bug exists in the pre-redesign contract, so port this pattern).
- Token/spacing consistency re-read against SPEC §1: new CSS uses existing
  variables only (`--bg-surface/-raised/-inset`, `--border/-strong`, `--text-1/2/3`,
  accent/tint/border, `--warn*/--err*`, `--t-*`, `--ease`, `--ring` via the global
  focus rule); radii follow the scale (999 pills, 10 cards, 7 inputs, 6 small
  buttons); spacing stays on the 4px grid (12/14/16 paddings, 8/10/12 gaps);
  no new colors or fonts; reduced-motion global override covers the editor rise.
- Skills / Settings markup, styles, and demo rows untouched (git diff shows
  changes confined to the deploy section, deploy CSS, and deploy JS).
- One polish fix found in the browser run: `.tier-badge` now carries
  `white-space:nowrap` (the `2 处漂移` badge wrapped inside the 720px dialog) —
  include this when porting to `ui/src/index.css`.
