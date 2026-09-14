import { useCallback, useState } from "react";
import type {
  TimelineCursor,
  ToolDetailResponse,
} from "../../shared/api-contract";
import type { ToolItem as Tool } from "../../shared/domain";
import { api } from "../api/client";
import { useLazyDetail } from "../state/use-lazy-detail";
import { EventTime } from "./EventTime";
import { CharacterCount } from "./CharacterCount";

interface ToolItemProps {
  item: Tool;
  sessionId: string;
  cursor: TimelineCursor;
  onTimelineConflict: () => void;
}

export function ToolItem({
  item,
  sessionId,
  cursor,
  onTimelineConflict,
}: ToolItemProps) {
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (requestCursor: TimelineCursor, signal: AbortSignal): Promise<ToolDetailResponse> =>
      api.tool(sessionId, item.id, { cursor: requestCursor }, signal),
    [item.id, sessionId],
  );
  const { detail, error } = useLazyDetail({
    enabled: open && item.hasDetail,
    cursor,
    load: loadDetail,
    unavailableMessage: "Tool detail unavailable",
    onTimelineConflict,
  });

  return (
    <article className="tool-body">
      <p className="event-label">
        {item.stage === "call"
          ? `Tool call · ${item.ordinal}`
          : `Tool output · ${item.status} · ${item.ordinal}`}
        <EventTime timestamp={item.timestamp} />
      </p>
      <p className="detail-summary">
        <strong>{item.toolName}</strong>{item.preview ? ` — ${item.preview}` : ""}
        {item.hasDetail ? <CharacterCount value={item.charCount} /> : null}
      </p>
      <p className="tool-call-id">Call ID · <code>{item.callId}</code></p>
      {item.hasDetail
        ? (
            <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? "Hide tool detail" : "Show tool detail"}
            </button>
          )
        : <p className="muted">No detail available.</p>}
      {open
        ? (
            <div className="tool-detail">
              {detail === null && error === null ? <p role="status">Loading tool detail…</p> : null}
              {error ? <p role="alert">{error}</p> : null}
              {detail
                ? (
                    <>
                      {detail.input !== null ? <><h4>Input</h4><pre>{detail.input}</pre></> : null}
                      {item.stage === "output" && detail.output !== null
                        ? <><h4>Output</h4><pre>{detail.output}</pre></>
                        : null}
                      {detail.truncated
                        ? <p className="truncated">Detail was truncated for safe display.</p>
                        : null}
                    </>
                  )
                : null}
            </div>
          )
        : null}
    </article>
  );
}
