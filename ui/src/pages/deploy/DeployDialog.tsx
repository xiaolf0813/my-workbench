// Target-scoped deploy dialog (SPEC §3.24/§4.6): one target, one body, one
// step. [变更 2026-10 极简部署弹窗] Both entries (部署 / 更新) render the
// identical minimal body — just the 覆盖 switch (the update entry presets it
// ON, owned by DeployPage openDeployDialog) — plus a 取消/安装 footer; 安装
// plans and executes in one step page-side at click time. The source is always
// bundled (the selection is built page-side) and the scope (项目级/用户级 +
// 项目目录) lives on the page's scope bar — the dialog carries neither. State
// lives above (DeployPage): closing mid-run never cancels the run, reopening
// shows the live log/progress state.
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../icons";
import type { Target } from "../../lib/ipc";
import { LogPane, type DeployView } from "./LogPane";
import type { LogLine, ProgressState, RunState, TerminalReport } from "./logic";

export type { DeployView };
export type DeployDialogFrom = "deploy" | "update";

interface DeployDialogProps {
  open: boolean;
  from: DeployDialogFrom;
  view: DeployView;
  target: Target;
  onClose: () => void;

  force: boolean;
  onForceToggle: (force: boolean) => void;

  /* one-step install (plan-then-execute at click time, state owned by DeployPage) */
  planning: boolean;
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

/* The 覆盖已存在文件 switch — the dialog's whole config body, shared by both
   entries (hint tracks the switch state). */
function ForceSwitch({ force, onToggle }: { force: boolean; onToggle: (v: boolean) => void }) {
  return (
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
          onClick={() => onToggle(!force)}
        />
      </div>
    </div>
  );
}

export function DeployDialog(props: DeployDialogProps) {
  const {
    open, from, view, target, onClose,
    force, onForceToggle,
    planning, onStartInstall,
    run, lines, progress, report, stopDisabled, onStop, onCopyLog, onRetry,
  } = props;

  /* 2px live bar across the dialog top (§3.9): a RUNNING indicator only —
     terminal states hide it entirely, the in-log report card carries the
     outcome [变更 2026-10 完成态隐藏顶条]. */
  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const livebarClass = run === "running" ? "livebar is-on" : "livebar";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="dlg-dep"
      icon="deploy"
      title={`${from === "update" ? "更新" : "部署"} · ${target}`}
      before={
        <div className={livebarClass}>
          <i style={{ width: run === "running" ? `${pct}%` : 0 }} />
        </div>
      }
      footer={
        view === "log" ? (
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        ) : (
          /* 取消 + 安装 — no gating (bundled source only); the run guards live
             page-side, so the button stays enabled. */
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={onStartInstall}>
              <Icon name="play" />
              安装
            </button>
          </>
        )
      }
    >
      {view === "log" ? (
        /* ===== shared run view (log pane) ===== */
        <LogPane
          run={run}
          lines={lines}
          progress={progress}
          report={report}
          onStop={onStop}
          stopDisabled={stopDisabled}
          onCopyLog={onCopyLog}
          onRetry={onRetry}
        />
      ) : planning ? (
        /* one-step install is being planned page-side */
        <div className="fhint" role="status">
          <span className="spin" />
          正在准备安装…
        </div>
      ) : (
        <ForceSwitch force={force} onToggle={onForceToggle} />
      )}
    </Dialog>
  );
}
