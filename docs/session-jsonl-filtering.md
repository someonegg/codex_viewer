# Session JSONL filtering rules

This document is the canonical summary of how rollout JSONL records become
timeline items. Keep it synchronized with `rollout-decoder.ts`,
`session-normalizer.ts`, `tool-normalizer.ts`, `user-input-normalizer.ts`, and
`session-read-service.ts`.

## Decode-time skips

Rollout state is checkpointed in memory after a successful source refresh. The
checkpoint records the observed EOF, the byte after the last committed newline,
the consumed physical-line count, decoder diagnostics and versions, plus SHA-256
probes covering the first 4 KiB and up to 4 KiB before the prior EOF. A strictly
growing file is decoded incrementally only when both probes and versions still
match. Truncation, a same-size change, a probe mismatch, or incompatible state
causes a complete decode and normalization. Checkpoints are not persisted, so
the first refresh after process startup is always complete.

Incremental decoding begins at the last committed newline rather than the old
EOF. Consequently, an unterminated tail—including partial UTF-8 or an oversized
line—is reread on later refreshes and remains invisible until its terminating
newline arrives. The decoder bounds every batch at the EOF observed from the
same open file handle used for probes and decoding.

- Empty lines are ignored.
- Malformed JSON and JSON values that are not objects are skipped with a
  diagnostic.
- Lines larger than 8 MiB are skipped with a diagnostic.
- A final line without a newline is treated as an incomplete live-write
  fragment and is not decoded or reported until it is terminated.
- Codex session diagnostics retain only the first 50 entries in production
  order. Additional diagnostics are silently discarded.

## Record normalization

- `session_meta` records do not become timeline items. A `turn_context` record
  becomes an `internal` item whose decoded record is available only through its
  lazy detail endpoint.
- A `response_item` message is accepted only when its role is `user`,
  `assistant`, or `developer`.
- Message content includes only `input_text`, `output_text`, and `text` parts.
  A message without accepted text content is dropped.
- Every accepted response message becomes a `directive`; response and event
  records are intentionally retained without duplicate matching.
- Legacy `user_message` and `agent_message` events require a non-empty string
  `message` and become user and assistant conversation messages respectively.
  Invalid message events become safe `internal` summaries of their event type.
- Newer `item_completed` events become conversation messages only for these
  allowlisted item shapes: `UserMessage` joins non-empty `text` content parts
  into a user message, `AgentMessage` joins non-empty `Text` content parts into
  an assistant message, and `Plan` accepts a non-empty `item.text` as an
  assistant final message. Joined parts are separated by a blank line.
  `AgentMessage` phases `final` and `final_answer` normalize to `final`, while
  `commentary` is retained. Only `Plan` publishes its item type as the message's
  `itemType`; user and agent messages leave `itemType` unset. Empty, non-text,
  and all other completed items become `internal` events labeled
  `item_completed.<subtype>` when the subtype is usable.
- Every `token_count` event becomes a `token` item. Only non-negative integer
  counters in `total_token_usage` and `last_token_usage` are retained; missing
  groups become unavailable. Rate limits and unknown payload fields are
  discarded.
- Every reasoning response becomes an `internal` item with event type
  `reasoning`. Semantic summaries are not parsed; all compatibility summaries
  use `Internal event: <eventType>`.
- Recognized tool calls and outputs become separate append-stable tool items.
  An output links directly to its preceding call by `call_id` during the same
  forward scan.
- A `request_user_input` function call and its recognized output become separate
  append-stable `user_input` items linked by `call_id`. Requests retain their
  questions and options. Outputs retain exact answers, an aborted outcome, or a
  safe unavailable fallback when their shape is not recognized.
- Other typed records become safe `internal` event types. A record without a
  usable type becomes a diagnostic.

## Client visibility

Timeline pages include every normalized item kind. The client always displays
user and assistant messages and `user_input` items, then independently filters
`directive`, `tool`, `token`, and `internal` items. Those four technical
event kinds are hidden by default and can be enabled without reloading the
timeline. Internal events show only their type until the user requests their
formatted JSON detail. Directives up to 512 JavaScript code units are shown inline as literal
plain-text blocks; longer directives retain their lazy detail control. An
inline directive is also hidden when either of the two preceding or two
following loaded timeline items is a message with exactly the same text. This
comparison uses the unfiltered timeline, so event visibility does not change
the matching neighborhood. Enabled kinds are stored in the page URL
as one comma-separated `show` parameter.

Loaded `user_input` request and response items are projected into one card by
`call_id`. The request is shown as waiting until its output is loaded; the same
card then displays exact selected answers or an aborted state while retaining
the original options. This projection does not rewrite the server timeline or
its cursor prefix.

## Truncation and paging

Truncation preserves an item but shortens its text; it is not filtering.
Message text is capped at 1,000,000 JavaScript code units. Directive, tool, and
formatted internal JSON details are capped at 256,000 code units. Directive and
unavailable-user-input summaries and tool previews share a 256-code-unit limit.
Terminal previews are separately capped at 256,000 UTF-8 bytes and retain only
complete UTF-8 characters.
Timeline paging may defer items to a later page because of the 300-item and
approximately 4 MiB response size budget. To guarantee forward progress, the
first item on a page is always included even when it exceeds that budget.
Client-side filtering never changes page cursors.
