// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  INTERACTION_PANEL_STORAGE_KEY,
  useInteractionPanelPreference,
} from "../../src/client/state/use-interaction-panel-preference";

describe("interaction panel preference", () => {
  it("defaults collapsed and restores an expanded choice after remounting", () => {
    const first = renderHook(() => useInteractionPanelPreference());
    expect(first.result.current[0]).toBe(false);

    act(() => first.result.current[1](true));
    expect(sessionStorage.getItem(INTERACTION_PANEL_STORAGE_KEY)).toBe("true");

    first.unmount();
    const restored = renderHook(() => useInteractionPanelPreference());
    expect(restored.result.current[0]).toBe(true);
  });

  it("treats malformed values as collapsed", () => {
    sessionStorage.setItem(INTERACTION_PANEL_STORAGE_KEY, "expanded");
    const result = renderHook(() => useInteractionPanelPreference());
    expect(result.result.current[0]).toBe(false);
  });

  it("continues in memory when storage writes fail", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    try {
      const result = renderHook(() => useInteractionPanelPreference());
      act(() => result.result.current[1](true));
      expect(result.result.current[0]).toBe(true);
    } finally {
      write.mockRestore();
    }
  });
});
