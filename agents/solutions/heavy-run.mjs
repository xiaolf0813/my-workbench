// User-level mutex for memory-heavy commands: one machine-wide run at a time,
// FIFO waiting across sessions, projects, and backends.
//   node heavy-run.mjs run [--root DIR] [--wait SECONDS] -- <command words...>
//   node heavy-run.mjs status [--root DIR]
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_WAIT_SECONDS = 900;
// Poll cadence while waiting; tests shrink it through this env var.
const pollMs = Math.max(25, Number(process.env.MY_WORKBENCH_HEAVY_POLL_MS) || 2000);
// A waiting process touches its ticket every poll, so a ticket untouched this
// long is abandoned — a heartbeat the pid table cannot fake (Windows reuses
// pids; a reused pid cannot fake a fresh mtime).
const STALE_TICKET_MS = Math.max(15000, pollMs * 10);

function parseOptions(argv) {
  const [command, ...rest] = argv;
  const split = rest.indexOf('--');
  const flags = split === -1 ? rest : rest.slice(0, split);
  const words = split === -1 ? [] : rest.slice(split + 1);
  const options = { command, words, root: undefined, wait: DEFAULT_WAIT_SECONDS };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--root') options.root = flags[++i];
    else if (flags[i] === '--wait') options.wait = Number(flags[++i]);
    else throw Error(`Unknown option: ${flags[i]}`);
  }
  if (command === 'run') {
    if (!words.length) throw Error('Expected a command after --');
    if (!Number.isFinite(options.wait) || options.wait < 0) throw Error('--wait expects non-negative seconds');
  } else if (command !== 'status') {
    throw Error('Expected run|status as the first argument');
  }
  return options;
}

function paths(root) {
  return { lock: join(root, 'lock'), holder: join(root, 'lock', 'holder.json'), queue: join(root, 'queue') };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, just not ours to signal
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function queueEntries(queueDir) {
  try {
    return readdirSync(queueDir).sort().map(name => ({ name, ticket: readJson(join(queueDir, name)) }));
  } catch {
    return [];
  }
}

function writeHolder(holderFile, words, childPid = null) {
  const holder = { pid: process.pid, childPid, command: words.join(' '), cwd: process.cwd(), startedAt: new Date().toISOString() };
  writeFileSync(holderFile, `${JSON.stringify(holder)}\n`);
}

function tryAcquire(lockDir, holderFile, words) {
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  writeHolder(holderFile, words); // childPid is filled in once the child exists
  return true;
}

// Only the head of the queue steals. A lock is stale when neither the wrapper
// nor its child is alive: a wrapper killed while its child still builds
// (childPid alive) is NOT stale — two concurrent heavy runs are exactly the
// failure this tool exists to prevent, so we would rather keep waiting. On
// Windows an orphaned grandchild under the cmd shell can outlive both pids;
// that leak is accepted rather than risked as a double build.
function holderStale(lockDir, holderFile) {
  try {
    const holder = readJson(holderFile);
    // Crashed between mkdir and the holder write: give the creator a grace
    // window measured by the same heartbeat clock, then take over.
    if (holder === null) return Date.now() - statSync(lockDir).mtimeMs > STALE_TICKET_MS;
    return !alive(holder.pid) && !alive(holder.childPid);
  } catch {
    return false; // the lock vanished mid-check; contend again on the next pass
  }
}

// Drop tickets of processes that stopped waiting: a dead pid, or a ticket left
// untouched past the grace period.
function pruneQueue(queueDir, keepName) {
  for (const { name, ticket } of queueEntries(queueDir)) {
    if (name === keepName) continue;
    try {
      const stale = Date.now() - statSync(join(queueDir, name)).mtimeMs > STALE_TICKET_MS;
      if (stale || (ticket !== null && !alive(ticket.pid))) rmSync(join(queueDir, name), { force: true });
    } catch { /* raced with another pruner or the ticket's writer */ }
  }
}

function ageOf(iso) {
  return `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))}s`;
}

function announceWait(holderFile, entries, ticketName) {
  const holder = readJson(holderFile);
  const running = holder ? `"${holder.command}" (pid ${holder.pid}, started ${ageOf(holder.startedAt)} ago)` : 'an unnamed holder';
  const position = entries.findIndex(entry => entry.name === ticketName) + 1;
  process.stderr.write(`heavy-run: waiting for ${running}; queue position ${position} of ${entries.length}\n`);
}

async function runCommand(words, root, waitSeconds) {
  const { lock, holder: holderFile, queue: queueDir } = paths(root);
  mkdirSync(queueDir, { recursive: true });

  // Fast path: no holder and no waiters → claim directly, no ticket churn.
  // Checking the queue first keeps a fresh arrival from jumping past waiters
  // parked in the release-to-poll window.
  if (!existsSync(lock) && readdirSync(queueDir).length === 0 && tryAcquire(lock, holderFile, words)) {
    return execute(words, lock, holderFile);
  }

  const ticketName = `${String(Date.now()).padStart(15, '0')}-${randomUUID()}.json`;
  const ticket = join(queueDir, ticketName);
  writeFileSync(ticket, `${JSON.stringify({ pid: process.pid, command: words.join(' '), queuedAt: new Date().toISOString() })}\n`);
  const deadline = Date.now() + waitSeconds * 1000;
  let lastAnnouncedHolder;
  try {
    for (;;) {
      utimesSync(ticket, new Date(), new Date()); // heartbeat: mtime proves this waiter still waits
      pruneQueue(queueDir, ticketName);
      const entries = queueEntries(queueDir);
      // Only the head ever acquires, so arrivals cannot jump the queue; the
      // same-millisecond tie between two fresh tickets is broken by uuid and
      // bounded — no starvation.
      if (entries.length === 0 || entries[0].name === ticketName) {
        if (!existsSync(lock)) {
          if (tryAcquire(lock, holderFile, words)) {
            rmSync(ticket, { force: true });
            return execute(words, lock, holderFile);
          }
        } else if (holderStale(lock, holderFile)) {
          process.stderr.write(`heavy-run: taking over the stale lock at ${lock}\n`);
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      }
      const holder = readJson(holderFile);
      if (holder?.pid !== lastAnnouncedHolder) {
        lastAnnouncedHolder = holder?.pid;
        announceWait(holderFile, entries, ticketName);
      }
      if (Date.now() >= deadline) {
        const running = holder ? `"${holder.command}" (pid ${holder.pid})` : 'an unnamed holder';
        process.stderr.write(`heavy-run: gave up after ${waitSeconds}s waiting for ${running}; ${entries.length} still queued.\nIf nothing heavy is running, remove ${lock} and retry.\n`);
        return 124;
      }
      await delay(pollMs);
    }
  } finally {
    rmSync(ticket, { force: true });
  }
}

async function execute(words, lockDir, holderFile) {
  // Crash safety: dying while holding the lock would wedge every later
  // session, so every exit path removes it.
  process.on('exit', () => rmSync(lockDir, { recursive: true, force: true }));
  let child;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (child?.pid != null && child.exitCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        else child.kill('SIGTERM');
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  try {
    try {
      child = spawn(words[0], words.slice(1), { stdio: 'inherit' });
    } catch (error) {
      // npm & friends ship as .cmd shims Node refuses to spawn directly on
      // Windows; the shell fallback covers exactly that case.
      if (error.code !== 'EINVAL' || process.platform !== 'win32') throw error;
      child = spawn(words.join(' '), { shell: true, stdio: 'inherit' });
    }
    if (child.pid != null) writeHolder(holderFile, words, child.pid);
    return await new Promise((resolveExit, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolveExit(signal ? 128 : code));
    });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function statusOf(root) {
  const { lock, holder: holderFile, queue: queueDir } = paths(root);
  return {
    root,
    holder: readJson(holderFile),
    queue: queueEntries(queueDir)
      .filter(entry => entry.ticket !== null)
      .map(({ name, ticket }) => ({ pid: ticket.pid, command: ticket.command, queuedAt: ticket.queuedAt, file: name })),
    lockPath: lock,
  };
}

try {
  const options = parseOptions(process.argv.slice(2));
  const root = resolve(options.root ?? join(homedir(), '.my-workbench', 'heavy-run'));
  if (options.command === 'status') console.log(JSON.stringify(statusOf(root)));
  else process.exitCode = (await runCommand(options.words, root, options.wait)) ?? 1;
} catch (error) {
  console.error(`heavy-run: ${error.message}`);
  process.exitCode = 1;
}
