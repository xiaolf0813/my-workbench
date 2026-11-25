import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
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
type SshAuth = "agent" | "key-file" | "password";
type SshServer = { id: string; name: string; target: string; port?: number; codexHome: string; authentication: SshAuth; keyFilePath?: string; passwordSaved: boolean; passwordStoreAvailable: boolean };
type SshServerDraft = Omit<SshServer, "id" | "passwordSaved" | "passwordStoreAvailable"> & { id?: string };
type SshCheck = { target: string; port: number | null; remoteHome: string; codexHome: string; nodeVersion: string; codexVersion: string; pluginVersion: string; profileConfigured: boolean };
type SshSyncResults = { batchId: string; status: "running" | "completed" | "unknown"; startedAt: number; completedAt?: number; results: Array<{ id: string; name: string; state: "queued" | "syncing" | "synced" | "failed"; pluginVersion?: string; codexHome?: string; error?: string }>; syncedCount: number };
const profiles: Profile[] = ["fast", "standard", "deep", "perceptive"];
const descriptions: Record<Profile, string> = { fast: "Focused, repeatable work", standard: "Everyday implementation and acceptance", deep: "Complex reasoning and investigation", perceptive: "Work that benefits from environmental understanding" };
type ActionIconName = "refresh" | "plus" | "remove" | "grip" | "key" | "check" | "edit" | "trash" | "back";
type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & { icon: ActionIconName; label: string; ref?: Ref<HTMLButtonElement> };

function ActionIcon({ name, spinning = false }: { name: ActionIconName; spinning?: boolean }) {
  const paths: Record<ActionIconName, ReactNode> = {
    refresh: <><path d="M20 7v5h-5" /><path d="M4.9 9a7.5 7.5 0 0 1 12.4-2L20 12M4 17v-5h5" /><path d="M19.1 15a7.5 7.5 0 0 1-12.4 2L4 12" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    remove: <><path d="m6 6 12 12M18 6 6 18" /></>,
    grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
    key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 3 3m-6 0 3 3" /></>,
    check: <><path d="M12 3v3m0 12v3M3 12h3m12 0h3" /><circle cx="12" cy="12" r="6" /><path d="m9.5 12 1.7 1.7 3.5-3.5" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" /></>,
    trash: <><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
    back: <><path d="m15 18-6-6 6-6M9 12h11" /></>,
  };
  return <svg className={spinning ? "is-spinning" : undefined} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function IconButton({ icon, label, className = "", ...props }: IconButtonProps) {
  return <button {...props} className={`icon-button ${className}`.trim()} aria-label={label} title={label}><ActionIcon name={icon} spinning={props["aria-busy"] === true} /></button>;
}

let candidateIdSequence = 0;
function newCandidateId() { candidateIdSequence += 1; return `candidate-${candidateIdSequence}`; }

export function App() {
  const [saved, setSaved] = useState<ConfigurationResponse | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [candidateIds, setCandidateIds] = useState<Record<Profile, string[]>>({ fast: [], standard: [], deep: [], perceptive: [] });
  const [dragCandidateId, setDragCandidateId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ profile: Profile; candidateId: string; side: "before" | "after" } | null>(null);
  const [movePicker, setMovePicker] = useState<{ profile: Profile; candidateId: string } | null>(null);
  const [candidateAnnouncement, setCandidateAnnouncement] = useState("");
  const [focusCandidateId, setFocusCandidateId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [page, setPage] = useState<"models" | "agents" | "sync">("models");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sshServers, setSshServers] = useState<SshServer[]>([]);
  const [sshDraft, setSshDraft] = useState<SshServerDraft | null>(null);
  const [sshLoading, setSshLoading] = useState(false);
  const [sshSaving, setSshSaving] = useState(false);
  const [sshDeleting, setSshDeleting] = useState<string | null>(null);
  const [sshConfirmDeleteId, setSshConfirmDeleteId] = useState<string | null>(null);
  const [sshEditingPasswordId, setSshEditingPasswordId] = useState<string | null>(null);
  const [sshPassword, setSshPassword] = useState("");
  const [sshSavingPassword, setSshSavingPassword] = useState(false);
  const [sshCheck, setSshCheck] = useState<Record<string, SshCheck>>({});
  const [sshCheckErrors, setSshCheckErrors] = useState<Record<string, string>>({});
  const [sshCheckingId, setSshCheckingId] = useState<string | null>(null);
  const [sshSyncing, setSshSyncing] = useState(false);
  const [sshBatchId, setSshBatchId] = useState<string | null>(null);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [sshError, setSshError] = useState("");
  const [syncResults, setSyncResults] = useState<SshSyncResults | null>(null);
  const candidateHandleRefs = useRef(new Map<string, HTMLButtonElement>());
  const movePickerRef = useRef<HTMLDivElement>(null);
  const dirty = useMemo(() => saved !== null && draft !== null && JSON.stringify(saved.configuration) !== JSON.stringify(draft), [saved, draft]);

  async function load() {
    setBusy(true); setError("");
    try {
      const result = await callTool<ConfigurationResponse>("get_model_configuration");
      setSaved(result); setDraft(structuredClone(result.configuration));
      setCandidateIds(Object.fromEntries(profiles.map((profile) => [profile, result.configuration.profiles[profile].map(() => newCandidateId())])) as Record<Profile, string[]>);
      setCatalog(await callTool<ModelCatalog>("list_models"));
      const roster = await callTool<{ agents: Agent[] }>("get_agent_configurations");
      setAgents(roster.agents.filter((agent) => result.configuration.agents[agent.name] !== undefined));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load configuration."); }
    finally { setBusy(false); }
  }

  async function loadSshServers() {
    setSshLoading(true); setSshError("");
    try {
      const result = await callTool<{ servers: SshServer[] }>("get_ssh_servers");
      setSshServers(result.servers);
    } catch (cause) { setSshError(cause instanceof Error ? cause.message : "Unable to load saved SSH servers."); }
    finally { setSshLoading(false); }
  }

  useEffect(() => { void initializeMcpApps().then(load).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to connect.")); }, []);
  useEffect(() => {
    if (page !== "sync") return;
    void loadSshServers();
    const batchId = sessionStorage.getItem("subagent-config-ssh-sync-batch");
    if (batchId) { setSshBatchId(batchId); setSshSyncing(true); void monitorSshBatch(batchId); }
  }, [page]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler); }, [dirty]);
  useEffect(() => {
    if (!movePicker) return;
    movePickerRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMovePicker(null); setFocusCandidateId(movePicker.candidateId); }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (movePickerRef.current?.contains(target) || candidateHandleRefs.current.get(movePicker.candidateId)?.contains(target)) return;
      setMovePicker(null); setFocusCandidateId(movePicker.candidateId);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", dismiss); document.removeEventListener("pointerdown", outside); };
  }, [movePicker]);
  useEffect(() => {
    if (!focusCandidateId) return;
    candidateHandleRefs.current.get(focusCandidateId)?.focus();
    setFocusCandidateId(null);
  }, [candidateIds, focusCandidateId]);

  function update(fn: (current: Configuration) => void) { setDraft((current) => { if (!current) return current; const next = structuredClone(current); fn(next); return next; }); }
  function reorderCandidate(profile: Profile, from: number, to: number) {
    const models = draft?.profiles[profile];
    if (!models || from < 0 || to < 0 || from >= models.length || to >= models.length || from === to) return;
    const candidate = models[from];
    update((next) => { const [item] = next.profiles[profile].splice(from, 1); next.profiles[profile].splice(to, 0, item); });
    setCandidateIds((current) => { const ids = [...current[profile]]; const [id] = ids.splice(from, 1); ids.splice(to, 0, id); return { ...current, [profile]: ids }; });
    setCandidateAnnouncement(`Moved ${candidate.model || "empty model"} to position ${to + 1} of ${models.length} in ${profile}.`);
  }
  function addCandidate(profile: Profile) {
    update((next) => { next.profiles[profile].push({ model: "" }); });
    setCandidateIds((current) => ({ ...current, [profile]: [...current[profile], newCandidateId()] }));
  }
  function removeCandidate(profile: Profile, index: number) {
    update((next) => { next.profiles[profile].splice(index, 1); });
    setCandidateIds((current) => ({ ...current, [profile]: current[profile].filter((_, itemIndex) => itemIndex !== index) }));
  }
  function changeCandidate(profile: Profile, index: number, key: keyof Candidate, value: string) { update((next) => { if (key === "reasoningEffort" && !value) delete next.profiles[profile][index].reasoningEffort; else next.profiles[profile][index][key] = value; }); }
  async function save() {
    if (!saved || !draft) return;
    setBusy(true); setError("");
    try { await callTool("save_model_configuration", { configuration: draft, fileRevision: saved.fileRevision }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save configuration."); setBusy(false); }
  }
  function updateSshDraft<K extends keyof SshServerDraft>(key: K, value: SshServerDraft[K]) {
    setSshDraft((current) => current ? { ...current, [key]: value } : current);
  }
  async function saveSshServer() {
    if (!sshDraft) return;
    setSshSaving(true); setSshError("");
    try {
      await callTool("save_ssh_server", {
        ...(sshDraft.id ? { id: sshDraft.id } : {}),
        name: sshDraft.name,
        target: sshDraft.target,
        ...(sshDraft.port ? { port: Number(sshDraft.port) } : {}),
        codexHome: sshDraft.codexHome,
        authentication: sshDraft.authentication,
        ...(sshDraft.authentication === "key-file" && sshDraft.keyFilePath ? { keyFilePath: sshDraft.keyFilePath } : {}),
      });
      setSshDraft(null); await loadSshServers();
    } catch (cause) { setSshError(cause instanceof Error ? cause.message : "Unable to save this SSH server."); }
    finally { setSshSaving(false); }
  }
  async function deleteSshServer(id: string) {
    setSshDeleting(id); setSshError("");
    try { await callTool("delete_ssh_server", { id }); setSshServers((current) => current.filter((server) => server.id !== id)); setSshCheck((current) => { const next = { ...current }; delete next[id]; return next; }); setSshCheckErrors((current) => { const next = { ...current }; delete next[id]; return next; }); }
    catch (cause) { setSshError(cause instanceof Error ? cause.message : "Unable to delete this SSH server."); }
    finally { setSshDeleting(null); }
  }
  async function saveSshPassword(id: string) {
    if (!sshPassword) return;
    const password = sshPassword;
    if (new TextEncoder().encode(password).byteLength > 4096) { setSshError("SSH passwords may contain at most 4096 UTF-8 bytes."); return; }
    setSshPassword(""); setSshSavingPassword(true); setSshError("");
    try {
      const entry = await callTool<{ url: string; ticket: string; proofKey: string; encryptionKey: string }>("begin_ssh_password_entry", { serverId: id, origin: window.location.origin });
      const post = async (body: unknown) => {
        const response = await fetch(entry.url, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body) });
        const result = await response.json() as { saved?: boolean; proof?: string; error?: string };
        if (!response.ok) throw new Error(result.error || "The local password channel could not be verified.");
        return result;
      };
      const nonce = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const challenge = await post({ phase: "challenge", nonce });
      const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)), (character) => character.charCodeAt(0));
      const key = await crypto.subtle.importKey("raw", decode(entry.proofKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`server\n${entry.ticket}\n${nonce}`)));
      const expectedProof = btoa(String.fromCharCode(...expectedBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      if (challenge.proof !== expectedProof) throw new Error("The local password endpoint is not the Subagent Config server. Password was not sent.");
      const saveBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`client\n${entry.ticket}\n${nonce}`)));
      const saveProof = btoa(String.fromCharCode(...saveBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const encryptionKey = await crypto.subtle.importKey("raw", decode(entry.encryptionKey), { name: "AES-GCM" }, false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${entry.ticket}\n${nonce}`) }, encryptionKey, new TextEncoder().encode(password)));
      const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const result = await post({ phase: "save", nonce, proof: saveProof, iv: encode(iv), ciphertext: encode(ciphertext) });
      if (!result.saved) throw new Error(result.error || "The system credential store did not confirm the password.");
      setSshEditingPasswordId(null); await loadSshServers();
    } catch (cause) { setSshError(cause instanceof Error ? cause.message : "Unable to save the SSH password."); }
    finally { setSshSavingPassword(false); }
  }
  async function checkSshTarget(server: SshServer) {
    setSshCheckingId(server.id); setSshError(""); setSyncResults(null); setOverwriteConfirmed(false);
    setSshCheck((current) => { const next = { ...current }; delete next[server.id]; return next; });
    setSshCheckErrors((current) => { const next = { ...current }; delete next[server.id]; return next; });
    try {
      const result = await callTool<SshCheck>("check_ssh_codex_target", { serverId: server.id }, 45000);
      setSshCheck((current) => ({ ...current, [server.id]: result }));
    } catch (cause) { setSshCheckErrors((current) => ({ ...current, [server.id]: cause instanceof Error ? cause.message : `Unable to check ${server.name}.` })); }
    finally { setSshCheckingId(null); }
  }
  async function monitorSshBatch(batchId: string) {
    try {
      while (true) {
        const result = await callTool<SshSyncResults>("get_ssh_sync_batch", { batchId }, 20000);
        setSyncResults(result);
        if (result.status === "completed") {
          sessionStorage.removeItem("subagent-config-ssh-sync-batch"); setSshBatchId(null); setSshSyncing(false); return;
        }
        if (result.status === "unknown") {
          setSshError("Sync progress could not be recovered after the plugin server restarted. Inspect each remote plugin and its recovery copies before retrying.");
          sessionStorage.removeItem("subagent-config-ssh-sync-batch"); setSshBatchId(null); setSshSyncing(false); return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
      }
    } catch (cause) {
      setSshError(cause instanceof Error ? cause.message : "Unable to refresh the sync status. The remote batch may still be running.");
      setSshSyncing(false);
    }
  }
  async function syncAllSshServers() {
    if (!overwriteConfirmed || !sshServers.length || sshBatchId) return;
    if (dirty) { setSshError("Save or discard your model changes first. Sync uses the saved configuration."); return; }
    setSshSyncing(true); setSshError(""); setSyncResults(null);
    try {
      const result = await callTool<SshSyncResults>("sync_subagent_config_to_all_ssh", { serverIds: sshServers.map((server) => server.id), confirmOverwrite: true });
      setSshBatchId(result.batchId); sessionStorage.setItem("subagent-config-ssh-sync-batch", result.batchId); setSyncResults(result);
      await monitorSshBatch(result.batchId);
    } catch (cause) { setSshError(cause instanceof Error ? cause.message : "Unable to start sync to all SSH servers."); setSshSyncing(false); }
  }

  const agent = agents.find((item) => item.name === selectedAgent);
  return <div className="app">
    <header className="app-header"><h1>Subagent Config</h1><div className="profile-actions"><IconButton type="button" icon="refresh" label="Refresh configuration" onClick={() => void load()} disabled={busy || dirty} /><button type="button" onClick={() => void save()} disabled={busy || !dirty}>Save changes</button></div></header>
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Configuration sections">
        <button type="button" className={page === "models" ? "active" : ""} onClick={() => { setPage("models"); setSelectedAgent(null); }}>Models</button>
        <button type="button" className={page === "agents" ? "active" : ""} onClick={() => { setPage("agents"); setSelectedAgent(null); }}>Agents</button>
        <button type="button" className={page === "sync" ? "active" : ""} onClick={() => { setPage("sync"); setSelectedAgent(null); }}>SSH Sync</button>
      </nav>
      <main className="settings-content">
        {saved && !saved.configured ? <p className="profile-notice">Add at least one model to every profile, then save.</p> : null}
        {error ? <p className="profile-error" role="alert">{error}</p> : null}
        {draft ? <>
          {page === "models" ? <>
            <div className="page-heading"><h2>Models</h2><p>Set an ordered list of candidates for each model profile.</p></div>
            <section className="profile-grid">{profiles.map((profile) => <article className="profile-card" key={profile}>
              <div className="card-heading"><h3>{profile}</h3><p>{descriptions[profile]}</p></div>
              {draft.profiles[profile].map((candidate, index) => {
                const candidateId = candidateIds[profile][index];
                const over = dragOver?.profile === profile && dragOver.candidateId === candidateId ? dragOver.side : null;
                return <div className={`candidate-row${dragCandidateId === candidateId ? " is-dragging" : ""}${over ? ` drop-${over}` : ""}`} key={candidateId}
                  onDragOver={(event) => {
                    if (!dragCandidateId || !candidateIds[profile].includes(dragCandidateId)) return;
                    event.preventDefault(); event.dataTransfer.dropEffect = "move";
                    const side = event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? "before" : "after";
                    setDragOver({ profile, candidateId, side });
                  }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(null); }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source = candidateIds[profile].indexOf(dragCandidateId ?? event.dataTransfer.getData("text/plain"));
                    const target = candidateIds[profile].indexOf(candidateId);
                    const side = dragOver?.profile === profile && dragOver.candidateId === candidateId ? dragOver.side : "before";
                    let destination = target + (side === "after" ? 1 : 0);
                    if (source >= 0 && source < destination) destination -= 1;
                    reorderCandidate(profile, source, Math.max(0, Math.min(candidateIds[profile].length - 1, destination)));
                    setDragCandidateId(null); setDragOver(null);
                  }}>
                <div className="candidate-order"><IconButton type="button" icon="grip" className="candidate-drag-handle" label={`Reorder ${candidate.model || `empty model ${index + 1}`} in ${profile}; activate to choose a position`} ref={(element) => { if (element) candidateHandleRefs.current.set(candidateId, element); else candidateHandleRefs.current.delete(candidateId); }} disabled={draft.profiles[profile].length < 2} draggable={draft.profiles[profile].length > 1} onClick={() => setMovePicker({ profile, candidateId })} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", candidateId); setDragCandidateId(candidateId); }} onDragEnd={() => { setDragCandidateId(null); setDragOver(null); }} /><span className="candidate-rank" aria-hidden="true">{index + 1}</span></div>
                <label>Model<select value={candidate.model} disabled={!catalog} aria-label={`${profile} model candidate ${index + 1}`} onChange={(event) => changeCandidate(profile, index, "model", event.target.value)}>
                  {!candidate.model ? <option value="">Select a model</option> : null}
                  {candidate.model && catalog && !catalog.models.some((model) => model.slug === candidate.model) ? <option value={candidate.model} disabled>Unavailable: {candidate.model}</option> : null}
                  {catalog?.models.map((model) => <option key={model.slug} value={model.slug}>{model.displayName} ({model.slug})</option>)}
                </select></label>
                <label>Reasoning<select value={candidate.reasoningEffort ?? ""} onChange={(event) => changeCandidate(profile, index, "reasoningEffort", event.target.value)}><option value="">Model default</option>{(catalog?.supportedReasoningEfforts ?? ["low", "medium", "high", "xhigh", "max", "ultra"]).map((effort) => <option key={effort}>{effort}</option>)}</select></label>
                <div className="candidate-actions"><IconButton type="button" icon="remove" label={`Remove ${candidate.model || `empty model ${index + 1}`} from ${profile}`} onClick={() => removeCandidate(profile, index)} /></div>
                {movePicker?.candidateId === candidateId ? <div className="candidate-rank-picker" ref={movePickerRef} role="group" aria-label={`Move ${candidate.model || `empty model ${index + 1}`} to position`}><strong>Move to position</strong><div>{candidateIds[profile].map((id, position) => <button type="button" key={id} aria-pressed={position === index} onClick={() => { const from = candidateIds[profile].indexOf(candidateId); reorderCandidate(profile, from, position); setMovePicker(null); setFocusCandidateId(candidateId); }}>{position + 1}</button>)}</div></div> : null}
              </div>;
              })}
              <IconButton type="button" icon="plus" label={`Add model to ${profile}`} className="add-candidate" onClick={() => addCandidate(profile)} />
            </article>)}</section>
            <p className="visually-hidden" aria-live="polite" aria-atomic="true">{candidateAnnouncement}</p>
          </> : page === "agents" ? <>
            {agent ? <section className="agent-detail">
              <IconButton className="back-link" icon="back" label="Back to agents" type="button" onClick={() => setSelectedAgent(null)} />
              <div className="page-heading"><h2>{agent.name}</h2><p>{agent.description}</p></div>
              <label className="agent-profile-field">Model profile<select value={draft.agents[agent.name]} onChange={(event) => update((next) => { next.agents[agent.name] = event.target.value as Assignment; })}>{agent.name === "developer" ? <option value="auto">auto</option> : null}{profiles.map((name) => <option key={name}>{name}</option>)}</select></label>
              <section className="prompt-preview"><h3>Instructions</h3><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{agent.developerInstructions ?? "Prompt is unavailable."}</ReactMarkdown></div></section>
            </section> : <>
              <div className="page-heading"><h2>Agents</h2><p>Choose a model profile for each subagent. Open an agent to preview its instructions.</p></div>
              <ul className="agent-rows">{Object.entries(draft.agents).map(([name, profile]) => <li key={name}><button type="button" className="agent-row" onClick={() => setSelectedAgent(name)}><span className="agent-row-copy"><strong>{name}</strong><small>{agents.find((item) => item.name === name)?.description}</small></span><select aria-label={`${name} model profile`} value={profile} onClick={(event) => event.stopPropagation()} onChange={(event) => update((next) => { next.agents[name] = event.target.value as Assignment; })}>{name === "developer" ? <option value="auto">auto</option> : null}{profiles.map((item) => <option key={item}>{item}</option>)}</select><span className="row-arrow" aria-hidden="true">›</span></button></li>)}</ul>
            </>}
          </> : <>
            <div className="page-heading sync-page-heading"><div><h2>SSH servers</h2><p>Manage remote Codex connections and sync Subagent Config to all of them.</p></div><button className="sync-primary" type="button" onClick={() => void syncAllSshServers()} disabled={!sshServers.length || !overwriteConfirmed || sshSyncing || Boolean(sshBatchId) || sshLoading || dirty}>{sshSyncing ? "Syncing all…" : sshBatchId ? "Sync status needs refresh" : "Sync all"}</button></div>
            <div className="ssh-list-toolbar"><IconButton type="button" icon="plus" label="Add SSH server" onClick={() => setSshDraft({ name: "", target: "", codexHome: "~/.codex", authentication: "agent" })} disabled={sshSaving || sshSyncing || Boolean(sshDraft)} /><IconButton type="button" icon="refresh" label={sshLoading ? "Refreshing SSH servers" : "Refresh SSH server list"} aria-busy={sshLoading} onClick={() => void loadSshServers()} disabled={sshLoading || sshSyncing} />{sshBatchId && !sshSyncing ? <IconButton type="button" icon="refresh" label="Refresh sync progress" onClick={() => { setSshSyncing(true); void monitorSshBatch(sshBatchId); }} /> : null}</div>
            {sshDraft ? <section className="sync-panel ssh-editor" aria-labelledby="ssh-editor-heading">
              <div className="sync-section-heading"><h3 id="ssh-editor-heading">{sshDraft.id ? "Edit SSH server" : "New SSH server"}</h3><p>Authentication uses your local SSH configuration, key file, or saved system credential.</p></div>
              <div className="sync-fields ssh-editor-fields">
                <label>Server name<input autoComplete="off" maxLength={80} value={sshDraft.name} onChange={(event) => updateSshDraft("name", event.target.value)} /></label>
                <label>SSH host or alias<input autoComplete="off" spellCheck={false} placeholder="lumina-pc or user@host" value={sshDraft.target} onChange={(event) => updateSshDraft("target", event.target.value)} /></label>
                <label>Port <span className="field-optional">Optional</span><input inputMode="numeric" type="number" min="1" max="65535" placeholder="Use SSH config" value={sshDraft.port ?? ""} onChange={(event) => updateSshDraft("port", event.target.value ? Number(event.target.value) : undefined)} /></label>
                <label className="codex-home-field">Remote CODEX_HOME<input autoComplete="off" spellCheck={false} placeholder="~/.codex" value={sshDraft.codexHome} onChange={(event) => updateSshDraft("codexHome", event.target.value)} /></label>
                <label>Authentication<select value={sshDraft.authentication} onChange={(event) => updateSshDraft("authentication", event.target.value as SshAuth)}><option value="agent">SSH config or agent</option><option value="key-file">Private key file</option><option value="password">Password</option></select></label>
                {sshDraft.authentication === "key-file" ? <label className="key-file-field">Private key file path<input autoComplete="off" spellCheck={false} placeholder="C:\\Users\\you\\.ssh\\id_ed25519" value={sshDraft.keyFilePath ?? ""} onChange={(event) => updateSshDraft("keyFilePath", event.target.value)} /><small>The key stays on this device. Host verification settings are preserved; ProxyJump, ProxyCommand, and KnownHostsCommand are not supported.</small></label> : null}
              </div>
              <div className="ssh-editor-actions"><IconButton type="button" icon="remove" label="Cancel editing SSH server" onClick={() => setSshDraft(null)} disabled={sshSaving} /><button className="sync-primary" type="button" onClick={() => void saveSshServer()} disabled={sshSaving || !sshDraft.name.trim() || !sshDraft.target.trim()}>{sshSaving ? "Saving…" : "Save server"}</button></div>
            </section> : null}
            {sshLoading && !sshServers.length ? <p className="sync-status sync-status-pending" role="status">Loading saved SSH servers…</p> : null}
            {!sshLoading && !sshServers.length && !sshDraft ? <p className="ssh-empty">No SSH servers saved. Add a server to configure where Subagent Config syncs.</p> : null}
            {sshError ? <div className="sync-status sync-status-error" role="alert"><strong>SSH sync issue</strong><p>{sshError}</p></div> : null}
            {sshServers.length ? <>
              <ul className="ssh-server-list">{sshServers.map((server) => <li key={server.id}>
                <div className="ssh-server-main"><div className="ssh-server-copy"><strong>{server.name}</strong><span>{server.target}{server.port ? `:${server.port}` : ""}</span><small>{server.codexHome} · {server.authentication === "agent" ? "SSH config or agent" : server.authentication === "key-file" ? "Private key file" : !server.passwordStoreAvailable ? "System keychain unavailable" : server.passwordSaved ? "Password saved in system keychain" : "Password not saved"}</small></div>
                  <div className="ssh-server-actions"><IconButton type="button" icon="edit" label={`Edit ${server.name}`} onClick={() => { setSshDraft({ ...server }); setSshEditingPasswordId(null); }} disabled={sshSyncing || Boolean(sshDraft)} /><IconButton type="button" icon="check" label={sshCheckingId === server.id ? `Checking ${server.name}` : sshCheck[server.id] ? `Check ${server.name} again` : `Check ${server.name}`} aria-busy={sshCheckingId === server.id} onClick={() => void checkSshTarget(server)} disabled={sshSyncing || sshCheckingId === server.id} />{server.authentication === "password" ? <IconButton type="button" icon="key" label={server.passwordSaved ? `Update saved password for ${server.name}` : `Save password for ${server.name}`} onClick={() => { setSshEditingPasswordId(sshEditingPasswordId === server.id ? null : server.id); setSshPassword(""); }} disabled={sshSyncing} /> : null}<IconButton type="button" icon="trash" label={`Delete ${server.name}`} aria-busy={sshDeleting === server.id} onClick={() => setSshConfirmDeleteId(sshConfirmDeleteId === server.id ? null : server.id)} disabled={sshSyncing || sshDeleting === server.id} /></div>
                </div>
                {sshEditingPasswordId === server.id ? <div className="ssh-password-entry"><label>SSH password<input type="password" autoComplete="new-password" maxLength={4096} value={sshPassword} onChange={(event) => setSshPassword(event.target.value)} /></label><button className="sync-primary" type="button" onClick={() => void saveSshPassword(server.id)} disabled={!sshPassword || sshSavingPassword}>{sshSavingPassword ? "Saving securely…" : "Save to system keychain"}</button><IconButton type="button" icon="remove" label="Cancel password entry" onClick={() => { setSshEditingPasswordId(null); setSshPassword(""); }} /></div> : null}
                {sshConfirmDeleteId === server.id ? <div className="ssh-delete-confirm"><span>Delete {server.name} and remove its saved password?</span><button type="button" onClick={() => { void deleteSshServer(server.id); setSshConfirmDeleteId(null); }}>Confirm delete</button><IconButton type="button" icon="remove" label="Cancel delete" onClick={() => setSshConfirmDeleteId(null)} /></div> : null}
                {sshCheckingId === server.id ? <p className="sync-status sync-status-pending ssh-check-result" role="status">Checking SSH and remote Codex requirements…</p> : null}
                {sshCheckErrors[server.id] ? <section className="sync-status sync-status-error ssh-check-result" role="alert"><strong>Connection check failed</strong><p>{sshCheckErrors[server.id]}</p></section> : null}
                {sshCheck[server.id] ? <section className="sync-status sync-status-success ssh-check-result" role="status"><strong>Connection verified</strong><p>SSH is connected and the remote Codex prerequisites are available.</p><dl className="sync-facts ssh-check-facts"><div><dt>Remote Codex home</dt><dd>{sshCheck[server.id].codexHome}</dd></div><div><dt>Codex CLI</dt><dd>{sshCheck[server.id].codexVersion}</dd></div><div><dt>Node.js</dt><dd>{sshCheck[server.id].nodeVersion}</dd></div><div><dt>Plugin version</dt><dd>{sshCheck[server.id].pluginVersion}</dd></div></dl></section> : null}
              </li>)}</ul>
              <label className="overwrite-confirm ssh-all-confirm"><input type="checkbox" checked={overwriteConfirmed} onChange={(event) => { setOverwriteConfirmed(event.target.checked); setSyncResults(null); }} /><span>Sync all {sshServers.length} configured servers. Each destination's Subagent Config plugin will be replaced and, when configured locally, its MyWorkbench model profiles will be updated. Provider credentials and other Codex settings are not copied.</span></label>
              {dirty ? <p className="sync-hint">Save or discard your model changes first. Sync uses the saved configuration.</p> : null}
            </> : null}
            {syncResults ? <section className={`sync-status ${syncResults.status === "completed" ? "sync-status-success" : "sync-status-pending"}`} role="status"><strong>{syncResults.status === "running" ? `Syncing all servers: ${syncResults.syncedCount} complete` : syncResults.status === "unknown" ? "Sync status unavailable" : `Sync finished: ${syncResults.syncedCount} of ${syncResults.results.length} servers`}</strong><ul className="ssh-sync-results">{syncResults.results.map((result) => <li key={result.id}><strong>{result.name}:</strong> {result.state === "synced" ? `plugin ${result.pluginVersion} installed at ${result.codexHome}. Restart remote Codex to reload it.` : result.state === "failed" ? result.error : result.state === "syncing" ? "sync in progress…" : "waiting to sync…"}</li>)}</ul></section> : null}
          </>}
        </> : <p>Loading configuration…</p>}
      </main>
    </div>
  </div>;
}
