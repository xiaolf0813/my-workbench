import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { getAgentConfigurationsTool } from "./tools/get-agent-configurations.js";
import { listModelsTool } from "./tools/list-models.js";
import { updateAgentModelTool } from "./tools/update-agent-model.js";

const UI_RESOURCE_URI = "ui://codex-agent-model-config/v10.html";

function createMcpServer() {
  const server = new McpServer({
    name: "codex-agent-model-config",
    version: "0.1.8",
  });

  registerAppResource(server, "codex-agent-model-config", UI_RESOURCE_URI, {}, async () => {
    const uiBundle = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/dist/component.html"), "utf8");
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
          },
        },
      ],
    };
  });

  registerAppTool(
    server,
    "get_agent_configurations",
    {
      title: "Get Codex agent configurations",
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
      _meta: {
        ui: { resourceUri: UI_RESOURCE_URI },
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

  registerAppTool(
    server,
    "list_models",
    {
      title: "List model options",
      description: "Return the model catalog and supported reasoning-effort values.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: UI_RESOURCE_URI },
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

  const updateInputSchema = z
    .object({
      agentId: z.string().min(1).max(1024),
      fileRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      model: z.string().min(1).max(128),
      modelReasoningEffort: z.string().min(1).max(32),
      modelReasoningSummary: z.string().min(1).max(32).optional(),
      modelVerbosity: z.string().min(1).max(32).optional(),
    })
    .strict();

  registerAppTool(
    server,
    "update_agent_model",
    {
      title: "Update agent model",
      description:
        "Save only model, reasoning-effort, optional reasoning-summary, and optional verbosity fields to an existing custom agent TOML file.",
      inputSchema: updateInputSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      _meta: {
        ui: { resourceUri: UI_RESOURCE_URI },
      },
    },
    async (input) => {
      try {
        const result = await updateAgentModelTool(input);
        return {
          content: [
            {
              type: "text",
              text: `Saved ${result.agentId}. New chats will use the updated model configuration.`,
            },
          ],
          structuredContent: {
            saved: result.saved,
            agentId: result.agentId,
            fileRevision: result.fileRevision,
            requiresNewChat: result.requiresNewChat,
            modelAvailability: result.modelAvailability,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to save the model configuration.";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          structuredContent: { saved: false, error: message },
        };
      }
    },
  );

  return server;
}

serveStdio(() => createMcpServer());
