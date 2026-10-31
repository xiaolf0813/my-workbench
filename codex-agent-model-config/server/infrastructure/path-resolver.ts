import { homedir } from "node:os";
import path from "node:path";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function normalize(inputPath: string): string {
  return path.normalize(inputPath.trim());
}

function isSafeConfiguredPath(inputPath: string): boolean {
  const normalized = normalize(inputPath);
  return normalized !== "." && (path.isAbsolute(normalized) || WINDOWS_ABSOLUTE.test(normalized));
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!(relative.startsWith("..") && !path.isAbsolute(relative)) && relative !== "");
}

export function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

export class PathResolver {
  readonly codexHome: string;
  readonly projectRoot: string | null;

  constructor(explicitCodexHome?: string | null, explicitProjectRoot?: string | null) {
    const candidates = [explicitCodexHome, process.env.CODEX_HOME, path.join(homedir(), ".codex")];
    const home = candidates.find((candidate): candidate is string =>
      Boolean(candidate && isSafeConfiguredPath(candidate)),
    );
    if (!home) throw new Error("Unable to resolve a valid Codex home directory.");
    this.codexHome = normalize(home);
    this.projectRoot =
      explicitProjectRoot && isSafeConfiguredPath(explicitProjectRoot) ? normalize(explicitProjectRoot) : null;
  }

  get personalAgentsDirectory(): string {
    return path.join(this.codexHome, "agents");
  }

  get projectAgentsDirectory(): string | null {
    return this.projectRoot ? path.join(this.projectRoot, ".codex", "agents") : null;
  }

  validateScannedAgentPath(agentId: string, filePath: string): string | null {
    const separator = agentId.indexOf(":");
    if (separator <= 0) return null;
    const scope = agentId.slice(0, separator);
    const directory = scope === "personal"
      ? this.personalAgentsDirectory
      : scope === "project"
        ? this.projectAgentsDirectory
        : null;
    if (!directory) return null;
    const normalizedDirectory = path.resolve(directory);
    const normalizedFile = path.resolve(filePath);
    if (path.dirname(normalizedFile) !== normalizedDirectory) return null;
    if (path.extname(normalizedFile).toLowerCase() !== ".toml") return null;
    return isInside(normalizedDirectory, normalizedFile) ? normalizedFile : null;
  }

  resolveAgentPath(agentId: string): string | null {
    const separator = agentId.indexOf(":");
    if (separator <= 0 || separator === agentId.length - 1) return null;
    const scope = agentId.slice(0, separator);
    const encodedName = agentId.slice(separator + 1);
    if (scope !== "personal" && scope !== "project") return null;
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(encodedName);
    } catch {
      return null;
    }
    if (!decodedName || decodedName !== normalizeAgentName(decodedName) || decodedName.includes("/") || decodedName.includes("\\")) {
      return null;
    }
    if (scope === "personal") {
      const filePath = path.join(this.personalAgentsDirectory, `${encodedName}.toml`);
      return isInside(this.personalAgentsDirectory, filePath) ? filePath : null;
    }
    if (!this.projectAgentsDirectory) return null;
    const filePath = path.join(this.projectAgentsDirectory, `${encodedName}.toml`);
    return isInside(this.projectAgentsDirectory, filePath) ? filePath : null;
  }
}
