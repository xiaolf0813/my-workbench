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

const UI_RESOURCE_URI = "ui://subagent-config/v18.html";

function createMcpServer() {
  const server = new McpServer({
    name: "subagent-config",
    version: "0.2.4",
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
              csp: { connectDomains: [] },
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
    description: "Open the Subagent Config model and agent settings page.",
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

  return server;
}

serveStdio(() => createMcpServer());
