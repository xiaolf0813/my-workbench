export type AgentScope = "personal" | "project" | "builtin";

export type AgentModelConfiguration = {
  id: string;
  name: string;
  description: string;
  scope: AgentScope;
  editable: boolean;
  filePath: string | null;
  projectRoot: string | null;
  model: string | null;
  modelReasoningEffort: string | null;
  modelReasoningSummary: string | null;
  modelVerbosity: string | null;
  developerInstructions: string | null;
  fileRevision: string | null;
  parseError: string | null;
};
