import { rootStatements } from "../agents/backends/codex/subagent-config/server/infrastructure/root-statements.js";
export { rootStatements };

/** Codex standalone-agent TOML helpers. No dependencies or config.toml writes. */
export const CODEX_MODEL_KEYS = ["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity"];

export function preserveCodexSettings(previous, fresh) {
  if (previous === null) return fresh;
  const saved = rootStatements(previous).filter(({ key }) => CODEX_MODEL_KEYS.includes(key));
  if (saved.length === 0) return fresh;
  const remove = new Set(saved.map(({ key }) => key));
  const body = rootStatements(fresh).filter(({ key }) => !remove.has(key)).map(({ raw }) => raw);
  return [...saved.map(({ raw }) => raw), ...body].join("\n") + "\n";
}

export function renderCodexAgent(name, description, lines, body, leaf, disciplines) {
  const metadata = lines.map((line) => line === "@description" ? `description = ${JSON.stringify(description)}` : line);
  if (!metadata.includes(`name = ${JSON.stringify(name)}`)) throw new Error(`Codex agent '${name}' must declare its roster name`);
  return `${metadata.join("\n")}\ndeveloper_instructions = ${JSON.stringify(`${body.replace(/\s+$/, "")}\n\n${leaf.trim()}${disciplines}\n`)}\n`;
}
