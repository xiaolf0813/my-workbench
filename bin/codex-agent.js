/** Codex standalone-agent TOML helpers. No dependencies or config.toml writes. */
export const CODEX_MODEL_KEYS = ["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity"];

// Split TOML statements without mistaking strings, comments or collections for
// root assignments. Preserve raw setting statements, including multiline strings.
export function rootStatements(text) {
  const statements = [];
  let start = 0, quote = "", triple = false, depth = 0, comment = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (comment) {
      if (c !== "\n" && c !== undefined) continue;
      comment = false;
    } else if (quote) {
      if (quote === '"' && c === "\\") { i++; continue; }
      if (triple ? text.slice(i, i + 3) === quote.repeat(3) : c === quote) {
        if (triple) while (text[i + 1] === quote) i++;
        quote = "";
      }
      continue;
    } else if (c === '"' || c === "'") {
      quote = c;
      triple = text.slice(i, i + 3) === c.repeat(3);
      if (triple) i += 2;
      continue;
    } else if (c === "#") {
      comment = true;
      continue;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if ((c === "\n" || c === undefined) && depth === 0) {
      const raw = text.slice(start, i).replace(/\r$/, "");
      if (/^[ \t]*\[/.test(raw)) break; // subsequent keys belong to a table
      const match = /^[ \t]*(?:([\w-]+)|"([\w-]+)"|'([\w-]+)')[ \t]*=/.exec(raw);
      if (raw.trim()) statements.push({ key: match ? match[1] ?? match[2] ?? match[3] : null, raw });
      start = i + 1;
    }
  }
  return statements;
}

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
