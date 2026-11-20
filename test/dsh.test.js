import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  compareDshVersions,
  describeDshInstallations,
  dshVersionInRange,
  dshVersionReport,
  findDshInstallations,
  parseDshVersion,
} from '../bin/dsh-version.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repo, 'bin', 'my-workbench.js')

// ── version gate (pure) ─────────────────────────────────────────────────────

test('DSH versions compare with prereleases below their release', () => {
  assert.equal(compareDshVersions('0.2.1-rc.2', '0.2.1-rc.3') < 0, true)
  assert.equal(compareDshVersions('0.2.1-rc.3', '0.2.1') < 0, true)
  assert.equal(compareDshVersions('0.2.1', '0.2.2-rc.5') < 0, true)
  assert.equal(compareDshVersions('0.2.2-rc.5', '0.2.2') < 0, true)
  assert.equal(compareDshVersions('0.2.2-rc.10', '0.2.2-rc.9') > 0, true, 'numeric identifiers compare numerically')
  assert.equal(compareDshVersions('v0.2.2-rc.5', '0.2.2-rc.5'), 0)
  assert.equal(parseDshVersion('nonsense'), undefined)
  assert.throws(() => compareDshVersions('nonsense', '0.2.1'), /cannot compare DSH versions/)
})

test('the supported window is >= 0.2.1-rc.2 < 0.3.0', () => {
  assert.equal(dshVersionInRange('0.2.1-rc.2'), true, 'the floor is inclusive')
  assert.equal(dshVersionInRange('0.2.2-rc.5'), true)
  assert.equal(dshVersionInRange('0.2.9'), true)
  assert.equal(dshVersionInRange('0.2.1-rc.1'), false)
  assert.equal(dshVersionInRange('0.1.5-rc.3'), false)
  assert.equal(dshVersionInRange('0.3.0-alpha.1'), false, 'the ceiling is exclusive')
  assert.equal(dshVersionInRange('junk'), false)
})

test('the version report blocks only when no installation is supported', () => {
  const unknown = dshVersionReport([])
  assert.match(unknown.warning, /could not find a DSH installation/)
  assert.equal(unknown.problem, undefined)

  const old = dshVersionReport([{ source: 'PATH', dir: '/opt/dsh', version: '0.1.5-rc.3' }])
  assert.match(old.problem, />= 0\.2\.1-rc\.2 < 0\.3\.0/)
  assert.match(old.problem, /0\.1\.5-rc\.3/)

  const mixed = dshVersionReport([
    { source: 'PATH', dir: '/old', version: '0.1.5-rc.3' },
    { source: 'DSH_INSTALL_DIR', dir: '/new', version: '0.2.2-rc.5' },
  ])
  assert.equal(mixed.problem, undefined)
  assert.match(mixed.warning, /outside the supported window/)

  const good = dshVersionReport([{ source: 'PATH', dir: '/new', version: '0.2.2-rc.5' }])
  assert.deepEqual(good, {})
  assert.match(describeDshInstallations([{ source: 'PATH', dir: '/new', version: '0.2.2-rc.5' }])[0], /^0\.2\.2-rc\.5 \(PATH: /)

  // A packaged Desktop install lives in app.asar, which plain Node cannot read.
  // It may be the supported runtime, so an old launcher must not cause a refusal.
  const unreadable = dshVersionReport([
    { source: 'a dsh launcher on PATH', dir: '/opt/old', version: '0.1.5-rc.3' },
    { source: 'DSH_INSTALL_DIR', dir: '/Applications/DeepSeek Harness.app/app.asar/dsh', version: undefined },
  ])
  assert.equal(unreadable.problem, undefined)
  assert.match(unreadable.warning, /no readable DSH installation/)
  assert.match(unreadable.warning, /unknown version/)
})

test('a dsh launcher on PATH is discovered without executing it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'my-workbench-dsh-launcher-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'bin')
  const pkg = join(bin, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(bin, 'dsh.cmd'), 'not an executable command\n')
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }))
  const found = findDshInstallations(join(dir, 'home'), { pathEnv: bin, installDir: '' })
  assert.equal(found.length, 1)
  assert.equal(found[0].version, '0.2.2-rc.5')
  assert.equal(found[0].source, 'a dsh launcher on PATH')
  assert.equal(found[0].dir, resolve(pkg))
})

// ── install fixture ─────────────────────────────────────────────────────────

/** A DSH home plus a fake installation at `version`, and the env for a `--dsh` run.
 *  PATH holds only an empty directory, so the machine's own launcher never leaks
 *  into a test; `installDir: ''` models "no version can be determined". */
function dshFixture(t, { version = '0.2.2-rc.5', installDir, probe = '', home } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'my-workbench-dsh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dshHome = home ?? join(dir, 'home')
  // A user-realm run stamps the REAL home; sandbox it so the test touches nothing outside the fixture.
  const sandboxHome = join(dir, 'user-home')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(sandboxHome, { recursive: true })
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  let install = installDir
  if (install === undefined) {
    install = join(dir, 'install')
    mkdirSync(install, { recursive: true })
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  }
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: repo,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_INSTALL_DIR: install,
        DSH_PROFILE_PROBE: probe,
        PATH: bin,
        HOME: sandboxHome,
        USERPROFILE: sandboxHome,
      },
      encoding: 'utf8',
    })
  return {
    home: dshHome,
    sandboxHome,
    install,
    run,
    patch: join(dshHome, 'cordis.patch.yml'),
    installDir: join(dshHome, 'my-workbench'),
    plugin: join(dshHome, 'my-workbench', 'lane-plugin', 'src', 'index.js'),
  }
}

/** Write a profile patch file under the fixture home. */
function writeProfilePatch(home, name, text) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), text)
}

const LEGACY_BLOCK = `# Your patch layer for this dsh profile.
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account

# >>> my-workbench lane settings page (managed block - regenerated by \`my-workbench --dsh\`) >>>
- insert:
    - id: my-workbench-lanes-ui
      name: 'file:///C:/Users/x/AppData/Local/Temp/x/.agent-presets/my-workbench/lane-plugin-ui/src/index.js'
# <<< my-workbench lane settings page <<<
`

// ── install ─────────────────────────────────────────────────────────────────

test('--dsh declares eight presets in the home patch and installs a self-contained plugin', t => {
  const { home, run, patch, installDir, plugin } = dshFixture(t)
  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /dsh\s+0\.2\.2-rc\.5 \(DSH_INSTALL_DIR:/)

  const block = readFileSync(patch, 'utf8')
  assert.match(block, /^# >>> my-workbench agent presets/m)
  assert.match(block, /^# <<< my-workbench agent presets/m)
  assert.equal(block.match(/name: '@deepseek-ai\/dsh-agent-preset'/g)?.length, 8, 'orchestrator + seven lanes')
  for (const preset of ['my-workbench', 'my-workbench-explorer', 'my-workbench-librarian', 'my-workbench-oracle', 'my-workbench-designer', 'my-workbench-fixer', 'my-workbench-observer', 'my-workbench-improver']) {
    assert.match(block, new RegExp(`id: preset-${preset}`), `${preset} is declared`)
  }
  // A preset declaration's child rows resolve from the profile's base URL, so the
  // lane plugin must be named by an absolute file: URL.
  assert.equal(block.includes(`name: '${pathToFileURL(plugin).href}'`), true, 'the lane row names the installed module by file: URL')
  assert.doesNotMatch(block, /\{\{(?:prompt|slot|lane-plugin|lane-pins|dep):?[^}]*\}\}/, 'no install-time placeholder ships')
  // The old design's per-profile row and the legacy directory are gone.
  assert.doesNotMatch(block, /lane-plugin-ui/)
  assert.equal(existsSync(join(home, '.agent-presets')), false)

  // The plugin is self-contained: sibling imports only, no package dependency,
  // no engine range DSH's compatibility preflight could reject.
  const source = readFileSync(plugin, 'utf8')
  for (const [, specifier] of source.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) assert.match(specifier, /^\.\//)
  const manifest = JSON.parse(readFileSync(join(installDir, 'lane-plugin', 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'my-workbench-lanes')
  assert.equal(manifest.version, JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version)
  for (const field of ['dependencies', 'peerDependencies', 'engines']) assert.equal(manifest[field], undefined, `${field} would need resolution or trip the preflight`)
  // The rendered artifact is kept for review and for a hand-merge.
  assert.equal(readFileSync(join(installDir, 'presets.generated.patch.yml'), 'utf8'), `${block.replace(/\n$/, '')}\n`)
})

test('--dsh is idempotent and renders per-lane model pins', t => {
  const { home, run, patch } = dshFixture(t)
  assert.equal(run(['--dsh']).status, 0)
  const first = readFileSync(patch, 'utf8')

  writeFileSync(
    join(home, 'my-workbench-lanes.json'),
    JSON.stringify({ explorer: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }, fixer: { provider: '', model: '', reasoningEffort: '' } }),
  )
  const pinned = run(['--dsh'])
  assert.equal(pinned.status, 0, pinned.stderr + pinned.stdout)
  assert.match(pinned.stdout, /lane pins read from/)
  const withPins = readFileSync(patch, 'utf8')
  assert.notEqual(withPins, first, 'changing the pin file re-renders the block')
  assert.match(withPins, /pins: \{"explorer":\{"provider":"deepseek-account","model":"deepseek-flash","reasoningEffort":"max"\},"fixer":\{"provider":"","model":"","reasoningEffort":""\}\}/)

  const rerun = run(['--dsh'])
  assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout)
  assert.match(rerun.stdout, /skip\s+.*cordis\.patch\.yml/)
  assert.match(rerun.stdout, /already current/)
  assert.equal(readFileSync(patch, 'utf8'), withPins, 'a rerun is byte-identical')
})

test('--dsh rejects an invalid pin file before writing anything', t => {
  const { home, run, patch } = dshFixture(t)
  writeFileSync(join(home, 'my-workbench-lanes.json'), JSON.stringify({ nope: { provider: 'p', model: 'm' } }))
  const result = run(['--dsh'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown lane "nope"/)
  assert.doesNotMatch(result.stderr, /\n {4}at /, 'a user-input error prints no stack trace')
  assert.equal(existsSync(patch), false, 'nothing was written')
})

test('--dsh refuses a runtime outside the supported window', t => {
  const { run, patch } = dshFixture(t, { version: '0.1.5-rc.3' })
  const result = run(['--dsh'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, />= 0\.2\.1-rc\.2 < 0\.3\.0/)
  assert.equal(existsSync(patch), false, 'no preset is written for a runtime that cannot read it')
})

test('--dsh installs with a warning when no installation can be read', t => {
  const { run, patch } = dshFixture(t, { installDir: '' })
  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout + result.stderr, /could not find a DSH installation/)
  assert.match(readFileSync(patch, 'utf8'), /preset-my-workbench/)
})

test('--dsh leaves a home patch it cannot extend alone and points at the rendered block', t => {
  const { home, run, patch, installDir } = dshFixture(t)
  const map = '# hand-written\nmodel:\n  provider: deepseek-account\n'
  writeFileSync(patch, map)
  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout + result.stderr, /is not a plain patch list/)
  assert.equal(readFileSync(patch, 'utf8'), map, 'the user file is untouched')
  assert.match(readFileSync(join(installDir, 'presets.generated.patch.yml'), 'utf8'), /preset-my-workbench/)
})

test('--dsh migrates a pre-0.2 install: profile rows removed, user rows kept, legacy directory deleted', t => {
  const { home, run, patch } = dshFixture(t)
  writeProfilePatch(home, 'desktop', LEGACY_BLOCK)
  writeProfilePatch(home, 'web', LEGACY_BLOCK)
  const legacy = join(home, '.agent-presets', 'my-workbench', 'lane-plugin')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, '..', 'agent.cordis.yml'), '# legacy\n')

  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /remove\s+.*desktop.*pre-0\.2 lane settings-page row/)
  assert.match(result.stdout, /legacy preset directory/)
  const desktop = readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(desktop, /my-workbench-lanes-ui/)
  assert.match(desktop, /agent-default-model/, "the user's own row survives")
  assert.equal(existsSync(join(home, '.agent-presets', 'my-workbench')), false)
  assert.match(readFileSync(patch, 'utf8'), /preset-my-workbench/)
})

test('--dsh-profile is gone', t => {
  const { run } = dshFixture(t)
  const result = run(['--dsh', '--dsh-profile', 'desktop'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown argument: --dsh-profile/)
})

// ── the installed plugin ────────────────────────────────────────────────────

/** A fake plugin context that records registrations and activation specs. */
function fakeContext() {
  const registered = []
  const calls = []
  const disposed = []
  let shape = 'flat'
  let result = { output: [{ type: 'text', text: 'lane report' }], stopReason: 'completed' }
  const ctx = {
    tools: { register: definition => { registered.push(definition); return () => {} } },
    subagents: {
      async startActivation(spec) {
        if (shape === 'nested' && spec.request === undefined) throw new TypeError("Cannot read properties of undefined (reading 'maxDepth')")
        calls.push(spec)
        return {
          name: 'agent-1',
          childId: 'child-1',
          result: Promise.resolve(result),
          dispose: async () => { disposed.push(1) },
        }
      },
    },
  }
  return {
    ctx,
    registered,
    calls,
    disposed,
    nested() { shape = 'nested' },
    settle(value) { result = value },
  }
}

/** Import the installed plugin (which needs its generated siblings) as `my-workbench --dsh` wrote it. */
async function installedPlugin(t, home) {
  const file = join(home, 'my-workbench', 'lane-plugin', 'src', 'index.js')
  return import(`${pathToFileURL(file).href}?test=${Math.random().toString(36).slice(2)}`)
}

test('the installed plugin registers one tool per lane and starts the lane preset', async t => {
  const { home, run } = dshFixture(t)
  assert.equal(run(['--dsh']).status, 0)
  const plugin = await installedPlugin(t, home)
  assert.equal(plugin.name, 'my-workbench-lanes')
  assert.deepEqual(plugin.inject, ['tools', 'subagents'])

  const fake = fakeContext()
  plugin.apply(fake.ctx, { maxDepth: 2, pins: { explorer: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } } })
  assert.deepEqual(fake.registered.map(tool => tool.name), [
    'subagent_explorer', 'subagent_librarian', 'subagent_oracle', 'subagent_designer', 'subagent_fixer', 'subagent_observer', 'subagent_improver',
  ])
  const explorer = fake.registered.find(tool => tool.name === 'subagent_explorer')
  const parent = { id: 'parent' }
  const exec = { agent: parent, signal: new AbortController().signal }

  const started = await explorer.execute({ prompt: 'map the code' }, exec)
  assert.match(started, /^started subagent agent-1 — lane explorer/)
  const spec = fake.calls[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'explorer lane')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.agentPreset, 'my-workbench-explorer', 'the child mounts that lane\'s preset')
  assert.equal(spec.maxDepth, 2)
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'map the code' }])
  assert.equal(spec.parent, parent)
  assert.deepEqual(spec.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })

  const waited = await explorer.execute({ prompt: 'map it', run_in_background: false }, exec)
  assert.equal(waited, 'lane report')
  assert.equal(fake.calls[1].delivery, 'caller', 'a waiting call does not also notify the parent')
  assert.ok(fake.disposed.length >= 1)

  // A lane without a pin inherits the session route.
  const fixer = fake.registered.find(tool => tool.name === 'subagent_fixer')
  await fixer.execute({ prompt: 'fix it' }, exec)
  assert.equal('agentOptions' in fake.calls[2], false)
})

test('the plugin tolerates both activation request shapes', async t => {
  const { home, run } = dshFixture(t)
  assert.equal(run(['--dsh']).status, 0)
  const plugin = await installedPlugin(t, home)
  const fake = fakeContext()
  fake.nested()
  plugin.apply(fake.ctx, {})
  const tool = fake.registered[0]
  const exec = { agent: { id: 'parent' }, signal: new AbortController().signal }
  const started = await tool.execute({ prompt: 'work' }, exec)
  assert.match(started, /started subagent/)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].request.agentPreset, 'my-workbench-explorer', '0.2.1-rc.2 takes the nested request')
  assert.equal(fake.calls[0].prompt, undefined)
})

test('the plugin reports a run failure as an errored tool call, not prose', async t => {
  const { home, run } = dshFixture(t)
  assert.equal(run(['--dsh']).status, 0)
  const plugin = await installedPlugin(t, home)
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const tool = fake.registered.find(entry => entry.name === 'subagent_fixer')
  const exec = { agent: { id: 'parent' }, signal: new AbortController().signal }
  fake.settle({ output: [{ type: 'text', text: 'partial' }], stopReason: 'error', diagnostic: 'boom' })
  await assert.rejects(() => tool.execute({ prompt: 'x', run_in_background: false }, exec), /ended with error: boom\n\npartial/)
  fake.settle({ output: [], stopReason: 'completed' })
  assert.match(await tool.execute({ prompt: 'x', run_in_background: false }, exec), /returned no text/)
  await assert.rejects(() => tool.execute({ prompt: '   ' }, exec), /prompt must be a non-empty string/)
  await assert.rejects(() => tool.execute({ prompt: 'ok' }, { agent: undefined, signal: exec.signal }), /needs a calling agent/)
})

test('a waiting lane is cancelled when the tool call aborts', async t => {
  const { home, run } = dshFixture(t)
  assert.equal(run(['--dsh']).status, 0)
  const plugin = await installedPlugin(t, home)
  const registered = []
  let disposed = 0
  const controller = new AbortController()
  const ctx = {
    tools: { register: definition => { registered.push(definition); return () => {} } },
    subagents: {
      async startActivation() {
        return { name: 'agent-1', childId: 'child-1', result: new Promise(() => {}), dispose: async () => { disposed += 1 } }
      },
    },
  }
  plugin.apply(ctx, {})
  const call = registered[0].execute({ prompt: 'long task', run_in_background: false }, { agent: { id: 'parent' }, signal: controller.signal })
  controller.abort()
  await assert.rejects(() => call, /abort/i)
  assert.equal(disposed >= 1, true, 'the published activation is disposed')
})

// ── upgrade (unchanged behavior, co-located with the DSH target) ─────────────

/** A local registry serving /my-workbench/latest with a fixed version; --upgrade tests point npm_config_registry at it. */
function registryServer(t) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version: '9.9.9' }))
  })
  t.after(() => {
    server.close()
    server.closeAllConnections?.()
  })
  return new Promise(resolveServer => server.listen(0, '127.0.0.1', () => resolveServer(server)))
}

/** Run --upgrade --claude in a temp project whose root carries the given stamp (none when omitted);
 *  path, when given, replaces PATH so a fake npx can shadow the real one.
 *  Async spawn, not spawnSync: the registry server lives in this process, and a
 *  sync spawn would freeze the event loop it answers on. */
function upgradeRun(cwd, stamp, registry, path) {
  if (stamp !== undefined) writeFileSync(join(cwd, 'my-workbench.version'), stamp)
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [cli, '--upgrade', '--claude'], {
      cwd,
      env: { ...process.env, npm_config_registry: registry, ...(path === undefined ? {} : { PATH: path }) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolveRun({ status, stdout, stderr }))
  })
}

function upgradeCodexRun(cwd, codexHome, registry) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [cli, '--upgrade', '--codex'], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, HOME: cwd, USERPROFILE: cwd, npm_config_registry: registry },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolveRun({ status, stdout, stderr }))
  })
}

/** A fake npx first on PATH: logs the args it was called with, optionally rewrites
 *  the project stamp (the redeploy's cwd is the project root), and exits with the given code. */
function fakeNpx(t, { rewrite, exitCode = 0 } = {}) {
  const bin = join(mkdtempSync(join(tmpdir(), 'my-workbench-npx-')), 'bin')
  t.after(() => rmSync(dirname(bin), { recursive: true, force: true }))
  const log = join(bin, 'npx.log')
  mkdirSync(bin)
  if (process.platform === 'win32') {
    // The CLI spawns npx through cmd.exe here and npm's own shim is npx.cmd, so the
    // fake must be a .cmd batch file: cmd cannot execute an extensionless sh script,
    // and without this it falls through to the real npx.cmd in the npm directory.
    // Redirection comes first so a trailing digit in %* can never read as "2>".
    const script = ['@echo off', `>"${log}" echo(%*`]
    if (rewrite !== undefined) script.push(`>"my-workbench.version" echo ${rewrite}`)
    script.push(`exit /b ${exitCode}`)
    writeFileSync(join(bin, 'npx.cmd'), script.join('\r\n') + '\r\n')
  } else {
    const script = ['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`]
    if (rewrite !== undefined) script.push(`printf '%s\\n' ${JSON.stringify(rewrite)} > my-workbench.version`)
    script.push(`exit ${exitCode}`)
    writeFileSync(join(bin, 'npx'), script.join('\n') + '\n')
    chmodSync(join(bin, 'npx'), 0o755)
  }
  return { path: bin + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''), log }
}

function projectFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'my-workbench-upgrade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('--upgrade exits 0 when the deployment stamp matches the registry latest', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t)
  const result = await upgradeRun(projectFixture(t), '9.9.9\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /up-to-date/)
  assert.equal(existsSync(npx.log), false, 'npx must not run for an up-to-date deployment')
})

test('--upgrade checks the selected CODEX_HOME stamp instead of the shared home stamp', async t => {
  const server = await registryServer(t)
  const home = projectFixture(t)
  const codexHome = join(home, 'codex-profile')
  mkdirSync(codexHome)
  writeFileSync(join(home, '.my-workbench.version'), '0.0.1\n')
  writeFileSync(join(codexHome, 'my-workbench.version'), '9.9.9\n')
  const result = await upgradeCodexRun(home, codexHome, `http://127.0.0.1:${server.address().port}`)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /~\/codex-profile[\\/]my-workbench\.version/)
  assert.match(result.stdout, /up-to-date/)
  assert.doesNotMatch(result.stdout, /\.my-workbench\.version/)
})

test('--upgrade auto-upgrades an outdated stamp via npx and verifies the rewrite', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t, { rewrite: '9.9.9' })
  const result = await upgradeRun(projectFixture(t), '0.0.1\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(npx.log, 'utf8').trim(), '--yes my-workbench@9.9.9 --claude --force')
  assert.match(result.stdout, /upgraded/)
})

test('--upgrade fails when the npx redeploy exits non-zero', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t, { exitCode: 3 })
  const result = await upgradeRun(projectFixture(t), '0.0.1\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr + result.stdout, /redeploy exited with status 3/)
})

test('--upgrade leaves a deployment newer than npm latest alone', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t, { rewrite: '9.9.9' })
  const result = await upgradeRun(projectFixture(t), '99.0.0\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stdout, /newer than npm latest/)
  assert.equal(existsSync(npx.log), false, 'npx must not run for a newer deployment')
})

test('--upgrade fails gracefully when the registry is unreachable', async t => {
  const result = await upgradeRun(projectFixture(t), '9.9.9\n', 'http://127.0.0.1:1')
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr + result.stdout, /could not read the latest/)
})
