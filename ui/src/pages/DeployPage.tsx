// Area 1 — 部署, v2 (SPEC §4, deploy-redesign-notes): per-backend page —
// backend tab bar + realm scope bar + a single fluid column showing the
// selected target's state (not-deployed empty state / agent card list with the
// full-page detail view / dsh preset summary). Deployment status derives from
// `deployed_overview`, never from detection. The whole former deploy workspace
// (内容源 / 安装位置 / 覆盖 / plan preview / streaming log)
// lives — behavior-unchanged — in the target-scoped deploy dialog; its state
// is owned HERE (above the dialog) so closing mid-run keeps the run going.
// (The former health-check/drift surface was UI-removed 2026-10 — SPEC §10
// tail note; the backend check_drift command stays.)
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "../components/Dialog";
import { useToast } from "../components/Toast";
import { Icon } from "../icons";
import {
  cancelInstall,
  deployedListAgents,
  deployedOverview,
  deployedSaveAgent,
  describeIpcError,
  executeInstall,
  isTauriAvailable,
  pickDirectory,
  planInstall,
  subscribeInstallEvents,
  validateCustomSource,
  type DeployedAgent,
  type DeployedTargetState,
  type EnvironmentInfo,
  type InstallEvent,
  type InstallReport,
  type IpcFailure,
  type Plan,
  type Target,
} from "../lib/ipc";
import { AgentCard } from "./deploy/AgentCard";
import { AgentDetailPage } from "./deploy/AgentDetailPage";
import { BackendTabs, type TabDeploymentStatus } from "./deploy/BackendTabs";
import { DeployDialog, type DeployDialogFrom, type DeployView } from "./deploy/DeployDialog";
import { DshPresetEmpty, NotDeployedEmpty, RosterEmpty } from "./deploy/DeployEmptyStates";
import { ScopeBar } from "./deploy/ScopeBar";
import {
  DSH_PRESET_NAME,
  buildSelection,
  hhmmss,
  locationShort,
  nextLogId,
  type LogLine,
  type ProgressState,
  type RunState,
  type TerminalReport,
} from "./deploy/logic";
import * as scopeStore from "./deploy/scopeStore";

export type EnvStatus = "loading" | "ready" | "error";

export interface DeployPageProps {
  env: EnvironmentInfo | null;
  /** Detection is inform-only (§10.4) and now lives on the sidebar env card;
   *  the props remain for the App-shell contract but no longer drive this page. */
  envStatus: EnvStatus;
  envError: string | null;
  refreshEnv: () => void;
  appVersion: string | null;
  /** App-level unsaved-changes guard: nav away from 部署 runs through it too
   *  (notes §5.6). Returns false when the guard dialog was raised instead. */
  navGuardRef?: { current: ((proceed: () => void) => boolean) | null };
}

type DepState = "loading" | "notDeployed" | "deployed" | "error";

interface OverviewState {
  loading: boolean;
  rows: DeployedTargetState[] | null;
  error: IpcFailure | null;
}

interface RosterState {
  status: "loading" | "ok" | "error";
  agents: DeployedAgent[];
  error: IpcFailure | null;
}

interface LocalCheck {
  status: "idle" | "checking" | "pass" | "fail" | "error";
  problems: string[];
}

export function DeployPage({ env, appVersion, navGuardRef }: DeployPageProps) {
  const toast = useToast();

  /* ---------------- page state machine (notes §3) ---------------- */
  const [target, setTarget] = useState<Target>("opencode");
  const [overview, setOverview] = useState<OverviewState>({ loading: true, rows: null, error: null });
  const [rosters, setRosters] = useState<Record<Target, RosterState | undefined>>({
    opencode: undefined,
    claude: undefined,
    zcode: undefined,
    dsh: undefined,
  });
  /** Which agent's detail page is open, per target (survives tab switches, like the mockup).
   *  Non-null = the full-page detail view replaces the content area (notes §3). */
  const [openMap, setOpenMap] = useState<Record<Target, string | null>>({
    opencode: null,
    claude: null,
    zcode: null,
    dsh: null,
  });
  /** `${target}/${agent}` → unsaved flag (guard input). */
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  /** Bumped on 放弃更改 so the detail page remounts with a fresh draft. */
  const [editorEpoch, setEditorEpoch] = useState(0);
  /** Card to re-focus after 返回 (detail → roster; nice-to-have a11y return). */
  const pendingCardFocus = useRef<{ target: Target; name: string } | null>(null);
  /** Raised unsaved-changes guard. */
  const [guard, setGuard] = useState<{ name: string; proceed: () => void } | null>(null);

  /* ---------------- shared scope (page bar ↔ dialog) ---------------- */
  const scope = useSyncExternalStore(scopeStore.subscribe, scopeStore.getScope);

  /* ---------------- deploy-dialog machine state (lives above the dialog) ---- */
  const [dlgOpen, setDlgOpen] = useState(false);
  const [dlgFrom, setDlgFrom] = useState<DeployDialogFrom>("deploy");
  const [dlgView, setDlgView] = useState<DeployView>("config");
  const [srcMode, setSrcMode] = useState<"bundled" | "local">("bundled");
  const [localRoot, setLocalRoot] = useState("");
  const [force, setForce] = useState(false);

  const [plan, setPlan] = useState<Plan | null>(null);
  const [planStamp, setPlanStamp] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<IpcFailure | null>(null);

  const [run, setRun] = useState<RunState>("idle");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [report, setReport] = useState<TerminalReport | null>(null);
  const [stopDisabled, setStopDisabled] = useState(false);

  const [localCheck, setLocalCheck] = useState<LocalCheck>({ status: "idle", problems: [] });
  const [localCheckNonce, setLocalCheckNonce] = useState(0);

  /* ---------------- refs ---------------- */
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const targetRef = useRef(target);
  targetRef.current = target;

  const selection = useMemo(
    () =>
      buildSelection(
        srcMode,
        localRoot,
        scopeRef.current.projectDir,
        new Set<Target>([target]),
        scopeRef.current.userLevel,
        force,
      ),
    [srcMode, localRoot, target, force, scope.userLevel, scope.projectDir],
  );
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;

  /* STALE-PREVIEW RULE (SPEC §4.2): any config change invalidates the plan —
     including scope flips made in the page scope bar while the dialog holds a
     preview (single shared scope state). */
  const invalidate = useCallback(() => {
    setStale((s) => s || planRef.current !== null);
  }, []);

  /* ---------------- overview (deployment status source) ---------------- */
  const overviewSeq = useRef(0);
  const refreshOverview = useCallback(async () => {
    const seq = ++overviewSeq.current;
    setOverview((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const rows = await deployedOverview({
        projectDir: scopeStore.projectDirArg(),
        userLevel: scopeStore.getScope().userLevel,
      });
      if (seq !== overviewSeq.current) return;
      setOverview({ loading: false, rows, error: null });
    } catch (e) {
      if (seq !== overviewSeq.current) return;
      setOverview((prev) => ({ ...prev, loading: false, error: describeIpcError(e) }));
    }
  }, []);

  /* ---------------- roster ---------------- */
  const rosterSeq = useRef(0);
  const loadRoster = useCallback(async (t: Target) => {
    const seq = ++rosterSeq.current;
    setRosters((prev) => ({ ...prev, [t]: { status: "loading", agents: [], error: null } }));
    try {
      const agents = await deployedListAgents({
        target: t,
        projectDir: scopeStore.projectDirArg(),
        userLevel: scopeStore.getScope().userLevel,
      });
      if (seq !== rosterSeq.current) return;
      setRosters((prev) => ({ ...prev, [t]: { status: "ok", agents, error: null } }));
    } catch (e) {
      if (seq !== rosterSeq.current) return;
      setRosters((prev) => ({ ...prev, [t]: { status: "error", agents: [], error: describeIpcError(e) } }));
    }
  }, []);

  /* Last-known roster per target — keeps the open editor (with its draft)
     mounted across roster refetches triggered by scope changes / runs. */
  const agentsRef = useRef<Record<Target, DeployedAgent[]>>({
    opencode: [],
    claude: [],
    zcode: [],
    dsh: [],
  });

  const currentRow = overview.rows?.find((r) => r.target === target) ?? null;
  const depState: DepState = overview.error
    ? "error"
    : overview.rows === null && overview.loading
      ? "loading"
      : currentRow?.deployed === true
        ? "deployed"
        : "notDeployed";
  const roster = rosters[target] ?? null;
  if (roster?.status === "ok") agentsRef.current[target] = roster.agents;

  /* ---------------- install event wiring (dialog log pane) ---------------- */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void subscribeInstallEvents((ev: InstallEvent) => {
      if (ev.event === "log") {
        const cls = ev.level === "warn" ? "warn" : ev.level === "error" ? "err" : "";
        setLines((prev) => [
          ...prev,
          { id: nextLogId(), ts: hhmmss(new Date(ev.timeMs)), tg: ev.target ?? "系统", cls, text: ev.text },
        ]);
      } else if (ev.event === "progress") {
        setProgress({ phase: ev.phase, done: ev.done, total: ev.total });
      } else if (ev.event === "started") {
        setProgress({ phase: "准备中…", done: 0, total: ev.totalFiles });
      }
      // 'finished': the authoritative terminal state is the install command's return value.
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /* ---------------- boot: reconcile scope, then read deployment status ----- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await scopeStore.reconcileWithBackend();
      if (!cancelled) void refreshOverview();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshOverview]);

  /* Scope changes (page bar or dialog) refresh the overview; the first run is
     covered by the boot effect above. */
  const scopeEffectRan = useRef(false);
  useEffect(() => {
    if (!scopeEffectRan.current) {
      scopeEffectRan.current = true;
      return;
    }
    invalidate();
    void refreshOverview();
  }, [scope.userLevel, scope.projectDir, invalidate, refreshOverview]);

  /* ---------------- local source validation (debounced, dialog config) ----- */
  useEffect(() => {
    if (srcMode !== "local" || localRoot.trim() === "") {
      setLocalCheck({ status: "idle", problems: [] });
      return;
    }
    let cancelled = false;
    setLocalCheck({ status: "checking", problems: [] });
    const timer = window.setTimeout(async () => {
      try {
        const rep = await validateCustomSource(localRoot.trim());
        if (cancelled) return;
        const problems = [
          ...rep.tier1.problems.map((p) => `${p.check} — ${p.detail}`),
          ...(rep.tier2 && rep.tier2.status === "fail" ? rep.tier2.problems : []),
        ];
        setLocalCheck({ status: problems.length === 0 ? "pass" : "fail", problems });
      } catch (e) {
        if (cancelled) return;
        setLocalCheck({ status: "error", problems: [describeIpcError(e).message] });
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [srcMode, localRoot, localCheckNonce]);

  const revalidate = useCallback(() => setLocalCheckNonce((n) => n + 1), []);

  const prevalApplies = srcMode === "local" && target === "dsh";

  /* ---------------- derived gating (ported verbatim) ---------------- */
  const localInvalid = srcMode === "local" && localCheck.status === "fail";
  const prevalBlocking = prevalApplies && (localCheck.status === "checking" || localCheck.status === "fail");
  const canRun = plan !== null && !stale && run !== "running" && !planning && !localInvalid && !prevalBlocking;
  const runDisabledReason = prevalBlocking
    ? localCheck.status === "fail"
      ? "预校验未通过，安装已被阻止"
      : "正在预校验本地源…"
    : stale
      ? "选择已更改，请重新生成预览"
      : plan === null
        ? "先生成预览"
        : localInvalid
          ? "本地源无效，请重新选择"
          : run === "running"
            ? "正在安装"
            : "";
  const planDisabled = planning || localInvalid;
  const planDisabledReason = localInvalid
    ? "本地源无效 — 请选择包含 agents/ 的上层目录"
    : planning
      ? "正在生成预览…"
      : "";

  /* ---------------- roster loading effects ---------------- */
  useEffect(() => {
    if (depState !== "deployed" || target === "dsh") return;
    const cache = rosters[target];
    if (cache === undefined || cache.status === "error") void loadRoster(target);
  }, [depState, target, rosters, loadRoster]);

  /* A target that reads back as not deployed loses its open detail page + dirty
     flags (the deployed files are gone). */
  useEffect(() => {
    if (depState !== "notDeployed") return;
    setOpenMap((prev) => (prev[target] === null ? prev : { ...prev, [target]: null }));
    setDirty((prev) => {
      const prefix = `${target}/`;
      let changed = false;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.startsWith(prefix)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [depState, target]);

  /* A detail page whose agent vanished from the roster closes. */
  const openName = openMap[target];
  const editorAgent =
    openName !== null ? (agentsRef.current[target] ?? []).find((a) => a.name === openName) ?? null : null;
  useEffect(() => {
    if (roster?.status === "ok" && roster.agents.length === 0 && openMap[target] !== null) {
      setOpenMap((prev) => ({ ...prev, [target]: null }));
    }
  }, [roster, openMap, target]);

  /* ---------------- unsaved-changes guard (notes §5.6) ---------------- */
  const guardDep = useCallback(
    (proceed: () => void) => {
      navGuardRef?.current?.(proceed);
    },
    [navGuardRef],
  );

  // Refreshed every render so App-level nav always consults current state.
  useEffect(() => {
    if (!navGuardRef) return;
    navGuardRef.current = (proceed: () => void): boolean => {
      const name = openMap[target];
      if (name !== null && dirty[`${target}/${name}`] === true) {
        setGuard({ name, proceed });
        return false;
      }
      proceed();
      return true;
    };
  });

  const cancelGuard = useCallback(() => setGuard(null), []);
  const discardAndProceed = useCallback(() => {
    const g = guard;
    if (g !== null) {
      setDirty((prev) => {
        if (prev[`${target}/${g.name}`] !== true) return prev;
        const next = { ...prev };
        delete next[`${target}/${g.name}`];
        return next;
      });
      setEditorEpoch((e) => e + 1); // remount → fresh draft
    }
    setGuard(null);
    g?.proceed();
  }, [guard, target]);

  /* ---------------- deploy-machine actions (ported from the former page) ---- */
  const genPreview = useCallback(
    async (forceOverride?: boolean) => {
      const useForce = forceOverride ?? force;
      if (srcMode === "local" && localCheck.status === "fail") return;
      setPlanning(true);
      setPlanError(null);
      try {
        const p = await planInstall(
          buildSelection(
            srcMode,
            localRoot,
            scopeRef.current.projectDir,
            new Set<Target>([targetRef.current]),
            scopeRef.current.userLevel,
            useForce,
          ),
        );
        setPlan(p);
        setPlanStamp(hhmmss(new Date()));
        setStale(false);
        setDlgView("preview");
      } catch (e) {
        setPlanError(describeIpcError(e));
      } finally {
        setPlanning(false);
      }
    },
    [srcMode, localRoot, force, localCheck.status],
  );

  /** After any terminal install state the page re-queries deployed_overview —
     the run may have deployed (or partially written) the current target. */
  const refreshAfterRun = useCallback(
    (runTarget: Target) => {
      setRosters((prev) => ({ ...prev, [runTarget]: undefined }));
      void refreshOverview();
    },
    [refreshOverview],
  );

  const startInstall = useCallback(async () => {
    const currentPlan = planRef.current;
    if (!currentPlan || stale || run === "running") return;
    const runTarget = targetRef.current;
    setDlgView("log");
    setLines([]);
    setProgress(null);
    setReport(null);
    setStopDisabled(false);
    setRun("running");
    const startedAt = Date.now();
    try {
      const rep: InstallReport = await executeInstall(currentPlan, selectionRef.current);
      const durationMs = Date.now() - startedAt;
      const written = rep.created + rep.overwritten + rep.managedBlocks;
      if (rep.cancelled) {
        setRun("cancelled");
        setReport({ kind: "cancel", durationMs, filesWritten: written });
        toast({ kind: "warn", title: "安装已取消", sub: `第 ${written} 个文件后停止 · 已写入的文件保留` });
      } else {
        setRun("success");
        setReport({ kind: "ok", counts: rep, durationMs, filesWritten: written });
        toast({
          kind: "ok",
          title: "安装完成",
          sub: `${rep.created} 新建 · ${rep.skipped} 跳过 · ${rep.overwritten} 覆盖 · ${rep.managedBlocks} 受管块 · 用时 ${(durationMs / 1000).toFixed(1)}s`,
        });
      }
      refreshAfterRun(runTarget);
    } catch (e) {
      const failure = describeIpcError(e);
      const durationMs = Date.now() - startedAt;
      setRun("failed");
      setLines((prev) => [
        ...prev,
        { id: nextLogId(), ts: hhmmss(new Date()), tg: "系统", cls: "err", text: `${failure.title} — ${failure.message}` },
      ]);
      setReport({ kind: "err", errmsg: failure.message, durationMs, filesWritten: 0 });
      toast({ kind: "err", title: "安装失败", sub: failure.message });
      refreshAfterRun(runTarget);
    } finally {
      setStopDisabled(false);
    }
  }, [stale, run, toast, refreshAfterRun]);

  const stopInstall = useCallback(async () => {
    setStopDisabled(true);
    try {
      await cancelInstall();
    } catch (e) {
      const failure = describeIpcError(e);
      toast({ kind: "warn", title: "停止失败", sub: failure.message });
      setStopDisabled(false);
    }
  }, [toast]);

  const copyLog = useCallback(async () => {
    const text = lines.map((l) => `${l.ts} [${l.tg}] ${l.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast({ kind: "ok", title: "日志已复制" });
    } catch {
      toast({ kind: "warn", title: "复制失败", sub: "剪贴板不可用" });
    }
  }, [lines, toast]);

  const browse = useCallback(
    async (title: string, onPicked: (path: string) => void) => {
      const picked = await pickDirectory(title);
      if (picked) {
        onPicked(picked);
        return;
      }
      if (!isTauriAvailable()) {
        toast({ kind: "info", title: "浏览器预览模式", sub: "系统目录选择器不可用 — 请直接在输入框中填写路径" });
      }
    },
    [toast],
  );

  /* ---------------- dialog open (部署 / 更新) ---------------- */
  const openDeployDialog = useCallback(
    (from: DeployDialogFrom) => {
      // 更新 presets 覆盖 ON (SPEC §4.6); a flip with a held plan marks it stale.
      const nextForce = from === "update";
      if (nextForce !== force && planRef.current !== null) setStale(true);
      setForce(nextForce);
      setDlgFrom(from);
      setDlgView("config");
      setDlgOpen(true);
    },
    [force],
  );

  /* Every header/empty-state dialog invocation is an editor exit path —
     guarded like card/tab switches (notes §5.6). */
  const openDeploy = useCallback(
    (from: DeployDialogFrom) => {
      guardDep(() => openDeployDialog(from));
    },
    [guardDep, openDeployDialog],
  );

  const selectTab = useCallback(
    (t: Target) => {
      guardDep(() => {
        // The deploy dialog is scoped to the previous target — close it.
        setDlgOpen(false);
        setTarget(t);
      });
    },
    [guardDep],
  );

  const openCard = useCallback(
    (name: string) => {
      if (openMap[target] === name) return;
      guardDep(() => setOpenMap((prev) => ({ ...prev, [target]: name })));
    },
    [guardDep, openMap, target],
  );

  /* 返回: the detail page's only exit affordance — wrapped in the unsaved-changes
     guard exactly like the former ✕ close / card / tab / App-nav switches. */
  const backToRoster = useCallback(() => {
    guardDep(() => {
      pendingCardFocus.current = { target, name: openMap[target] ?? "" };
      setOpenMap((prev) => ({ ...prev, [target]: null }));
    });
  }, [guardDep, openMap, target]);

  /* Return focus to the originating card after 返回 (detail → roster); skipped
     when the guard proceeded somewhere else (e.g. a tab switch). */
  useEffect(() => {
    const p = pendingCardFocus.current;
    if (p === null) return;
    if (target !== p.target) {
      pendingCardFocus.current = null;
      return;
    }
    if (openMap[target] !== null || p.name === "") return;
    pendingCardFocus.current = null;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`.agc[data-ag="${CSS.escape(p.name)}"]`)?.focus();
    });
  }, [openMap, target]);

  /* ---------------- config change handlers (each invalidates) ---------------- */
  const pickSource = (mode: "bundled" | "local") => {
    if (mode === srcMode) return;
    setSrcMode(mode);
    invalidate();
  };

  const setForceOpt = (v: boolean) => {
    setForce(v);
    invalidate();
  };

  /* ---------------- editor save (deployed_save_agent) ---------------- */
  const handleEditorSave = useCallback(
    async (agent: DeployedAgent, body: string, settings: Record<string, string | null>): Promise<DeployedAgent> => {
      const t = targetRef.current;
      const saved = await deployedSaveAgent({
        target: t,
        projectDir: scopeStore.projectDirArg(),
        userLevel: scopeStore.getScope().userLevel,
        fileName: agent.fileName,
        body,
        settings,
      });
      setRosters((prev) => {
        const r = prev[t];
        if (r === undefined || r.status !== "ok") return prev;
        return { ...prev, [t]: { ...r, agents: r.agents.map((a) => (a.fileName === saved.fileName ? saved : a)) } };
      });
      agentsRef.current[t] = (agentsRef.current[t] ?? []).map((a) => (a.fileName === saved.fileName ? saved : a));
      setDirty((prev) => ({ ...prev, [`${t}/${saved.name}`]: false }));
      void refreshOverview();
      return saved;
    },
    [refreshOverview],
  );

  /* ---------------- derived render data ---------------- */
  const tabStatusOf = useCallback(
    (t: Target): TabDeploymentStatus => {
      if (overview.error !== null || overview.rows === null) return overview.loading ? "loading" : "error";
      const row = overview.rows.find((r) => r.target === t);
      if (row === undefined) return "error";
      return row.deployed ? "deployed" : "notDeployed";
    },
    [overview],
  );

  const statusLine = ((): { dot: string; text: string } => {
    if (depState === "loading") return { dot: "off", text: "正在读取部署状态…" };
    if (depState === "error") return { dot: "err", text: "读取失败" };
    if (depState === "notDeployed" || currentRow === null) return { dot: "off", text: "未部署" };
    if (target === "dsh") return { dot: "ok", text: `已部署 · 预设 ${DSH_PRESET_NAME}` };
    if (roster?.status === "ok") return { dot: "ok", text: `已部署 · ${roster.agents.length} 个智能体` };
    return { dot: "ok", text: "已部署" };
  })();

  const scopeLabel = currentRow?.scopeLabel ?? "";

  const cachedAgents = agentsRef.current[target] ?? [];

  /* View state (notes §3): roster (default) ↔ agent detail. The detail page
     replaces the whole content area below the page header — tab bar, scope bar
     and card list give way. It shows exactly where the former below-list editor
     rendered: deployed target whose roster is loading (cached agents) or loaded
     and non-empty; the roster-error / empty / not-deployed / overview-loading
     states keep rendering their own bodies, as before. */
  const rosterListVisible =
    roster === null || roster.status === "loading" || (roster.status === "ok" && roster.agents.length > 0);
  const showDetail = depState === "deployed" && target !== "dsh" && editorAgent !== null && rosterListVisible;

  const renderCards = (agents: DeployedAgent[]) => (
    <div className="agclist">
      {agents.map((a) => (
        <AgentCard
          key={a.fileName}
          target={target}
          agent={a}
          scopeLabel={scopeLabel}
          onOpen={() => openCard(a.name)}
        />
      ))}
    </div>
  );

  const renderDetailPage = (agent: DeployedAgent) => (
    /* adp-wrap: 20px top clearance for the floating window controls (§3.18) —
       the roster header row that normally provides it is not rendered here */
    <div className="dep-wrap adp-wrap">
      <AgentDetailPage
        key={`${target}/${agent.fileName}/${editorEpoch}`}
        target={target}
        agent={agent}
        onSave={(body, settings) => handleEditorSave(agent, body, settings)}
        onBack={backToRoster}
      />
    </div>
  );

  /* ---------------- markup ---------------- */
  return (
    <>
      {/* Roster view only (SPEC §4.1): title + subtitle + contextual header actions.
          In the detail view the page's own 返回 + name header is the title — this
          row (and its data-tauri-drag-region surface) gives way entirely. */}
      {!showDetail && (
        <header className="page-head" data-tauri-drag-region>
          <div>
            <h1 className="ph-title">部署</h1>
            <p className="ph-sub">管理各后端已部署的智能体与提示词 · 预览与安装均不访问网络</p>
          </div>
        </header>
      )}

      <div className="page-body">
        {showDetail && editorAgent !== null ? (
          /* Detail view (SPEC §3.22): the whole page — the roster header row
             above and the tabs / scope bar / cards below are not rendered. */
          renderDetailPage(editorAgent)
        ) : (
          <div className="dep-wrap">
            <div className="dep-toolbar">
              <BackendTabs value={target} statusOf={tabStatusOf} onSelect={selectTab} />
              <div className="dep-status">
                <span className={`dot ${statusLine.dot}`} />
                <span>{statusLine.text}</span>
              </div>
              {/* per-target actions (SPEC §4.5, 2026-10 move): deployment is per-backend,
                  so the buttons live in the selected backend's own toolbar row —
                  未部署 → 部署 · 已部署 → 更新 */}
              {depState === "notDeployed" && (
                <button type="button" className="btn btn-primary" onClick={() => openDeploy("deploy")}>
                  <Icon name="deploy" />
                  部署
                </button>
              )}
              {depState === "deployed" && (
                <button type="button" className="btn btn-primary" onClick={() => openDeploy("update")}>
                  <Icon name="up" />
                  更新
                </button>
              )}
            </div>

            <ScopeBar
              target={target}
              userLevel={scope.userLevel}
              projectDir={scope.projectDir}
              onUserLevel={scopeStore.setUserLevel}
              onProjectDir={scopeStore.setProjectDir}
              onBrowse={() => void browse("选择项目目录", scopeStore.setProjectDir)}
              env={env}
            />

            {/* per-state body (notes §5.1: no flash of the empty state while loading) */}
            <div className="dep-main" id="depMain">
              {depState === "loading" ? null : depState === "error" ? (
                <div className="bn err">
                  <Icon name="warn" />
                  <div className="bn-c">
                    <div className="bn-t">部署状态读取失败 — {overview.error?.message ?? "后端未就绪"}</div>
                  </div>
                  <div className="bn-a">
                    <button type="button" className="btn btn-sm" onClick={() => void refreshOverview()}>
                      <Icon name="ref" />
                      重试
                    </button>
                  </div>
                </div>
              ) : depState === "notDeployed" ? (
                <NotDeployedEmpty
                  target={target}
                  locationLabel={locationShort(target, scope.userLevel)}
                  onDeploy={() => openDeploy("deploy")}
                />
              ) : target === "dsh" ? (
                <DshPresetEmpty
                  home={env?.dsh.home ?? "—"}
                  profile={env?.dsh.profile ?? null}
                  presetFileCount={currentRow?.presetFileCount ?? null}
                  deployedAtMs={currentRow?.deployedAtMs ?? null}
                />
              ) : roster === null || roster.status === "loading" ? (
                <>
                  {/* notes §5.1: spinner line above the card list; last-known
                      cards stay visible across refetches (an open agent shows
                      the detail page instead — see showDetail above) */}
                  <div className="fhint roster-loading">
                    <span className="spin" />
                    正在读取智能体列表…
                  </div>
                  {cachedAgents.length > 0 && renderCards(cachedAgents)}
                </>
              ) : roster.status === "error" ? (
                <div className="bn err">
                  <Icon name="warn" />
                  <div className="bn-c">
                    <div className="bn-t">智能体列表读取失败 — {roster.error?.message ?? "后端未就绪"}</div>
                  </div>
                  <div className="bn-a">
                    <button type="button" className="btn btn-sm" onClick={() => void loadRoster(target)}>
                      <Icon name="ref" />
                      重试
                    </button>
                  </div>
                </div>
              ) : roster.agents.length === 0 ? (
                <RosterEmpty />
              ) : (
                renderCards(roster.agents)
              )}
            </div>
          </div>
        )}
      </div>

      {/* target-scoped deploy dialog — state lives above, closing keeps runs going */}
      <DeployDialog
        open={dlgOpen}
        from={dlgFrom}
        view={dlgView}
        target={target}
        onView={setDlgView}
        onClose={() => setDlgOpen(false)}
        env={env}
        appVersion={appVersion}
        userLevel={scope.userLevel}
        projectDir={scope.projectDir}
        onUserLevel={scopeStore.setUserLevel}
        onProjectDir={scopeStore.setProjectDir}
        onBrowseProject={() => void browse("选择项目目录", scopeStore.setProjectDir)}
        srcMode={srcMode}
        onSrcMode={pickSource}
        localRoot={localRoot}
        onLocalRoot={(root) => {
          setLocalRoot(root);
          invalidate();
        }}
        onBrowseLocal={() =>
          void browse("选择本地源目录", (p) => {
            setLocalRoot(p);
            invalidate();
          })
        }
        localCheck={localCheck}
        onRevalidate={revalidate}
        force={force}
        onForceToggle={setForceOpt}
        plan={plan}
        planStamp={planStamp}
        stale={stale}
        planning={planning}
        planError={planError}
        canRun={canRun}
        runDisabledReason={runDisabledReason}
        planDisabled={planDisabled}
        planDisabledReason={planDisabledReason}
        onGenPreview={() => void genPreview()}
        onStartInstall={() => void startInstall()}
        run={run}
        lines={lines}
        progress={progress}
        report={report}
        stopDisabled={stopDisabled}
        onStop={() => void stopInstall()}
        onCopyLog={() => void copyLog()}
        onRetry={() => void startInstall()}
      />

      {/* unsaved-changes guard (SPEC §3.22) — Esc/backdrop = 取消 */}
      <Dialog
        open={guard !== null}
        onClose={cancelGuard}
        title="放弃未保存的更改？"
        icon="warn"
        width={440}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={cancelGuard}>
              取消
            </button>
            <button type="button" className="btn btn-warn" onClick={discardAndProceed}>
              放弃更改
            </button>
          </>
        }
      >
        <span>
          关闭后将丢失对 <b className="mono">{guard?.name ?? ""}</b> 提示词的修改。
        </span>
      </Dialog>
    </>
  );
}
