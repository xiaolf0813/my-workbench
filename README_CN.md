[English](README.md) | 简体中文

# my-workbench

可移植的 [OpenCode](https://opencode.ai) + Claude Code + ZCode + ChatGPT / Codex 智能体配置，一条命令即可安装。OpenCode 仅支持项目级安装；Claude Code 支持项目级安装或用 `--user` 安装到用户级；ZCode 与 Codex 恒为用户级。

已停止维护的自研 Tauri 桌面应用保留在 [`desktop`](https://github.com/xiaolf0813/my-workbench/tree/desktop) 分支，`main` 不再维护它。

> 本文件为参考翻译，以[英文版](README.md)为准。

```bash
npx my-workbench
```

`my-workbench` 将一套精心整理的多智能体配置复制到当前项目：

- **`.opencode/`** — OpenCode 核心配置与原生 `.opencode/agents/` 子智能体：十一个智能体 — `orchestrator`、`explorer`、`librarian`、`oracle`、`designer`、`fixer`、`observer`、`spotter`、`driver`、`improver`、`intake`。
- **`.claude/`** — 同一批专家智能体的 Claude Code 原生子智能体形态（`.claude/agents/*.md`）。所有目标中安装内容完全一致。
- **`~/.zcode/`** — 可选的 ZCode 支持（`--zcode`）：用户级全局指令，外加各专家子智能体作为 ZCode 用户级 agents（`~/.zcode/agents/*.md`）。不在项目内写入任何内容。
- **`~/.codex/`** — 可选的本地 ChatGPT / Codex 支持（`--chatgpt` 或 `--codex`）：全局短入口、编排策略、十个原生 TOML 子智能体、方案指南及内置的 **Subagent Config** 插件；支持 `CODEX_HOME`。

orchestrator 提示词还内置一条持久任务队列：`intake` 专家 —— 仅当你明确点名或 @-提及时才被调用 —— 把你的原始输入整理为确认后的任务文件，存入项目的 `.oxbench/` 目录；orchestrator 在完成工作、空闲或被唤醒时展示该队列。你选一条任务执行，或（在带定时器的平台上，即 ZCode）两分钟后自动开始第一条；每条任务都在独立的新会话中执行，且只有 orchestrator 验收通过后才标记为已完成。

## OpenCode 目标

- **`--opencode`（原生）** — 核心配置（`opencode.jsonc`）加原生 `.opencode/agents/*.md` 子智能体。要求已安装 OpenCode（PATH 上有 `opencode`）。不下载任何东西。通用行为规则（`agents/disciplines.md`）在组装时被追加进每个 agent 自己的提示词，因此每个 agent 自带这套纪律，orchestrator 不再把它粘贴进委派简报。

## 用法

```bash
npx my-workbench                    # 安装 .opencode/ 和 .claude/
npx my-workbench --opencode         # 仅 OpenCode 配置
npx my-workbench --claude           # 仅 Claude Code 配置
npx my-workbench --user             # Claude Code 用户级安装：~/.claude/
npx my-workbench --force            # 覆盖已存在的文件
npx my-workbench --dry-run          # 预览，不写入
npx my-workbench --zcode            # 仅 ZCode 用户级安装（~/.zcode）
npx my-workbench assemble [--check] # 本仓库内：重新生成 .claude/agents/ 和 .opencode/
```

除非给出 `--force`，已存在的文件会被跳过，因此重复运行是安全的。`--force` 覆盖前会先快照并还原你的模型设置 —— 即每个 `agents/*.md` 按后端各自的 `model`/`effort`/`variant`/`thoughtLevel` 行 —— 你手动调整的模型指定在升级后依然保留。它部署的两个 JSON 文件是种子桩文件，不是被接管的文件：`--force` 只把桩文件自带的键（`.claude/settings.json` 的 `agent`、`opencode.jsonc` 的 `$schema`，由桩文件内容解析得出）调和进已有文件，其余任何字节都不会被改动。

## 版本管理

每次安装（以及本仓库内的 `assemble`）都会写入一个小的标记文件，记录部署该处的 CLI 版本，**每个部署域（realm）一个**：项目级运行写在项目根目录的 `my-workbench.version`，共享用户级运行（`--user` 或 ZCode）写在 `~/.my-workbench.version`，每个 Codex home 则写在 `<CODEX_HOME>/my-workbench.version`。混合运行会写入所有适用的部署域。该标记每次运行都会无条件刷新，因此始终是当前运行版本。

```bash
npx my-workbench --upgrade   # compare deployed versions with the npm latest
```

`--upgrade` 将所选各域的标记与 npm registry 上的最新版本比较（尊重 `npm_config_registry`，默认为 `https://registry.npmjs.org`）。发现过期的标记时会**自动升级**：以 `npx --yes my-workbench@latest [<targets>] [--user] --force` 重新运行安装 —— 重新部署会覆盖已部署的文件（对升级而言是有意为之），且需要 PATH 上有 `npm`/`npx`。数值上比 registry 最新版本更新的部署不会被改动。仅当运行结束后所有被检查的标记都与最新版本一致时 `--upgrade` 退出码为 `0`；registry 错误、完全找不到标记（请先运行安装）、或重新部署失败时退出码为 `1`。

## 用户级安装

`npx my-workbench --user` 仅将 Claude Code 资产安装到 `~/.claude/`（`settings.json` + `agents/*.md`）。OpenCode 仅支持项目级安装；`--opencode` 与 `--user` 同时使用会报错，搭配 `--upgrade` 时也一样。用户级文件对所有项目生效，不用于版本控制；命名冲突时项目级 agents 优先于用户级。ZCode 与 Codex 恒为用户级，忽略 `--user`。

## ZCode 目标

`npx my-workbench --zcode` 仅在**用户级**安装 ZCode 支持：`~/.zcode/AGENTS.md`（主智能体的全局指令）和 `~/.zcode/agents/*.md`（子智能体）。ZCode 没有可配置的主智能体，也没有项目级子智能体，因此项目内无需安装任何内容。

- 全局文件就是 `agents/prompts/orchestrator.md` — orchestrator 提示词驱动主智能体，其中 ZCode 的派发约定由 `agents/backends/zcode/slots/dispatch.md` 填入。
- 子智能体以 `injectAgentsMd: false` 运行：全局文件不会注入它们，因此每个委派简报必须自带完整上下文。
- 仅按需启用（`--zcode` 或 `zcode`）— 默认目标仍是 `.opencode/` + `.claude/`。不下载任何东西。已存在的文件除非 `--force` 否则跳过。重启 ZCode 会话以生效。

## ChatGPT / Codex 目标

`npx my-workbench --chatgpt`（别名 `--codex`）把原生本地子智能体安装到 **CODEX_HOME**，默认 `~/.codex/`。适用于当前 ChatGPT 桌面程序的本地 Codex 运行时及 Codex CLI；云端聊天和自定义 GPT 不读取这些本地文件。

- 当前生效的全局 AGENTS 文件：`AGENTS.override.md` 含有用户指令时在其中维护一个带标记的加载块，否则维护在 `AGENTS.md`；块外用户内容原样保留。该加载块指向 `my-workbench-orchestrator.md`，避免完整策略挤占 AGENTS.md 自动发现的大小预算。
- `agents/*.toml`：十个原生专家子智能体，使用 `name`、`description`、`developer_instructions`，从同一 roster、提示词和通用纪律组装。默认继承当前会话模型，也可通过已部署 TOML 或 Subagent Config 调整。
- `my-workbench-plugin-marketplace/`：包含 **Subagent Config** 的离线本地 marketplace；插件只编辑已部署子智能体的模型字段。部署通过 `codex plugin` 注册 marketplace 与插件，不直接编辑 Codex 插件状态。
- `my-workbench-solutions/`：每次安装刷新的平台指南。

仅用户级，按需启用，不下载、不写项目文件；要求 PATH 中存在 Node.js 以及支持 `codex plugin` 的 Codex CLI。已有智能体文件默认跳过；`--force` 保留子智能体顶层的 `model`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity` 设置，而当前生效的 AGENTS 加载块、内置 marketplace 与插件运行时每次部署都会刷新。插件注册通过官方 CLI 完成，由该 CLI 管理必要的 `config.toml` 变更；注册失败会恢复部署前的受管文件、`config.toml` 与插件缓存，也不会写入 CODEX_HOME 本地版本戳。成功后需要重启 ChatGPT / Codex。用户设置禁用子智能体时仍可能无法委派。职责指令不会授予工具权限，也不会建立独立沙箱。

格式及发现规则依据 OpenAI 官方文档：[自定义智能体](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。

## 单一来源，组装输出

一切由一棵树 `agents/` 生成：

```
agents/
├── disciplines.md    # 通用纪律，组装时追加到每个 agent 提示词末尾
├── disciplines_cn.md # disciplines.md 的中文参考译文（永不打包）
├── roster.json       # 智能体描述与各后端 frontmatter 的唯一编写处
├── prompts/          # 每个智能体的提示词正文，仅一份（署名声明留在此处，组装时剥离）
├── prompts_cn/       # 中文参考翻译（永不打包）
└── backends/         # 所有后端专属内容；每个后端可带 slots/*.md
                      # （后端专属文本，替换 agents/prompts/ 中的 {{slot:...}} 占位符）
    ├── claude/
    │   ├── settings.json   # 主线程智能体设置
    │   └── slots/          # Claude 专属提示词文本
    ├── opencode/
    │   ├── slots/                # OpenCode 专属提示词文本
    │   └── opencode.jsonc        # 核心配置
    └── zcode/
        └── slots/          # dispatch.md（每个后端都有，不逐一列出）
```

在你的项目中，`.claude/agents/` 和 `.opencode/` 由它组装而来。编辑 `agents/`，然后运行 `npx my-workbench assemble`（`--check` 检测漂移）— 同样的工作流适用于本仓库和任何目标项目。`agents/roster.json` 集中保存描述与各后端 frontmatter，检查会拒绝没有记录的提示词。提示词正文可以引用 `{{slot:<name>}}`；每个后端在 `agents/backends/<backend>/slots/` 中提供对应文本，缺少 slot 会导致组装失败。

## 署名

智能体提示词改编自 [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)（MIT 许可证，© 2025），`improver` 与 `intake` 除外 —— 它们由本项目原创。该声明位于 `agents/prompts/` 下每个改编文件的开头 —— 出处与源码放在一起 —— 组装时会被剥离，因此交付给 agent 的提示词里不含许可证声明。`agents/prompts_cn/` 与 `agents/disciplines_cn.md` 仅供参考，永不打包。

## 许可证

MIT。
