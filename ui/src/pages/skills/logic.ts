// Skills-area helpers (SPEC §5): row-model derivation, badge mapping, cache
// labels, network-state folding. Pure functions only — no React, no IPC calls.
import type {
  InstalledSkill,
  SkillChange,
  SkillSourceConfig,
  SkillsListingResult,
} from "../../lib/ipc";

export type SkillStatus = "na" | "lat" | "mod" | "upd";

/** Badge mapping — one visual language with the deploy table (SPEC §3.2). */
export const SKILL_BADGE: Record<SkillStatus, { label: string; cls: string }> = {
  na: { label: "未安装", cls: "bd-na" },
  lat: { label: "已安装 · 最新", cls: "bd-lat" },
  mod: { label: "有本地修改", cls: "bd-mod" },
  upd: { label: "可更新", cls: "bd-upd" },
};

export interface SkillRow {
  name: string;
  /** Source index in the sources list; null when the installed skill's source was removed. */
  sourceIndex: number | null;
  repo: string;
  status: SkillStatus;
  installed: InstalledSkill | null;
  change: SkillChange | null;
  /** Remote path from the listing (informational); "" when only the manifest is known. */
  desc: string;
}

export function statusOf(installed: InstalledSkill | null, change: SkillChange | null): SkillStatus {
  if (!installed) return "na";
  if (change?.event === "updatable") return "upd";
  if (change?.event === "local-modified") return "mod";
  return "lat";
}

export function makeRow(
  name: string,
  sourceIndex: number | null,
  repo: string,
  installed: InstalledSkill | null,
  change: SkillChange | null,
  desc: string,
): SkillRow {
  return { name, sourceIndex, repo, status: statusOf(installed, change), installed, change, desc };
}

/**
 * Rows = remote listings per source (in source order) overlaid with the
 * installed manifest. Skills installed but absent from every listing (offline,
 * or their source was removed) still get a row — delete/view must keep working
 * off the manifest (SPEC §5.4).
 */
export function buildRows(
  sources: SkillSourceConfig[] | null,
  listings: Record<number, SkillsListingResult | null>,
  installed: InstalledSkill[],
  checks: Record<string, SkillChange | null>,
): SkillRow[] {
  const byName = new Map<string, SkillRow>();
  const installedByName = new Map(installed.map((s) => [s.name, s]));
  if (sources) {
    sources.forEach((src, i) => {
      const listing = listings[i]?.listing;
      if (!listing) return;
      for (const rs of listing.skills) {
        if (byName.has(rs.name)) continue;
        const inst = installedByName.get(rs.name) ?? null;
        byName.set(rs.name, makeRow(rs.name, i, src.repo, inst, checks[rs.name] ?? null, rs.path));
      }
    });
  }
  for (const inst of installed) {
    if (byName.has(inst.name)) continue;
    const idx = sources?.findIndex((s) => s.repo === inst.repo) ?? -1;
    byName.set(inst.name, makeRow(inst.name, idx >= 0 ? idx : null, inst.repo, inst, checks[inst.name] ?? null, ""));
  }
  return [...byName.values()];
}

export type NetState = "loading" | "fresh" | "cached" | "rate" | "offline";

/** True when any listing reports a nearly-exhausted unauthenticated quota (SPEC §5.4 限流). */
export function rateNearlyExhausted(listings: Record<number, SkillsListingResult | null>): boolean {
  return Object.values(listings).some(
    (l) => l !== undefined && l !== null && l.listing.rate.remaining !== null && l.listing.rate.remaining <= 5,
  );
}

/**
 * Fold per-source listing results + failures into one page-level network
 * state: a rejection with a cached listing in hand → offline; the rate banner
 * wins over fresh/cached labels; otherwise the most recent cachedAtMs decides
 * 刚刚刷新 (< 60s) vs 列表缓存于.
 */
export function foldNetState(
  listings: Record<number, SkillsListingResult | null>,
  failedIndexes: number[],
  now: number,
): NetState {
  const hasValues = Object.keys(listings).length > 0;
  if (!hasValues) return "loading";
  if (failedIndexes.some((i) => listings[i])) return "offline";
  if (rateNearlyExhausted(listings)) return "rate";
  const times = Object.values(listings)
    .map((l) => l?.cachedAtMs ?? null)
    .filter((t): t is number => t !== null);
  if (times.length === 0) return "loading";
  const latest = Math.max(...times);
  return now - latest < 60_000 ? "fresh" : "cached";
}

/** 全部更新 count: skills whose per-row check says 可更新. */
export function updatableCount(rows: SkillRow[]): number {
  return rows.filter((r) => r.status === "upd").length;
}

export function hhmm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** yyyymmdd-hhmm stamp used in the 备份位置 hint (sample-data format, SPEC §10.10). */
export function backupStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function shortSha(commit: string): string {
  return commit.length > 7 ? commit.slice(0, 7) : commit;
}

/** `owner/repo` shape the backend's check_repo_shape mirrors (kept loose: route errors surface from the command). */
export function repoShapeOk(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());
}

/** source chip meta line: `@{ref} · {n} 个技能` (ref null → the default branch, omitted). */
export function sourceMeta(src: SkillSourceConfig, count: number | null): string {
  const refPart = src.ref ? `@${src.ref} · ` : "";
  const countPart = count === null ? "—" : `${count} 个技能`;
  return `${refPart}${countPart}`;
}

/** Progress phase label for the skill-progress bar (phases fixed in the M2 skill-repo spec). */
export function phaseLabel(p: { skill: string; phase: string; done: number; total: number; text: string }): string {
  switch (p.phase) {
    case "started":
      return `开始 ${p.skill} · 共 ${p.total} 个文件`;
    case "skill-install":
      return `正在安装 ${p.skill} · ${p.done}/${p.total}`;
    case "skill-update":
      return `正在更新 ${p.skill} · ${p.done}/${p.total}`;
    case "log":
    case "log-warn":
    case "log-error":
      return p.text;
    case "finished":
      return `${p.skill} 完成`;
    case "cancelled":
      return `${p.skill} 已取消`;
    default:
      return p.text || p.phase;
  }
}
