import type { AgentModelConfiguration } from "../domain/agent-config.js";
import type { PathResolver } from "../infrastructure/path-resolver.js";

// Keep the latest snapshot per file. Revisions include the path, so identical
// templates in separate projects can be edited independently in the same server.
type ScanTarget = { resolver: PathResolver; agentId: string; filePath: string; fileRevision: string };
const scanned = new Map<string, ScanTarget>();

export function rememberScan(resolver: PathResolver, agents: AgentModelConfiguration[]) {
  for (const agent of agents) {
    if (!agent.filePath) continue;
    if (!agent.editable || !agent.fileRevision) {
      scanned.delete(agent.filePath);
      continue;
    }
    scanned.set(agent.filePath, { resolver, agentId: agent.id, filePath: agent.filePath, fileRevision: agent.fileRevision });
  }
}

export function requireScanTarget(agentId: string, fileRevision: string): ScanTarget {
  for (const target of scanned.values()) {
    if (target.agentId === agentId && target.fileRevision === fileRevision) return target;
  }
  throw new Error("This agent snapshot is stale or unknown. Refresh before saving.");
}
