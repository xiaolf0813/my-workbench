import { getAgentConfigurations } from "../services/agent-config-service.js";
import { listModels } from "../services/model-catalog-service.js";
import { updateAgentModel, type UpdateAgentModelInput } from "../services/agent-write-service.js";
import { requireScanTarget } from "../services/project-context-service.js";

export async function updateAgentModelTool(input: UpdateAgentModelInput) {
  const target = requireScanTarget(input.agentId, input.fileRevision);
  const { agents } = await getAgentConfigurations(target.resolver);
  const agent = agents.find((entry) => entry.id === input.agentId && entry.filePath === target.filePath);
  if (!agent?.editable) throw new Error("Unknown, conflicted, invalid, or read-only agent.");
  const result = await updateAgentModel(target.resolver, await listModels(), input, target.filePath);
  target.fileRevision = result.fileRevision;
  return result;
}
