import { useCallback, useState } from "react";
import type {
  DirectiveDetailResponse,
  TimelineCursor,
} from "../../shared/api-contract";
import type { DirectiveItem as Directive } from "../../shared/domain";
import { api } from "../api/client";
import { useLazyDetail } from "../state/use-lazy-detail";
import { EventTime } from "./EventTime";
import { CharacterCount } from "./CharacterCount";

interface DirectiveItemProps {
  item: Directive;
  sessionId: string;
  cursor: TimelineCursor;
  onTimelineConflict: () => void;
}

export function DirectiveItem({
  item,
  sessionId,
  cursor,
  onTimelineConflict,
}: DirectiveItemProps) {
  if (!item.hasDetail) {
    return <InlineDirective item={item} />;
  }
  return (
    <LazyDirective
      item={item}
      sessionId={sessionId}
      cursor={cursor}
      onTimelineConflict={onTimelineConflict}
    />
  );
}

function InlineDirective({ item }: { item: Extract<Directive, { hasDetail: false }> }) {
  return (
    <article className="directive-body">
      <p className="event-label">
        Directive · {item.ordinal}<EventTime timestamp={item.timestamp} />
      </p>
      <pre className="directive-block">{item.text}</pre>
    </article>
  );
}

function LazyDirective({
  item,
  sessionId,
  cursor,
  onTimelineConflict,
}: DirectiveItemProps & { item: Extract<Directive, { hasDetail: true }> }) {
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (requestCursor: TimelineCursor, signal: AbortSignal): Promise<DirectiveDetailResponse> =>
      api.directive(sessionId, item.id, { cursor: requestCursor }, signal),
    [item.id, sessionId],
  );
  const { detail, error } = useLazyDetail({
    enabled: open,
    cursor,
    load: loadDetail,
    unavailableMessage: "Directive unavailable",
    onTimelineConflict,
  });

  return (
    <article className="directive-body">
      <p className="event-label">
        Directive · {item.ordinal}<EventTime timestamp={item.timestamp} />
      </p>
      <p className="detail-summary">
        <strong>{item.summary}</strong>
        <CharacterCount value={item.charCount} />
      </p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide directive" : "Show directive"}
      </button>
      {open
        ? (
            <div className="tool-detail">
              {detail === null && error === null
                ? <p role="status">Loading directive…</p>
                : null}
              {error ? <p role="alert">{error}</p> : null}
              {detail
                ? (
                    <>
                      <pre>{detail.text}</pre>
                      {detail.truncated
                        ? <p className="truncated">Directive was truncated for safe display.</p>
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
