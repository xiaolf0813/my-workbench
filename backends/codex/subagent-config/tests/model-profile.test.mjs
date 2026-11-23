import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyConfiguration, getModelConfiguration, saveModelConfiguration, validateConfiguration } from "../dist/services/model-profile-service.js";

test("profile configuration uses ordered candidates and migrates managed agent pins with a backup", () => {
  const home = mkdtempSync(path.join(tmpdir(), "my-workbench-profiles-"));
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const config = emptyConfiguration();
    assert.equal(config.agents.developer, "auto");
    for (const profile of Object.keys(config.profiles)) config.profiles[profile] = [{ model: `${profile}-primary` }, { model: `${profile}-backup`, reasoningEffort: "high" }];
    assert.deepEqual(validateConfiguration(config), config);
    const agentDir = path.join(home, "agents");
    mkdirSync(agentDir);
    const agentFile = path.join(agentDir, "driver.toml");
    writeFileSync(agentFile, 'model = "old-model"\nmodel_reasoning_effort = "high"\nname = "driver"\ndeveloper_instructions = "Keep this"\n');
    const saved = saveModelConfiguration(config, null);
    assert.equal(saved.saved, true);
    assert.deepEqual(getModelConfiguration().configuration.profiles.fast.map((item) => item.model), ["fast-primary", "fast-backup"]);
    const agent = readFileSync(agentFile, "utf8");
    assert.doesNotMatch(agent, /^model(?:_reasoning_effort)?\s*=/m);
    assert.match(agent, /Keep this/);
    const backups = readdirSync(path.join(home, "my-workbench-agent-model-backups"));
    assert.equal(backups.length, 1);
    assert.match(readFileSync(path.join(home, "my-workbench-agent-model-backups", backups[0]), "utf8"), /old-model/);
    assert.throws(() => saveModelConfiguration(config, null), /changed since it was opened/);
    const invalid = structuredClone(config);
    invalid.profiles.standard = [];
    assert.throws(() => validateConfiguration(invalid), /needs 1 to 20/);
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  }
});
