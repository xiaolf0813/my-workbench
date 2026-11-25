import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import { PathResolver } from "../infrastructure/path-resolver.js";
import { withFileLockSync } from "../infrastructure/file-lock.js";

const STORE_NAME = "my-workbench-ssh-servers.json";
const KEYRING_SERVICE = "Subagent Config SSH";
const HOST_PATTERN = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])$/;

export type SshAuthentication = "agent" | "key-file" | "password";
export type SshServer = {
  id: string;
  name: string;
  target: string;
  port?: number;
  codexHome: string;
  authentication: SshAuthentication;
  keyFilePath?: string;
  credentialGeneration?: string;
  passwordDestination?: string;
};

type CredentialReference = { id: string; target: string; port?: number; credentialGeneration?: string };
type StoreData = { schemaVersion: 1; servers: SshServer[]; pendingCredentialCleanup: CredentialReference[] };
export type SshServerInput = Omit<SshServer, "id" | "credentialGeneration" | "passwordDestination"> & { id?: string };

function storePath(): string {
  return path.join(new PathResolver().codexHome, STORE_NAME);
}

function readStore(): StoreData {
  const filename = storePath();
  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8")) as StoreData;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.servers)) throw new Error();
    const pendingCredentialCleanup = Array.isArray(parsed.pendingCredentialCleanup)
      ? parsed.pendingCredentialCleanup.filter((item): item is CredentialReference => Boolean(item && typeof item === "object" && !Array.isArray(item)
        && typeof item.id === "string" && typeof item.target === "string"
        && (item.port === undefined || Number.isInteger(item.port))
        && (item.credentialGeneration === undefined || typeof item.credentialGeneration === "string")))
      : [];
    return { ...parsed, pendingCredentialCleanup };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, servers: [], pendingCredentialCleanup: [] };
    throw new Error("The saved SSH server list is invalid. Keep the file for recovery and repair its JSON before continuing.");
  }
}

function withStoreLock<T>(action: () => T): T {
  const filename = storePath();
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  return withFileLockSync(filename, action);
}

function credentialReference(server: SshServer): CredentialReference {
  return { id: server.id, target: server.target, ...(server.port !== undefined ? { port: server.port } : {}), ...(server.credentialGeneration ? { credentialGeneration: server.credentialGeneration } : {}) };
}

function cleanupPendingLocked(data: StoreData): void {
  const pending = new Map(data.pendingCredentialCleanup.map((item) => [JSON.stringify(item), item]));
  const activeAccounts = new Set(data.servers.filter((server) => server.authentication === "password").map(credentialAccount));
  for (const [key, reference] of pending) {
    const account = credentialAccount({ ...reference, name: "", codexHome: "", authentication: "password" });
    if (activeAccounts.has(account)) { pending.delete(key); continue; }
    try { removeCredentialAccount(account); pending.delete(key); } catch { /* Keep the retired generation queued for a later retry. */ }
  }
  if (pending.size !== data.pendingCredentialCleanup.length) writeStore({ ...data, pendingCredentialCleanup: [...pending.values()] });
}

function writeStore(data: StoreData): void {
  const filename = storePath();
  const directory = path.dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, filename);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Keep the original write error. */ }
    throw error;
  }
}

function credentialEntry(account: string): KeyringEntry {
  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bindings = path.join(runtimeDirectory, "keyring", "bindings");
  const binary = process.platform === "win32" && process.arch === "x64" ? "keyring.win32-x64-msvc.node"
      : process.platform === "darwin" && process.arch === "x64" ? "keyring.darwin-x64.node"
        : process.platform === "darwin" && process.arch === "arm64" ? "keyring.darwin-arm64.node"
          : process.platform === "linux" && process.arch === "x64" ? "keyring.linux-x64-gnu.node"
            : process.platform === "linux" && process.arch === "arm64" ? "keyring.linux-arm64-gnu.node"
              : null;
  if (!binary) throw new Error(`System credential storage is not packaged for ${process.platform}/${process.arch}.`);
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(bindings, binary);
  const require = createRequire(import.meta.url);
  const { Entry } = require(path.join(runtimeDirectory, "keyring", "index.cjs")) as { Entry: new (service: string, username: string, options?: { linux?: { store: string } }) => KeyringEntry };
  return new Entry(KEYRING_SERVICE, account, { linux: { store: "secret-service" } });
}

function credentialAccount(server: SshServer): string {
  const scope = path.resolve(new PathResolver().codexHome);
  return createHash("sha256").update(JSON.stringify([scope, server.id, server.target, server.port ?? null, server.credentialGeneration ?? "legacy"])).digest("hex");
}

function readCredential(account: string): string | null {
  try { return credentialEntry(account).getPassword(); }
  catch (error) { throw keyringError(error); }
}

function keyringError(error: unknown): Error {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  if (process.platform === "linux") {
    return new Error(detail.includes("secret") || detail.includes("dbus")
      ? "Linux Secret Service is unavailable. Unlock or install a Secret Service keyring, then retry."
      : "Unable to access the Linux Secret Service keyring.");
  }
  return new Error("Unable to access the system credential store.");
}

export function listSshServers(): SshServer[] {
  return readStore().servers;
}

export function getSshServer(id: string): SshServer {
  const server = readStore().servers.find((item) => item.id === id);
  if (!server) throw new Error("The selected SSH server no longer exists. Refresh the server list.");
  return server;
}

export function saveSshServer(input: SshServerInput): SshServer {
  const name = input.name.trim();
  const target = input.target.trim();
  if (!name || name.length > 80) throw new Error("Enter a server name of at most 80 characters.");
  if (!HOST_PATTERN.test(target) || target.length > 255 || target.startsWith("-")) {
    throw new Error("Enter an SSH host alias or user@host using letters, numbers, dots, underscores, or hyphens.");
  }
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    throw new Error("SSH port must be an integer from 1 to 65535.");
  }
  const codexHome = input.codexHome.trim() || "~/.codex";
  if (codexHome.length > 1024 || /[\r\n\0]/.test(codexHome)) throw new Error("Remote CODEX_HOME contains invalid characters.");
  if (!["agent", "key-file", "password"].includes(input.authentication)) throw new Error("Choose a supported SSH authentication method.");
  const keyFilePath = input.authentication === "key-file" ? input.keyFilePath?.trim() : undefined;
  if (input.authentication === "key-file" && (!keyFilePath || keyFilePath.length > 2048 || /[\r\n\0]/.test(keyFilePath)
    || (!path.isAbsolute(keyFilePath) && !/^~[/\\]/.test(keyFilePath)))) {
    throw new Error("Choose a valid private key file path.");
  }

  return withStoreLock(() => {
  const current = readStore();
  const previous = input.id ? current.servers.find((item) => item.id === input.id) : undefined;
  if (input.id && !previous) throw new Error("The SSH server no longer exists. Refresh the list before editing.");
  const id = previous?.id ?? randomUUID();
  const pendingCredentialCleanup = [...current.pendingCredentialCleanup];
  const passwordBindingChanged = previous?.authentication === "password" && (previous.target !== target || previous.port !== input.port || input.authentication !== "password" || !previous.credentialGeneration);
  if (passwordBindingChanged) {
    pendingCredentialCleanup.push(credentialReference(previous));
  }
  const server: SshServer = {
    id,
    name,
    target,
    ...(input.port !== undefined ? { port: input.port } : {}),
    codexHome,
    authentication: input.authentication,
    ...(keyFilePath ? { keyFilePath } : {}),
    ...(input.authentication === "password" ? {
      credentialGeneration: !passwordBindingChanged && previous?.authentication === "password" ? previous.credentialGeneration ?? randomUUID() : randomUUID(),
      ...(!passwordBindingChanged && previous?.authentication === "password" && previous.passwordDestination ? { passwordDestination: previous.passwordDestination } : {}),
    } : {}),
  };
  const servers = previous ? current.servers.map((item) => item.id === id ? server : item) : [...current.servers, server];
  const updated = { schemaVersion: 1 as const, servers, pendingCredentialCleanup: [...new Set(pendingCredentialCleanup)] };
  writeStore(updated);
  cleanupPendingLocked(updated);
  return server;
  });
}

export function deleteSshServer(id: string): void {
  withStoreLock(() => {
    const current = readStore();
    const server = current.servers.find((item) => item.id === id);
    if (!server) return;
    const pending = [...current.pendingCredentialCleanup];
    if (server.authentication === "password") pending.push(credentialReference(server));
    const updated = { ...current, servers: current.servers.filter((item) => item.id !== id), pendingCredentialCleanup: [...new Set(pending)] };
    writeStore(updated);
    cleanupPendingLocked(updated);
  });
}

export function getSshCredentialKey(id: string): string {
  const server = getSshServer(id);
  if (server.authentication !== "password") throw new Error("Choose password authentication for this SSH server first.");
  return credentialAccount(server);
}

export function storeSshPassword(id: string, password: string, expectedAccount: string, expectedDestination: string): void {
  withStoreLock(() => {
    const current = readStore();
    const server = current.servers.find((item) => item.id === id);
    if (!server || server.authentication !== "password" || credentialAccount(server) !== expectedAccount) {
      throw new Error("This server changed while password entry was open. Reopen the password form and try again.");
    }
    if (!expectedDestination || expectedDestination.length > 2048 || /[\r\n\0]/.test(expectedDestination)) throw new Error("The SSH destination could not be verified.");
    if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw new Error("Enter a valid SSH password.");
    if (Buffer.byteLength(password, "utf8") > 4096) throw new Error("SSH passwords may contain at most 4096 UTF-8 bytes.");
    const nextServer = { ...server, credentialGeneration: randomUUID(), passwordDestination: expectedDestination };
    const nextAccount = credentialAccount(nextServer);
    const nextReference = credentialReference(nextServer);
    const staged: StoreData = { ...current, pendingCredentialCleanup: [...current.pendingCredentialCleanup, nextReference] };
    writeStore(staged);
    try { credentialEntry(nextAccount).setPassword(password); }
    catch (error) { cleanupPendingLocked(staged); throw keyringError(error); }
    let confirmedPassword: string | null;
    try { confirmedPassword = readCredential(nextAccount); }
    catch (error) { cleanupPendingLocked(staged); throw error; }
    if (confirmedPassword !== password) {
      cleanupPendingLocked(staged);
      throw new Error("The system credential store did not confirm the saved password.");
    }
    const updated: StoreData = {
      ...current,
      servers: current.servers.map((item) => item.id === id ? nextServer : item),
      pendingCredentialCleanup: [...current.pendingCredentialCleanup, credentialReference(server)],
    };
    writeStore(updated);
    cleanupPendingLocked(updated);
  });
}

export function getSshPassword(snapshot: SshServer, destination: string): string {
  const current = readStore().servers.find((item) => item.id === snapshot.id);
  if (!current || current.authentication !== "password" || credentialAccount(current) !== credentialAccount(snapshot)
    || current.passwordDestination !== destination || snapshot.passwordDestination !== destination) {
    throw new Error("The SSH destination or saved credentials changed. Confirm the server settings and save its password again.");
  }
  const password = readCredential(credentialAccount(snapshot));
  if (password === null) throw new Error("No password is saved for this SSH server. Save it again before syncing.");
  return password;
}

export function assertPasswordServer(id: string): void {
  if (getSshServer(id).authentication !== "password") throw new Error("Choose password authentication for this SSH server first.");
}

export function removeSshPassword(id: string): void {
  const server = getSshServer(id);
  if (server.authentication === "password") removeCredentialAccount(credentialAccount(server));
}

function removeCredentialAccount(account: string): void {
  try {
    const entry = credentialEntry(account);
    const existing = entry.getPassword();
    if (existing === null) return;
    const removed = entry.deletePassword();
    if (removed === false || entry.getPassword() !== null) throw new Error("Credential deletion was not confirmed.");
  } catch (error) {
    if (error instanceof Error && error.message === "Credential deletion was not confirmed.") throw error;
    throw keyringError(error);
  }
}

export function getSshPasswordStatus(id: string): { saved: boolean; available: boolean } {
  try { return { saved: readCredential(getSshCredentialKey(id)) !== null, available: true }; }
  catch { return { saved: false, available: false }; }
}
