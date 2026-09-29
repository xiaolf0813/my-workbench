// Area 1 — 部署 (SPEC §4): config column (内容源 / 安装方式 / 安装目标 /
// pre-validation banner) + the preview panel, wired to the typed IPC layer with
// graceful degradation when the backend is a stub or absent.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { Icon, type IconName } from "../icons";
import {
  cancelInstall,
  checkDrift,
  describeIpcError,
  executeInstall,
  isTauriAvailable,
  pickDirectory,
  planInstall,
  subscribeInstallEvents,
  validateCustomSource,
  type DriftFile,
  type DriftReport,
  type EnvironmentInfo,
  type InstallEvent,
  type InstallReport,
  type IpcFailure,
  type Plan,
  type Target,
} from "../lib/ipc";
import { PreviewPanel } from "./deploy/PreviewPanel";
import { DriftDialog } from "./deploy/DriftDialog";
import {
  buildSelection,
  bundledVersionLabel,
  detailPresent,
  dshCardState,
  hhmmss,
  nextLogId,
  targetDetail,
  versionLabel,
  type LogLine,
  type PlanFilter,
  type ProgressState,
  type RunState,
  type TabId,
  type TerminalReport,
} from "./deploy/logic";

export type EnvStatus = "loading" | "ready" | "error";

export interface DeployPageProps {
  env: EnvironmentInfo | null;
  envStatus: EnvStatus;
  envError: string | null;
  refreshEnv: () => void;
  appVersion: string | null;
}

type LocalCheckStatus = "idle" | "checking" | "pass" | "fail" | "error";

interface LocalCheck {
  status: LocalCheckStatus;
  problems: string[];
}

const ALL_TARGETS: Target[] = ["opencode", "omos", "claude", "zcode", "dsh", "openbitfun"];

/** 安装方式 segmented options (SPEC §4.1). The pressed visual state (`.is-on`
 *  class AND `aria-pressed`) is derived from the single comparison
 *  `opt.userLevel === user` at render time — both carriers follow the same
 *  userLevel state and cannot diverge from each other or from Selection. */
const SCOPE_OPTS: Array<{ userLevel: boolean; icon: IconName; label: string; sub: string }> = [
  { userLevel: false, icon: "folder", label: "目录级安装", sub: "安装到项目目录" },
  { userLevel: true, icon: "set", label: "用户级安装", sub: "安装到用户配置目录" },
];

export function DeployPage({ env, envStatus, envError, refreshEnv, appVersion }: DeployPageProps) {
  const toast = useToast();

  /* ---------------- selection state ---------------- */
  const [srcMode, setSrcMode] = useState<"bundled" | "local">("bundled");
  const [localRoot, setLocalRoot] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [targets, setTargets] = useState<Set<Target>>(() => new Set<Target>(["opencode", "claude", "zcode"]));
  // 安装方式 segmented control (SPEC §4.1): false = 目录级安装, true = 用户级安装.
  // Maps 1:1 to Selection.userLevel; projectDir is still sent either way (the
  // backend ignores it for user-level targets).
  const [user, setUser] = useState(false);
  const [force, setForce] = useState(false);

  /* ---------------- preview state ---------------- */
  const [tab, setTab] = useState<TabId>("preview");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planStamp, setPlanStamp] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<IpcFailure | null>(null);
  const [filter, setFilter] = useState<PlanFilter>("all");

  /* ---------------- install run state ---------------- */
  const [run, setRun] = useState<RunState>("idle");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [report, setReport] = useState<TerminalReport | null>(null);
  const [stopDisabled, setStopDisabled] = useState(false);

  /* ---------------- health state ---------------- */
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthReport, setHealthReport] = useState<DriftReport | null>(null);
  const [healthError, setHealthError] = useState<IpcFailure | null>(null);
  const [healthCheckedAt, setHealthCheckedAt] = useState<Date | null>(null);
  const [driftFile, setDriftFile] = useState<DriftFile | null>(null);

  /* ---------------- local-source validation / pre-validation ---------------- */
  const [localCheck, setLocalCheck] = useState<LocalCheck>({ status: "idle", problems: [] });
  const [localCheckNonce, setLocalCheckNonce] = useState(0);

  const selection = useMemo(
    () => buildSelection(srcMode, localRoot, projectPath, targets, user, force),
    [srcMode, localRoot, projectPath, targets, user, force],
  );
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;

  /* STALE-PREVIEW RULE (SPEC §4.2): any config change invalidates the plan. */
  const invalidate = useCallback(() => {
    setStale((s) => s || planRef.current !== null);
  }, []);

  /* ---------------- install event wiring ---------------- */
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

  /* ---------------- local source validation (debounced) ---------------- */
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

  const prevalApplies = srcMode === "local" && targets.has("dsh");

  /* ---------------- derived gating ---------------- */
  const localInvalid = srcMode === "local" && localCheck.status === "fail";
  const prevalBlocking =
    prevalApplies && (localCheck.status === "checking" || localCheck.status === "fail");
  const canRun =
    plan !== null && !stale && run !== "running" && !planning && !localInvalid && !prevalBlocking;
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

  /* ---------------- actions ---------------- */
  const genPreview = useCallback(
    async (forceOverride?: boolean) => {
      const useForce = forceOverride ?? force;
      if (srcMode === "local" && localCheck.status === "fail") return;
      setPlanning(true);
      setPlanError(null);
      try {
        const p = await planInstall(buildSelection(srcMode, localRoot, projectPath, targets, user, useForce));
        setPlan(p);
        setPlanStamp(hhmmss(new Date()));
        setStale(false);
        setFilter("all");
        setTab("preview");
      } catch (e) {
        setPlanError(describeIpcError(e));
      } finally {
        setPlanning(false);
      }
    },
    [srcMode, localRoot, projectPath, targets, user, force, localCheck.status],
  );

  const startInstall = useCallback(async () => {
    const currentPlan = planRef.current;
    if (!currentPlan || stale || run === "running") return;
    setTab("log");
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
    } finally {
      setStopDisabled(false);
    }
  }, [stale, run, toast]);

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

  const runHealthCheck = useCallback(async () => {
    setHealthChecking(true);
    setHealthError(null);
    try {
      const rep = await checkDrift(selectionRef.current);
      setHealthReport(rep);
      setHealthCheckedAt(new Date());
    } catch (e) {
      setHealthError(describeIpcError(e));
    } finally {
      setHealthChecking(false);
    }
  }, []);

  const runHealthCheckFromReport = useCallback(() => {
    setTab("health");
    void runHealthCheck();
  }, [runHealthCheck]);

  /** Locked drift repair (§10.3): force ON → regenerate preview → normal flow. */
  const driftRepair = useCallback(async () => {
    setDriftFile(null);
    setForce(true);
    await genPreview(true);
    toast({
      kind: "warn",
      title: "已开启覆盖模式并重新生成预览",
      sub: "请确认预览后点击「开始安装」",
    });
  }, [genPreview, toast]);

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

  /* ---------------- config change handlers (each invalidates) ---------------- */
  const pickSource = (mode: "bundled" | "local") => {
    if (mode === srcMode) return;
    setSrcMode(mode);
    invalidate();
  };

  const onSourceRadioKey = (pick: () => void) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      pick();
    }
  };

  const toggleTarget = (t: Target, checked: boolean) => {
    setTargets((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(t);
        // opencode / omos mutex — selecting one deselects the other (SPEC §4.1)
        if (t === "opencode") next.delete("omos");
        if (t === "omos") next.delete("opencode");
      } else {
        next.delete(t);
      }
      return next;
    });
    invalidate();
  };

  const setScope = (userLevel: boolean) => {
    if (userLevel === user) return;
    setUser(userLevel);
    invalidate();
  };

  const setForceOpt = (v: boolean) => {
    setForce(v);
    invalidate();
  };

  /* ---------------- detection rendering ---------------- */
  const detectionFor = useCallback(
    (t: Target): { dot: "ok" | "off"; text: string } => {
      if (envStatus === "loading") return { dot: "off", text: "正在检测环境…" };
      if (envStatus === "error" || !env) return { dot: "off", text: "检测不可用" };
      if (t === "opencode") {
        return env.opencode.present
          ? { dot: "ok", text: `已检测到 ${versionLabel(env.opencode.version)}`.trim() }
          : { dot: "off", text: "未检测到" };
      }
      if (t === "dsh") {
        const s = dshCardState(env.dsh);
        return { dot: s.dot, text: s.text };
      }
      if (t === "openbitfun") {
        return env.openbitfun.exists
          ? { dot: "ok", text: env.openbitfun.configDir }
          : { dot: "off", text: "未找到配置目录 · 仍可安装" };
      }
      // omos / claude / zcode: only a free-form detail string is available.
      const d = targetDetail(env, t);
      if (!detailPresent(d)) return { dot: "off", text: d && d.trim() ? d : "未检测到" };
      return { dot: "ok", text: d as string };
    },
    [env, envStatus],
  );

  const targetCard = (t: Target) => {
    const on = targets.has(t);
    const disabled = (t === "opencode" && targets.has("omos")) || (t === "omos" && targets.has("opencode"));
    const mutex = t === "omos" && targets.has("opencode");
    const det = detectionFor(t);
    const dshChip = t === "dsh" && env !== null && envStatus === "ready" && dshCardState(env.dsh).chip;
    return (
      <label key={t} className={`tck${on ? " is-on" : ""}${disabled ? " is-dis" : ""}`}>
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => toggleTarget(t, e.target.checked)} />
        <span className="trow">
          <span className="tbox">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
          <span className="tname">{t}</span>
        </span>
        <span className="tstat">
          <span className={`dot ${mutex ? "off" : det.dot}`} />
          {mutex ? (
            <span className="mutex">与 opencode 互斥</span>
          ) : (
            <span>{det.text}</span>
          )}
        </span>
        {dshChip && (
          <span className="textra">
            <span className="envchip">DSH_HOME 已覆盖</span>
          </span>
        )}
      </label>
    );
  };

  /* ---------------- health context line ---------------- */
  const healthSrc =
    srcMode === "bundled"
      ? `内置源 ${bundledVersionLabel(env, appVersion)}`
      : `本地源 ${localRoot.trim() || "（未填写）"}`;
  const healthDir = user ? "用户级 ~" : projectPath.trim() || "（未填写项目目录）";

  /* ---------------- markup ---------------- */
  return (
    <>
      <header className="page-head" data-tauri-drag-region>
        <div>
          <h1 className="ph-title">部署</h1>
          <p className="ph-sub">将多智能体编排系统安装到项目目录或用户配置目录 · 预览与安装均不访问网络</p>
        </div>
        <div className="ph-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void genPreview()}
            disabled={planDisabled}
            title={planDisabled ? planDisabledReason : undefined}
          >
            {planning ? <span className="spin" /> : <Icon name="layers" />}
            生成预览
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void startInstall()}
            disabled={!canRun}
            title={canRun ? undefined : runDisabledReason}
          >
            <Icon name="play" />
            开始安装
          </button>
        </div>
      </header>

      <div className="page-body dgrid">
        {/* ---- config column ---- */}
        <div className="dcol">
          <div className="card">
            <div className="card-h">
              <span className="card-t">内容源</span>
              <span className="card-s">渲染所用的 agents/ 树</span>
            </div>
            <div className="card-b">
              <div className="srcgrid" role="radiogroup" aria-label="内容源">
                <div
                  className={`src${srcMode === "bundled" ? " is-on" : ""}`}
                  role="radio"
                  aria-checked={srcMode === "bundled"}
                  tabIndex={0}
                  onClick={() => pickSource("bundled")}
                  onKeyDown={onSourceRadioKey(() => pickSource("bundled"))}
                >
                  <span className="src-rad" />
                  <div className="src-c">
                    <div className="src-t">
                      内置源 <span className="vchip">{bundledVersionLabel(env, appVersion)}</span>
                    </div>
                    <div className="src-s">随应用打包</div>
                  </div>
                </div>
                <div
                  className={`src${srcMode === "local" ? " is-on" : ""}`}
                  role="radio"
                  aria-checked={srcMode === "local"}
                  tabIndex={0}
                  onClick={() => pickSource("local")}
                  onKeyDown={onSourceRadioKey(() => pickSource("local"))}
                >
                  <span className="src-rad" />
                  <div className="src-c">
                    <div className="src-t">本地源</div>
                    <div className="src-s">选择包含 agents/ 的目录（维护者工作流）</div>
                  </div>
                </div>
              </div>
              {srcMode === "local" && (
                <div className="local-panel">
                  <div className="path">
                    <div className="path-in">
                      <input
                        value={localRoot}
                        onChange={(e) => setLocalRoot(e.target.value)}
                        spellCheck={false}
                        aria-label="本地源目录"
                        placeholder="D:\repos\my-fork"
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ height: 32 }}
                      onClick={() => void browse("选择本地源目录", setLocalRoot)}
                    >
                      <Icon name="folder" />
                      浏览…
                    </button>
                  </div>
                  {localCheck.status === "checking" && (
                    <div className="fhint">
                      <span className="spin" />
                      正在校验本地源…
                    </div>
                  )}
                  {localCheck.status === "pass" && (
                    <div className="fhint ok">
                      <Icon name="checkc" />
                      agents/ 树有效 · 检测到 6 个后端 · dsh 插件结构完整
                    </div>
                  )}
                  {localCheck.status === "fail" && (
                    <div className="fhint err">
                      <Icon name="xc" />
                      未找到 agents/ 目录 — 请选择包含 agents/ 的上层目录
                    </div>
                  )}
                  {localCheck.status === "error" && (
                    <div className="fhint warn">
                      <Icon name="warn" />
                      <span>本地源校验不可用 — 后端未就绪</span>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={revalidate}>
                        重新校验
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <span className="card-t">安装方式</span>
            </div>
            <div className="card-b">
              {/* scope toggle — `.is-on` and `aria-pressed` both come from the
                  same `o.userLevel === user` comparison (SPEC §9) */}
              <div className="seg seg-scope" role="group" aria-label="安装方式">
                {SCOPE_OPTS.map((o) => {
                  const on = o.userLevel === user;
                  return (
                    <button
                      key={o.label}
                      type="button"
                      className={`seg-b${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() => setScope(o.userLevel)}
                    >
                      <Icon name={o.icon} />
                      <span className="seg-sc">
                        <span>{o.label}</span>
                        <span className="seg-st">{o.sub}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {user ? (
                <div className="fhint">
                  <Icon name="info" />
                  安装到用户配置目录而非项目目录
                </div>
              ) : (
                <div className="field">
                  <div className="path">
                    <div className="path-in">
                      <input
                        value={projectPath}
                        onChange={(e) => {
                          setProjectPath(e.target.value);
                          invalidate();
                        }}
                        spellCheck={false}
                        aria-label="项目目录"
                        placeholder="D:\dev\acme-web"
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ height: 32 }}
                      onClick={() => void browse("选择项目目录", (p) => { setProjectPath(p); invalidate(); })}
                    >
                      <Icon name="folder" />
                      浏览…
                    </button>
                  </div>
                  <div className="fhint">
                    <Icon name="info" />
                    项目目录 = opencode / claude 项目级安装根目录
                  </div>
                </div>
              )}
              <div className="opts scope-opts">
                <div className="opt">
                  <div className="opt-c">
                    <div className="opt-t">覆盖已存在文件</div>
                    {force ? (
                      <div className="opt-s warn">已开启 — 已存在的文件将被直接覆盖，请确认</div>
                    ) : (
                      <div className="opt-s">默认跳过已存在的文件</div>
                    )}
                  </div>
                  <Switch checked={force} onChange={setForceOpt} label="覆盖已存在文件" />
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <span className="card-t">安装目标</span>
              <span className="card-s">已选 {targets.size} 个</span>
              <span className="card-hr">
                <button
                  type="button"
                  className="icon-btn"
                  title="重新检测环境"
                  onClick={refreshEnv}
                  disabled={envStatus === "loading"}
                >
                  <Icon name="ref" />
                </button>
              </span>
            </div>
            <div className="card-b">
              <div className="tgrid">{ALL_TARGETS.map(targetCard)}</div>
              <div className="mutex-line">
                <Icon name="info" />
                <span>opencode 与 omos 为同一运行时的两种宿主形态，互斥；未检测到仍可安装。</span>
              </div>
              {envStatus === "error" && (
                <div className="fhint err" style={{ marginTop: 8 }}>
                  <Icon name="warn" />
                  <span>环境检测失败 — {envError ?? "后端未就绪"}</span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={refreshEnv}>
                    重新检测
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* custom-source pre-validation banner (local source + DSH target) */}
          {prevalApplies && localCheck.status !== "idle" && (
            <div>
              {localCheck.status === "checking" && (
                <div className="bn info">
                  <span className="spin" />
                  <div className="bn-c">
                    <div className="bn-t" style={{ color: "var(--accent)" }}>
                      正在预校验本地源…
                    </div>
                    <div className="bn-s">本地源 + DSH 目标：安装前必须先通过执行状态检查。</div>
                  </div>
                </div>
              )}
              {localCheck.status === "pass" && (
                <div className="bn ok">
                  <Icon name="checkc" />
                  <div className="bn-c">
                    <div className="bn-t">预校验通过 · 3 项执行检查</div>
                    <div className="bn-s">本地源渲染的 DSH 工件通过全部执行检查 — 可以开始安装。</div>
                  </div>
                </div>
              )}
              {localCheck.status === "fail" && (
                <div className="bn err">
                  <Icon name="warn" />
                  <div className="bn-c">
                    <div className="bn-t">预校验未通过 · 安装已阻止</div>
                    <div className="bn-s">本地源需先通过预校验：</div>
                    <ul>
                      {localCheck.problems.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="bn-a">
                    <button type="button" className="btn btn-sm" onClick={revalidate}>
                      <Icon name="ref" />
                      重新校验
                    </button>
                  </div>
                </div>
              )}
              {localCheck.status === "error" && (
                <div className="bn mut">
                  <Icon name="info" />
                  <div className="bn-c">
                    <div className="bn-t">预校验不可用 — 后端未就绪</div>
                    <div className="bn-s">{localCheck.problems[0] ?? "预校验暂不可用。"}</div>
                  </div>
                  <div className="bn-a">
                    <button type="button" className="btn btn-sm" onClick={revalidate}>
                      <Icon name="ref" />
                      重新校验
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---- preview column ---- */}
        <PreviewPanel
          tab={tab}
          onTab={setTab}
          forceOn={force}
          scopeLabel={user ? "用户级" : "项目级"}
          plan={plan}
          planStamp={planStamp}
          stale={stale}
          planning={planning}
          planError={planError}
          filter={filter}
          onFilter={setFilter}
          onRegenerate={() => void genPreview()}
          run={run}
          lines={lines}
          progress={progress}
          report={report}
          onStop={() => void stopInstall()}
          stopDisabled={stopDisabled}
          onCopyLog={() => void copyLog()}
          onRetry={() => void startInstall()}
          onRunHealthCheck={runHealthCheckFromReport}
          healthSrc={healthSrc}
          healthDir={healthDir}
          healthChecking={healthChecking}
          healthReport={healthReport}
          healthError={healthError}
          healthCheckedAt={healthCheckedAt}
          nodeVersion={env?.node.version ?? null}
          onRecheck={() => void runHealthCheck()}
          onOpenDrift={setDriftFile}
        />
      </div>

      <DriftDialog file={driftFile} onClose={() => setDriftFile(null)} onRepair={() => void driftRepair()} />
    </>
  );
}
