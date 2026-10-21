// Agent detail page (SPEC §3.22, 2026-10 view restructure): full-page view that
// replaces the deploy content area — the deploy page's header row, tab bar,
// scope bar and card list all give way. Page-level title row (返回 ghost back
// button, focus lands here on open, + mono agent name — nothing else) sits
// OUTSIDE and above; the chromeless column holds the 模型 / per-backend
// reasoning selects and the read-only prompt body. The prompt body is NOT
// editable in-app — my-workbench deploys prompts from its bundled source, it
// does not manage them; the body renders as read-only Markdown (react-markdown
// + remark-gfm). Model settings are the
// only editables and SAVE IMMEDIATELY on select change — there is no 保存
// button and no footer: a failed write toasts and the selects revert to the
// deployed values. 返回 is the only exit affordance on the page.
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToast } from "../../components/Toast";
import { Icon } from "../../icons";
import { describeIpcError, type DeployedAgent, type Target } from "../../lib/ipc";
import { MODEL_OPTIONS, REASONING_LEVELS, reasoningKeyOf, reasoningLabel } from "./logic";

interface AgentDetailPageProps {
  target: Target;
  agent: DeployedAgent;
  /** Writes the deployed file; resolves with the authoritative saved agent. */
  onSave: (body: string, settings: Record<string, string | null>) => Promise<DeployedAgent>;
  /** Back to the roster view. */
  onBack: () => void;
}

/** Select options: the known candidates + the current value; "" = 未设置 (clears the key). */
function optionsWithCurrent(candidates: readonly string[], current: string): string[] {
  const set = new Set<string>([""]);
  for (const c of candidates) set.add(c);
  if (current !== "") set.add(current);
  return [...set];
}

export function AgentDetailPage({ target, agent, onSave, onBack }: AgentDetailPageProps) {
  const toast = useToast();
  const lvlLabel = reasoningLabel(target);
  const lvlKey = reasoningKeyOf(target);

  const baseModel = (agent.settings.model ?? "").trim();
  const baseLevel = lvlKey !== null ? (agent.settings[lvlKey] ?? "").trim() : "";

  const [model, setModel] = useState(baseModel);
  const [level, setLevel] = useState(baseLevel);
  const [saving, setSaving] = useState(false);

  const modelOpts = useMemo(() => optionsWithCurrent(target === "codex" ? ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"] : MODEL_OPTIONS, model), [target, model]);
  const levelOpts = useMemo(() => optionsWithCurrent(REASONING_LEVELS, level), [level]);

  // Immediate save on select change. The full managed key set is always sent:
  // a value writes/updates the key, null clears it (deployed.rs splice
  // semantics). A failed write toasts and the selects revert to the deployed
  // values, so the UI never shows a value that is not persisted.
  const save = async (nextModel: string, nextLevel: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const settings: Record<string, string | null> = {
        model: nextModel.trim() === "" ? null : nextModel.trim(),
      };
      if (lvlKey !== null) settings[lvlKey] = nextLevel.trim() === "" ? null : nextLevel.trim();
      await onSave(agent.body, settings);
      toast({ kind: "ok", title: `已保存 ${agent.name} 的设置`, sub: "已写入已部署文件" });
    } catch (e) {
      const failure = describeIpcError(e);
      setModel(baseModel);
      setLevel(baseLevel);
      toast({ kind: "err", title: "保存失败", sub: failure.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="region" aria-label={`提示词详情 · ${agent.name}`}>
      {/* Page-level title row — sits on the page background; the column below
          holds the selects and the read-only prompt text block. */}
      <div className="adp-title">
        <button type="button" className="btn btn-ghost adp-back" onClick={onBack} autoFocus>
          <Icon name="arl" />
          返回
        </button>
        <span className="adp-name">{agent.name}</span>
      </div>
      <div className="adp">
        {/* .adp is a chromeless editor column — no outer frame; the text block keeps its own */}
        <div className="edt-meta">
          <div className="edt-fld">
            <label className="flab" htmlFor="edtModel">
              模型
            </label>
            <select
              className="fsel"
              id="edtModel"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                void save(e.target.value, level);
              }}
              disabled={saving}
            >
              {modelOpts.map((o) => (
                <option key={o} value={o}>
                  {o === "" ? "未设置" : o}
                </option>
              ))}
            </select>
          </div>
          {lvlLabel !== null && lvlKey !== null && (
            <div className="edt-fld">
              <label className="flab" htmlFor="edtLvl">
                {lvlLabel}
              </label>
              <select
                className="fsel"
                id="edtLvl"
                value={level}
                onChange={(e) => {
                  setLevel(e.target.value);
                  void save(model, e.target.value);
                }}
                disabled={saving}
              >
                {levelOpts.map((o) => (
                  <option key={o} value={o}>
                    {o === "" ? "未设置" : o}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="edt-b">
          <div className="edt-ta md-body" aria-label="提示词内容（随部署更新）">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{agent.body}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
