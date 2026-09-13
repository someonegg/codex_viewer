import { describe, expect, it, vi } from "vitest";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import type {
  InteractionSessionSnapshot,
  SessionReader,
} from "../../src/server/application/session-reader.js";
import {
  CODEX_INTERACTION_KEY_BINDINGS,
  CODEX_TMUX_ACTIVATION,
} from "../../src/server/adapters/codex/interaction-parser.js";
import type { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";

function repository(snapshot: InteractionSessionSnapshot | null): SessionReader {
  return {
    list: vi.fn(),
    getSession: vi.fn(),
    getItems: vi.fn(),
    getLiveSession: vi.fn(),
    getToolDetail: vi.fn(),
    getDirectiveDetail: vi.fn(),
    getInternalDetail: vi.fn(),
    getInteractionSession: vi.fn().mockResolvedValue(snapshot),
    refresh: vi.fn(),
  };
}

function session(archived = false): InteractionSessionSnapshot {
  return {
    archived,
    interaction: {
      activation: CODEX_TMUX_ACTIVATION,
      bindingAttempt: null,
      keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
    },
  };
}

function boundSession(): InteractionSessionSnapshot {
  return {
    archived: false,
    interaction: {
      activation: CODEX_TMUX_ACTIVATION,
      bindingAttempt: {
        ordinal: 4,
        valid: true,
        socketPath: "/tmp/viewer.sock",
        paneId: "%7",
      },
      keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
    },
  };
}

describe("session interaction policy", () => {
  it("is unsupported when disabled or archived", async () => {
    expect(await new SessionInteractionService(repository(session()), false)
      .describe("session")).toEqual({ supported: false });
    expect(await new SessionInteractionService(repository(session(true)), true)
      .describe("session")).toEqual({ supported: false });
  });

  it("reports unbound and rejects actions before transport", async () => {
    const service = new SessionInteractionService(repository(session()), true);
    expect(await service.describe("session")).toEqual({
      supported: true,
      state: "unbound",
      activation: CODEX_TMUX_ACTIVATION,
    });
    await expect(service.sendMessage("session", "hello")).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
    await expect(service.sendKeys("session", ["interrupt"])).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
  });

  it("allows all actions whenever the pane is connected", async () => {
    const binding = {
      socketPath: "/tmp/viewer.sock",
      serverStartTime: "1700000000",
      paneId: "%7",
      panePid: "4100",
    };
    const tmux = {
      connect: vi.fn().mockResolvedValue(binding),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      captureTerminal: vi.fn().mockResolvedValue({
        content: "recent output",
        truncated: false,
      }),
    } as unknown as TmuxInteractionService;
    const service = new SessionInteractionService(
      repository(boundSession()),
      true,
      tmux,
    );

    await expect(service.describe("session")).resolves.toEqual({
      supported: true,
      state: "connected",
      activation: CODEX_TMUX_ACTIVATION,
    });
    await service.sendMessage("session", "hello");
    await service.sendKeys("session", [
      "enter", "up", "down", "left", "right", "interrupt", "plan",
    ]);
    await expect(service.preview("session")).resolves.toEqual({
      content: "recent output",
      truncated: false,
      capturedAt: expect.any(String),
    });
    expect(tmux.sendMessage).toHaveBeenCalledWith(binding, "hello");
    expect(tmux.sendKeys).toHaveBeenCalledWith(binding, [
      "Enter", "Up", "Down", "Left", "Right", "C-c", "BTab",
    ]);
    expect(tmux.captureTerminal).toHaveBeenCalledWith(binding);
  });
});
