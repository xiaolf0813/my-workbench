import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PathResolver } from "../infrastructure/path-resolver.js";
import { withFileLockSync } from "../infrastructure/file-lock.js";
import { rootStatements } from "../infrastructure/root-statements.js";
import { replaceModelFields } from "../infrastructure/toml-editor.js";

export const PROFILE_NAMES = ["fast", "standard", "deep", "perceptive"] as const;
export type ProfileName = typeof PROFILE_NAMES[number];
export type ModelCandidate = { model: string; reasoningEffort?: string };
export type ModelConfiguration = {
  schemaVersion: 1;
  profiles: Record<ProfileName, ModelCandidate[]>;
  agents: Record<string, ProfileName | "auto">;
};

const DEFAULT_AGENTS: Record<string, ProfileName | "auto"> = {
  designer: "standard", driver: "standard", explorer: "fast", developer: "auto",
  intake: "fast", librarian: "standard", observer: "perceptive",
  spotter: "perceptive", oracle: "deep", improver: "deep",
};

export function emptyConfiguration(): ModelConfiguration {
  return {
    schemaVersion: 1,
    profiles: { fast: [], standard: [], deep: [], perceptive: [] },
    agents: { ...DEFAULT_AGENTS },
  };
}

function configPath(): string {
  return path.join(new PathResolver().codexHome, "my-workbench-config.json");
}

function revision(contents: string | null): string | null {
  return contents === null ? null : `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

export function validateConfiguration(value: unknown): ModelConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be an object.");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error("Unsupported configuration schemaVersion.");
  if (!input.profiles || typeof input.profiles !== "object" || Array.isArray(input.profiles)) throw new Error("Missing profiles.");
  const profiles = input.profiles as Record<string, unknown>;
  if (Object.keys(profiles).sort().join() !== [...PROFILE_NAMES].sort().join()) throw new Error("Profiles must be fast, standard, deep, and perceptive.");
  for (const name of PROFILE_NAMES) {
    const candidates = profiles[name];
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 20) throw new Error(`${name} needs 1 to 20 model candidates.`);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Invalid ${name} candidate.`);
      const entry = candidate as Record<string, unknown>;
      if (typeof entry.model !== "string" || !entry.model.trim() || entry.model.length > 128 || /[\r\n\0]/.test(entry.model)) throw new Error(`Invalid model in ${name}.`);
      if (entry.reasoningEffort !== undefined && (typeof entry.reasoningEffort !== "string" || !/^[a-z]+$/.test(entry.reasoningEffort))) throw new Error(`Invalid reasoning effort in ${name}.`);
      if (seen.has(entry.model)) throw new Error(`Duplicate model ${entry.model} in ${name}.`);
      seen.add(entry.model);
    }
  }
  if (!input.agents || typeof input.agents !== "object" || Array.isArray(input.agents)) throw new Error("Missing agents.");
  const agents = input.agents as Record<string, unknown>;
  if (Object.keys(agents).sort().join() !== Object.keys(DEFAULT_AGENTS).sort().join()) throw new Error("Agent assignments must cover the installed MyWorkbench roster.");
  for (const [name, profile] of Object.entries(agents)) {
    if (!PROFILE_NAMES.includes(profile as ProfileName) && !(name === "developer" && profile === "auto")) throw new Error(`Invalid profile for ${name}.`);
  }
  return value as ModelConfiguration;
}

export function getModelConfiguration() {
  const file = configPath();
  const contents = existsSync(file) ? readFileSync(file, "utf8") : null;
  return { path: file, configured: contents !== null, fileRevision: revision(contents), configuration: contents === null ? emptyConfiguration() : validateConfiguration(JSON.parse(contents)) };
}

export function saveModelConfiguration(value: unknown, expectedRevision: string | null) {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSync(file, () => {
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (revision(current) !== expectedRevision) throw new Error("Configuration changed since it was opened. Refresh before saving.");
  const validated = validateConfiguration(value);
  const contents = JSON.stringify(validated, null, 2) + "\n";
  const codexHome = new PathResolver().codexHome;
  const pinnedAgents: { file: string; source: string; cleaned: string; name: string }[] = [];
  for (const name of Object.keys(DEFAULT_AGENTS)) {
    const agentFile = path.join(codexHome, "agents", `${name}.toml`);
    if (!existsSync(agentFile)) continue;
    const source = readFileSync(agentFile, "utf8");
    if (!rootStatements(source).some(({ key }) => key === "model" || key === "model_reasoning_effort")) continue;
    pinnedAgents.push({ file: agentFile, source, cleaned: replaceModelFields(source, { model: null, model_reasoning_effort: null }), name });
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    if (pinnedAgents.length) {
      const backupDir = path.join(codexHome, "my-workbench-agent-model-backups");
      mkdirSync(backupDir, { recursive: true });
      for (const agent of pinnedAgents) {
        writeFileSync(path.join(backupDir, `${agent.name}-${randomUUID()}.toml`), agent.source, { encoding: "utf8", flag: "wx" });
        writeFileSync(agent.file, agent.cleaned, "utf8");
      }
    }
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    for (const agent of pinnedAgents) writeFileSync(agent.file, agent.source, "utf8");
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { saved: true, fileRevision: revision(contents), path: file };
  });
}
