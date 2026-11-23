import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function revisionForFile(filePath: string, source: string): string {
  const digest = createHash("sha256").update(path.resolve(filePath)).update("\0").update(source).digest("hex");
  return `sha256:${digest}`;
}

export async function readUtf8(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf8");
}

export async function listTomlFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"))
      .map((entry) => path.join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}
