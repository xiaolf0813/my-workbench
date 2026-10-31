import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { SUPPORTED_MODEL_REASONING_EFFORTS, type ModelCatalog, type ModelOption } from "../domain/model-option.js";

const execFileAsync = promisify(execFile);
const CODEX_COMMAND = process.env.CODEX_CLI_PATH?.trim() || "codex";
const APP_SERVER_TIMEOUT_MS = 15_000;

const FALLBACK_MODELS: ModelOption[] = [
  {
    slug: "gpt-6.1-sol",
    displayName: "GPT-6.1-Sol",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    available: null,
  },
  {
    slug: "gpt-6-luna",
    displayName: "GPT-6-Luna",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    available: null,
  },
];

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function orderedEfforts(efforts: Iterable<string>): string[] {
  const unique = new Set(efforts);
  const known = SUPPORTED_MODEL_REASONING_EFFORTS.filter((effort) => unique.delete(effort));
  return [...known, ...unique];
}

export function modelCatalogFromRows(rows: unknown[]): ModelCatalog {
  const bySlug = new Map<string, ModelOption>();

  for (const row of rows) {
    const model = record(row);
    if (!model || model.hidden === true || model.visibility === "hide") continue;

    const slug = stringValue(model.model) ?? stringValue(model.id) ?? stringValue(model.slug);
    if (!slug) continue;

    const rawEfforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
      : Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
        : [];
    const efforts = orderedEfforts(
      rawEfforts
        .map((entry) => {
          if (typeof entry === "string") return entry;
          const item = record(entry);
          return item ? stringValue(item.reasoningEffort) ?? stringValue(item.effort) : null;
        })
        .filter((effort): effort is string => effort !== null),
    );
    if (efforts.length === 0) continue;

    bySlug.set(slug, {
      slug,
      displayName: stringValue(model.displayName) ?? stringValue(model.display_name) ?? slug,
      supportedReasoningEfforts: efforts,
      available: null,
    });
  }

  const models = [...bySlug.values()];
  if (models.length === 0) throw new Error("Codex returned an empty model catalog.");
  return {
    models,
    supportedReasoningEfforts: orderedEfforts(models.flatMap((model) => model.supportedReasoningEfforts)),
    allowCustomSlug: false,
  };
}

async function loadModelsFromAppServer(): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn(CODEX_COMMAND, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    const rows: unknown[] = [];
    let stderr = "";
    let nextRequestId = 1;
    let pendingPageId: number | null = null;
    let finishing = false;
    let settled = false;

    const timer = setTimeout(() => finish(new Error("Timed out while loading the Codex model catalog.")), APP_SERVER_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
    }

    function finish(error?: Error): void {
      if (settled || finishing) return;
      finishing = true;
      cleanup();
      child.once("close", () => {
        settled = true;
        if (error) reject(error);
        else resolve(rows);
      });
      child.kill();
    }

    function send(message: unknown): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function requestPage(cursor?: string): void {
      const id = nextRequestId++;
      pendingPageId = id;
      send({
        method: "model/list",
        id,
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      });
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled && !finishing) {
        finish(new Error(`Codex app-server exited before returning models (code ${code ?? "unknown"}). ${stderr}`.trim()));
      }
    });

    lines.on("line", (line) => {
      let message: JsonObject | null = null;
      try {
        message = record(JSON.parse(line));
      } catch {
        return;
      }
      if (!message) return;

      if (message.id === 0) {
        const error = record(message.error);
        if (error) {
          finish(new Error(stringValue(error.message) ?? "Codex app-server initialization failed."));
          return;
        }
        send({ method: "initialized", params: {} });
        requestPage();
        return;
      }

      if (message.id !== pendingPageId) return;
      const error = record(message.error);
      if (error) {
        finish(new Error(stringValue(error.message) ?? "Codex model/list failed."));
        return;
      }
      const result = record(message.result);
      if (!result || !Array.isArray(result.data)) {
        finish(new Error("Codex model/list returned an invalid response."));
        return;
      }
      rows.push(...result.data);
      const nextCursor = stringValue(result.nextCursor);
      if (nextCursor) requestPage(nextCursor);
      else finish();
    });

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "codex_agent_model_config",
          title: "Codex Agent Model Config",
          version: "0.1.8",
        },
      },
    });
  });
}

async function loadModelsFromDebugCommand(): Promise<unknown[]> {
  const { stdout } = await execFileAsync(CODEX_COMMAND, ["debug", "models"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: APP_SERVER_TIMEOUT_MS,
    windowsHide: true,
  });
  const result = record(JSON.parse(stdout));
  if (!result || !Array.isArray(result.models)) throw new Error("Codex debug models returned an invalid response.");
  return result.models;
}

export async function listModels(): Promise<ModelCatalog> {
  try {
    return modelCatalogFromRows(await loadModelsFromAppServer());
  } catch {
    try {
      return modelCatalogFromRows(await loadModelsFromDebugCommand());
    } catch {
      return {
        models: FALLBACK_MODELS,
        supportedReasoningEfforts: SUPPORTED_MODEL_REASONING_EFFORTS,
        allowCustomSlug: false,
      };
    }
  }
}
