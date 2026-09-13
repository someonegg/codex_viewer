---
status: accepted
date: 2026-08-01
---

# Use opaque single-writer timeline cursors

## Context and Problem Statement

The reader exposed session revisions, ordinals, and prefix tokens and allowed metadata and lazy-detail responses to replace the shared cursor. That made clients interpret consistency fields and coordinate compare-and-set updates across requests that do not advance the timeline. The server only needs the client to return proof of its confirmed prefix.

## Decision Drivers

- Keep prefix validation and protocol fields private to the server.
- Preserve append-only continuation and fail closed after confirmed content changes.
- Serialize only requests that can advance the reader boundary.
- Prevent lazy detail for an item beyond the confirmed prefix.
- Retain bounded pages for long sessions.

## Considered Options

- Continue exposing structured revision and prefix fields to every session-scoped endpoint.
- Use a content snapshot revision and reset on every change.
- Use an opaque cursor advanced only by the items endpoint.

## Decision Outcome

Chosen option: "Use an opaque cursor advanced only by the items endpoint", because cursor ownership then matches the only operation that extends the confirmed timeline prefix.

The cursor is an authenticated, process-local protocol value bound to the session ID, through ordinal, and keyed prefix-chain token. Cursor identity follows the observable timeline, so identical content under the same session ID preserves existing cursors. The items endpoint accepts no cursor for an initial read and always returns a cursor, including empty tail polls. Metadata does not accept or return a cursor. Tool, directive, and internal-event detail require a cursor, validate that the target ordinal is within its boundary, and return content only. Any prefix mismatch returns `timeline_changed`.

A structurally valid cursor whose signature cannot be verified, including a cursor retained across a process restart, also returns `timeline_changed`. Structurally malformed cursor input remains an `invalid_query` error. This distinction lets the reader preserve loaded content and offer explicit reload recovery without treating arbitrary malformed input as session history change.

This decision supersedes [ADR-0004](0004-use-session-scoped-reader-revisions.md) and [ADR-0006](0006-use-timeline-prefix-continuity.md).

### Positive Consequences

- UI code treats consistency state as an indivisible string and cannot assemble invalid field combinations.
- Pagination and polling share one serial cursor writer, while metadata and details may run concurrently.
- Empty polls do not manufacture new cursor state.
- Appends and identical replacements preserve old cursors; changes to a confirmed prefix fail closed.

### Negative Consequences

- Process restarts invalidate outstanding cursors.
- Debugging requires server-side cursor inspection rather than reading query fields.
- The server retains one 24-byte prefix state per timeline boundary.
- A conflict requires an explicit reload from the beginning.

## Pros and Cons of the Options

### Structured conditional cursor on every read

- Good: Makes protocol fields directly observable.
- Bad: Spreads cursor interpretation and write coordination across the client.

### Exact content revision with reset

- Good: Has a simple equality check.
- Bad: Harmless appends discard accumulated reading state.

### Opaque single-writer cursor

- Good: Encapsulates validation and gives cursor advancement one owner.
- Bad: Requires authenticated encoding and explicit conflict recovery.
