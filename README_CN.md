[English](README.md) | 简体中文

# my-workbench

可移植的 [OpenCode](https://opencode.ai) + Claude Code + ZCode + DeepSeek Harness + OpenBitFun 智能体配置，一条命令安装到你的项目（或用 `--user` 安装到用户级；ZCode、DSH 与 OpenBitFun 恒为用户级）。

> 本文件为参考翻译，以[英文版](README.md)为准。

```bash
npx my-workbench
```

`my-workbench` 将一套精心整理的多智能体配置复制到当前项目：

- **`.opencode/`** — OpenCode 核心配置与原生 `.opencode/agents/` 子智能体：八个专职智能体 — `orchestrator`、`explorer`、`librarian`、`oracle`、`designer`、`fixer`、`observer`、`improver`。在此之上可用独立的 `--omos` 目标启用 [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) 插件方案（简称 **omos**）：多模型议会预设与提示词覆盖。
- **`.claude/`** — 同一批专家智能体的 Claude Code 原生子智能体形态（`.claude/agents/*.md`）。与 omos 无关：所有目标中安装内容完全一致。
- **`~/.zcode/`** — 可选的 ZCode 支持（`--zcode`）：用户级全局指令，外加各专家子智能体作为 ZCode 用户级 agents（`~/.zcode/agents/*.md`）。不在项目内写入任何内容。
- **`~/.dsh/`** — 可选的 DeepSeek Harness 支持（`--dsh`）：在 `<DSH_HOME>/.agent-presets/my-workbench/` 安装一个 agent preset — orchestrator 提示词作为该 preset 的 persona，外加拥有七个具名专家工具与「MyWorkbench 赛道模型」设置页的打包 **lane 插件**。工具在 preset 作用域内；设置页需要一行惰性 profile 行，那是 profile 层的全部足迹。不在项目内写入任何内容。
- **OpenBitFun** — 可选的 OpenBitFun 支持（`--openbitfun`）：把八个 agent 安装到 OpenBitFun 各操作系统用户配置目录下的 `agents/` 中。恒为用户级；不在项目内写入任何内容。

## OpenCode 目标：原生或 omos

OpenCode 支持分为两个独立目标：

- **`--opencode`（原生）** — 核心配置（`opencode.jsonc`）加原生 `.opencode/agents/*.md` 子智能体。要求已安装 OpenCode（PATH 上有 `opencode`）。不下载任何东西。通用行为规则（`agents/disciplines.md`）在组装时被追加进每个 agent 自己的提示词，因此每个 agent 自带这套纪律，orchestrator 不再把它粘贴进委派简报。检测到用户级 omos 安装（`~/.config/opencode`）时，会改为按 omos 方式安装（省略资产、不装原生 agents），以避免智能体冲突。
- **`--omos`（可选插件方案）** — 仅复制 omos 项目资产（oh-my-opencode-slim.jsonc、提示词覆盖、插件 node 依赖）到 `.opencode/`。要求 OpenCode **且**已存在用户级 omos 安装（`~/.config/opencode`）：插件从用户级加载，因此 my-workbench 永不固定 `"plugin"` 条目、永不下载任何东西。不能与 `--opencode` 同时使用。

没有确认流程：显式的 `--omos` 旗标即显式选择；若 omos 尚未安装，前置检查直接快速失败。

## 用法

```bash
npx my-workbench                    # 安装 .opencode/ 和 .claude/
npx my-workbench --opencode         # 仅 OpenCode 配置
npx my-workbench --omos             # 仅 omos 插件方案（无原生 agents）
npx my-workbench --claude           # 仅 Claude Code 配置
npx my-workbench --user             # 用户级安装：~/.config/opencode/ + ~/.claude/
npx my-workbench --force            # 覆盖已存在的文件
npx my-workbench --dry-run          # 预览，不写入
npx my-workbench --zcode            # 仅 ZCode 用户级安装（~/.zcode）
npx my-workbench --dsh              # 仅 DSH agent preset（~/.dsh）
npx my-workbench --openbitfun       # 仅 OpenBitFun 用户级 agents
npx my-workbench assemble [--check] # 本仓库内：重新生成 .claude/agents/ 和 .opencode/
```

除非给出 `--force`，已存在的文件会被跳过，因此重复运行是安全的。

## 版本管理

每次安装（以及本仓库内的 `assemble`）都会写入一个小的标记文件，记录部署该处的 CLI 版本，**每个部署域（realm）一个**：项目级运行写在项目根目录的 `my-workbench.version`，用户级运行（`--user`，或恒为用户级的 ZCode/DSH/OpenBitFun 目标）写在 `~/.my-workbench.version`。混合运行（如 `npx my-workbench --claude --zcode`）会同时写两个。该标记每次运行都会无条件刷新，因此始终是当前运行版本。

```bash
npx my-workbench --upgrade   # compare deployed versions with the npm latest
```

`--upgrade` 将所选各域的标记与 npm registry 上的最新版本比较（尊重 `npm_config_registry`，默认为 `https://registry.npmjs.org`）。发现过期的标记时会**自动升级**：以 `npx --yes my-workbench@latest [<targets>] [--user] --force` 重新运行安装 —— 重新部署会覆盖已部署的文件（对升级而言是有意为之），且需要 PATH 上有 `npm`/`npx`。数值上比 registry 最新版本更新的部署不会被改动。仅当运行结束后所有被检查的标记都与最新版本一致时 `--upgrade` 退出码为 `0`；registry 错误、完全找不到标记（请先运行安装）、或重新部署失败时退出码为 `1`。

## 用户级安装

`npx my-workbench --user` 将同样的资产安装到用户级而非当前项目：OpenCode/omos 资产进入 `~/.config/opencode/`（其 XDG 配置目录；全局 agents 从 `~/.config/opencode/agents/` 读取），Claude Code 资产进入 `~/.claude/`（`settings.json` + `agents/*.md`）。用户级文件对所有项目生效，不用于版本控制；命名冲突时项目级 agents 优先于用户级。ZCode、DSH 与 OpenBitFun 恒为用户级，忽略 `--user`。

## ZCode 目标

`npx my-workbench --zcode` 仅在**用户级**安装 ZCode 支持：`~/.zcode/AGENTS.md`（主智能体的全局指令）和 `~/.zcode/agents/*.md`（子智能体）。ZCode 没有可配置的主智能体，也没有项目级子智能体，因此项目内无需安装任何内容。

- 全局文件就是 `agents/prompts/orchestrator.md` — orchestrator 提示词驱动主智能体，其中 ZCode 的派发约定由 `agents/backends/zcode/slots/dispatch.md` 填入。
- 子智能体以 `injectAgentsMd: false` 运行：全局文件不会注入它们，因此每个委派简报必须自带完整上下文。
- 仅按需启用（`--zcode` 或 `zcode`）— 默认目标仍是 `.opencode/` + `.claude/`。无 omos，不下载任何东西。已存在的文件除非 `--force` 否则跳过。重启 ZCode 会话以生效。

## OpenBitFun 目标

`npx my-workbench --openbitfun` 仅在**用户级**安装 OpenBitFun 支持：把八个 agent 文件（`orchestrator` 加七个专家）安装到 OpenBitFun 各操作系统用户配置目录下的 `agents/` 中。agent 是带 YAML frontmatter 的纯 markdown 文件（`schema_version`/`kind`/`id`/`name`/`description`/`tools`/`readonly`；orchestrator 为 `kind: mode`，专家为 `kind: subagent`），因此项目内无需安装任何内容。

| 操作系统 | 配置目录 |
| --- | --- |
| Linux | `~/.config/openbitfun`（设置 `$XDG_CONFIG_HOME` 时优先） |
| macOS | `~/Library/Application Support/openbitfun` |
| Windows | `%APPDATA%\openbitfun`（回退 `~/AppData/Roaming/openbitfun`） |

- **要求已安装 OpenBitFun**：配置目录不存在时目标拒绝运行 —— 在写入任何内容之前快速失败，并给出三个操作系统各自的预期路径。
- 仅按需启用（`--openbitfun` 或 `openbitfun`）— 默认目标仍是 `.opencode/` + `.claude/`。不下载任何东西，已存在的文件除非 `--force` 否则跳过。
- 重启 OpenBitFun 以生效。

## DSH 目标

`npx my-workbench --dsh` 在用户级安装一个 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) **agent preset**：`<DSH_HOME>/.agent-presets/my-workbench/`（`DSH_HOME`，否则 `~/.dsh`）。DSH 从其 home 读取 presets，因此项目内无需安装任何内容。

- `preset.yml` — preset 选择器中显示的名称与描述。
- `agent.cordis.yml` — 组合文件：orchestrator 提示词作为该 preset 的 persona、完整的标准工具集，以及**一行**指向 lane 插件。
- `lane-plugin/` — preset 挂载的打包插件。它拥有七个专家工具与各自的提示词，因此可以为每条赛道固定模型路由并持久保存。
- `lane-plugin-ui/` — 设置页面，单独打包，由**一行惰性 profile 行**挂载（见下）。这就是 DSH 目标在 profile 层的全部足迹。

**lane 插件目录结构**

```
lane-plugin/                        # preset 行：./lane-plugin/src/index.js
├── package.json                    # 名称 my-workbench-lanes（仅 Host 半，不含浏览器半）
├── src/index.js                    # Host 半：7 个委派工具 + 设置命名空间
├── src/roster.generated.js         # Host 赛道字段，由 dsh/lanes.json 渲染而来
└── src/prompts.generated.js        # 7 条提示词，由 agents/prompts/*.md 渲染而来

lane-plugin-ui/                     # profile 行：file:///…/lane-plugin-ui/src/index.js
├── package.json                    # 名称 my-workbench-lanes-ui，exports "./client"，dsh.client.platform "web"
├── src/index.js                    # 惰性 Host 半：什么都不注册
└── lib/client.js                   # 设置页面，显示标签由 dsh/lanes.json 渲染而来
```

- Host 行的 `name` 是**相对路径**（`./lane-plugin/src/index.js`）：预设行的裸包名解析基准是 host 组合的位置而非 preset 目录，因此随组合一起分发的包无法被找到。
- Host 半的两个部署依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）在**安装时**被解析为绝对 `file:` URL 写入其 `src/index.js`（从你的 DSH home 解析）。因此永远不需要任何依赖安装命令。
- 该插件只能由这一个 preset 引用：它要注册一个设置命名空间，而 DSH 拒绝重复注册，所以第二个 preset 挂载同一行会直接失败。

**为什么必须有一行 profile 行（以及它的代价）**

DSH 发现浏览器（client）插件半的方式是扫描 **profile loader 自己的条目**——agent preset 是挂在某个 scope 下的独立 loader 树，因此 preset 内的行永远不会被扫描，页面不会被下发，`clientModules.clientPath(...)` 始终是 `undefined`。Host 半能正常挂载、设置命名空间也能注册，只有「页面」需要 profile 层。因此 `--dsh` 还会维护 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 中**一个带标记的托管块**，其中只有一行惰性行：

```yaml
# >>> my-workbench lane settings page (managed block - regenerated by `my-workbench --dsh`) >>>
- insert:
    - id: my-workbench-lanes-ui
      name: 'file:///…/.agent-presets/my-workbench/lane-plugin-ui/src/index.js'
# <<< my-workbench lane settings page <<<
```

- 每次运行都**就地替换**该块；你自己的行与注释永远不会被改动或重排。`--dry-run` 不写任何东西。
- 该行是惰性的：`lane-plugin-ui` **完全不声明依赖**，不注册任何工具、提示词段落或服务。不改动任何 bundle 层，也不向任何 `node_modules` 安装东西。
- 页面在 `apply()` 中**同步注册**，由组件自己决定显示什么：`my-workbench-lanes` 命名空间已注册时显示可操作控件，否则显示惰性占位。最初「先 await 门禁再注册」的写法会让 shell 账本里的条目变成 `active: false`（其它分区都是 `active: true`），面板渲染为空白，所以判断移进了组件。
- 因此从未挂载过 MyWorkbench 的部署会看到**一个没有控件、没有写入路径**的导航条目；一旦任何 MyWorkbench 会话挂载过 host 半（命名空间是进程级的），同一个页面在任何会话里都是可用的 —— 它编辑的固定值只被 MyWorkbench 会话消费。
- 组件在每次打开该分区时重新读取命名空间，所以**刷新一次页面**只是为了加载/更新浏览器 bundle。
- **改动 lane 插件的 Host 半需要重启 DSH，只重装不够。** preset 行每个进程只 import 一次 —— Node 的 ESM 缓存，而且 DSH 重挂载 stale 组合时用的仍是**同一个 specifier** —— 所以 `--dsh --force` 之后运行中的进程还是旧代码。更麻烦的是：stale 挂载对设置命名空间的注册**永远不会被释放**（`ensureStanding` 丢弃挂载时没有 dispose 它的 scope），因此"无条件注册"的旧代码会让下一次挂载直接失败：`settings namespace "my-workbench-lanes" is already registered`。现在随包发布的 Host 半会容忍这种重复注册、直接沿用存活的那份注册；这个容忍逻辑在**下次 DSH 重启**后生效。设置页面属于浏览器模块，只需刷新页面。
- 若找不到唯一的 profile 目录，则不会向任何 profile 写入，并会打印出可直接粘贴的行。

**委派与按赛道路由**

- 委派是原生机制。模型调用 `subagent_explorer`、`subagent_librarian`、`subagent_oracle`、`subagent_designer`、`subagent_fixer`、`subagent_observer`、`subagent_improver`，而不是在 Task 工具里填写子智能体类型。赛道默认在后台运行并返回可续用的子 agent id，用 `send_message` 继续它 —— 这正是 orchestrator 提示词中所说的会话句柄。
- 每个工具携带该专家的提示词（由 `agents/prompts/*.md` 渲染），并按其提示词的约束收紧子 agent 的工具：只读赛道失去 `write`/`edit`，`observer` 与 `improver` 还失去 shell，所有赛道都失去委派工具，因此赛道无法再派生子赛道。
- **按赛道固定模型与推理等级。** 打开 DSH Web GUI 的设置页 **MyWorkbench 赛道模型**：每条赛道一行，左侧选模型、右侧选思考级别，另有 应用 / 全部改回继承 / 刷新模型目录。写入落在插件自己的设置命名空间并持久化到 `<DSH_HOME>/settings.yaml`，重启 DSH 后依然有效。全新安装由作为命名空间 `base` 层的推荐映射初始化；把某条赛道留作「继承会话模型」即可沿用当前会话的路由。
- 仅按需启用（`--dsh` 或 `dsh`）— 默认目标仍是 `.opencode/` + `.claude/`。要求已存在 DSH home，不下载任何东西，已存在的文件除非 `--force` 否则跳过。新开一个 DSH 会话即可选用该 preset。

**安装、验证、回滚**

```bash
npx my-workbench --dsh --force        # （重新）写入 ~/.dsh/.agent-presets/my-workbench/
                                      # 以及 ~/.dsh/profiles/web/cordis.patch.yml 中那一个托管行
```

顺序很重要：安装 → **新开一个 DSH 会话**并选用 MyWorkbench preset（这会挂载 lane host 半）→ **刷新 Web 页面**（这会执行页面的门槛检查）→ 确认 `设置 → MyWorkbench 赛道模型` 列出七条赛道。同时确认七个 `subagent_*` 工具都在，且固定某条赛道后其子会话 header 带上所固定的 provider/model/effort。

回滚：从 profile 的 `cordis.patch.yml` 中删除该托管块，**并**删除 `~/.dsh/.agent-presets/my-workbench`。`npx my-workbench --dsh --force` 会把两者都恢复。回滚后可能残留的只有 `~/.dsh/settings.yaml` 里一段惰性的 `my-workbench-lanes:`。

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
    ├── omos/
    │   ├── oh-my-opencode-slim.jsonc       # omos 项目配置
    │   ├── oh-my-opencode-slim/  # 提示词覆盖（<agent>_append.md）
    │   └── package.json          # 插件 node 依赖
    ├── zcode/
    │   └── slots/          # dispatch.md（每个后端都有，不逐一列出）
    ├── openbitfun/
    │   └── slots/          # dispatch.md（orchestrator 提示词内的 {{slot:dispatch}}）
    └── dsh/
        ├── lanes.json        # 赛道 key、工具、标签、权限和默认模型
        ├── agent.cordis.yml  # preset 组合文件；{{prompt:<agent>}} 内嵌 prompts/<agent>.md
        ├── preset.yml        # preset 展示元数据（name/description）
        ├── lane-plugin/      # preset 挂载的 Host 半（设计记录：docs/dsh-lane-plugin/）
        │   └── host-package/          # ESM 插件包：7 个赛道工具 + 设置命名空间
        │       ├── package.json
        │       └── src/index.js       # {{dep:<alias>}} 在安装时解析为 file: URL
        ├── lane-plugin-ui/   # profile 挂载的设置「页面」
        │   ├── package.json           # exports "./client"，dsh.client.platform "web"
        │   ├── src/index.js           # 惰性 Host 半（什么都不注册）
        │   └── lib/client.js          # 带渲染后赛道名册的浏览器半
        └── slots/            # dispatch.md（orchestrator 提示词内的 {{slot:dispatch}}）
```

在你的项目中，`.claude/agents/` 和 `.opencode/` 由它组装而来。编辑 `agents/`，然后运行 `npx my-workbench assemble`（`--check` 检测漂移）— 同样的工作流适用于本仓库和任何目标项目。`agents/roster.json` 集中保存描述与各后端 frontmatter，检查会拒绝没有记录的提示词。提示词正文可以引用 `{{slot:<name>}}`；每个后端在 `agents/backends/<backend>/slots/` 中提供对应文本，缺少 slot 会导致组装失败。DSH 组合文件用 `{{prompt:<agent>}}` 嵌入提示词；`agents/backends/dsh/lanes.json` 驱动安装后的赛道提示词模块、host 名册和设置页面标签。`assemble --check` 会渲染这些内容及八个 OpenBitFun agents，检查页面包的 `dsh.client`/`./client` 声明和浏览器导入，并验证惰性 host 半可导入且不注册任何内容。

## 署名

智能体提示词改编自 [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)（MIT 许可证，© 2025），`improver` 除外 —— 它由本项目原创。该声明位于 `agents/prompts/` 下每个改编文件的开头 —— 出处与源码放在一起 —— 组装时会被剥离，因此交付给 agent 的提示词里不含许可证声明。`agents/prompts_cn/` 与 `agents/disciplines_cn.md` 仅供参考，永不打包。

## 许可证

MIT。
