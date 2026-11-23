import type { AgentModelConfiguration } from "../types";

type AgentListProps = {
  agents: AgentModelConfiguration[];
  selectedId: string | null;
  loading: boolean;
  projectRoot: string | null;
  onRefresh: () => void;
  onSelect: (agent: AgentModelConfiguration) => void;
};

function shortModel(agent: AgentModelConfiguration): string {
  return agent.model || "inherit";
}

function status(agent: AgentModelConfiguration): string {
  if (!agent.editable) return agent.parseError ? "Error" : "Read-only";
  return "";
}

function scopeLabel(agent: AgentModelConfiguration): string {
  return agent.scope === "personal" ? "Personal" : "Current Project";
}

export function AgentList({ agents, selectedId, loading, projectRoot, onRefresh, onSelect }: AgentListProps) {
  const groups: { title: string; scope: AgentModelConfiguration["scope"] }[] = [
    { title: "Personal", scope: "personal" },
    ...(projectRoot ? [{ title: "Current Project", scope: "project" as const }] : []),
  ];

  return (
    <aside className="agent-list" aria-label="Codex subagents">
      <div className="panel-heading">
        <span>Agents</span>
        <button
          className="icon-button"
          onClick={onRefresh}
          disabled={loading}
          type="button"
          aria-label={loading ? "Refreshing agents" : "Refresh agents"}
          title={loading ? "Refreshing agents" : "Refresh agents"}
        >
          <svg className={loading ? "is-spinning" : undefined} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
      </div>
      {groups.map((group) => {
        const scoped = agents.filter((agent) => agent.scope === group.scope);
        return (
          <section key={group.scope}>
            <div className="scope-heading">
              <h2>{group.title}</h2>
              {group.scope === "project" && projectRoot ? (
                <span className="project-root-value" title={projectRoot} aria-label={`Project root: ${projectRoot}`}>
                  {projectRoot}
                </span>
              ) : null}
            </div>
            {scoped.length === 0 ? <p className="empty">No agents</p> : null}
            <ul>
              {scoped.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className={agent.id === selectedId ? "selected" : ""}
                    aria-current={agent.id === selectedId ? "true" : undefined}
                    onClick={() => onSelect(agent)}
                  >
                    <span className="agent-name">{agent.name || "(invalid name)"}</span>
                    <small>
                      {shortModel(agent)}
                      {agent.scope === "project" ? " - current project" : ""}
                      {status(agent) ? ` - ${status(agent)}` : ""}
                      {agent.editable ? ` - ${scopeLabel(agent)}` : ""}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
