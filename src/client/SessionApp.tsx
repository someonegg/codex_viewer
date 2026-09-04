import { useEffect } from "react";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { SessionReader } from "./components/SessionReader";
import { useSessionReader } from "./state/use-session-reader";
import { useTimelineVisibility } from "./state/use-timeline-visibility";
import { sessionDisplayTitle } from "./session-title";

export function SessionApp() {
  const sessionId = sessionIdFromPath(window.location.pathname);
  if (sessionId === null) {
    return <InvalidSessionPage />;
  }
  return <SessionPage sessionId={sessionId} />;
}

function SessionPage({ sessionId }: { sessionId: string }) {
  const timelineVisibility = useTimelineVisibility();
  const reader = useSessionReader(sessionId);
  const sessionTitle = reader.context === null
    ? null
    : sessionDisplayTitle(reader.context.session);

  useEffect(() => {
    document.title = sessionTitle === null
      ? "Codex Sessions"
      : `${sessionTitle} · Codex Sessions`;
  }, [sessionTitle]);

  return (
    <main className="reader-page">
      {reader.context
        ? (
            <SessionReader
              context={reader.context}
              items={reader.items}
              interaction={reader.interaction}
              visibility={timelineVisibility.visibility}
              onVisibilityChange={timelineVisibility.setVisibility}
              readerLoading={reader.readerLoading}
              readerBusy={reader.operation !== null}
              autoRefreshEnabled={reader.autoRefreshEnabled}
              onAutoRefreshChange={reader.setAutoRefreshEnabled}
              onLoadMore={reader.loadMore}
              onTimelineConflict={reader.markTimelineConflict}
              timelineConflict={reader.timelineConflict}
              timelineRenderGeneration={reader.timelineRenderGeneration}
              onRefreshLatest={reader.refreshLatest}
              error={reader.readerError}
              onDismissError={reader.clearReaderError}
            />
          )
        : reader.readerError
        ? (
            <section className="reader">
              <ErrorState
                title={reader.missing ? "Session not found" : "Could not load session"}
                message={reader.readerError}
              />
              {!reader.missing
                ? (
                    <button
                      className="load-more"
                      type="button"
                      disabled={reader.operation !== null}
                      onClick={() => void reader.retryOpen()}
                    >
                      Retry opening session
                    </button>
                  )
                : null}
            </section>
          )
        : (
            <section className="reader reader-welcome">
              <p className="loading" role="status">Opening session…</p>
            </section>
          )}
    </main>
  );
}

function InvalidSessionPage() {
  return (
    <main className="reader-page">
      <nav className="reader-navigation"><a href="/">← Back to sessions</a></nav>
      <section className="reader reader-welcome">
        <EmptyState title="Invalid session URL">Choose a session from the list.</EmptyState>
      </section>
    </main>
  );
}

export function sessionIdFromPath(pathname: string): string | null {
  const match = /^\/sessions\/([A-Za-z0-9_-]{20,100})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}
