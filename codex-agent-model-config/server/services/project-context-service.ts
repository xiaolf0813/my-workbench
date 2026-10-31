import { PathResolver } from "../infrastructure/path-resolver.js";

let activeProjectContext: PathResolver | null = null;

export function createProjectContext(input: {
  explicitCodexHome?: string | null;
  explicitProjectRoot?: string | null;
}): PathResolver {
  return new PathResolver(input.explicitCodexHome, input.explicitProjectRoot);
}

export function activateProjectContext(resolver: PathResolver): void {
  activeProjectContext = resolver;
}

export function requireActiveProjectContext(): PathResolver {
  if (!activeProjectContext) {
    throw new Error("Load the agent configurations before saving changes.");
  }
  return activeProjectContext;
}
