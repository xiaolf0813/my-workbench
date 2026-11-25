import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { getAgentConfigurationsTool } from "./tools/get-agent-configurations.js";
import { listModelsTool } from "./tools/list-models.js";
import { getModelConfiguration, saveModelConfiguration } from "./services/model-profile-service.js";
import { checkSshCodexTarget, getSshSyncBatch, startSshSyncBatch, syncSubagentConfigToSsh } from "./services/ssh-sync-service.js";
import { beginSshPasswordEntry } from "./services/ssh-credential-broker.js";
import { deleteSshServer, getSshPasswordStatus, listSshServers, saveSshServer, getSshServer } from "./services/ssh-server-store.js";

const UI_RESOURCE_URI = "ui://subagent-config/v21.html";

function createMcpServer() {
  const server = new McpServer({
    name: "subagent-config",
    version: "0.2.14",
  });
  new OpenAIExtensions(server);

  registerAppResource(server, "subagent-config", UI_RESOURCE_URI, {}, async () => {
    const uiBundle = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "component.html"), "utf8");
    return {
      contents: [
        {
          uri: UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: uiBundle,
          _meta: {
            ui: {
              csp: { connectDomains: ["http://127.0.0.1:*"] },
            },
            "openai/ui": {
              preferredDisplayMode: "fullscreen",
              availableDisplayModes: ["fullscreen"],
            },
          },
        },
      ],
    };
  });

  registerAppTool(server, "open_subagent_config", {
    title: "Open Subagent Config",
    description: "Open Subagent Config to manage models, agents, and remote SSH sync.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: UI_RESOURCE_URI },
      "openai/ui": { entrypoints: [{ type: "global" }] },
    },
  }, async () => ({ content: [{ type: "text", text: "Subagent Config opened." }] }));

  server.registerTool(
    "get_agent_configurations",
    {
      title: "Subagent Config",
      description:
        "Scan personal Codex custom agents and, when the active Codex project root is known, current-project agents. Pass the absolute active project root; omit it when the host provides no project context.",
      inputSchema: z
        .object({
          projectRoot: z
            .string()
            .min(1)
            .max(1024)
            .optional()
            .describe("Absolute root of the active Codex project, supplied from the current task context when known."),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectRoot }) => {
      try {
        const result = await getAgentConfigurationsTool({ projectRoot });
        return {
          content: [
            {
              type: "text",
              text: `Found ${result.agents.length} agent${result.agents.length === 1 ? "" : "s"}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to scan agent files." }],
        };
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List model options",
      description: "Return the model catalog and supported reasoning-effort values.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = await listModelsTool();
        return {
          content: [{ type: "text", text: `Found ${result.models.length} model option${result.models.length === 1 ? "" : "s"}.` }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to load models." }],
        };
      }
    },
  );

  server.registerTool("get_model_configuration", {
    title: "Get model profiles",
    description: "Read the user-owned Codex model profile configuration.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      const result = getModelConfiguration();
      return { content: [{ type: "text", text: result.configured ? "Model profiles loaded." : "Model profiles need configuration." }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to read model profiles." }] };
    }
  });

  server.registerTool("save_model_configuration", {
    title: "Save model profiles",
    description: "Save ordered Codex model candidates and MyWorkbench agent profile assignments.",
    inputSchema: z.object({ configuration: z.unknown(), fileRevision: z.string().nullable() }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
  }, async ({ configuration, fileRevision }) => {
    try {
      const result = saveModelConfiguration(configuration, fileRevision);
      return { content: [{ type: "text", text: "Model profiles saved for new chats." }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to save model profiles." }] };
    }
  });

  server.registerTool("get_ssh_servers", {
    title: "List SSH servers",
    description: "Read saved SSH server connection settings. Passwords are never returned.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      const servers = listSshServers().map((item) => {
        const credential = item.authentication === "password" ? getSshPasswordStatus(item.id) : { saved: false, available: true };
        const { credentialGeneration: _credentialGeneration, passwordDestination: _passwordDestination, ...publicServer } = item;
        return { ...publicServer, passwordSaved: credential.saved, passwordStoreAvailable: credential.available };
      });
      return { content: [{ type: "text", text: `Found ${servers.length} SSH server${servers.length === 1 ? "" : "s"}.` }], structuredContent: { servers } };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to read saved SSH servers." }] };
    }
  });

  const sshServerInputSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(80),
    target: z.string().min(1).max(255).describe("SSH host alias or user@host from the local SSH configuration."),
    port: z.number().int().min(1).max(65535).optional(),
    codexHome: z.string().max(1024),
    authentication: z.enum(["agent", "key-file", "password"]),
    keyFilePath: z.string().max(2048).optional(),
  }).strict();

  server.registerTool("save_ssh_server", {
    title: "Save SSH server",
    description: "Add or update an SSH server connection. Stores connection metadata locally and never accepts a password.",
    inputSchema: sshServerInputSchema,
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
  }, async (input) => {
    try {
      const saved = saveSshServer(input);
      const { credentialGeneration: _credentialGeneration, passwordDestination: _passwordDestination, ...publicServer } = saved;
      return { content: [{ type: "text", text: "SSH server saved." }], structuredContent: { server: publicServer } };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to save the SSH server." }] };
    }
  });

  server.registerTool("delete_ssh_server", {
    title: "Delete SSH server",
    description: "Remove a saved SSH server and its system credential, if present.",
    inputSchema: z.object({ id: z.string().uuid() }).strict(),
    annotations: { destructiveHint: true, openWorldHint: false, readOnlyHint: false },
  }, async ({ id }) => {
    try {
      deleteSshServer(id);
      return { content: [{ type: "text", text: "SSH server deleted." }], structuredContent: { deleted: true } };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to delete the SSH server." }] };
    }
  });

  registerAppTool(server, "begin_ssh_password_entry", {
    title: "Open secure SSH password entry",
    description: "Create a short-lived local credential entry request. The password is sent directly to the local keychain endpoint, not through MCP.",
    inputSchema: z.object({ serverId: z.string().uuid(), origin: z.string().min(1).max(256) }).strict(),
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI, visibility: ["app"] } },
  }, async ({ serverId, origin }) => {
    try {
      const result = await beginSshPasswordEntry(serverId, origin);
      return { content: [{ type: "text", text: "Secure password entry is ready." }], _meta: { "subagent-config/credential-entry": result } };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to open secure password entry." }] };
    }
  });

  const sshServerIdSchema = z.object({ serverId: z.string().uuid() }).strict();

  server.registerTool("check_ssh_codex_target", {
    title: "Check SSH Codex target",
    description: "Check SSH connectivity and confirm remote Node.js, Codex CLI, and the local plugin package version. Does not change the remote host.",
    inputSchema: sshServerIdSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ serverId }) => {
    try {
      const result = await checkSshCodexTarget(getSshServer(serverId));
      return { content: [{ type: "text", text: "SSH target is ready." }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to check the SSH target." }] };
    }
  });

  server.registerTool("sync_subagent_config_to_ssh", {
    title: "Sync Subagent Config over SSH",
    description: "Install or update the Subagent Config plugin on a user-selected remote Codex and copy the sanitized MyWorkbench model profiles. Requires explicit overwrite confirmation. Does not sync provider credentials or Codex settings.",
    inputSchema: sshServerIdSchema.extend({
      confirmOverwrite: z.literal(true).describe("Confirm replacing the remote Subagent Config plugin and model profile file."),
    }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
  }, async ({ serverId, confirmOverwrite: _confirmOverwrite }) => {
    try {
      const result = await syncSubagentConfigToSsh(getSshServer(serverId));
      return { content: [{ type: "text", text: "Subagent Config synced. Restart remote Codex to reload it." }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to sync Subagent Config over SSH." }] };
    }
  });

  server.registerTool("sync_subagent_config_to_all_ssh", {
    title: "Sync Subagent Config to all SSH servers",
    description: "Sync the current Subagent Config plugin and sanitized model profiles to every saved SSH server. Requires explicit overwrite confirmation.",
    inputSchema: z.object({ serverIds: z.array(z.string().uuid()).min(1).max(50), confirmOverwrite: z.literal(true) }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
  }, async ({ serverIds, confirmOverwrite: _confirmOverwrite }) => {
    try {
      const uniqueIds = [...new Set(serverIds)];
      if (uniqueIds.length !== serverIds.length) throw new Error("The server list contains duplicate entries. Refresh it and retry.");
      const servers = uniqueIds.map((id) => getSshServer(id));
      const result = startSshSyncBatch(servers);
      return { content: [{ type: "text", text: `Started sync batch ${result.batchId}.` }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to sync all SSH servers." }] };
    }
  });

  server.registerTool("get_ssh_sync_batch", {
    title: "Get SSH sync progress",
    description: "Read per-server progress for an active or recently completed sync-all batch.",
    inputSchema: z.object({ batchId: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ batchId }) => {
    const result = getSshSyncBatch(batchId);
    const message = result.status === "unknown" ? "The sync batch status is no longer available; inspect remote plugin state before retrying." : `Sync batch is ${result.status}.`;
    return { content: [{ type: "text", text: message }], structuredContent: result };
  });

  return server;
}

serveStdio(() => createMcpServer());
