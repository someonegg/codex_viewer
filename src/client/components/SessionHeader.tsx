import type { SessionDetail } from "../../shared/domain";
import { sessionDisplayTitle } from "../session-title";
import type {
  TimelineVisibility,
  TimelineVisibilityKey,
} from "../state/timeline-visibility";

interface SessionHeaderProps {
  session: SessionDetail;
  visibility: TimelineVisibility;
  onVisibilityChange: (key: TimelineVisibilityKey, visible: boolean) => void;
  autoRefreshEnabled: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function SessionHeader({
  session,
  visibility,
  onVisibilityChange,
  autoRefreshEnabled,
  onAutoRefreshChange,
}: SessionHeaderProps) {
  const updatedAt = formatTimestamp(session.updatedAt);

  return (
    <header className="reader-header">
      <div>
        <div className="session-heading-flags">
          <p className="eyebrow">Session trace</p>
          {session.archived ? <span className="archive-label">Archived</span> : null}
        </div>
        <h2 id="session-title">{sessionDisplayTitle(session)}</h2>
        <p className="session-meta">
          {session.cwd ?? "Project unavailable"} · {updatedAt} · {session.itemCount} events
        </p>
        <p className="session-origin">
          {sessionOriginLabel(session.origin)}
        </p>
        <p className="session-source-id">
          Original session ID · <code>{session.sourceId ?? "Unavailable"}</code>
        </p>
        <div className="reader-controls">
          {!session.archived
            ? (
                <div className="auto-refresh-control">
                  <span className="auto-refresh-label" id="live-updates-label">
                    Live updates
                  </span>
                  <button
                    type="button"
                    className="auto-refresh-switch"
                    role="switch"
                    aria-checked={autoRefreshEnabled}
                    aria-labelledby="live-updates-label"
                    onClick={() => onAutoRefreshChange(!autoRefreshEnabled)}
                  >
                    <span className="auto-refresh-thumb" aria-hidden="true" />
                  </button>
                </div>
              )
            : null}
          <div className="event-toggles" role="group" aria-label="Timeline event visibility">
            {VISIBILITY_TOGGLES.map(({ key, label }) => (
              <label className="check-row event-toggle" key={key}>
                <input
                  type="checkbox"
                  checked={visibility[key]}
                  onChange={(event) => onVisibilityChange(key, event.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

function formatTimestamp(value: string | null): string {
  if (value === null) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Time unavailable"
    : DATE_FORMAT.format(date);
}

const VISIBILITY_TOGGLES: Array<{
  key: TimelineVisibilityKey;
  label: string;
}> = [
  { key: "directive", label: "directive" },
  { key: "tools", label: "tool" },
  { key: "token", label: "token" },
  { key: "internal", label: "internal" },
];

function sessionOriginLabel(origin: SessionDetail["origin"]): string {
  let label = origin.agentName;
  if (origin.agentVersion !== null) label += ` ${origin.agentVersion}`;
  if (origin.formatVersion !== null) label += ` · format ${origin.formatVersion}`;
  return label;
}
