const TOP_LEVEL_ASSIGNMENT = /^([A-Za-z0-9_-]+)(\s*)=(?!=)(.*)$/;

function scalarToToml(value: string): string {
  return JSON.stringify(value);
}

function unwrapBasicString(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function unwrapMultilineString(lines: string[], startIndex: number): { value: string; nextIndex: number } | null {
  const body: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length) {
    if (lines[index].trim() === '"""') {
      return { value: body.join("\n"), nextIndex: index + 1 };
    }
    body.push(lines[index]);
    index += 1;
  }
  return null;
}

export type ModelFields = {
  model?: string;
  model_reasoning_effort?: string;
  model_reasoning_summary?: string;
  model_verbosity?: string;
};

export type EditableToml = {
  lines: string[];
  fields: Map<string, string>;
};

function updateOrInsertField(lines: string[], key: string, value: string): string[] {
  const replacement = `${key} = ${scalarToToml(value)}`;
  let insertAt = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const match = TOP_LEVEL_ASSIGNMENT.exec(lines[index]);
    if (!match) continue;
    if (match[1] === key) {
      const next = lines.slice();
      next[index] = replacement;
      return next;
    }
    insertAt = index + 1;
  }
  const next = lines.slice();
  next.splice(insertAt, 0, replacement);
  return next;
}

export function parseEditableToml(source: string): EditableToml {
  const lines = source.split(/\r?\n/);
  const fields = new Map<string, string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") {
      index += 1;
      continue;
    }
    const match = TOP_LEVEL_ASSIGNMENT.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1];
    const right = match[3].trim();
    if (right === '"""') {
      const multiline = unwrapMultilineString(lines, index);
      if (multiline) {
        fields.set(key, multiline.value);
        index = multiline.nextIndex;
        continue;
      }
    }
    const scalar = unwrapBasicString(right);
    if (scalar !== null) fields.set(key, scalar);
    index += 1;
  }
  return { lines, fields };
}

export function replaceModelFields(source: string, updates: ModelFields): string {
  let lines = parseEditableToml(source).lines;
  for (const [key, value] of Object.entries(updates)) {
    lines = updateOrInsertField(lines, key, value);
  }
  return lines.join("\n");
}
