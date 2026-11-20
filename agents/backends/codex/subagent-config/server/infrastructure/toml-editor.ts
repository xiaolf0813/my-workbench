import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { rootStatements } from "./root-statements.js";

export type ModelFields = {
  model?: string | null;
  model_reasoning_effort?: string | null;
  model_reasoning_summary?: string | null;
  model_verbosity?: string | null;
};

export function parseEditableToml(source: string) {
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(parse(source))) {
    if (typeof value === "string") fields.set(key, value);
  }
  return { fields };
}

export function replaceModelFields(source: string, updates: ModelFields): string {
  const expected = parse(source);
  const pending = new Map(Object.entries(updates));
  for (const [key, value] of pending) {
    if (value === null) delete expected[key];
    else expected[key] = value;
  }

  // Edit from the end so offsets always refer to the original document.
  let result = source;
  for (const { start, end, raw, commentStart, key } of rootStatements(source).reverse()) {
    // The parser also recognizes escaped quoted keys, e.g. "mo\u0064el".
    const name = key ?? Object.keys(parse(raw))[0];
    const value = pending.get(name);
    if (value === undefined) continue;
    pending.delete(name);
    const equals = raw.indexOf("=");
    const valueStart = equals + 1 + (raw.slice(equals + 1).match(/^[ \t]*/)?.[0].length ?? 0);
    const valueEnd = source.slice(start, commentStart < start ? end : commentStart).trimEnd().length + start;
    if (value === null) {
      // Keep an inline comment as a standalone comment.
      const after = commentStart >= start ? commentStart : Math.min(source.length, end + 1);
      result = result.slice(0, start) + result.slice(after);
    } else {
      result = result.slice(0, start + valueStart) + JSON.stringify(value) + result.slice(valueEnd);
    }
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const prefix = [...pending].filter(([, value]) => value !== null)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}${newline}`).join("");
  const bomLength = source.startsWith("\ufeff") ? 1 : 0;
  result = result.slice(0, bomLength) + prefix + result.slice(bomLength);
  if (!isDeepStrictEqual(parse(result), expected)) {
    throw new Error("Could not update only the requested top-level model settings.");
  }
  return result;
}
