import { PathResolver } from "../infrastructure/path-resolver.js";
import { getAgentConfigurations } from "../services/agent-config-service.js";
import { rememberScan } from "../services/project-context-service.js";

export async function getAgentConfigurationsTool(input: { projectRoot?: string }) {
  const resolver = new PathResolver(null, input.projectRoot);
  const result = await getAgentConfigurations(resolver);
  rememberScan(resolver, result.agents);
  return result;
}
