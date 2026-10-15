// Deploy-dialog log pane (SPEC §3.9/§4.6): the streaming install log viewer
// with cooperative cancel and terminal report cards — the shared run view both
// dialog entries (部署 / 更新) land in. The former preview/plan pane (plan
// table, stale strip, 生成预览 flow) was retired 2026-10 when both entries went
// tab-free with one-step installs — re-addable from SPEC §4.6 history.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../icons";
import { fmtDuration, type LogLine, type ProgressState, type RunState, type TerminalReport } from "./logic";

/** Deploy-dialog views: `config` = entry body (部署 config controls / 更新
 *  quick switch), `log` = this run view. */
export type DeployView = "config" | "log";

interface LogPaneProps {
  run: RunState;
  lines: LogLine[];
  progress: ProgressState | null;
  report: TerminalReport | null;
  onStop: () => void;
  stopDisabled: boolean;
  onCopyLog: () => void;
  onRetry: () => void;
}

export function LogPane(props: LogPaneProps) {
  const { run, lines, progress, report, onStop, stopDisabled, onCopyLog, onRetry } = props;

  /* ---------------- log autoscroll (SPEC §3.9) ---------------- */
  const logRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(autoScroll);
  const [showResume, setShowResume] = useState(false);

  const scrollToBottom = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const changeAutoScroll = (v: boolean) => {
    autoScrollRef.current = v;
    setAutoScroll(v);
    if (v) {
      scrollToBottom();
      setShowResume(false);
    }
  };

  // Fresh run → stick back to the bottom.
  useEffect(() => {
    if (run === "running") changeAutoScroll(true);
  }, [run]);

  useEffect(() => {
    if (autoScrollRef.current) scrollToBottom();
  }, [lines]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setShowResume(!nearBottom && el.children.length > 2);
    if (!nearBottom && autoScrollRef.current) changeAutoScroll(false);
  };

  /* ---------------- progress derivation ---------------- */
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : run === "success"
        ? 100
        : 0;
  const lpfillClass =
    run === "running" ? "lpfill is-run"
    : run === "success" ? "lpfill done"
    : run === "failed" ? "lpfill failed"
    : "lpfill";
  const phaseText =
    run === "running"
      ? progress
        ? `${progress.phase} · ${progress.done}/${progress.total} · ${pct}%`
        : "准备中…"
      : run === "success"
        ? `已完成 · ${progress?.done ?? "—"}/${progress?.total ?? "—"} · 100%`
        : run === "failed"
          ? "已中止"
          : run === "cancelled"
            ? "已取消"
            : "准备中…";

  return (
    <div className="logwrap">
      <div className="logbar">
        {run === "idle" && <span className="lchip idle">未开始</span>}
        {run === "running" && (
          <span className="lchip run">
            <span
              className="pulse"
              style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "currentColor" }}
            />
            运行中
          </span>
        )}
        {run === "success" && <span className="lchip ok">已完成</span>}
        {run === "failed" && <span className="lchip err">已失败</span>}
        {run === "cancelled" && <span className="lchip warn">已取消</span>}
        <button
          type="button"
          className="btn btn-sm"
          hidden={run !== "running"}
          disabled={stopDisabled}
          title="协作取消：将在当前文件写完后停止（已写入的文件保留）"
          onClick={onStop}
        >
          <Icon name="x" />
          停止
        </button>
        <span className="logbar-actions">
          <span className="mini-sw">
            <button
              type="button"
              className="sw"
              role="switch"
              aria-checked={autoScroll}
              aria-label="自动滚动"
              onClick={() => changeAutoScroll(!autoScroll)}
            />
            自动滚动
          </span>
          <button type="button" className="icon-btn" title="复制日志" onClick={onCopyLog}>
            <Icon name="copy" style={{ width: 14, height: 14 }} />
          </button>
          <button type="button" className="icon-btn" title="导出日志 — 计划于 M3 提供" disabled>
            <Icon name="dl" style={{ width: 14, height: 14 }} />
          </button>
        </span>
      </div>
      <div className="lprog" hidden={run === "idle"}>
        <div className="lpbar">
          <span className={lpfillClass} style={{ width: `${pct}%` }} />
        </div>
        <span className="lphase">{phaseText}</span>
      </div>
      <div className="log" ref={logRef} role="log" aria-live="polite" onScroll={onLogScroll}>
        {lines.length === 0 ? (
          <div className="log-empty">
            <Icon name="term" style={{ width: 20, height: 20 }} />
            尚未开始安装 — 点击「开始安装」后此处将流式输出日志
          </div>
        ) : (
          lines.map((l) => (
            <div key={l.id} className={`ln${l.cls ? ` ${l.cls}` : ""}`}>
              <span className="ts">{l.ts}</span>
              <span className="tg">{l.tg}</span>
              <span className="lm">{l.text}</span>
            </div>
          ))
        )}
        {report && <ReportCard report={report} onRetry={onRetry} />}
      </div>
      <button type="button" className={`resume${showResume ? " is-on" : ""}`} onClick={() => changeAutoScroll(true)}>
        <Icon name="chevd" style={{ width: 12, height: 12 }} />
        回到底部
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal report card (SPEC §3.9)                                    */
/* ------------------------------------------------------------------ */

function ReportCard({
  report,
  onRetry,
}: {
  report: TerminalReport;
  onRetry: () => void;
}) {
  if (report.kind === "ok" && report.counts) {
    const c = report.counts;
    return (
      <div className="report ok">
        <div className="report-t">
          <Icon name="checkc" />
          安装完成
        </div>
        <div className="report-chips">
          <span className="rc">{c.created} 新建</span>
          <span className="rc">{c.skipped} 跳过</span>
          <span className="rc">{c.overwritten} 覆盖</span>
          <span className="rc">{c.managedBlocks} 受管块</span>
          <span className="rc">用时 {fmtDuration(report.durationMs)}</span>
        </div>
        {c.stamps.length > 0 && (
          <div className="report-chips">
            {c.stamps.map((s, i) => (
              <span key={i} className="rc">
                {s}
              </span>
            ))}
          </div>
        )}
        {c.warnings.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {c.warnings.map((w, i) => (
              <div key={i} className="mono" style={{ fontSize: 11, color: "var(--warn)" }}>
                — {w}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (report.kind === "cancel") {
    return (
      <div className="report warn">
        <div className="report-t">
          <Icon name="info" />
          安装已取消
        </div>
        <div className="report-chips">
          <span className="rc">第 {report.filesWritten} 个文件后停止</span>
          <span className="rc">已写入的文件保留</span>
        </div>
        <div className="report-a">
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            <Icon name="ref" />
            重试安装
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="report err">
      <div className="report-t">
        <Icon name="xc" />
        安装失败
      </div>
      <div className="errmsg">{report.errmsg ?? "未知错误"}</div>
      <div className="report-a">
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <Icon name="ref" />
          重试安装
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled title="计划于 M3 提供">
          导出日志
        </button>
      </div>
    </div>
  );
}
