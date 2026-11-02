import { useCallback, useEffect, useRef, useState } from "react";
import { AgentList } from "./components/AgentList";
import { AgentModelForm } from "./components/AgentModelForm";
import { StatusMessage, type Status } from "./components/StatusMessage";
import {
  callTool,
  getInvocationProjectRoot,
  initializeMcpApps,
  subscribeInvocationProjectRoot,
} from "./bridge/mcp-apps-client";
import type { AgentModelConfiguration, ModelCatalog, UpdateResult } from "./types";

type AgentSnapshot = {
  agents: AgentModelConfiguration[];
};

export function App() {
  const [agents, setAgents] = useState<AgentModelConfiguration[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(getInvocationProjectRoot);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });
  const [initializing, setInitializing] = useState(true);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const cancelDiscardButton = useRef<HTMLButtonElement>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setInitializing(true);
    setStatus({ kind: "idle", message: "" });
    try {
      await initializeMcpApps();
      const [agentSnapshot, modelCatalog] = await Promise.all([
        callTool<AgentSnapshot>("get_agent_configurations", projectRoot ? { projectRoot } : {}),
        callTool<ModelCatalog>("list_models"),
      ]);
      if (generation === refreshGeneration.current) {
        setAgents(agentSnapshot.agents);
        setCatalog(modelCatalog);
      }
    } catch (error) {
      if (generation === refreshGeneration.current) {
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Unable to load agents." });
      }
    } finally {
      if (generation === refreshGeneration.current) setInitializing(false);
    }
  }, [projectRoot]);

  useEffect(() => subscribeInvocationProjectRoot(setProjectRoot), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!discardDialogOpen) return;
    cancelDiscardButton.current?.focus();
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        pendingNavigation.current = null;
        setDiscardDialogOpen(false);
      }
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [discardDialogOpen]);

  const visibleAgents = agents.filter((agent) => agent.scope !== "builtin");
  const selected = visibleAgents.find((agent) => agent.id === selectedId) ?? null;

  const requestNavigation = useCallback(
    (action: () => void) => {
      if (!hasUnsavedChanges) {
        action();
        return;
      }
      pendingNavigation.current = action;
      setDiscardDialogOpen(true);
    },
    [hasUnsavedChanges],
  );

  function cancelDiscard() {
    pendingNavigation.current = null;
    setDiscardDialogOpen(false);
  }

  function discardAndContinue() {
    const action = pendingNavigation.current;
    pendingNavigation.current = null;
    setDiscardDialogOpen(false);
    setHasUnsavedChanges(false);
    action?.();
  }

  const save = useCallback(
    async (agent: AgentModelConfiguration, values: { model: string; effort: string; summary: string; verbosity: string }) => {
      const result = await callTool<UpdateResult>("update_agent_model", {
        agentId: agent.id,
        fileRevision: agent.fileRevision,
        model: values.model || null,
        modelReasoningEffort: values.model && values.effort ? values.effort : null,
        modelReasoningSummary: values.model && values.summary ? values.summary : null,
        modelVerbosity: values.model && values.verbosity ? values.verbosity : null,
      });
      if (!result.saved) throw new Error(result.error || "The server rejected the save.");
      await refresh();
      setSelectedId(agent.id);
    },
    [refresh],
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>Subagent Config</h1>
      </header>
      <StatusMessage status={status} />
      <div className="layout">
        <AgentList
          agents={visibleAgents}
          selectedId={selectedId}
          loading={initializing}
          projectRoot={projectRoot}
          onRefresh={() =>
            requestNavigation(() => {
              setSelectedId(null);
              void refresh();
            })
          }
          onSelect={(agent) => {
            if (agent.id === selectedId) return;
            requestNavigation(() => {
              setSelectedId(agent.id);
              setStatus({ kind: "idle", message: "" });
            });
          }}
        />
        <AgentModelForm key={selectedId} agent={selected} catalog={catalog} onSave={save} onDirtyChange={setHasUnsavedChanges} />
      </div>
      {discardDialogOpen ? (
        <div className="dialog-backdrop">
          <section className="discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-dialog-title" aria-describedby="discard-dialog-description">
            <h2 id="discard-dialog-title">Unsaved changes</h2>
            <p id="discard-dialog-description">Your model configuration changes have not been saved. Discard them and continue?</p>
            <div className="dialog-actions">
              <button ref={cancelDiscardButton} type="button" className="ghost" onClick={cancelDiscard}>
                Keep editing
              </button>
              <button type="button" className="danger" onClick={discardAndContinue}>
                Discard changes
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
