type JsonRpcResponse = {
  id?: number | string | null;
  method?: string;
  params?: {
    arguments?: Record<string, unknown>;
  };
  result?: {
    structuredContent?: unknown;
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  error?: { message?: string };
};

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
const projectRootListeners = new Set<(projectRoot: string | null) => void>();
let nextRequestId = 1;
let initialized = false;
let invocationProjectRoot: string | null = null;

function updateInvocationProjectRoot(projectRoot: string | null): void {
  if (projectRoot === invocationProjectRoot) return;
  invocationProjectRoot = projectRoot;
  for (const listener of projectRootListeners) listener(projectRoot);
}

function rejectAll(message: string): void {
  for (const entry of pending.values()) entry.reject(new Error(message));
  pending.clear();
}

function notify(method: string, params: unknown = {}): void {
  window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
}

window.addEventListener("message", (event: MessageEvent) => {
  const source = event.source as WindowProxy | null;
  if (source !== window.parent) return;
  const data = event.data as JsonRpcResponse | undefined;
  if (!data || typeof data !== "object") return;
  if (data.method === "ui/notifications/tool-input") {
    const args = data.params?.arguments;
    if (args && Object.prototype.hasOwnProperty.call(args, "projectRoot")) {
      const value = args.projectRoot;
      updateInvocationProjectRoot(typeof value === "string" && value.trim() ? value.trim() : null);
    }
    return;
  }
  if (!("id" in data)) return;
  if (data.id === null || data.id === undefined) return;
  const entry = pending.get(Number(data.id));
  if (!entry) return;
  pending.delete(Number(data.id));
  if (data.error) {
    entry.reject(new Error(data.error.message || "MCP Apps request failed."));
    return;
  }
  if (data.result?.isError) {
    entry.reject(new Error(data.result.content?.find((part) => part.type === "text")?.text || "MCP tool error."));
    return;
  }
  entry.resolve(data.result?.structuredContent ?? data.result);
});

window.addEventListener("unload", () => rejectAll("UI disconnected."));

async function request(method: string, params?: unknown): Promise<unknown> {
  const id = nextRequestId++;
  const payload = { jsonrpc: "2.0", id, method, params: params ?? {} };
  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.parent.postMessage(payload, "*");
    window.setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("MCP Apps request timed out."));
    }, 15000);
  });
}

export async function initializeMcpApps(): Promise<void> {
  if (initialized) return;
  await request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "codex-agent-model-config-ui", version: "0.1.8" },
    appCapabilities: {},
  });
  notify("ui/notifications/initialized");
  initialized = true;
}

export function getInvocationProjectRoot(): string | null {
  return invocationProjectRoot;
}

export function subscribeInvocationProjectRoot(listener: (projectRoot: string | null) => void): () => void {
  projectRootListeners.add(listener);
  listener(invocationProjectRoot);
  return () => projectRootListeners.delete(listener);
}

export async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await request("tools/call", { name, arguments: args })) as T;
  return result;
}
