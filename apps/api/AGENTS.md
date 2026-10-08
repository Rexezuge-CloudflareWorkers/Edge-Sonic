# Edge-Sonic — API Worker

Scope: `apps/api/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — `fetch` via `EdgeSonicWorker`, plus a re-export of `ScanWorker`
  (from `@edge-sonic/background`) so the `SCAN` Durable Object binding resolves.
- `src/workers/scanStubs.ts` — per-library `SCAN.getByName(libraryId)` stubs, following the
  `doStubs` pattern Cloudflare's Durable Objects docs describe (that is a documentation
  pattern, not a file in this repository); `hasScanBinding` gates the DO path with a
  direct-service fallback when no binding is configured.
- `src/workers/EdgeSonicWorker.ts` — Hono routes, no file routing, in this order:
  `securityHeaders` → `onError` → `/health` + SPA shell → `/user/` redirect →
  `scopeMiddleware` →
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
  (the aggregate reads), plus `params`, `format`, `pageSize` and `maxOffset`.
- `src/rest/mappers.ts` — song rows to protocol records, and the names both a song element and the
  artist grouping derive. `src/rest/artistIndex.ts` — the artist half (`groupArtistRows`,
  `artistIndexGroups`), split out because it is *artist* work and the two are the shared half of
  `getArtists` and `getIndexes`. `src/rest/albumIdentity.ts` — what an album **is** for one request:
  `albumIdentity` for one library and `identityPerLibrary` for a granted set. `src/rest/paging.ts` —
  the derived `maxOffset`, with the reason an offset needs a ceiling at all.
- `src/user/routes.ts` — the operator API behind Access. `src/user/librarySummary.ts` — the
  library list's projection over `libraries`, `scan_state` and `songs`.
  `src/user/indexDropRoutes.ts` — the Danger Zone's three routes.
  `src/user/importRoutes.ts` — the import surface.
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
`Access-Control-Request-Method` so it cannot shadow anything else.

The two limit
registrars sit on **opposite** sides of auth, for different reasons: `/user/*` limits
come **after** `userAuthentication`, because the limiter prefers the resolved
`AuthenticatedUserEmailAddress` over the client address and that variable does not exist
until auth has run. `/rest` limits come **before** their route, because a Subsonic client
authenticates inside the dispatcher from query parameters — there is no ambient identity
on that surface to key on. See *The user rate limits come after auth* below.

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

## The library list carries a scan summary, and it is a **read**

`GET /user/libraries` publishes each library's `songCount` and `scan`. It carried
`songCount: 0` before — a count the server never computed, on a field whose whole purpose is to
be counted, with no client reading it. A claim on the wire with nothing behind it is the shape a
later reader trusts.

Three things in `librarySummary.ts` are decisions rather than code:

- **`scan` is nullable, and the missing case is not `idle`.** A library with no `scan_state` row
  has **never been scanned**; `idle` means scanned and finished. Folding the first into the
  second renders "Up to date" for a library with nothing indexed — the answer a client reads as
  done, on the one row the operator has to act on.
- **The reads are batched, and there are exactly two.** `MAX_LIBRARIES` defaults to 10, so the
  per-library form is an N+1 against a page the operator loads **and then polls**, and a D1
  query is a subrequest spent on every tick. Batch sizes are derived from D1's measured
  ceiling inside the DAOs.
- **It is a read and does not `ensure`.** `ScanStateDAO.ensure` writes an `idle` row on first
  sight, so using it here would create the very row whose absence carries the "never scanned"
  meaning — on a `GET`, on every poll. Asserted by counting rows after two list calls.

`storedStatus` (`backend-services`) supplies the status mapping, shared with `ScanService.status`,
because `failed` and `stalled` are one stored status separated by a counter: reporting the row's
status verbatim renders a terminal scan as one that is still being retried.

## `probe` is the only surface that still holds the raw hrefs, and it used to discard them

`LibraryService.probe` did `await client.propfind('', { depth: 0 }); return reachable();` — it
threw away the listing it had just received. So a library whose configured root path did not
match the `DAV:href` prefix its origin emitted probed **perfectly clean**: the credential
worked, the origin answered `207`, and not one entry could ever be indexed. That is the same
shape as the scan's prune reading an unmappable listing as a mass deletion — a success verdict
over an absence of evidence.

`reachable(entries, placeable)` now takes the listing and answers `207` with a message naming
the root path when the origin returned entries and none could be placed. Two things it
deliberately does **not** do:

- **It is narrow, and the comment in `probeOutcome.ts` says so.** A `Depth: 0` listing holds
  exactly one entry — the root — so this asks only "could the root be placed?". It will not
  catch a browse-path or enumeration defect further down, and it does not claim to.
- **An empty listing is a success.** An empty folder is a legitimate library with zero tracks,
  so the guard is `entries > 0 && placeable === 0`. Failing every probe that returns a listing
  would be the same over-correction in the other direction, and it would break every probe.

The status stays `207` on the failure, because the origin *did* answer: this is a
configuration fault, and reporting it as unreachable would send an operator off to debug their
own server — the exact failure `classifyBeforeRequest` exists to prevent.

## The Danger Zone drops an index, and keeps the library

Three routes in `user/indexDropRoutes.ts`: `GET /user/index/stats`, `POST /user/index/drop`,
`POST /user/libraries/:id/index/drop`. They empty `songs`, `nodes` and `scan_state` and leave
`libraries` in place — which is the whole difference from `DELETE /user/libraries/:id`, whose
cascade takes the registration **and** the encrypted WebDAV password with it. Before this, a
rejected credential had no remedy but re-registering the origin.

Three things about the shape, and each would have been the obvious alternative:

- **The per-library drop is a `POST` on a sub-path, not a `DELETE`.** `DELETE /user/libraries/:id`
  already exists and means something quite different; a second destructive route under the same
  id that differs only in whether the operator must re-enter a password is a distinction the verb
  should carry. The projection is the one `GET`, because `IndexStatsDAO` has no write method — so
  there is no version of it that can be triggered by a prefetcher into doing damage.
- **There is no confirmation token here.** Every caller of `/user/*` is already an operator —
  Cloudflare Access *is* the authorization boundary, and `users.is_admin` is written but read only
  to render a badge. The two gates are in `apps/web`. What this side owes is **honesty about
  cost**: the figure the dialog quotes comes from the same `billedRowsForTable` that charges the
  delete, so what the operator consents to is what they pay. And the figure is why the drop is
  not merely "expensive": past the daily row-write allowance D1 refuses every query until midnight
  UTC, reads included, so a large drop takes the deployment down rather than slowing the scan.
- **The projection and the measured result are both reported.** `stats` is what the dialog shows;
  the `POST` answers what the deletes **measured**. They differ whenever a scan ran while the
  dialog was open, and when they differ the measured one is what was spent — so it is the one the
  notice renders. Computing the projection here instead would be a second copy of a per-table
  table this layer cannot import (`no-restricted-imports`).

A global drop's measured total cannot be attributed per library, because the three `DELETE`s are
unscoped and `meta.changes` is one number. `IndexDropService` splits it by what each library held
and **corrects the parts to sum to the measured total**, then charges each object its share —
`dailyRowWriteShare` divides the allowance by library count, so an object told the whole bill
would pause itself at a quarter of a budget sized for a quarter.

## `/user/import/*` holds no credential, and that is a layer rule

The import routes live in `user/importRoutes.ts` and reach storage through
`Tokens.ImportSourceService`, **not** `backend-data` — `no-restricted-imports` forbids
`apps/api` from importing that package's values, and `LibraryService` has always owned the DAV
credential's encrypt/decrypt for exactly that reason.

The reason is not tidiness. The credential is read from **two** places — here, to list the remote's
playlists before the Workflow starts, and inside the Workflow, per step, because a Workflow payload
is persisted by the platform and a password can never be part of one. Two readers of one stored
secret is two implementations of "decrypt it", free to disagree about which key, and the
disagreement is a credential that decrypts in one place and not the other.

`createSource` therefore **throws** rather than catching: `BaseRoute.toErrorResponse` is the
documented single path, and the **error class** carries the status. An earlier version mapped
every `BadRequestError` to a 409, which made "that URL is not allowed by the SSRF gate" and "that
remote account is already registered" arrive under one number.

Registration order inside `registerImportRoutes` matters within the module:
`GET /user/import/sources` is registered before `GET /user/import/:id`, and a route table where one
entry silently captures another's is one nothing tests.

The status route is a **read**: the operator's page polls it while an import runs, and a status
read that wrote would spend the allowance it is reporting on — the defect `ScanStateDAO.ensure`
caused on the libraries page, one surface over.

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

- `elList(name, listKey, attrs, children)` declares the repeated element's name. **A
  declared list key with no items is an absent key, not `[]`** — the seeding this used
  to do was removed deliberately, because emitting `[]` made this the only
  implementation answering differently from Navidrome. The name is a parameter, not
  inferred: with no children there is nothing to infer it from.
- `el(name, {}, [index])` states a **scalar**, and `el(name, attrs)` a record — an
  element carrying an attribute is a record to every serializer.
- `elArray` is the fourth shape: a bare array at the parent's key, for a field whose
  wrapper and child are the same word in two grammatical forms (`Child.artists`).
  Pairs with `array: true`.
- It flags **only** the child named by `listKey`. `playQueue` and `bookmarks` mix a
  repeated element with scalar siblings (`current`, `position`, `username`), and
  flagging those made `playQueue.current` a one-element array.
- An element's **name is the JSON key a client reads**. A `song` element inside a
  `bookmarks` wrapper produces `bookmarks.song` and leaves `bookmarks.bookmark` absent, so
  a client following the schema sees nothing.
- An element with no attributes and exactly one scalar child **is** that scalar:
  `<position>42000</position>` is `42000` in JSON, not `{"#text": 42000}`.
- Every other element **is** a record, which is what makes the last rule usable: the
  one exception the schema makes is `user.folder`, and a record there fails to decode.
  See *A scalar the schema says is a scalar* below.
- **An album is two elements over one attribute builder**: `albumElement` is the list
  child (`getAlbumList2`, `getArtist`, `search2`), `albumChildElement` is the `Child`
  shape, and `albumWithSongs` is `getAlbum`'s payload — over `albumAttrs`. The split is
  in the builders because each element's schema is known there and nowhere else; see
  [`docs/agents/protocol/AGENTS.md`](../../docs/agents/protocol/AGENTS.md).

## Paging

`MAX_PAGE_SIZE` (`500`) is **clamped** to `MAX_PAGE_SIZE_CEILING`, which is
derived from the statement budget rather than chosen — a limit the platform imposes is
not a number this code may pick, and `validate()` *reports* the clamp. `DEFAULT_PAGE_SIZE`
is `20`; `context.pageSize(n, fallback)` clamps to `[1, maxPage]`.

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

## The default is the **union**, and a folder still narrows

`resolveLibraries` answers **every** library the caller was granted when no
`musicFolderId` is sent; an explicit one narrows it to that library, so the
protocol's scope-selector model is intact. `resolveLibrary` is the first element
and stays for the per-library callers (`getMusicDirectory`, which browses one
origin).

The reason is a measurement rather than a preference. A release whose track 01 is
in one library and track 03 in another was browsable from **no** `musicFolderId`
at all: folder 0 held half the album, folder 1 the other half, so a client
listed it at `songCount: 1` and never opened the track it was missing. There was
no client view that showed both — so "a user with two libraries is not a user with
a preference between them" was the only reading that made the data reachable.

### The union reaches the **identity**, not only the read — and the mappers make that structural

It was implemented for the *read* and not for the *identity*, in four places. Each bound
`library = libraries[0]` and used it to filter rows or mint ids while reading across the union:

| Surface | What it dropped |
| --- | --- |
| `getStarred` | every starred **song** from the second library, while the starred **albums** in the same response were unioned — so one response was internally inconsistent |
| `getNowPlaying` | the current track, for a user playing something in their second library |
| `getArtist` | every album key outside `libraries[0]`, from the completion fetch — so a split release was published here at a `songCount` of 1 while `getAlbumList2`, `search3` and `getAlbum` reported 2 for the same id |
| every album list | nothing visible under a tag grouping, and a **dead link** under `ALBUM_GROUP_BY=folder` |

The folder case is the one that made it a protocol bug rather than a missing row: under that grouping
the library is **part of** the album id (`albumIdOf`), so a release whose folder lives in library 2 was
published as `al:<library1>:<library2Dir>` — and `getAlbum` decoded it, queried library 1 for library
2's directory, found nothing and answered `code=70`. The tag groupings carry the sentinel and ignore
the library half, which is exactly why the defect survived and only appeared on a per-performer
library.

So the fix is structural rather than a patch per call site: `songToModel`, `songToChild`,
`albumModel`, `groupArtistRows` and `groupAlbumsOf` take **`(song) => AlbumIdentity`** — a resolver —
instead of a `LibraryRow` beside an identity. They used to accept that library argument **and never
read it**, so nothing about the two could be checked against each other; a resolver cannot disagree
with its row. `context.albumsForScope(libraries)` builds one from a granted set. Asserted in
`test/library-union.test.ts`, in both directions for `getStarred`, plus `getNowPlaying` and
`getArtist`.

**And the cost, which is a decision with a witness in
`test/library-union.test.ts`:** `getMusicFolders` still publishes the individual
libraries, so a client with a folder picker can choose one and will then see
*less* than the default. A synthetic "All" entry would fix the incoherence and
shift every published position, and the stored `musicFolderId`s depend on those
positions — so the default carries the union and the list carries the parts.

**`librariesForId` is the only way an endpoint turns an id into a scope**, and it
has two answers because an id names a group or a file. A **song** or **directory**
id names one library, because `path` only means something inside one; the grant
check is `requireForUser`, so an id for a library the caller cannot see is
`code=70` and never `code=50`. An **album** or **artist** id names every granted
library, and that is the branch the union lives on. The union is still
grant-scoped, so the oracle rule holds on it too — a key existing only in an
invisible library resolves to nothing, because the lookup is restricted to the
granted set rather than widened to everything and filtered afterwards.

## Ids

`kind:base64url(libraryId \n path)`, kinds `s:`/`al:`/`alk:`/`ar:`/`dir:`/`vid:`/`mf:`/`dira:` —
except `s:`, which is short and derived (`subsonic/songId.ts`: `s:` plus the
first 128 bits of SHA-256 over `libraryId \n path` as 22 base64url chars, so a
rescan after an index drop recreates it). A reversible song id grows with the path and clients file
downloads under it, so over 255 bytes it is `ENAMETOOLONG` on the client with
no server-side error. Song ids resolve through the row by primary key, and **only** that:
the reversible long form and its `(library_id, path)` fallback are retired, so an
annotation written before the rotation (a star, rating, bookmark, play count, queue
entry or now-playing row) names the old id and no longer resolves. The operator's
decision; see `subsonic/songId.ts`. Album (`alk:`) and artist (`ar:`) ids stay reversible: they name
groups, not files, and are never download filenames.
Artist ids derive from the artist grouping's **name**. Album ids derive from the album's
**grouping key** — `ALBUM_GROUP_BY`, owned by `subsonic/albumKey.ts` and carried per request by
`./albumIdentity` — and never from the album name, which is the part that changes.

### An album or artist id names **no** library, and a song still resolves to one

A short song id carries nothing and resolves to its library through the
row. The scope rule below is unchanged — the grant check is on the resolved library, so an id
in a library the caller cannot see is `code=70`, never `code=50`.

`decodeId` requires a library half (`separator <= 0` is `code=70`), so "this id
names no particular library" is not a payload this repository could otherwise
express — and branching a validator that every id on every surface passes through
is far larger than the feature. So the library half is
`SPANNING_LIBRARY_ID`: a value that satisfies `LIBRARY_ID_PATTERN` and that
`LibraryDAO` never mints, and the all-zeros UUID `wrangler.template.jsonc` already
carries for "no particular library". `decodeId` is untouched.

**Only the two ids that name a *group* carry it.** A song id still names its
library, because the same relative path in two libraries is two files and
collapsing them would point a star at whichever was written last. `al:`
(`ALBUM_GROUP_BY=folder`) also keeps its library — under that grouping an album
*is* a directory, and directories are per-source — so **folder grouping is not
unioned**, and that asymmetry is stated in `albumIdOf` rather than left to be
inferred.

The minting sites were five for an artist and one for an album, so they are
`artistIdOf` and `albumIdOf` now: an id minted two ways is two ids for one group,
and nothing in the response says which is stale.

**A stored annotation survives the re-key**, and `test/library-union.test.ts`
asserts it rather than assuming it — because `resolveAlbumId` decodes to a *key*,
which the widened lookup then finds. An album star written by a client before the
change names a real library and still resolves, attached to the whole release. A
migration to re-point stored ids would have been written on the belief that it did
not, which is why the belief was measured instead.

**An album's year and genre come from the first track that *has* one, not from track 1.**
`year` and `genre` are the two columns `pathConvention` deliberately never derives, so a row the
scan has not range-read holds NULL for both. That was invisible while a derived `X (derived)` and
a tagged `X` were two albums — the tagged half published a year, the derived half published none,
and nobody compared them. `DERIVED_MARKER` now defaults to empty, which merges them, so a merged
album's first track is often the unenriched one and `first.year` reported no year for a release
every other track had one for. The merge introduced the bug; `firstWith` in `albumRecord.ts` is
the fix, and it is asserted on **both** track orderings because the answer must be a function of
the album rather than of which row the statement returned first.

Three things about the album id, each of which is a way to lose a user's library:

- **`alk:` is a new kind rather than a new payload under `al:`.** The payload of a key is
  base64url segments, and `<b64>/<b64>` is itself a valid relative path — so a folder key
  encoded the same way could not be told from a tag key. The prefix says which reading applies,
  so a decode can refuse rather than guess.
- **The payload cannot be a literal album name.** `decodeId` runs `normalizeRelativePath` over
  it, refusing `..`, empty segments, control characters and `%XX` — and `Sgt. Pepper's`,
  `100%`, and every Japanese folder in this product's live library carry them. An id minted
  with the name plainly is one this server cannot read back: `getAlbum` answers `code=70`,
  `getCoverArt` serves the placeholder, nothing says why.
- **`al:` is still accepted and resolves to the whole group.** A client is holding thousands of
  them — every starred album and every album rating. It resolves through the directory and then
  that directory's rows' key, so a pre-change star points at the **merged** album rather than
  the half of it that happened to be its folder. `albumModel` therefore looks a star up under the
  current id *and* under the folder id each row would have had: checking only the current one
  reports a correctly-stored star by nothing at all.

`getAlbumList` and `getAlbumList2` share one grouping on purpose, against the protocol's own
description of them as two views — two album identities would make a client's album id whichever
it saw last, and Navidrome answers both from one album table. The folder view is still reachable,
through `getIndexes` and `getMusicDirectory`.

Refusals are deliberately uniform. An id for a library the caller cannot see answers
`code=70`, not `code=50`, and not `code=10`: `50` would confirm the id is real, turning
the endpoint into an oracle for which paths exist. A position needs no such check — it is
resolved inside the caller's own grant list, so there is no id to forge.

## `paused` is a status the library list can see and `getScanStatus` cannot explain

`/user/libraries` reads each library's scan state from **both** `scan_state` and the per-library
Durable Object, and the DO's answer wins. A pause is held in DO storage because it is usually
*caused by* D1 refusing writes, so `scan_state` is **guaranteed stale** about it: it says
`scanning`, which an operator reads as working. This is the one case where the DO is the
authoritative source for the *status* and D1 is not — the frontier and every count still come from
D1.

Two events are kept apart here, and conflating them is how this page would end up lying twice:

- **D1 is refusing every query** (a spent daily allowance, until midnight UTC). Then this
  projection cannot be built at all — `libraries` is itself a read, so there is nothing to enumerate —
  and the answer is a `503` from `ErrorMapper` naming the limit and the hour it resumes. **Not** a
  partial list and **not** an empty one: "No libraries yet" is the one sentence on this page that
  means something is genuinely absent. The two D1 reads are batched as they always were; nothing
  about the refusal is detected here, because `ErrorMapper` classifies it once for every surface.
- **A scan is paused while D1 is healthy** (the library spent its share of today's allowance). Here
  the DO overlay is what makes the pause visible.

`songCount` is deliberately **not** nullable, which follows from the first bullet: there is no
"count unavailable" row state, because a refused D1 never produces a list at all. Adding one would be
a field with no path that generates it — the same defect as a `stoppedBy` that only one surface can
produce.

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

**The ceiling is a total, and on Free it is 50.** Workers Free allows 50 subrequests per
invocation and a D1 statement is one of them — D1 states its own limit as *queries per Worker
invocation — 1000 (Workers Paid) / 50 (Free)* — so a chunk that budgeted only `fetch` spent
~240 against a budget of 40 and was terminated by the runtime inside its first album, on every
chunk, with `ScanWorker.alarm` re-arming and each dead invocation banking a few tracks. That is
why a scan could report success while no chunk ever completed, and why `stoppedBy: 'requests'`
was **unreachable** — this operator surface has a string for it that could never render, and a
self-inflicted ceiling was recorded against the retry budget as though it were a credential
failure. The string it renders now says the limit is the plan's and the scan continues, rather
than telling an operator to raise a knob Free cannot raise. See
`docs/issues/free-plan-subrequest-ceiling.md`.

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

**`paused` is `false` here and `true` for the alarm, and that is not an inconsistency.**
`isAdvancing` answers *the client's* question — "will my poll buy anything?" — and polling cannot
move a wall clock, so a paused scan answers `false` and the client stops. `willResumeWithoutAPoll`
answers *the alarm's* question and is `true`, or deleting the alarm would leave an allowance spent
until an operator noticed. Two questions, two functions; one predicate for both is the same shape of
defect as the one above it.

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

`UNIMPLEMENTED` carries a `kind`, and `code=70` is the **fourth** of them rather than the
only one: `gone` → 410, `not-implemented` → 501, `not-authorized` → `code=50`, `absent` →
`code=70`. **No entry uses `absent` today**, so the registry answers 410 five times, 501
twelve times and `code=50` three times, and `code=70` from here is unreachable. The seven
endpoints a client calls routinely — `getLyrics` on every track among them — are in
`EMPTY_RESULT`, each with **its own wrapper name**, validated before it answers empty.
`code=70` is still right for an endpoint this server does not have at all, which is the
case `getOpenSubsonicExtensions` was in — the protocol says a
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
an array wrapped in another array". The exception to "an empty list is an absent key", and the reason it is not arbitrary:
it is a bare list at a key rather than a record wrapping one.

## Never

- Never import `@edge-sonic/backend-data` **values** in a route (type-only is fine).
- Never write a D1 predicate that lowercases a column. See the parent index.
- Never batch an `IN (...)` list on a number you chose. Derive it from
  `bindChunkSize`. See the parent index.
- Never let a list wrapper's child name disagree with its declared list key.
- Never mint an id from `libraries[0]` over a union read. Take a resolver; see *The union reaches
  the identity* above.
- Never pass an unbounded `id` list to a per-id loop. `MAX_IDS_PER_REQUEST` refuses with a code a
  client can read; without it the platform terminates the invocation and the client sees a dropped
  connection.
- Never publish a `parent` id computed with `slice(0, lastIndexOf('/'))`. A top-level folder's path
  holds no separator, so that answers `-1` and yields the folder name one character short; and
  `decodeId` refuses an empty path, so the library root has **no id** and is published as `''`.
  `parentOf` in `libraryNames.ts` is the one implementation of both halves.
- Never add an unvalidated parameter to a SQL `LIMIT` or `OFFSET`. `context.maxOffset` is derived
  from the page ceiling; `params.int` bounds an offset by `MAX_SAFE_INTEGER` otherwise.
- Never mark a `5xx` with a raw error message. A D1 error names tables and columns.
- Never let `getCoverArt` answer with anything but an image. It is the one `/rest`
  endpoint consumed as bytes rather than parsed, so the Subsonic envelope is not a
  lesser dialect there — it is the wrong shape. A `404` from the origin used to become a
  masked `200 application/json`, which a client hands to an image decoder and fails on
  with no diagnostic. It lives in `endpoints/coverArt.ts` because it is the one media
  endpoint that *finds* a picture rather than forwarding one, and that is a different
  shape of problem from `stream`.
