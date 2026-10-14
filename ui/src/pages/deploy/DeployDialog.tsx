// Target-scoped deploy dialog (SPEC §3.24/§4.6): the former page-level deploy
// workspace — 内容源, 安装位置 (scope for opencode/claude, fixed location for
// zcode/dsh), 覆盖 switch, plan preview, streaming install log with
// cooperative cancel — moved verbatim in behavior into
// a 720px dialog scoped to ONE target. State lives above (DeployPage): closing
// mid-run never cancels the run, reopening shows the live log/progress state.
import type { ReactNode } from "react";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../icons";
import type { EnvironmentInfo, IpcFailure, Plan, Target } from "../../lib/ipc";
import { PreviewPanel, type DeployView } from "./PreviewPanel";
import { bundledVersionLabel, realmLabel, type LogLine, type ProgressState, type RunState, type TerminalReport } from "./logic";

export type { DeployView };
export type DeployDialogFrom = "deploy" | "update";

interface LocalCheck {
  status: "idle" | "checking" | "pass" | "fail" | "error";
  problems: string[];
}

interface DeployDialogProps {
  open: boolean;
  from: DeployDialogFrom;
  view: DeployView;
  target: Target;
  onView: (v: DeployView) => void;
  onClose: () => void;

  env: EnvironmentInfo | null;
  appVersion: string | null;

  /* shared scope (page scope bar ↔ dialog 安装位置) */
  userLevel: boolean;
  projectDir: string;
  onUserLevel: (userLevel: boolean) => void;
  onProjectDir: (dir: string) => void;
  onBrowseProject: () => void;

  /* config machine */
  srcMode: "bundled" | "local";
  onSrcMode: (m: "bundled" | "local") => void;
  localRoot: string;
  onLocalRoot: (root: string) => void;
  onBrowseLocal: () => void;
  localCheck: LocalCheck;
  onRevalidate: () => void;
  force: boolean;
  onForceToggle: (force: boolean) => void;

  /* plan + run machine (state owned by DeployPage) */
  plan: Plan | null;
  planStamp: string | null;
  stale: boolean;
  planning: boolean;
  planError: IpcFailure | null;
  canRun: boolean;
  runDisabledReason: string;
  planDisabled: boolean;
  planDisabledReason: string;
  onGenPreview: () => void;
  onStartInstall: () => void;

  run: RunState;
  lines: LogLine[];
  progress: ProgressState | null;
  report: TerminalReport | null;
  stopDisabled: boolean;
  onStop: () => void;
  onCopyLog: () => void;
  onRetry: () => void;
}

const VIEWS: { id: DeployView; label: string }[] = [
  { id: "config", label: "配置" },
  { id: "preview", label: "预览" },
  { id: "log", label: "安装日志" },
];

export function DeployDialog(props: DeployDialogProps) {
  const {
    open, from, view, target, onView, onClose,
    env, appVersion,
    userLevel, projectDir, onUserLevel, onProjectDir, onBrowseProject,
    srcMode, onSrcMode, localRoot, onLocalRoot, onBrowseLocal, localCheck, onRevalidate,
    force, onForceToggle,
    plan, planStamp, stale, planning, planError,
    canRun, runDisabledReason, planDisabled, planDisabledReason, onGenPreview, onStartInstall,
    run, lines, progress, report, stopDisabled, onStop, onCopyLog, onRetry,
  } = props;

  const oc = target === "opencode" || target === "claude";
  const prevalApplies = srcMode === "local" && target === "dsh";

  /* 2px live bar across the dialog top (§3.9) */
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : run === "success"
        ? 100
        : 0;
  const livebarClass =
    run === "idle" ? "livebar" : `livebar is-on${run === "success" || run === "failed" ? " done" : ""}`;

  const fixedLocation: ReactNode =
    target === "zcode" ? (
      <>
        <span className="dep-loclabel">安装位置</span>
        <span className="dep-loc">
          <span className="mono">~\.zcode</span>
        </span>
        <span className="fixchip">固定</span>
      </>
    ) : (
      <>
        <span className="dep-loclabel">安装位置</span>
        <span className="dep-loc">
          <span className="mono">DSH_HOME → {env?.dsh.home ?? "—"}</span>
          <span className="mono">· profile {env?.dsh.profile ?? "—"}</span>
        </span>
        {env !== null && env.dsh.homeSource === "env" && <span className="envchip">DSH_HOME 已覆盖</span>}
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="dlg-dep"
      icon="deploy"
      title={`${from === "update" ? "更新" : "部署"} · ${target}`}
      before={
        <div className={livebarClass}>
          <i style={{ width: run === "idle" ? 0 : `${pct}%` }} />
        </div>
      }
      footer={
        view === "config" || view === "preview" ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              onClick={onGenPreview}
              disabled={planDisabled}
              title={planDisabled ? planDisabledReason : undefined}
            >
              {planning ? <span className="spin" /> : <Icon name="layers" />}
              {view === "preview" ? "重新生成" : "生成预览"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onStartInstall}
              disabled={!canRun}
              title={canRun ? undefined : runDisabledReason}
            >
              <Icon name="play" />
              开始安装
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      <div className="dlg-tabrow">
        <div className="seg" role="tablist" aria-label="部署步骤">
          {VIEWS.map((v) => {
            const on = view === v.id;
            return (
              <button
                key={v.id}
                type="button"
                className={`seg-b${on ? " is-on" : ""}`}
                role="tab"
                aria-selected={on}
                onClick={() => onView(v.id)}
              >
                {v.label}
                {v.id === "log" && run === "running" && <span className="pulse" />}
              </button>
            );
          })}
        </div>
        {force && <span className="bd bd-over">覆盖已开启</span>}
        <span className="mut num" style={{ fontSize: 11.5 }}>
          {realmLabel(target, userLevel)} · 0 写入
        </span>
      </div>

      {/* ===== config pane ===== */}
      <div className={`dpane${view === "config" ? " is-on" : ""}`} role="tabpanel" aria-label="配置" hidden={view !== "config"}>
        <div className="dsec-t">内容源</div>
        <div className="srcgrid" role="radiogroup" aria-label="内容源">
          <div
            className={`src${srcMode === "bundled" ? " is-on" : ""}`}
            role="radio"
            aria-checked={srcMode === "bundled"}
            tabIndex={0}
            onClick={() => onSrcMode("bundled")}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onSrcMode("bundled");
              }
            }}
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
            onClick={() => onSrcMode("local")}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onSrcMode("local");
              }
            }}
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
                  onChange={(e) => onLocalRoot(e.target.value)}
                  spellCheck={false}
                  aria-label="本地源目录"
                  placeholder="D:\repos\my-fork"
                />
              </div>
              <button type="button" className="btn btn-sm" style={{ height: 32 }} onClick={onBrowseLocal}>
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
                agents/ 树有效 · 检测到 4 个后端 · dsh 插件结构完整
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
                <button type="button" className="btn btn-sm btn-ghost" onClick={onRevalidate}>
                  重新校验
                </button>
              </div>
            )}
          </div>
        )}

        <div className="dsec-t">安装位置</div>
        {oc ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="seg" role="group" aria-label="安装方式">
              <button
                type="button"
                className={`seg-b${!userLevel ? " is-on" : ""}`}
                aria-pressed={!userLevel}
                onClick={() => onUserLevel(false)}
              >
                项目级
              </button>
              <button
                type="button"
                className={`seg-b${userLevel ? " is-on" : ""}`}
                aria-pressed={userLevel}
                onClick={() => onUserLevel(true)}
              >
                用户级
              </button>
            </div>
            {!userLevel && (
              <div className="path">
                <div className="path-in">
                  <input
                    value={projectDir}
                    onChange={(e) => onProjectDir(e.target.value)}
                    spellCheck={false}
                    aria-label="项目目录"
                    placeholder="D:\dev\acme-web"
                  />
                </div>
                <button type="button" className="btn btn-sm" style={{ height: 32 }} onClick={onBrowseProject}>
                  <Icon name="folder" />
                  浏览…
                </button>
              </div>
            )}
            {userLevel ? (
              <div className="fhint">
                <Icon name="info" />
                安装到用户配置目录而非项目目录
              </div>
            ) : (
              <div className="fhint">
                <Icon name="info" />
                项目目录 = opencode / claude 项目级安装根目录
              </div>
            )}
          </div>
        ) : (
          <div className="dep-loc">{fixedLocation}</div>
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
            <button
              type="button"
              className="sw"
              role="switch"
              aria-checked={force}
              aria-label="覆盖已存在文件"
              onClick={() => onForceToggle(!force)}
            />
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
                  <button type="button" className="btn btn-sm" onClick={onRevalidate}>
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
                  <button type="button" className="btn btn-sm" onClick={onRevalidate}>
                    <Icon name="ref" />
                    重新校验
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== preview / log panes (ported component) ===== */}
      <PreviewPanel
        view={view}
        plan={plan}
        planStamp={planStamp}
        stale={stale}
        planError={planError}
        onRegenerate={onGenPreview}
        run={run}
        lines={lines}
        progress={progress}
        report={report}
        onStop={onStop}
        stopDisabled={stopDisabled}
        onCopyLog={onCopyLog}
        onRetry={onRetry}
      />
    </Dialog>
  );
}
