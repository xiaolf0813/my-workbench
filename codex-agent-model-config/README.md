# Codex Agent Model Config

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
- Shows `developer_instructions` read-only.
- Preserves TOML comments, ordering, unknown fields, formatting.
- Refuses stale saves by comparing a SHA-256 file revision.
- Uses same-directory temporary-file validation plus atomic replacement.

## Install and run

The desktop plugin entry points are `plugin.json` and `mcp.json`; install this
folder from the ChatGPT desktop app as a local desktop-only plugin.

For local development:

```sh
cd codex-agent-model-config
npm install
npm --prefix web install
npm run build
npm test
```

`npm run build` compiles the stdio server and creates the inlined MCP Apps UI at
`web/dist/component.html`. Keep the root `node_modules/`, `dist/`, and `web/dist/`
directories present when installing the plugin locally.

For ChatGPT desktop testing, expose this folder through a repo or personal local
plugin marketplace, restart ChatGPT, install **Codex Agent Model Config**, and open
it in a local Codex chat. The final acceptance pass is:

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
