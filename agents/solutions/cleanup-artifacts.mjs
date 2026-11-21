// Run after writing acceptance captures. Performs one LRU retention pass over the artifact store.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

// Sizes are binary megabytes: 1 MB = 1024 * 1024 bytes.
const MB = 1024 * 1024;
const fold = process.platform === 'win32' ? text => text.toLowerCase() : text => text;

function parseArgs(argv) {
  const options = { excludes: [], dryRun: false };
  const number = text => {
    const size = Number(text);
    if (!Number.isFinite(size) || size < 0) throw Error(`Expected a non-negative number, got "${text}"`);
    return size;
  };
  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      if (i + 1 >= argv.length) throw Error(`Missing value for ${argv[i]}`);
      const next = argv[++i];
      if (!String(next).trim()) throw Error(`Expected a value for ${argv[i - 1]}`);
      return next;
    };
    if (argv[i] === '--root') options.root = value();
    else if (argv[i] === '--max-mb') options.maxMb = number(value());
    else if (argv[i] === '--claim-hours') options.claimHours = number(value());
    else if (argv[i] === '--mark-delivered') options.markDelivered = value();
    else if (argv[i] === '--present') (options.presents ??= []).push(value());
    else if (argv[i] === '--done-presenting') (options.donePresenting ??= []).push(value());
    else if (argv[i] === '--exclude') options.excludes.push(value());
    else if (argv[i] === '--dry-run') options.dryRun = true;
    else throw Error(`Unknown option ${argv[i]}`);
  }
  return options;
}

// Expand a bare home prefix so quoted "~"-form arguments still resolve.
const expandTilde = candidate => candidate === '~' || candidate.startsWith(`~${sep}`) || candidate.startsWith('~/')
  ? join(homedir(), candidate.slice(1)) : candidate;

function normalize(candidate) {
  const expanded = expandTilde(candidate);
  try {
    // The native realpath also expands 8.3 short names and canonicalizes case on win32.
    return (process.platform === 'win32' ? realpathSync.native : realpathSync)(expanded);
  } catch {
    return resolve(expanded);
  }
}

const same = (a, b) => fold(a) === fold(b);
const under = (child, parent) => fold(child).startsWith(fold(parent) + sep);

function runDirectoryUnder(given, root) {
  // Judge the entry as given before canonicalizing: a link submitted in place of a run
  // directory is rejected even when it points at a real run inside the store.
  let entry;
  try {
    entry = lstatSync(given);
  } catch {
    throw Error(`Expected an existing run directory: ${given}`);
  }
  if (!entry.isDirectory()) throw Error(`Expected a real run directory, not a link or a file: ${given}`);
  const target = normalize(given);
  if (same(target, root) || !under(target, root)) throw Error(`Expected a run directory inside the artifact store: ${target}`);
  if (dirname(target) !== root) throw Error(`Expected a direct run directory of the artifact store, not a nested path: ${target}`);
  return target;
}

// Store-level mutual exclusion so claiming, releasing, marking, and a real cleanup pass
// have one consistent order: a claim that lands before the pass scans is always honored,
// and claiming a run a finished pass has already evicted fails explicitly.
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

function withStoreLock(root, action) {
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, '.cleanup.lock');
  const owner = randomUUID();
  const lockRecord = JSON.stringify({ owner, pid: process.pid });
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(lockPath, lockRecord, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        let holder = null;
        try {
          holder = JSON.parse(readFileSync(lockPath, 'utf8'));
        } catch {
          // Older and interrupted writers may leave an opaque lock. Its age is the only signal.
        }
        const identifiedHolder = typeof holder?.owner === 'string'
          && holder.owner.length > 0 && Number.isSafeInteger(holder.pid) && holder.pid > 0;
        let holderAlive = false;
        if (identifiedHolder) {
          try {
            process.kill(holder.pid, 0);
            holderAlive = true;
          } catch (processError) {
            holderAlive = processError.code !== 'ESRCH';
          }
        }
        const abandoned = identifiedHolder ? !holderAlive : age > LOCK_STALE_MS;
        if (abandoned) {
          // Rename is the ownership transfer: only one contender can move this exact lock,
          // and deleting the tombstone can never remove a newer holder's file.
          const tombstone = `${lockPath}.stale.${owner}`;
          renameSync(lockPath, tombstone);
          rmSync(tombstone, { force: true });
          continue;
        }
      } catch {
        // The lock vanished between the failed create and the stat: retry immediately.
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw Error(`Timed out waiting for the store lock: ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return action();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === lockRecord) rmSync(lockPath, { force: true });
    } catch {
      // A stolen or already removed lock needs no release.
    }
  }
}

function measureUnit(unitPath, entry) {
  let bytes = 0;
  let recency = null;
  const visit = (path, entry) => {
    if (entry.isDirectory()) {
      for (const nested of readdirSync(path, { withFileTypes: true })) visit(join(path, nested.name), nested);
      return;
    }
    // The delivery marker carries no bytes and no recency.
    if (entry.name === '.delivered') return;
    // Symlinks are never followed: a linked directory counts 0 and is never traversed.
    const stats = entry.isSymbolicLink() ? lstatSync(path) : statSync(path);
    if (!entry.isSymbolicLink()) bytes += stats.size;
    // Recency is the latest of modified and accessed: reading a capture keeps it hot.
    recency = Math.max(recency ?? -Infinity, stats.mtimeMs, stats.atimeMs);
  };
  visit(unitPath, entry);
  // A unit holding no files is as old as the unit entry itself.
  return { bytes, recency: recency ?? statSync(unitPath).mtimeMs };
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const root = normalize(options.root ?? join(homedir(), '.my-workbench', 'artifacts'));
  if (same(root, normalize(homedir()))) throw Error(`Refusing to operate on the home directory itself: ${root}`);
  if (same(root, parse(root).root)) throw Error(`Refusing to operate on the filesystem root: ${root}`);
  if (existsSync(root) && !statSync(root).isDirectory()) throw Error(`Artifact store is not a directory: ${root}`);
  if (options.markDelivered) {
    const markDelivered = () => {
      const target = runDirectoryUnder(expandTilde(options.markDelivered), root);
      const marker = join(target, '.delivered');
      if (existsSync(marker)) return { marked: target, already: true, dryRun: options.dryRun };
      if (options.dryRun) return { marked: target, dryRun: true };
      writeFileSync(marker, '', { flag: 'wx' });
      return { marked: target };
    };
    return options.dryRun ? markDelivered() : withStoreLock(root, markDelivered);
  }
  if (options.presents?.length) {
    const present = () => {
      // Validate the whole batch before writing anything.
      const targets = options.presents.map(given => runDirectoryUnder(expandTilde(given), root));
      if (options.dryRun) return { presenting: targets, tokens: [], dryRun: true };
      const claimsDir = join(root, '.claims');
      mkdirSync(claimsDir, { recursive: true });
      const presenting = [];
      const tokens = [];
      const written = [];
      try {
        for (const target of targets) {
          const token = randomUUID();
          const claimPath = join(claimsDir, `${basename(target)}.${token}`);
          writeFileSync(claimPath, '', { flag: 'wx' });
          written.push(claimPath);
          presenting.push(target);
          tokens.push(token);
        }
      } catch (error) {
        // A partially written batch leaves nothing behind the caller cannot release.
        for (const claimPath of written) rmSync(claimPath, { force: true });
        throw error;
      }
      return { presenting, tokens, dryRun: false };
    };
    return options.dryRun ? present() : withStoreLock(root, present);
  }
  if (options.donePresenting?.length) {
    const release = () => {
      const claimsDir = join(root, '.claims');
      const released = [];
      if (existsSync(claimsDir)) {
        for (const token of options.donePresenting) {
          for (const name of readdirSync(claimsDir)) {
            if (name.endsWith(`.${token}`)) {
              if (!options.dryRun) rmSync(join(claimsDir, name), { force: true });
              released.push(name);
            }
          }
        }
      }
      return { released, dryRun: options.dryRun };
    };
    if (!existsSync(root) || options.dryRun) return release();
    return withStoreLock(root, release);
  }
  const maxBytes = (options.maxMb ?? 200) * MB;
  if (options.dryRun && !existsSync(root)) {
    // A rehearsal must not materialize the store.
    return { root, beforeBytes: 0, afterBytes: 0, maxBytes, pendingBytes: 0, claimedBytes: 0, deleted: [], dryRun: true, targetMet: true, failures: [] };
  }
  const pass = dryRun => {
    const excludes = options.excludes.map(normalize);
    mkdirSync(root, { recursive: true });
    // Live presentation claims are shared store state: every cleanup invocation spares
    // claimed runs, so a concurrent delivery cannot evict evidence another task is about
    // to show. Claims expire after the window so a crashed presenter cannot lock forever.
    const claimMs = (options.claimHours ?? 24) * 60 * 60 * 1000;
    const claimsDir = join(root, '.claims');
    const claimedUnits = new Set();
    if (existsSync(claimsDir)) {
      const now = Date.now();
      for (const name of readdirSync(claimsDir)) {
        const path = join(claimsDir, name);
        let mtimeMs;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch (error) {
          // A dry-run does not hold the store lock, so a release can remove a listed claim.
          if (error.code === 'ENOENT') continue;
          throw Error(`Cannot inspect presentation claim ${path}: ${error.message}`);
        }
        const dot = name.lastIndexOf('.');
        const unit = dot > 0 ? name.slice(0, dot) : '';
        const stale = claimMs <= 0 || now - mtimeMs >= claimMs || !existsSync(join(root, unit));
        if (stale) {
          if (!dryRun) rmSync(path, { force: true });
          continue;
        }
        claimedUnits.add(unit);
      }
    }
    const failures = [];
    let unknownBytes = false;
    const units = readdirSync(root, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.')) // dot-entries are store metadata (claims, lock), not runs
      .map(entry => {
        const path = join(root, entry.name);
        let measured;
        try {
          measured = measureUnit(path, entry);
        } catch (error) {
          // An unmeasurable unit stays put: its size is unknown, so it is never evicted or counted.
          failures.push({ path, error: error.message });
          unknownBytes = true;
          return null;
        }
        const excluded = excludes.some(exclude => same(path, exclude) || under(path, exclude));
        // Undelivered evidence stays: a run directory without a .delivered marker is pending and
        // is never evicted, whatever its age - only a delivery mark re-admits it to the LRU.
        const pending = !existsSync(join(path, '.delivered'));
        const claimed = claimedUnits.has(entry.name);
        const protectedUnit = excluded || pending || claimed;
        return { path, name: entry.name, ...measured, excluded, pending, claimed, protectedUnit };
      }).filter(unit => unit !== null);
    const beforeBytes = units.reduce((sum, unit) => sum + unit.bytes, 0);
    const pendingBytes = units.filter(unit => unit.pending).reduce((sum, unit) => sum + unit.bytes, 0);
    const claimedBytes = units.filter(unit => unit.claimed).reduce((sum, unit) => sum + unit.bytes, 0);
    const deleted = [];
    let total = beforeBytes;
    if (total > maxBytes) {
      const evictable = units.filter(unit => !unit.protectedUnit)
        .sort((a, b) => a.recency - b.recency || (a.name < b.name ? -1 : 1));
      for (const unit of evictable) {
        if (total <= maxBytes) break;
        if (!under(unit.path, root)) {
          failures.push({ path: unit.path, error: 'resolved outside the store root' });
          continue;
        }
        if (!dryRun) {
          try {
            rmSync(unit.path, { recursive: true, force: true });
          } catch (error) {
            failures.push({ path: unit.path, error: error.message });
            continue;
          }
        }
        total -= unit.bytes;
        deleted.push({ path: unit.path, bytes: unit.bytes });
      }
    }
    return {
      root,
      beforeBytes,
      afterBytes: total,
      maxBytes,
      pendingBytes,
      claimedBytes,
      deleted,
      dryRun,
      // With any unit unmeasured the real total is unknown, so the target cannot be claimed met.
      targetMet: !unknownBytes && total <= maxBytes,
      failures,
    };
  };
  if (options.dryRun) return pass(true);
  return withStoreLock(root, () => pass(false));
}

try {
  console.log(JSON.stringify(run()));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
