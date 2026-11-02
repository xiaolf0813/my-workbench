import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { readFileRevision } from "../infrastructure/file-system.js";
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
): { available: boolean | null } {
  const model = models.models.find((entry) => entry.slug === modelSlug);
  if (!model) throw invalid("Model must be selected from the available model list.");
  if (!model.supportedReasoningEfforts.includes(effort)) {
    throw invalid("The selected model does not support this reasoning effort.");
  }
  return { available: model.available ?? null };
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
  let availability: { available: boolean | null } = { available: null };
  if (input.model === null) {
    if (
      input.modelReasoningEffort !== null ||
      input.modelReasoningSummary != null ||
      input.modelVerbosity != null
    ) {
      throw invalid("Inherited model configuration cannot pin reasoning or verbosity fields.");
    }
  } else {
    validateModel(input.model, models);
    if (input.modelReasoningEffort !== null) {
      validateEffort(input.modelReasoningEffort, models);
      availability = validateSelectedEffort(input.model, input.modelReasoningEffort, models);
    } else {
      availability = { available: models.models.find((entry) => entry.slug === input.model)?.available ?? null };
    }
  }

  const currentRevision = await readFileRevision(filePath);
  if (currentRevision !== input.fileRevision) {
    throw invalid("The file changed after it was loaded. Refresh and try again.");
  }

  const source = await fs.readFile(filePath, "utf8");
  validateExistingAgent(source, filePath, resolver, input.agentId);
  const updated = replaceModelFields(
    source,
    input.model === null
      ? {
          model: null,
          model_reasoning_effort: null,
          model_reasoning_summary: null,
          model_verbosity: null,
        }
      : {
          model: input.model,
          model_reasoning_effort: input.modelReasoningEffort,
          ...(input.modelReasoningSummary === undefined ? {} : { model_reasoning_summary: input.modelReasoningSummary }),
          ...(input.modelVerbosity === undefined ? {} : { model_verbosity: input.modelVerbosity }),
        },
  );

  const temporaryPath = await fs.mkdtemp(path.join(path.dirname(filePath), ".subagent-config-"));
  const candidatePath = path.join(temporaryPath, "candidate.toml");
  try {
    const candidate = await fs.open(candidatePath, "wx", 0o600);
    try {
      await candidate.writeFile(updated, "utf8");
      await candidate.sync();
    } finally {
      await candidate.close();
    }
    const candidateSource = await fs.readFile(candidatePath, "utf8");
    try {
      parseToml(candidateSource);
    } catch {
      throw invalid("Updated TOML validation failed; the original file was not changed.");
    }
    await fs.rename(candidatePath, filePath);
  } catch (error) {
    try {
      await fs.rm(temporaryPath, { recursive: true, force: true });
    } catch {
      // The original file remains untouched if replacement failed.
    }
    throw error;
  }
  await fs.rm(temporaryPath, { recursive: true, force: true });

  return {
    saved: true,
    agentId: input.agentId,
    fileRevision: await readFileRevision(filePath),
    requiresNewChat: true,
    modelAvailability: availability.available,
  };
}
