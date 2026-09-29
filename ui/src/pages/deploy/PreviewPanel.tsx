// Preview panel — the product surface (SPEC §3.8/3.9/3.10/3.11, §4.2–4.5):
// tabbed 预览 / 安装日志 / 健康检查, plan table, streaming log viewer with
// cooperative-cancel terminal states, tier cards + drift list.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../icons";
import type { DriftFile, DriftReport, Plan } from "../../lib/ipc";
import type { IpcFailure } from "../../lib/ipc";
import {
  KIND_BADGE,
  fmtDuration,
  noteFor,
  planCounts,
  relTime,
  splitPath,
  versionLabel,
  type LogLine,
  type PlanFilter,
  type ProgressState,
  type RunState,
  type TabId,
  type TerminalReport,
} from "./logic";

interface PreviewPanelProps {
  tab: TabId;
  onTab: (t: TabId) => void;
  forceOn: boolean;
  scopeLabel: string;

  plan: Plan | null;
  planStamp: string | null;
  stale: boolean;
  planning: boolean;
  planError: IpcFailure | null;
  filter: PlanFilter;
  onFilter: (f: PlanFilter) => void;
  onRegenerate: () => void;

  run: RunState;
  lines: LogLine[];
  progress: ProgressState | null;
  report: TerminalReport | null;
  onStop: () => void;
  stopDisabled: boolean;
  onCopyLog: () => void;
  onRetry: () => void;
  onRunHealthCheck: () => void;

  healthSrc: string;
  healthDir: string;
  healthChecking: boolean;
  healthReport: DriftReport | null;
  healthError: IpcFailure | null;
  healthCheckedAt: Date | null;
  nodeVersion: string | null;
  onRecheck: () => void;
  onOpenDrift: (f: DriftFile) => void;
}

const FILTERS: { id: PlanFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "create", label: "新建" },
  { id: "skip", label: "跳过" },
  { id: "overwrite", label: "覆盖" },
  { id: "managed-block", label: "受管块" },
];

export function PreviewPanel(props: PreviewPanelProps) {
  const {
    tab, onTab, forceOn, scopeLabel,
    plan, planStamp, stale, planning, planError, filter, onFilter, onRegenerate,
    run, lines, progress, report, onStop, stopDisabled, onCopyLog, onRetry, onRunHealthCheck,
    healthSrc, healthDir, healthChecking, healthReport, healthError, healthCheckedAt, nodeVersion,
    onRecheck, onOpenDrift,
  } = props;

  const counts = useMemo(() => (plan ? planCounts(plan) : null), [plan]);
  const rows = useMemo(() => {
    if (!plan) return [];
    return plan.items
      .filter((it) => filter === "all" || it.kind === filter)
      .map((it) => ({ item: it, ...splitPath(it.path), note: noteFor(it.kind) }));
  }, [plan, filter]);

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

  const livebarClass = run === "idle" ? "livebar" : `livebar is-on${run === "success" || run === "failed" ? " done" : ""}`;

  return (
    <div className="panel">
      <div className={livebarClass}>
        <i style={{ width: run === "idle" ? 0 : `${pct}%` }} />
      </div>
      <div className="panel-h">
        <div className="seg" role="tablist" aria-label="预览面板">
          <button
            type="button"
            className={`seg-b${tab === "preview" ? " is-on" : ""}`}
            role="tab"
            aria-selected={tab === "preview"}
            onClick={() => onTab("preview")}
          >
            预览
          </button>
          <button
            type="button"
            className={`seg-b${tab === "log" ? " is-on" : ""}`}
            role="tab"
            aria-selected={tab === "log"}
            onClick={() => onTab("log")}
          >
            安装日志{run === "running" && <span className="pulse" />}
          </button>
          <button
            type="button"
            className={`seg-b${tab === "health" ? " is-on" : ""}`}
            role="tab"
            aria-selected={tab === "health"}
            onClick={() => onTab("health")}
          >
            健康检查
          </button>
        </div>
        <div className="panel-hr">
          {forceOn && <span className="bd bd-over">覆盖已开启</span>}
          <span className="mut" style={{ fontSize: 11.5 }}>
            {scopeLabel} · 0 写入
          </span>
        </div>
      </div>

      <div className="panel-b">
        {/* ===== preview pane ===== */}
        <div className={`pane${tab === "preview" ? " is-on" : ""}`} role="tabpanel" aria-label="预览">
          {planError && (
            <div className="bn err" style={{ margin: "10px 12px 0" }}>
              <Icon name="xc" />
              <div className="bn-c">
                <div className="bn-t">{planError.title} — 生成预览</div>
                <div className="bn-s">{planError.message}</div>
              </div>
            </div>
          )}
          {!plan && (
            <div className="empty">
              <div className="empty-ic">
                <Icon name="layers" />
              </div>
              <div className="empty-t">先选择目标生成预览</div>
              <div className="empty-s">在左侧勾选安装目标，然后点击「生成预览」。预览不会写入任何文件。</div>
              <button type="button" className="btn btn-acc-o" onClick={onRegenerate} disabled={planning}>
                <Icon name="layers" />
                生成预览
              </button>
            </div>
          )}
          {plan && counts && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <div className="stalebar" hidden={!stale}>
                <Icon name="warn" />
                选择已更改 — 预览可能过期，请重新生成
                <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onRegenerate}>
                  重新生成
                </button>
              </div>
              <div className="chips">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`chip${filter === f.id ? " is-on" : ""}`}
                    onClick={() => onFilter(f.id)}
                  >
                    {f.label} <b>{f.id === "all" ? counts.total : counts[f.id]}</b>
                  </button>
                ))}
                <span className="chips-right">
                  <Icon name="shield" style={{ width: 12, height: 12 }} />
                  预览不会写入任何文件
                </span>
              </div>
              <div className="tblw">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 88 }}>状态</th>
                      <th>目标文件</th>
                      <th style={{ width: 230 }}>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.item.target}-${r.item.path}-${i}`}>
                        <td>
                          <span className={`bd ${KIND_BADGE[r.item.kind].cls}`}>{KIND_BADGE[r.item.kind].label}</span>
                        </td>
                        <td>
                          <span className="p">
                            <span className="dir">{r.dir}</span>
                            <span className="nm">{r.name}</span>
                          </span>
                        </td>
                        <td className="note">{r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pfoot">
                <div className="psum">
                  <b>{counts.create}</b> 新建 · <b>{counts.skip}</b> 跳过 · <b>{counts.overwrite}</b> 覆盖 ·{" "}
                  <b>{counts["managed-block"]}</b> 受管块 · 共 {counts.total} 个文件
                </div>
                <div className="pright">
                  <span>{planStamp ? `生成于 ${planStamp}` : ""}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    title="重新生成预览"
                    onClick={onRegenerate}
                  >
                    <Icon name="ref" style={{ width: 13, height: 13 }} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ===== log pane ===== */}
        <div className={`pane${tab === "log" ? " is-on" : ""}`} role="tabpanel" aria-label="安装日志">
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
              {report && <ReportCard report={report} onRetry={onRetry} onRunHealthCheck={onRunHealthCheck} />}
            </div>
            <button type="button" className={`resume${showResume ? " is-on" : ""}`} onClick={() => changeAutoScroll(true)}>
              <Icon name="chevd" style={{ width: 12, height: 12 }} />
              回到底部
            </button>
          </div>
        </div>

        {/* ===== health pane ===== */}
        <div className={`pane${tab === "health" ? " is-on" : ""}`} role="tabpanel" aria-label="健康检查">
          <div className="hscroll">
            <div className="hctx">
              <Icon name="act" style={{ width: 14, height: 14, color: "var(--text-3)" }} />
              检查对象：
              <span className="mono">{healthSrc}</span> → <span className="mono">{healthDir}</span>
              {healthCheckedAt && <span className="mut">· 上次检查 {relTime(healthCheckedAt, new Date())}</span>}
              <button type="button" className="btn btn-sm" onClick={onRecheck} disabled={healthChecking}>
                {healthChecking ? <span className="spin" /> : <Icon name="ref" />}
                重新检查
              </button>
            </div>

            {healthError && (
              <div className="bn err">
                <Icon name="xc" />
                <div className="bn-c">
                  <div className="bn-t">{healthError.title} — 健康检查</div>
                  <div className="bn-s">{healthError.message}</div>
                </div>
              </div>
            )}
            {healthChecking && (
              <div className="bn info">
                <span className="spin" />
                <div className="bn-c">
                  <div className="bn-t">正在检查…</div>
                  <div className="bn-s">渲染 agents/ 树并与本地文件逐字节对比。</div>
                </div>
              </div>
            )}
            {!healthReport && !healthChecking && !healthError && (
              <div className="bn mut">
                <Icon name="info" />
                <div className="bn-c">
                  <div className="bn-t">尚未运行健康检查</div>
                  <div className="bn-s">点击「重新检查」对比本地文件与渲染期望。</div>
                </div>
              </div>
            )}
            {healthReport && <HealthReport report={healthReport} nodeVersion={nodeVersion} onOpenDrift={onOpenDrift} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal report card (SPEC §3.9)                                    */
/* ------------------------------------------------------------------ */

function ReportCard({
  report,
  onRetry,
  onRunHealthCheck,
}: {
  report: TerminalReport;
  onRetry: () => void;
  onRunHealthCheck: () => void;
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
        <div className="report-a">
          <button type="button" className="btn btn-sm" onClick={onRunHealthCheck}>
            <Icon name="act" />
            运行健康检查
          </button>
        </div>
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

/* ------------------------------------------------------------------ */
/* Tier cards + drift list (SPEC §3.10 / §3.11, locked Tier-2 skip)    */
/* ------------------------------------------------------------------ */

function HealthReport({
  report,
  nodeVersion,
  onOpenDrift,
}: {
  report: DriftReport;
  nodeVersion: string | null;
  onOpenDrift: (f: DriftFile) => void;
}) {
  const t1 = report.tier1;
  const driftCount = t1.drifted.length;
  const t1Badge =
    t1.problems.length > 0 ? (
      <span className="tier-badge err">
        <Icon name="xc" style={{ width: 11, height: 11 }} />
        失败
      </span>
    ) : driftCount > 0 ? (
      <span className="tier-badge warn">
        <Icon name="warn" style={{ width: 11, height: 11 }} />
        {driftCount} 处漂移
      </span>
    ) : (
      <span className="tier-badge ok">
        <Icon name="check" style={{ width: 11, height: 11 }} />
        通过
      </span>
    );

  const t2Status = report.tier2?.status ?? "skipped";

  return (
    <>
      <div className="tiers">
        <div className="tier">
          <div className="tier-h">
            <div>
              <div className="tier-t">结构检查（始终可用）</div>
            </div>
            {t1Badge}
          </div>
          <div className="tier-b">
            <div className="tier-row">
              <Icon name={driftCount > 0 ? "warn" : "checkc"} className={driftCount > 0 ? "errc" : "okc"} style={{ width: 14, height: 14 }} />
              <span>
                渲染字节对比{" "}
                <b className="num">
                  {Math.max(0, t1.compared - driftCount)} / {t1.compared}
                </b>
                &nbsp;一致
                {driftCount > 0 && (
                  <>
                    {" "}
                    · <b style={{ color: "var(--warn)" }}>{driftCount} 个文件漂移</b>
                  </>
                )}
              </span>
            </div>
            {t1.problems.length === 0 ? (
              <div className="tier-row">
                <Icon name="checkc" className="okc" style={{ width: 14, height: 14 }} />
                <span>结构检查全部通过 · 槽位与源结构完整</span>
              </div>
            ) : (
              t1.problems.map((p, i) => (
                <div key={i} className="tier-row">
                  <Icon name="xc" className="errc" style={{ width: 14, height: 14 }} />
                  <span>
                    <span className="mono">{p.check}</span> — {p.detail}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="tier-f">渲染 agents/ 树并与目标文件逐字节对比，附全部结构性检查。</div>
        </div>

        <div className="tier">
          <div className="tier-h">
            <div>
              <div className="tier-t">执行状态检查（需要本地 Node）</div>
            </div>
            {t2Status === "pass" && (
              <span className="tier-badge ok">
                <Icon name="check" style={{ width: 11, height: 11 }} />
                通过
              </span>
            )}
            {t2Status === "skipped" && (
              <span className="tier-badge warn">
                <Icon name="info" style={{ width: 11, height: 11 }} />
                已跳过
              </span>
            )}
            {t2Status === "fail" && (
              <span className="tier-badge err">
                <Icon name="x" style={{ width: 11, height: 11 }} />
                失败
              </span>
            )}
          </div>
          <div className="tier-b">
            {t2Status === "pass" && (
              <div className="tier-row">
                <Icon name="checkc" className="okc" style={{ width: 14, height: 14 }} />
                <span>执行检查通过 · 3 项</span>
              </div>
            )}
            {t2Status === "skipped" && (
              <>
                <div className="tier-note">
                  <b>
                    <Icon name="info" />
                    执行状态检查已跳过：未检测到 Node
                  </b>
                  <span className="mut2">安装本地 Node 后点击「重新检查」。</span>
                </div>
                <div className="tier-row" style={{ color: "var(--text-3)" }}>
                  <Icon name="x" style={{ width: 14, height: 14 }} />
                  <span>3 项执行检查未执行</span>
                </div>
              </>
            )}
            {t2Status === "fail" &&
              (report.tier2?.problems ?? []).map((p, i) => (
                <div key={i} className="tier-row">
                  <Icon name="xc" className="errc" style={{ width: 14, height: 14 }} />
                  <span>{p}</span>
                </div>
              ))}
          </div>
          <div className="tier-f">
            {t2Status === "pass"
              ? `本地 Node ${nodeVersion ? versionLabel(nodeVersion) : "已检测"} · 全部执行检查通过。`
              : t2Status === "skipped"
                ? "缺失 Node 不会阻塞安装。"
                : "存在失败的执行检查 — 若为本地源 + DSH 目标，安装将被阻止。"}
          </div>
        </div>
      </div>

      {driftCount === 0 ? (
        <div className="sect-t" style={{ color: "var(--text-3)" }}>
          <Icon name="checkc" style={{ width: 14, height: 14 }} />
          漂移报告
          <span style={{ fontWeight: 500, fontSize: 12, color: "var(--text-3)" }}>无漂移 — 全部文件与渲染期望一致</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="sect-t">
            <Icon name="warn" style={{ width: 14, height: 14, color: "var(--warn)" }} />
            漂移报告
            <span className="cnt">{driftCount} 个文件与渲染期望不一致</span>
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-3)", fontWeight: 400 }}>
              在「查看详情」中选择处理方式
            </span>
          </div>
          <div className="drift">
            {t1.drifted.map((f, i) => {
              const sp = splitPath(f.path);
              return (
                <div key={`${f.path}-${i}`} className="drift-row">
                  <Icon name="file" className="w" style={{ width: 15, height: 15 }} />
                  <div>
                    <div className="drift-p">
                      <span className="dir">{sp.dir}</span>
                      {sp.name}
                    </div>
                    <div className="drift-n">
                      本地与渲染期望不一致 · <span className="mono">{f.target}</span>
                    </div>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => onOpenDrift(f)}>
                    查看详情
                    <Icon name="chevr" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
