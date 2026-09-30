# Edge-Sonic — API Worker

Scope: `apps/api/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — `fetch` via `EdgeSonicWorker`, plus a re-export of `ScanWorker`
  (from `@edge-sonic/background`) so the `SCAN` Durable Object binding resolves.
- `src/workers/scanStubs.ts` — per-library `SCAN.getByName(libraryId)` stubs (Git
  `doStubs.ts` pattern); `hasScanBinding` gates the DO path with a direct-service
  fallback when no binding is configured.
- `src/workers/EdgeSonicWorker.ts` — Hono routes, no file routing, in this order:
  `securityHeaders` → `onError` → `/health` + SPA shell → `scopeMiddleware` →
  `OPTIONS *` preflight → `/rest/*` limits → `/user/*` (Access) → `/user/*` limits →
  `/user/*` routes → `/rest/*` (Subsonic). Runs `AppConfiguration.validate()` once per
  isolate on the first request. The two limit registrars sit on opposite sides of auth
  on purpose; see below.
- `src/endpoints/BaseRoute.ts` — the shared `WorkerEnv` / `UserContext` types and the
  static helpers every route uses: `getScope`, `readJson`, `requireString`,
  `toErrorType`, `toErrorBody`, `jsonError`, `toErrorResponse`.
- `src/rest/dispatch.ts` — the `/rest` dispatcher: version check, authentication, the
  `RestContext`, and the endpoint table.
- `src/rest/endpoints/` — one module per protocol area. `index.ts` holds the table and
  the known-but-unimplemented list.
- `src/rest/context.ts` — the per-request shape: `songs` (row state) and `songIndex`
  (the aggregate reads), plus `params`, `format`, and `pageSize`.
- `src/user/routes.ts` — the operator API behind Access.
- `src/middleware/` — `scopeMiddleware`, `userAuth`, `rateLimit`, `rateLimitConfig`,
  `securityHeaders`. `index.ts` is the barrel the worker imports from, so the installed
  set is one list rather than one import line per middleware.

## Relative imports, not the `@/` alias

`apps/api` uses relative paths. A tsconfig `paths` alias resolves under `tsc` and under
Vite, so it looks fine everywhere, and fails only where a bundler does not read tsconfig.
The Workers pool was one such bundler; a pre-bundled entry with an alias table was
another. A few `../` segments need no toolchain configuration at all, and the alias is
gone from `apps/api/tsconfig.json` so it cannot be reintroduced silently.

## Route order

The preflight precedes auth because a Fetch-spec preflight carries no credentials by
design, and a browser never issues the real request after a failed one. It is gated on
`Access-Control-Request-Method` so it cannot shadow anything else. The rate limiter
precedes auth so it can key on the resolved identity.

## `onError` speaks both dialects

`/rest` answers with the Subsonic envelope, because a client parsing that surface has no
way to interpret anything else. Everything else answers through `toUserResponse`,
which keeps a 4xx and its message and masks a 5xx. The blanket 500 this replaced meant a
missing field, a duplicate slug, and a grant for a library that does not exist were all
"InternalServerError" — an answer an operator cannot act on and a support ticket that
cannot be reproduced.

## The two error dialects, and why the split is by surface

`/rest` answers in the Subsonic envelope. Everything else answers in
`{Exception:{Type,Message}}` — the shape the reference project used, which the SPA
already decodes. This is **not** a leftover of copying the reference: the argument
against `Exception` is specific to `/rest`, where a client branches on the envelope and
treats a 401 with an unrecognized body as "server error". An SPA reads the HTTP status,
so the same shape is correct here.

One surface has one dialect, enforced. A 429 from the rate limiter used to hand-build
`Exception` while every other user error emitted `{error:{code,message}}`, so a client
needed two decoders. Both now route through `toUserResponse` / `BaseRoute.toErrorBody`,
and a test asserts the body has exactly one key.

`BaseRoute` lives in `src/endpoints/BaseRoute.ts` and owns `WorkerEnv`, `UserContext`,
and the shared statics. It used to sit in `user/routes.ts` (previously `admin/routes.ts`) and be imported backwards by
`rest/dispatch.ts` and `middleware/userAuth.ts`; a route module owning the type that
`/rest`, `/user`, and the auth middleware all share is what let three of those files
re-declare their own copy, and two of the copies had already drifted.

## The user rate limits come after auth

`registerUserRateLimits(app)` is registered **after** `app.use('/user/*', userAuthentication())`,
because the limiter keys on `c.get('AuthenticatedUserEmailAddress')` and that variable does not exist until
auth has run. The previous order registered limits first while a comment claimed the
opposite ("before auth, so they can key on the resolved identity"), so every bucket
silently fell back to `ip:…` and several operators behind one NAT shared a budget.

`/rest` limits are registered *before* its route instead, because a Subsonic client
authenticates inside the dispatcher from `u`/`t`/`s` query parameters: there is no
ambient identity on that surface to read.

`RATE_LIMIT_DEFS` carries a `surface` field rather than being sliced by array index. The
reference project uses `slice(0, 3)` / `slice(3)`, so inserting a definition at index 3
silently reclassifies it and a new `/rest` limit starts being keyed on the user identity.

## One trusted client address

`clientIp` in `middleware/rateLimit.ts` trusts `CF-Connecting-IP` and nothing else, and
takes a header reader rather than a Hono context so `rest/dispatch.ts` shares it. The
previous `/rest` chain also accepted `x-real-ip`, which is client-controlled: rotating it
per attempt keeps the D1-backed **fail-closed** credential throttle from ever incrementing,
so an offline brute force works forever. With no trusted address at all, callers share the
`unknown` bucket — fail-closed grouping rather than per-spoofed-header isolation.

## A `no-store` predicate must name a served path

`isSensitiveJsonPath` checks `/user/` and `/rest/`. It arrived from the reference project
as `startsWith('/user/')` — that project's private surface. This worker registers no
`/user/` route, so the predicate could never return `true` and `Cache-Control: no-store`
was never applied to anything: `/user/me` and `/user/users` shipped with no
`Cache-Control`. Nothing else in the app would have said so, because the Subsonic envelope
sets its own `no-store` and the tests that existed all passed. Asserted in
`test/security-headers.test.ts`.

## The list shapes, and the one element that is not a record

- `elList(name, listKey, attrs, children)` declares the repeated element's name, so an
  **empty** list serializes as `[]` rather than as an absent key. The name is a
  parameter, not inferred: with no children there is nothing to infer it from.
- It flags **only** the child named by `listKey`. `playQueue` and `bookmarks` mix a
  repeated element with scalar siblings (`current`, `position`, `username`), and
  flagging those made `playQueue.current` a one-element array.
- An element's **name is the JSON key a client reads**. A `song` element inside a
  `bookmarks` wrapper produces `bookmarks.song` and leaves `bookmarks.bookmark` as its
  empty seed, so a client following the schema sees nothing.
- An element with no attributes and exactly one scalar child **is** that scalar:
  `<position>42000</position>` is `42000` in JSON, not `{"#text": 42000}`.
- Every other element **is** a record, which is what makes the last rule usable: the
  one exception the schema makes is `user.folder`, and a record there fails to decode.
  See *A scalar the schema says is a scalar* below.

## Paging

`context.pageSize(context.params.optionalInt('size'), 10)`. `params.int` returns the
**number** `0` for an absent parameter, `0` is not nullish, so the fallback never applies
and `pageSize`'s floor turns it into exactly one item. Every paged endpoint shipped that
way at least once.

## A scalar the schema says is a scalar

`user.folder` is typed `Array of int` — "Folder ID(s)" — so each entry is the bare
position, while `musicFolder` carries a `name` beside its `id` and is a record. Building
`folder` as `el('folder', { id })` is the natural reading of the element name and the
wrong shape: an element carrying an attribute is a record to every serializer, so JSON
came out `[{"id": 0}]` where a client modelling `User.folder` as `List<Int>` throws.

It shipped, and the symptom was the worst available one: the throw lands in a client's
**login** path, so a correct server that had answered `ping` and authenticated the
request reported *"failed to connect, check your credentials"*. A wrong shape in a scalar
field is indistinguishable from a wrong password, and nothing in the product could tell
them apart.

The shape is therefore **stated where it is known** — `el('folder', {}, [index])`, a
scalar child the serializer's existing collapse carries — for the same reason `elList`
takes a `listKey`: the serializer cannot tell a scalar-valued element from a record, so
the builder that knows says so. `mf:` in the id kinds is now explicitly un-mintable and
says so, because `getMusicFolders` publishes a position and there is nothing to encode.

## A folder id is a position, and both publishers are one list

`getUser`'s `folder` and `getMusicFolders` are the same list — an `id` from one is what
any other request's `musicFolderId` refers to — so `rest/endpoints/libraries.ts` owns the
list, its order, and both publishers, and `resolveLibrary` resolves a position against
that same order. They did not agree: `getUser` published positions and `getMusicFolders`
published library identifiers, so a client that read an id from `getUser` got `code=70`
from every folder-scoped endpoint.

**No test passed a `musicFolderId` at all.** Each surface's shape was asserted in
isolation, so both halves were green while the round trip between them was never
executed — the comment on `respondWithUser` claimed an invariant that nothing measured,
which is the same defect as the subrequest bound that lived in a comment. The round trip
is `test/music-folder-index.test.ts`, and it is deliberately paired with the shape
assertions: shapes alone pass again on two surfaces that disagree.

`resolveLibrary` still accepts a library identifier, so a client holding one persisted
before this change keeps working. It is authorized by the same grant check, so it is a
second **spelling** rather than a second way past it, and only a canonical position
*in range* is read as one — otherwise `"00"` would shadow a library whose id is `"00"`.

## Ids

`kind:base64url(libraryId \n path)`, kinds `s:`/`al:`/`ar:`/`dir:`/`vid:`/`mf:`/`dira:`.
Album and artist ids derive from the **directory**, never the name, so a starred album
resolves back to its songs after a folder is renamed. Decoding rejects control characters
and `%XX`, because the payload is split on a newline and a forged id must not be able to
move the boundary.

Refusals are deliberately uniform. An id for a library the caller cannot see answers
`code=70`, not `code=50`, and not `code=10`: `50` would confirm the id is real, turning
the endpoint into an oracle for which paths exist. A position needs no such check — it is
resolved inside the caller's own grant list, so there is no id to forge.

## `getScanStatus` is read-only on the DO path, and a poll that returns is a success

With the `SCAN` binding the scan is alarm-driven: `ScanWorker` (one Durable Object
per library) advances one chunk per alarm, and `getScanStatus` is a passive read
(`getStatus`). Without the binding (tests, local dev) it advances one chunk
(`step`) — the legacy client-driven path. The protocol has no read-only
scan-status method, and the operator surface has one (`GET
/user/libraries/:id/scan`), so a client asking "how far along am I?" observes the
alarm loop rather than driving it.

That shaped how long a poll can take. A chunk is bounded by a subrequest ceiling and a
wall-clock deadline, and it **returns early** when it reaches either, leaving the rest of
the frontier for the next poll. Before the bounds, a chunk on a slow origin ran ~88 s while
clients gave up at ~45 s, so the scan looked stalled and backing off genuinely stopped it.
A bounded chunk returns inside its deadline, so "still scanning" is an answer and not a
symptom — and a client that does back off should keep polling rather than lengthen its
interval, because **polling is the scan**.

Neither bound is visible in the `scanStatus` element, which carries only `scanning` and
`count`. Which bound ended a chunk is on `ChunkResult.stoppedBy`, read through
`POST /user/libraries/:id/scan/step` — a `POST` for the same reason `probe` is, since it
performs live outbound requests with the stored credential.

### `scanning` means "poll me again", which is not what it answered

`scanStatus` carries only `scanning` and `count`, so `scanning` has exactly one job: tell
the client whether another poll buys anything. It answered "did *this* call do work"
instead, and every client reads `scanning: false` as **stop polling** — which is precisely
what stopped a library being scanned. A failed chunk *is* retried, from the frontier in D1,
so it reports `true`; only `stalled`, which has spent its retry budget and will not be
retried without an explicit `startScan`, reports `false`. The distinction is the whole fix,
and the reason `stalled` is a status rather than a flavour of `failed`.

`isAdvancing` lives in `backend-services` beside the state machine it describes, because
the two are one decision: `step` used to answer both inline, and the tangle is what shipped.

The *reason* a scan failed is not on this surface at all. A reason here would be a
non-standard attribute some strict clients reject, and `scanStatus` has nowhere to put one.
It is on `scan_state.last_error`, read through the operator API.

## Stream and download

A `Range` is forwarded verbatim and the upstream `Response` is returned as it arrived —
status, `Content-Range`, `Content-Length`, `Content-Type`. `estimateContentLength` is
deliberately unset: with no transcoding there is nothing to estimate, and a wrong value
makes a player seek to the wrong byte. `download` adds only a `Content-Disposition` whose
filename is stripped of quotes, control characters, **and path separators** — a WebDAV
name is attacker-controlled through a directory listing.

An unsatisfiable range answers with the protocol envelope rather than a forwarded `416`,
because a client parsing this surface cannot read anything else; what matters is that the
body is not audio.

## `code=70` means absent, not empty

`UNIMPLEMENTED` answers `code=70`, and that is right for an endpoint this server does not
have: videos, podcasts, last.fm, lyrics. It is **wrong** for an endpoint that exists and has
nothing to report, and `getOpenSubsonicExtensions` was in that list — the protocol says a
server supporting no extensions returns an empty *list*, and answering a failure from the
**capability-discovery** call told a client it could not ask the question, which is the one
answer it cannot use. It is implemented now and reports `[]`.

`tokenInfo` is the same shape of gap from the other side: it was absent entirely, so a
client holding a stored token — on a server that had just authenticated that token — got
`code=70`. It reports the authenticated `username`, with `username` as an **attribute**, so
JSON gets a record rather than `{ "username": { "#text": … } }`.

The one exception to "authenticate first" is `getOpenSubsonicExtensions`, which the
protocol requires to be **publicly accessible** because a client asking it may have no
credentials yet. It is safe because the payload is a compile-time constant carrying no user,
no library and no version detail, and that is asserted — the whole envelope's key set is
pinned, so adding a version to this response fails a test rather than reaching an
unauthenticated caller. `PUBLIC_ENDPOINTS` in `dispatch.ts` is a named one-entry set rather
than a flag on the handler, because a per-handler "public" marker is one edit from covering
an endpoint that reads data and nothing would say so. `tokenInfo` is deliberately **not** in
it: its entire output is an identity, so answering it unauthenticated would be an oracle.

## The serializer's third list shape

A Subsonic list is `{"wrapper": {"child": [...]}}`, and a single element collapses to a bare
object. `getOpenSubsonicExtensions` needs neither: the protocol's own JSON puts a bare
array at the key, so it is built by hand with `array: true` rather than through `elList`.
That flag alone was not enough — a childless flagged element serialized as `{}`, and the
grouping step wrapped the result again as `[[]]`, so a client reading `.length` got
`undefined` and then `1`. `serialize.ts` now collapses a lone list element back to that
list, which is what makes `array: true` mean "render as a JSON array" rather than "render as
an array wrapped in another array". Same rule as `listKey` seeding, one level out.

## Never

- Never import `@edge-sonic/backend-data` **values** in a route (type-only is fine).
- Never write a D1 predicate that lowercases a column. See the parent index.
- Never batch an `IN (...)` list on a number you chose. Derive it from
  `bindChunkSize`. See the parent index.
- Never let a list wrapper's child name disagree with its declared list key.
- Never mark a `5xx` with a raw error message. A D1 error names tables and columns.
- Never let `getCoverArt` answer with anything but an image. It is the one `/rest`
  endpoint consumed as bytes rather than parsed, so the Subsonic envelope is not a
  lesser dialect there — it is the wrong shape. A `404` from the origin used to become a
  masked `200 application/json`, which a client hands to an image decoder and fails on
  with no diagnostic. It lives in `endpoints/coverArt.ts` because it is the one media
  endpoint that *finds* a picture rather than forwarding one, and that is a different
  shape of problem from `stream`.
