import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function withFileLockSync<T>(filePath: string, action: () => T, timeoutMs = 30_000): T {
  const lock = `${filePath}.lock`;
  const owner = path.join(lock, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let created = false;
    try {
      mkdirSync(lock, { mode: 0o700 });
      created = true;
      writeFileSync(owner, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (created) {
        try { unlinkSync(owner); } catch { /* Owner creation may have failed before creating the file. */ }
        try { rmdirSync(lock); } catch { /* Preserve the original owner-record error. */ }
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = lstatSync(lock);
        if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) throw new Error("The file lock path is unsafe.");
      } catch (lockError) {
        if (lockError instanceof Error && lockError.message.includes("lock path is unsafe")) throw lockError;
      }
      if (Date.now() >= deadline) throw new Error("The file is busy in another plugin process. If it stays locked after all Codex processes exit, remove its .lock directory and retry.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return action(); }
  finally {
    try {
      const lockOwner = JSON.parse(readFileSync(owner, "utf8")) as { token?: string };
      if (lockOwner.token === token) { unlinkSync(owner); rmdirSync(lock); }
    } catch { /* Leave a lock for stale-owner recovery rather than deleting an unknown path. */ }
  }
}
