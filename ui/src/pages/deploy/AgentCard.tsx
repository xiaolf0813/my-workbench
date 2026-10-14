// Agent card (SPEC §3.20): one full-width button per deployed agent file —
// mono name + value chips (模型 / per-backend reasoning level, §3.21), the
// deployed-file path, and the prompt-body preview clamped to 2 lines. Click
// navigates to the full-page detail view (§3.22), which replaces the deploy
// content area — the card is a plain navigation trigger (no expanded/collapsed
// state: the list is not visible while the detail page is open).
import type { DeployedAgent, Target } from "../../lib/ipc";
import { agentFilePath, chipValue, reasoningKeyOf, reasoningLabel } from "./logic";

interface AgentCardProps {
  target: Target;
  agent: DeployedAgent;
  /** The target's scope root from deployed_overview ("" = unresolved). */
  scopeLabel: string;
  onOpen: () => void;
}

export function AgentCard({ target, agent, scopeLabel, onOpen }: AgentCardProps) {
  const lvlLabel = reasoningLabel(target);
  const lvlKey = reasoningKeyOf(target);
  return (
    <button
      type="button"
      className="agc"
      data-ag={agent.name}
      title="点击打开提示词详情，可编辑、保存"
      onClick={onOpen}
    >
      <span className="agc-top">
        <span className="agc-name">{agent.name}</span>
        <span className="agc-chips">
          <span className="achip" title="模型">
            {chipValue(agent.settings.model)}
          </span>
          {lvlLabel !== null && lvlKey !== null && (
            <span className="achip" title={lvlLabel}>
              {chipValue(agent.settings[lvlKey])}
            </span>
          )}
        </span>
      </span>
      <span className="agc-file">{agentFilePath(scopeLabel, agent.fileName)}</span>
      <span className="agc-prev">{agent.body}</span>
    </button>
  );
}
