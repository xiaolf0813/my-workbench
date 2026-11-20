import fs from "node:fs/promises";
import path from "node:path";
import { revisionForFile } from "../infrastructure/file-system.js";
import { normalizeAgentName, PathResolver } from "../infrastructure/path-resolver.js";
import { parseEditableToml, replaceModelFields } from "../infrastructure/toml-editor.js";
import type { ModelCatalog } from "../domain/model-option.js";

export type UpdateAgentModelInput = {
  agentId: string;
  fileRevision: string;
  model: string | null;
  modelReasoningEffort: string | null;
  modelReasoningSummary?: string | null;
  modelVerbosity?: string | null;
};

function invalid(message: string): Error {
  return new Error(message);
}

function validateModel(model: string, models: ModelCatalog): void {
  if (!models.models.some((entry) => entry.slug === model)) {
    throw invalid("Model must be selected from the available model list.");
  }
}

function validateEffort(effort: string, models: ModelCatalog): void {
  if (!models.supportedReasoningEfforts.includes(effort)) {
    throw invalid(`Reasoning effort must be one of: ${models.supportedReasoningEfforts.join(", ")}.`);
  }
}

function validateSelectedEffort(
  modelSlug: string,
  effort: string,
  models: ModelCatalog,
): void {
  const model = models.models.find((entry) => entry.slug === modelSlug);
  if (!model) throw invalid("Model must be selected from the available model list.");
  if (!model.supportedReasoningEfforts.includes(effort)) {
    throw invalid("The selected model does not support this reasoning effort.");
  }
}

function validateExistingAgent(source: string, filePath: string, resolver: PathResolver, agentId: string): void {
  const parsed = parseEditableToml(source);
  const name = parsed.fields.get("name")?.trim() ?? "";
  const description = parsed.fields.get("description")?.trim() ?? "";
  const instructions = parsed.fields.get("developer_instructions")?.trim() ?? "";
  if (!name || !description || !instructions) {
    throw invalid("This agent file is incomplete and cannot be edited.");
  }
  const expectedId = `${path.dirname(filePath) === resolver.personalAgentsDirectory ? "personal" : "project"}:${encodeURIComponent(normalizeAgentName(name))}`;
  if (agentId !== expectedId) throw invalid("Agent identity no longer matches its file.");
}

export async function updateAgentModel(
  resolver: PathResolver,
  models: ModelCatalog,
  input: UpdateAgentModelInput,
  scannedFilePath?: string,
): Promise<{ saved: true; agentId: string; fileRevision: string; requiresNewChat: true; modelAvailability: boolean | null }> {
  const filePath = scannedFilePath
    ? resolver.validateScannedAgentPath(input.agentId, scannedFilePath)
    : resolver.resolveAgentPath(input.agentId);
  if (!filePath) throw invalid("Unknown or read-only agent.");
  if (input.model !== null) validateModel(input.model, models);
  if (input.modelReasoningEffort !== null) {
    validateEffort(input.modelReasoningEffort, models);
    if (input.model !== null) validateSelectedEffort(input.model, input.modelReasoningEffort, models);
  }
  const lock = filePath + ".subagent-config-lock";
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw invalid(`Another save is in progress. Refresh and retry. If all writers have stopped, remove ${lock}.`);
  }

  try {
    const source = await fs.readFile(filePath, "utf8");
    if (revisionForFile(filePath, source) !== input.fileRevision) {
      throw invalid("The file changed after it was loaded. Refresh and try again.");
    }
    validateExistingAgent(source, filePath, resolver, input.agentId);
    // Existing clients clear all model settings by sending null for model and
    // effort and omitting the two optional fields.
    const clearOptional = input.model === null && input.modelReasoningEffort === null;
    const updated = replaceModelFields(source, {
      model: input.model,
      model_reasoning_effort: input.modelReasoningEffort,
      ...(clearOptional || input.modelReasoningSummary !== undefined ? { model_reasoning_summary: input.modelReasoningSummary ?? null } : {}),
      ...(clearOptional || input.modelVerbosity !== undefined ? { model_verbosity: input.modelVerbosity ?? null } : {}),
    });
    const candidate = path.join(lock, "candidate.toml");
    const handle = await fs.open(candidate, "wx", 0o600);
    try {
      await handle.writeFile(updated, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await fs.readFile(filePath, "utf8") !== source) {
      throw invalid("The file changed after it was loaded. Refresh and try again.");
    }
    await fs.rename(candidate, filePath);
    return {
      saved: true,
      agentId: input.agentId,
      fileRevision: revisionForFile(filePath, updated),
      requiresNewChat: true,
      modelAvailability: models.models.find((model) => model.slug === input.model)?.available ?? null,
    };
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
