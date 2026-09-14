import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/api-contract.js";
import type {
  InteractionBindingAttempt,
  TmuxKey,
} from "../domain/session-domain.js";

export { MAX_INTERACTION_MESSAGE_BYTES };
export const MAX_TERMINAL_PREVIEW_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface TmuxBinding {
  readonly socketPath: string;
  readonly serverStartTime: string;
  readonly paneId: string;
  readonly panePid: string;
}

export interface TmuxCommandRunner {
  run(
    socketPath: string,
    args: readonly string[],
    input: string | undefined,
    timeoutMs: number,
    options?: TmuxCommandOptions,
  ): Promise<{ readonly stdout: string; readonly truncated?: boolean }>;
}

export interface TmuxCommandOptions {
  readonly maxOutputBytes: number;
  readonly truncateStart: boolean;
}

export class TmuxInteractionError extends Error {
  constructor(
    readonly code: "disconnected" | "timeout" | "command_failed" | "invalid_message",
    message: string,
  ) {
    super(message);
    this.name = "TmuxInteractionError";
  }
}

export class TmuxInteractionService {
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    private readonly runner: TmuxCommandRunner = new SpawnTmuxCommandRunner(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async connect(attempt: InteractionBindingAttempt): Promise<TmuxBinding> {
    if (!attempt.valid) throw disconnected();
    await validateSocket(attempt.socketPath);
    const identity = await this.#display(attempt.socketPath, attempt.paneId);
    return {
      socketPath: attempt.socketPath,
      serverStartTime: identity.serverStartTime,
      paneId: identity.paneId,
      panePid: identity.panePid,
    };
  }

  sendMessage(binding: TmuxBinding, message: string): Promise<void> {
    const normalized = normalizeMessage(message);
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      const bufferName = `codex-viewer-${process.pid}-${randomUUID()}`;
      let bufferMayExist = true;
      try {
        await this.#run(binding, ["load-buffer", "-b", bufferName, "-"], normalized);
        await this.#run(binding, [
          "paste-buffer", "-p", "-d", "-b", bufferName, "-t", binding.paneId,
        ]);
        bufferMayExist = false;
        await this.#run(binding, ["send-keys", "-t", binding.paneId, "Enter"]);
      } finally {
        if (bufferMayExist) {
          try {
            await this.#run(binding, ["delete-buffer", "-b", bufferName]);
          } catch {
            // Preserve the original failure; the buffer may not exist or may already be deleted.
          }
        }
      }
    });
  }

  sendKeys(binding: TmuxBinding, keys: readonly TmuxKey[]): Promise<void> {
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      await this.#run(binding, ["send-keys", "-t", binding.paneId, ...keys]);
    });
  }

  captureTerminal(binding: TmuxBinding): Promise<{
    readonly content: string;
    readonly truncated: boolean;
  }> {
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      const result = await this.runner.run(
        binding.socketPath,
        ["capture-pane", "-p", "-t", binding.paneId],
        undefined,
        this.timeoutMs,
        { maxOutputBytes: MAX_TERMINAL_PREVIEW_BYTES, truncateStart: true },
      );
      return { content: result.stdout, truncated: result.truncated === true };
    });
  }

  async #revalidate(binding: TmuxBinding): Promise<void> {
    await validateSocket(binding.socketPath);
    const current = await this.#display(binding.socketPath, binding.paneId);
    if (
      current.serverStartTime !== binding.serverStartTime ||
      current.paneId !== binding.paneId ||
      current.panePid !== binding.panePid
    ) {
      throw disconnected();
    }
  }

  async #display(socketPath: string, paneId: string) {
    let result: { readonly stdout: string };
    try {
      result = await this.runner.run(
        socketPath,
        [
          "display-message", "-p", "-t", paneId,
          "#{start_time}|#{pane_id}|#{pane_pid}|#{pane_dead}",
        ],
        undefined,
        this.timeoutMs,
      );
    } catch (error) {
      if (error instanceof TmuxInteractionError && error.code === "timeout") throw error;
      throw disconnected();
    }
    const [serverStartTime, actualPaneId, panePid, paneDead, ...extra] =
      result.stdout.trimEnd().split("|");
    if (
      extra.length > 0 ||
      !/^\d+$/.test(serverStartTime ?? "") ||
      !/^%\d+$/.test(actualPaneId ?? "") ||
      !/^\d+$/.test(panePid ?? "") ||
      paneDead !== "0" ||
      actualPaneId !== paneId
    ) {
      throw disconnected();
    }
    return { serverStartTime: serverStartTime!, paneId: actualPaneId!, panePid: panePid! };
  }

  async #run(
    binding: TmuxBinding,
    args: readonly string[],
    input?: string,
  ): Promise<void> {
    await this.runner.run(binding.socketPath, args, input, this.timeoutMs);
  }

  #serialize<T>(binding: TmuxBinding, operation: () => Promise<T>): Promise<T> {
    const key = `${binding.socketPath}\0${binding.paneId}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.#queues.set(key, settled);
    void settled.finally(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return current;
  }
}

export function normalizeMessage(message: string): string {
  const normalized = message.replace(/\r\n?/g, "\n");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (normalized.trim().length === 0) {
    throw new TmuxInteractionError("invalid_message", "message must not be blank");
  }
  if (bytes > MAX_INTERACTION_MESSAGE_BYTES) {
    throw new TmuxInteractionError(
      "invalid_message",
      `message must not exceed ${MAX_INTERACTION_MESSAGE_BYTES} UTF-8 bytes`,
    );
  }
  return normalized;
}

async function validateSocket(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isSocket() || currentUid === null || info.uid !== currentUid) throw disconnected();
  } catch (error) {
    if (error instanceof TmuxInteractionError) throw error;
    throw disconnected();
  }
}

function disconnected(): TmuxInteractionError {
  return new TmuxInteractionError("disconnected", "tmux target is not connected");
}

export class SpawnTmuxCommandRunner implements TmuxCommandRunner {
  run(
    socketPath: string,
    args: readonly string[],
    input: string | undefined,
    timeoutMs: number,
    options?: TmuxCommandOptions,
  ): Promise<{ readonly stdout: string; readonly truncated?: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn("tmux", ["-S", socketPath, ...args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout: Buffer = Buffer.alloc(0);
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let truncated = false;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new TmuxInteractionError(
          "timeout",
          "tmux operation timed out; the result is unknown",
        )));
      }, timeoutMs);
      const collectStdout = (chunk: Buffer) => {
        if (options?.truncateStart) {
          stdout = Buffer.concat([stdout, chunk]);
          if (stdout.byteLength > options.maxOutputBytes) {
            stdout = trimLeadingPartialUtf8(
              stdout.subarray(stdout.byteLength - options.maxOutputBytes),
            );
            truncated = true;
          }
          return;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) stdout = Buffer.concat([stdout, chunk]);
        else child.kill("SIGKILL");
      };
      const collectStderr = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) stderr.push(chunk);
        else child.kill("SIGKILL");
      };
      child.stdout.on("data", collectStdout);
      child.stderr.on("data", collectStderr);
      child.once("error", (error) => finish(() => reject(
        new TmuxInteractionError("command_failed", error.message),
      )));
      child.stdin.once("error", (error) => finish(() => reject(
        new TmuxInteractionError("command_failed", error.message),
      )));
      child.once("close", (code) => finish(() => {
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES || code !== 0) {
          reject(new TmuxInteractionError(
            "command_failed",
            Buffer.concat(stderr).toString("utf8").trim() || "tmux command failed",
          ));
          return;
        }
        resolve({ stdout: stdout.toString("utf8"), truncated });
      }));
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input, "utf8");
    });
  }
}

function trimLeadingPartialUtf8(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}
