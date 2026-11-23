import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PathResolver } from "../dist/infrastructure/path-resolver.js";
import { getAgentConfigurations } from "../dist/services/agent-config-service.js";

test("discovers personal, project, and built-in agents", async () => {
  const resolver = new PathResolver(
    fileURLToPath(new URL("./fixtures/codex-home", import.meta.url)),
    fileURLToPath(new URL("./fixtures/project-root", import.meta.url)),
  );
  const { agents } = await getAgentConfigurations(resolver);
  assert.equal(agents.filter((agent) => agent.scope === "personal").length, 2);
  assert.equal(agents.filter((agent) => agent.scope === "project").length, 5);
  assert.deepEqual(
    agents.filter((agent) => agent.scope === "builtin").map((agent) => agent.name),
    ["default", "worker", "explorer"],
  );
  const planner = agents.find((agent) => agent.name === "planner");
  assert.equal(planner.model, "gpt-6.1-sol");
  assert.equal(planner.developerInstructions, "Create an implementation plan before coding.");
});

test("marks malformed and duplicate-name agents as non-editable", async () => {
  const resolver = new PathResolver(
    fileURLToPath(new URL("./fixtures/codex-home", import.meta.url)),
    fileURLToPath(new URL("./fixtures/project-root", import.meta.url)),
  );
  const { agents } = await getAgentConfigurations(resolver);
  assert.equal(agents.find((agent) => agent.name === "").editable, false);
  const missingInstructions = agents.find((agent) => agent.name === "missing-instructions");
  assert.equal(missingInstructions.editable, false);
  assert.match(missingInstructions.parseError, /developer_instructions/);
  assert.equal(agents.filter((agent) => agent.name.toLowerCase() === "shared").every((agent) => !agent.editable), true);
});
