import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { preserveCodexSettings, rootStatements } from '../bin/codex-agent.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t, override = true) {
  const root = mkdtempSync(join(tmpdir(), 'my-workbench-codex-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const config = override ? join(root, 'custom codex home') : join(home, '.codex');
  const codexLog = join(root, 'codex-plugin.log');
  const fakeCodex = join(root, 'fake-codex.cjs');
  mkdirSync(home); mkdirSync(project);
  writeFileSync(fakeCodex, `
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(process.env.MY_WORKBENCH_TEST_CODEX_LOG, JSON.stringify(args) + '\\n');
if (process.env.MY_WORKBENCH_FAIL_PLUGIN_INSTALL === '1' && args[0] === 'plugin' && args[1] === 'add') {
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'partial plugin registration\\n');
  const cache = join(process.env.CODEX_HOME, 'plugins', 'cache', 'my-workbench', 'subagent-config', '0.1.8');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'plugin.json'), '{"partial":true}');
  process.exit(42);
}
process.stdout.write(JSON.stringify({ ok: true }));
`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), XDG_CONFIG_HOME: join(home, '.config') };
  env.MY_WORKBENCH_TEST_CODEX_BIN = process.execPath;
  env.MY_WORKBENCH_TEST_CODEX_SCRIPT = fakeCodex;
  env.MY_WORKBENCH_TEST_CODEX_LOG = codexLog;
  if (override) env.CODEX_HOME = config; else delete env.CODEX_HOME;
  const runRaw = (...args) => spawnSync(process.execPath, [join(repo, 'bin/my-workbench.js'), ...args], { cwd: project, env, encoding: 'utf8' });
  const run = (...args) => {
    const result = runRaw(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  return { root, home, project, config, codexLog, env, run, runRaw };
}

test('ChatGPT alias deploys native agents into CODEX_HOME without changing config.toml', t => {
  const f = fixture(t);
  mkdirSync(f.config);
  const config = '[agents]\nenabled = true\n';
  writeFileSync(join(f.config, 'config.toml'), config);
  f.run('--chatgpt');
  assert.equal(readFileSync(join(f.config, 'config.toml'), 'utf8'), config);
  const files = readdirSync(join(f.config, 'agents'));
  assert.equal(files.length, 9);
  for (const file of files) {
    assert.ok(file.endsWith('.toml'));
    const fields = new Map(rootStatements(readFileSync(join(f.config, 'agents', file), 'utf8')).map(({ key, raw }) => [key, raw]));
    assert.ok(fields.has('name') && fields.has('description') && fields.has('developer_instructions'));
    const body = JSON.parse(fields.get('developer_instructions').split(' = ').slice(1).join(' = '));
    assert.match(body, /## Disciplines/);
    assert.match(body, /You are a leaf specialist/);
    assert.ok(body.indexOf('## Host execution boundaries') < body.indexOf('## Disciplines'));
    assert.doesNotMatch(body, /\{\{slot:|Adapted from/);
    assert.equal(fields.has('model'), false, 'models inherit from the current session');
  }
  const entry = readFileSync(join(f.config, 'AGENTS.md'), 'utf8');
  assert.ok(Buffer.byteLength(entry) < 2048);
  assert.equal(entry.match(/my-workbench Codex orchestrator \(managed block/g)?.length, 1);
  assert.ok(entry.includes(join(f.config, 'my-workbench-orchestrator.md').split(sep).join('/')));
  assert.ok(existsSync(join(f.config, 'my-workbench-solutions/toolkit-gui-test.md')));
  const marketplace = join(f.config, 'my-workbench-plugin-marketplace');
  assert.ok(existsSync(join(marketplace, '.agents/plugins/marketplace.json')));
  assert.ok(existsSync(join(marketplace, 'plugins/subagent-config/runtime/server.mjs')));
  assert.ok(existsSync(join(marketplace, 'plugins/subagent-config/runtime/component.html')));
  const pluginCalls = readFileSync(f.codexLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(pluginCalls.at(-2), ['plugin', 'marketplace', 'add', marketplace, '--json']);
  assert.deepEqual(pluginCalls.at(-1), ['plugin', 'add', 'subagent-config@my-workbench', '--json']);
  assert.ok(existsSync(join(f.config, 'my-workbench.version')));
  assert.equal(existsSync(join(f.home, '.my-workbench.version')), false);
  assert.deepEqual(readdirSync(f.project), []);
});

test('Codex defaults to the sandbox home; dry-run writes nothing', t => {
  const f = fixture(t, false);
  const dry = f.run('--codex', '--dry-run');
  assert.match(dry.stdout, /codex plugin marketplace add .* \(dry-run\)/);
  assert.match(dry.stdout, /codex plugin add subagent-config@my-workbench --json  \(dry-run\)/);
  assert.equal(existsSync(f.config), false);
  assert.equal(existsSync(join(f.home, '.my-workbench.version')), false);
  f.run('--codex', '--user');
  assert.ok(existsSync(join(f.config, 'agents/fixer.toml')));
  assert.ok(existsSync(join(f.config, 'my-workbench.version')));
});

test('Codex plugin install failure rolls back files, config, cache, and the CODEX_HOME stamp', t => {
  const f = fixture(t);
  mkdirSync(f.config);
  const config = '[agents]\nenabled = true\n';
  writeFileSync(join(f.config, 'config.toml'), config);
  f.env.MY_WORKBENCH_FAIL_PLUGIN_INSTALL = '1';
  const result = f.runRaw('--codex');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /codex plugin add subagent-config@my-workbench --json failed/);
  assert.match(result.stderr, /rollback\s+restored Codex files and plugin registration state/);
  assert.equal(readFileSync(join(f.config, 'config.toml'), 'utf8'), config);
  assert.equal(existsSync(join(f.config, 'agents/fixer.toml')), false);
  assert.equal(existsSync(join(f.config, 'AGENTS.md')), false);
  assert.equal(existsSync(join(f.config, 'my-workbench-orchestrator.md')), false);
  assert.equal(existsSync(join(f.config, 'plugins/cache/my-workbench/subagent-config/0.1.8/plugin.json')), false);
  assert.equal(existsSync(join(f.config, 'my-workbench.version')), false);
});

test('Codex reruns skip owned files, refresh guides, and preserve model knobs on force', t => {
  const f = fixture(t);
  f.run('--codex');
  const agent = join(f.config, 'agents/observer.toml');
  const guide = join(f.config, 'my-workbench-solutions/toolkit-gui-test.md');
  const previous = 'model = "custom/model" # user pin\nmodel_reasoning_effort = \'high\'\nmodel_verbosity = "low"\nname = "old"\ndeveloper_instructions = "old"\n';
  writeFileSync(agent, previous);
  writeFileSync(guide, 'stale');
  writeFileSync(join(f.config, 'AGENTS.md'), 'user instructions');
  f.run('--codex');
  assert.equal(readFileSync(agent, 'utf8'), previous);
  const entry = readFileSync(join(f.config, 'AGENTS.md'), 'utf8');
  assert.ok(entry.startsWith('user instructions\n\n'));
  assert.equal(entry.match(/my-workbench Codex orchestrator \(managed block/g)?.length, 1);
  assert.notEqual(readFileSync(guide, 'utf8'), 'stale');
  f.run('--codex', '--force');
  const repaired = readFileSync(agent, 'utf8');
  assert.match(repaired, /^model = "custom\/model" # user pin/m);
  assert.match(repaired, /^model_reasoning_effort = 'high'/m);
  assert.match(repaired, /^features.shell_tool = false$/m);
  assert.match(repaired, /^name = "observer"$/m);
  f.run('--codex', '--force');
  assert.equal(readFileSync(agent, 'utf8'), repaired, 'force is idempotent');
  assert.equal(readFileSync(join(f.config, 'AGENTS.md'), 'utf8'), entry, 'managed block is idempotent and preserves user text');
});

test('Codex maintains the loader block in AGENTS.override.md when it is active', t => {
  const f = fixture(t);
  mkdirSync(f.config);
  writeFileSync(join(f.config, 'AGENTS.md'), 'fallback user instructions\n');
  writeFileSync(join(f.config, 'AGENTS.override.md'), 'active override instructions\n');
  f.run('--codex');
  assert.equal(readFileSync(join(f.config, 'AGENTS.md'), 'utf8'), 'fallback user instructions\n');
  const override = readFileSync(join(f.config, 'AGENTS.override.md'), 'utf8');
  assert.ok(override.startsWith('active override instructions\n\n'));
  assert.equal(override.match(/my-workbench Codex orchestrator \(managed block/g)?.length, 1);
  f.run('--codex');
  assert.equal(readFileSync(join(f.config, 'AGENTS.override.md'), 'utf8'), override);
});

test('Codex rejects a malformed managed block and rolls back earlier writes', t => {
  const f = fixture(t);
  mkdirSync(f.config);
  const malformed = 'user instructions\n\n<!-- >>> my-workbench Codex orchestrator (managed block - regenerated by `my-workbench --codex`) >>>\n';
  writeFileSync(join(f.config, 'AGENTS.md'), malformed);
  const result = f.runRaw('--codex');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /opening marker but not its closing marker/);
  assert.equal(readFileSync(join(f.config, 'AGENTS.md'), 'utf8'), malformed);
  assert.equal(existsSync(join(f.config, 'agents/fixer.toml')), false);
  assert.equal(existsSync(join(f.config, 'my-workbench.version')), false);
});

test('TOML preservation ignores prompt text and nested keys, and retains multiline settings', () => {
  const previous = `# model = "comment"\ndeveloper_instructions = '''\nmodel = "prompt"\n'''\nmodel = """custom/model""" # pinned\nmodel_reasoning_effort = 'high'\n[features]\nmodel_verbosity = "nested"\n`;
  const fresh = 'name = "observer"\nfeatures.shell_tool = false\ndeveloper_instructions = "new"\n';
  const result = preserveCodexSettings(previous, fresh);
  assert.match(result, /^model = """custom\/model""" # pinned/m);
  assert.match(result, /model_reasoning_effort = 'high'/);
  assert.match(result, /features.shell_tool = false/);
  assert.doesNotMatch(result, /nested|prompt|comment/);
  assert.equal(preserveCodexSettings(null, fresh), fresh);
  const withQuotes = 'developer_instructions = """ends with a quote""""\nmodel = \'custom/after-prompt\'\n';
  assert.ok(preserveCodexSettings(withQuotes, fresh).startsWith("model = 'custom/after-prompt'\n"));
});
