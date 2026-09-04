import { open } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSessionTitle } from "../../domain/session-text.js";
import { MAX_JSONL_LINE_BYTES } from "./limits.js";

interface SessionIndexFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
}

export class SessionIndexReader {
  readonly #path: string;
  #fingerprint: SessionIndexFingerprint | null = null;
  #threadNames: ReadonlyMap<string, string> = new Map();

  constructor(codexHome: string) {
    this.#path = join(codexHome, "session_index.jsonl");
  }

  async refresh(): Promise<void> {
    let handle;
    try {
      handle = await open(this.#path, "r");
      const info = await handle.stat();
      const fingerprint = { size: info.size, mtimeMs: info.mtimeMs };
      if (sameFingerprint(this.#fingerprint, fingerprint)) return;
      const threadNames = info.size === 0
        ? new Map<string, string>()
        : await readCompleteRecords(
          handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false }),
        );
      this.#threadNames = threadNames;
      this.#fingerprint = fingerprint;
    } catch {
      this.#threadNames = new Map();
      this.#fingerprint = null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  threadName(id: string): string | null {
    return this.#threadNames.get(id) ?? null;
  }
}

async function readCompleteRecords(
  stream: AsyncIterable<Buffer | string>,
): Promise<Map<string, string>> {
  const threadNames = new Map<string, string>();
  let parts: Buffer[] = [];
  let bytes = 0;
  let droppingOversizedLine = false;

  for await (const rawChunk of stream) {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(cursor, end);
      if (!droppingOversizedLine) {
        if (bytes + part.length <= MAX_JSONL_LINE_BYTES) {
          if (part.length > 0) parts.push(part);
          bytes += part.length;
        } else {
          parts = [];
          bytes = 0;
          droppingOversizedLine = true;
        }
      }
      if (newline === -1) break;
      if (!droppingOversizedLine) consumeLine(Buffer.concat(parts, bytes), threadNames);
      parts = [];
      bytes = 0;
      droppingOversizedLine = false;
      cursor = newline + 1;
    }
  }

  // An unterminated tail may still be in flight, so it is deliberately ignored.
  return threadNames;
}

function consumeLine(line: Buffer, threadNames: Map<string, string>): void {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (!isObject(value)) return;
    const id = nonEmptyString(value.id);
    const threadName = nonEmptyString(value.thread_name);
    if (id === null || threadName === null) return;
    const normalized = normalizeSessionTitle(threadName);
    if (normalized !== null) threadNames.set(id, normalized);
  } catch {
    // session_index.jsonl is advisory; malformed records do not affect sessions.
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFingerprint(
  left: SessionIndexFingerprint | null,
  right: SessionIndexFingerprint,
): boolean {
  return left !== null && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
