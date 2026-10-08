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

/** A DSH home whose lane-plugin dependencies resolve, plus the env for a `--dsh` run against it.
 *  `marker` is the file written into each listed profile ({@link dshFixture} explains why):
 *  `"cordis.patch.yml"` (the default), `"package.json"`, or `null` for a bare directory.
 *  `probe` replaces the process-table command the CLI reads to decide whether DSH is
 *  running, so a test never depends on what is live on the machine. */
function dshFixture(t, { profiles = [], marker = 'cordis.patch.yml', probe = '' } = {}) {
  const dir = fixture(t)
  const home = join(dir, 'home')
  const modules = join(dir, 'modules')
  // A user-realm run stamps the REAL home; sandbox it so the test touches nothing outside the fixture.
  const sandboxHome = join(dir, 'user-home')
  mkdirSync(home)
  mkdirSync(sandboxHome)
  for (const name of profiles) {
    mkdirSync(join(home, 'profiles', name), { recursive: true })
    // marker === null models a bare directory: an initialized profile carries one of
    // its loader files or its manifest, and a bare one is reached only by the fallback.
    if (marker !== null) writeFileSync(join(home, 'profiles', name, marker), marker === 'cordis.patch.yml' ? '[]\n' : '{}\n')
  }
  packageAt(modules, deps.tools)
  packageAt(modules, deps.schema)
  const run = args =>
    spawnSync(process.execPath, [join(repo, 'bin', 'my-workbench.js'), ...args], {
      cwd: repo,
      env: {
        ...process.env,
        DSH_HOME: home,
        MY_WORKBENCH_DSH_NODE_MODULES: modules,
        HOME: sandboxHome,
        USERPROFILE: sandboxHome,
        DSH_PROFILE_PROBE: probe,
      },
      encoding: 'utf8',
    })
  return { home, sandboxHome, run, patchOf: name => join(home, 'profiles', name, 'cordis.patch.yml') }
}

test('DSH install renders host, page, and prompts from one lane record', t => {
  const { home, sandboxHome, run, patchOf } = dshFixture(t, { profiles: ['solo'], marker: null })
  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  // One bare profile directory under no managed name: it is still maintained, which is
  // the behavior every DSH home with a single profile had before profiles were plural.
  assert.match(readFileSync(patchOf('solo'), 'utf8'), /my-workbench-lanes-ui/)
  assert.match(result.stdout, /the only profile directory/)
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

test('installed lane artifacts carry the release that produced them', t => {
  // DSH's plugin inventory reports each active package as {name, version} from its
  // nearest manifest, so the manifests must name this release; the browser half has
  // no manifest field the shell reads, so its version lives in the file itself.
  const { home, run } = dshFixture(t, { profiles: ['web'] })
  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)

  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
  const preset = join(home, '.agent-presets', 'my-workbench')
  const host = JSON.parse(readFileSync(join(preset, 'lane-plugin', 'package.json'), 'utf8'))
  const page = JSON.parse(readFileSync(join(preset, 'lane-plugin-ui', 'package.json'), 'utf8'))
  assert.equal(host.name, 'my-workbench-lanes')
  assert.equal(page.name, 'my-workbench-lanes-ui')
  assert.equal(host.version, version, 'the host manifest names the installed release')
  assert.equal(page.version, version, 'the page manifest names the installed release')

  const bundle = readFileSync(join(preset, 'lane-plugin-ui', 'lib', 'client.js'), 'utf8')
  assert.match(bundle, new RegExp(`Generated by my-workbench ${version.replace(/\./g, '\\.')}`))
  assert.doesNotMatch(bundle, /__MY_WORKBENCH_VERSION__/, 'the version marker must not ship')
  assert.equal(bundle.match(/id: 'my-workbench-lanes-ui'/g)?.length, 2, 'module id and section id agree')

  // The three release-stamped files refresh on every run — skip-if-exists would
  // freeze the first release's version there — and the refresh is byte-identical,
  // so a re-run is a no-op on disk even though it reports a write.
  const stamped = ['lane-plugin/package.json', 'lane-plugin-ui/package.json', 'lane-plugin-ui/lib/client.js'];
  const before = stamped.map((rel) => readFileSync(join(preset, ...rel.split('/')), 'utf8'));
  const rerun = run(['--dsh'])
  assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout)
  for (const rel of stamped) {
    assert.match(rerun.stdout, new RegExp(`overwrite\\s+.*${rel.replace(/[./]/g, '.')}.*refreshed`), `${rel} is refreshed`)
  }
  // Everything else keeps the ordinary skip semantics.
  assert.match(rerun.stdout, /skip\s+.*lane-plugin.src.index\.js/)
  for (const [index, rel] of stamped.entries()) {
    assert.equal(readFileSync(join(preset, ...rel.split('/')), 'utf8'), before[index], `${rel} is byte-identical after a refresh`)
  }
})

test('--dsh warns when a DSH process is live, and stays quiet when none is', t => {
  // A profile row written while DSH runs reaches the disk but not the composition the
  // process already booted, and DSH Desktop refuses the change outright — so the run
  // has to say so before it writes, not leave the user with a page that never appears.
  const live = dshFixture(t, { profiles: ['desktop'], probe: 'echo @deepseek-ai/dsh-desktop-host/lib/index.js C:\\Users\\x\\.dsh\\profiles\\desktop' })
  const warned = live.run(['--dsh'])
  assert.equal(warned.status, 0, warned.stderr + warned.stdout)
  assert.match(warned.stdout + warned.stderr, /DSH appears to be running/)
  assert.match(warned.stdout + warned.stderr, /close DSH \(and DSH Desktop\) first/)
  assert.match(readFileSync(live.patchOf('desktop'), 'utf8'), /my-workbench-lanes-ui/, 'the warning does not block the write')

  const quiet = dshFixture(t, { profiles: ['desktop'], probe: 'node -e ""' })
  const clean = quiet.run(['--dsh'])
  assert.equal(clean.status, 0, clean.stderr + clean.stdout)
  assert.doesNotMatch(clean.stdout + clean.stderr, /DSH appears to be running/)

  // An unanswerable probe warns like a live one: a missed warning costs a confusing
  // no-op, a false one costs a sentence.
  const unknown = dshFixture(t, { profiles: ['desktop'], probe: 'node -e "process.exit(3)"' })
  const guessed = unknown.run(['--dsh'])
  assert.equal(guessed.status, 0, guessed.stderr + guessed.stdout)
  assert.match(guessed.stdout + guessed.stderr, /could not be determined on this platform/)
})

test('--dsh maintains the page row in the web and desktop profiles', t => {
  // `web` is what `dsh web` composes, `desktop` what DSH Desktop composes. With both
  // present, the desktop profile must not go without the row: it is per profile, and
  // only the profile a process composes is scanned for client halves.
  const { run, patchOf } = dshFixture(t, { profiles: ['web', 'desktop'] })
  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)

  const rows = [];
  for (const name of ['web', 'desktop']) {
    const patch = readFileSync(patchOf(name), 'utf8')
    assert.match(patch, /# >>> my-workbench lane settings page/, `${name} carries the managed block`)
    assert.match(patch, /- id: my-workbench-lanes-ui/, `${name} carries the row`)
    const found = patch.match(/name: '(file:[^']+)'/g)
    assert.equal(found?.length, 1, `${name} carries exactly one row name`)
    rows.push(found[0])
  }
  assert.equal(rows[0], rows[1], 'the row names the same installed page in both profiles')
  assert.match(rows[0], /lane-plugin-ui\/src\/index\.js'$/)

  // The non-destructive contract: the block is replaced in place, never re-added.
  const rerun = run(['--dsh'])
  assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout)
  for (const name of ['web', 'desktop']) {
    assert.match(rerun.stdout, new RegExp(`skip\\s+.*${name}.*cordis\\.patch\\.yml`), 'a current block reports as unchanged')
    assert.equal(readFileSync(patchOf(name), 'utf8').match(/# >>> my-workbench lane settings page/g).length, 1)
  }
})

test('--dsh-profile names one profile instead of every profile found', t => {
  const { patchOf, run } = dshFixture(t, { profiles: ['web', 'desktop'], marker: 'package.json' })
  const result = run(['--dsh', '--dsh-profile', 'desktop'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /named by --dsh-profile/)
  assert.match(readFileSync(patchOf('desktop'), 'utf8'), /my-workbench-lanes-ui/)
  assert.equal(existsSync(patchOf('web')), false, 'the unselected profile is left alone')

  // A named profile that does not exist is reported, never guessed at.
  const missing = run(['--dsh', '--dsh-profile', 'nope'])
  assert.equal(missing.status, 0, missing.stderr + missing.stdout)
  assert.match(missing.stdout, /nope names none of/)
  assert.match(missing.stdout, /the settings page was NOT mounted/)

  // The flag is a DSH option, and it needs a value, in either spelling.
  const mismatch = run(['--claude', '--dsh-profile', 'desktop'])
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stderr, /--dsh-profile only applies to the DSH target/)
  const bare = run(['--dsh', '--dsh-profile'])
  assert.equal(bare.status, 1)
  assert.match(bare.stderr, /--dsh-profile needs a profile name/)
  const empty = run(['--dsh', '--dsh-profile='])
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /--dsh-profile needs a profile name/)
  const optionValue = run(['--dsh', '--dsh-profile', '--force'])
  assert.equal(optionValue.status, 1)
  assert.match(optionValue.stderr, /needs a profile name, got '--force'/)
})

test('--dsh reports directories that are not profiles and writes nothing to them', t => {
  // Directories with no cordis.yml and no cordis.patch.yml are not profiles, and there
  // is no single one to fall back on: the CLI must name them and print the exact row
  // rather than pick one for the user.
  const { home, patchOf, run } = dshFixture(t, { profiles: ['boom', 'odd'], marker: null })
  // The shared dependency farm: a directory, but never a profile.
  mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
  const result = run(['--dsh'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /no profile directory under/)
  assert.match(result.stdout, /entries present: boom, odd/)
  assert.match(result.stdout, /--dsh-profile <name>/)
  assert.match(result.stdout, /- id: my-workbench-lanes-ui/)
  for (const name of ['boom', 'odd']) {
    assert.equal(existsSync(patchOf(name)), false, `${name} is left without a patch layer`)
  }
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
