# Edge-Sonic — Index

Scope: the whole repository. Per-area guides are in the table at the bottom.

**Edge-Sonic** serves the Subsonic REST API v1.16.1 from a WebDAV library. WebDAV is
the only data source, D1 is the authoritative index, and KV is a cache the server is
built to work without.

- **Protocol**: `packages/subsonic` — reversible ids (`kind:base64url(libraryId \n path)`),
  one node model with three serializers (XML/JSON/JSONP), the error codes, MD5.
- **Origin**: `packages/webdav` — a strict 207 reader and a client that sets the stored
  credential in exactly one place and forwards `Range` verbatim.
- **Tags**: `packages/media-tags` — MP3, FLAC, Ogg Vorbis/Opus. Read from a *bounded
  prefix*, never the whole file.
- **Index**: D1 `nodes` (the folder tree, one row per entry) and `songs` (one row per
  track). No `albums` table: an album is a group, and grouping in SQL is how the counts
  went wrong.
- **Scan**: client-driven and chunked. `getScanStatus` advances one chunk; nothing runs
  on a schedule.
- **Admin**: `apps/api/src/admin` + `apps/web`. Guarded by Cloudflare Access, never by a
  Subsonic credential.
- **Keys**: two Secrets Store secrets, one per feature. Never merged.

## Hardening invariants

Violating any of these reintroduces a fixed defect. The suite asserts each one.

- **D1 predicates: lowercase the _parameter_, never the column.** `lower(col)` cannot
  use an index, so the authenticated hot path becomes a full table scan. Every writer
  stores a lowercased twin, so this changes no matching semantics. Paths are the
  exception and are exact: a WebDAV origin on Linux is case-sensitive, and lowercasing a
  path merges two real folders.
- **The album/artist/genre queries page over groups, then fetch every row of the groups
  on the page.** A SQL `GROUP BY` returns one *representative row* per group, so the
  counts computed from it are 1 for a real discography. This shipped once: every album in
  the product reported `songCount: 1` and its first track's duration.
- **A changed file invalidates its own enrichment, in the same statement.** The upsert
  compares `mtime_ms` and clears `duration`/`bitrate`/`sample_rate`/`channels`/
  `enriched_at` together, so there is no window where a row claims a new mtime with the
  old duration — and `enrich`, which short-circuits on `enriched_at`, re-reads it.
- **`await` the authorization check.** A `void`ed `requireForUser` starts the check and
  discards the rejection, so the write it was guarding proceeds. It shipped: a play
  queue accepted an id for a library the caller could not see.
- **An ordered id list stays ordered.** `id IN (...)` returns rows in index-scan order, so
  `listIdsIn` re-orders to the caller's list. A play queue that reshuffles between polls
  is worse than no queue.
- **The cache is never load-bearing.** D1 answers everything; KV only avoids a repeat.
  `KvCache` fails soft, and its circuit breaker is module-level so one outage opens it
  for the whole isolate rather than per request scope.
- **Cache keys carry `scan_state.index_version`.** A superseded entry becomes
  structurally unreachable, so invalidation costs zero writes — the free plan allots
  1,000 writes a day against 100,000 reads.
- **5xx bodies are masked.** `toSubsonicError` logs the cause and returns a localized
  generic message; a D1 error names tables and columns.
- **An absent value is a value.** An empty Subsonic list serializes as `[]`, and an
  element's name is the JSON key its wrapper declares. A client doing
  `response.starred2.song.map(...)` throws on an absent key and renders an empty screen
  on `[]`.
- **`params.int(name, undefined)` is not `undefined`.** It returns the number `0`, which
  is not nullish, so a `pageSize(params.int('count', undefined), 10)` fallback never
  applies and the floor turns it into one. Use `optionalInt` for "was it sent".
- **Untrusted names never reach a header unescaped.** `Content-Disposition` escapes
  quotes, control characters, **and path separators** — a WebDAV entry named
  `a";b/../../evil.flac` is a legal name and quoting it does nothing.
- **A dev bypass is gated on an allow-list of environments.** A deny-list enables it for
  `staging`, `Preview`, and a misspelled `prodcution`.
- **Never rebuild a parent table.** D1 runs each migration in an implicit transaction,
  so `PRAGMA foreign_keys = OFF` is unavailable and a `DROP TABLE <parent>` becomes a
  `DELETE FROM parent` that fires every cascade beneath it. Only a child may be rebuilt.

## Test doubles must model the platform

A double that shares a wrong assumption with the code it tests makes both look right. Two
from this repository's own history:

- The reference project carried `lower(owner_email) = lower(?)` through a full green
  suite because its D1 double lowercased both sides in JavaScript. The rows were
  identical; only the query plan differed. **D1 is SQLite, so the DAOs run against
  `node:sqlite`** — the real engine, with a real planner, so `EXPLAIN QUERY PLAN` is an
  assertion rather than a hope.
- The FLAC fixture and the FLAC reader shared a wrong byte offset, so every duration was
  wrong by 2^16 and nothing failed. When a fixture and a reader can both be wrong the
  same way, **the fixture is written from the spec** and the offsets are spelled out.
- `fakeDav` used to answer any `Range` with the whole file and a `Content-Range` header
  claiming a prefix. That models a server lying about what it served, and it hid the one
  bug this product exists to avoid. It truncates now, and answers `416` past the end.

## Commands

```bash
pnpm install --ignore-scripts
pnpm run checks        # pnpm -r typecheck + lint + god-files + SPA shell
pnpm -r typecheck
pnpm run lint          # eslint --fix
pnpm run test
pnpm run test:coverage # with the coverage gate
pnpm run build         # apps/web -> apps/api/src/generated/spa-shell.ts
pnpm run typegen       # wrangler types from the template
pnpm exec wrangler dev
```

The committed `wrangler.jsonc` is **local development only** and is the one config that
carries a `DEV_AUTH_EMAIL` bypass and the two raw 32-zero placeholder keys;
`apps/api/wrangler.template.jsonc` is what a deployment starts from, and it omits both.
`worker-configuration.d.ts` is generated and gitignored. The god-file guard is 300 warn /
400 error, and `test/` is a workspace project so both `pnpm -r typecheck` and `pnpm run
lint` reach it.

Coverage floors are a **measured** floor (78/65/79/80 against 79/66/81/82), not an
aspiration — lower one to make CI green and the gate stops saying anything.
`packages/backend-errors` is excluded, and says why in the config: it is a pure taxonomy
whose *mapping out* is tested.

## Layers

```
shared, backend-errors, subsonic, media-tags, webdav -> 0 deps
backend-runtime   -> layer 0 only
backend-data      -> layer 0 only
backend-services  -> layers 0-2 (not apps)
apps/api          -> layers 0-3 + webdav (NOT backend-data values; type-only allowed)
```

Enforced by ESLint `no-restricted-imports` in `eslint.config.mjs`.

## Index

| Area                          | Guide                                        |
| ----------------------------- | -------------------------------------------- |
| API worker, routes, `/rest`   | `apps/api/AGENTS.md`                          |
| Admin SPA                     | `apps/web/AGENTS.md`                          |
| DAOs, schema, D1 rules        | `packages/backend-data/AGENTS.md`             |
| Services, auth, composition   | `packages/backend-services/AGENTS.md`         |
| Bindings, wrangler, secrets   | `docs/agents/runtime/AGENTS.md`               |
| Tests, thresholds, doubles    | `docs/agents/testing/AGENTS.md`               |
