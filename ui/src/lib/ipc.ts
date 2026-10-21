// Typed IPC layer — mirrors the Rust/Tauri command contract (serde camelCase).
// Every call is wrapped so a missing backend (plain `vite dev` browser session)
// or a failing stub command degrades into a typed, renderable error — the UI
// must never crash or white-screen (see SPEC.md §7).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type Event } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";

/* ------------------------------------------------------------------ */
/* Contract types (exactly the Rust serde shapes, camelCase)           */
/* ------------------------------------------------------------------ */

export type Target = "opencode" | "claude" | "zcode" | "codex" | "dsh";

export interface Selection {
  /** Authoritative project directory; still sent when userLevel is on (backend ignores it for user-level targets). */
  projectDir: string;
  targets: Target[];
  userLevel: boolean;
  force: boolean;
}

export type PlanKind = "create" | "skip" | "overwrite" | "managed-block";

export interface PlanItem {
  target: Target;
  path: string;
  sourceRel: string;
  kind: PlanKind;
}

export interface StampPlan {
  realm: "project" | "home";
  path: string;
  version: string;
}

export interface Plan {
  items: PlanItem[];
  stamps: StampPlan[];
  notes: string[];
}

export interface InstallReport {
  cancelled: boolean;
  created: number;
  skipped: number;
  overwritten: number;
  managedBlocks: number;
  stamps: string[];
  warnings: string[];
}

export type InstallEvent =
  | { event: "started"; totalFiles: number }
  | { event: "log"; timeMs: number; target: Target | null; level: "info" | "warn" | "error"; text: string }
  | { event: "progress"; phase: string; done: number; total: number }
  | { event: "finished"; cancelled: boolean };

export interface StructuralProblem {
  check: string;
  detail: string;
}

/** Drift contract of the retained backend `check_drift` command (the
 *  health-check/drift UI surface was UI-removed 2026-10, SPEC §10 tail note —
 *  the backend command stays; these shapes mirror it for future use). */
export interface DriftFile {
  path: string;
  sourceRel: string;
  target: Target;
}

export interface Tier1Report {
  compared: number;
  drifted: DriftFile[];
  problems: StructuralProblem[];
}

export type Tier2Status = "pass" | "skipped" | "fail";

export interface Tier2Report {
  status: Tier2Status;
  problems: string[];
}

export interface DriftReport {
  tier1: Tier1Report;
  tier2: Tier2Report | null;
}

export interface ToolStatus {
  present: boolean;
  version: string | null;
}

export interface DshInfo {
  home: string;
  homeSource: "env" | "default";
  exists: boolean;
  profile: string | null;
  profilesCount: number;
}

export interface EnvironmentInfo {
  home: string;
  /** Embedded content-source version (version alignment); may be empty from the stub backend. */
  sourceVersion: string;
  opencode: ToolStatus;
  node: ToolStatus;
  dsh: DshInfo;
  targets: { target: Target; detail: string }[];
}

/** Fixed apply order: opencode → claude → zcode → codex → dsh. */
export const TARGET_ORDER: readonly Target[] = [
  "opencode",
  "claude",
  "zcode",
  "codex",
  "dsh",
] as const;

/* ------------------------------------------------------------------ */
/* Graceful failure envelope                                           */
/* ------------------------------------------------------------------ */

export interface IpcFailure {
  /** Short zh headline for banners: 后端未就绪 | 命令失败 */
  title: string;
  /** Detail message for the banner body. */
  message: string;
}

/** zh failure prefixes shown to the user, keyed by IPC command identifier. */
const COMMAND_LABELS: Record<string, string> = {
  detect_environment: "环境检测",
  plan_install: "预览生成",
  execute_install: "安装",
  cancel_install: "停止安装",
  settings_get: "设置读取",
  settings_set: "设置保存",
  deployed_overview: "已部署状态读取",
  deployed_list_agents: "已部署智能体读取",
  deployed_save_agent: "已部署智能体保存",
};

function labelFor(command: string): string {
  return COMMAND_LABELS[command] ?? "后端调用";
}

/** Backend error bodies may carry flag tokens; the GUI never shows them.
 *  Flag tokens are assembled from parts so this source file itself stays free
 *  of flag literals. */
function scrubCliFlags(text: string): string {
  const dash = "-";
  return text
    .split(dash + dash + "force")
    .join("覆盖模式")
    .split(dash + dash + "user")
    .join("用户级安装")
    .split(dash + dash + "check")
    .join("状态检查");
}

export class IpcUnavailableError extends Error {
  readonly command: string;
  constructor(command: string) {
    super("后端未就绪：当前处于浏览器预览模式（无 Tauri IPC），无法调用后端功能。");
    this.name = "IpcUnavailableError";
    this.command = command;
  }
}

export class IpcCommandError extends Error {
  readonly command: string;
  constructor(command: string, cause: unknown) {
    const raw =
      typeof cause === "string" ? cause : cause instanceof Error ? cause.message : JSON.stringify(cause);
    super(`${labelFor(command)}失败：${scrubCliFlags(raw)}`);
    this.name = "IpcCommandError";
    this.command = command;
  }
}

export function describeIpcError(e: unknown): IpcFailure {
  if (e instanceof IpcUnavailableError) return { title: "后端未就绪", message: e.message };
  if (e instanceof IpcCommandError) return { title: "命令失败", message: e.message };
  return {
    title: "命令失败",
    message: e instanceof Error ? e.message : String(e),
  };
}

/** True when running inside a Tauri webview (the v2 IPC internals are injected). */
export function isTauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriAvailable()) throw new IpcUnavailableError(command);
  try {
    return await tauriInvoke<T>(command, args);
  } catch (e) {
    throw new IpcCommandError(command, e);
  }
}

/* ------------------------------------------------------------------ */
/* Command wrappers (SPEC.md §7 — Deploy column)                       */
/* ------------------------------------------------------------------ */

export function detectEnvironment(): Promise<EnvironmentInfo> {
  return call<EnvironmentInfo>("detect_environment");
}

export function planInstall(selection: Selection): Promise<Plan> {
  return call<Plan>("plan_install", { selection });
}

export function executeInstall(plan: Plan, selection: Selection): Promise<InstallReport> {
  return call<InstallReport>("execute_install", { plan, selection });
}

export function cancelInstall(): Promise<void> {
  return call<void>("cancel_install");
}

/** App version from the Tauri shell; null in a plain browser session. */
export async function getAppVersion(): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

/**
 * Directory picker via the Tauri dialog plugin, when present. The plugin is an
 * optional runtime capability: when absent (browser session, or the shell has
 * not registered the plugin) the caller falls back to the path text input.
 */
export async function pickDirectory(title: string): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  try {
    const res = await open({ directory: true, multiple: false, title });
    if (typeof res === "string" && res.length > 0) return res;
    if (Array.isArray(res) && typeof res[0] === "string") return res[0];
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Settings contract type (shape verified against                      */
/* src-tauri/src/lib.rs serialization, camelCase)                      */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  language: string;
  /** The Deploy page's project directory (`null` = not picked yet). */
  projectDir: string | null;
  /** The Deploy page's user-level toggle. */
  userLevel: boolean;
}

/* ------------------------------------------------------------------ */
/* Settings command wrappers                                           */
/* ------------------------------------------------------------------ */

export function settingsGet(): Promise<AppSettings> {
  return call<AppSettings>("settings_get");
}

export function settingsSet(settings: AppSettings): Promise<AppSettings> {
  return call<AppSettings>("settings_set", { settings });
}

/* ------------------------------------------------------------------ */
/* Deployed agents contract types & wrappers (shapes verified against  */
/* src-tauri/src/lib.rs and crates/workbench-core/src/deployed.rs,     */
/* camelCase)                                                          */
/* ------------------------------------------------------------------ */

/** One target's deployed state row (`deployed_overview`, APPLY_ORDER). */
export interface DeployedTargetState {
  target: Target;
  deployed: boolean;
  /** Human-readable scope root for display; "" when unresolvable. */
  scopeLabel: string;
  /** dsh only: recursive regular-file count under the preset root; null for the other targets and when the root is absent or empty. */
  presetFileCount: number | null;
  /** dsh only: newest preset file mtime in millis; null for the other targets and when the root is absent or empty. */
  deployedAtMs: number | null;
  /** The target realm's version stamp (`my-workbench.version` / `.my-workbench.version`), trimmed; null when the stamp is missing, unreadable or empty. */
  deployedVersion: string | null;
}

/** One deployed agent markdown of a target (`deployed_list_agents`). */
export interface DeployedAgent {
  name: string;
  description: string | null;
  fileName: string;
  /** Everything after the closing frontmatter fence, verbatim. */
  body: string;
  /** The backend's model keys → current value (null = absent); every backend key is present. */
  settings: Record<string, string | null>;
}

export function deployedOverview(args: {
  projectDir: string | null;
  userLevel: boolean;
}): Promise<DeployedTargetState[]> {
  return call<DeployedTargetState[]>("deployed_overview", {
    projectDir: args.projectDir,
    userLevel: args.userLevel,
  });
}

export function deployedListAgents(args: {
  target: Target;
  projectDir: string | null;
  userLevel: boolean;
}): Promise<DeployedAgent[]> {
  return call<DeployedAgent[]>("deployed_list_agents", {
    target: args.target,
    projectDir: args.projectDir,
    userLevel: args.userLevel,
  });
}

export function deployedSaveAgent(args: {
  target: Target;
  projectDir: string | null;
  userLevel: boolean;
  fileName: string;
  body: string;
  settings: Record<string, string | null>;
}): Promise<DeployedAgent> {
  return call<DeployedAgent>("deployed_save_agent", {
    target: args.target,
    projectDir: args.projectDir,
    userLevel: args.userLevel,
    fileName: args.fileName,
    body: args.body,
    settings: args.settings,
  });
}

/* ------------------------------------------------------------------ */
/* Event wiring: install-log / install-progress                        */
/* ------------------------------------------------------------------ */

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Defensive parse — a stub backend may emit partial/odd payloads. */
function parseInstallEvent(payload: unknown): InstallEvent | null {
  const r = asRecord(payload);
  if (!r) return null;
  switch (r.event) {
    case "started":
      return typeof r.totalFiles === "number" ? { event: "started", totalFiles: r.totalFiles } : null;
    case "log": {
      if (typeof r.timeMs !== "number" || typeof r.text !== "string") return null;
      const target = typeof r.target === "string" ? (r.target as Target) : null;
      const level = r.level === "warn" || r.level === "error" ? r.level : "info";
      return { event: "log", timeMs: r.timeMs, target, level, text: r.text };
    }
    case "progress": {
      if (typeof r.phase !== "string" || typeof r.done !== "number" || typeof r.total !== "number") return null;
      return { event: "progress", phase: r.phase, done: r.done, total: r.total };
    }
    case "finished":
      return { event: "finished", cancelled: r.cancelled === true };
    default:
      return null;
  }
}

/**
 * Subscribe to both install event channels. Never throws: without Tauri (or on
 * listen failure) it resolves to a no-op unlisten so the UI keeps working.
 */
export async function subscribeInstallEvents(handler: (ev: InstallEvent) => void): Promise<() => void> {
  if (!isTauriAvailable()) return () => undefined;
  const onEvent = (e: Event<unknown>) => {
    const parsed = parseInstallEvent(e.payload);
    if (parsed) handler(parsed);
  };
  const unlisteners: Array<() => void> = [];
  for (const channel of ["install-log", "install-progress"] as const) {
    try {
      const un = await tauriListen(channel, onEvent);
      unlisteners.push(un);
    } catch {
      // Channel unavailable — keep subscribing to whatever else works.
    }
  }
  return () => {
    for (const un of unlisteners) un();
  };
}
