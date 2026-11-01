import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PathResolver } from "../dist/infrastructure/path-resolver.js";
import { getAgentConfigurations } from "../dist/services/agent-config-service.js";
import { updateAgentModel } from "../dist/services/agent-write-service.js";
import { listModels } from "../dist/services/model-catalog-service.js";
import { getAgentConfigurationsTool } from "../dist/tools/get-agent-configurations.js";
import { updateAgentModelTool } from "../dist/tools/update-agent-model.js";

async function withSandbox(action) {
  const sandbox = await fs.mkdtemp(path.join(path.resolve("tests"), "tools-sandbox-"));
  try {
    await action(sandbox);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

test("rejects arbitrary update paths and edits only the scanned agent id", async () => {
  await withSandbox(async (sandbox) => {
    const home = path.join(sandbox, "home");
    const project = path.join(sandbox, "project");
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.mkdir(path.join(project, ".codex", "agents"), { recursive: true });
    const source = 'name = "planner"\ndescription = "Plans work."\ndeveloper_instructions = """\nPlan first.\n"""\n# keep\nother = 1\n';
    const filePath = path.join(home, "agents", "planner.toml");
    await fs.writeFile(filePath, source, "utf8");
    const revision = `sha256:${createHash("sha256").update(source).digest("hex")}`;
    const resolver = new PathResolver(home, project);
    const models = await listModels();
    await assert.rejects(
      updateAgentModel(resolver, models, {
        agentId: "personal:planner",
        fileRevision: revision,
        model: "custom/provider-model",
        modelReasoningEffort: "high",
      }),
      /selected from the available model list/,
    );
    const result = await updateAgentModel(resolver, models, {
      agentId: "personal:planner",
      fileRevision: revision,
      model: "gpt-6-luna",
      modelReasoningEffort: "high",
      modelReasoningSummary: "auto",
      modelVerbosity: "low",
    });
    assert.equal(result.saved, true);
    const updated = await fs.readFile(filePath, "utf8");
    assert.match(updated, /# keep/);
    assert.match(updated, /other = 1/);
    assert.equal(resolver.resolveAgentPath("personal:..%2Fsecret"), null);
    assert.equal(resolver.resolveAgentPath("personal:%"), null);
    await assert.rejects(
      updateAgentModel(resolver, models, {
        agentId: "personal:planner",
        fileRevision: revision,
        model: "gpt-6-luna",
        modelReasoningEffort: "high",
      }),
      /changed after it was loaded/,
    );
  });
});

test("get_agent_configurations hides developer instructions on conflict", async () => {
  const resolver = new PathResolver(
    fileURLToPath(new URL("./fixtures/codex-home", import.meta.url)),
    fileURLToPath(new URL("./fixtures/project-root", import.meta.url)),
  );
  const { agents } = await getAgentConfigurations(resolver);
  const conflicts = agents.filter((agent) => agent.name.toLowerCase() === "shared");
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts.every((agent) => agent.developerInstructions === null), true);
});

test("tool update re-resolves a scanned project agent whose file name differs from its name", async () => {
  await withSandbox(async (sandbox) => {
    const home = path.join(sandbox, "home");
    const project = path.join(sandbox, "project with 空格");
    const projectAgents = path.join(project, ".codex", "agents");
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.mkdir(projectAgents, { recursive: true });
    const source = 'name = "planner"\ndescription = "Plans work."\ndeveloper_instructions = """\nPlan first.\n"""\n';
    const filePath = path.join(projectAgents, "renamed-agent.toml");
    await fs.writeFile(filePath, source, "utf8");

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const snapshot = await getAgentConfigurationsTool({ projectRoot: project });
      const agent = snapshot.agents.find((entry) => entry.id === "project:planner");
      assert.equal(agent?.editable, true);
      const result = await updateAgentModelTool({
        agentId: "project:planner",
        fileRevision: agent.fileRevision,
        model: "gpt-6-luna",
        modelReasoningEffort: "high",
      });
      assert.equal(result.saved, true);
      assert.match(await fs.readFile(filePath, "utf8"), /model = "gpt-6-luna"/);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});
