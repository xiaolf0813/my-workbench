# Subagent Config

Desktop-only Codex plugin for managing user-owned model profiles. Open it from the ChatGPT desktop sidebar after deploying and restarting Codex.

The plugin creates `<CODEX_HOME>/my-workbench-config.json` only when the user saves. It stores ordered model candidates for `fast`, `standard`, `deep`, and `perceptive`, plus a profile assignment for each MyWorkbench subagent. `developer` defaults to `auto`; users can choose a fixed profile. Every profile needs at least one model before saving. Reasoning effort is optional per candidate. The repository deploys no model choices.

On the first profile save, existing direct `model` and `model_reasoning_effort` fields in personal MyWorkbench agent TOMLs are backed up under `<CODEX_HOME>/my-workbench-agent-model-backups/` and removed so dispatch-time profile selection can apply. Other TOML content is preserved. New chats read the saved configuration.

The Codex orchestrator chooses a profile, tries the user-ordered candidates, and falls back only if a model-specific error proves the agent did not start. It asks the user to configure an absent profile or replace exhausted candidates.

## Development

```sh
cd backends/codex/subagent-config
npm install
npm --prefix web install
npm run build
npm test
```

`npm run build` updates the checked-in offline runtime at `runtime/server.mjs` and `runtime/component.html`. The MCP app resource URI is versioned; update `UI_RESOURCE_URI` whenever the HTML contract changes.
