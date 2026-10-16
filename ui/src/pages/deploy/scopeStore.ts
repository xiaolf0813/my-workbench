// App-wide deploy scope (SPEC §4.3): the 项目级/用户级 realm toggle and the
// project directory, shared 1:1 by the page scope bar and the deploy dialog's
// 安装位置 section and sent as `userLevel`/`projectDir` in every deployed_*/
// plan/execute call. Module-level store (notes §3): snapshot + subscribe for
// useSyncExternalStore, persisted synchronously to localStorage (restored at
// boot) and durably to the backend settings file via settingsGet/settingsSet.
import { settingsGet, settingsSet } from "../../lib/ipc";

export interface ScopeState {
  /** true = 用户级 (install to the user config directory). */
  userLevel: boolean;
  /** The picked project directory; "" = not picked yet. */
  projectDir: string;
}

const STORAGE_KEY = "workbench.deploy.scope";

function readLocal(): ScopeState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const r = parsed as Record<string, unknown>;
        return {
          userLevel: r.userLevel === true,
          projectDir: typeof r.projectDir === "string" ? r.projectDir : "",
        };
      }
    }
  } catch {
    // Unreadable cache — fall through to defaults.
  }
  return { userLevel: false, projectDir: "" };
}

let state: ScopeState = readLocal();
const listeners = new Set<() => void>();

export function getScope(): ScopeState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: ScopeState): void {
  if (next.userLevel === state.userLevel && next.projectDir === state.projectDir) return;
  state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — the in-memory store still serves this session.
  }
  for (const l of listeners) l();
  void persistToBackend(state);
}

export function setUserLevel(userLevel: boolean): void {
  commit({ ...state, userLevel });
}

export function setProjectDir(projectDir: string): void {
  commit({ ...state, projectDir });
}

/** The trimmed project directory as sent to the backend (`null` = unset). */
export function projectDirArg(): string | null {
  const dir = state.projectDir.trim();
  return dir === "" ? null : dir;
}

let persistChain: Promise<unknown> = Promise.resolve();

/** Read-modify-write of the backend settings file (never clobbers other keys). */
function persistToBackend(scope: ScopeState): Promise<unknown> {
  persistChain = persistChain.then(async () => {
    try {
      const current = await settingsGet();
      await settingsSet({
        language: current.language,
        projectDir: scope.projectDir,
        userLevel: scope.userLevel,
      });
    } catch {
      // Best-effort durability: localStorage already covers this session and
      // the next reconcile adopts the backend values when the cache is absent.
    }
  });
  return persistChain;
}

/**
 * Boot reconciliation: when the localStorage cache has never been written,
 * adopt the backend's persisted values (the durable source); when it has, push
 * the cached values back so the backend file agrees with what the UI shows.
 */
export async function reconcileWithBackend(): Promise<void> {
  let backend: Awaited<ReturnType<typeof settingsGet>> | null = null;
  try {
    backend = await settingsGet();
  } catch {
    return; // Backend unavailable — localStorage defaults stand.
  }
  const hadCache = window.localStorage.getItem(STORAGE_KEY) !== null;
  if (!hadCache) {
    const next: ScopeState = {
      userLevel: backend.userLevel === true,
      projectDir: typeof backend.projectDir === "string" ? backend.projectDir : "",
    };
    if (next.userLevel !== state.userLevel || next.projectDir !== state.projectDir) {
      state = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Ignore — memory state still applies.
      }
      for (const l of listeners) l();
    }
    return;
  }
  await persistToBackend(state);
}
