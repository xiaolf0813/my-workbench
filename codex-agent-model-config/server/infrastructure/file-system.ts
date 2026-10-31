import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function readFileRevision(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
