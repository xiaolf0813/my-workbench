// Split TOML statements without mistaking strings, comments or collections for
// root assignments. Preserve raw setting statements, including multiline strings.
/** @param {string} text */
export function rootStatements(text) {
  const statements = [];
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0, quote = "", triple = false, depth = 0, comment = false;
  let commentStart = -1;
  for (let i = start; i <= text.length; i++) {
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
      commentStart = i;
      comment = true;
      continue;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if ((c === "\n" || c === undefined) && depth === 0) {
      const raw = text.slice(start, i).replace(/\r$/, "");
      if (/^[ \t]*\[/.test(raw)) break; // subsequent keys belong to a table
      const match = /^[ \t]*(?:([\w-]+)|"([\w-]+)"|'([\w-]+)')[ \t]*=/.exec(raw);
      if (raw.trim()) statements.push({ start, end: i, commentStart, key: match ? match[1] ?? match[2] ?? match[3] : null, raw });
      start = i + 1;
      commentStart = -1;
    }
  }
  return statements;
}
