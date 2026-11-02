import path from "node:path";
import type { AgentModelConfiguration, AgentScope } from "../domain/agent-config.js";
import { listTomlFiles, readFileRevision, readUtf8 } from "../infrastructure/file-system.js";
import { PathResolver, normalizeAgentName } from "../infrastructure/path-resolver.js";
import { parseEditableToml } from "../infrastructure/toml-editor.js";

const BUILTIN_AGENTS = [
  {
    name: "default",
    description: "Built-in Codex agent. Uses parent or global default model settings.",
  },
  {
    name: "worker",
    description: "Built-in Codex worker agent. Uses parent or global default model settings.",
  },
  {
    name: "explorer",
    description: "Built-in Codex explorer agent. Uses parent or global default model settings.",
  },
];

function deriveNameFromFile(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function modelString(fields: Map<string, string>, key: string): string | null {
  return fields.get(key) ?? null;
}

function invalid(message: string): Error {
  return new Error(message);
}

function markNameConflicts(agents: AgentModelConfiguration[]): void {
  const byName = new Map<string, AgentModelConfiguration[]>();
  for (const agent of agents) {
    const key = normalizeAgentName(agent.name);
    const group = byName.get(key) ?? [];
    group.push(agent);
    byName.set(key, group);
  }
  for (const group of byName.values()) {
    if (group.length <= 1) continue;
    for (const agent of group) {
      agent.editable = false;
      agent.parseError = "Duplicate agent name in this scope. Fix the duplicate name manually before editing.";
      agent.developerInstructions = null;
    }
  }
}

async function readScope(
  scope: Exclude<AgentScope, "builtin">,
  directory: string,
  projectRoot: string | null,
): Promise<AgentModelConfiguration[]> {
  const files = await listTomlFiles(directory);
  const agents: AgentModelConfiguration[] = [];
  for (const filePath of files) {
    let fileRevision: string | null = null;
    let source: string;
    let readError: string | null = null;
    try {
      source = await readUtf8(filePath);
      fileRevision = await readFileRevision(filePath);
    } catch (error) {
      source = "";
      readError = error instanceof Error ? error.message : "Unable to read the agent file.";
    }

    const editable = readError === null;
    let name = deriveNameFromFile(filePath);
    let description = "";
    let developerInstructions: string | null = null;
    let parseError = readError;
    let model: string | null = null;
    let modelReasoningEffort: string | null = null;
    let modelReasoningSummary: string | null = null;
    let modelVerbosity: string | null = null;

    if (editable) {
      try {
        const parsed = parseEditableToml(source);
        name = parsed.fields.get("name")?.trim() ?? "";
        description = parsed.fields.get("description")?.trim() ?? "";
        developerInstructions = parsed.fields.get("developer_instructions")?.trim() ?? "";
        model = modelString(parsed.fields, "model");
        modelReasoningEffort = modelString(parsed.fields, "model_reasoning_effort");
        modelReasoningSummary = modelString(parsed.fields, "model_reasoning_summary");
        modelVerbosity = modelString(parsed.fields, "model_verbosity");
        if (!name || !description || !developerInstructions) {
          throw invalid("The agent file must contain name, description, and developer_instructions.");
        }
      } catch (error) {
        parseError = error instanceof Error ? error.message : "Unable to parse the agent file.";
      }
    }

    agents.push({
      id: `${scope}:${encodeURIComponent(normalizeAgentName(name))}`,
      name,
      description,
      scope,
      editable: editable && parseError === null,
      filePath,
      projectRoot: scope === "project" ? projectRoot : null,
      model,
      modelReasoningEffort,
      modelReasoningSummary,
      modelVerbosity,
      developerInstructions,
      fileRevision,
      parseError,
    });
  }
  markNameConflicts(agents);
  return agents;
}

function builtinConfigurations(resolver: PathResolver): AgentModelConfiguration[] {
  return BUILTIN_AGENTS.map((agent) => ({
    id: `builtin:${agent.name}`,
    name: agent.name,
    description: agent.description,
    scope: "builtin" as const,
    editable: false,
    filePath: null,
    projectRoot: null,
    model: null,
    modelReasoningEffort: null,
    modelReasoningSummary: null,
    modelVerbosity: null,
    developerInstructions: null,
    fileRevision: null,
    parseError: null,
  }));
}

export async function getAgentConfigurations(
  resolver: PathResolver,
): Promise<{ agents: AgentModelConfiguration[] }> {
  const personal = await readScope("personal", resolver.personalAgentsDirectory, null);
  const project = resolver.projectAgentsDirectory
    ? await readScope("project", resolver.projectAgentsDirectory, resolver.projectRoot)
    : [];
  return {
    agents: [...personal, ...project, ...builtinConfigurations(resolver)],
  };
}
