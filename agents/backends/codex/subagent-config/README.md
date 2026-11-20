# Subagent Config

Desktop-only ChatGPT/Codex plugin for editing model fields in existing custom Codex
subagent TOML files.

## What it does

- Discovers custom agents in `<CODEX_HOME>/agents/*.toml` and
  `<projectRoot>/.codex/agents/*.toml`.
- Shows personal agents and, when the invoking Codex context supplies its project
  root, current-project agents. The project root is read-only and the entire
  current-project section stays hidden when that context is unavailable.
- Built-in agents remain read-only in the MCP contract and are omitted from the
  settings UI.
- Loads the visible model picker catalog from Codex `model/list`, so model selection
  matches the current desktop chat composer; custom model slugs remain disabled.
- Edits only `model`, `model_reasoning_effort`, `model_reasoning_summary`, and
  `model_verbosity`.
- Supports inheriting the session model while pinning reasoning effort. Clear individual fields to restore inheritance; custom
  model slugs are never accepted.
- Shows `developer_instructions` read-only.
- Preserves TOML comments, ordering, unknown fields, formatting.
- Each save is bound to the scanned file and revision. Concurrent plugin writes to that file are serialized or rejected.
- Uses same-directory temporary-file validation plus atomic replacement.

## Local development

```sh
cd agents/backends/codex/subagent-config
npm install
npm --prefix web install
npm run build
npm test
```

`npm run build` bundles the dependency-free deployment artifacts at
`runtime/server.mjs` and `runtime/component.html`; those two files are checked in
and are the only runtime payload beside `plugin.json` and `mcp.json`.

With **Subagent Config** loaded in a local Codex chat, verify the following behaviors.

1. Load and save a personal agent.
2. Open the plugin from a project chat, confirm its read-only project root, then
   load and save a project agent.
3. Start a new Codex chat and confirm the updated custom agent uses the saved model.
4. Confirm no hooks are requested or installed.

The MCP app resource is versioned; update `UI_RESOURCE_URI` in
`server/index.ts` whenever its HTML changes in a way that can break a cached UI.

The local server uses the MCP SDK's stdio entry (`serveStdio`) and the MCP Apps
server helpers to associate the HTML resource with all three tools.

## Intentional limits

The plugin does not read transcripts or runtime subagent state, register hooks,
create agents, edit prompts, create backups, show diffs, or expose arbitrary file
paths to clients. Built-in agents remain read-only in the MCP contract and are
omitted from the settings UI.
