import { getAgentConfigurations } from "../services/agent-config-service.js";
import { listModels } from "../services/model-catalog-service.js";
import { updateAgentModel } from "../services/agent-write-service.js";
import { requireActiveProjectContext } from "../services/project-context-service.js";

export type UpdateAgentModelInput = {
  agentId: string;
  fileRevision: string;
  model: string | null;
  modelReasoningEffort: string | null;
  modelReasoningSummary?: string | null;
  modelVerbosity?: string | null;
};

export async function updateAgentModelTool(input: UpdateAgentModelInput) {
  const resolver = requireActiveProjectContext();
  const { agents } = await getAgentConfigurations(resolver);
  const scannedAgent = agents.find((agent) => agent.id === input.agentId);
  if (!scannedAgent?.editable || !scannedAgent.filePath) {
    throw new Error("Unknown, conflicted, invalid, or read-only agent.");
  }
  const models = await listModels();
  return await updateAgentModel(resolver, models, input, scannedAgent.filePath);
}
