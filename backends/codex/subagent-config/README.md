# Subagent Config

Desktop-only Codex plugin for managing user-owned model profiles. Open it from the ChatGPT desktop sidebar after deploying and restarting Codex.

The plugin creates `<CODEX_HOME>/my-workbench-config.json` only when the user saves. It stores ordered model candidates for `fast`, `standard`, `deep`, and `perceptive`, plus a profile assignment for each MyWorkbench subagent. `developer` defaults to `auto`; users can choose a fixed profile. Every profile needs at least one model before saving. Reasoning effort is optional per candidate. The repository deploys no model choices.

On the first profile save, existing direct `model` and `model_reasoning_effort` fields in personal MyWorkbench agent TOMLs are backed up under `<CODEX_HOME>/my-workbench-agent-model-backups/` and removed so dispatch-time profile selection can apply. Other TOML content is preserved. New chats read the saved configuration.

The **SSH Sync** page keeps a local list of remote Codex servers and can sync to all of them. Connections can use the local SSH agent/config, a private key file path, or a password saved in the operating system credential store. Passwords travel encrypted from the UI to a short-lived loopback endpoint and never pass through MCP tool arguments or the server-list file. Password connections require a matching host key in the configured `known_hosts` files and currently do not support `ProxyJump` or `ProxyCommand`. Key-file authentication pins the selected key while preserving effective host-verification settings; it requires direct SSH and does not support `ProxyJump`, `ProxyCommand`, or `KnownHostsCommand`. Agent authentication uses the full local SSH config. Private key files stay on this device. A connection check verifies remote Node.js, Codex CLI, `tar`, `flock`, and `cmp` before syncing. The remote plugin files and `my-workbench-config.json` are replaced after explicit confirmation. Provider credentials, provider settings, and other Codex files are not copied. The lock serializes syncs from this feature; manual or external marketplace edits are not coordinated. Restart remote Codex after syncing.

The Codex orchestrator chooses a profile, tries the user-ordered candidates, and falls back only if a model-specific error proves the agent did not start. It asks the user to configure an absent profile or replace exhausted candidates.

## Development

```sh
cd backends/codex/subagent-config
npm install
npm --prefix web install
npm run build
npm test
```

`npm run build` updates the checked-in offline runtime at `runtime/server.mjs` and `runtime/component.html`, including the vendored per-platform system-keyring bindings. The MCP app resource URI is versioned; update `UI_RESOURCE_URI` whenever the HTML contract changes.
