import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  accessSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getModelConfiguration, PROFILE_NAMES, type ModelConfiguration } from "./model-profile-service.js";
import { PathResolver } from "../infrastructure/path-resolver.js";
import { assertSshTrustPathsUnambiguous, normalizeSshTrustConfigLine, runPasswordSsh } from "./password-ssh-transport.js";
import type { SshServer } from "./ssh-server-store.js";

const PLUGIN_NAME = "subagent-config";
const MARKETPLACE_NAME = "my-workbench";
const MAX_OUTPUT_BYTES = 32 * 1024;
const SSH_TARGET_PATTERN = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])$/;

export type SshSyncTarget = SshServer;

type RemoteInfo = {
  home: string;
  nodeVersion: string;
  codexVersion: string;
};

type ProcessResult = { stdout: string; stderr: string };

function validateTarget(input: SshSyncTarget): void {
  if (!SSH_TARGET_PATTERN.test(input.target) || input.target.length > 255 || input.target.startsWith("-")) {
    throw new Error("Enter an SSH host alias or user@host using letters, numbers, dots, underscores, or hyphens.");
  }
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    throw new Error("SSH port must be an integer from 1 to 65535.");
  }
  if (input.codexHome !== undefined && (input.codexHome.length > 1024 || /[\r\n\0]/.test(input.codexHome))) {
    throw new Error("Remote CODEX_HOME is too long or contains invalid characters.");
  }
  if (input.authentication === "key-file" && (!input.keyFilePath || /[\r\n\0]/.test(input.keyFilePath))) {
    throw new Error("Choose a valid private key file path.");
  }
}

function sshEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "ProgramData",
    "SystemRoot",
    "WINDIR",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "LANG",
    "LC_ALL",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function runProcess(
  command: string,
  args: string[],
  options: { input?: Buffer; timeoutMs?: number; mutatingSsh?: boolean } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: sshEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;

    const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = MAX_OUTPUT_BYTES - current;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      return current + Math.min(chunk.length, Math.max(remaining, 0));
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutSize = collect(stdout, chunk, stdoutSize); });
    child.stderr.on("data", (chunk: Buffer) => { stderrSize = collect(stderr, chunk, stderrSize); });

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(options.mutatingSsh ? "The SSH connection ended before sync status was confirmed. It may have partially completed; inspect the remote plugin and recovery copies before retrying." : `${command} timed out.`));
    }, timeoutMs);

    function finish(error?: Error, result?: ProcessResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    }

    child.once("error", () => {
      finish(new Error(`${command} could not start.`));
    });
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === "EPIPE" ? "The SSH process closed before receiving the complete request." : "The SSH input stream failed."));
    });
    child.once("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) finish(undefined, result);
      else {
        const detail = result.stderr.toLowerCase();
        const knownRemoteOutcome = /remote_(?:node|codex|tar|flock|cmp)_missing|sync_partial|rollback_failed|plugin_install_unverified|profile_changed_during_sync|profile_lock_busy|another subagent config sync/.test(detail);
        const connectionLost = /connection (?:reset|closed|aborted)|broken pipe|lost connection|software caused connection abort|connection timed out|no route to host/.test(detail);
        if (options.mutatingSsh && !knownRemoteOutcome && (signal !== null || connectionLost || (code === 255 && !/permission denied|authentication failed|host key verification failed|could not resolve|name or service not known/.test(detail)))) {
          finish(new Error("The SSH connection ended before sync status was confirmed. It may have partially completed; inspect the remote plugin and recovery copies before retrying."));
        } else finish(new Error(processFailure(command, code, result.stderr)));
      }
    });

    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function processFailure(command: string, code: number | null, stderr: string): string {
  const detail = stderr.toLowerCase();
  if (command === "ssh") {
    if (detail.includes("remote_node_missing")) return "Remote Node.js is not installed or is unavailable on PATH.";
    if (detail.includes("remote_codex_missing")) return "The remote Codex CLI is not installed or is unavailable on PATH.";
    if (detail.includes("remote_tar_missing")) return "The remote host needs tar to receive the plugin package.";
    if (detail.includes("remote_flock_missing")) return "The remote host needs flock (util-linux) to protect concurrent syncs.";
    if (detail.includes("remote_cmp_missing")) return "The remote host needs cmp to verify rollback safely.";
    if (detail.includes("sync_partial")) return "Remote Codex may have changed plugin registration, but sync did not complete. New files and recovery backups were retained for inspection.";
    if (detail.includes("rollback_failed")) return "The sync failed and automatic rollback was incomplete. Recovery copies were retained in the remote CODEX_HOME.";
    if (detail.includes("plugin_install_unverified")) return "Codex did not confirm that the requested plugin version is installed and enabled.";
    if (detail.includes("profile_changed_during_sync")) return "The remote MyWorkbench profile changed during sync. The new profile was left untouched; inspect the retained recovery copies before retrying.";
    if (detail.includes("profile_lock_busy")) return "The remote MyWorkbench profile is busy in another operation. Wait for it to finish, then retry.";
    if (detail.includes("ssh_remote_status_unconfirmed")) return "The SSH connection ended before sync status was confirmed. It may have partially completed; inspect the remote plugin and recovery copies before retrying.";
    if (detail.includes("another subagent config sync") || detail.includes("remote_sync_locked")) return "Another Subagent Config sync is already running for this CODEX_HOME.";
    if (/permission denied|authentication failed|host key verification failed/.test(detail)) {
      return "SSH authentication or host verification failed. Check the SSH alias, key agent, and known-hosts entry.";
    }
    if (/could not resolve|name or service not known|temporary failure in name resolution/.test(detail)) {
      return "The SSH host could not be resolved. Check the host alias and SSH configuration.";
    }
    if (/connection timed out|connection refused|no route to host/.test(detail)) {
      return "SSH could not connect to the target. Check its address, port, and network availability.";
    }
    return detail
      ? "SSH failed with an unrecognized diagnostic. Check the SSH configuration and remote command environment."
      : "SSH exited without diagnostic output. Check the local and system OpenSSH configuration.";
  }
  return `${command} exited with status ${code ?? "unknown"}.`;
}

function sshArgs(target: SshSyncTarget, remoteCommand: string): { args: string[]; temporaryConfigDirectory?: string } {
  let temporaryConfigDirectory: string | undefined;
  if (target.authentication === "key-file") {
    const resolved = spawnSync("ssh", ["-G", ...(target.port ? ["-p", String(target.port)] : []), target.target], {
      encoding: "utf8", windowsHide: true, timeout: 10_000, env: sshEnvironment(),
    });
    if (resolved.error || resolved.status !== 0) throw new Error("The local SSH configuration could not resolve this host.");
    assertSshTrustPathsUnambiguous(resolved.stdout);
    const configValues = new Map<string, string>();
    for (const line of resolved.stdout.split(/\r?\n/)) {
      const split = line.indexOf(" ");
      if (split > 0) configValues.set(line.slice(0, split).toLowerCase(), line.slice(split + 1).trim());
    }
    if (["proxyjump", "proxycommand", "knownhostscommand"].some((name) => configValues.get(name) && configValues.get(name) !== "none")) {
      throw new Error("Private key file authentication requires direct SSH without ProxyJump, ProxyCommand, or KnownHostsCommand.");
    }
    if (["no", "false"].includes((configValues.get("pubkeyauthentication") ?? "").toLowerCase())) throw new Error("The SSH configuration disables public-key authentication for this host.");
    const host = configValues.get("hostname");
    const username = configValues.get("user");
    const resolvedPort = Number(configValues.get("port"));
    if (!host || !/^[A-Za-z0-9._:-]+$/.test(host.replace(/^\[|\]$/g, "")) || !username || !/^[A-Za-z0-9._-]+$/.test(username)
      || !Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
      throw new Error("The local SSH configuration did not provide a valid host, username, and port.");
    }
    const keyPath = target.keyFilePath?.startsWith("~") ? path.join(os.homedir(), target.keyFilePath.slice(2).replace(/^[/\\]/, "")) : target.keyFilePath;
    if (!keyPath) throw new Error("Choose a private key file.");
    try {
      if (!statSync(keyPath).isFile()) throw new Error();
      accessSync(keyPath);
    } catch { throw new Error("The selected private key file does not exist or cannot be read."); }
    const safeOptions = new Set([
      "hostname", "user", "port", "hostkeyalias", "userknownhostsfile", "globalknownhostsfile", "revokedhostkeys",
      "hostkeyalgorithms", "hostbasedacceptedalgorithms", "casignaturealgorithms", "requiredrsasize", "stricthostkeychecking",
      "checkhostip", "verifyhostkeydns", "updatehostkeys", "addressfamily", "bindaddress", "bindinterface",
      "canonicalizehostname", "canonicaldomains", "canonicalizefallbacklocal", "canonicalizepermittedcnames", "canonicalizemaxdots",
      "ciphers", "macs", "kexalgorithms", "connecttimeout", "serveraliveinterval", "serveralivecountmax", "tcpkeepalive", "ipqos", "compression", "rekeylimit", "loglevel",
      "preferredauthentications", "pubkeyauthentication", "pubkeyacceptedalgorithms", "passwordauthentication", "kbdinteractiveauthentication", "challengeresponseauthentication",
    ]);
    const effectiveConfig = resolved.stdout.split(/\r?\n/).flatMap((line) => {
      const split = line.indexOf(" ");
      if (split <= 0) return [];
      const name = line.slice(0, split).toLowerCase();
      const value = line.slice(split + 1).trim();
      if (["userknownhostsfile", "globalknownhostsfile", "revokedhostkeys"].includes(name)) return [normalizeSshTrustConfigLine(name, value)];
      return safeOptions.has(name) && !["host", "identityfile", "certificatefile"].includes(name) ? [line] : [];
    });
    temporaryConfigDirectory = mkdtempSync(path.join(os.tmpdir(), "subagent-ssh-config-"));
    try { writeFileSync(path.join(temporaryConfigDirectory, "config"), `Host *\n${effectiveConfig.join("\n")}\nIdentityFile none\nCertificateFile none\n`, { mode: 0o600, flag: "wx" }); }
    catch (error) { rmSync(temporaryConfigDirectory, { recursive: true, force: true }); throw error; }
  }
  const args = [
    ...(temporaryConfigDirectory ? ["-F", path.join(temporaryConfigDirectory, "config")] : []),
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ForwardAgent=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    ...(target.authentication === "key-file" && target.keyFilePath
      ? ["-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "IdentityFile=none", "-o", "CertificateFile=none", "-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-i", target.keyFilePath.startsWith("~") ? path.join(os.homedir(), target.keyFilePath.slice(2).replace(/^[/\\]/, "")) : target.keyFilePath]
      : []),
    ...(target.port ? ["-p", String(target.port)] : []),
    target.target,
    remoteCommand,
  ];
  return { args, temporaryConfigDirectory };
}

async function runSsh(target: SshSyncTarget, remoteCommand: string, input?: Buffer, timeoutMs = 30_000, mutatingSsh = false): Promise<ProcessResult> {
  if (target.authentication === "password") {
    try { return await runPasswordSsh(target, remoteCommand, input, timeoutMs); }
    catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (/REMOTE_(?:NODE|CODEX|TAR|FLOCK|CMP)_MISSING|SSH_REMOTE_STATUS_UNCONFIRMED|REMOTE_SYNC_LOCKED|PROFILE_LOCK_BUSY|SYNC_PARTIAL|ROLLBACK_FAILED|PLUGIN_INSTALL_UNVERIFIED|PROFILE_CHANGED_DURING_SYNC/i.test(detail)) {
        throw new Error(processFailure("ssh", 1, detail));
      }
      throw error;
    }
  }
  const invocation = sshArgs(target, remoteCommand);
  try { return await runProcess("ssh", invocation.args, { input, timeoutMs, mutatingSsh }); }
  finally { if (invocation.temporaryConfigDirectory) rmSync(invocation.temporaryConfigDirectory, { recursive: true, force: true }); }
}

async function readRemoteInfo(target: SshSyncTarget): Promise<RemoteInfo> {
  validateTarget(target);
  const script = [
    "set -eu",
    "command -v node >/dev/null 2>&1 || { echo REMOTE_NODE_MISSING >&2; exit 1; }",
    "command -v codex >/dev/null 2>&1 || { echo REMOTE_CODEX_MISSING >&2; exit 1; }",
    "command -v tar >/dev/null 2>&1 || { echo REMOTE_TAR_MISSING >&2; exit 1; }",
    "command -v flock >/dev/null 2>&1 || { echo REMOTE_FLOCK_MISSING >&2; exit 1; }",
    "command -v cmp >/dev/null 2>&1 || { echo REMOTE_CMP_MISSING >&2; exit 1; }",
    "printf 'HOME=%s\\n' \"$HOME\"",
    "printf 'NODE_VERSION=%s\\n' \"$(node --version)\"",
    "printf 'CODEX_VERSION=%s\\n' \"$(codex --version 2>/dev/null | head -n 1)\"",
  ].join("\n");
  const result = await runSsh(target, "sh -s", Buffer.from(script), 25_000);
  const fields = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const home = fields.get("HOME");
  const nodeVersion = fields.get("NODE_VERSION");
  const codexVersion = fields.get("CODEX_VERSION");
  if (!home?.startsWith("/") || !nodeVersion || !codexVersion) {
    throw new Error("SSH connected, but remote HOME, Node.js, or Codex CLI could not be confirmed.");
  }
  const nodeMajor = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
    throw new Error("Remote Node.js 18 or newer is required to run the Codex plugin.");
  }
  return { home, nodeVersion, codexVersion };
}

function resolveRemoteCodexHome(input: string | undefined, remoteHome: string): string {
  const value = input?.trim() || "~/.codex";
  if (value.split("/").includes("..")) throw new Error("Remote CODEX_HOME cannot contain parent-directory segments.");
  let resolved: string;
  if (value === "~") resolved = remoteHome;
  else if (value.startsWith("~/")) {
    const suffix = value.slice(2);
    if (!suffix || suffix.startsWith("/")) throw new Error("Remote CODEX_HOME after ~/ must be a path within the remote home directory.");
    resolved = path.posix.resolve(remoteHome, suffix);
    if (resolved !== remoteHome && !resolved.startsWith(`${remoteHome.replace(/\/$/, "")}/`)) {
      throw new Error("Remote CODEX_HOME must stay within the remote home directory when using ~/.");
    }
  }
  else if (value.startsWith("/")) resolved = path.posix.normalize(value);
  else throw new Error("Remote CODEX_HOME must be absolute or start with ~/.");
  if (resolved === "/") throw new Error("Remote CODEX_HOME cannot be the filesystem root.");
  return resolved;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeProfileConfiguration(): { configured: boolean; json?: string } {
  const result = getModelConfiguration();
  if (!result.configured) return { configured: false };

  const configuration: ModelConfiguration = {
    schemaVersion: 1,
    profiles: Object.fromEntries(PROFILE_NAMES.map((name) => [
      name,
      result.configuration.profiles[name].map((candidate) => ({
        model: candidate.model,
        ...(candidate.reasoningEffort ? { reasoningEffort: candidate.reasoningEffort } : {}),
      })),
    ])) as ModelConfiguration["profiles"],
    agents: Object.fromEntries(Object.entries(result.configuration.agents)),
  };
  return { configured: true, json: `${JSON.stringify(configuration, null, 2)}\n` };
}

function copyIfPresent(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`Required installed plugin file is missing: ${path.basename(from)}.`);
  if (!lstatSync(from).isFile()) throw new Error(`Required installed plugin file is not a regular file: ${path.basename(from)}.`);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function createPayload(remoteCodexHome: string, profileJson?: string): { tempRoot: string; archive: Buffer; pluginVersion: string } {
  const localCodexHome = new PathResolver().codexHome;
  const installedMarketplace = path.join(localCodexHome, "my-workbench-plugin-marketplace");
  const installedPlugin = path.join(installedMarketplace, "plugins", PLUGIN_NAME);
  const payloadBase = path.resolve(os.tmpdir());
  const tempRoot = mkdtempSync(path.join(payloadBase, "subagent-config-sync-"));
  if (!path.resolve(tempRoot).startsWith(`${payloadBase}${path.sep}`)) {
    throw new Error("Temporary payload escaped the system temporary directory.");
  }

  try {
    const marketplace = path.join(tempRoot, "marketplace");
    const plugin = path.join(marketplace, "plugins", PLUGIN_NAME);
    const manifestPath = path.join(installedPlugin, "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; version?: string };
    if (manifest.name !== PLUGIN_NAME || !manifest.version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) {
      throw new Error("The installed Subagent Config manifest has an invalid identity or version.");
    }
    copyIfPresent(manifestPath, path.join(plugin, "plugin.json"));
    copyIfPresent(path.join(installedPlugin, "assets", "icon.png"), path.join(plugin, "assets", "icon.png"));
    copyIfPresent(path.join(installedPlugin, "assets", "logo.png"), path.join(plugin, "assets", "logo.png"));
    for (const filename of [
      "keyring-win32-x64-msvc-LICENSE.third-party.md",
      "keyring-linux-x64-gnu-LICENSE.third-party.md",
      "keyring-linux-arm64-gnu-LICENSE.third-party.md",
      "keyring-darwin-x64-LICENSE.third-party.md",
      "keyring-darwin-arm64-LICENSE.third-party.md",
    ]) {
      copyIfPresent(path.join(installedPlugin, "assets", "keyring", "licenses", filename), path.join(plugin, "assets", "keyring", "licenses", filename));
    }
    for (const filename of ["ssh2-LICENSE.txt", "asn1-LICENSE.txt", "bcrypt-pbkdf-LICENSE.txt", "napi-rs-keyring-LICENSE.txt"]) {
      copyIfPresent(path.join(installedPlugin, "assets", "third-party-licenses", filename), path.join(plugin, "assets", "third-party-licenses", filename));
    }
    copyIfPresent(path.join(installedPlugin, "runtime", "server.mjs"), path.join(plugin, "runtime", "server.mjs"));
    copyIfPresent(path.join(installedPlugin, "runtime", "component.html"), path.join(plugin, "runtime", "component.html"));
    copyIfPresent(path.join(installedPlugin, "runtime", "keyring", "index.cjs"), path.join(plugin, "runtime", "keyring", "index.cjs"));
    for (const filename of [
      "keyring.win32-x64-msvc.node",
      "keyring.linux-x64-gnu.node",
      "keyring.linux-arm64-gnu.node",
      "keyring.darwin-x64.node",
      "keyring.darwin-arm64.node",
    ]) {
      copyIfPresent(path.join(installedPlugin, "runtime", "keyring", "bindings", filename), path.join(plugin, "runtime", "keyring", "bindings", filename));
    }

    const marketplaceMetadata = {
      name: MARKETPLACE_NAME,
      interface: { displayName: "My Workbench" },
      plugins: [{
        name: PLUGIN_NAME,
        source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    };
    const marketplaceMetadataPath = path.join(marketplace, ".agents", "plugins", "marketplace.json");
    mkdirSync(path.dirname(marketplaceMetadataPath), { recursive: true });
    writeFileSync(marketplaceMetadataPath, `${JSON.stringify(marketplaceMetadata, null, 2)}\n`, { mode: 0o600 });
    const mcp = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        [PLUGIN_NAME]: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/runtime/server.mjs"],
          cwd: "${PLUGIN_ROOT}",
          env: { CODEX_HOME: remoteCodexHome },
        },
      },
    };
    writeFileSync(path.join(plugin, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });

    if (profileJson) writeFileSync(path.join(tempRoot, "profile.json"), profileJson, { mode: 0o600 });
    const archiveResult = spawnSync("tar", ["-cf", "-", "-C", tempRoot, "."], {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (archiveResult.error || archiveResult.status !== 0 || !archiveResult.stdout) {
      throw new Error(`Unable to package the installed plugin${archiveResult.error ? `: ${archiveResult.error.message}` : "."}`);
    }
    return { tempRoot, archive: archiveResult.stdout as Buffer, pluginVersion: manifest.version };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function checkSshCodexTarget(input: SshSyncTarget) {
  validateTarget(input);
  const remote = await readRemoteInfo(input);
  const codexHome = resolveRemoteCodexHome(input.codexHome, remote.home);
  const profile = safeProfileConfiguration();
  const localCodexHome = new PathResolver().codexHome;
  const installedPluginPath = path.join(localCodexHome, "my-workbench-plugin-marketplace", "plugins", PLUGIN_NAME, "plugin.json");
  if (!existsSync(installedPluginPath)) throw new Error("The installed local Subagent Config package could not be found.");
  const localManifest = JSON.parse(readFileSync(installedPluginPath, "utf8")) as { version?: string };
  if (!localManifest.version) throw new Error("The installed local plugin version could not be read.");
  return {
    target: input.target,
    port: input.port ?? null,
    remoteHome: remote.home,
    codexHome,
    nodeVersion: remote.nodeVersion,
    codexVersion: remote.codexVersion,
    pluginVersion: localManifest.version,
    profileConfigured: profile.configured,
  };
}

export async function syncSubagentConfigToSsh(input: SshSyncTarget) {
  validateTarget(input);
  const remote = await readRemoteInfo(input);
  const codexHome = resolveRemoteCodexHome(input.codexHome, remote.home);
  const profile = safeProfileConfiguration();
  const payload = createPayload(codexHome, profile.json);
  const remoteStage = `/tmp/subagent-config-sync-${randomUUID()}`;

  try {
    const updateMarketplace = "const fs=require('node:fs');const [source,destination,expected]=process.argv.slice(1);let catalog={name:'my-workbench',interface:{displayName:'My Workbench'},plugins:[]};if(fs.existsSync(source)){const stat=fs.lstatSync(source);if(stat.isSymbolicLink()||!stat.isFile())throw Error('Invalid marketplace manifest');catalog=JSON.parse(fs.readFileSync(source,'utf8'));if(catalog.name!=='my-workbench'||!Array.isArray(catalog.plugins))throw Error('Unexpected marketplace manifest');}const entry={name:'subagent-config',source:{source:'local',path:'./plugins/subagent-config'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'};const index=catalog.plugins.findIndex(item=>item&&item.name==='subagent-config');if(index<0)catalog.plugins.push(entry);else catalog.plugins[index]={...catalog.plugins[index],...entry};const content=JSON.stringify(catalog,null,2)+'\\n';fs.writeFileSync(destination,content,{mode:0o600,flag:'wx'});fs.writeFileSync(expected,content,{mode:0o600,flag:'wx'});";
    const validateRemotePaths = "const fs=require('node:fs');const path=require('node:path');for(const target of process.argv.slice(1)){const absolute=path.resolve(target);const parts=absolute.split(path.sep).filter(Boolean);let current=path.parse(absolute).root;for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw Error('Symbolic link in managed path');if(i<parts.length-1&&!stat.isDirectory())throw Error('Non-directory in managed path')}catch(error){if(error.code==='ENOENT')break;throw error}}}";
    const copyExclusive = "const fs=require('node:fs');fs.copyFileSync(process.argv[1],process.argv[2],fs.constants.COPYFILE_EXCL);";
    const commitProfile = `const fs=require('node:fs');const crypto=require('node:crypto');const [live,backup,temp,hadPrevious]=process.argv.slice(1);const lock=live+'.lock',owner=lock+'/owner.json',token=crypto.randomUUID(),deadline=Date.now()+30000;let owned=false;while(!owned){let created=false;try{fs.mkdirSync(lock,{mode:448});created=true;fs.writeFileSync(owner,JSON.stringify({token}),{flag:'wx',mode:384});owned=true}catch(error){if(created){try{fs.unlinkSync(owner)}catch{}try{fs.rmdirSync(lock)}catch{}throw error}if(error.code!=='EEXIST')throw error;try{const stat=fs.lstatSync(lock);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('PROFILE_LOCK_UNSAFE')}catch(error){if(error.message==='PROFILE_LOCK_UNSAFE')throw error}if(Date.now()>=deadline)throw Error('PROFILE_LOCK_BUSY');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)}}try{if(hadPrevious==='true'){const stat=fs.lstatSync(live);if(stat.isSymbolicLink()||!stat.isFile()||!fs.readFileSync(live).equals(fs.readFileSync(backup)))throw Error('PROFILE_CHANGED_DURING_SYNC')}else{try{fs.lstatSync(live);throw Error('PROFILE_CHANGED_DURING_SYNC')}catch(error){if(error.code!=='ENOENT')throw error}}const tempStat=fs.lstatSync(temp);if(tempStat.isSymbolicLink()||!tempStat.isFile())throw Error('Invalid staged profile');fs.renameSync(temp,live)}finally{try{const record=JSON.parse(fs.readFileSync(owner,'utf8'));if(record.token===token){fs.unlinkSync(owner);fs.rmdirSync(lock)}}catch{}}`;
    const commitMarketplace = "const fs=require('node:fs');const [live,backup,temp,expected,hadPrevious]=process.argv.slice(1);if(hadPrevious==='true'){if(!fs.readFileSync(live).equals(fs.readFileSync(backup)))throw Error('Marketplace changed during sync')}else{try{fs.lstatSync(live);throw Error('Marketplace appeared during sync')}catch(error){if(error.code!=='ENOENT')throw error}}if(!fs.readFileSync(temp).equals(fs.readFileSync(expected)))throw Error('Marketplace payload mismatch');try{const stat=fs.lstatSync(live);if(stat.isSymbolicLink()||!stat.isFile())throw Error('Marketplace destination changed')}catch(error){if(error.code!=='ENOENT')throw error}fs.renameSync(temp,live);";
    const renamePath = "require('node:fs').renameSync(process.argv[1],process.argv[2]);";
    const recordPluginIdentity = "const fs=require('node:fs');const [plugin,record]=process.argv.slice(1);const stat=fs.lstatSync(plugin);if(!stat.isDirectory()||stat.isSymbolicLink())process.exit(2);fs.writeFileSync(record,stat.dev+':'+stat.ino+'\\n',{flag:'wx',mode:0o600});";
    const verifyPluginIdentity = "const fs=require('node:fs');const path=require('node:path');const [expected,plugin,record]=process.argv.slice(1);const stat=fs.lstatSync(plugin);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.readFileSync(record,'utf8').trim()!==stat.dev+':'+stat.ino)process.exit(2);function equal(a,b){const x=fs.lstatSync(a),y=fs.lstatSync(b);if(x.isSymbolicLink()||y.isSymbolicLink())return x.isSymbolicLink()&&y.isSymbolicLink()&&fs.readlinkSync(a)===fs.readlinkSync(b);if(x.isDirectory()!==y.isDirectory()||x.isFile()!==y.isFile())return false;if(x.isFile())return fs.readFileSync(a).equals(fs.readFileSync(b));if(!x.isDirectory())return false;const left=fs.readdirSync(a).sort(),right=fs.readdirSync(b).sort();return left.length===right.length&&left.every((name,index)=>name===right[index]&&equal(path.join(a,name),path.join(b,name)))}if(!equal(expected,plugin))process.exit(2);";
    const installedVersion = "const fs=require('node:fs');const result=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const plugin=result.installed?.find(item=>item.pluginId==='subagent-config@my-workbench'&&item.installed&&item.enabled);if(!plugin?.version)process.exit(2);process.stdout.write(plugin.version);";
    const script = [
      "set -eu",
      "umask 077",
      `stage=${shellQuote(remoteStage)}`,
      `codex_home=${shellQuote(codexHome)}`,
      `sync_id=${shellQuote(path.posix.basename(remoteStage).slice("subagent-config-sync-".length))}`,
      "marketplace=\"$codex_home/my-workbench-plugin-marketplace\"",
      "plugin_dir=\"$marketplace/plugins/subagent-config\"",
      "plugin_next=\"$marketplace/plugins/.subagent-config.next.$sync_id\"",
      "plugin_previous=\"$marketplace/plugins/.subagent-config.previous.$sync_id\"",
      "plugin_rollback=\"$marketplace/plugins/.subagent-config.rollback.$sync_id\"",
      "manifest=\"$marketplace/.agents/plugins/marketplace.json\"",
      "manifest_tmp=\"$marketplace/.agents/plugins/.marketplace.json.sync.$sync_id\"",
      "manifest_backup=\"$marketplace/.agents/plugins/.marketplace.json.backup.$sync_id\"",
      "manifest_expected=\"$stage/marketplace.expected.json\"",
      "lock=\"$marketplace/.subagent-config-sync.lock\"",
      "profile_path=\"$codex_home/my-workbench-config.json\"",
      "profile_backup=\"$codex_home/.my-workbench-config.backup.$sync_id\"",
      "profile_tmp=",
      "sync_complete=false",
      "cleanup_done=false",
      "stage_owned=false",
      "lock_owned=false",
      "lock_fd_open=false",
      "plugin_had_previous=false",
      "plugin_new_installed=false",
      "plugin_restore_safe=true",
      "manifest_had_previous=false",
      "manifest_new_installed=false",
      "profile_had_previous=false",
      "profile_new_installed=false",
      "codex_cli_changed=false",
      "profile_synced=false",
      "cleanup() {",
      "  trap '' HUP INT TERM",
      "  [ \"$cleanup_done\" = true ] && return 0",
      "  cleanup_done=true",
      "  rollback_failed=false",
      "  if [ \"$lock_owned\" = true ]; then",
      "    if [ \"$sync_complete\" != true ]; then",
      "      if [ \"$codex_cli_changed\" != true ]; then",
      `        if [ "$plugin_new_installed" = true ]; then if node -e ${shellQuote(renamePath)} "$plugin_dir" "$plugin_rollback"; then if node -e ${shellQuote(verifyPluginIdentity)} "$stage/marketplace/plugins/subagent-config" "$plugin_rollback" "$stage/plugin.identity"; then if ! rm -rf -- "$plugin_rollback"; then rollback_failed=true; plugin_restore_safe=false; fi; else rollback_failed=true; plugin_restore_safe=false; if [ ! -e "$plugin_dir" ] && [ ! -L "$plugin_dir" ]; then node -e ${shellQuote(renamePath)} "$plugin_rollback" "$plugin_dir" || true; fi; fi; else rollback_failed=true; plugin_restore_safe=false; fi; fi`,
      `        if [ "$plugin_had_previous" = true ]; then if [ "$plugin_restore_safe" = true ] && [ -d "$plugin_previous" ]; then if ! node -e ${shellQuote(renamePath)} "$plugin_previous" "$plugin_dir"; then rollback_failed=true; fi; else rollback_failed=true; fi; fi`,
      `        if [ "$manifest_new_installed" = true ]; then if [ "$manifest_had_previous" = true ]; then if [ -f "$manifest_backup" ] && cmp -s "$manifest" "$manifest_expected"; then if ! node -e ${shellQuote(renamePath)} "$manifest_backup" "$manifest"; then rollback_failed=true; fi; else rollback_failed=true; fi; elif cmp -s "$manifest" "$manifest_expected"; then rm -f -- "$manifest" || rollback_failed=true; else rollback_failed=true; fi; fi`,
      `        if [ "$profile_new_installed" = true ]; then if [ "$profile_had_previous" = true ]; then if [ -f "$profile_backup" ] && cmp -s "$profile_path" "$stage/profile.json"; then if ! node -e ${shellQuote(renamePath)} "$profile_backup" "$profile_path"; then rollback_failed=true; fi; else rollback_failed=true; fi; elif cmp -s "$profile_path" "$stage/profile.json"; then rm -f -- "$profile_path" || rollback_failed=true; else rollback_failed=true; fi; fi`,
      "      fi",
      "    fi",
      "    if [ \"$codex_cli_changed\" = true ] && [ \"$sync_complete\" != true ]; then echo 'SYNC_PARTIAL: the remote Codex CLI changed plugin registration; new files and recovery backups were retained.' >&2; fi",
      "    if [ \"$rollback_failed\" = true ]; then echo 'ROLLBACK_FAILED: backup files were retained for recovery.' >&2; fi",
      "    if [ \"$sync_complete\" = true ] || { [ \"$rollback_failed\" = false ] && [ \"$codex_cli_changed\" != true ]; }; then rm -f -- \"$profile_backup\" \"$manifest_backup\"; rm -rf -- \"$plugin_previous\"; fi",
      "    if [ -n \"$profile_tmp\" ]; then rm -f -- \"$profile_tmp\" 2>/dev/null || true; fi",
      "    rm -f -- \"$manifest_tmp\" 2>/dev/null || true",
      "    rm -rf -- \"$plugin_next\" 2>/dev/null || true",
      "  fi",
      "  if [ \"$lock_fd_open\" = true ]; then exec 9>&-; fi",
      "  if [ \"$stage_owned\" = true ]; then rm -rf -- \"$stage\"; fi",
      "}",
      "trap cleanup EXIT",
      "trap 'exit 1' HUP INT TERM",
      "mkdir -m 700 \"$stage\"",
      "stage_owned=true",
      "tar -xf - -C \"$stage\"",
      `node -e ${shellQuote(validateRemotePaths)} "$codex_home" "$marketplace" "$marketplace/.agents/plugins" "$marketplace/plugins"`,
      "mkdir -p \"$codex_home\" \"$marketplace/.agents/plugins\" \"$marketplace/plugins\"",
      "if [ -L \"$lock\" ] || { [ -e \"$lock\" ] && [ ! -f \"$lock\" ]; }; then echo 'The remote sync lock path is not a regular file.' >&2; exit 1; fi",
      "exec 9>>\"$lock\"",
      "lock_fd_open=true",
      "if ! flock -n 9; then echo 'Another Subagent Config sync is already running for this CODEX_HOME.' >&2; exit 1; fi",
      "lock_owned=true",
      "export CODEX_HOME=\"$codex_home\"",
      "if [ -L \"$manifest\" ] || { [ -e \"$manifest\" ] && [ ! -f \"$manifest\" ]; }; then echo 'The remote marketplace manifest is not a regular file.' >&2; exit 1; fi",
      `if [ -f "$manifest" ]; then node -e ${shellQuote(copyExclusive)} "$manifest" "$manifest_backup"; manifest_had_previous=true; fi`,
      `node -e ${shellQuote(updateMarketplace)} "$manifest_backup" "$manifest_tmp" "$manifest_expected"`,
      "trap '' HUP INT TERM",
      `if node -e ${shellQuote(commitMarketplace)} "$manifest" "$manifest_backup" "$manifest_tmp" "$manifest_expected" "$manifest_had_previous"; then manifest_new_installed=true; else trap 'exit 1' HUP INT TERM; exit 1; fi`,
      "trap 'exit 1' HUP INT TERM",
      "mkdir -m 700 \"$plugin_next\"",
      "cp -R \"$stage/marketplace/plugins/subagent-config/.\" \"$plugin_next/\"",
      `node -e ${shellQuote(recordPluginIdentity)} "$plugin_next" "$stage/plugin.identity"`,
      "if [ -L \"$plugin_dir\" ] || { [ -e \"$plugin_dir\" ] && [ ! -d \"$plugin_dir\" ]; }; then echo 'The remote plugin path is not a directory.' >&2; exit 1; fi",
      `if [ -d "$plugin_dir" ]; then trap '' HUP INT TERM; if node -e ${shellQuote(renamePath)} "$plugin_dir" "$plugin_previous"; then plugin_had_previous=true; else trap 'exit 1' HUP INT TERM; exit 1; fi; trap 'exit 1' HUP INT TERM; fi`,
      "trap '' HUP INT TERM",
      `if node -e ${shellQuote(renamePath)} "$plugin_next" "$plugin_dir"; then plugin_new_installed=true; else trap 'exit 1' HUP INT TERM; exit 1; fi`,
      "trap 'exit 1' HUP INT TERM",
      `if [ -f "$stage/profile.json" ]; then if [ -L "$profile_path" ] || { [ -e "$profile_path" ] && [ ! -f "$profile_path" ]; }; then echo 'The remote model profile path is not a regular file.' >&2; exit 1; fi; if [ -f "$profile_path" ]; then node -e ${shellQuote(copyExclusive)} "$profile_path" "$profile_backup"; profile_had_previous=true; fi; profile_tmp="$codex_home/.my-workbench-config.sync.$sync_id"; node -e ${shellQuote(copyExclusive)} "$stage/profile.json" "$profile_tmp"; chmod 600 "$profile_tmp"; fi`,
      "codex_cli_changed=true",
      "if ! codex plugin marketplace add \"$marketplace\" --json 9>&- >/dev/null 2>&1; then echo SYNC_PARTIAL >&2; exit 1; fi",
      "if ! codex plugin add subagent-config@my-workbench --json 9>&- >/dev/null 2>&1; then echo SYNC_PARTIAL >&2; exit 1; fi",
      `if [ -n "$profile_tmp" ]; then trap '' HUP INT TERM; if node -e ${shellQuote(commitProfile)} "$profile_path" "$profile_backup" "$profile_tmp" "$profile_had_previous"; then profile_new_installed=true; profile_tmp=; profile_synced=true; else trap 'exit 1' HUP INT TERM; exit 1; fi; trap 'exit 1' HUP INT TERM; fi`,
      "codex plugin list --json 9>&- > \"$stage/plugin-list.json\" || { echo PLUGIN_INSTALL_UNVERIFIED >&2; exit 1; }",
      `remote_plugin_version=$(node -e ${shellQuote(installedVersion)} "$stage/plugin-list.json") || { echo PLUGIN_INSTALL_UNVERIFIED >&2; exit 1; }`,
      `if [ "$remote_plugin_version" != ${shellQuote(payload.pluginVersion)} ]; then echo PLUGIN_INSTALL_UNVERIFIED >&2; exit 1; fi`,
      "sync_complete=true",
      "printf 'SYNCED_PLUGIN_VERSION=%s\\n' \"$remote_plugin_version\"",
      "printf 'PROFILE_SYNCED=%s\\n' \"$profile_synced\"",
    ].join("\n");
    let result: ProcessResult;
    try {
      result = await runSsh(input, `sh -c ${shellQuote(script)}`, payload.archive, 120_000, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/^ssh timed out\.$|^The SSH process closed before receiving|^The SSH input stream failed\.|^The SSH operation failed\.|^SSH could not connect to the target\./.test(message)) {
        throw new Error("The SSH connection ended before the sync was confirmed. It may have partially completed. Inspect the remote plugin and recovery copies before retrying.");
      }
      throw error;
    }
    const fields = new Map<string, string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    if (fields.get("SYNCED_PLUGIN_VERSION") !== payload.pluginVersion || fields.get("PROFILE_SYNCED") !== String(profile.configured)) {
      throw new Error("The remote Codex did not confirm the completed sync.");
    }
    return {
      synced: true,
      target: input.target,
      port: input.port ?? null,
      codexHome,
      pluginVersion: payload.pluginVersion,
      profileSynced: fields.get("PROFILE_SYNCED") === "true",
    };
  } finally {
    const tempRoot = path.resolve(payload.tempRoot);
    const tempBase = path.resolve(os.tmpdir());
    if (tempRoot.startsWith(`${tempBase}${path.sep}`)) rmSync(tempRoot, { recursive: true, force: true });
  }
}

type SshBatchEntry = { id: string; name: string; state: "queued" | "syncing" | "synced" | "failed"; pluginVersion?: string; codexHome?: string; error?: string };
type SshSyncBatch = { batchId: string; serverIds: string[]; status: "running" | "completed" | "unknown"; startedAt: number; completedAt?: number; results: SshBatchEntry[]; syncedCount: number };
const sshSyncBatches = new Map<string, SshSyncBatch>();

function snapshotBatch(batch: SshSyncBatch): SshSyncBatch {
  return structuredClone(batch);
}

export function getSshSyncBatch(batchId: string): SshSyncBatch {
  const batch = sshSyncBatches.get(batchId);
  return batch ? snapshotBatch(batch) : { batchId, serverIds: [], status: "unknown", startedAt: 0, results: [], syncedCount: 0 };
}

export function startSshSyncBatch(servers: SshSyncTarget[]) {
  if (!servers.length) throw new Error("Add at least one SSH server before syncing all.");
  if (servers.length > 50) throw new Error("Sync all supports up to 50 configured SSH servers.");
  const active = [...sshSyncBatches.values()].find((batch) => batch.status === "running");
  if (active) {
    if (active.serverIds.length === servers.length && active.serverIds.every((id, index) => id === servers[index].id)) return snapshotBatch(active);
    throw new Error("A different sync-all batch is already running. Refresh its progress before starting another.");
  }
  const batch: SshSyncBatch = {
    batchId: randomUUID(),
    serverIds: servers.map((server) => server.id),
    status: "running",
    startedAt: Date.now(),
    results: servers.map((server) => ({ id: server.id, name: server.name, state: "queued" })),
    syncedCount: 0,
  };
  sshSyncBatches.set(batch.batchId, batch);
  for (const [id, entry] of sshSyncBatches) if (entry.status === "completed" && Date.now() - (entry.completedAt ?? entry.startedAt) > 3_600_000) sshSyncBatches.delete(id);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < servers.length) {
      const index = next++;
      const server = servers[index];
      batch.results[index].state = "syncing";
      try {
        const result = await syncSubagentConfigToSsh(server);
        batch.results[index] = { id: server.id, name: server.name, state: "synced", pluginVersion: result.pluginVersion, codexHome: result.codexHome };
        batch.syncedCount += 1;
      } catch (error) {
        batch.results[index] = {
          id: server.id,
          name: server.name,
          state: "failed",
          error: error instanceof Error ? error.message : "Unable to sync this SSH server.",
        };
      }
    }
  }
  void Promise.all(Array.from({ length: Math.min(2, servers.length) }, worker)).then(() => {
    batch.status = "completed";
    batch.completedAt = Date.now();
  });
  return snapshotBatch(batch);
}
