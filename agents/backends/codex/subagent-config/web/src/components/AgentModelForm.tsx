import { useEffect, useMemo, useState } from "react";
import { InstructionsViewer } from "./InstructionsViewer";
import { StatusMessage, type Status } from "./StatusMessage";
import type { AgentModelConfiguration, ModelCatalog } from "../types";

type FormValues = {
  model: string;
  effort: string;
  summary: string;
  verbosity: string;
};

function valuesFromAgent(agent: AgentModelConfiguration): FormValues {
  return {
    model: agent.model ?? "",
    effort: agent.modelReasoningEffort ?? "medium",
    summary: agent.modelReasoningSummary ?? "",
    verbosity: agent.modelVerbosity ?? "",
  };
}

export function AgentModelForm({
  agent,
  catalog,
  onSave,
  onDirtyChange,
}: {
  agent: AgentModelConfiguration | null;
  catalog: ModelCatalog | null;
  onSave: (agent: AgentModelConfiguration, values: FormValues) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [values, setValues] = useState<FormValues | null>(agent ? valuesFromAgent(agent) : null);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });
  const selectedModel = useMemo(
    () => catalog?.models.find((model) => model.slug === values?.model),
    [catalog, values?.model],
  );
  const modelChoice = selectedModel?.slug ?? "";
  const loaded = agent ? valuesFromAgent(agent) : null;
  const dirty = Boolean(
    agent?.editable &&
      values !== null &&
      loaded !== null &&
      (values.model !== loaded.model || values.effort !== loaded.effort || values.summary !== loaded.summary || values.verbosity !== loaded.verbosity),
  );

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  if (!agent) {
    return (
      <main className="detail">
        <h1>Subagent Config</h1>
        <p>Select an agent to inspect its model configuration.</p>
      </main>
    );
  }

  if (!agent.editable) {
    return (
      <main className="detail">
        <h1>{agent.name || "(invalid agent)"}</h1>
        {agent.parseError ? <StatusMessage status={{ kind: "error", message: agent.parseError }} /> : null}
        <InstructionsViewer name={agent.name} instructions={agent.developerInstructions} />
      </main>
    );
  }

  if (!loaded) return null;
  const unsupportedEffort = Boolean(selectedModel?.slug && !selectedModel.supportedReasoningEfforts.includes(values?.effort ?? ""));
  const unknownModel = Boolean(values?.model && catalog && !catalog.models.some((model) => model.slug === values.model));
  const canSave = agent.editable && dirty && !unsupportedEffort && values?.model.trim() !== "" && values?.effort !== "";
  const availability = selectedModel?.available ?? null;

  function update<K extends keyof FormValues>(key: K, value: string) {
    setValues((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save() {
    if (!agent.editable || !values || !agent.fileRevision) return;
    setStatus({ kind: "info", message: "Saving..." });
    try {
      await onSave(agent, values);
      setStatus({
        kind: "success",
        message: `Saved ${agent.name}'s model configuration. New chats will use the new configuration.`,
      });
    } catch (error) {
      setStatus({ kind: "error", message: `Save failed: ${error instanceof Error ? error.message : "Unknown error."}` });
    }
  }

  return (
    <main className="detail">
      <header className="detail-header">
        <h1>{agent.name || "(invalid agent)"}</h1>
        {dirty ? (
          <button
            type="button"
            className="icon-button"
            onClick={save}
            disabled={!canSave || status.kind === "info"}
            aria-label={`Save ${agent.name}'s model configuration`}
            title="Save changes"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 3h11l3 3v15H5z" />
              <path d="M8 3v6h8V3M8 21v-7h8v7" />
            </svg>
          </button>
        ) : null}
      </header>
      {agent.parseError ? <StatusMessage status={{ kind: "error", message: agent.parseError }} /> : null}

      <section className="configuration-panel" aria-labelledby="configuration-heading">
        <h2 id="configuration-heading">Model configuration</h2>
        <div className="form-grid">
        <label htmlFor="model-choice">Model</label>
        <div className="model-picker">
          <select
            id="model-choice"
            value={modelChoice}
            onChange={(event) => update("model", event.target.value)}
            disabled={!agent.editable}
            aria-describedby={unknownModel ? "model-choice-error" : undefined}
          >
            <option value="" disabled>
              Select a model
            </option>
            {catalog?.models.map((model) => (
              <option key={model.slug} value={model.slug}>
                {model.displayName} ({model.slug})
              </option>
            ))}
          </select>
          {unknownModel ? (
            <p id="model-choice-error" className="field-warning" role="alert">
              The current model is not in the available model list. Select a listed model to replace it.
            </p>
          ) : null}
        </div>

        <label htmlFor="effort">Reasoning effort</label>
        <select
          id="effort"
          value={values?.effort ?? ""}
          onChange={(event) => update("effort", event.target.value)}
          disabled={!agent.editable}
        >
          {(selectedModel?.supportedReasoningEfforts ?? catalog?.supportedReasoningEfforts ?? []).map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>

        <label htmlFor="summary">Reasoning summary</label>
        <select
          id="summary"
          value={values?.summary ?? ""}
          onChange={(event) => update("summary", event.target.value)}
          disabled={!agent.editable}
        >
          {loaded.summary === "" ? <option value="">Not set</option> : null}
          {["auto", "concise", "detailed"].map((summary) => (
            <option key={summary} value={summary}>
              {summary}
            </option>
          ))}
        </select>

        <label htmlFor="verbosity">Output verbosity</label>
        <select
          id="verbosity"
          value={values?.verbosity ?? ""}
          onChange={(event) => update("verbosity", event.target.value)}
          disabled={!agent.editable}
        >
          {loaded.verbosity === "" ? <option value="">Not set</option> : null}
          {["low", "medium", "high"].map((verbosity) => (
            <option key={verbosity} value={verbosity}>
              {verbosity}
            </option>
          ))}
        </select>
        </div>

        {!unknownModel && availability === null ? (
          <StatusMessage status={{ kind: "warning", message: "Model availability is unverified." }} />
        ) : null}
        {unsupportedEffort ? (
          <StatusMessage status={{ kind: "error", message: "This model does not support the selected reasoning effort." }} />
        ) : null}

        <StatusMessage status={status} />
      </section>

      <InstructionsViewer name={agent.name} instructions={agent.developerInstructions} />

      <dl className="metadata">
        <div>
          <dt>Scope</dt>
          <dd>{agent.scope}</dd>
        </div>
        <div>
          <dt>File</dt>
          <dd>{agent.filePath || "No editable TOML file."}</dd>
        </div>
        <div>
          <dt>Description</dt>
          <dd>{agent.description || "-"}</dd>
        </div>
      </dl>
    </main>
  );
}
