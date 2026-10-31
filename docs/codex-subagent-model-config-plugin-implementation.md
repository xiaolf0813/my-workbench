# Codex 子智能体模型配置插件实现文档

## 1. 文档信息

- 文档状态：实现草案
- 目标平台：ChatGPT 桌面版中的本地 Codex 环境
- 插件类型：Desktop-only 插件
- 核心目标：通过图形界面配置已有自定义子智能体的模型参数

## 2. 背景

Codex 支持通过个人级和项目级 TOML 文件定义自定义 Agent：

- 个人级：`~/.codex/agents/*.toml`
- 项目级：`<project>/.codex/agents/*.toml`

每个自定义 Agent 文件可以配置 `model`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity` 和 `developer_instructions`。目前这些配置主要通过手工编辑 TOML 文件完成。本插件为这些已有配置提供一个轻量 GUI，降低模型切换和参数配置成本。

## 3. 产品目标

插件必须支持：

1. 扫描个人级和当前项目级的自定义 Agent 文件。
2. 展示每个 Agent 的名称、描述、作用域、配置文件位置和当前模型参数。
3. 为每个已有自定义 Agent 选择模型。
4. 设置该 Agent 的推理强度。
5. 可选设置推理摘要和输出详细程度。
6. 只读查看该 Agent 文件中的 `developer_instructions`。
7. 直接保存模型配置到原 TOML 文件。
8. 在保存成功后提示“新建聊天后使用新配置”。

## 4. 明确不做

MVP 不包含以下能力：

- 不查看某次实际委派给子智能体的任务提示。
- 不尝试获取子智能体最终收到的完整有效 Prompt。
- 不监听运行中的子智能体。
- 不读取或解析 Codex transcript、rollout 或聊天历史。
- 不注册 `SubagentStart`、`SubagentStop`、`PreToolUse` 等 Hooks。
- 不展示文件 Diff。
- 不创建配置备份。
- 不提供“恢复继承”或删除模型覆盖的操作。
- 不编辑 `developer_instructions`。
- 不创建新的自定义 Agent。
- 不修改 Agent 的权限、沙箱、MCP Server、模型提供商或 Skill 配置。
- 不支持 ChatGPT Web 或云端 ChatGPT Work 的本地配置管理。

## 5. 支持边界

### 5.1 支持的 Agent

MVP 只允许编辑已经存在独立 TOML 文件的自定义 Agent。

例如：

```text
~/.codex/agents/planner.toml
<project>/.codex/agents/implementer.toml
```

### 5.2 内置 Agent

Codex 内置 `default`、`worker` 和 `explorer`。自定义同名 Agent 会覆盖内置 Agent，但官方没有提供读取内置 Agent 完整 `developer_instructions` 的稳定接口。

因此 MVP 不为内置 Agent 自动创建同名文件，也不尝试复制其内部提示词。界面可以显示内置 Agent，但必须标记为只读：

```text
worker
内置 Agent · 使用父级或全局默认模型 · 不可单独编辑
```

如果用户已经自行创建了同名自定义 Agent 文件，则该 Agent 按普通自定义 Agent 处理。

### 5.3 配置生效时机

插件只负责修改磁盘配置，不负责热更新已经运行的子智能体。保存成功后提示用户新建聊天或重新启动相关会话。

## 6. 用户界面

### 6.1 主界面

推荐使用全屏 MCP Custom UI：

```text
┌──────────────────────────────────────────────────────────────────┐
│ 子智能体模型配置                         [刷新]                  │
├──────────────────────┬───────────────────────────────────────────┤
│ Agent                │ 配置详情                                  │
│                      │                                           │
│ Personal             │ 名称：planner                             │
│ ● planner            │ 作用域：个人                              │
│   reviewer           │ 文件：~/.codex/agents/planner.toml        │
│                      │                                           │
│ Current Project      │ 模型：        GPT-6.1 Sol        ▼        │
│   implementer        │ 推理强度：    High               ▼        │
│   tester             │ 推理摘要：    Auto               ▼        │
│                      │ 输出详细度：  Medium             ▼        │
│ Built-in             │                                           │
│   worker   只读      │ [查看角色指令]                             │
│   explorer 只读      │                                           │
│                      │                              [保存]        │
└──────────────────────┴───────────────────────────────────────────┘
```

### 6.2 Agent 列表

列表分为三个区域：

1. `Personal`：来自 `~/.codex/agents/`。
2. `Current Project`：来自当前项目 `.codex/agents/`。
3. `Built-in`：内置 Agent，只读展示。

每一项显示：

- Agent 名称；
- 当前模型简称；
- 作用域；
- TOML 解析错误标记；
- 只读状态。

若个人级和项目级存在同名 Agent，两个配置分别显示，不在 UI 中合并。项目级项增加“当前项目”标识，避免用户误改个人配置。

### 6.3 模型配置表单

可编辑字段：

| UI 字段 | TOML 字段 | 必填 | 控件 |
|---|---|---:|---|
| 模型 | `model` | 是 | 可搜索下拉框，并允许输入模型 slug |
| 推理强度 | `model_reasoning_effort` | 是 | 下拉框 |
| 推理摘要 | `model_reasoning_summary` | 否 | 下拉框 |
| 输出详细度 | `model_verbosity` | 否 | 下拉框 |

保存按钮只在表单值与已加载值不一致且字段通过校验时启用。点击保存后直接写入，不显示 Diff 或二次确认页。

### 6.4 角色指令查看器

点击“查看角色指令”打开只读区域：

```text
角色指令：planner

负责分析需求、识别风险并制定实现方案……

[关闭]
```

显示内容仅来自当前 Agent TOML 文件中的 `developer_instructions`。界面必须明确标注：

> 这是配置文件中的角色指令，不是子智能体运行时的完整 Prompt。

### 6.5 保存反馈

保存成功：

```text
已保存 planner 的模型配置。新建聊天后使用新配置。
```

保存失败：

```text
保存失败：文件已被其他程序修改，请刷新后重试。
```

不提供插件内回滚按钮。

## 7. 技术架构

```text
ChatGPT Desktop
┌─────────────────────────────────┐
│ MCP Custom UI                   │
│ React + TypeScript              │
└───────────────┬─────────────────┘
                │ MCP Apps tools/call
┌───────────────▼─────────────────┐
│ Local MCP Server               │
│ Node.js + TypeScript           │
├─────────────────────────────────┤
│ AgentDiscoveryService          │
│ AgentConfigService             │
│ ModelCatalogService            │
│ ProjectContextService          │
└───────┬─────────────────────────┘
        │
        ├── ~/.codex/agents/*.toml
        └── <project>/.codex/agents/*.toml
```

### 7.1 为什么需要本地 MCP Server

自定义 Agent 配置位于用户本机。纯远程 MCP Server 无法直接读取或写入这些文件，因此插件必须包含或连接一个运行在桌面本机的 MCP Server。

### 7.2 为什么不需要 Hooks

插件只处理静态配置，不观察 Agent 的启动、任务、状态或输出，因此不需要任何生命周期 Hook。这样可以减少权限请求、信任提示和运行时数据处理。

## 8. 推荐项目结构

```text
codex-agent-model-config/
├── plugin.json
├── mcp.json
├── package.json
├── tsconfig.json
├── server/
│   ├── index.ts
│   ├── tools/
│   │   ├── get-agent-configurations.ts
│   │   ├── list-models.ts
│   │   └── update-agent-model.ts
│   ├── services/
│   │   ├── agent-discovery-service.ts
│   │   ├── agent-config-service.ts
│   │   ├── model-catalog-service.ts
│   │   └── project-context-service.ts
│   ├── infrastructure/
│   │   ├── file-system.ts
│   │   ├── toml-editor.ts
│   │   └── path-resolver.ts
│   └── domain/
│       ├── agent-config.ts
│       └── model-option.ts
├── web/
│   ├── package.json
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── AgentList.tsx
│   │   │   ├── AgentModelForm.tsx
│   │   │   ├── InstructionsViewer.tsx
│   │   │   └── StatusMessage.tsx
│   │   ├── bridge/
│   │   │   └── mcp-apps-client.ts
│   │   └── types.ts
│   └── dist/
│       └── component.js
└── tests/
    ├── fixtures/
    ├── agent-discovery.test.ts
    ├── agent-config.test.ts
    └── mcp-tools.test.ts
```

## 9. 领域模型

```ts
type AgentScope = "personal" | "project" | "builtin";

type AgentModelConfiguration = {
  id: string;
  name: string;
  description: string;
  scope: AgentScope;
  editable: boolean;
  filePath: string | null;
  projectRoot: string | null;
  model: string | null;
  modelReasoningEffort: string | null;
  modelReasoningSummary: string | null;
  modelVerbosity: string | null;
  developerInstructions: string | null;
  fileRevision: string | null;
  parseError: string | null;
};

type ModelOption = {
  slug: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  available: boolean | null;
};
```

`fileRevision` 是读取文件内容后生成的 SHA-256，用于保存时检测文件是否已被其他进程修改。它不是备份，也不会保留历史版本。

## 10. MCP 工具设计

MVP 只需要三个业务工具和一个 UI 资源。

### 10.1 `get_agent_configurations`

用途：扫描并返回个人级、项目级和内置 Agent。

输入：

```json
{
  "projectRoot": "D:\\workspace\\example"
}
```

输出：

```json
{
  "agents": [
    {
      "id": "project:planner",
      "name": "planner",
      "description": "Plans implementation work.",
      "scope": "project",
      "editable": true,
      "filePath": "D:\\workspace\\example\\.codex\\agents\\planner.toml",
      "model": "gpt-6.1-sol",
      "modelReasoningEffort": "high",
      "modelReasoningSummary": null,
      "modelVerbosity": null,
      "developerInstructions": "Create implementation plans...",
      "fileRevision": "sha256:...",
      "parseError": null
    }
  ]
}
```

要求：

- 只扫描固定配置目录，不接受任意文件路径。
- 单个 TOML 解析失败不得阻止其他 Agent 加载。
- 对 `developer_instructions` 只读取，不提供写入参数。

### 10.2 `list_models`

用途：返回模型选择器的数据。

输出：

```json
{
  "models": [
    {
      "slug": "gpt-6.1-sol",
      "displayName": "GPT-6.1 Sol",
      "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "available": true
    },
    {
      "slug": "gpt-6-luna",
      "displayName": "GPT-6 Luna",
      "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max"],
      "available": true
    }
  ],
  "allowCustomSlug": true
}
```

模型目录实现优先级：

1. 如果本地 Codex 提供可调用的模型目录接口，则使用实时目录。
2. 否则使用插件内置的建议列表，并允许用户手工输入模型 slug。
3. 当无法确认账户可用性时，将 `available` 返回为 `null`，UI 显示“可用性未验证”。

插件不能因为模型不在内置建议列表中就拒绝保存；模型目录会变化，手工 slug 是必要的兼容路径。

### 10.3 `update_agent_model`

用途：更新一个已有自定义 Agent 的模型字段。

输入：

```json
{
  "agentId": "project:planner",
  "fileRevision": "sha256:...",
  "model": "gpt-6.1-sol",
  "modelReasoningEffort": "high",
  "modelReasoningSummary": "auto",
  "modelVerbosity": "medium"
}
```

输出：

```json
{
  "saved": true,
  "agentId": "project:planner",
  "fileRevision": "sha256:new...",
  "requiresNewChat": true
}
```

约束：

- 只允许修改已扫描且 `editable = true` 的 Agent。
- 不接受客户端传入的任意文件路径。
- 保存前重新读取文件并核对 `fileRevision`。
- 只修改四个允许的模型字段。
- 不修改 `name`、`description`、`developer_instructions` 或其他字段。
- 不创建备份文件。
- 不返回 Diff。
- 不支持通过空值删除已有配置字段。

### 10.4 UI 资源

MCP Server 暴露一个 `text/html;profile=mcp-app` 资源，并由打开配置页的工具通过 `_meta.ui.resourceUri` 关联。UI 使用 MCP Apps bridge 的 `tools/call` 调用上述三个工具。

## 11. 文件发现规则

### 11.1 Codex Home

解析顺序：

1. 使用宿主明确提供的 Codex Home。
2. 使用 `CODEX_HOME` 环境变量。
3. 回退到平台默认的 `~/.codex`。

不得把普通用户输入直接拼接进 Codex Home 路径。

### 11.2 当前项目

项目根目录由宿主上下文或打开插件时的工作目录提供。MVP 只扫描：

```text
<projectRoot>/.codex/agents/*.toml
```

不递归扫描子目录，不跨工作区搜索其他仓库。

### 11.3 Agent 身份

Codex 以 TOML 中的 `name` 字段识别 Agent，文件名不是身份来源。插件的稳定 ID 使用：

```text
<scope>:<normalized-name>
```

发现同一作用域内重名时：

- 两个文件都标为冲突；
- 禁止保存；
- 提示用户手工修复重名文件。

## 12. TOML 读取与写入

### 12.1 读取

每个 Agent 文件必须包含：

```toml
name = "planner"
description = "Plans implementation work."
developer_instructions = """
Create an implementation plan before coding.
"""
```

缺少必填字段时：

- 仍在列表中显示文件；
- 标记为配置错误；
- 禁止修改模型字段。

### 12.2 修改范围

服务端只允许修改：

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
model_reasoning_summary = "auto"
model_verbosity = "medium"
```

未出现在请求中的可选字段保持原样。

### 12.3 格式保留

应使用能够保留注释、字段顺序和未知字段的 TOML 编辑器。禁止把整个 TOML 解析成普通对象后重新序列化，因为这种方式可能删除注释或改变用户文件布局。

### 12.4 原子写入

虽然不创建备份，仍必须避免半写入文件：

1. 在同一目录创建临时文件。
2. 写入并刷新临时文件。
3. 再次解析临时文件，确认 TOML 有效。
4. 使用原子替换覆盖原文件。
5. 不保留临时副本。

原子写入是防止文件损坏的实现机制，不属于备份功能。

## 13. 模型与推理强度校验

校验规则：

- `model` 必须是非空字符串。
- 模型 slug 最大长度 128。
- 模型 slug 只允许字母、数字、点、斜杠、下划线和连字符。
- `model_reasoning_effort` 必须来自服务端返回的允许集合。
- 如果模型目录声明某个模型不支持选定 effort，则阻止保存并要求重新选择。
- 模型可用性未知时允许保存，但显示非阻塞警告。

建议支持的 effort UI 值：

```text
none, minimal, low, medium, high, xhigh, max, ultra
```

最终允许值必须以当前 Codex 配置规范和模型目录为准，不能仅依赖硬编码列表。

## 14. 安全和隐私

### 14.1 最小文件权限

本地 MCP Server 只需要：

- 读取个人级和当前项目级 Agent 目录；
- 写入用户明确选择的已有 Agent TOML 文件。

禁止：

- 接受任意绝对路径；
- 访问其他项目；
- 读取聊天 transcript；
- 扫描整个用户目录；
- 修改主配置中与本功能无关的字段。

### 14.2 Prompt 数据

`developer_instructions` 可能包含内部规则或敏感信息。要求：

- 默认只在本机读取和展示；
- 不发送到远程分析服务；
- 不写入日志；
- UI 以纯文本或安全转义后的 Markdown 展示；
- MCP 工具结果中的该字段不应进入错误遥测。

### 14.3 路径校验

保存时服务端根据 `agentId` 重新解析真实文件路径，并确认规范化路径仍位于允许目录内。不得信任 UI 缓存的 `filePath`。

## 15. 错误处理

| 场景 | UI 行为 |
|---|---|
| Agent 目录不存在 | 显示空状态，不视为错误 |
| TOML 无法解析 | 显示具体文件和解析错误，禁用保存 |
| 缺少必填字段 | 显示不完整配置，禁用保存 |
| 模型 slug 为空 | 表单内校验，不调用保存工具 |
| 模型可用性未知 | 允许保存并显示警告 |
| 文件在加载后被修改 | 拒绝覆盖，提示刷新 |
| 文件只读或权限不足 | 显示操作系统错误的友好描述 |
| 原子替换失败 | 报告失败，原文件保持不变 |
| 项目上下文缺失 | 只展示个人级 Agent |

## 16. 测试计划

### 16.1 单元测试

- 发现个人级 Agent。
- 发现项目级 Agent。
- 忽略非 TOML 文件。
- 解析所有允许的模型字段。
- 正确读取多行 `developer_instructions`。
- 缺少必填字段时返回配置错误。
- 同一作用域重名时返回冲突。
- 模型字段更新不改变其他 TOML 字段。
- 注释和字段顺序保持不变。
- `fileRevision` 不匹配时拒绝写入。
- 路径越界时拒绝写入。
- 临时文件验证失败时不覆盖原文件。

### 16.2 MCP 契约测试

- `get_agent_configurations` 返回稳定结构。
- `list_models` 在实时目录不可用时正确降级。
- `update_agent_model` 不接受任意路径。
- `update_agent_model` 不接受修改提示词的额外字段。
- 错误结果不泄露 `developer_instructions`。

### 16.3 UI 测试

- 个人、项目、内置 Agent 正确分组。
- 切换 Agent 后表单不会保留上一个 Agent 的脏状态。
- 不支持的 effort 无法提交。
- 保存成功后显示新建聊天提示。
- 角色指令查看器只读。
- 内置 Agent 的保存按钮不可用。
- MCP 调用失败时保留用户当前输入。

### 16.4 跨平台测试

- Windows：`%USERPROFILE%\.codex`。
- macOS/Linux：`$HOME/.codex`。
- 包含空格和非 ASCII 字符的项目路径。
- 只读文件、文件锁和安全软件拦截场景。

## 17. 实施顺序

### 阶段一：配置服务

1. 实现 Codex Home 和项目根目录解析。
2. 实现 Agent 文件扫描和 TOML 解析。
3. 实现领域模型和错误模型。
4. 实现格式保留的模型字段修改。
5. 实现 `fileRevision` 并发检查和原子写入。

### 阶段二：MCP Server

1. 注册 `get_agent_configurations`。
2. 注册 `list_models`。
3. 注册 `update_agent_model`。
4. 注册 MCP Apps UI 资源。
5. 对工具输入使用严格 JSON Schema 校验。

### 阶段三：Custom UI

1. 实现 Agent 分组列表。
2. 实现模型配置表单。
3. 实现角色指令只读查看器。
4. 接入 `tools/call`。
5. 实现加载、保存和错误状态。

### 阶段四：集成验证

1. 在 ChatGPT 桌面版安装本地插件。
2. 验证个人级 Agent 加载和保存。
3. 验证项目级 Agent 加载和保存。
4. 新建 Codex 聊天，验证配置被实际读取。
5. 验证插件没有加载 Hooks 或读取运行时会话数据。

## 18. 验收标准

满足以下条件即可认为 MVP 完成：

1. 插件能在 ChatGPT 桌面版打开模型配置界面。
2. 能列出个人级和当前项目级的已有自定义 Agent。
3. 能区分个人、项目和内置 Agent。
4. 能为已有自定义 Agent 修改 `model` 和 `model_reasoning_effort`。
5. 能选填 `model_reasoning_summary` 和 `model_verbosity`。
6. 能只读展示 `developer_instructions`。
7. 保存操作不修改其他 TOML 字段和注释。
8. 保存操作不创建 Diff、备份或历史版本。
9. UI 不提供恢复继承、删除模型字段或编辑角色指令的入口。
10. 插件不读取委派提示、完整 Prompt、聊天 transcript 或运行时 Agent 状态。
11. 文件并发变化时不会静默覆盖。
12. 保存后新建 Codex 聊天能够使用新模型配置。

## 19. 后续功能约束

后续版本即使扩展，也应保持以下边界：

- 新增 Agent 创建功能时，必须要求用户明确提供 `name`、`description` 和 `developer_instructions`。
- 不得通过复制未知的内置 Prompt 来覆盖内置 Agent。
- 不得把运行时 Prompt 采集作为模型配置功能的隐式依赖。
- 任何远程同步功能都必须单独征得用户同意，并默认排除 `developer_instructions`。

## 20. 官方依据

- [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)：自定义 Agent 的目录、必填字段、模型字段、继承关系和内置 Agent。
- [Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)：MCP Custom UI、MCP Apps bridge、`tools/call` 和 UI 资源机制。
- [Plugin build guide](https://developers.openai.com/plugins/build/plugins)：插件打包、MCP Server 和桌面端本地插件结构。
