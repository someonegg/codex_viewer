import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionIndexReader } from "../../src/server/adapters/codex/session-index-reader.js";
import { MAX_SESSION_TITLE_CHARS } from "../../src/server/domain/session-text.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("SessionIndexReader", () => {
  it("aggregates the last complete valid thread name for each id", async () => {
    const home = await createTempDirectory("codex-session-index-");
    const longName = "Long nickname ".repeat(12);
    await writeFile(join(home, "session_index.jsonl"), [
      JSON.stringify({ id: "one", thread_name: "First", updated_at: "ignored" }),
      "not json",
      JSON.stringify({ id: "one", thread_name: "  " }),
      JSON.stringify({ id: 2, thread_name: "Wrong id type" }),
      JSON.stringify({ id: "two", thread_name: `\n ${longName}\nIgnored` }),
      JSON.stringify({ id: "one", thread_name: "Last valid" }),
      JSON.stringify({ id: "one", thread_name: "Incomplete tail" }),
    ].join("\n"));
    const reader = new SessionIndexReader(home);

    await reader.refresh();

    expect(reader.threadName("one")).toBe("Last valid");
    expect(reader.threadName("two")).toBe(longName.trim().slice(0, MAX_SESSION_TITLE_CHARS));
    expect(reader.threadName("missing")).toBeNull();
  });

  it("treats a missing index as an empty advisory source and recovers later", async () => {
    const home = await createTempDirectory("codex-session-index-missing-");
    const reader = new SessionIndexReader(home);

    await expect(reader.refresh()).resolves.toBeUndefined();
    expect(reader.threadName("session")).toBeNull();

    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ id: "session", thread_name: "Recovered" })}\n`,
    );
    await reader.refresh();

    expect(reader.threadName("session")).toBe("Recovered");
  });
});
