// Area 2 — 技能 (SPEC §5): source chips, filter toolbar, skill rows, network
// states (最新/缓存/限流/离线), add/edit/remove source, install / update /
// 重装 / delete with the 检测到本地修改 + 删除技能 dialogs, 全部更新 with
// per-skill skill-progress rendering. Wired to the typed IPC layer with the
// same graceful-degradation idiom as the deploy page.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useToast } from "../components/Toast";
import { Icon } from "../icons";
import {
  describeIpcError,
  isTauriAvailable,
  skillsAddSource,
  skillsCheckUpdate,
  skillsDelete,
  skillsInstall,
  skillsListInstalled,
  skillsListRemote,
  skillsListSources,
  skillsRemoveSource,
  skillsUpdate,
  skillsUpdateSource,
  settingsGet,
  subscribeSkillProgress,
  type InstalledSkill,
  type IpcFailure,
  type SkillChange,
  type SkillProgress,
  type SkillSourceConfig,
  type SkillsListingResult,
} from "../lib/ipc";
import { hhmmss } from "./deploy/logic";
import {
  ModifiedDialog,
  SourceDeleteDialog,
  SourceDialog,
  DeleteSkillDialog,
  backupHintPath,
  type ModifiedDialogState,
  type SourceDialogState,
} from "./skills/dialogs";
import {
  SKILL_BADGE,
  buildRows,
  foldNetState,
  hhmm,
  phaseLabel,
  shortSha,
  sourceMeta,
  type SkillRow,
  type SkillStatus,
} from "./skills/logic";

export interface SkillsPageProps {
  goToSettings: () => void;
  /** Sidebar meta: installed count; null = unknown (backend down). */
  onInstalledCount: (n: number | null) => void;
}

const DEFAULT_SKILLS_ROOT = "~\\.agents\\skills\\";

interface ProgLine {
  id: number;
  ts: string;
  cls: "" | "warn" | "err";
  text: string;
}

interface BulkState {
  current: string | null;
  done: number;
  total: number;
}

let progSeq = 0;
function nextProgId(): number {
  return ++progSeq;
}

export function SkillsPage({ goToSettings, onInstalledCount }: SkillsPageProps) {
  const toast = useToast();

  /* ---------------- data state ---------------- */
  const [skillsRoot, setSkillsRoot] = useState(DEFAULT_SKILLS_ROOT);
  const [sources, setSources] = useState<SkillSourceConfig[] | null>(null);
  const [sourcesError, setSourcesError] = useState<IpcFailure | null>(null);
  const [listings, setListings] = useState<Record<number, SkillsListingResult | null>>({});
  const [failures, setFailures] = useState<Record<number, IpcFailure>>({});
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [installedError, setInstalledError] = useState<IpcFailure | null>(null);
  const [checks, setChecks] = useState<Record<string, SkillChange | null>>({});

  /* ---------------- view state ---------------- */
  const [loading, setLoading] = useState(true);
  const [srcFilter, setSrcFilter] = useState<number | null>(null);
  const [sf, setSf] = useState<"all" | SkillStatus>("all");
  const [q, setQ] = useState("");
  const [rateDismissed, setRateDismissed] = useState(false);

  /* ---------------- operation state ---------------- */
  const [opRunning, setOpRunning] = useState(false);
  const [bulk, setBulk] = useState<BulkState | null>(null);
  const [prog, setProg] = useState<SkillProgress | null>(null);
  const [progLines, setProgLines] = useState<ProgLine[]>([]);

  /* ---------------- dialogs ---------------- */
  const [srcDlg, setSrcDlg] = useState<SourceDialogState | null>(null);
  const [srcDel, setSrcDel] = useState<{ index: number; repo: string } | null>(null);
  const [modDlg, setModDlg] = useState<ModifiedDialogState | null>(null);
  const [delDlg, setDelDlg] = useState<{ name: string } | null>(null);

  const seqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const anyDialogOpen = srcDlg !== null || srcDel !== null || modDlg !== null || delDlg !== null;
  const [firstLoadDone, setFirstLoadDone] = useState(false);

  /* ---------------- skill-progress wiring ---------------- */
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void subscribeSkillProgress((ev: SkillProgress) => {
      setProg(ev);
      if (ev.phase === "log" || ev.phase === "log-warn" || ev.phase === "log-error") {
        const cls = ev.phase === "log-warn" ? "warn" : ev.phase === "log-error" ? "err" : "";
        setProgLines((prev) => [...prev.slice(-80), { id: nextProgId(), ts: hhmmss(new Date()), cls, text: ev.text }]);
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /* ---------------- installed count → sidebar meta ---------------- */
  useEffect(() => {
    if (!firstLoadDone) return;
    onInstalledCount(installedError !== null ? null : installed.length);
  }, [firstLoadDone, installed, installedError, onInstalledCount]);

  /* ---------------- freshness checks (background, sequential) ---------------- */
  const runChecks = useCallback(async (srcs: SkillSourceConfig[], inst: InstalledSkill[], seq: number) => {
    for (const sk of inst) {
      if (seq !== seqRef.current) return;
      const src = srcs.find((s) => s.repo === sk.repo);
      if (!src) continue; // 源已解除关联 — 无法检查
      try {
        const ch = await skillsCheckUpdate({ repo: src.repo, ref: src.ref, subdir: src.subdir, name: sk.name });
        if (seq !== seqRef.current) return;
        setChecks((prev) => ({ ...prev, [sk.name]: ch }));
      } catch {
        // offline / rate-limited — keep the current verdict (已安装 · 最新 stays)
      }
    }
  }, []);

  /* ---------------- load (initial + 刷新) ---------------- */
  const loadAll = useCallback(
    async (refresh: boolean) => {
      const seq = ++seqRef.current;
      setLoading(true);

      // settings — for the header's 安装位置 label; non-fatal (browser session keeps the literal default)
      try {
        const s = await settingsGet();
        if (seq === seqRef.current) setSkillsRoot(s.skillsRoot || DEFAULT_SKILLS_ROOT);
      } catch {
        /* keep default */
      }

      // sources
      let srcs: SkillSourceConfig[] = [];
      let srcErr: IpcFailure | null = null;
      try {
        srcs = await skillsListSources();
        if (seq === seqRef.current) {
          setSources(srcs);
          setSourcesError(null);
        }
      } catch (e) {
        srcErr = describeIpcError(e);
        if (seq === seqRef.current) {
          setSources(null);
          setSourcesError(srcErr);
        }
      }

      // installed manifest — offline-safe read
      let inst: InstalledSkill[] = [];
      let instErr: IpcFailure | null = null;
      try {
        inst = await skillsListInstalled();
        if (seq === seqRef.current) {
          setInstalled(inst);
          setInstalledError(null);
        }
      } catch (e) {
        instErr = describeIpcError(e);
        if (seq === seqRef.current) {
          setInstalled([]);
          setInstalledError(instErr);
        }
      }

      // per-source listings — sequential, rate-limit friendly. A failed source
      // keeps its stale listing (→ offline state); no stale listing → error.
      const results: Record<number, SkillsListingResult> = {};
      const fails: Record<number, IpcFailure> = {};
      if (seq === seqRef.current) setFailures({});
      for (let i = 0; i < srcs.length; i++) {
        const s = srcs[i];
        try {
          results[i] = await skillsListRemote({ repo: s.repo, ref: s.ref, subdir: s.subdir, refresh });
        } catch (e) {
          fails[i] = describeIpcError(e);
        }
      }
      if (seq === seqRef.current) {
        setListings((prev) => {
          const next: Record<number, SkillsListingResult | null> = {};
          for (let i = 0; i < srcs.length; i++) next[i] = results[i] ?? prev[i] ?? null;
          return next;
        });
        setFailures(fails);
        setLoading(false);
        setFirstLoadDone(true);
      }

      // background per-row checks — skipped when a listing fetch failed (they would fail too)
      if (Object.keys(fails).length === 0 && srcErr === null && isTauriAvailable()) {
        void runChecks(srcs, inst, seq);
      }
    },
    [runChecks],
  );

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  /* ---------------- derived ---------------- */
  const rows = useMemo(() => buildRows(sources, listings, installed, checks), [sources, listings, installed, checks]);

  const failedIndexes = useMemo(() => Object.keys(failures).map(Number), [failures]);
  const net = useMemo(() => foldNetState(listings, failedIndexes, Date.now()), [listings, failedIndexes]);

  const noListingFailure = useMemo(
    () => failedIndexes.find((i) => !listings[i]) ?? null,
    [failedIndexes, listings],
  );

  const offline = net === "offline";
  const backendDown = sourcesError !== null;

  const latestAt = useMemo(() => {
    const times = Object.values(listings)
      .map((l) => l?.cachedAtMs ?? null)
      .filter((t): t is number => t !== null);
    return times.length > 0 ? Math.max(...times) : null;
  }, [listings]);

  const cacheLabel = useMemo(() => {
    if (offline) return `离线 · 显示本地清单（${rows.length} 个技能）`;
    if (net === "rate") return "限额预警 · 显示缓存清单";
    if (noListingFailure !== null && latestAt === null) return "列表不可用";
    if (net === "loading" || latestAt === null) return "列表加载中…";
    const d = new Date(latestAt);
    if (net === "fresh") return `刚刚刷新 · ${hhmm(d)}`;
    const minutes = Math.max(0, Math.floor((Date.now() - latestAt) / 60_000));
    return `列表缓存于 ${minutes} 分钟前 · 上次刷新 ${hhmm(d)}`;
  }, [net, offline, latestAt, rows.length, noListingFailure]);

  const cacheIcon = offline ? "offline" : net === "rate" ? "warn" : "clock";

  const visibleRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (srcFilter === null || r.sourceIndex === srcFilter) &&
        (sf === "all" || r.status === sf) &&
        (needle === "" || r.name.toLowerCase().includes(needle) || r.desc.toLowerCase().includes(needle)),
    );
  }, [rows, srcFilter, sf, q]);

  const chipCounts = useMemo(
    () => ({
      all: rows.length,
      upd: rows.filter((r) => r.status === "upd").length,
      mod: rows.filter((r) => r.status === "mod").length,
      na: rows.filter((r) => r.status === "na").length,
    }),
    [rows],
  );

  /* ---------------- `/` → focus search (SPEC §9, guarded) ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        return;
      }
      if (anyDialogOpen) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyDialogOpen]);

  /* ---------------- source mutations ---------------- */
  const saveSource = useCallback(
    async (repo: string, ref: string | null, subdir: string): Promise<boolean> => {
      try {
        const next =
          srcDlg?.mode === "edit" && typeof srcDlg.index === "number"
            ? await skillsUpdateSource(srcDlg.index, { repo, ref, subdir })
            : await skillsAddSource({ repo, ref, subdir });
        setSources(next);
        toast({ kind: "ok", title: `已保存源 ${repo}`, sub: "技能源已刷新" });
        void loadAll(false);
        return true;
      } catch (e) {
        toast({ kind: "err", title: "保存源失败", sub: describeIpcError(e).message });
        return false;
      }
    },
    [srcDlg, toast, loadAll],
  );

  const removeSource = useCallback(
    (index: number) => {
      void (async () => {
        try {
          const next = await skillsRemoveSource(index);
          setSources(next);
          setSrcFilter(null);
          toast({ kind: "ok", title: `已移除源 ${srcDel?.repo ?? ""}`, sub: "已安装技能保留" });
          void loadAll(false);
        } catch (e) {
          toast({ kind: "err", title: "移除源失败", sub: describeIpcError(e).message });
        }
      })();
    },
    [srcDel, toast, loadAll],
  );

  /* ---------------- skill operations ---------------- */
  const mergeInstalled = useCallback((inst: InstalledSkill) => {
    setInstalled((prev) => [...prev.filter((s) => s.name !== inst.name), inst]);
  }, []);

  const recheckOne = useCallback(async (src: SkillSourceConfig, name: string) => {
    try {
      const ch = await skillsCheckUpdate({ repo: src.repo, ref: src.ref, subdir: src.subdir, name });
      setChecks((prev) => ({ ...prev, [name]: ch }));
    } catch {
      /* keep the previous verdict */
    }
  }, []);

  const install = useCallback(
    async (row: SkillRow) => {
      if (row.sourceIndex === null || !sources) return;
      const src = sources[row.sourceIndex];
      setOpRunning(true);
      setProg(null);
      setProgLines([]);
      toast({ kind: "info", title: `正在安装 ${row.name}…`, sub: `技能源 ${src.repo}` });
      try {
        const inst = await skillsInstall({ repo: src.repo, ref: src.ref, subdir: src.subdir, name: row.name });
        mergeInstalled(inst);
        await recheckOne(src, inst.name);
        toast({ kind: "ok", title: `已安装 ${inst.name}`, sub: `${inst.fileCount} 个文件 · ${shortSha(inst.commit)}` });
      } catch (e) {
        toast({ kind: "err", title: "安装失败", sub: describeIpcError(e).message });
      } finally {
        setOpRunning(false);
      }
    },
    [sources, mergeInstalled, recheckOne, toast],
  );

  const runUpdate = useCallback(
    async (name: string, opts: { force: boolean; backup: boolean }, okTitle: string) => {
      const inst = installed.find((s) => s.name === name);
      const idx = inst && sources ? sources.findIndex((s) => s.repo === inst.repo) : -1;
      if (!inst || !sources || idx < 0) return;
      const src = sources[idx];
      setOpRunning(true);
      setProg(null);
      setProgLines([]);
      try {
        const after = await skillsUpdate({
          repo: src.repo,
          ref: src.ref,
          subdir: src.subdir,
          name,
          force: opts.force,
          backup: opts.backup,
        });
        mergeInstalled(after);
        await recheckOne(src, name);
        toast({
          kind: "ok",
          title: okTitle,
          sub: opts.backup ? `备份于 ${skillsRoot}\\.backups\\` : shortSha(after.commit),
        });
      } catch (e) {
        toast({ kind: "err", title: "更新失败", sub: describeIpcError(e).message });
      } finally {
        setOpRunning(false);
      }
    },
    [installed, sources, mergeInstalled, recheckOne, toast, skillsRoot],
  );

  const openModDialog = useCallback(
    async (row: SkillRow) => {
      if (row.sourceIndex === null || !sources) return;
      const src = sources[row.sourceIndex];
      let ch = row.change;
      if (ch === null) {
        try {
          ch = await skillsCheckUpdate({ repo: src.repo, ref: src.ref, subdir: src.subdir, name: row.name });
          setChecks((prev) => ({ ...prev, [row.name]: ch }));
        } catch (e) {
          toast({ kind: "err", title: "检查更新失败", sub: describeIpcError(e).message });
          return;
        }
      }
      if (ch !== null && ch.event === "local-modified") {
        setModDlg({
          name: row.name,
          modified: ch.modified,
          backupPath: backupHintPath(skillsRoot, row.name, new Date()),
        });
      } else {
        // raced: no longer locally modified → plain update path
        void runUpdate(row.name, { force: false, backup: false }, `已更新 ${row.name}`);
      }
    },
    [sources, skillsRoot, runUpdate, toast],
  );

  const forceUpdate = useCallback(
    (name: string) => {
      void runUpdate(name, { force: true, backup: true }, `已备份并强制更新 ${name}`);
    },
    [runUpdate],
  );

  const deleteSkill = useCallback(
    (name: string, trash: boolean) => {
      void (async () => {
        setOpRunning(true);
        setProg(null);
        setProgLines([]);
        try {
          await skillsDelete(name, trash);
          setInstalled((prev) => prev.filter((s) => s.name !== name));
          setChecks((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
          });
          toast({ kind: "ok", title: `已删除 ${name}`, sub: trash ? "已备份到回收站 · 清单已更新" : "清单已更新" });
        } catch (e) {
          toast({ kind: "err", title: "删除失败", sub: describeIpcError(e).message });
        } finally {
          setOpRunning(false);
        }
      })();
    },
    [toast],
  );

  /* ---------------- 全部更新: sequential, pre-checked, progress-rendered ---------------- */
  const updateAll = useCallback(async () => {
    if (opRunning || loading || !sources || sources.length === 0 || offline) return;
    setOpRunning(true);
    setProg(null);
    setProgLines([]);
    setBulk({ current: null, done: 0, total: installed.length });
    let updated = 0;
    let upToDate = 0;
    let failed = 0;
    const failedNames: string[] = [];
    const skippedMod: string[] = [];
    for (const inst of [...installed]) {
      setBulk((b) => (b ? { ...b, current: inst.name } : b));
      const idx = sources.findIndex((s) => s.repo === inst.repo);
      if (idx === -1) {
        setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
        continue;
      }
      const src = sources[idx];
      let ch = checks[inst.name] ?? null;
      try {
        ch = await skillsCheckUpdate({ repo: src.repo, ref: src.ref, subdir: src.subdir, name: inst.name });
        setChecks((prev) => ({ ...prev, [inst.name]: ch }));
      } catch {
        /* use the cached verdict; none → skip this round */
      }
      if (ch === null || ch.event === "up-to-date") {
        upToDate++;
        setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
        continue;
      }
      if (ch.event === "local-modified") {
        skippedMod.push(inst.name);
        setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
        continue;
      }
      try {
        const after = await skillsUpdate({
          repo: src.repo,
          ref: src.ref,
          subdir: src.subdir,
          name: inst.name,
          force: false,
          backup: false,
        });
        mergeInstalled(after);
        // the skill is now at the commit it just fetched — 刷新 re-verifies later
        setChecks((prev) => ({ ...prev, [inst.name]: { event: "up-to-date" } }));
        updated++;
      } catch (e) {
        failed++;
        failedNames.push(inst.name);
      }
      setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
    }
    try {
      const fresh = await skillsListInstalled();
      setInstalled(fresh);
    } catch {
      /* keep the merged list */
    }
    setBulk(null);
    setOpRunning(false);
    if (updated > 0) toast({ kind: "ok", title: "全部更新完成", sub: `${updated} 已更新 · ${upToDate} 已是最新` });
    else toast({ kind: "info", title: "全部已是最新", sub: `${upToDate} 个技能均为最新` });
    if (skippedMod.length > 0)
      toast({ kind: "warn", title: "有本地修改，已跳过", sub: `${skippedMod.join("、")} — 需逐个选择「备份后强制更新」` });
    if (failed > 0) toast({ kind: "err", title: `${failed} 个技能更新失败`, sub: failedNames.join("、") });
  }, [opRunning, loading, sources, offline, installed, checks, mergeInstalled, toast]);

  const refreshListings = useCallback(() => {
    if (loading) return;
    void loadAll(true);
  }, [loading, loadAll]);

  const clearFilters = useCallback(() => {
    setSf("all");
    setQ("");
    setSrcFilter(null);
  }, []);

  /* ---------------- row actions ---------------- */
  const actionDisabled = (r: SkillRow): { disabled: boolean; title?: string } => {
    if (r.sourceIndex === null) return { disabled: true, title: "来源已解除关联，无法更新" };
    if (offline) return { disabled: true, title: "离线状态：安装与更新不可用" };
    if (opRunning) return { disabled: true, title: "有技能操作正在进行" };
    return { disabled: false };
  };

  const rowActions = (r: SkillRow): ReactElement => {
    const d = actionDisabled(r);
    let act: ReactElement;
    if (r.status === "na") {
      act = (
        <button type="button" className="btn btn-sm btn-acc-o" disabled={d.disabled} title={d.title} onClick={() => void install(r)}>
          <Icon name="dl" />
          安装
        </button>
      );
    } else if (r.status === "upd") {
      act = (
        <button type="button" className="btn btn-sm" disabled={d.disabled} title={d.title} onClick={() => void runUpdate(r.name, { force: false, backup: false }, `已更新 ${r.name}`)}>
          <Icon name="up" />
          更新
        </button>
      );
    } else if (r.status === "mod") {
      act = (
        <button type="button" className="btn btn-sm btn-warn-o" disabled={d.disabled} title={d.title} onClick={() => void openModDialog(r)}>
          <Icon name="up" />
          更新
        </button>
      );
    } else {
      act = (
        <button type="button" className="btn btn-sm btn-ghost" disabled={d.disabled} title={d.title ?? "重新安装"} onClick={() => void runUpdate(r.name, { force: false, backup: false }, `已重装 ${r.name}`)}>
          重装
        </button>
      );
    }
    return (
      <>
        {act}
        <button
          type="button"
          className="btn btn-sm btn-ghost btn-danger-o"
          aria-label={`删除 ${r.name}`}
          disabled={opRunning}
          onClick={() => setDelDlg({ name: r.name })}
        >
          <Icon name="trash" />
        </button>
      </>
    );
  };

  const rowVer = (r: SkillRow) => {
    if (!r.installed) return <span className="na">—</span>;
    return (
      <>
        {shortSha(r.installed.commit)}
        {r.change?.event === "updatable" && (
          <span style={{ color: "var(--accent)" }}> → {shortSha(r.change.newCommit)}</span>
        )}
      </>
    );
  };

  /* ---------------- markup ---------------- */
  const allDisabled = offline || opRunning;
  const canUpdateAll = sources !== null && sources.length > 0 && !allDisabled && !loading && !backendDown;

  /* progress derivation: during 全部更新 the loop interleaves check_update
     (no events) with update (events) — show a checking label whenever the
     latest event belongs to a different skill than the current one. */
  const checkingNext = bulk !== null && (prog === null || prog.skill !== bulk.current);
  const progSuffix = bulk !== null && bulk.total > 0 ? ` · ${bulk.done}/${bulk.total}` : "";
  const progLabel = checkingNext
    ? `正在检查 ${bulk?.current ?? ""}…${progSuffix}`
    : prog !== null
      ? `${phaseLabel(prog)}${progSuffix}`
      : "正在处理…";
  const progWidth = prog !== null && prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0;
  const progFillCls =
    prog === null ? "lpfill" : prog.phase === "finished" ? "lpfill done" : prog.phase === "cancelled" ? "lpfill" : "lpfill is-run";

  return (
    <>
      <header className="page-head" data-tauri-drag-region>
        <div>
          <h1 className="ph-title">技能</h1>
          <p className="ph-sub">
            {offline ? (
              "离线模式 · 从本地清单管理技能"
            ) : (
              <>
                从 GitHub 仓库安装与管理技能 · 安装位置 <span className="mono">{skillsRoot}</span>
              </>
            )}
          </p>
        </div>
        <div className="ph-actions">
          <button type="button" className="btn" onClick={() => void updateAll()} disabled={!canUpdateAll} title={offline ? "离线状态：安装与更新不可用" : undefined}>
            <Icon name="up" />
            全部更新
            <span className="vchip num" style={{ marginLeft: 2 }}>
              {chipCounts.upd}
            </span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setSrcDlg({ mode: "add" })}>
            <Icon name="plus" />
            添加源
          </button>
          <button
            type="button"
            className="icon-btn"
            title="从 GitHub 刷新（受 60 次/小时限额约束）"
            onClick={refreshListings}
            disabled={loading || backendDown}
          >
            {loading ? <span className="spin" /> : <Icon name="ref" />}
          </button>
        </div>
      </header>

      <div className="page-body sk-body">
        <div className="sk-wrap">
          {/* ---- network banner slot (offline + listing-failure may coexist) ---- */}
          {backendDown ? (
            <div className="bn mut">
              <Icon name="info" />
              <div className="bn-c">
                <div className="bn-t">{sourcesError.title}</div>
                <div className="bn-s">{sourcesError.message}</div>
              </div>
              <div className="bn-a">
                <button type="button" className="btn btn-sm" onClick={() => void loadAll(false)}>
                  <Icon name="ref" />
                  重试
                </button>
              </div>
            </div>
          ) : (
            <>
              {noListingFailure !== null && (
                <div className="bn err">
                  <Icon name="warn" />
                  <div className="bn-c">
                    <div className="bn-t">技能列表加载失败</div>
                    <div className="bn-s">{failures[noListingFailure]?.message ?? "未知错误"}</div>
                  </div>
                  <div className="bn-a">
                    <button type="button" className="btn btn-sm" onClick={() => void loadAll(false)}>
                      <Icon name="ref" />
                      重试
                    </button>
                  </div>
                </div>
              )}
              {offline && (
                <div className="bn mut">
                  <Icon name="offline" />
                  <div className="bn-c">
                    <div className="bn-t">离线 — 无法连接 GitHub</div>
                    <div className="bn-s">当前显示本地清单，安装与更新不可用；删除与查看不受影响。恢复网络后点击刷新。</div>
                  </div>
                </div>
              )}
              {!offline && net === "rate" && !rateDismissed && (
                <div className="bn warn">
                  <Icon name="warn" />
                  <div className="bn-c">
                    <div className="bn-t">GitHub API 限额提醒</div>
                    <div className="bn-s">
                      未认证限额 60 次/小时，即将用尽。配置 PAT 后提升至 5,000 次/小时。{" "}
                      <a
                        className="link"
                        href="#settings"
                        onClick={(e) => {
                          e.preventDefault();
                          goToSettings();
                        }}
                      >
                        前往设置
                      </a>
                    </div>
                  </div>
                  <div className="bn-a">
                    <button type="button" className="btn btn-sm btn-ghost" title="关闭" onClick={() => setRateDismissed(true)}>
                      稍后
                    </button>
                  </div>
                </div>
              )}
              {!offline && noListingFailure === null && net !== "rate" && installedError !== null && (
                <div className="bn warn">
                  <Icon name="warn" />
                  <div className="bn-c">
                    <div className="bn-t">技能清单不可用</div>
                    <div className="bn-s">{installedError.message}</div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ---- 技能源 card ---- */}
          <div className="card">
            <div className="card-h">
              <span className="card-t">技能源</span>
              <span className="card-s">{sources ? `${sources.length} 个源` : "—"}</span>
              <span className="card-hr">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSrcDlg({ mode: "add" })}>
                  <Icon name="plus" />
                  添加源
                </button>
              </span>
            </div>
            <div className="card-b">
              <div className="schips">
                {sources?.map((s, i) => {
                  const count = listings[i]?.listing.skills.length ?? null;
                  return (
                    <div
                      key={`${i}:${s.repo}`}
                      className={`schip${srcFilter === i ? " is-on" : ""}`}
                      role="button"
                      tabIndex={0}
                      title="点击按该源筛选"
                      onClick={() => setSrcFilter(srcFilter === i ? null : i)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSrcFilter(srcFilter === i ? null : i);
                        }
                      }}
                    >
                      <Icon name="git" />
                      <div>
                        <div className="schip-r">{s.repo}</div>
                        <div className="schip-m">{sourceMeta(s, count)}</div>
                      </div>
                      <span className="schip-x">
                        <button
                          type="button"
                          title="编辑源"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSrcDlg({ mode: "edit", index: i, initial: s });
                          }}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          type="button"
                          title="删除源"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSrcDel({ index: i, repo: s.repo });
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </span>
                    </div>
                  );
                })}
                <button type="button" className="schip schip-add" onClick={() => setSrcDlg({ mode: "add" })}>
                  <Icon name="plus" />
                  添加源
                </button>
              </div>
            </div>
          </div>

          {/* ---- toolbar ---- */}
          <div className="sk-tools">
            <div className="search">
              <Icon name="search" className="sk-search-ic" />
              <input
                ref={searchRef}
                value={q}
                placeholder="搜索技能…"
                aria-label="搜索技能"
                onChange={(e) => setQ(e.target.value)}
              />
              <kbd className="kbd">/</kbd>
            </div>
            <button type="button" className={`chip${sf === "all" ? " is-on" : ""}`} onClick={() => setSf("all")}>
              全部 <b className="num">{chipCounts.all}</b>
            </button>
            <button type="button" className={`chip${sf === "upd" ? " is-on" : ""}`} onClick={() => setSf("upd")}>
              可更新 <b className="num">{chipCounts.upd}</b>
            </button>
            <button type="button" className={`chip${sf === "mod" ? " is-on" : ""}`} onClick={() => setSf("mod")}>
              有本地修改 <b className="num">{chipCounts.mod}</b>
            </button>
            <button type="button" className={`chip${sf === "na" ? " is-on" : ""}`} onClick={() => setSf("na")}>
              未安装 <b className="num">{chipCounts.na}</b>
            </button>
            <span className="sk-cache num">
              <Icon name={cacheIcon} />
              {cacheLabel}
            </span>
          </div>

          {/* ---- per-op progress ---- */}
          {opRunning && (
            <div className="sk-prog">
              <div className="lprog">
                <span className="spin" />
                <span className="sk-prog-name mono">{prog?.skill ?? bulk?.current ?? ""}</span>
                <div className="lpbar">
                  <span className={progFillCls} style={{ width: `${progWidth}%` }} />
                </div>
                <span className="lphase num">{progLabel}</span>
              </div>
              {progLines.length > 0 && (
                <div className="log sk-prog-log" role="log" aria-live="polite">
                  {progLines.map((l) => (
                    <div className={`ln ${l.cls}`} key={l.id}>
                      <span className="ts">{l.ts}</span>
                      <span className="lm">{l.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---- skill list / empty states ---- */}
          {backendDown ? (
            <div className="sk-list">
              <div className="sk-empty">
                <Icon name="offline" className="sk-empty-ic" />
                后端未就绪
                <span className="sk-empty-s">{sourcesError.message}</span>
              </div>
            </div>
          ) : sources !== null && sources.length === 0 ? (
            <div className="empty">
              <div className="empty-ic">
                <Icon name="git" />
              </div>
              <div className="empty-t">没有技能源</div>
              <div className="empty-s">
                添加 GitHub 仓库作为技能源，从仓库安装与管理技能（<span className="mono">owner/repo</span>）。
              </div>
              <button type="button" className="btn btn-acc-o" onClick={() => setSrcDlg({ mode: "add" })}>
                <Icon name="plus" />
                添加源
              </button>
            </div>
          ) : (
            <div className="sk-list">
              <div className="sk-head">
                <span className="h1">技能</span>
                <span className="h2">来源</span>
                <span className="h3">已安装</span>
                <span className="h4">状态</span>
                <span className="h5" style={{ textAlign: "right" }}>
                  操作
                </span>
              </div>
              {loading && sources === null ? (
                <div className="sk-empty">
                  <span className="spin" />
                  正在加载…
                </div>
              ) : visibleRows.length === 0 ? (
                <div className="sk-empty">
                  <Icon name="search" className="sk-empty-ic" />
                  没有匹配的技能
                  <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
                    清除筛选
                  </button>
                </div>
              ) : (
                visibleRows.map((r) => (
                  <div className="sk-row" key={r.name}>
                    <div className="sk-main">
                      <div className="sk-name">{r.name}</div>
                      <div className="sk-desc" title={r.desc}>
                        {r.desc}
                      </div>
                    </div>
                    <div className="sk-src" title={r.repo}>
                      <Icon name="git" />
                      {r.repo}
                    </div>
                    <div className="sk-ver num">{rowVer(r)}</div>
                    <div className="sk-st">
                      <span className={`bd ${SKILL_BADGE[r.status].cls}`}>{SKILL_BADGE[r.status].label}</span>
                    </div>
                    <div className="sk-acts">{rowActions(r)}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---- dialogs ---- */}
      <SourceDialog state={srcDlg} onClose={() => setSrcDlg(null)} onSave={saveSource} />
      <SourceDeleteDialog state={srcDel} onClose={() => setSrcDel(null)} onRemove={removeSource} />
      <ModifiedDialog state={modDlg} onClose={() => setModDlg(null)} onForceUpdate={forceUpdate} />
      <DeleteSkillDialog state={delDlg} skillsRoot={skillsRoot} onClose={() => setDelDlg(null)} onDelete={deleteSkill} />
    </>
  );
}
