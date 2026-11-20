/**
 * DSH installation discovery and version gating for `my-workbench --dsh`.
 *
 * The DSH target writes preset declarations that reference harness packages by
 * name, so it only works inside a DSH runtime whose contracts it was written
 * for. DSH releases before 0.2.1-rc.2 read presets from a `.agent-presets/`
 * directory (a format that version then deleted) and take the nested
 * `startActivation` request; 0.3 may change either again. This module finds the
 * installations a machine can actually launch and answers whether they are in
 * the supported window, so a mismatch is a clear error instead of a preset that
 * silently never appears.
 *
 * Zero dependencies, like the rest of this CLI.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

/**
 * Supported DSH runtime: `>= 0.2.1-rc.2 < 0.3.0`.
 *
 * The floor is the release that renamed the preset package and removed the
 * `.agent-presets/` reader while still taking the nested activation request
 * (the lane plugin supports both shapes); the ceiling guards the next contract
 * break.
 */
export const DSH_VERSION_RANGE = { min: "0.2.1-rc.2", max: "0.3.0" };

/** Parse `x.y.z[-pre]`; undefined when the string is not a version. */
export function parseDshVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version).trim());
  if (match === null) return undefined;
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** Compare two prerelease identifiers per semver: numeric sorts below alphanumeric. */
function comparePreIdentifier(a, b) {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two DSH versions: negative when `a` is older, 0 when equal, positive
 * when `a` is newer. A release compares above its own prereleases. Unparsable
 * input throws — a version gate must never guess.
 */
export function compareDshVersions(a, b) {
  const left = parseDshVersion(a);
  const right = parseDshVersion(b);
  if (left === undefined || right === undefined) {
    throw new Error(`cannot compare DSH versions ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
  for (let index = 0; index < 3; index++) {
    if (left.main[index] !== right.main[index]) return left.main[index] - right.main[index];
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === 0 ? (right.pre.length === 0 ? 0 : 1) : -1;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index++) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const order = comparePreIdentifier(left.pre[index], right.pre[index]);
    if (order !== 0) return order;
  }
  return 0;
}

/** Whether one version string is inside the window; unparsable is out. */
export function dshVersionInRange(version, range = DSH_VERSION_RANGE) {
  const parsed = parseDshVersion(version);
  if (parsed === undefined) return false;
  if (compareDshVersions(version, range.min) < 0) return false;
  // The ceiling is a release to stop BEFORE, not a version to compare against:
  // a prerelease of 0.3.0 must not slip in through semver's prerelease ordering
  // when the next contract is exactly what this gate is guarding against.
  const ceiling = parseDshVersion(range.max);
  if (ceiling === undefined) throw new Error(`invalid DSH version ceiling ${JSON.stringify(range.max)}`);
  for (let index = 0; index < 3; index++) {
    if (parsed.main[index] !== ceiling.main[index]) return parsed.main[index] < ceiling.main[index];
  }
  return false;
}

/** Read the version from one `@deepseek-ai/dsh` package directory, or undefined. */
function readDshPackage(dir) {
  if (dir === undefined || dir === "") return undefined;
  const manifestPath = join(dir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== "object" || manifest.name !== "@deepseek-ai/dsh" || typeof manifest.version !== "string") return undefined;
  return { dir: resolve(dir), version: manifest.version };
}

/**
 * Directories of every `dsh` launcher on PATH, as candidate package roots.
 *
 * npm shims sit beside `node_modules`, and Unix symlinks point into a package
 * tree; both shapes are covered without running the launcher.
 */
function launcherPackageDirs(pathEnv) {
  const dirs = [];
  const seen = new Set();
  const push = (dir) => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push(resolved);
  };
  for (const entry of pathEnv.split(delimiter)) {
    if (entry === "") continue;
    for (const name of ["dsh", "dsh.cmd", "dsh.exe", "dsh.ps1"]) {
      const launcher = join(entry, name);
      if (!existsSync(launcher)) continue;
      push(join(entry, "node_modules", "@deepseek-ai", "dsh"));
      let real = launcher;
      try {
        real = realpathSync(launcher);
      } catch {
        // an unreadable launcher still leaves the sibling candidate above
      }
      let current = dirname(real);
      for (;;) {
        // A launcher inside the package tree (a Unix symlink target) names its
        // package directory on an ancestor path.
        if (basename(current) === "dsh" && basename(dirname(current)) === "@deepseek-ai") {
          push(current);
          break;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  return dirs;
}

/**
 * Every DSH installation this machine can plausibly launch.
 *
 * Sources, in reporting order: the running process's `DSH_INSTALL_DIR` (set
 * when this CLI runs inside a DSH session), each `dsh` launcher on PATH, and the
 * profile module farm a DSH home keeps under `<home>/profiles/node_modules`.
 *
 * An installation whose manifest cannot be read is reported with an `undefined`
 * version instead of being dropped. A packaged Desktop install lives inside
 * `app.asar`, which plain Node cannot traverse, and silently forgetting it would
 * let an older launcher on PATH cause a false refusal.
 *
 * @param {string} home - the DSH home.
 * @param {{ pathEnv?: string, installDir?: string, profilesDir?: string }} [options] - test seams.
 * @returns {{ source: string, dir: string, version: string | undefined }[]} unique installations.
 */
export function findDshInstallations(home, options = {}) {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const installDir = options.installDir ?? process.env.DSH_INSTALL_DIR;
  const profilesDir = options.profilesDir ?? join(home, "profiles");
  const found = [];
  const seen = new Set();
  const add = (source, dir, { unreadable = false } = {}) => {
    const entry = readDshPackage(dir);
    if (entry === undefined) {
      if (!unreadable || dir === undefined || dir === "") return;
      const resolved = resolve(dir);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      found.push({ source, dir: resolved, version: undefined });
      return;
    }
    if (seen.has(entry.dir)) return;
    seen.add(entry.dir);
    found.push({ source, ...entry });
  };
  // Only the explicitly supplied install may be unreadable-but-real: launcher
  // and farm candidates are guesses, and reporting every failed guess as an
  // installation would make the report noise.
  add("DSH_INSTALL_DIR", installDir, { unreadable: true });
  for (const dir of launcherPackageDirs(pathEnv)) add("a dsh launcher on PATH", dir);
  add("the profile module farm", join(profilesDir, "node_modules", "@deepseek-ai", "dsh"));
  return found;
}

/** One human-readable line per installation: version, source, directory. */
export function describeDshInstallations(installations) {
  return installations.map((entry) => `${entry.version === undefined ? "unknown version" : entry.version} (${entry.source}: ${entry.dir})`);
}

/**
 * Decide whether the detected installations are acceptable.
 *
 * The gate refuses only on proof: when every readable installation is out of
 * window AND no unreadable one exists. An unreadable installation downgrades a
 * refusal to a warning, because it may be the supported runtime.
 *
 * @param {{ source: string, dir: string, version: string | undefined }[]} installations - detected installs.
 * @param {{ min: string, max: string }} [range] - supported window.
 * @returns {{ problem?: string, warning?: string }} a blocking problem, a non-blocking warning, or neither.
 */
export function dshVersionReport(installations, range = DSH_VERSION_RANGE) {
  const window = `>= ${range.min} < ${range.max}`;
  if (installations.length === 0) {
    return {
      warning:
        `could not find a DSH installation to read a version from; my-workbench --dsh supports DSH ${window}. ` +
        "Set DSH_INSTALL_DIR (or put a `dsh` launcher on PATH) so the version can be checked.",
    };
  }
  const supported = installations.filter((entry) => entry.version !== undefined && dshVersionInRange(entry.version, range));
  if (supported.length === 0) {
    const unreadable = installations.filter((entry) => entry.version === undefined);
    if (unreadable.length > 0) {
      return {
        warning:
          `no readable DSH installation is inside the supported window ${window}: ` +
          describeDshInstallations(installations).join("; ") +
          ". Installing anyway; verify that the runtime you launch is supported.",
      };
    }
    return {
      problem:
        `no detected DSH installation is supported: my-workbench --dsh targets DSH ${window}, but found ` +
        describeDshInstallations(installations).join("; ") +
        ". Upgrade DSH (or run this CLI from a supported installation) and retry.",
    };
  }
  const unsupported = installations.filter((entry) => entry.version !== undefined && !dshVersionInRange(entry.version, range));
  const unreadable = installations.filter((entry) => entry.version === undefined);
  const notes = [];
  if (unsupported.length > 0) {
    notes.push(
      `these detected DSH installations are outside the supported window ${window} and will not read the installed presets: ` +
        describeDshInstallations(unsupported).join("; "),
    );
  }
  if (unreadable.length > 0) {
    const where = unreadable.map((entry) => `${entry.source}: ${entry.dir}`).join("; ");
    notes.push(`the version at ${where} could not be read (a packaged app's app.asar cannot be read by Node)`);
  }
  if (notes.length === 0) return {};
  return { warning: `${notes.join("; ")}; supported: ${describeDshInstallations(supported).join("; ")}` };
}
