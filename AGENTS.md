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
- **User**: `apps/api/src/user` + `apps/web`. Guarded by Cloudflare Access, never by a
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
  `enriched_at`/`reader_version` together, so there is no window where a row claims a new
  mtime with the old duration — and `enrich`, which short-circuits on `enriched_at`,
  re-reads it.
- **Staleness has two inputs, and only recording one makes a fix inert.** What a row
  holds is a function of the file's bytes *and* of the reader that extracted them.
  Keying invalidation on `mtime_ms` alone is correct for the bytes and blind to the
  reader, so a corrected reader leaves every row it already wrote looking current: the
  file genuinely has not moved, so the short-circuit is right and the wrong value is
  served for ever. It shipped. A deploy carrying a fixed Ogg reader left a live library
  reporting a 240.61 s track as 3 s at 15329 kbps with no artist, album, genre, track or
  year, and neither a `getSong`, a rescan, nor a re-index changed it — every part of the
  incrementality logic was working. `songs.reader_version` is the other input, written in
  the same statement as the values, bumped when a change makes a prior extraction wrong;
  the KV entry carries it too, because `enrich` consults the cache before the row. The
  same rule the index already follows for `scan_state.index_version` and `key_version`: a
  superseded value is made **structurally unreachable**, not left to be detected. Asserted
  in `test/enrichment-config.test.ts`, including the paired case proving the guard
  re-reads a stale row rather than only stamping one — a test that only checks the stamp
  would pass with the short-circuit still in place.
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
- **A limit that claims to key on an identity runs after the middleware that sets it.**
  The rate limiter prefers `c.get('AuthenticatedUserEmailAddress')` over the client address, so registering it
  before `userAuthentication` makes it fall back to `ip:…` — silently, and with a comment
  claiming the opposite. A limiter's key and the order that produces it are one decision.
- **A chunk is bounded by a *measured* request count, not by a folder number.**
  `getScanStatus` is not a progress read — it *is* the scan — so one call descending
  `SCAN_CHUNK_FOLDERS` folders sequentially is unbounded work on a surface whose
  clients time out. It shipped: a chunk on a 2.2 s origin took ~88 s while clients
  gave up at ~45 s, so the work finished server-side where nobody was watching, and
  a client that backed off stopped advancing the scan *by construction*. Enrichment
  then moved per-track range reads inside that same loop, taking a chunk from 40
  subrequests to 1,640 — past the ceiling, so a chunk that **fails** rather than one
  that is slow. Two rules, and each is how the previous one collapsed:
  - **The count is taken where the request is issued.** `WebDavClient` takes an
    `onRequest` callback invoked inside its private `request()`, the one path
    `propfind`/`get`/`readPrefix`/`readTail` all funnel through. `webdavRequests`
    used to be `+= 1` inside the walk's loop, which charged the `PROPFIND`s and
    nothing the scan's own enrichment caused — an undercount of up to 40x, on a field
    whose comment claimed it was instrumented "so the budget is testable". A
    caller-incremented counter is a *claim* about work; one incremented at the choke
    point is a measurement of it, and only the second can bound anything.
  - **A bound that is not checked is not a bound.** `webdavRequests` was returned in
    `ChunkResult` and compared against nothing anywhere. There is now a request
    ceiling *and* a wall-clock deadline, the loop checks `canAfford` **before** each
    unit of work, and the remainder of the frontier is simply left for the next poll.
  Asserted in `test/scan-budget.test.ts`: `webdavRequests` is compared against what
  the `fakeDav` double actually received, a `fakeDav` gained a real `latencyMs` so a
  deadline is observable at all, and every bound test is paired with one that shows
  the guard has teeth. The same rule the previous invariant records, one level up: the
  budget lived in a comment and in the choice of default numbers, and **a comment is
  not a measurement**.
- **Size a subrequest budget against the plan that will run it.** Cloudflare retired
  the 1,000-subrequest ceiling on 2026-02-11: Workers **Free** allows **50 external**
  subrequests per invocation and **Paid** 10,000 (raiseable to 10M). This codebase
  sizes every other quota against the free tier, and `SCAN_CHUNK_FOLDERS = 40` was
  already 80% of the whole external budget before a single enrichment read. A default
  of 1,000 is not a slow chunk, it is a **failed** chunk on a Free-plan account, and
  the number sat in a comment that read like a measurement. `DEFAULT_SCAN_CHUNK_MAX_REQUESTS`
  is 40, and `test/scan-budget.test.ts` asserts both the constant and that a real
  chunk stays under it with enrichment on.
- **A `no-store` predicate must name a path the router serves.** `isSensitiveJsonPath`
  once checked a prefix this worker did not register, so the branch was unreachable and the
  operator surface shipped with no `Cache-Control`. A predicate copied from another router's
  route table is an unconditional no-op, and nothing else reports it: the Subsonic envelope
  sets its own `no-store`. Asserted in `test/security-headers.test.ts`.
- **One surface speaks one error dialect.** `/rest` answers in the protocol envelope and
  everything else in `{Exception:{Type,Message}}`; that split is by surface, not by
  convenience. A 429 built by hand while the rest of the user API went through the mapper
  gave one client two decoders, so both now route through `BaseRoute.toErrorBody`.
- **`params.int(name, undefined)` is not `undefined`.** It returns the number `0`, which
  is not nullish, so a `pageSize(params.int('count', undefined), 10)` fallback never
  applies and the floor turns it into one. Use `optionalInt` for "was it sent".
- **Untrusted names never reach a header unescaped.** `Content-Disposition` escapes
  quotes, control characters, **and path separators** — a WebDAV entry named
  `a";b/../../evil.flac` is a legal name and quoting it does nothing.
- **A dev bypass is gated on an allow-list of environments.** A deny-list enables it for
  `staging`, `Preview`, and a misspelled `prodcution`.
- **A deployment placeholder is the exact sentinel, never a readable stand-in.**
  `scripts/prepare-wrangler-config.ts` patches a D1 `database_id` only when it equals
  `DEFAULT_UUID`, and a KV `id` or Secrets Store `store_id` only when it equals
  `DEFAULT_HEX_ID` (32 zeros). A friendlier placeholder is skipped silently, the unpatched
  value reaches `wrangler deploy`, and it fails there as Cloudflare error 10182 rather
  than at the step that caused it. This shipped: `apps/api/wrangler.template.jsonc` used
  `REPLACE_WITH_YOUR_SECRETS_STORE_ID`, and every deploy died on the Worker job while the
  Pages job failed separately on a `wrangler.template.jsonc` that did not exist.
- **A provisioning script exits non-zero when it fails.** `init-secrets.ts` once ended in
  `main().catch(console.error)`: it logged `Unknown secret` and returned 0, so the CD step
  reported success while no key was ever created, and the failure surfaced two steps later
  on the deploy. Same rule as awaiting an authorization check instead of voiding it — a
  discarded rejection is not a failed guard, it is no guard.
- **A diagnostic names its cause, and only one of them is "unreachable".** The probe is
  the only place an operator learns why a library does not work, and it had one `catch`
  and one sentence. A missing Secrets Store binding, a rotated WebDAV key, an
  SSRF-policy refusal, and a dead host all reported *"Library is unreachable."* — so a
  fault in **this** deployment sent the operator off to debug their own server. It
  shipped against a live origin answering `207` with a correct password. Three rules,
  and each is a way this collapsed: a `try` per step rather than one around all of
  them, so a `catch` cannot mean more than one thing; a fault with no HTTP status is a
  **category** (`resolveKey`, `decryptData`), not a network failure; and a timeout is
  translated into a status, because `AbortSignal.timeout` rejects with something that is
  neither an `Error` shape nor a status and therefore reached the residual branch.
  Asserted in `test/library-ssrf.test.ts`, including the case that *does* say
  "unreachable" — without it the other three pass vacuously.
- **A platform global is invoked bare, never as a stored field.** `WebDavClient` kept
  the global `fetch` in a field and called it as `this.fetchImpl(...)` — a *method call*,
  so the receiver was the client rather than the global scope. workerd validates that
  receiver and throws `TypeError: Illegal invocation: function called with incorrect
  'this' reference.` It broke every WebDAV path in the product — probe, scan, tree,
  enrichment, streaming — against a live origin answering `207`. Being a `TypeError`, it
  has no `status`, so it fell through every status-based branch and reached the operator
  as *"Library is unreachable."*: a fault in **this** server, described as a fault in
  theirs. The wrapper lives in the constructor, so no call site can reintroduce it, and
  the same mistake is worth grepping for after any refactor that stores a function.
- **A double that cannot observe a failure is worse than no double.** 423 tests were
  green throughout the above. `fakeDav`'s `fetch` was an **arrow function**, and an
  arrow has no `this` binding, so it was structurally incapable of detecting the one
  class of bug it existed to catch — and Node's real `globalThis.fetch` does not check
  its receiver either, so the `vi.stubGlobal` suites inherited the same blind spot. A
  passing test is evidence *only* to the extent the double shares the platform's
  assumptions. `withReceiverCheck` now models the receiver: 33 tests across 5 suites go
  red against the bug, including a paired test that proves the guard has teeth, without
  which the guard could be quietly removed and the first test would pass forever.
- **A stored failure is read back, or it was never written.** `scan_state.last_error`
  was populated on every scan failure and read by nothing, and `apps/web` declared a
  `ScanStateSummary.lastError` the server never sent — so a failed scan rendered the
  bare word "failed" while the reason sat in the database. Persisting a diagnosis
  nobody can retrieve is the same defect as never computing it, and the type declared
  the field, so nothing ever reported the gap. Wiring it up is what named the
  `Illegal invocation` above: the reason had been in the database the whole time.
- **Never rebuild a parent table.** D1 runs each migration in an implicit transaction,
  so `PRAGMA foreign_keys = OFF` is unavailable and a `DROP TABLE <parent>` becomes a
  `DELETE FROM parent` that fires every cascade beneath it. Only a child may be rebuilt.
- **An Ogg page is not a packet, and a granule is only a duration on the last page.**
  Packets are delimited by the **segment table** — a packet ends where a lacing entry is
  below 255, and one page may carry several. `libavformat` writes an Opus identification
  header and its comment block as two packets in **one** page, so a reader that looks for
  them only at page starts finds the first and never looks again. It shipped: no Opus file
  reported an artist, album, genre, track or year, and since `getArtists`,
  `getAlbumList2`, `getGenres` and `search3` all group on those columns, a library of 81
  artists answered all four with `[]`. A packet longer than a page continues onto the
  next one, split by that page's header, so its bytes are not adjacent and it must be
  **reassembled** — a comment block with embedded cover art is that case, and reading
  across the gap consumes the page header as comment data.
  Separately, a granule read off a page that is not the end-of-stream page — or off one
  the buffer truncated — is a *number* that is not the file's length. A 240.61 s track
  was served as 3 s and 15329 kbps instead of 191, and a client seeks by it. Returning
  `null` and letting `readOggTailDuration` answer from a second read is the fix; the
  `null` was never the bug, the missing tail read was. Asserted in
  `test/ogg-packet-layout.test.ts`, whose fixtures are written from the framing spec and
  **decode their own lacing table back**, because the existing suite built one packet per
  page — the reader's assumption — and so could not see either defect.
- **A double that compensates for a bug hides it.** `test/scan-incremental.test.ts`'s
  `listRoots` filtered `node.path !== ''` while `NodeDAO.listRoots` did not, so the
  library root's own row reached `getIndexes` as a `shortcut` with an empty `name` — an
  unlabelled entry at the top of the `#` group, whose id then failed with `code 70` — and
  the suite stayed green. A double is evidence only to the extent it shares the
  production assumptions; here it shared the *correct* behaviour and the DAO did not.
  The DAO now runs against real `node:sqlite` for this predicate, where a wrong query and
  a double cannot disagree.

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
- The Ogg fixture and the Ogg reader shared a wrong *framing* assumption — one packet per
  page — so no tag ever parsed and no test failed. The fix is a fixture that builds the
  **lacing table** from the spec and then **decodes it back** (`packetStarts` in
  `test/ogg-packet-layout.test.ts`), so the fixture is checked against the format rather
  than against the reader it exists to catch. A fixture that only mirrors the reader's
  assumptions cannot fail for the reader's reason.
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

Coverage floors are a **measured** floor (79/66/81/82 against 80/67/82/83), not an
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
| Operator SPA                  | `apps/web/AGENTS.md`                          |
| DAOs, schema, D1 rules        | `packages/backend-data/AGENTS.md`             |
| Services, auth, composition   | `packages/backend-services/AGENTS.md`         |
| Bindings, wrangler, secrets   | `docs/agents/runtime/AGENTS.md`               |
| Tests, thresholds, doubles    | `docs/agents/testing/AGENTS.md`               |

## Commit Policy

Always commit changes after completing work unless explicitly told not to.

## Git Commit Messages

Format: `<TYPE>[optional scope]: <description>`

- Type in UPPERCASE: `FIX`, `FEAT`, `DOCS`, `STYLE`, `REFACTOR`, `TEST`, `BUILD`, `CHORE`, `CI`, `PERF`.
- Scope in lowercase: `FEAT(runtime): Add Scheduled Job State`.
- Description: Title Case words — `DOCS: Latest Agents Context Reflection`.
- When committing from `main`, first create a branch: `type/description` or `type/scope/description` in kebab-case (e.g. `feat/bootstrap/bootstrap-jqanywhere-v0.1-framework`).
- Always include a Markdown body separated from the subject by a blank line.
- Breaking changes: `!` after type/scope, or `BREAKING CHANGE: <description>` footer.

```text
<TYPE>[optional scope]: <description>

[Markdown body]

[optional footers]
```
