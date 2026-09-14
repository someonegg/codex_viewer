import { useCallback, useState } from "react";

export const INTERACTION_PANEL_STORAGE_KEY =
  "codex-sessions-reader.interaction-panel-expanded.v1";

export function useInteractionPanelPreference() {
  const [expanded, setExpandedState] = useState(readPreference);

  const setExpanded = useCallback((next: boolean) => {
    setExpandedState(next);
    try {
      sessionStorage.setItem(INTERACTION_PANEL_STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable in privacy modes; the preference still works in memory.
    }
  }, []);

  return [expanded, setExpanded] as const;
}

function readPreference(): boolean {
  try {
    return sessionStorage.getItem(INTERACTION_PANEL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}
