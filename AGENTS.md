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
- **A scalar the schema says is a scalar is not a record.** `user.folder` is typed
  `Array of int`, so each entry is the bare position; `musicFolder` has a `name` beside
  its `id` and is a record. Building `folder` as `el('folder', { id })` renders
  `[{"id": 0}]` in JSON, because an element carrying an attribute is a record to every
  serializer. It shipped, and the symptom was the worst available one: a client whose
  `User` model is `folder: List<Int>` throws **inside its login path**, so a correct
  server that had answered `ping` and authenticated correctly reported *"failed to
  connect, check your credentials"*. A wrong shape in a scalar field is
  indistinguishable from a wrong password, so the shape is stated in the builder —
  `el('folder', {}, [index])` — rather than inferred, exactly as `elList` takes a
  `listKey`. Asserted in `test/client-decoding.test.ts`, which decodes our real answers
  with a model written from the schema rather than from our own reading of it.
- **An id the protocol publishes twice is resolved once.** `getUser`'s `folder` and
  `getMusicFolders` are the same list — an id from one is what every `musicFolderId`
  refers to — so one module owns the list, its order and both publishers. They did not
  agree: `getUser` published positions, `getMusicFolders` published library identifiers,
  and a client that read an id from `getUser` got `code=70` from every folder-scoped
  endpoint. **No test passed a `musicFolderId` at all** — each shape was asserted in
  isolation, so both halves were green while the round trip was never executed, which is
  the same defect as the subrequest bound that lived in a comment. Asserted in
  `test/music-folder-index.test.ts`, paired with the shape assertions because shapes
  alone pass again on two surfaces that disagree.
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
- **An applied migration is immutable, and nothing in a `.sql` file says so.** D1 records
  applied migrations by *filename* in `d1_migrations`, so a migration that has run is
  skipped by every later `wrangler d1 migrations apply` — silently, with no warning. An
  applied migration is therefore immutable in fact while being an ordinary text file in
  appearance. `songs.reader_version` was added by editing `0001`; the column never reached
  the live database, so `applyMetadata` and `upsertFileFacts` both failed naming it, every
  enrichment wrote nothing, `getArtists`/`getAlbumList2`/`getGenres`/`search3` answered
  `[]` for a library of 80 albums, `getSong` answered a masked 500, and the scan wedged —
  through 489 passing tests. Two rules, and the second exists because the first did not
  stop it:
  - **A schema change is a new numbered file.** Never an edit to one that has shipped.
  - **`migrations/applied.lock.json` records the sha256 of everything applied**, and
    `test/schema.int.test.ts` asserts both directions — every file on disk is listed, and
    every listed hash matches. Adding a migration means adding a lock entry in the same
    commit; editing an applied one fails the suite instead of the deployment.
    `scripts/hash-migrations.ts` regenerates it and **exits non-zero** on a changed
    existing entry, so the operator running it cannot quietly bless the edit they just
    made.
  The suite was blind to all of it because it `exec`'d one hardcoded migration file, which
  cannot tell *a new migration* from *an edit to an old one* — both produce identical
  bytes on the database it is building. `test/helpers/migrations.ts` reads the **directory
  sorted**, which is what Wrangler does, and reading it immediately exposed a second
  problem: `0001_router_init.sql` is inherited dead code that declares `users` with an
  incompatible shape and left `router_backends` with a **foreign key that does not
  resolve** (`users(email)` against a nullable, non-unique column), so
  `PRAGMA foreign_key_check` failed outright on the real schema. Dropped in `0003`.
- **A failed scan is retried, and the retry is bounded.** `ScanService.step` used to
  short-circuit on any status other than `scanning`, and `fail` sets `failed` — so **one bad
  chunk ended a scan permanently** with the frontier sitting intact and unread in D1. A
  library of eighty albums stayed at one scanned folder for the life of the deployment,
  and `getScanStatus` reported `{"scanning": false, "count": 1}` because it derived
  `scanning` from the status, which is exactly what a client reads as *stop polling*. Only
  `startScan` recovered, and `startScan` runs at client startup, not while browsing. The
  module header claimed the opposite and the claim was true of the frontier and false of
  the code reading it. So: a `failed` scan is re-entered, bounded by
  `scan_state.consecutive_failures` — a bound, because unbounded is the opposite defect
  (a revoked credential re-attempted for ever, spending the operator's subrequest budget to
  reach the same conclusion each poll). `stalled` is separated from `failed` because they
  mean **opposite things about what happens next**, and `getScanStatus` answers
  "will more work happen if I poll again", not "did this call do work". Asserted in
  `test/scan-incremental.test.ts` (resumes; gives up; `startScan` resets) and
  `test/endpoints.test.ts` (the wire shape, since the mapping is the client-facing claim).
- **A row with no tags is absent from every aggregate, not shown with a blank name.**
  `listAlbums` filters `album_ci IS NOT NULL AND album_ci <> ''`, `listArtists` filters
  `artist_ci IS NOT NULL`, `listGenres` filters `genre_ci IS NOT NULL` — and those columns
  are written *only* by a tag read, which costs one ranged request per track and is bounded
  twice over. So for a library of any size most rows are unenriched for a long time, and
  the whole tag-organized half of the protocol answers `[]` while `getRandomSongs`, which
  does not group, returns rows happily. It shipped. The fix is to derive `album`/`artist`
  from `dir_path` at index time (`pathConvention.ts`, handling both `Artist/Album` and the
  flat `Artist - Album` layout), written through the existing upsert rather than as extra
  statements. `genre`, `track` and `year` are deliberately **not** derived: a guessed genre
  is offered to the user as fact, and `getGenres` would publish it with a song count. An
  uninformative path yields NULL, never `''`, because `''` groups under a blank name — the
  same defect `NodeDAO.listRoots` had with the root.
- **Indexing only happens on change, so deriving there is not enough — and the symptom
  hides in the one endpoint that does not group.** Every writer of the grouping columns is
  gated on the file having *moved*: the `Depth: 0` root probe, `isScanned: !changed`,
  `if (changed)` in `reconcileFolder`, and the read-through `getMusicDirectory` path. That
  gating is correct — it is what makes a rescan of an unchanged library cost one
  subrequest — and the consequence is that the derivation is **unreachable for an
  already-indexed library**, so its aggregates never recover without a file changing. It
  shipped *twice*, the second time as a fix that changed nothing: 113 rows on a live
  library, all indexed before the deploy, all with `album_ci`/`artist_ci` NULL, and
  `getArtists`/`getAlbumList2`/`getGenres`/`search3` answering `[]` after a redeploy that
  carried the derivation. Per-track everything looked fine, because `rest/mappers.ts`
  falls back to the folder name when `album` is NULL — **the one endpoint that does not
  group in SQL was the only one that looked healthy**, which is why this took a whole
  deployment to name. Four rules, and the first two are why the second attempt worked:
  - **The backfill runs where the rows are, not where the files are.**
    `SongDerivationDAO` re-runs the *same* `deriveFromPath` over rows the walk will never
    revisit. Deriving the same fact in SQL was rejected: a second implementation of the
    convention, free to disagree over the separator rules and the marker, and a
    disagreement between two naming conventions is invisible until a client groups a
    library wrongly.
  - **It runs on every poll, ahead of the status check.** A fully scanned library is
    `idle`, and `idle` returns from `step` without touching the walk — so a backfill
    placed after the status check never runs for precisely the libraries that need it.
  - **The selection is on `derived_version`, not on NULL**, and the write is a `CASE` on
    `DERIVED_MARKER`: replace a value that is itself a guess, fill a NULL, leave a real
    tag. `NULL` alone cannot express a *corrected* convention — this is the
    `reader_version` invariant one layer down, and a plain `COALESCE` would re-select the
    row and then decline to change it, which is a version column that buys nothing. It is
    also why the marker sits on the **album** as well as the artist: artist-marked and
    album-bare means a version bump can correct a wrong artist and never a wrong album.
  - **It never stamps `enriched_at`.** `EnrichmentService` short-circuits on that, so
    claiming a row was read means a track with `duration: 0` is never range-read on first
    play — a backfill that repairs the grouping by breaking enrichment.
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
- **A double that models *an* implementation of the platform is not modelling the
  platform.** The DAOs run against `node:sqlite` precisely so a wrong predicate and a right
  one differ in the query plan, and that instinct was right. But D1 is SQLite with a
  **different build**: `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 in Node's and **100** in
  D1's. So the double was structurally incapable of failing the way the product fails — and
  `songsForAlbumKeys` bound two variables per album group, so **any** request for 50+ albums
  raised `too many SQL variables` and answered a masked `code=0` on the endpoint a player
  draws its album list from. `listArtists` bound one per artist against callers asking for
  500, 5,000 and 500, so `getArtists`, `getArtist` and `getCoverArt` were each a guaranteed
  failure on a library with 100+ artists. 500+ tests were green throughout.
  `listIdsIn` was the sharpest, because it *did* guard: it batched at 200 under a comment
  reading "SQLite's limit (999 by default)" — a real guard whose stated budget was fiction,
  at twice the ceiling. The generalization is the transferable part. Being the same
  *engine* earned this double the trust that being the same *build* requires, and that trust
  is what hid the bug. `helpers/sqlite.ts` now enforces the ceiling on every statement, and
  the batch sizes are **derived** from one measured constant (`bindChunkSize`) rather than
  chosen per query — a number typed beside a query is wrong by the time someone raises a
  page size. Asserted: removing the batching from any of the three sites, dropping the
  re-sort that makes a chunked fetch order-independent, raising the constant to 999, or
  removing the double's own enforcement each turn tests red.
- **A limit the platform imposes is not a number the code may choose.** `MAX_PAGE_SIZE` is
  500 and D1 binds 100 parameters, so a 500-album page was a request this server was
  *obliged* to accept and could not answer. Same shape as `SCAN_CHUNK_MAX_REQUESTS` being
  1,000 against a 50-subrequest ceiling: a configured maximum read as a permission rather
  than as an obligation on everything below it. A chunk bound is a claim about the code
  beneath it, and it is only true if something measures it.
- **`code=70` means the endpoint is absent, not that it has nothing to report.**
  `getOpenSubsonicExtensions` sat in the `UNIMPLEMENTED` registry with the reason "no
  extensions are advertised", so the **capability-discovery** call answered a failure —
  the one answer a client cannot act on, from a server whose every envelope carries
  `openSubsonic: true` and therefore sends clients looking for it. It returns `[]` now, and
  is the sole entry in `PUBLIC_ENDPOINTS`, because the protocol requires it to be reachable
  without credentials; safe because the payload is a compile-time constant, asserted on the
  whole envelope's key set so a future version string cannot reach an anonymous caller.
  `tokenInfo` was absent entirely, so a client holding a stored token got `code=70` from a
  server that had just authenticated that token. Both were found by reading the
  OpenSubsonic endpoint list against the registry — and nothing in the suite asserted the
  registry covers what a real client calls, which is the same "a comment claiming an
  invariant that nothing measured" defect as the subrequest bound.
- **A double may disagree with production about the very column under repair.** The
  `upsertFileFacts` double in `test/scan-incremental.test.ts` wrote `artist: null,
  album: null` while the real `UPSERT_FILE_FACTS` *derived* them. That is the same
  failure as the one above, and it is why the grouping fix appeared to do nothing: the
  suite agreed with itself and with neither production, so every test passed against a
  deployment whose aggregates stayed empty. The double now calls `deriveFromPath` and
  stamps `DERIVED_VERSION` — because a double is evidence only to the extent it models
  the platform, and *which* platform matters as much as modelling it.

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
