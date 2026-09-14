// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionPanel } from "../../src/client/components/InteractionPanel";
import { INTERACTION_PANEL_STORAGE_KEY } from "../../src/client/state/use-interaction-panel-preference";
import type { InteractionResponse } from "../../src/shared/api-contract";

const activation = "! printf 'CODEX_VIEWER_TMUX_BIND_V1\\n%s\\n%s\\n' \"$TMUX\" \"$TMUX_PANE\"";

function interaction(
  state: "unbound" | "disconnected" | "connected",
): InteractionResponse {
  return {
    supported: true,
    state,
    activation,
  };
}

function props(value: InteractionResponse | null) {
  return {
    interaction: value,
    itemCount: 12,
    updatedAt: "2026-08-08T12:00:00.000Z",
    interactionBusy: false,
    error: null,
    onDismissError: vi.fn(),
    onSendMessage: vi.fn().mockResolvedValue(undefined),
    onSendKeys: vi.fn().mockResolvedValue(undefined),
    preview: null,
    previewBusy: false,
    previewError: null,
    onDismissPreviewError: vi.fn(),
    onPreviewTerminal: vi.fn().mockResolvedValue(undefined),
    onCancelPreviewTerminal: vi.fn(),
  };
}

describe("interaction panel", () => {
  beforeEach(() => {
    sessionStorage.setItem(INTERACTION_PANEL_STORAGE_KEY, "true");
  });

  it("defaults to a collapsed summary and persists the disclosure choice", async () => {
    sessionStorage.removeItem(INTERACTION_PANEL_STORAGE_KEY);
    const user = userEvent.setup();
    const handlers = props(interaction("connected"));
    const { unmount } = render(<InteractionPanel {...handlers} />);

    const toggle = screen.getByRole("button", { name: /Live interaction.*Connected/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/12 events · Updated/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message to agent" })).toBeNull();
    expect(handlers.onPreviewTerminal).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeInTheDocument();
    expect(sessionStorage.getItem(INTERACTION_PANEL_STORAGE_KEY)).toBe("true");

    unmount();
    render(<InteractionPanel {...handlers} />);
    expect(screen.getByRole("button", { name: /Live interaction.*Connected/i }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("keeps attention states collapsed and exposes them in the heading", () => {
    sessionStorage.setItem(INTERACTION_PANEL_STORAGE_KEY, "false");
    const { rerender } = render(
      <InteractionPanel {...props(interaction("unbound"))} />,
    );
    expect(screen.getByRole("button", { name: /Needs activation/i }))
      .toHaveAttribute("aria-expanded", "false");

    rerender(<InteractionPanel {...props(interaction("disconnected"))} />);
    expect(screen.getByRole("button", { name: /Disconnected/i }))
      .toHaveAttribute("aria-expanded", "false");

    rerender(<InteractionPanel {...props(interaction("connected"))} error="send failed" />);
    expect(screen.getByRole("button", { name: /Error/i }))
      .toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves drafts and pauses terminal polling while the outer panel is collapsed", async () => {
    const user = userEvent.setup();
    const handlers = {
      ...props(interaction("connected")),
      preview: { content: "output", truncated: false, capturedAt: "2026-08-08T12:00:00.000Z" },
    };
    render(<InteractionPanel {...handlers} />);
    await user.type(screen.getByRole("textbox", { name: "Message to agent" }), "draft");
    handlers.onCancelPreviewTerminal.mockClear();

    await user.click(screen.getByRole("button", { name: /Live interaction.*Connected/i }));
    expect(screen.queryByRole("textbox", { name: "Message to agent" })).toBeNull();
    expect(handlers.onCancelPreviewTerminal).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Live interaction.*Connected/i }));
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("draft");
    expect(screen.getByLabelText("Terminal preview content")).toHaveTextContent("output");
  });

  it("keeps unsupported sessions as a pure viewer", () => {
    const { container, rerender } = render(<InteractionPanel {...props(null)} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<InteractionPanel {...props({ supported: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows activation and reconnection guidance", () => {
    const updatedAt = "2026-08-08T12:00:00.000Z";
    const localTime = new Date(updatedAt).toLocaleTimeString(undefined, { timeStyle: "medium" });
    const { rerender } = render(
      <InteractionPanel
        {...props(interaction("unbound"))}
        itemCount={12}
        updatedAt={updatedAt}
      />,
    );
    expect(screen.getByText(activation)).toBeInTheDocument();
    expect(screen.getByText(`12 events · Updated ${localTime}`)).toBeInTheDocument();
    rerender(
      <InteractionPanel
        {...props(interaction("disconnected"))}
        itemCount={12}
        updatedAt={updatedAt}
      />,
    );
    expect(screen.getByText(/previous tmux target is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(`12 events · Updated ${localTime}`)).toBeInTheDocument();
  });

  it("shows the event count and local update time while connected", () => {
    const updatedAt = "2026-08-08T12:00:00.000Z";
    const localTime = new Date(updatedAt).toLocaleTimeString(undefined, { timeStyle: "medium" });
    render(<InteractionPanel {...props(interaction("connected"))} itemCount={12} updatedAt={updatedAt} />);

    const summary = screen.getByText(`12 events · Updated ${localTime}`);
    const preview = screen.getByRole("region", { name: "Terminal preview" });
    const prompt = screen.getByRole("textbox", { name: "Message to agent" });
    const lastAction = screen.getByRole("button", { name: "Interrupt" });
    expect(summary).toBeInTheDocument();
    expect(preview.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lastAction.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(preview.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses a singular event label and falls back when the update time is unavailable", () => {
    const { rerender } = render(
      <InteractionPanel {...props(interaction("connected"))} itemCount={1} updatedAt={null} />,
    );
    expect(screen.getByText("1 event · Update time unavailable")).toBeInTheDocument();

    rerender(
      <InteractionPanel {...props(interaction("connected"))} itemCount={0} updatedAt="not-a-time" />,
    );
    expect(screen.getByText("0 events · Update time unavailable")).toBeInTheDocument();
  });

  it("copies the activation command", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<InteractionPanel {...props(interaction("unbound"))} />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(activation);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("inserts a newline on Enter, sends on Shift+Enter, and clears after success", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} />);
    const textarea = screen.getByRole("textbox", { name: "Message to agent" });
    await user.type(textarea, "line one{enter}line two");
    expect(textarea).toHaveValue("line one\nline two");
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(handlers.onSendMessage).toHaveBeenCalledWith("line one\nline two");
    expect(await screen.findByRole("textbox", { name: "Message to agent" })).toHaveValue("");
  });

  it("keeps Send disabled for blank input", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} />);
    const textarea = screen.getByRole("textbox", { name: "Message to agent" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    await user.type(textarea, "   ");
    expect(send).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    expect(handlers.onSendKeys).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("   ");
  });

  it("dispatches interaction controls and locks the composer and action buttons while busy", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    expect(screen.getByText(/12 events · Updated/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rebind" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rebind" }).parentElement)
      .toHaveClass("interaction-actions");
    expect(screen.getByRole("button", { name: "Send" }).parentElement)
      .toHaveClass("interaction-primary-actions");
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal preview" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(handlers.onSendKeys).toHaveBeenNthCalledWith(1, ["interrupt"]);
    expect(handlers.onSendKeys).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Rebind" }));
    expect(handlers.onSendMessage).toHaveBeenCalledWith(activation);

    await user.type(screen.getByRole("textbox"), "draft");
    const interrupt = screen.getByRole("button", { name: "Interrupt" });
    interrupt.focus();
    handlers.onSendKeys.mockClear();
    handlers.onSendMessage.mockClear();
    rerender(<InteractionPanel {...handlers} interactionBusy />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("draft");
    expect(interrupt).toHaveFocus();
    expect(interrupt).toBeEnabled();
    expect(interrupt).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Rebind" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Terminal preview" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await user.click(interrupt);
    await user.click(screen.getByRole("button", { name: "Rebind" }));
    expect(handlers.onSendKeys).not.toHaveBeenCalled();
    expect(handlers.onSendMessage).not.toHaveBeenCalled();

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeEnabled();
    expect(send).toHaveAttribute("aria-disabled", "true");
    await user.click(send);
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
  });

  it("loads from the unified header and opens at the bottom", async () => {
    const handlers = props(interaction("connected"));
    const captured = {
      content: "first\nlatest",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
    };
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(480);
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);

    const header = screen.getByRole("button", { name: "Terminal preview" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);

    rerender(<InteractionPanel {...handlers} preview={captured} />);
    expect(screen.getByRole("button", { name: "Terminal preview" }))
      .toHaveAttribute("aria-expanded", "true");
    const content = screen.getByLabelText("Terminal preview content");
    expect(content).toHaveAttribute("tabindex", "0");
    expect(content.scrollTop).toBe(480);
    scrollHeight.mockRestore();
  });

  it("renders a truncated terminal preview as plain text", () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: "\u001b[31mplain text<img src=x onerror=alert(1)><script>alert(2)</script>",
        truncated: true,
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    render(<InteractionPanel {...handlers} />);

    const content = screen.getByLabelText("Terminal preview content");
    expect(content).toHaveTextContent(
      "plain text<img src=x onerror=alert(1)><script>alert(2)</script>",
    );
    expect(content.querySelector("img")).toBeNull();
    expect(content.querySelector("script")).toBeNull();
    expect(screen.getByText(/terminal output exceeded the preview limit/i)).toBeInTheDocument();
  });

  it("reopens a folded terminal preview at the bottom", async () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: "terminal output",
        truncated: false,
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(640);
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} />);

    const header = screen.getByRole("button", { name: "Terminal preview" });
    await user.click(header);
    expect(screen.queryByLabelText("Terminal preview content")).not.toBeInTheDocument();
    await user.click(header);
    expect(screen.getByLabelText("Terminal preview content").scrollTop).toBe(640);
    scrollHeight.mockRestore();
  });

  it("replaces long terminal content without replacing or disturbing the scroll container", () => {
    const staleLine = "stale offscreen line";
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: Array.from({ length: 80 }, (_, index) =>
          `${staleLine} ${index + 1}`).join("\n"),
        truncated: false,
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const content = screen.getByLabelText("Terminal preview content");
    const textLayer = content.querySelector(".terminal-preview-content");
    expect(textLayer).not.toBeNull();
    content.scrollTop = 120;
    content.focus();
    expect(content).toHaveFocus();
    const refreshedPreview = {
      ...handlers.preview,
      content: "short fresh output",
      capturedAt: "2026-08-08T12:00:01.000Z",
    };
    rerender(<InteractionPanel {...handlers} preview={refreshedPreview} />);
    const refreshed = screen.getByLabelText("Terminal preview content");
    const refreshedTextLayer = refreshed.querySelector(".terminal-preview-content");
    expect(refreshed).toBe(content);
    expect(refreshedTextLayer).not.toBe(textLayer);
    expect(refreshedTextLayer).toHaveTextContent("short fresh output");
    expect(refreshed).not.toHaveTextContent(staleLine);
    expect(refreshed.scrollTop).toBe(120);
    expect(refreshed).toHaveFocus();
  });

  it("replaces timestamp and manual refresh with a default-on auto-refresh switch", async () => {
    const captured = {
      content: "output",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
    };
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} preview={captured} />);
    const autoRefresh = screen.getByRole("switch", { name: "Auto refresh" });
    expect(autoRefresh).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Refresh terminal preview" })).toBeNull();
    expect(screen.queryByText(new Date(captured.capturedAt).toLocaleTimeString())).toBeNull();

    await user.click(autoRefresh);
    expect(autoRefresh).toHaveAttribute("aria-checked", "false");
  });

  it("polls without overlap and retries after failures", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const handlers = {
      ...props(interaction("connected")),
      preview: { content: "output", truncated: false, capturedAt: "2026-08-08T12:00:00.000Z" },
    };
    handlers.onPreviewTerminal
      .mockReturnValueOnce(first)
      .mockRejectedValueOnce(new Error("temporary capture failure"))
      .mockResolvedValue(undefined);

    try {
      const { unmount } = render(<InteractionPanel {...handlers} />);
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);

      await act(async () => { resolveFirst(); await first; });
      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(3);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a paused manual preview capture when unmounted", async () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: { content: "output", truncated: false, capturedAt: "2026-08-08T12:00:00.000Z" },
    };
    const { unmount } = render(<InteractionPanel {...handlers} />);
    const autoRefresh = screen.getByRole("switch", { name: "Auto refresh" });
    const toggle = screen.getByRole("button", { name: "Terminal preview" });

    fireEvent.click(autoRefresh);
    fireEvent.click(toggle);
    handlers.onPreviewTerminal.mockClear();
    handlers.onCancelPreviewTerminal.mockClear();

    fireEvent.click(toggle);
    expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);
    expect(handlers.onCancelPreviewTerminal).not.toHaveBeenCalled();

    unmount();
    expect(handlers.onCancelPreviewTerminal).toHaveBeenCalledTimes(1);
  });

  it("pauses polling when disabled, collapsed, hidden, or disconnected", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilityState = vi.spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const handlers = {
      ...props(interaction("connected")),
      preview: { content: "output", truncated: false, capturedAt: "2026-08-08T12:00:00.000Z" },
    };

    try {
      const { rerender, unmount } = render(<InteractionPanel {...handlers} />);
      await act(async () => { await Promise.resolve(); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);

      const autoRefresh = screen.getByRole("switch", { name: "Auto refresh" });
      fireEvent.click(autoRefresh);
      expect(autoRefresh).toHaveAttribute("aria-checked", "false");
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);

      fireEvent.click(autoRefresh);
      await act(async () => { await Promise.resolve(); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(2);

      const toggle = screen.getByRole("button", { name: "Terminal preview" });
      fireEvent.click(toggle);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(2);

      fireEvent.click(toggle);
      await act(async () => { await Promise.resolve(); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(3);

      visibility = "hidden";
      fireEvent(document, new Event("visibilitychange"));
      expect(handlers.onCancelPreviewTerminal).toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(3);

      visibility = "visible";
      fireEvent(document, new Event("visibilitychange"));
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(4);

      rerender(<InteractionPanel {...handlers} interaction={interaction("disconnected")} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(4);
      unmount();
    } finally {
      visibilityState.mockRestore();
      vi.useRealTimers();
    }
  });

  it("sends the six terminal keys from the rectangular terminal keypad", async () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: { content: "output", truncated: false, capturedAt: "2026-08-08T12:00:00.000Z" },
    };
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const keypad = screen.getByRole("group", { name: "Terminal controls" });
    expect(keypad).toBeInTheDocument();
    expect([...keypad.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Enter", "↑", "Plan", "←", "↓", "→",
    ]);

    for (const name of ["Enter", "Up", "Plan", "Left", "Down", "Right"]) {
      await user.click(screen.getByRole("button", { name }));
    }
    expect(handlers.onSendKeys.mock.calls).toEqual([
      [["enter"]],
      [["up"]],
      [["plan"]],
      [["left"]],
      [["down"]],
      [["right"]],
    ]);

    rerender(<InteractionPanel {...handlers} interactionBusy />);
    handlers.onSendKeys.mockClear();
    for (const name of ["Enter", "Up", "Plan", "Left", "Down", "Right"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute("aria-disabled", "true");
      await user.click(button);
    }
    expect(handlers.onSendKeys).not.toHaveBeenCalled();
  });
});
