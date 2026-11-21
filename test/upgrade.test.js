import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repo, 'bin', 'my-workbench.js')

// ── upgrade ───────────────────────────────────────────────────────────────────

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
function upgradeRun(cwd, stamp, registry, path, { targets = ['--claude'], env = {} } = {}) {
  if (stamp !== undefined) writeFileSync(join(cwd, 'my-workbench.version'), stamp)
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [cli, '--upgrade', ...targets], {
      cwd,
      env: { ...process.env, npm_config_registry: registry, ...(path === undefined ? {} : { PATH: path }), ...env },
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
function fakeNpx(t, { rewrite, rewriteFile = 'my-workbench.version', exitCode = 0 } = {}) {
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
    if (rewrite !== undefined) script.push(`>"${rewriteFile}" echo ${rewrite}`)
    script.push(`exit /b ${exitCode}`)
    writeFileSync(join(bin, 'npx.cmd'), script.join('\r\n') + '\r\n')
  } else {
    const script = ['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`]
    if (rewrite !== undefined) script.push(`printf '%s\\n' ${JSON.stringify(rewrite)} > ${JSON.stringify(rewriteFile)}`)
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

test('--user --upgrade checks the home stamp and preserves the user-level target selection', async t => {
  const server = await registryServer(t)
  const home = projectFixture(t)
  writeFileSync(join(home, '.my-workbench.version'), '0.0.1\n')
  const npx = fakeNpx(t, { rewrite: '9.9.9', rewriteFile: '.my-workbench.version' })
  const result = await upgradeRun(home, '99.0.0\n', `http://127.0.0.1:${server.address().port}`, npx.path, {
    targets: ['--user'],
    env: { HOME: home, USERPROFILE: home },
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(npx.log, 'utf8').trim(), '--yes my-workbench@9.9.9 --user --force')
  assert.equal(readFileSync(join(home, 'my-workbench.version'), 'utf8'), '99.0.0\n')
  assert.match(result.stdout, /upgraded\s+~\/\.my-workbench\.version/)
})

test('--opencode --upgrade checks only the home stamp without requiring --user', async t => {
  const server = await registryServer(t)
  const home = projectFixture(t)
  writeFileSync(join(home, '.my-workbench.version'), '0.0.1\n')
  const npx = fakeNpx(t, { rewrite: '9.9.9', rewriteFile: '.my-workbench.version' })
  const result = await upgradeRun(home, '99.0.0\n', `http://127.0.0.1:${server.address().port}`, npx.path, {
    targets: ['--opencode'],
    env: { HOME: home, USERPROFILE: home },
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(npx.log, 'utf8').trim(), '--yes my-workbench@9.9.9 --opencode --force')
  assert.equal(readFileSync(join(home, 'my-workbench.version'), 'utf8'), '99.0.0\n')
  assert.match(result.stdout, /upgraded\s+~\/\.my-workbench\.version/)
})

test('default --upgrade checks both project and home stamps', async t => {
  const server = await registryServer(t)
  const home = projectFixture(t)
  writeFileSync(join(home, '.my-workbench.version'), '0.0.1\n')
  const npx = fakeNpx(t, { rewrite: '9.9.9', rewriteFile: '.my-workbench.version' })
  const result = await upgradeRun(home, '9.9.9\n', `http://127.0.0.1:${server.address().port}`, npx.path, {
    targets: [],
    env: { HOME: home, USERPROFILE: home },
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(npx.log, 'utf8').trim(), '--yes my-workbench@9.9.9 --force')
  assert.match(result.stdout, /up-to-date\s+my-workbench\.version/)
  assert.match(result.stdout, /upgraded\s+~\/\.my-workbench\.version/)
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
