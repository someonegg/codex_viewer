# Codex Sessions Reader

A local web viewer for Codex session history stored in your Codex home. It does
not edit, delete, export, or upload session files. With explicit opt-in, it can
send input to an existing tmux-hosted Codex session.

![Codex session catalog](docs/images/codex-sessions-catalog.png)

![Codex session reader](docs/images/codex-session-reader.png)

## Quick start

Requirements:

- Node.js 22.13 or newer
- npm
- A local Codex home (usually `~/.codex`)

Install, build, and start:

```sh
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4173`. The server prints the exact URL at startup and
detects session changes without a restart. Press `Ctrl-C` to stop it.

## Configuration

Pass server options after `npm start --`:

| Option | Default | Description |
| --- | --- | --- |
| `--codex-home <path>` | `~/.codex` | Codex home containing `sessions/` and optionally `archived_sessions/` |
| `--host <host>` | `127.0.0.1` | Server host |
| `--port <port>` | `4173` | Server port; use `0` to select a free port automatically |
| `--ssl` | disabled | Enable TLS and accept HTTPS only |
| `--ssl-cert <path>` | none | PEM server certificate or certificate chain; required with `--ssl` |
| `--ssl-key <path>` | none | PEM server private key; required with `--ssl` |
| `--ssl-ca <path>` | none | PEM CA bundle; enables mandatory client-certificate verification |
| `--enable-interaction` | disabled | Allow interaction and terminal previews for active sessions bound to an existing tmux pane |
| `--help` | — | Print command-line help |

Example:

```sh
npm start -- --codex-home /path/to/codex-home --port 4180
```

Restart the server after changing configuration.

### TLS and mTLS

Enable TLS with a server certificate and matching private key:

```sh
npm start -- \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem
```

When `--ssl` is enabled, that port accepts HTTPS only. The viewer does not open
a separate HTTP port or redirect plaintext requests.

Add a trusted client CA to enable mutual TLS (mTLS):

```sh
npm start -- \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem \
  --ssl-ca /path/to/client-ca.pem
```

With `--ssl-ca`, every connection must present a client certificate signed by
one of the configured CAs. Certificate, key, and CA files are read at startup;
restart the server after replacing them.

## Features and limits

- Browse active and archived Codex sessions.
- Open each session at a stable `/sessions/:id` URL.
- Filter sessions by project, date range, and archive state.
- Render Markdown, GitHub-flavored Markdown, and KaTeX math.
- Continue reading rollout files while Codex is writing them.
- Enable Live updates for active sessions with a preference remembered for the browser tab.
- Handle malformed or unknown records with diagnostics where possible.
- With `--enable-interaction`, interact with a user-bound tmux pane and manually
  preview its terminal contents. Archived sessions remain read-only.

The viewer never starts Codex or creates or manages tmux. To bind an active
session, run the activation command shown at the bottom of that session's
timeline from inside its Codex pane. The interaction panel is shown only while
Live updates are enabled.

The viewer reads `rollout-*.jsonl` files and the advisory `session_index.jsonl`;
it does not inspect Codex databases. It applies size limits when reading and
serving session data. See
[Session JSONL filtering rules](docs/session-jsonl-filtering.md) for supported
records, truncation, and visibility rules.

## Security

The server listens on loopback by default. It rejects path traversal and symlink
escapes, does not enable permissive CORS, and does not expose rollout file paths
or raw Codex records. Interaction endpoints are disabled unless the process is
started with `--enable-interaction`. Enabling them does not add authentication;
they use the same network trust boundary as the read API.

Rendered Markdown cannot run raw HTML. Remote images are replaced with text,
and unsafe links are disabled.

Loopback protects against network access, not other processes or users on the
same machine. If you bind to a non-loopback address or place the viewer behind a
reverse proxy, add authentication and restrict network access—especially when
interaction is enabled, because any client that can reach the viewer can call
its interaction endpoints.

## Architecture decisions

Accepted architecture decisions are recorded under [`docs/adr`](docs/adr):

- [ADR-0001: Generation-based whole-file session snapshots (superseded)](docs/adr/0001-use-generation-based-session-snapshots.md)
- [ADR-0002: JSONL-only session discovery](docs/adr/0002-use-jsonl-only-session-discovery.md)
- [ADR-0003: Session source adapters](docs/adr/0003-use-session-source-adapters.md)
- [ADR-0004: Session-scoped reader revisions (superseded)](docs/adr/0004-use-session-scoped-reader-revisions.md)
- [ADR-0005: Query-scoped revisions for session-list pagination (superseded)](docs/adr/0005-use-query-scoped-revisions-for-session-list-pagination.md)
- [ADR-0006: Conditional read cursors for session resources (superseded)](docs/adr/0006-use-timeline-prefix-continuity.md)
- [ADR-0007: Adapter-discovered tmux interaction](docs/adr/0007-use-adapter-discovered-tmux-interaction.md)
- [ADR-0008: Multi-page catalog and reader](docs/adr/0008-split-session-catalog-and-reader-into-an-mpa.md)
- [ADR-0009: Opaque single-writer timeline cursors](docs/adr/0009-use-opaque-single-writer-timeline-cursors.md)
- [ADR-0010: Opaque session-list cursors](docs/adr/0010-use-opaque-session-list-cursors.md)
- [ADR-0011: Repository-probed bounded long polling](docs/adr/0011-use-repository-probed-bounded-long-polling.md)
- [ADR-0012: Checkpointed incremental rollout loading with probe validation](docs/adr/0012-use-checkpointed-incremental-rollout-loading.md)
- [ADR-0013: Browser-side session archive filtering](docs/adr/0013-filter-session-archive-state-in-the-browser.md)
- [ADR-0014: Tab-scoped Live update preference](docs/adr/0014-remember-live-updates-per-browser-tab.md)
- [ADR-0015: Session index names as presentation metadata](docs/adr/0015-expose-session-index-names-as-presentation-metadata.md)

## Development

Run the client-only Vite server:

```sh
npm run dev
```

This does not provide the local session API. Use `npm run build` followed by
`npm start` when testing real session data.

Verification commands:

```sh
npm run typecheck
npm test
npm run build
```

When `tmux` is available, include the real transport integration test with:

```sh
npm run test:all
```

Run the optional scale benchmark with:

```sh
npm run benchmark:scale
```

## Troubleshooting

**No sessions appear**

Pass `--codex-home` with the directory containing `sessions/`, not `sessions/`
itself. Session files must be regular files named `rollout-*.jsonl`.

**The port is already in use**

Choose another port:

```sh
npm start -- --port 4180
```

## Uninstall

Stop the server and delete this repository. The viewer creates no database,
background service, or cache in your Codex home, so your sessions are not
affected.
