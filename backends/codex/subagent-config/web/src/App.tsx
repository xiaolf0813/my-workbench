import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { callTool, initializeMcpApps } from "./bridge/mcp-apps-client";
import type { ModelCatalog } from "./types";

type Candidate = { model: string; reasoningEffort?: string };
type Profile = "fast" | "standard" | "deep" | "perceptive";
type Assignment = Profile | "auto";
type Configuration = { schemaVersion: 1; profiles: Record<Profile, Candidate[]>; agents: Record<string, Assignment> };
type ConfigurationResponse = { configured: boolean; fileRevision: string | null; configuration: Configuration; path: string };
type Agent = { id: string; name: string; description: string; developerInstructions: string | null };
const profiles: Profile[] = ["fast", "standard", "deep", "perceptive"];
const descriptions: Record<Profile, string> = { fast: "Focused, repeatable work", standard: "Everyday implementation and acceptance", deep: "Complex reasoning and investigation", perceptive: "Work that benefits from environmental understanding" };

export function App() {
  const [saved, setSaved] = useState<ConfigurationResponse | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [page, setPage] = useState<"models" | "agents">("models");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => saved !== null && draft !== null && JSON.stringify(saved.configuration) !== JSON.stringify(draft), [saved, draft]);

  async function load() {
    setBusy(true); setError("");
    try {
      const result = await callTool<ConfigurationResponse>("get_model_configuration");
      setSaved(result); setDraft(structuredClone(result.configuration));
      setCatalog(await callTool<ModelCatalog>("list_models"));
      const roster = await callTool<{ agents: Agent[] }>("get_agent_configurations");
      setAgents(roster.agents.filter((agent) => result.configuration.agents[agent.name] !== undefined));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load configuration."); }
    finally { setBusy(false); }
  }

  useEffect(() => { void initializeMcpApps().then(load).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to connect.")); }, []);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler); }, [dirty]);

  function update(fn: (current: Configuration) => void) { setDraft((current) => { if (!current) return current; const next = structuredClone(current); fn(next); return next; }); }
  function changeCandidate(profile: Profile, index: number, key: keyof Candidate, value: string) { update((next) => { if (key === "reasoningEffort" && !value) delete next.profiles[profile][index].reasoningEffort; else next.profiles[profile][index][key] = value; }); }
  async function save() {
    if (!saved || !draft) return;
    setBusy(true); setError("");
    try { await callTool("save_model_configuration", { configuration: draft, fileRevision: saved.fileRevision }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save configuration."); setBusy(false); }
  }

  const agent = agents.find((item) => item.name === selectedAgent);
  return <div className="app">
    <header className="app-header"><h1>Subagent Config</h1><div className="profile-actions"><button type="button" onClick={() => void load()} disabled={busy || dirty}>Refresh</button><button type="button" onClick={() => void save()} disabled={busy || !dirty}>Save changes</button></div></header>
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Configuration sections">
        <button type="button" className={page === "models" ? "active" : ""} onClick={() => { setPage("models"); setSelectedAgent(null); }}>Models</button>
        <button type="button" className={page === "agents" ? "active" : ""} onClick={() => { setPage("agents"); setSelectedAgent(null); }}>Agents</button>
      </nav>
      <main className="settings-content">
        {saved && !saved.configured ? <p className="profile-notice">Add at least one model to every profile, then save.</p> : null}
        {error ? <p className="profile-error" role="alert">{error}</p> : null}
        {draft ? <>
          {page === "models" ? <>
            <div className="page-heading"><h2>Models</h2><p>Set an ordered list of candidates for each model profile.</p></div>
            <datalist id="model-options">{catalog?.models.map((model) => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}</datalist>
            <section className="profile-grid">{profiles.map((profile) => <article className="profile-card" key={profile}>
              <div className="card-heading"><h3>{profile}</h3><p>{descriptions[profile]}</p></div>
              {draft.profiles[profile].map((candidate, index) => <div className="candidate-row" key={`${profile}-${index}`}>
                <span className="candidate-rank">{index + 1}</span><label>Model<input list="model-options" value={candidate.model} onChange={(event) => changeCandidate(profile, index, "model", event.target.value)} placeholder="Model ID" /></label>
                <label>Reasoning<select value={candidate.reasoningEffort ?? ""} onChange={(event) => changeCandidate(profile, index, "reasoningEffort", event.target.value)}><option value="">Model default</option>{(catalog?.supportedReasoningEfforts ?? ["low", "medium", "high", "xhigh", "max", "ultra"]).map((effort) => <option key={effort}>{effort}</option>)}</select></label>
                <div className="candidate-actions"><button type="button" onClick={() => update((next) => { const a=next.profiles[profile]; if(index>0)[a[index-1],a[index]]=[a[index],a[index-1]]; })} disabled={index===0} aria-label="Move model up">↑</button><button type="button" onClick={() => update((next) => { const a=next.profiles[profile]; if(index<a.length-1)[a[index+1],a[index]]=[a[index],a[index+1]]; })} disabled={index===draft.profiles[profile].length-1} aria-label="Move model down">↓</button><button type="button" onClick={() => update((next) => { next.profiles[profile].splice(index,1); })} aria-label="Remove model">×</button></div>
              </div>)}
              <button type="button" className="add-candidate" onClick={() => update((next) => { next.profiles[profile].push({model:""}); })}>Add model</button>
            </article>)}</section>
          </> : <>
            {agent ? <section className="agent-detail">
              <button className="back-link" type="button" onClick={() => setSelectedAgent(null)}>← Agents</button>
              <div className="page-heading"><h2>{agent.name}</h2><p>{agent.description}</p></div>
              <label className="agent-profile-field">Model profile<select value={draft.agents[agent.name]} onChange={(event) => update((next) => { next.agents[agent.name] = event.target.value as Assignment; })}>{agent.name === "developer" ? <option value="auto">auto</option> : null}{profiles.map((name) => <option key={name}>{name}</option>)}</select></label>
              <section className="prompt-preview"><h3>Instructions</h3><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{agent.developerInstructions ?? "Prompt is unavailable."}</ReactMarkdown></div></section>
            </section> : <>
              <div className="page-heading"><h2>Agents</h2><p>Choose a model profile for each subagent. Open an agent to preview its instructions.</p></div>
              <ul className="agent-rows">{Object.entries(draft.agents).map(([name, profile]) => <li key={name}><button type="button" className="agent-row" onClick={() => setSelectedAgent(name)}><span className="agent-row-copy"><strong>{name}</strong><small>{agents.find((item) => item.name === name)?.description}</small></span><select aria-label={`${name} model profile`} value={profile} onClick={(event) => event.stopPropagation()} onChange={(event) => update((next) => { next.agents[name] = event.target.value as Assignment; })}>{name === "developer" ? <option value="auto">auto</option> : null}{profiles.map((item) => <option key={item}>{item}</option>)}</select><span className="row-arrow" aria-hidden="true">›</span></button></li>)}</ul>
            </>}
          </>}
        </> : <p>Loading configuration…</p>}
      </main>
    </div>
  </div>;
}
