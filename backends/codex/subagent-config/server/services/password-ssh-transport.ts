import { createHmac } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client, utils, type CipherAlgorithm, type CompressionAlgorithm, type KexAlgorithm, type MacAlgorithm, type ServerHostKeyAlgorithm } from "ssh2";
import { getSshPassword, type SshServer } from "./ssh-server-store.js";

type SshConfig = { host: string; hostKeyName: string; username: string; port: number; checkHostIp: boolean; addressFamily: "any" | "inet" | "inet6"; ipHostNames: string[]; hostKeyAlgorithms: ServerHostKeyAlgorithm[]; kexAlgorithms: KexAlgorithm[]; ciphers: CipherAlgorithm[]; macs: MacAlgorithm[]; compression: CompressionAlgorithm[]; requiredRsaSize: number; acceptedHostNames: string[]; revokedHostNames: string[]; knownHosts: string[]; revokedHostKeys: string[]; destinationId: string };
type ProcessResult = { stdout: string; stderr: string };
const MAX_OUTPUT_BYTES = 32 * 1024;

function defaultSshPaths(kind: "userknownhostsfile" | "globalknownhostsfile"): string[] {
  if (kind === "userknownhostsfile") return [path.join(os.homedir(), ".ssh", "known_hosts"), path.join(os.homedir(), ".ssh", "known_hosts2")];
  if (process.platform === "win32") {
    const programData = process.env.ProgramData ?? "C:\\ProgramData";
    return [path.join(programData, "ssh", "ssh_known_hosts"), path.join(programData, "ssh", "ssh_known_hosts2")];
  }
  return ["/etc/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"];
}

function splitSshPaths(value: string | undefined, defaults: string[] = []): string[] {
  const result: string[] = [];
  let current = "";
  let quote = false;
  const characters = [...(value ?? "")];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (character === "\\" && quote) {
      const next = characters[index + 1];
      if (next === '"' || next === "\\") { current += next; index++; }
      else current += character;
    }
    else if (character === '"') quote = !quote;
    else if (/\s/.test(character) && !quote) { if (current) { result.push(current); current = ""; } }
    else current += character;
  }
  if (quote) throw new Error("The SSH trust-file configuration is ambiguous. Quote paths that contain spaces.");
  if (current) result.push(current);
  if (result.some((item) => item.startsWith("~") && !item.startsWith("~/") && !item.startsWith("~\\"))) {
    throw new Error("Named-user SSH trust paths are unsupported. Use an absolute path or a path beginning with ~/.");
  }
  const expanded = result.map((item) => process.platform === "win32" && /^__PROGRAMDATA__[/\\]/i.test(item)
    ? path.join(process.env.ProgramData ?? "C:\\ProgramData", item.slice("__PROGRAMDATA__".length).replace(/^[/\\]/, ""))
    : item.startsWith("~/") || item.startsWith("~\\") ? path.join(os.homedir(), item.slice(2)) : item);
  if (expanded.length > 1) {
    const normalize = (item: string) => {
      const formatted = item.replace(/\\/g, "/").replace(/\/$/, "");
      return process.platform === "win32" ? formatted.toLowerCase() : formatted;
    };
    const expected = defaults.map(normalize);
    if (expected.length !== expanded.length || expanded.some((item, index) => normalize(item) !== expected[index])) {
      throw new Error("OpenSSH did not preserve the boundaries of multiple trust-file paths. Configure one absolute path without spaces.");
    }
  }
  if (expanded.some((item) => item !== "none" && !path.isAbsolute(item) && !item.startsWith("~/") && !item.startsWith("~\\"))) {
    throw new Error("SSH trust-file paths must be absolute or start with ~.");
  }
  return expanded.filter((item) => item && item !== "none");
}

export function assertSshTrustPathsUnambiguous(configOutput: string): void {
  const values = new Map<string, string>();
  for (const line of configOutput.split(/\r?\n/)) {
    const split = line.indexOf(" ");
    if (split > 0) values.set(line.slice(0, split).toLowerCase(), line.slice(split + 1).trim());
  }
  splitSshPaths(values.get("userknownhostsfile"), defaultSshPaths("userknownhostsfile"));
  splitSshPaths(values.get("globalknownhostsfile"), defaultSshPaths("globalknownhostsfile"));
  splitSshPaths(values.get("revokedhostkeys"));
}

export function normalizeSshTrustConfigLine(name: string, value: string): string {
  const normalizedName = name.toLowerCase();
  const paths = normalizedName === "userknownhostsfile" ? splitSshPaths(value, defaultSshPaths("userknownhostsfile"))
    : normalizedName === "globalknownhostsfile" ? splitSshPaths(value, defaultSshPaths("globalknownhostsfile"))
      : normalizedName === "revokedhostkeys" ? splitSshPaths(value) : null;
  if (!paths) throw new Error("Unsupported SSH trust-file setting.");
  const rendered = paths.length ? paths.map((item) => /\s/.test(item) ? `"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : item).join(" ") : "none";
  return `${normalizedName} ${rendered}`;
}

function resolveConfig(server: SshServer): SshConfig {
  const resolved = spawnSync("ssh", ["-G", ...(server.port ? ["-p", String(server.port)] : []), server.target], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ProgramData: process.env.ProgramData, SystemRoot: process.env.SystemRoot },
  });
  if (resolved.error || resolved.status !== 0) throw new Error("The local SSH configuration could not resolve this host.");
  const values = new Map<string, string>();
  for (const line of resolved.stdout.split(/\r?\n/)) {
    const split = line.indexOf(" ");
    if (split > 0) values.set(line.slice(0, split).toLowerCase(), line.slice(split + 1).trim());
  }
  if (["proxyjump", "proxycommand", "knownhostscommand"].some((name) => values.get(name) && values.get(name) !== "none")) {
    throw new Error("Password authentication requires configured trust files and a direct SSH connection without ProxyJump, ProxyCommand, or KnownHostsCommand.");
  }
  if (["no", "false"].includes((values.get("passwordauthentication") ?? "").toLowerCase())) {
    throw new Error("The SSH configuration disables password authentication for this host.");
  }
  if ((values.get("batchmode") ?? "yes").toLowerCase() === "yes") throw new Error("The SSH configuration enables BatchMode, so password authentication is not permitted.");
  const preferredAuthentications = (values.get("preferredauthentications") ?? "gssapi-with-mic,hostbased,publickey,keyboard-interactive,password").split(",").map((item) => item.trim());
  if (!preferredAuthentications.includes("password")) throw new Error("The SSH configuration does not permit password authentication in PreferredAuthentications.");
  const passwordPrompts = Number(values.get("numberofpasswordprompts") ?? "3");
  if (!Number.isInteger(passwordPrompts) || passwordPrompts < 1) throw new Error("The SSH configuration does not permit password prompts.");
  const host = values.get("hostname");
  const username = values.get("user");
  const port = server.port ?? Number(values.get("port"));
  assertSshTrustPathsUnambiguous(resolved.stdout);
  const knownHosts = [...splitSshPaths(values.get("userknownhostsfile"), defaultSshPaths("userknownhostsfile")), ...splitSshPaths(values.get("globalknownhostsfile"), defaultSshPaths("globalknownhostsfile"))];
  const revokedHostKeys = splitSshPaths(values.get("revokedhostkeys"));
  const supportedHostKeyAlgorithms = new Set<ServerHostKeyAlgorithm>(["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ssh-dss"]);
  const hostKeyAlgorithms: ServerHostKeyAlgorithm[] = (values.get("hostkeyalgorithms") ?? "").split(",").filter((algorithm) => supportedHostKeyAlgorithms.has(algorithm as ServerHostKeyAlgorithm)) as ServerHostKeyAlgorithm[];
  const supportedKexAlgorithms = new Set<KexAlgorithm>(["curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521", "diffie-hellman-group-exchange-sha256", "diffie-hellman-group14-sha256", "diffie-hellman-group15-sha512", "diffie-hellman-group16-sha512", "diffie-hellman-group17-sha512", "diffie-hellman-group18-sha512", "diffie-hellman-group-exchange-sha1", "diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1"]);
  const supportedCiphers = new Set<CipherAlgorithm>(["chacha20-poly1305@openssh.com", "aes128-gcm", "aes128-gcm@openssh.com", "aes256-gcm", "aes256-gcm@openssh.com", "aes128-ctr", "aes192-ctr", "aes256-ctr", "aes256-cbc", "aes192-cbc", "aes128-cbc", "blowfish-cbc", "3des-cbc", "arcfour256", "arcfour128", "arcfour"]);
  const supportedMacs = new Set<MacAlgorithm>(["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha1-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512", "hmac-sha1", "hmac-md5", "hmac-sha2-256-96", "hmac-sha2-512-96", "hmac-ripemd160", "hmac-sha1-96", "hmac-md5-96"]);
  const kexAlgorithms = (values.get("kexalgorithms") ?? "").split(",").filter((item): item is KexAlgorithm => supportedKexAlgorithms.has(item as KexAlgorithm));
  const ciphers = (values.get("ciphers") ?? "").split(",").filter((item): item is CipherAlgorithm => supportedCiphers.has(item as CipherAlgorithm));
  const macs = (values.get("macs") ?? "").split(",").filter((item): item is MacAlgorithm => supportedMacs.has(item as MacAlgorithm));
  const compression: CompressionAlgorithm[] = (values.get("compression") ?? "no").toLowerCase() === "yes" ? ["zlib@openssh.com", "zlib", "none"] : ["none"];
  const requiredRsaSize = Number(values.get("requiredrsasize") ?? "1024");
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host.replace(/^\[|\]$/g, "")) || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The local SSH configuration did not provide a valid host, username, and port.");
  }
  if (!knownHosts.length) throw new Error("No known_hosts file is configured. Verify the host fingerprint with OpenSSH before using password authentication.");
  if (!hostKeyAlgorithms.length) throw new Error("The configured HostKeyAlgorithms list has no algorithms supported by password authentication.");
  if (!kexAlgorithms.length || !ciphers.length || !macs.length) throw new Error("The configured SSH key exchange, cipher, or MAC list has no algorithms supported by password authentication.");
  if (!Number.isInteger(requiredRsaSize) || requiredRsaSize < 1 || requiredRsaSize > 16384) throw new Error("The configured RequiredRSASize value is invalid.");
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  const explicitHostKeyAlias = values.get("hostkeyalias");
  const hasHostKeyAlias = explicitHostKeyAlias !== undefined && explicitHostKeyAlias !== "";
  const hostKeyName = hasHostKeyAlias ? explicitHostKeyAlias : normalizedHost;
  const acceptedHostNames = hasHostKeyAlias
    ? [hostKeyName]
    : port === 22 ? [normalizedHost] : [`[${normalizedHost}]:${port}`];
  const revokedHostNames = [...new Set([...acceptedHostNames, hostKeyName])];
  const addressFamily = (values.get("addressfamily") ?? "any").toLowerCase();
  if (!["any", "inet", "inet6"].includes(addressFamily)) throw new Error("The SSH configuration contains an unsupported AddressFamily value.");
  return { host: normalizedHost, hostKeyName, username, port, checkHostIp: ["yes", "true"].includes((values.get("checkhostip") ?? "no").toLowerCase()), addressFamily: addressFamily as SshConfig["addressFamily"], ipHostNames: [], hostKeyAlgorithms, kexAlgorithms, ciphers, macs, compression, requiredRsaSize, acceptedHostNames, revokedHostNames, knownHosts, revokedHostKeys, destinationId: JSON.stringify([normalizedHost, username, port, hostKeyName]) };
}

async function pinCheckHostIp(config: SshConfig): Promise<SshConfig> {
  const requiredFamily = config.addressFamily === "inet" ? 4 : config.addressFamily === "inet6" ? 6 : undefined;
  if (!config.checkHostIp) {
    if (requiredFamily && isIP(config.host) && isIP(config.host) !== requiredFamily) throw new Error("The SSH host address does not match the configured AddressFamily.");
    return config;
  }
  let addresses: string[];
  if (isIP(config.host)) addresses = [config.host];
  else {
    try { addresses = (await lookup(config.host, { all: true, verbatim: true })).map((item) => item.address); }
    catch { throw new Error("The SSH host could not be resolved for CheckHostIP verification."); }
  }
  if (requiredFamily) addresses = addresses.filter((address) => isIP(address) === requiredFamily);
  if (!addresses.length) throw new Error("The SSH host could not be resolved for CheckHostIP verification.");
  const ipHostName = config.port === 22 ? addresses[0] : `[${addresses[0]}]:${config.port}`;
  return { ...config, host: addresses[0], ipHostNames: [ipHostName], revokedHostNames: [...new Set([...config.revokedHostNames, ipHostName])] };
}

export function resolvePasswordSshBinding(server: SshServer): string {
  return resolveConfig(server).destinationId;
}

function hostMatches(pattern: string, candidates: string[]): boolean {
  if (pattern.startsWith("|1|")) {
    const [, , saltText, hashText] = pattern.split("|");
    if (!saltText || !hashText) return false;
    let salt: Buffer;
    let expected: Buffer;
    try { salt = Buffer.from(saltText, "base64"); expected = Buffer.from(hashText, "base64"); } catch { return false; }
    return candidates.some((candidate) => {
      const actual = createHmac("sha1", salt).update(candidate).digest();
      return actual.length === expected.length && actual.equals(expected);
    });
  }
  const patterns = pattern.split(",");
  const matches = (item: string, candidate: string) => {
    const special = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
    const source = [...item].map((character) => character === "*" ? ".*" : character === "?" ? "." : special.has(character) ? `\\${character}` : character).join("");
    const expression = new RegExp(`^${source}$`, "i");
    return expression.test(candidate);
  };
  const positive = patterns.filter((item) => item && !item.startsWith("!"));
  const negative = patterns.filter((item) => item.startsWith("!"));
  return candidates.some((candidate) => !negative.some((item) => matches(item.slice(1), candidate))
    && positive.some((item) => matches(item, candidate)));
}

function parsePublicKeyBlob(algorithm: string, encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Malformed SSH public key.");
  const blob = Buffer.from(encoded, "base64");
  const canonical = blob.toString("base64");
  if (!blob.length || (encoded !== canonical && encoded !== canonical.replace(/=+$/, ""))) throw new Error("Malformed SSH public key.");
  if (blob.length < 4) throw new Error("Malformed SSH public key.");
  const embeddedAlgorithmLength = blob.readUInt32BE(0);
  if (embeddedAlgorithmLength < 1 || embeddedAlgorithmLength > blob.length - 4
    || blob.subarray(4, 4 + embeddedAlgorithmLength).toString("ascii") !== algorithm) throw new Error("Malformed SSH public key.");
  const parsed = utils.parseKey(`${algorithm} ${encoded}`);
  if (parsed instanceof Error || parsed.type !== algorithm || !parsed.getPublicSSH().equals(blob)) throw new Error("Malformed SSH public key.");
  return blob;
}

function readPolicyFile(filename: string, label: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    const before = process.platform === "win32" ? lstatSync(filename) : undefined;
    if (before?.isSymbolicLink()) throw new Error();
    descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes || (before && (stat.dev !== before.dev || stat.ino !== before.ino))) throw new Error();
    const contents = readFileSync(descriptor);
    if (contents.length > maximumBytes) throw new Error();
    if (before) {
      const after = lstatSync(filename);
      if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error();
    }
    return contents;
  } catch (error) {
    if (descriptor === undefined && error instanceof Error && "code" in error && error.code === "ENOENT") throw error;
    throw new Error(`${label} is unavailable or not a regular bounded file.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function rsaModulusBits(key: Buffer): number | null {
  let offset = 0;
  const readField = (): Buffer => {
    if (offset + 4 > key.length) throw new Error();
    const length = key.readUInt32BE(offset);
    offset += 4;
    if (length > key.length - offset) throw new Error();
    const field = key.subarray(offset, offset + length);
    offset += length;
    return field;
  };
  try {
    if (readField().toString("ascii") !== "ssh-rsa") return null;
    readField();
    const modulus = readField();
    if (offset !== key.length) throw new Error();
    let first = 0;
    while (first < modulus.length && modulus[first] === 0) first++;
    if (first === modulus.length) throw new Error();
    let highBits = 8;
    let leading = modulus[first];
    while ((leading & 0x80) === 0) { highBits--; leading <<= 1; }
    return (modulus.length - first - 1) * 8 + highBits;
  } catch {
    throw new Error("The RSA host key could not be validated against RequiredRSASize.");
  }
}

function knownHostKeys(server: SshConfig): { accepted: Set<string>; acceptedIp: Set<string>; revoked: Set<string> } {
  const accepted = new Set<string>();
  const acceptedIp = new Set<string>();
  const revoked = new Set<string>();
  for (const filename of server.knownHosts) {
    let contents: Buffer;
    try { contents = readPolicyFile(filename, "The configured known_hosts file", 32 * 1024 * 1024); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Unable to read the configured known_hosts file.");
    }
    const content = contents.toString("utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const fields = trimmed.split(/\s+/);
      const marker = fields[0].startsWith("@") ? fields.shift() : undefined;
      if (marker === "@revoked") {
        const revokedHosts = fields[0];
        if (!revokedHosts || !hostMatches(revokedHosts, server.revokedHostNames)) continue;
        if (fields.length < 3 || !fields[1] || !fields[2]) throw new Error("A matching @revoked known_hosts entry is malformed. Password authentication is blocked.");
      } else if (fields.length < 3) continue;
      const [hosts, algorithm, key] = fields;
      if (!hosts || !algorithm || !key) continue;
      const acceptedMatch = hostMatches(hosts, server.acceptedHostNames);
      const acceptedIpMatch = server.checkHostIp && hostMatches(hosts, server.ipHostNames);
      const revokedMatch = hostMatches(hosts, server.revokedHostNames);
      if ((marker === "@revoked" && revokedMatch) || (!marker && (acceptedMatch || acceptedIpMatch))) {
        let blob: Buffer;
        try { blob = parsePublicKeyBlob(algorithm, key); }
        catch { throw new Error("A matching known_hosts entry is malformed. Password authentication is blocked."); }
        if (marker === "@revoked") revoked.add(blob.toString("base64"));
        else {
          if (acceptedMatch) accepted.add(blob.toString("base64"));
          if (acceptedIpMatch) acceptedIp.add(blob.toString("base64"));
        }
      }
    }
  }
  if (!accepted.size) throw new Error("This host is not in the configured known_hosts file. Verify its fingerprint with OpenSSH, then retry.");
  if (server.checkHostIp && !acceptedIp.size) throw new Error("The connected IP address is not in the configured known_hosts file. Verify its fingerprint with OpenSSH, then retry.");
  return { accepted, acceptedIp, revoked };
}

function checkRevokedHostKey(key: Buffer, files: string[]): boolean {
  if (!files.length) return false;
  if (key.length < 4) throw new Error("SSH host key format could not be checked against the revocation policy.");
  const algorithmLength = key.readUInt32BE(0);
  if (algorithmLength < 1 || algorithmLength > key.length - 4) throw new Error("SSH host key format could not be checked against the revocation policy.");
  const algorithm = key.subarray(4, 4 + algorithmLength).toString("ascii");
  const publicKeyPath = path.join(os.tmpdir(), `subagent-hostkey-${randomUUID()}.pub`);
  for (const filename of files) {
    const contents = readPolicyFile(filename, "A configured revoked-host-key file", 16 * 1024 * 1024);
    if (!contents.subarray(0, Buffer.byteLength("SSHKRL\n")).equals(Buffer.from("SSHKRL\n"))) {
      for (const line of contents.toString("utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const fields = trimmed.split(/\s+/);
        if (fields.length < 2) throw new Error("The text host-key revocation list is malformed. Password authentication is blocked.");
        const revokedAlgorithm = fields[0];
        let decoded: Buffer;
        try { decoded = parsePublicKeyBlob(revokedAlgorithm, fields[1]); }
        catch { throw new Error("The text host-key revocation list is malformed. Password authentication is blocked."); }
        if (decoded.equals(key)) return true;
      }
      continue;
    }
    const krlPath = path.join(os.tmpdir(), `subagent-hostrevocations-${randomUUID()}.krl`);
    try {
      writeFileSync(krlPath, contents, { flag: "wx", mode: 0o600 });
      writeFileSync(publicKeyPath, `${algorithm} ${key.toString("base64")}\n`, { flag: "wx", mode: 0o600 });
      const result = spawnSync("ssh-keygen", ["-Q", "-f", krlPath, publicKeyPath], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      if (result.error || result.status === null || (result.status !== 0 && result.status !== 1)) {
        throw new Error("The configured host-key revocation policy could not be evaluated. Password authentication is blocked.");
      }
      if (result.status === 1) return true;
    } finally {
      try { rmSync(publicKeyPath, { force: true }); } catch { /* The one-use public-key file contains no secret. */ }
      try { rmSync(krlPath, { force: true }); } catch { /* The temporary KRL copy contains only public keys. */ }
    }
  }
  return false;
}

export async function runPasswordSsh(server: SshServer, command: string, input: Buffer | undefined, timeoutMs = 30_000): Promise<ProcessResult> {
  const config = await pinCheckHostIp(resolveConfig(server));
  const hostKeys = knownHostKeys(config);
  const password = getSshPassword(server, config.destinationId);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let commandStarted = false;
    let timer: NodeJS.Timeout;
    let stdoutSize = 0;
    let stderrSize = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const finish = (error?: Error, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(result!);
    };
    timer = setTimeout(() => finish(new Error(commandStarted ? "SSH_REMOTE_STATUS_UNCONFIRMED" : "SSH connection timed out.")), timeoutMs);
    client.once("error", (error) => finish(error.message.toLowerCase().includes("host key")
      ? new Error("SSH host key verification failed. Verify the fingerprint with OpenSSH and update known_hosts.")
      : new Error(commandStarted ? "SSH_REMOTE_STATUS_UNCONFIRMED" : "SSH connection or password authentication failed.")));
    client.once("ready", () => {
      commandStarted = true;
      client.exec(command, { pty: false }, (error, channel) => {
        if (error) { finish(new Error("SSH could not start the remote command.")); return; }
        channel.on("data", (chunk: Buffer) => {
          const keep = Math.max(0, MAX_OUTPUT_BYTES - stdoutSize);
          if (keep) stdout.push(chunk.subarray(0, keep));
          stdoutSize += chunk.length;
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          const keep = Math.max(0, MAX_OUTPUT_BYTES - stderrSize);
          if (keep) stderr.push(chunk.subarray(0, keep));
          stderrSize += chunk.length;
        });
        channel.once("error", () => finish(new Error(commandStarted ? "SSH_REMOTE_STATUS_UNCONFIRMED" : "SSH remote command channel failed.")));
        channel.once("close", (code: number | null) => {
          const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
          if (code === 0) finish(undefined, result);
          else {
            const detail = result.stderr.toLowerCase();
            const markers = ["REMOTE_NODE_MISSING", "REMOTE_CODEX_MISSING", "REMOTE_TAR_MISSING", "REMOTE_FLOCK_MISSING", "REMOTE_CMP_MISSING", "SYNC_PARTIAL", "ROLLBACK_FAILED", "PLUGIN_INSTALL_UNVERIFIED", "PROFILE_CHANGED_DURING_SYNC", "PROFILE_LOCK_BUSY"];
            const marker = markers.find((value) => detail.includes(value.toLowerCase()));
            if (marker) finish(new Error(marker));
            else if (detail.includes("another subagent config sync")) finish(new Error("REMOTE_SYNC_LOCKED"));
            else finish(new Error("SSH_REMOTE_STATUS_UNCONFIRMED"));
          }
        });
        if (input) channel.stdin.end(input);
        else channel.stdin.end();
      });
    });
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      algorithms: { serverHostKey: config.hostKeyAlgorithms, kex: config.kexAlgorithms, cipher: config.ciphers, hmac: config.macs, compress: config.compression },
      password,
      authHandler: ["none", "password"],
      tryKeyboard: false,
      readyTimeout: 15_000,
      agentForward: false,
      forceIPv4: config.addressFamily === "inet",
      forceIPv6: config.addressFamily === "inet6",
      hostVerifier: (key: Buffer) => {
        const fingerprint = key.toString("base64");
        const rsaBits = rsaModulusBits(key);
        return (rsaBits === null || rsaBits >= config.requiredRsaSize)
          && !hostKeys.revoked.has(fingerprint) && hostKeys.accepted.has(fingerprint)
          && (!config.checkHostIp || hostKeys.acceptedIp.has(fingerprint))
          && !checkRevokedHostKey(key, config.revokedHostKeys);
      },
    });
  });
}
