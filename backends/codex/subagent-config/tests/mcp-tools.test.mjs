import assert from "node:assert/strict";
import { revisionForFile } from "../dist/infrastructure/file-system.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "smol-toml";
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
    const revision = revisionForFile(filePath, source);
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
    const inherited = await updateAgentModel(resolver, models, {
      agentId: "personal:planner",
      fileRevision: result.fileRevision,
      model: null,
      modelReasoningEffort: null,
    });
    assert.equal(inherited.saved, true);
    const restored = await fs.readFile(filePath, "utf8");
    assert.doesNotMatch(restored, /^model(?:_|\s*=)/m);
    assert.match(restored, /# keep/);
    assert.equal(resolver.resolveAgentPath("personal:..%2Fsecret"), null);
    assert.equal(resolver.resolveAgentPath("personal:%"), null);
    await assert.rejects(
      updateAgentModel(resolver, models, {
        agentId: "personal:planner",
        fileRevision: result.fileRevision,
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

test("a save after switching projects targets the original scanned file with its nonmatching filename", async () => {
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
      const secondProject = path.join(sandbox, "project B");
      const secondFile = path.join(secondProject, ".codex", "agents", "renamed-agent.toml");
      await fs.mkdir(path.dirname(secondFile), { recursive: true });
      await fs.writeFile(secondFile, source);
      const other = await getAgentConfigurationsTool({ projectRoot: secondProject });
      assert.notEqual(other.agents.find((entry) => entry.id === agent.id).fileRevision, agent.fileRevision);

      const result = await updateAgentModelTool({
        agentId: "project:planner",
        fileRevision: agent.fileRevision,
        model: "gpt-6-luna",
        modelReasoningEffort: "high",
      });
      assert.equal(result.saved, true);
      assert.equal(await fs.readFile(secondFile, "utf8"), source);
      const saved = parse(await fs.readFile(filePath, "utf8"));
      assert.equal(saved.model, "gpt-6-luna");
      assert.equal(saved.developer_instructions, parse(source).developer_instructions);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});

test("concurrent saves of one revision accept only one inherited-model effort change", async () => {
  await withSandbox(async (home) => {
    const resolver = new PathResolver(home);
    const file = path.join(home, "agents", "planner.toml");
    await fs.mkdir(path.dirname(file));
    const source = 'name = "planner"\ndescription = "Plans"\ndeveloper_instructions = "Plan first."\n';
    await fs.writeFile(file, source);
    const models = { models: [], supportedReasoningEfforts: ["medium", "high"] };
    const input = { agentId: "personal:planner", model: null, fileRevision: revisionForFile(file, source) };
    const efforts = ["medium", "high"];
    const attempts = await Promise.allSettled(efforts.map((effort) =>
      updateAgentModel(resolver, models, { ...input, modelReasoningEffort: effort }),
    ));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.match(attempts.find((result) => result.status === "rejected").reason.message, /in progress|changed after/);
    const winner = efforts[attempts.findIndex((result) => result.status === "fulfilled")];
    const saved = parse(await fs.readFile(file, "utf8"));
    assert.equal(saved.model_reasoning_effort, winner);
    assert.equal(saved.model, undefined);
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["planner.toml"]);
    await assert.rejects(updateAgentModel(resolver, models, { ...input, modelReasoningEffort: null }), /changed after/);
  });
});
