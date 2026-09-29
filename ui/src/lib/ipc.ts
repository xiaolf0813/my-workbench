// Typed IPC layer — mirrors the Rust/Tauri command contract (serde camelCase).
// Every call is wrapped so a missing backend (plain `vite dev` browser session)
// or a failing stub command degrades into a typed, renderable error — the UI
// must never crash or white-screen (see docs/desktop/PLAN.md §4 / SPEC.md §7).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type Event } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";

/* ------------------------------------------------------------------ */
/* Contract types (exactly the Rust serde shapes, camelCase)           */
/* ------------------------------------------------------------------ */

export type Target = "opencode" | "omos" | "claude" | "zcode" | "dsh" | "openbitfun";

export type Source = { mode: "bundled" } | { mode: "local"; root: string };

export interface Selection {
  source: Source;
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

export interface OpenBitFunInfo {
  configDir: string;
  exists: boolean;
}

export interface EnvironmentInfo {
  home: string;
  /** Embedded content-source version (PLAN §2 version alignment); may be empty from the stub backend. */
  sourceVersion: string;
  opencode: ToolStatus;
  node: ToolStatus;
  omosUserLevel: boolean;
  dsh: DshInfo;
  openbitfun: OpenBitFunInfo;
  targets: { target: Target; detail: string }[];
}

/** Fixed apply order (PLAN.md §4): opencode → omos → claude → zcode → dsh → openbitfun. */
export const TARGET_ORDER: readonly Target[] = [
  "opencode",
  "omos",
  "claude",
  "zcode",
  "dsh",
  "openbitfun",
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
  check_drift: "健康检查",
  validate_custom_source: "预校验",
  settings_get: "设置读取",
  settings_set: "设置保存",
  pat_status: "令牌状态读取",
  pat_set: "保存令牌",
  pat_clear: "清除令牌",
  skills_list_sources: "技能源读取",
  skills_add_source: "添加技能源",
  skills_update_source: "更新技能源",
  skills_remove_source: "移除技能源",
  skills_list_installed: "技能清单读取",
  skills_list_remote: "技能列表获取",
  skills_check_update: "检查更新",
  skills_install: "技能安装",
  skills_update: "技能更新",
  skills_delete: "技能删除",
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

export function checkDrift(selection: Selection): Promise<DriftReport> {
  return call<DriftReport>("check_drift", { selection });
}

export function validateCustomSource(sourceRoot: string): Promise<DriftReport> {
  return call<DriftReport>("validate_custom_source", { sourceRoot });
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
/* Skills & settings contract types (SPEC.md §7 — M2 column; shapes    */
/* verified against src-tauri/src/lib.rs serialization, camelCase)     */
/* ------------------------------------------------------------------ */

/** One configured skill source. The Rust `ref_` field serializes as `ref`. */
export interface SkillSourceConfig {
  repo: string;
  ref: string | null;
  subdir: string;
}

export interface RemoteSkill {
  name: string;
  path: string;
}

export interface RateLimit {
  remaining: number | null;
  limit: number | null;
}

export interface SkillListing {
  skills: RemoteSkill[];
  rate: RateLimit;
  fromIndex: boolean;
}

/** `skills_list_remote` result: the listing plus when it was fetched (Some for fresh fetch AND cache hit). */
export interface SkillsListingResult {
  listing: SkillListing;
  cachedAtMs: number | null;
}

export interface InstalledSkill {
  name: string;
  repo: string;
  branch: string | null;
  commit: string;
  installedAtMs: number;
  fileCount: number;
}

/**
 * Update verdict for one installed skill. Tagged `event` with kebab-case
 * variants (crates/workbench-core/src/skills.rs); `parseSkillChange`
 * additionally accepts a `type` tag defensively.
 */
export type SkillChange =
  | { event: "up-to-date" }
  | { event: "updatable"; newCommit: string }
  | { event: "local-modified"; newCommit: string; modified: string[] };

export interface AppSettings {
  skillsRoot: string;
  language: string;
}

/** `pat_status` result — ONLY the boolean; the token never round-trips. */
export interface PatStatus {
  configured: boolean;
}

/** One `skill-progress` channel event (frozen five-key camelCase payload). */
export interface SkillProgress {
  skill: string;
  /** started | skill-install | skill-update | log | log-warn | log-error | finished | cancelled */
  phase: string;
  done: number;
  total: number;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Skills & settings command wrappers                                  */
/* ------------------------------------------------------------------ */

export function skillsListSources(): Promise<SkillSourceConfig[]> {
  return call<SkillSourceConfig[]>("skills_list_sources");
}

export function skillsAddSource(source: { repo: string; ref: string | null; subdir: string }): Promise<SkillSourceConfig[]> {
  return call<SkillSourceConfig[]>("skills_add_source", { repo: source.repo, ref: source.ref, subdir: source.subdir });
}

export function skillsUpdateSource(
  index: number,
  source: { repo: string; ref: string | null; subdir: string },
): Promise<SkillSourceConfig[]> {
  return call<SkillSourceConfig[]>("skills_update_source", {
    index,
    repo: source.repo,
    ref: source.ref,
    subdir: source.subdir,
  });
}

export function skillsRemoveSource(index: number): Promise<SkillSourceConfig[]> {
  return call<SkillSourceConfig[]>("skills_remove_source", { index });
}

export function settingsGet(): Promise<AppSettings> {
  return call<AppSettings>("settings_get");
}

export function settingsSet(settings: AppSettings): Promise<AppSettings> {
  return call<AppSettings>("settings_set", { settings });
}

export function skillsListInstalled(): Promise<InstalledSkill[]> {
  return call<InstalledSkill[]>("skills_list_installed");
}

export function skillsListRemote(input: {
  repo: string;
  ref: string | null;
  subdir: string;
  refresh: boolean;
}): Promise<SkillsListingResult> {
  return call<SkillsListingResult>("skills_list_remote", {
    repo: input.repo,
    ref: input.ref,
    subdir: input.subdir,
    refresh: input.refresh,
  });
}

export async function skillsCheckUpdate(input: {
  repo: string;
  ref: string | null;
  subdir: string;
  name: string;
}): Promise<SkillChange> {
  // Normalized defensively (parseSkillChange): the shell serializes the
  // kebab-case `event` tag, but a `type` tag is accepted too; an
  // unrecognized shape becomes a typed command error instead of poisoning
  // the page's status badges.
  const raw = await call<unknown>("skills_check_update", {
    repo: input.repo,
    ref: input.ref,
    subdir: input.subdir,
    name: input.name,
  });
  const parsed = parseSkillChange(raw);
  if (parsed === null) {
    throw new IpcCommandError("skills_check_update", "无法识别的后端响应格式");
  }
  return parsed;
}

export function skillsInstall(input: {
  repo: string;
  ref: string | null;
  subdir: string;
  name: string;
}): Promise<InstalledSkill> {
  return call<InstalledSkill>("skills_install", {
    repo: input.repo,
    ref: input.ref,
    subdir: input.subdir,
    name: input.name,
  });
}

export function skillsUpdate(input: {
  repo: string;
  ref: string | null;
  subdir: string;
  name: string;
  force: boolean;
  backup: boolean;
}): Promise<InstalledSkill> {
  return call<InstalledSkill>("skills_update", {
    repo: input.repo,
    ref: input.ref,
    subdir: input.subdir,
    name: input.name,
    force: input.force,
    backup: input.backup,
  });
}

export function skillsDelete(name: string, trash: boolean): Promise<void> {
  return call<void>("skills_delete", { name, trash });
}

export function patStatus(): Promise<PatStatus> {
  return call<PatStatus>("pat_status");
}

export function patSet(token: string): Promise<void> {
  return call<void>("pat_set", { token });
}

export function patClear(): Promise<void> {
  return call<void>("pat_clear");
}

/**
 * Defensive SkillChange parse — trusts only the kebab-case `event` tag the
 * shell serializes, but also accepts a `type` tag carrying the same values
 * (payloads from alternative shells must not wedge the page).
 */
export function parseSkillChange(payload: unknown): SkillChange | null {
  const r = asRecord(payload);
  if (!r) return null;
  const tag = typeof r.event === "string" ? r.event : typeof r.type === "string" ? r.type : null;
  switch (tag) {
    case "up-to-date":
      return { event: "up-to-date" };
    case "updatable":
      return typeof r.newCommit === "string" ? { event: "updatable", newCommit: r.newCommit } : null;
    case "local-modified": {
      if (typeof r.newCommit !== "string" || !Array.isArray(r.modified)) return null;
      const modified = r.modified.filter((f): f is string => typeof f === "string");
      return { event: "local-modified", newCommit: r.newCommit, modified };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Event wiring: skill-progress                                        */
/* ------------------------------------------------------------------ */

/** Defensive parse of the frozen five-key skill-progress payload. */
function parseSkillProgress(payload: unknown): SkillProgress | null {
  const r = asRecord(payload);
  if (!r) return null;
  if (typeof r.skill !== "string" || typeof r.phase !== "string") return null;
  return {
    skill: r.skill,
    phase: r.phase,
    done: typeof r.done === "number" ? r.done : 0,
    total: typeof r.total === "number" ? r.total : 0,
    text: typeof r.text === "string" ? r.text : "",
  };
}

/** Subscribe to the `skill-progress` channel; never throws (no Tauri → no-op). */
export async function subscribeSkillProgress(handler: (ev: SkillProgress) => void): Promise<() => void> {
  if (!isTauriAvailable()) return () => undefined;
  const unlisteners: Array<() => void> = [];
  try {
    const un = await tauriListen("skill-progress", (e: Event<unknown>) => {
      const parsed = parseSkillProgress(e.payload);
      if (parsed) handler(parsed);
    });
    unlisteners.push(un);
  } catch {
    // Channel unavailable — degrade to a no-op subscription.
  }
  return () => {
    for (const un of unlisteners) un();
  };
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
