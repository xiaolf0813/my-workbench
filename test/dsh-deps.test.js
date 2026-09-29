import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { dshModuleRoots, resolveLaneDependencies } from '../bin/dsh-deps.js'

const deps = { tools: '@deepseek-ai/dsh-tools', schema: '@deepseek-ai/schemastery' }
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'my-workbench-dsh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function packageAt(root, name, exportsField = './index.mjs') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', exports: { '.': exportsField } }))
  const entry = typeof exportsField === 'string' ? exportsField : exportsField.import
  writeFileSync(join(dir, entry), 'export default {}\n')
  return join(dir, entry)
}

test('profile closure resolves the ESM entry and wins over the explicit fallback', t => {
  const dir = fixture(t)
  const home = join(dir, 'home')
  const profileRoot = join(home, 'profiles', 'node_modules')
  const fallback = join(dir, 'fallback')
  const toolsFile = packageAt(profileRoot, deps.tools)
  packageAt(profileRoot, deps.schema, { require: './index.cjs', import: './index.mjs' })
  packageAt(fallback, deps.tools)
  const roots = dshModuleRoots(home, { pathEnv: '', envModules: fallback })
  assert.equal(roots[0], profileRoot)
  const result = resolveLaneDependencies(home, deps, { pathEnv: '', envModules: fallback })
  assert.equal(result.tools, pathToFileURL(toolsFile).href)
  assert.match(result.schema, /index\.mjs$/)
})

test('unstarted DSH resolves packages from its launcher install without executing it', t => {
  const dir = fixture(t)
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'dsh.cmd'), 'not an executable command')
  const closure = join(bin, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
  const toolsFile = packageAt(closure, deps.tools)
  packageAt(closure, deps.schema)
  const result = resolveLaneDependencies(home, deps, { pathEnv: bin, envModules: '' })
  assert.equal(result.tools, pathToFileURL(toolsFile).href)
})

test('missing dependency reports the searched roots', t => {
  const dir = fixture(t)
  const home = join(dir, 'home')
  assert.throws(
    () => resolveLaneDependencies(home, deps, { pathEnv: '', envModules: '' }),
    error => error.message.includes(join(home, 'profiles', 'node_modules')) && error.message.includes("no 'dsh' launcher"),
  )
})

test('DSH install renders host, page, and prompts from one lane record', t => {
  const dir = fixture(t)
  const home = join(dir, 'home')
  const modules = join(dir, 'modules')
  // A user-realm run stamps the REAL home; sandbox it so the test touches nothing outside the fixture.
  const sandboxHome = join(dir, 'user-home')
  mkdirSync(home)
  mkdirSync(sandboxHome)
  packageAt(modules, deps.tools)
  packageAt(modules, deps.schema)
  const result = spawnSync(process.execPath, [join(repo, 'bin', 'my-workbench.js'), '--dsh'], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: home, MY_WORKBENCH_DSH_NODE_MODULES: modules, HOME: sandboxHome, USERPROFILE: sandboxHome },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const preset = join(home, '.agent-presets', 'my-workbench')
  const roster = readFileSync(join(preset, 'lane-plugin', 'src', 'roster.generated.js'), 'utf8')
  const host = readFileSync(join(preset, 'lane-plugin', 'src', 'index.js'), 'utf8')
  const prompts = readFileSync(join(preset, 'lane-plugin', 'src', 'prompts.generated.js'), 'utf8')
  const page = readFileSync(join(preset, 'lane-plugin-ui', 'lib', 'client.js'), 'utf8')
  for (const file of [
    join(preset, 'lane-plugin', 'src', 'index.js'),
    join(preset, 'lane-plugin', 'src', 'roster.generated.js'),
    join(preset, 'lane-plugin', 'src', 'prompts.generated.js'),
    join(preset, 'lane-plugin-ui', 'lib', 'client.js'),
  ]) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(checked.status, 0, checked.stderr)
  }
  assert.match(host, /from '\.\/roster\.generated\.js'/)
  assert.match(roster, /subagent_explorer/)
  assert.match(prompts, /"explorer":/)
  assert.match(page, /外部文档研究/)
  assert.doesNotMatch(page, /__MY_WORKBENCH_LANES__/)
  assert.equal(
    readFileSync(join(sandboxHome, '.my-workbench.version'), 'utf8').trim(),
    JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version,
  )
})

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
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** Run --upgrade --claude in a temp project whose root carries the given stamp (none when omitted);
 *  path, when given, replaces PATH so a fake npx can shadow the real one.
 *  Async spawn, not spawnSync: the registry server lives in this process, and a
 *  sync spawn would freeze the event loop it answers on. */
function upgradeRun(cwd, stamp, registry, path) {
  if (stamp !== undefined) writeFileSync(join(cwd, 'my-workbench.version'), stamp)
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [join(repo, 'bin', 'my-workbench.js'), '--upgrade', '--claude'], {
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

/** A fake npx first on PATH: logs the args it was called with, optionally rewrites the
 *  project stamp (the redeploy's cwd is the project root), and exits with the given code. */
function fakeNpx(t, { rewrite, exitCode = 0 } = {}) {
  const bin = join(fixture(t), 'bin')
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
  return { path: bin + delimiter + (process.env.PATH ?? ''), log }
}

test('--upgrade exits 0 when the deployment stamp matches the registry latest', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t)
  const result = await upgradeRun(fixture(t), '9.9.9\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /up-to-date/)
  assert.equal(existsSync(npx.log), false, 'npx must not run for an up-to-date deployment')
})

test('--upgrade auto-upgrades an outdated stamp via npx and verifies the rewrite', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t, { rewrite: '9.9.9' })
  const result = await upgradeRun(fixture(t), '0.0.1\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(npx.log, 'utf8').trim(), '--yes my-workbench@9.9.9 --claude --force')
  assert.match(result.stdout, /upgraded/)
})

test('--upgrade fails when the npx redeploy exits non-zero', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t, { exitCode: 3 })
  const result = await upgradeRun(fixture(t), '0.0.1\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr + result.stdout, /redeploy exited with status 3/)
})

test('--upgrade leaves a deployment newer than npm latest alone', async t => {
  const server = await registryServer(t)
  const npx = fakeNpx(t, { rewrite: '9.9.9' })
  const result = await upgradeRun(fixture(t), '99.0.0\n', `http://127.0.0.1:${server.address().port}`, npx.path)
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stdout, /newer than npm latest/)
  assert.equal(existsSync(npx.log), false, 'npx must not run for a newer deployment')
})

test('--upgrade fails gracefully when the registry is unreachable', async t => {
  const result = await upgradeRun(fixture(t), '9.9.9\n', 'http://127.0.0.1:1')
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr + result.stdout, /could not read the latest/)
})
