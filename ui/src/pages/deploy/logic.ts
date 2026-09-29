// Deploy-area helpers: plan-table derivation, DSH detection states (SPEC §10.5),
// formatters. Pure functions only — no React, no IPC.
import { TARGET_ORDER } from "../../lib/ipc";
import type { DshInfo, EnvironmentInfo, InstallReport, Plan, PlanKind, Selection, Source, Target } from "../../lib/ipc";

export type TabId = "preview" | "log" | "health";
export type RunState = "idle" | "running" | "success" | "failed" | "cancelled";
export type PlanFilter = "all" | PlanKind;

export interface LogLine {
  id: number;
  ts: string;
  tg: string;
  /** mockup line class: "" | "warn" | "err" */
  cls: string;
  text: string;
}

export interface ProgressState {
  phase: string;
  done: number;
  total: number;
}

/** Terminal state rendered as the in-flow report card at the log end (SPEC §3.9). */
export interface TerminalReport {
  kind: "ok" | "err" | "cancel";
  counts?: InstallReport;
  errmsg?: string;
  durationMs: number;
  filesWritten: number;
}

let logSeq = 0;
export function nextLogId(): number {
  return ++logSeq;
}

/* ------------------------------------------------------------------ */
/* Badges / table                                                      */
/* ------------------------------------------------------------------ */

export const KIND_BADGE: Record<PlanKind, { label: string; cls: string }> = {
  create: { label: "新建", cls: "bd-create" },
  skip: { label: "跳过", cls: "bd-skip" },
  overwrite: { label: "覆盖", cls: "bd-over" },
  "managed-block": { label: "受管块", cls: "bd-mgd" },
};

/** 说明 column copy derived from the plan kind (the IPC payload carries no note). */
export function noteFor(kind: PlanKind): string {
  switch (kind) {
    case "create":
      return "";
    case "skip":
      return "已存在";
    case "overwrite":
      return "已存在 · 将被覆盖";
    case "managed-block":
      return "追加受管块 · 保留既有内容";
  }
}

export interface PlanCounts {
  create: number;
  skip: number;
  overwrite: number;
  "managed-block": number;
  total: number;
}

export function planCounts(plan: Plan): PlanCounts {
  const c: PlanCounts = { create: 0, skip: 0, overwrite: 0, "managed-block": 0, total: plan.items.length };
  for (const it of plan.items) c[it.kind]++;
  return c;
}

export function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i === -1) return { dir: "", name: p };
  return { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export function buildSource(srcMode: "bundled" | "local", localRoot: string): Source {
  return srcMode === "bundled" ? { mode: "bundled" } : { mode: "local", root: localRoot.trim() };
}

export function buildSelection(
  srcMode: "bundled" | "local",
  localRoot: string,
  projectDir: string,
  targets: ReadonlySet<Target>,
  userLevel: boolean,
  force: boolean,
): Selection {
  return {
    source: buildSource(srcMode, localRoot),
    projectDir: projectDir.trim(),
    targets: TARGET_ORDER.filter((t) => targets.has(t)),
    userLevel,
    force,
  };
}

/**
 * 内置源 version label: prefer EnvironmentInfo.sourceVersion (the embedded
 * content-source version, PLAN §2) and fall back to the Tauri app version,
 * then to a dash placeholder in the browser / stub backend.
 */
export function bundledVersionLabel(env: EnvironmentInfo | null, appVersion: string | null): string {
  const v = (env?.sourceVersion || "").trim() || appVersion || "";
  return v ? `v${v}` : "v—";
}

/** `v1.2.3` from a possibly already-prefixed version string (guards `vv1.2.3`). */
export function versionLabel(version: string | null | undefined): string {
  const v = (version ?? "").trim().replace(/^v/i, "");
  return v ? `v${v}` : "";
}

/* ------------------------------------------------------------------ */
/* DSH detection states (locked payload semantics, SPEC §4.1 / §10.5)  */
/* ------------------------------------------------------------------ */

export function dshCardState(dsh: DshInfo): { dot: "ok" | "off"; text: string; chip: boolean } {
  if (!dsh.exists) return { dot: "off", text: "未找到 DSH 主目录 · 仍可安装", chip: false };
  if (dsh.profile === null) {
    return {
      dot: "ok",
      text: `未找到唯一 profile（共 ${dsh.profilesCount} 个候选）· 仍可安装`,
      chip: dsh.homeSource === "env",
    };
  }
  return { dot: "ok", text: `profile：${dsh.profile}`, chip: dsh.homeSource === "env" };
}

/** Sidebar env-card label: profile name / 未找到 / N 候选. */
export function dshEnvLabel(dsh: DshInfo): string {
  if (!dsh.exists) return "未找到";
  if (dsh.profile !== null) return dsh.profile;
  return dsh.profilesCount > 1 ? `${dsh.profilesCount} 候选` : "未找到";
}

/*
 * Detection derivation for targets that expose only a free-form `detail`
 * string in EnvironmentInfo.targets. Positive-looking detail → ok dot;
 * negative/empty → off dot. Detection is inform-only (SPEC §10.4) — the dot
 * never affects selectability. 「无前置要求」 is a positive verdict (nothing
 * needs to be present) even though it starts with a negative-looking
 * character, so it is whitelisted before the negative scan.
 */
const POSITIVE_DETAIL = /^(已|无前置|无需|没有前置)/;
const NEGATIVE_DETAIL = /未|无|找不到|失败|不可用|not found/i;

export function detailPresent(detail: string | null | undefined): boolean {
  if (detail === undefined || detail === null) return false;
  const d = detail.trim();
  if (POSITIVE_DETAIL.test(d)) return true;
  return d.length > 0 && !NEGATIVE_DETAIL.test(d);
}

export function targetDetail(env: EnvironmentInfo, t: Target): string | null {
  return env.targets.find((x) => x.target === t)?.detail ?? null;
}

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

export function hhmmss(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 「上次检查 …」 relative label. */
export function relTime(from: Date, now: Date): string {
  const diffMs = now.getTime() - from.getTime();
  if (diffMs < 60_000) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  return hhmmss(from);
}
