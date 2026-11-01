import { getAgentConfigurations } from "../services/agent-config-service.js";
import { activateProjectContext, createProjectContext } from "../services/project-context-service.js";

export type GetAgentConfigurationsInput = {
  projectRoot?: string;
};

export async function getAgentConfigurationsTool(input: GetAgentConfigurationsInput) {
  const resolver = createProjectContext({ explicitProjectRoot: input.projectRoot ?? null });
  const result = await getAgentConfigurations(resolver);
  activateProjectContext(resolver);
  return result;
}
