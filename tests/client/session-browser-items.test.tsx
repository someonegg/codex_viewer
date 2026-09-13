// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionApp } from "../../src/client/SessionApp";
import { DirectiveItem } from "../../src/client/components/DirectiveItem";
import { InternalEventItem } from "../../src/client/components/InternalEventItem";
import { Timeline } from "../../src/client/components/Timeline";
import { ToolItem } from "../../src/client/components/ToolItem";
import type { ItemPageResponse, LiveRevision, TimelineCursor } from "../../src/shared/api-contract";
import type { TimelineItem } from "../../src/shared/domain";
import {
  baseSession,
  directiveItem,
  json,
  NEXT_TIMELINE_CURSOR,
  SESSION_ID,
  TIMELINE_CURSOR,
  toolItem,
} from "./session-browser.fixtures";
import { installIntersectionObserver, intersectLatest } from "./intersection-observer";

describe("session reader items", () => {
  it("lazily loads and reuses formatted internal JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      itemId: "internal-3",
      json: "{\n  \"type\": \"reasoning\"\n}",
      truncated: true,
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InternalEventItem
      item={{ kind: "internal", id: "internal-3", ordinal: 3, timestamp: null,
        eventType: "reasoning", summary: "must stay hidden", truncated: true }}
      sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR}
      onTimelineConflict={vi.fn()}
    />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("must stay hidden")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show JSON" }));
    expect(await screen.findByText(/\"type\": \"reasoning\"/)).toBeInTheDocument();
    expect(screen.getByText("JSON was truncated for safe display.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Show JSON" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an internal detail timeline conflict", async () => {
    const onTimelineConflict = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: { code: "timeline_changed", message: "Timeline changed" },
    }, 409)));
    render(<InternalEventItem
      item={{ kind: "internal", id: "internal-3", ordinal: 3, timestamp: null,
        eventType: "reasoning", summary: "Internal event: reasoning", truncated: false }}
      sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR}
      onTimelineConflict={onTimelineConflict}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Show JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Internal event unavailable");
    expect(onTimelineConflict).toHaveBeenCalledOnce();
  });

  it("renders inline directives without requesting detail", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DirectiveItem
      item={{ kind: "directive", id: "directive-inline", ordinal: 1, timestamp: null,
        hasDetail: false, text: "Inline policy", charCount: 13 }}
      sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR}
      onTimelineConflict={vi.fn()}
    />);
    expect(screen.getByText("Inline policy")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels tool stages and renders only stage-appropriate detail", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ itemId: "tool-call", input: "args", output: "hidden", truncated: false }))
      .mockResolvedValueOnce(json({ itemId: "tool-output", input: "args", output: "result", truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<>
      <ToolItem item={{ ...toolItem, id: "tool-call", stage: "call" }} sessionId={SESSION_ID}
        cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
      <ToolItem item={{ ...toolItem, id: "tool-output", stage: "output", status: "failed" }} sessionId={SESSION_ID}
        cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
    </>);

    fireEvent.click(screen.getAllByRole("button", { name: "Show tool detail" })[0]!);
    expect(await screen.findByText("args")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("result")).toBeInTheDocument();
    expect(screen.getByText(/Tool output · failed/)).toBeInTheDocument();
  });

  it("opens a session under React StrictMode", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(json(page([message("message-1", 1, "Strict ready")]))),
    ));
    render(<StrictMode><SessionApp /></StrictMode>);
    expect(await screen.findByText("Strict ready")).toBeInTheDocument();
  });

  it("loads later pages without duplicating an overlapping item", async () => {
    installIntersectionObserver();
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    const first = page([message("message-1", 1, "First")], TIMELINE_CURSOR, true);
    const second = page([
      message("message-1", 1, "First"),
      message("message-2", 2, "Second"),
    ], NEXT_TIMELINE_CURSOR, false);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(second)));
    render(<SessionApp />);

    await screen.findByText("First");
    intersectLatest();
    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(screen.getAllByText("First")).toHaveLength(1);
  });

  it("backs off retryable automatic timeline page failures", async () => {
    installIntersectionObserver();
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    const first = page([message("message-1", 1, "First")], TIMELINE_CURSOR, true);
    const second = page([message("message-2", 2, "Retried event")], NEXT_TIMELINE_CURSOR, false);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json({ error: { code: "busy", message: "Timeline busy" } }, 503))
      .mockResolvedValueOnce(json(second));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await screen.findByText("First");

    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    intersectLatest();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Timeline busy")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Retried event")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("stops automatic timeline pagination on a terminal page error", async () => {
    installIntersectionObserver();
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([message("message-1", 1, "First")], TIMELINE_CURSOR, true)))
      .mockResolvedValueOnce(json({ error: { code: "invalid_query", message: "Stop timeline" } }, 400));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await screen.findByText("First");

    intersectLatest();
    expect(await screen.findByText("Stop timeline")).toBeInTheDocument();
    intersectLatest();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps automatic pagination available when all loaded events are filtered", () => {
    render(<Timeline
      items={[{ kind: "internal", id: "internal-1", ordinal: 1, timestamp: null,
        eventType: "reasoning", summary: "hidden upstream", truncated: false }]}
      sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR}
      hasMore
      loading={false}
      onLoadMore={vi.fn()}
      onTimelineConflict={vi.fn()}
    />);
    expect(document.querySelector(".infinite-scroll-sentinel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more events" })).not.toBeInTheDocument();
  });

  it("keeps one mark per full-width timeline event", () => {
    render(<Timeline
      items={[
        message("message-mark", 1, "Message body"),
        { kind: "internal", id: "internal-mark", ordinal: 2, timestamp: null,
          eventType: "reasoning", summary: "Internal body", truncated: false },
      ]}
      sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR}
      hasMore
      loading={false}
      onLoadMore={vi.fn()}
      onTimelineConflict={vi.fn()}
    />);

    const events = document.querySelectorAll(".trace-event");
    expect(events).toHaveLength(2);
    for (const event of events) {
      const mark = event.querySelector(":scope > .trace-mark");
      expect(mark).toHaveAttribute("aria-hidden", "true");
      expect(event.querySelector(":scope > article")).toBeInTheDocument();
    }
  });

  it("loads tool and directive details concurrently without changing their cursor", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    render(<>
      <ToolItem item={toolItem} sessionId={SESSION_ID} cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
      <DirectiveItem item={directiveItem} sessionId={SESSION_ID} cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
    </>);

    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("cursor=opaque.timeline.cursor"))).toBe(true);
    pending[1]!(json({ itemId: directiveItem.id, text: "Directive body", truncated: false }));
    pending[0]!(json({ itemId: toolItem.id, input: "input", output: "output", truncated: false }));
    expect(await screen.findByText("Directive body")).toBeInTheDocument();
    expect(await screen.findByText("input")).toBeInTheDocument();
  });

  it("keeps pending lazy detail when the cursor advances", async () => {
    let resolveDetail!: (response: Response) => void;
    const pendingDetail = new Promise<Response>((resolve) => { resolveDetail = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(pendingDetail);
    const onTimelineConflict = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ToolItem item={toolItem} sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR} onTimelineConflict={onTimelineConflict} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(<ToolItem item={toolItem} sessionId={SESSION_ID}
      cursor={NEXT_TIMELINE_CURSOR} onTimelineConflict={onTimelineConflict} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(false);
    resolveDetail(json({ itemId: toolItem.id, input: "loaded detail", output: null, truncated: false }));
    expect(await screen.findByText("loaded detail")).toBeInTheDocument();
  });

  it("aborts pending lazy detail when it is closed", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<ToolItem item={toolItem} sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Hide tool detail" }));

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("toggles technical-event visibility for the current page", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([
      { kind: "internal", id: "internal-1", ordinal: 1, timestamp: null,
        eventType: "reasoning", summary: "Internal body", truncated: false },
    ]))));
    render(<SessionApp />);
    const checkbox = await screen.findByRole("checkbox", { name: "internal" });
    fireEvent.click(checkbox);
    expect(screen.getByText("reasoning", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText(/Internal body/)).not.toBeInTheDocument();
  });
});

async function flushMicrotasks(turns = 6): Promise<void> {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) await Promise.resolve();
  });
}

function message(id: string, ordinal: number, markdown: string): TimelineItem {
  return { kind: "message", id, ordinal, timestamp: null, role: "assistant",
    phase: "final", itemType: null, markdown };
}

function page(
  items: TimelineItem[],
  cursor: TimelineCursor = TIMELINE_CURSOR,
  hasMore = false,
): ItemPageResponse {
  return {
    session: { ...baseSession, sourceId: "reader", diagnostics: [], itemCount: items.length },
    items,
    cursor,
    hasMore,
    interaction: { supported: false },
    liveRevision: "opaque.live.revision" as LiveRevision,
  };
}
