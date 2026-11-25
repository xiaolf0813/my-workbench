import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSshCredentialKey, getSshServer, storeSshPassword } from "./ssh-server-store.js";
import { resolvePasswordSshBinding } from "./password-ssh-transport.js";

const MAX_BODY_BYTES = 8 * 1024;
const TICKET_LIFETIME_MS = 90_000;
type CredentialTicket = { serverId: string; account: string; destination: string; origin: string; proofKey: Buffer; encryptionKey: Buffer; nonce?: string; expiresAt: number };
const tickets = new Map<string, CredentialTicket>();
let endpoint: Promise<{ port: number }> | null = null;

function send(request: IncomingMessage, response: ServerResponse, status: number, body: string, ticket?: CredentialTicket): void {
  const headers: Record<string, string | number> = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "60",
    Vary: "Origin",
  };
  if (ticket && request.headers.origin === ticket.origin) headers["Access-Control-Allow-Origin"] = ticket.origin;
  response.writeHead(status, headers);
  response.end(body);
}

function parseBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let requestUrl: URL;
  try { requestUrl = new URL(request.url ?? "/", "http://127.0.0.1"); }
  catch { send(request, response, 400, JSON.stringify({ error: "Invalid request." })); return; }
  const token = requestUrl.searchParams.get("ticket") ?? "";
  const ticket = tickets.get(token);
  if (!ticket || ticket.expiresAt < Date.now() || request.headers.origin !== ticket.origin) {
    send(request, response, 403, JSON.stringify({ error: "Credential entry expired. Reopen the password form and try again." }));
    return;
  }
  if (request.method === "OPTIONS" && requestUrl.pathname === "/credential") {
    send(request, response, 204, "", ticket);
    return;
  }
  if (request.method !== "POST" || requestUrl.pathname !== "/credential") {
    send(request, response, 404, JSON.stringify({ error: "Not found." }), ticket);
    return;
  }
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "text/plain") {
    send(request, response, 415, JSON.stringify({ error: "Unsupported request." }), ticket);
    return;
  }
  try {
    const body = JSON.parse(await parseBody(request)) as { phase?: unknown; nonce?: unknown; ciphertext?: unknown; iv?: unknown; proof?: unknown };
    if (body.phase === "challenge" && typeof body.nonce === "string" && body.nonce.length >= 16 && body.nonce.length <= 128) {
      ticket.nonce = body.nonce;
      const proof = createHmac("sha256", ticket.proofKey).update(`server\n${token}\n${body.nonce}`).digest("base64url");
      send(request, response, 200, JSON.stringify({ proof }), ticket);
      return;
    }
    if (body.phase !== "save" || typeof body.ciphertext !== "string" || typeof body.iv !== "string" || typeof body.nonce !== "string" || typeof body.proof !== "string" || !ticket.nonce || body.nonce !== ticket.nonce) {
      send(request, response, 400, JSON.stringify({ error: "Credential request is incomplete." }), ticket);
      return;
    }
    const expectedProof = createHmac("sha256", ticket.proofKey).update(`client\n${token}\n${body.nonce}`).digest();
    const suppliedProof = Buffer.from(body.proof, "base64url");
    if (suppliedProof.length !== expectedProof.length || !timingSafeEqual(suppliedProof, expectedProof)) {
      send(request, response, 403, JSON.stringify({ error: "Credential channel verification failed. Reopen the password form and try again." }), ticket);
      return;
    }
    if (!/^[A-Za-z0-9_-]{16,11000}$/.test(body.ciphertext) || !/^[A-Za-z0-9_-]{16}$/.test(body.iv)) {
      send(request, response, 400, JSON.stringify({ error: "Encrypted credential payload is invalid." }), ticket);
      return;
    }
    const encrypted = Buffer.from(body.ciphertext, "base64url");
    const iv = Buffer.from(body.iv, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", ticket.encryptionKey, iv);
    decipher.setAAD(Buffer.from(`${token}\n${body.nonce}`));
    decipher.setAuthTag(encrypted.subarray(-16));
    const password = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
    if (tickets.get(token) !== ticket || ticket.expiresAt < Date.now()) {
      send(request, response, 403, JSON.stringify({ error: "Credential entry expired. Reopen the password form and try again." }), ticket);
      return;
    }
    if (resolvePasswordSshBinding(getSshServer(ticket.serverId)) !== ticket.destination) {
      send(request, response, 409, JSON.stringify({ error: "The SSH destination changed while password entry was open. Reopen the form and try again." }), ticket);
      return;
    }
    tickets.delete(token);
    storeSshPassword(ticket.serverId, password, ticket.account, ticket.destination);
    send(request, response, 200, JSON.stringify({ saved: true }), ticket);
  } catch (error) {
    send(request, response, 400, JSON.stringify({ error: error instanceof Error ? error.message : "Unable to save the credential." }), ticket);
  }
}

function startEndpoint(): Promise<{ port: number }> {
  if (endpoint) return endpoint;
  endpoint = new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) send(request, response, 400, JSON.stringify({ error: "Unable to process the credential request." }));
        else response.destroy();
      });
    });
    server.on("error", (error) => { endpoint = null; reject(error); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        endpoint = null;
        reject(new Error("Unable to start the local credential channel."));
        return;
      }
      resolve({ port: address.port });
    });
  });
  return endpoint;
}

export async function beginSshPasswordEntry(serverId: string, origin: string): Promise<{ url: string; ticket: string; proofKey: string; encryptionKey: string }> {
  if (origin.length > 256 || /[\r\n\0]/.test(origin)) throw new Error("The password form origin is invalid.");
  const server = getSshServer(serverId);
  const { port } = await startEndpoint();
  const ticket = randomBytes(32).toString("base64url");
  const proofKey = randomBytes(32);
  const encryptionKey = randomBytes(32);
  const account = getSshCredentialKey(serverId);
  const destination = resolvePasswordSshBinding(server);
  tickets.set(ticket, { serverId, account, destination, origin, proofKey, encryptionKey, expiresAt: Date.now() + TICKET_LIFETIME_MS });
  for (const [value, entry] of tickets) if (entry.expiresAt < Date.now()) tickets.delete(value);
  while (tickets.size > 100) tickets.delete(tickets.keys().next().value!);
  return { url: `http://127.0.0.1:${port}/credential?ticket=${encodeURIComponent(ticket)}`, ticket, proofKey: proofKey.toString("base64url"), encryptionKey: encryptionKey.toString("base64url") };
}
