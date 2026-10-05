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
- **Scan**: alarm-driven and chunked. `ScanWorker` (one Durable Object per library,
  `apps/background`) advances one chunk per alarm; `getScanStatus` is a read-only
  status read when the `SCAN` binding is configured and advances one chunk only
  without it (tests, local dev).
- **User**: `apps/api/src/user` + `apps/web`. Guarded by Cloudflare Access, never by a
  Subsonic credential.
- **Keys**: **three** Secrets Store secrets, one per feature. Never merged — see
  `docs/agents/runtime/AGENTS.md` for what each merge would cost, which are three *different*
  failures rather than one.
- **Import**: `packages/backend-services/src/import` + `apps/background`'s
  `LibraryImportWorkflow` (a Workflow) and `PlayCountImportWorker` (a Durable Object), reading
  another Subsonic server to move playlists, stars, ratings, bookmarks, a play queue and play
  counts into one chosen local user. Operator-triggered from `/user/import/*`.

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
- **An empty list is an absent key, and a list of one is an array.** This **reverses**
  an earlier rule here, and the reversal is the finding. The rule used to be that an empty
  list serializes as `[]`, on the strength of a real incident: a client whose model is
  `@SerialName("song") val songs: List<Song>` throws `MissingFieldException` on an absent
  key and rendered an empty screen on `[]`. That reasoning was sound and the conclusion
  was still wrong, because it fixed the symptom — the throw is a client that cannot
  tolerate an absent optional field, and **every** field here is optional in the schema.
  Emitting `[]` made this the only implementation answering differently from Navidrome,
  which is the more expensive half of the trade: a client written against it works there
  and fails here and nowhere else. Being right about the shape and wrong about the
  ecosystem is not the same as being right. So the seeding is gone rather than
  conditional — a child carrying the declared key already renders as an array, and a key
  no child carries has no items to report. `array: true` is the exception and is
  load-bearing: it is a bare list at a key rather than a record wrapping one, so
  `getOpenSubsonicExtensions` must answer `[]` on the capability call. The two shapes are
  asserted by a test each, because neither assertion survives the other's absence.
- **An attribute the schema does not declare is not an error, and nothing here can see
  one.** `AlbumID3` published `title` and `isDir`; `song.type` published `mediaType`'s
  value. A lenient client drops an unknown attribute and a strict one ignores it, so the
  suite stayed green through all three — and `type="song"` was a value outside `type`'s
  own enumeration, in the one field every client filters on to decide what a row *is*, so
  a player asking `type == "music"` saw an empty library. **The only instrument that
  finds this class is a reference server**: the fact "this attribute is not in the schema"
  exists in the schema, and the schema is not in this repository. `scripts/
  compare-reference.ts` reads the same call off a configured reference and compares
  attribute key sets; committed rather than run once, because a difference reported there
  is a difference a client hits.
- **Two spellings of one question are answered with different element types, and one
  builder serving both is wrong on one of them.** `getAlbumList` answers `Array of Child`
  and `getAlbumList2` answers `Array of AlbumID3`; `searchResult2`/`searchResult3` split
  the same way. One `albumAttrs` published the union, so every album in `getAlbumList2`
  carried two attributes its schema does not declare. **The test that would have caught
  it could not**, because it asserted the two endpoints agree by reading `title` off one
  and `name` off the other — so it passed *because* they disagreed, and could only hold
  while each carried the field it was reading and neither carried the other's. So
  `groupAlbums` returns models and the caller picks the builder, because the wrapper is
  the only thing that knows which element type it is; and the parity assertion compares
  something both endpoints actually publish.
- **One grouping, or two answers to "which tracks are this album".** `listAlbums` grouped
  in SQL on `(album_artist_ci, album_ci)` while the caller regrouped by `dir_path`, and
  every symptom followed from the disagreement rather than from either being wrong alone:
  `LIMIT 5` bounded five SQL groups so a page carried between one and five albums; a
  directory with two `album_artist` values was one album to the caller and two groups to
  the query, so paging split it; and the ordering was chosen three times — by the query,
  by a re-sort leading with `album_artist_ci`, and by a grouping re-sorting by directory
  path — so `type=alphabeticalByName` returned albums in folder order, which for folders
  named `Artist - Album` is an order no client requested and none could predict.
  Unifying them on `dir_path` fixed the disagreement and left the **choice** unmade — which
  is a different defect, and it shipped next.
- **An album is a *configuration*, because a folder and a release routinely disagree.**
  Unifying the grouping on `dir_path` made a library whose folders split a release report one
  album per folder: measured on a live library, 113 tracks in 80 album folders carrying **71
  distinct `ALBUM` values**, nine releases split across folders and one across six, so
  `MementoMori (メメントモリ)` appeared six times and `Ex-Otogibanashi` was cut in half. The
  answer is `ALBUM_GROUP_BY` ∈ `folder | album | album_artist`, default `album` — the same
  decision the reference server exposes as `PID.Album`, and a modelling question with no
  right answer is a *setting*, not a bug. `subsonic/albumKey.ts` owns the question,
  `albumKeySql.ts` writes it as SQL, and `apps/api`'s `albumIdentity` carries it per request.
  Five rules, and each is how the previous one collapses:
  - **The SQL group and the TypeScript group are one function of the same columns**, which is
    the invariant the bullet above is about; the property is now structural rather than
    re-tested per grouping. A fixture with one album in one directory passes under all three
    and can see none of this, so `schema.int.test.ts` holds releases that **span** folders and
    a directory holding **two** albums.
  - **A missing album artist is a value, not a wildcard.** Rows with `album_artist IS NULL`
    group under `(NULL, album)`. Treating absent as "matches anything" merges every untagged
    row into every tagged album sharing its name, and `COALESCE(album_artist_ci, '')` — which
    returns the **same rows** — also silently drops `idx_songs_album`. Asserted with
    `EXPLAIN QUERY PLAN`, because a wrong predicate and a right one differ only there.
  - **The album id carries the key, and a new kind says so.** `alk:` holds base64url segments,
    because `decodeId` runs `normalizeRelativePath` over the payload and a raw album name
    holding `..`, `/` or `%` is an id this server cannot read back. `al:` is still **accepted**
    and resolves through the directory to the whole group, so a star written before the change
    still points at the merged album — and an annotation lookup checks the legacy ids too, or
    a correctly-stored star is reported by nothing.
  - **A partial group is not an album.** `getArtist` and `search3` grouped the artist's own
    rows, which publishes an album holding one track of a compilation and a `songCount` that
    disagrees with every other surface. Both complete each group first.
  - **`getAlbumList` and `getAlbumList2` follow the same grouping**, against the protocol's own
    description of them as two views: two album identities would make a client's album id
    whichever it saw last. The folder view stays reachable through `getIndexes`.
- **An album's tracks have one order, and it was written out three times with two answers.**
  `groupAlbums` sorted `disc, track, name`; `getAlbum` and `getCoverArt`'s artwork probe sorted
  `track, name` — and the two wrong copies **matched each other**, so a two-disc album came back
  interleaved (`disc=1 trk=2, disc=2 trk=3, disc=2 trk=6, disc=1 trk=8, disc=2 trk=14`) with
  every field correct and no error anywhere. It is live on a single-folder album, so no
  configuration is involved. `compareAlbumTracks` is the one definition, and `albumModel` takes
  its `created`/`year`/`genre` from `songs[0]` — so a differing "first track" also made
  `getAlbum` and `getAlbumList2` publish **different `created` for one album**, which is the
  drift recorded below arriving through the sort rather than the literal.
- **A chunked fetch cannot inherit an `ORDER BY`, so the order is rebuilt from the key
  list.** This is `listIdsIn`'s trick and `songsForAlbumKeys`' now, and the failure it
  replaced is the same one the comparator caused: re-sorting by a tuple that leads with a
  *different* column substitutes *alphabetical by artist* for whatever was asked. Assert
  the **concatenation** of consecutive pages, not any one page's order — a re-sort leaves
  every individual page looking plausible.
- **"Not implemented" is four answers, and `code=70` was right for none of them.**
  `getLyrics`, `getShares`, `getArtistInfo`, `getArtistInfo2`, `getTopSongs` and
  `getInternetRadioStations` answered `code=70` while being endpoints a client calls
  routinely — `getLyrics` on every track — so `code=70` said the server had *failed* where
  the truth was that there is nothing to report. `EMPTY_RESULT` answers each with its own
  wrapper and no items, after validating the request: an unresolvable `id` is `code=70`
  and an absent required parameter is `code=10`, because "the lyrics of that song do not
  exist" and "that song has no lyrics" look identical in a response and mean opposite
  things. `UNIMPLEMENTED` carries a `kind`: `gone` → 410, `not-implemented` → 501,
  `not-authorized` → `code=50`, `absent` → `code=70`. **A name in two registry tables is
  routed by whichever was assigned last and reported by neither**, and five were when
  `EMPTY_RESULT` was introduced because the overlap test existed and did not look there.
- **The wrapper element's name is not the endpoint's name.** Six of the seven empty-result
  wrappers differ — `getLyrics` answers `<lyrics>`, `getTopSongs` answers `<topSongs>` —
  and naming one after its endpoint answers `200` with the payload under the wrong key,
  which reads as "no data" rather than "wrong key". Both names are stated.
- **An OpenSubsonic array whose wrapper and child are the same word is a bare array.**
  `Child.artists` is `"artists": [{…}]`, not `{"artists":{"artist":[…]}}`: a Subsonic list
  wrapper puts the value under the *child's* key (`albumList2.album`), and here the wrapper
  and the child are the same word in two grammatical forms, so the array belongs at the
  **wrapper's**. `elArray` exists for it and pairs with `array: true`, which collapses the
  wrapper's single occurrence back to the array it already is. A client whose model is
  `artists: List<Artist>` reads an object and throws — the same failure mode as an absent
  key, and equally invisible from here.
- **Advertising an extension is a claim, and a default is not an absence.** The spec asks a
  server supporting a field to return it *with an empty default* so clients can detect
  support, which makes `bitDepth: 0` the "correct" answer for a column that does not exist.
  So the published set is drawn from two constraints — a client branches on it when
  rendering, and the value already exists — and `bitDepth` is excluded because
  `media-tags` extracts it and nothing stores it. `undefined` rather than a default for
  anything unknown, so "not read yet" is distinguishable from "read, and the answer is
  none"; `duration` cannot afford that, which is why the rule is not applied uniformly.
- **The XML namespace is `http://`, and its absence is invisible here.** It shipped
  missing entirely, and an undeclared namespace is still well-formed XML, so every parser
  in this suite accepted the document and a lenient client ignores the attribute — while a
  client that resolves element names *against* the namespace, which is what the protocol's
  own schema tells it to do, finds no elements at all. The constant was also `https://`,
  where the protocol published `http://`; a namespace is an identifier and not an address,
  so "correcting" it is undetectable on every client that ignores it and fatal on the ones
  that resolve against it. Declared on the **root element only** — in the serializer's root
  handling, never in `attrs`, which would put it in the JSON too.
- **A repeated child of a *record* element is a list too, and it is invisible at n≥2.**
  `elList` states the repeated child's name, and a **wrapper** always goes through it — so
  the empty case and the one-item case were both covered. A record element has no
  `listKey` of its own, and `childrenToJsonObject` collapses a single undeclared child to
  a bare object: `getAlbum` attached its songs to the album element and rendered
  `{"song": {...}}` for a one-track album and `{"song": [{...}, {...}]}` for a two-track
  one. **The shape changed with the data.** It shipped, and a client whose `Album` model
  is `@SerialName("song") val songs: List<Song>` throws
  `Expected JsonArray, but had JsonObject ... at path: $.song` on every single-track
  album. Two things hid it, and each is its own rule:
  - **A fixture with two items cannot see a collapse.** The suite's album holds two
    tracks, so the array path rendered everywhere it was looked at, and the two `getAlbum`
    tests asserted album *attributes* — never `album.song`. Assert **both** sizes, or the
    guard is a fixture rather than a rule. `test/subsonic-protocol.test.ts` and
    `test/endpoints.test.ts` both do.
  - **The declaration cannot move into the shared builder.** `listKey` seeds its key
    *unconditionally*, so putting `song` on the album builder would attach an empty
    `"song": []` to every album in `getAlbumList2`/`getArtist`/`search2` — a different
    wrong answer, and one that only the paired assertion catches. So an album is **two**
    elements: `albumElement` (a list child) and `albumWithSongs` (`getAlbum`'s payload),
    over one `albumAttrs`.

  A repeated child is declared wherever it is attached; the wrapper's `listKey` only ever
  described the wrapper.
- **The same album, built once.** `getAlbum` and every album *list* publish the same `id`,
  name and `created`, read from the same first track — and they were two literals, which
  had already diverged: `getAlbum`'s omitted `created`. A client declaring
  `@SerialName("created") val createdAt: Instant` (no `?`, no default) then failed on
  **every** `getAlbum`, and the one-track report above was only the first failure to
  surface. `albumModel` is the single construction; `test/endpoints.test.ts` asserts the
  two endpoints publish the same attribute **key set**, so the next field to drift fails
  there rather than on a client.
- **A non-nullable field with no default is a *missing-key* failure.** It is not caught by
  checking the types of the fields that *are* present, and kotlinx.serialization raises
  `MissingFieldException` only *after* the loop over present keys — so a second defect in
  the same response hides behind the first. `test/client-decoding.test.ts` models
  required-vs-defaulted from the client's own declaration for this reason: a decoder that
  only checks types passes forever against a response missing a key.
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
- **A feature that covers one storage layout reports "nothing here" for the other, and
  nothing distinguishes them.** `getCoverArt` found artwork by listing the album folder
  and matching `cover`/`folder`/`front`/`album`/`albumart`/`thumb` ×
  `jpg`/`jpeg`/`png`/`webp`. That is a complete implementation of *one* way a music
  library stores a picture, and not the common one: Picard, beets, Metaflac, `ffmpeg` and
  every ripped disc put the image **inside the audio file**. For such a library the
  lookup found nothing and the endpoint served `PLACEHOLDER_PNG` — a **valid** 70-byte
  1×1 transparent PNG, `200`, `image/png`. The client decoded an image, cached it, and
  drew a transparent pixel. **A transparent pixel and a network fault are the same
  observation from outside**, which is why it presented as "no cover image can be loaded"
  and never as a failure, and why no log line anywhere would have named it. The suite was
  green because `helpers/harness.ts` seeds a `cover.jpg` node — the one layout that
  already worked. Three rules, and each is how the previous one would have collapsed:
  - **A fixture holding the one case that works cannot see the cases that do not.** The
    sidecar test and the embedded-art test are the same code path with different
    contents, so "the cover test passes" said nothing about a library with no
    `cover.jpg`. `test/cover-art-embedded.test.ts` **deletes the seeded node** to stand
    the broken library up, and says so.
  - **A placeholder that is a valid success is the worst possible answer.** `404`, or
    `200` with zero bytes, is recoverable — a client re-asks. A valid image is cached
    and never re-requested, so artwork that appears later is invisible until the client
    evicts. That is why the no-artwork answer is a real, decodable image *and* why the
    extracted bytes are cached under a key that goes stale when the file does.
  - **A cover endpoint must never speak the Subsonic envelope.** A `404` from the origin
    on the cover `GET` threw, was classified by `toSubsonicError`, and came back as a
    masked `200 application/json`. A client hands that to an image decoder, it fails, and
    the only evidence is a client-side log line — so an unreachable cover is a
    placeholder, and the endpoint has no failure path that produces JSON.
- **A fixture that is written from the spec must decode itself back, or it is a mirror.**
  Extracting artwork meant reading three container formats, and every one of them is a
  place this repository has already shipped a silent error. So `test/embedded-art.test.ts`
  builds a FLAC metadata block table, an ID3 frame list and an Ogg **lacing table** from
  the specifications, and then re-reads each through an independent path
  (`decodeBlockTable`, `decodeSyncsafe`, `packetStarts`) before asserting anything about
  the reader. It paid for itself immediately: five of its own bugs surfaced as reader
  failures — a 4-byte Ogg granule where the spec has 8, a 36-byte `STREAMINFO` where it
  has 34, a syncsafe *decoder* that ORed the whole value into its low byte, a
  `packetStarts` that reported where a packet's last segment began, and a
  `Uint8Array` image body that `Array.prototype.flat` refused to flatten, so every offset
  after it was wrong. In every case the reader was right and the fixture was not — which
  is the only outcome that makes the remaining assertions mean anything.
- **Locating bytes and having bytes are different questions, and the answer is a range.**
  A FLAC `PICTYPE` block is conventionally **last** and is as large as the image, so a
  500 KB cover starts past any prefix worth reading. `findPicture` therefore returns
  either `inline` (the bytes are in the buffer) or `range` (a claim about a byte range
  the caller must fetch) — never a partial image, because a truncated cover is a cover
  that "loaded" and renders as a grey box. And the limit is stated rather than implied:
  a picture whose *block header* is past the prefix is not locatable at all, and the
  answer is the placeholder. The MP3 retry exists for the one case a prefix cannot
  answer — an `APIC` frame is normally the **last** frame, and ID3 frame headers are
  interleaved with payloads, so there is no offset table to consult and the tag has to be
  walked — and it is bounded by a named constant rather than attempted on every file.
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
- **A repeated child lives where the schema puts it, and the suite reads the schema.**
  `getIndexes` nested the folders as `shortcut` children *inside* the letter `index`
  groups; the schema puts `shortcut` directly under `indexes` and `artist` under
  `index`. No client reads `index.shortcut`, so the whole alphabetical browse was empty
  on a client that works everywhere else — and the suite asserted the wrong shape,
  because the assertion was written from the code rather than the schema. The folders
  are top-level `shortcut` children now, the letter groups hold the same artists
  `getArtists` publishes — one grouping (`groupArtistRows` in `rest/mappers.ts`), one
  letter function, one element constructor, or the two browses disagree about who is
  whom and which letter they are under — and the test drills an id from `getIndexes`
  into `getArtist`, because shapes alone pass again on two surfaces that disagree.
  Asserted in `test/worker.int.test.ts`, which goes red on the old placement.
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
- **A subrequest is not only `fetch`, and budgeting the easy one to measure kills the
  invocation.** Workers Free allows **50 subrequests per invocation**, and D1 counts
  its own queries against the same 50 — *"Queries per Worker invocation — 1000 (Workers
  Paid) / 50 (Free)"* — as do KV, Durable Object RPCs and Secrets Store reads. Cloudflare's
  own two limits pages disagree on the internal-service question (the Workers page carries a
  *subrequests to internal services: 1,000 on Free* row), and this repository believed the
  wrong one for long enough to ship a broken scan: `ScanBudget` metered
  `WebDavClient.request()` and nothing else, so a chunk of 40 folders charged its budget
  **40** and spent the platform **~240**. It crossed the ceiling inside its first album,
  `ScanWorker.alarm` caught an error nothing in the scan can see, re-armed a second later,
  and each dead invocation banked ~20 tracks — which is why a 110-track library *finished*
  while no chunk ever completed. Four rules, and each is how the previous one collapsed:
  - **One counter, owned by the request scope, charged at the choke point.** `fetch` was
    easy to instrument because `WebDavClient` has a private `request()`; D1 and KV were not
    counted because nothing forced them to be, and a forgotten charge has **no symptom at
    all** until the platform kills the invocation — the statement works, the rows are
    right, the suite is green. `BaseDAO.withRetry` is the one path every D1 statement
    takes, so charging there is one line rather than a hundred chances to forget one.
  - **Charge pessimistically where the platform is ambiguous.** A D1 `batch()` of N
    statements is 1 or N subrequests and the docs do not say; charging N costs throughput
    if N is wrong and costs availability if 1 is.
  - **The per-unit reservation is the unit's whole cost.** `MAX_REQUESTS_PER_TRACK = 2`
    counted a prefix read and a tail read — the two *external* requests — while the same
    track also costs a `songMeta` KV read, an `applyMetadata` and a `songMeta` KV write.
    Admitting 20 tracks per folder on the cost of two each is ~100 subrequests of work onto
    a budget of 50. Likewise a folder: the walk checked one `PROPFIND`, and a chunk that
    starts a folder it cannot finish does not get a slow folder, it gets a terminated
    invocation.
  - **Every bound is derived from the one platform number, and clamped to it.**
    `subrequests.ts` holds `WORKER_SUBSREQUEST_CEILING = 50` and computes the chunk budget
    (`50 − 8` for the invocation's own statements), the folder count (`floor(42/6)`), the
    enrich cap (`floor(42/5)`) and `MAX_PAGE_SIZE_CEILING`. The three scan vars are
    **clamped**, because the operator surface was telling people to raise one of them: on
    Free the ceiling cannot be raised, and following that advice converts a chunk that
    pauses into a chunk the runtime terminates.
  A budget that ran out is a **pause**, not a failure — `stoppedBy: 'requests'` was
  structurally unreachable while the meter could not see D1, so a self-inflicted ceiling
  spent the retry budget on every attempt and the operator surface had a string for a state
  it could never render. Asserted in `test/subrequest-budget.test.ts` (per charge point,
  with negatives) and `test/scan-budget.test.ts` (a whole chunk, against a store double
  that charges). Full account: `docs/issues/free-plan-subrequest-ceiling.md`.
- **A write that is larger than the invocation must be resumable, or it must be refused.**
  A 500-track album is ~1,000 statements against a ceiling of 50, so truncation is the
  *expected* case on Free rather than an edge case. `runWriteBatch` splits by what is left
  and reports `truncated`; `reconcileFolder` writes the children **first** and the folder's
  own row — the one carrying `is_scanned: true` — **last and only if nothing was
  truncated**, so a half-written folder stays on the frontier and the next chunk finishes it.
  The prune is skipped there, because it derives its delete set from the rows D1 holds and
  would otherwise delete exactly the children the upsert could not write. A browse cannot
  resume, so `TreeService` persists nothing and answers from the listing it already holds. And
  a write that has no partial form — a play queue, a playlist's `song_count`, the derivation
  backfill — refuses with a `413` instead, because half a queue is a *shorter queue*, which
  is a wrong answer rather than an unfinished one.
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
- **An unbounded quantifier before a character that can fail is quadratic in the _input_,
  and JavaScript cannot be told to stop backtracking.** Three CodeQL alerts, all
  `js/polynomial-redos`, all on data that arrived from an untrusted WebDAV origin:
  `/\/+$/` in `toLibraryPath` (twice — once per operand) and `/\s+[-–—]\s+/` in
  `fromFlatAlbumFolder`. The mechanism is not a nested quantifier, which is why it is easy to
  miss: an unanchored `/+$` over a run of *n* identical characters makes the engine retry every
  length the run could have, from each of the *n* start positions inside it. 16 KB costs ~200 ms
  and 100 KB costs ~8 s, against a **10 ms CPU limit on Workers Free**, and well inside the
  8 MiB body cap `MAX_METADATA_BYTES` already allows — so one hostile `PROPFIND` is an
  invocation the runtime kills. The rule is *unanchored quantifier, then something that can
  fail*, and `[gimsuy]` cannot fix it: JS has no possessive quantifier and no atomic group, so
  the fix is a scan. Five things, and each is how this one would have collapsed:
  - **A quadratic regex without a nested quantifier is invisible to every linter this
    repository runs.** Probed: `eslint-plugin-regexp`'s `no-super-linear-backtracking` and
    `sonarjs`'s `slow-regex` both fire on `^(a+)+$`, only `slow-regex` fires on
    `/\s+[-–—]\s+/`, and **neither fires on `/\/+$/`**. So the lint gate was green over a live
    DoS and CodeQL — not a test, and not on every commit — was the only instrument that found
    it. There is no lint rule for "quadratic in the input", so the guard is a measurement.
  - **The expensive shape is the _interior_ run, and the obvious test input is the cheap
    one.** A *leading* run is consumed by `replace(/^\/+/, '')` before `/+$/` runs; a
    *trailing* run matches, and V8 fast-paths a successful `/[/]+$/`. Measured at 16,000
    slashes: **0.0 ms leading, 0.0 ms trailing, 198 ms interior**. The first version of
    `test/redos-linear-parsing.test.ts` asserted the leading and trailing runs, and both
    passed against the regex it was written to catch — 48 of 48 green. So a guard built on the
    wrong shape of the input is indistinguishable from no guard, and a hostile `DAV:href` is
    `<base>/<path>`, so the expensive shape is also the ordinary one.
  - **The rewrite is only equivalent because the caller discards what the regex measured.**
    `findAlbumSeparator` returns the **dash's** index rather than the match index because both
    sides of the split are `.trim()`ed by the caller, so the *extent* of the whitespace runs
    cannot change the answer. Strip the trim and the equivalence argument goes with it.
  - **A fixture that disagrees with the reader is the finding, and it was the fixture twice.**
    The oracle is `split('/')`-based and was written *filtering every* empty segment, which
    silently normalises the middle of the string; the seeded fuzz caught it on the first
    interior run it met. An inverted `&&`/`||` in the whitespace test was caught the same way.
    Both were bugs in the check, not in the code — which is the argument for the fuzz, since
    "written from the spec" is a claim and the fuzz is the measurement.
  - **A test must not trip the query it exists to close.** CodeQL's default configuration scans
    `test/` as well as `packages/`, so the quadratic reference is built with `new RegExp` and
    `prefer-regex-literals` is disabled there with that reason attached. Asserted: reintroducing
    each original regex turns the file red, on the wall-clock bound and on nothing else — every
    equivalence assertion stays green, which is what makes the timing assertion the only thing
    distinguishing a linear implementation from a slow one.
- **A dev bypass is gated on an allow-list of environments.** A deny-list enables it for
  `staging`, `Preview`, and a misspelled `prodcution`.
- **A deployment placeholder is the exact sentinel, never a readable stand-in.**
  `scripts/deploy/prepare-wrangler-config.ts` patches a D1 `database_id` only when it equals
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
  - **`migrations/migrations.lock.json` records the sha256 of everything applied**, and
    `test/schema.int.test.ts` asserts both directions — every file on disk is listed, and
    every listed hash matches. Adding a migration means adding a lock entry in the same
    commit; editing an applied one fails the suite instead of the deployment.
    `pnpm run migrations:lock` records a newly-added file and **refuses to touch an
    existing entry**, so it cannot quietly bless an edit the operator just made. There is
    deliberately no `--force`: a write that could adopt a new digest for a file already
    applied *is* the bug, offered as a flag.
- **Eight migrations were squashed into one baseline, and the cost is stated rather than
  absorbed.** `migrations/0008_squash.sql` holds the combined schema of every file before
  it and those files are deleted. A lock can stop an *edit*; nothing stopped the file count
  growing. Three things the squash had to get right, each of which the next one collapses:
  - **It is not a concatenation.** `d1_migrations` records the absorbed filenames, so they
    are skipped and the squash is unapplied — it runs against production databases that
    already have every table, column and index. The four `ALTER TABLE … ADD COLUMN` the
    absorbed migrations used have **no** `IF NOT EXISTS` form, so a concatenated squash
    fails with "duplicate column name" on exactly the databases it exists to serve. The
    columns are folded into their `CREATE TABLE`s, in the order the ALTERs appended them,
    so the resulting `sqlite_schema` is identical.
  - **It resolves what a squash is for.** `namespaces` and `router_backends` are never
    created, which retires the inherited `owner_email → users(email)` foreign key that did
    not resolve at all (`PRAGMA foreign_key_check` failed; D1 enforces foreign keys), and
    it removes the **duplicate `0001_` prefix** — two files from two different projects,
    ordered by a lexicographic tiebreak nobody intended, on a database that could run only
    one. `lock-check.ts` fails on a duplicate prefix, which is what forced this.
  - **It omits 0006's data migration, and that omission is checked rather than assumed.**
    On a fresh database `songs` is empty; on an existing one 0006 already stamped every row
    it matched. Asserted by seeding the old marker rows *between* 0005 and 0006 — seeding
    them afterwards tests nothing, because 0006 has already run.

  The cost: D1's `d1_migrations` on an existing database still lists the eight absorbed
  filenames, and this repository no longer describes what they contained. D1 keeps that
  history, which is what makes adopting a baseline safe — and it is why the baseline is a
  deliberate act recorded in the lock, not a formatting change.
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
- **A folder too large for one invocation must be *closable*, or the scan writes the same
  rows for ever.** `runWriteBatch` truncates a folder's children against the
  invocation's subrequest ceiling — 45 statements on the Free plan — and `reconcileFolder`
  writes the folder's own `is_scanned: true` **only if nothing was truncated**. That is the
  resumability mechanism, and it only resumes if the next pass offers strictly fewer rows.
  It did not: `reconcileFolder` had no comparison, so the rows it had already written were
  the rows it re-offered *first*, the truncation landed on the same offset every time, and
  progress on the next pass was zero. So **any folder with ≥45 entries could never be
  closed**, and every chunk rewrote the same ~45 rows. It shipped: **231,620 rows written on
  `nodes`** for one 80-album, 110-track library, `is_scanned` never reaching 1, the frontier
  never draining, and `getScanStatus` reporting `scanning` throughout — 231,620 ÷ 45 ≈ 5,147
  chunks, and the two numbers are the same measurement. Nothing reported it: `stoppedBy`
  answered `'frontier'` because the chunk did consume its whole (one-folder) frontier, and
  `rowsWritten` is only readable through `POST /user/libraries/:id/scan/step`. Full account:
  `docs/issues/nodes-upsert-livelock.md`. Four rules, and the second is why the first alone
  was not enough:
  - **The compare exists, it is one function, and it was already written — elsewhere.**
    `TreeService.persistChildren` had it; `reconcileFolder` described it in its own docstring
    and had no such branch. Two writers and two answers, and the second answer was *no
    comparison at all*. `nodeWrite.ts` owns it now, and its caller-side and statement-side
    halves are **both** required: `runWriteBatch.truncated` counts statements **issued**, not
    rows changed, so `NodeDAO.UPSERT`'s new `WHERE` makes redundant writes free but does not
    make a caller that offers 80 rows for a 45-statement budget converge. The `WHERE` is
    defence in depth; the compare is the fix.
  - **`updated_at` is excluded from the statement's `WHERE`, and that is why.**
    It is `nowSeconds()`, so it is the one column that *always* differs — including it would
    make every comparison true and the guard a comment. It is consequently the one column a
    no-op upsert does not move, which is what keeps "when was this row last actually touched"
    answerable. The other half: `IS NOT`, not `!=`, because `NULL != NULL` is `NULL` and in a
    `WHERE` that is false — so a row whose etag went from a value to none looked unchanged and
    its subtree froze. That permissive direction is the dangerous one.
  - **A browse does not get to say a folder was descended into.** `persistChildren` wrote
    `is_scanned = 0` for every child, so a client merely *looking at* the root put all 80
    album folders back on the frontier and the scan re-walked them — once per browse, on a
    `GET`, spending the same allowance. The flag means "someone descended into this" and that
    path demonstrably has not. It now **preserves** the stored value and writes `0` only for
    rows it creates — which is what keeps `needsDescent`'s invariant intact for a folder
    discovered by browsing alone.
  - **A ceiling the write batch cannot see is a ceiling it spends.** `BaseDAO.fitCount` read
    `meter.remaining`, the **platform's** 50, rather than the chunk's own 42 — so a batch spent
    the invocation's 8-statement reserve and the post-walk `saveProgress` then crossed 50 and
    the runtime terminated the invocation. Measured at 52 against a ceiling of 50. The fix is
    `SubrequestCounter.setCeiling` and `ScanBudget` calling it, because `ScanBudget` is layer 3
    while every charge point that matters is below it holding only the meter — so the meter is
    the one place the two can meet.
  - **A guard is convergence, and convergence is a measurement no status assertion makes.**
    `test/scan-convergence.test.ts` drives the real DAO over `node:sqlite` with a real
    `SubrequestCounter` and asserts each pass writes **strictly less** than the one before.
    Removing either the compare or the `WHERE` turns seven of its cases red while every
    status- and shape-level assertion in the suite stays green — which is the finding, because
    the two doubles that hid this (`scan-budget`'s `upsertMany`, which *skipped* unchanged
    rows, and `scan-incremental`'s `chunkMaxRequests: 10_000` with a double that never
    truncates) each modelled the fixed implementation or a bound that never fires.
- **A spent D1 daily allowance is a *pause*, and it is not `failed`.** Since 2026-09-01 a
  Free account over its daily row allowance has **every query fail** — reads included — until
  **midnight UTC**, so the whole product is down (Subsonic auth reads `users`) and the remedy
  is a clock. It shipped as a loop: `step` caught the refusal, tried to record it with a D1
  write that *could not succeed* (the fault **is** a refusal to write), returned `failed`,
  `isAdvancing('failed')` is true, and the alarm re-armed one second later — ~86,400 times
  before the reset, each attempt two failed statements, with `getScanStatus` reporting
  `scanning: true` and the cause masked into `code=0`. `paused` is the third answer: retried
  **by itself, at a known time, needing no operator**. Neither existing status could carry it —
  `failed` retries (a loop) and `stalled` never does (a wedge until an operator acts). Four
  rules:
  - **Two questions, so two predicates.** The alarm asks *will this resume by itself?*
    (`true`); `getScanStatus`'s `scanning` asks *will my poll buy anything?* (`false` — polling
    cannot move a clock). One predicate for both is the shape of defect that once made
    `scanning` mean "did this call do work" and stopped every scan; its mirror deletes the
    alarm and leaves an allowance spent. `willResumeWithoutAPoll` and `isAdvancing` are
    separate, agree on every other status, and are asserted to.
  - **The pause lives in Durable Object storage, and that is the mechanism rather than a
    convenience.** It is the only store still accepting writes when D1 is refusing them, so a
    pause in `scan_state` would be unwritable exactly when needed — and `/user/libraries`, which
    reads D1, could not see it either. `getStatus` reads it back and lets it **override** the
    stored row, because D1's row is *guaranteed* stale about it: it says `scanning`, which an
    operator reads as working. The stated exception to "D1 stays authoritative"; the frontier,
    every indexed row, the retry counter and the index version are all still D1's.
  - **The limit is reached by design, so the scan paces itself before the platform refuses.**
    A correct chunk writes ~42 rows at ~1/second, so 5,000 rows/day is **two minutes of
    scanning** — the runaway above was not the only way there, and a fix that only made the
    outage survivable would leave it frequent. `SCAN_DAILY_ROW_WRITE_BUDGET` is the platform's
    5,000 less a named reserve for non-scan writes, **divided by the number of registered
    libraries** (the allowance is per *account*, so a per-library cap is unsound the moment a
    second library exists, and `MAX_LIBRARIES` would give a one-library deployment a tenth of
    what it could have had). Counted from the chunk's measured `rowsWritten`, held in DO storage
    because **metering D1 writes must not itself spend D1 writes**, and persisted at most once
    per 500 rows — which makes it a lower bound, absorbed by the reserve.
  - **A classifier that matches a paraphrase has never met the platform.** `isD1DailyLimitError`
    matches Cloudflare's exact wording, because `executeD1WithRetry` throws
    `Failed to ${context}: ${errorMessage}` — a classifier wanting the bare sentence would
    answer "not a quota" for a quota, and the branch would be reachable only from a test. And
    `isD1ErrorRetryable` answers `false` for it **by accident of vocabulary** (`too many` is
    retryable, `exceeded` is not), which is asserted rather than left to the next person who
    adds `/exceeded/`. Full account: `docs/issues/d1-daily-write-limit.md`.
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
    `songs.grouping_source`: replace a value a derivation is recorded as owning, fill a
    NULL, leave a real tag. `NULL` alone cannot express a *corrected* convention — this
    is the `reader_version` invariant one layer down, and a plain `COALESCE` would
    re-select the row and then decline to change it, which is a version column that buys
    nothing. **It never stamps `enriched_at`**, so `EnrichmentService` does not read the
    claim as "these bytes were read": a backfill that repairs the grouping by breaking
    enrichment is the opposite of a repair.
- **Provenance is a column, because the marker became configuration and a `LIKE` is not a
  string.** The guard above used to be `col LIKE '%' || DERIVED_MARKER` — reading the
  suffix back out of the stored value — and `DERIVED_MARKER` is now an env var, because an
  operator asked for one. Empty is its **default**, and that is the point rather than an
  absence: an empty marker is what makes a derived `X` and a tagged `X` **one** album
  instead of two spellings of one release, which is also the only reason a search for the
  album's real name could find a track the scan has not tag-read. Two failures follow from
  the string guard, both measured over real SQLite against the real statement before the
  column was added:
  | `DERIVED_MARKER` | `Bonobo (derived)` | `Bonobo` | `Black Sands (Remastered)` |
  | --- | --- | --- | --- |
  | `' (derived)'`   | replaced | kept | **kept** |
  | `''`             | replaced | replaced | **→ replaced** |
  | `'_ (guess)'`    | **kept** | kept | kept |
  - **An empty marker is a match-all**, so the shipped default would have replaced every
    real `ALBUMARTIST` in the library — silently, on every poll, and past the first page.
  - **Any other marker is a `LIKE` pattern, not a literal.** `'_ (guess)'` is `'%_ (guess)'`,
    where `_` matches one character, so the guard stopped recognising its **own** guesses: a
    version bump re-selected those rows and declined to change them. The `reader_version`
    defect verbatim, one layer down, with no error anywhere. `%` as a marker is the empty
    case again.
  - So `songs.grouping_source` holds `'derived'`, meaning **all three** of
    `artist`/`album`/`album_artist` came from `dir_path`. "All three" is the conservative
    direction: the permissive one lets a convention correction overwrite a real tag, and the
    price is only that a partially-tagged row's derived `album_artist` is never corrected
    again — which no change of separator rule would affect. `applyMetadata` **clears** it
    whenever it writes any of the three, and that is the writer whose absence is a data-loss
    defect rather than a stale one. Three assertions, one per input, in
    `test/schema.int.test.ts`; all three go red against the `LIKE` guard, and the `%`/`_` case
    carries a *stale* marked value rather than a NULL for the reason above — seeded as a NULL
    it is filled by `col IS NULL` whatever the pattern is, so it passes against the defect it
    exists to catch.
  - **Changing the marker is a migration, and it costs stars.** It re-derives every wholly
    derived row, so `_ci` moves, the album grouping key moves, and `alk:` album ids move with
    it. Accepted rather than papered over with a fallback lookup, and stated in
    `migrations/0008_squash.sql` beside the `' (derived)'` literal that is now
    the only place it is written down (it was introduced in `0006`, which that file absorbs).
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
  The variable form of it was still live: `MAX_PAGE_SIZE` is env-raisable, and past a
  certain size a page is not *slow*, it is unservable — one grouped query plus
  `ceil(N / groupsPerStatement)` more, and D1 queries are subrequests. So it is clamped to
  `MAX_PAGE_SIZE_CEILING`, whose own docstring derives the number from the two platform
  limits rather than picking a comfortable one, and `validate()` **reports the clamp**
  rather than applying it quietly. Raising a number in `ConfigurationDefaults` is an
  encouraged operation, so an un-clamped maximum is a defect waiting for an operator.
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
  OpenSubsonic endpoint list against the registry — and **nothing in the suite asserted the
  registry covers what a real client calls**, which is the same "a comment claiming an
  invariant that nothing measured" defect as the subrequest bound. That gap is now closed:
  `test/endpoint-registry.test.ts` asserts the registry's shape, all 33 `code=70` answers
  through the real dispatcher, and the exact error key set of each — so the next endpoint
  that lands in the wrong map fails a test rather than answering.
- **A double may disagree with production about the very column under repair.** The
  `upsertFileFacts` double in `test/scan-incremental.test.ts` wrote `artist: null,
  album: null` while the real `UPSERT_FILE_FACTS` *derived* them. That is the same
  failure as the one above, and it is why the grouping fix appeared to do nothing: the
  suite agreed with itself and with neither production, so every test passed against a
  deployment whose aggregates stayed empty. The double now calls `deriveFromPath` and
  stamps `DERIVED_VERSION` — because a double is evidence only to the extent it models
  the platform, and *which* platform matters as much as modelling it. **It then happened
  again, on the same column and in the same files, in the opposite direction**: both doubles
  stamped `derived_version` and each one's comment asserted that `UPSERT_FILE_FACTS` did —
  which it did not, because that statement omitted the column entirely. So the *fix* for
  the first occurrence was applied to the doubles only, agreeing with a statement that did
  not exist. See the next bullet for what that cost.
- **A page a chunk cannot write whole is a permanent failure, not a slow one.** The
  derived-grouping backfill reads a page of rows and writes them **one `UPDATE` per row**
  with `requireComplete`, so it refuses rather than truncating — correctly, because the
  selection is on `derived_version` and a partial page leaves rows re-selected for ever.
  That makes the page size a bound the chunk budget *imposes*. It was
  `DERIVE_MAX_ROWS_PER_CHUNK = 200`, against a chunk budget of `42` and a platform ceiling
  of `50`: it fitted on **no chunk under any configuration**, so every library with more
  than ~48 rows owing a derivation threw `SubrequestBudgetExhaustedError` out of
  `derivePending` — which runs *before* `listFrontier` — so the walk never ran, `step`'s
  catch recorded a scan failure, `isAdvancing('failed')` is `true`, and `getScanStatus`
  answered `scanning: true` for ever. Reported as *"stuck on Scanning after 2 hours with
  ~100 tracks"*. Three rules, and each is how the other two collapse:
  - **Both the debt and its repayment have to be bounded.** `UPSERT_FILE_FACTS` stamped no
    `derived_version`, so every row the walk wrote took the migration's `DEFAULT 0` and was
    *immediately owed* — permanently, since the selection is `derived_version < 1`. Neither
    half produces the wedge alone: with the stamp and a `200` page it is a slow repair; with
    a `32` page and no stamp it is a scan that re-stamps every row it wrote, every poll.
  - **The bound is derived, and it holds a folder back.**
    `SCAN_DERIVE_MAX_ROWS_PER_CHUNK = SCAN_CHUNK_SUBSREQUEST_BUDGET −
    SUBSREQUESTS_PER_CHUNK_OVERHEAD − SUBSREQUESTS_PER_FOLDER_BASE` (`42 − 4 − 6 = 32`).
    `SUBSREQUESTS_PER_CHUNK_OVERHEAD` is the four statements a chunk spends belonging to no
    folder (`ensure`, the backfill's read, `listFrontier`, `saveProgress`) and the count
    matters: size the page without the two that *bracket* the walk and the loop's
    `canAfford(SUBSREQUESTS_PER_FOLDER_BASE)` refuses, so the chunk returns `scanning`
    having visited **zero** folders — the same stuck scan with the throw removed, and what a
    fix that only deleted the throw would have shipped.
  - **A guard that passes by an accident of interleaving is not a guard.** Making the page
    fit cost one extra `await` at the top of every chunk, which moved the interleaving in
    `test/scan-do.test.ts` and exposed a latent lost update: `saveProgress` wrote
    `scanned_count = ?` where `fail` one method below increments in its own statement, so
    two overlapped chunks published the smaller of the two. The work was done — the counter
    went backwards. Now a delta, and the test that was written for it passes for the
    reason it was written.

  Asserted in `test/schema.int.test.ts` (the real statement over real SQLite: a scanned row
  is owed nothing, on both the `INSERT` and the `ON CONFLICT` clause), `test/scan-budget.test.ts`
  (a chunk that drains a 100-row backlog **and** still visits a folder — either assertion
  alone passes against the other failure), and `test/subrequest-budget.test.ts` (the
  relationship, not the numeral).
- **A failure that says nothing about the file earns no stamp.** `enriched_at` means
  "already read", and `shouldEnrich` trusts it — so writing it over a `503`, a timeout,
  or a reset connection makes a transient fault permanent: the row reports duration `0`
  for ever, and no `getSong`, rescan, or re-index re-reads it. It shipped: four tracks
  of a live library caught a flapping origin during the scan and stayed at duration `0`
  with no tags. `isTransientEnrichmentFailure` (`index/enrichmentRetry.ts`) is the split —
  `408`/`429`/`5xx` or no status at all leaves the row untouched — and it covers the
  tail read too, where even good prefix tags are discarded rather than written without
  their duration. Asserted in `test/enrichment-config.test.ts`, paired with the `404`
  case proving a definitive failure still stamps, without which the fix is just "never
  write".
- **"We looked and there is nothing" and "we could not look" are different
  observations, and only the first is worth remembering.** The artwork negative cache
  used to be written whenever the probe found nothing — including when the probe threw —
  so one `503` became "no artwork" for 30 days under a key the file's own revisions
  could never invalidate. `embeddedAlbumArt` writes the zero-length entry only when a
  read actually completed (`examined`). Asserted in `test/cover-art-embedded.test.ts`,
  paired with the completed-read case for the same reason as above.
- **An unawaited promise is not a cheaper version of an awaited one, it is a different
  one.** The artwork cache was the only KV write in the product issued as `void
  deps.cache.putBytes(...)`, and work a Workers handler does not await is not guaranteed
  to run — so the cover cache never populated, and every cell of an album grid re-read
  the origin at up to two ranged reads each against a 50-subrequest ceiling. Same defect
  as voiding `requireForUser`, one level down. Both writes are awaited now, and the
  double can tell the difference: `fakeKv`'s `put` used to settle on the microtask queue,
  so an abandoned write still landed in time and the suite proved a cache that production
  never filled. `deferPuts` holds every write until released, so the ordering — the
  response must not resolve before its write settles — is asserted rather than assumed.
  Asserted in `test/cover-art-embedded.test.ts`, which goes red on the `void` version.

- **A second implementation of a thing you already wrote is a defect, not a duplication.**
  `embeddedArt` re-derived the media type of a cached image with its own magic-byte table
  while the extractor that *wrote* those bytes called `sniffImageType`, which knows four
  more families. So a TIFF cover was extracted correctly and then served as the 1x1
  transparent placeholder on every request after the first, for the TTL, under a key only
  the file's revision can invalidate — the client got a `200` and a decodable image on both
  requests, so it cached the placeholder and never asked again. The generalisation is what
  matters: extraction answered one question and re-identification answered a *different*
  one about the same bytes, and the suite could not see it because the formats were asserted
  through the path that already worked. One answer per question, and the second answer must
  be the first one's callee rather than its twin.
- **A cache read that does not say what it wants is given the platform's default, and two
  readers of the same namespace do not get the same answer.** `KvCache.getBytes` called
  `ns.get(key)`; KV's default is `type: 'text'`, and UTF-8 is not a byte-preserving codec, so
  a stored JPEG came back lossy-decoded — every invalid sequence replaced by U+FFFD and
  re-encoded as three bytes — and `ff d8 ff db` arrived as `ef bf bd ef bf bd ef bf bd ef bf
  bd`. Every entry under the `albumArt` key was therefore correct on the way in and
  unrecognisable on the way out, and the one branch that re-identifies a cached image answered
  `null`, so the placeholder was served for the entry's full 30-day TTL under a key only the
  file's revision can invalidate. It took the whole embedded-artwork feature with it, on a
  live library that is 100% Opus: **42 covers on the first sweep of 80 albums, 0 of 80 on the
  second.** Four things, and each is how the others would have collapsed:
  - **A lossy read is silent, and it is not an absence.** The corrupt entry has a *non-zero*
    length, so it cannot be mistaken for the zero-length entry that means "this album has no
    artwork" — which is why every answer was a *successful* `200` with a decodable image, why
    each client cached the placeholder, and why nothing anywhere named a cause. A defect that
    reports itself as a cache hit cannot be found by looking for errors.
  - **The re-identification from the previous entry is what turned corruption into an
    answer.** Storing the type beside the bytes would have survived this; deriving it from
    them is right for a *stored* value and is exactly wrong for a value the reader mangled.
    So the reader on that branch now logs, because the only writer on that path is
    `resolveImageBytes`, which refuses a non-image — an entry that is a picture on the way in
    and not on the way out means the **bytes changed in transit**, and that is worth a line.
  - **A narrowed hand-written interface hid it as surely as a wrong one.** `KvNamespaceLike.get`
    was declared `get(key: string)`, with no `type` parameter, so the platform's `arrayBuffer`
    overload could not be expressed: the correct call was a compile error and the wrong one was
    the only one available. Widening a type to `string | ArrayBuffer` modelled the *return*
    and left the decision — which is the whole defect — unmodelled.
  - **The double was byte-exact, so the right assertion was already written and already
    green.** `test/cover-art-embedded.test.ts` has asserted that the second request serves the
    same bytes out of KV since the feature landed. `fakeKv` returned whatever `put` was given,
    so it passed against a production read that loses data. **A double must model the
    platform's _defaults_, not only its shapes** — the same rule as the D1 double lowercasing
    both sides of a predicate, one encoding down. `fakeKv` now reproduces the lossy decode and
    records the requested type. Asserted in `test/kv-outage.test.ts`, paired with the negative
    that reads the same key the way the platform reads by default and shows it is **not** the
    same value — a byte-exact round-trip assertion proves nothing about a lossy read, and
    without the pair a `getBytes` that forgot the type again would pass on a fixture whose
    magic happened to survive UTF-8. Full account:
    `docs/issues/kv-default-text-read-corrupts-artwork.md`.
- **A value the protocol declares as a timestamp cannot be published from a `Set`.**
  `getArtists` decorated a starred artist with `starred: undefined`, and `undefined` is
  dropped by **both** serializers — so no attribute in XML and no key in JSON, for a star
  that was stored correctly. `getStarred` deliberately does not expand artist stars, so
  `getArtists` was the only surface that reports them and it reported nothing. The lookup
  was a `Set<string>`, which made `undefined` the only value the mapper could produce: a
  type making the wrong answer the only available one *is* a field saying it is missing.
  `AnnotationLookup.stars` is a `Map` of id to epoch second, and `stars.starred_at` was
  already stored and already the sort key — it was simply never selected.
- **The reported state and the scheduled work are two stores, and they must be reconciled.**
  `ScanWorker.alarm` had no handler and `ScanService.step` had five awaited calls outside
  its own `try`, so a D1 error in any of them rejected `step`, the re-arm never ran, the
  alarm was consumed, and D1 still recorded `scanning` — which `getStatus` reports as *keep
  polling*, for ever, with nothing scheduled to answer. `getAlarm()` is called from nowhere
  in this repository, so the two stores were never compared. A handler that can reject is a
  permanent wedge, and `stalled` is the wrong answer for a failure it could not record: it
  is the terminal status, so `isAdvancing` is false for it and the chain is deleted — the
  same wedge reached by handling "cannot record" the obvious way.
- **An import refuses to start rather than sharing the daily row allowance, because the
  allowance is an outage.** `SCAN_DAILY_ROW_WRITE_BUDGET` exists because 5,000 rows/day is per
  **account**, so N libraries each capped at the whole allowance would write N times it. The
  argument is *stronger* for an import, because since 2026-09-01 an account over its allowance
  has **every query fail** until midnight UTC — reads included. Two writers racing for the last
  rows do not each get slower: the second takes the whole product down, `/rest` authentication
  with it, and the remedy is a clock rather than a change. So there is **one writer at a time**,
  and the two refusals are about *not writing rows* rather than a conflict in the usual sense.
  Both are asserted through the HTTP surface in `test/import-routes.test.ts`, each with the case
  that proves the gate has teeth, and `assertScansIdle` is asserted **both ways** — because a
  precondition that passes when it should fail looks exactly like a guard.
  Three answers rather than two, and each asks the operator for something different: `paused`
  resumes without a poll, `failed` needs a look, and `stalled` is neither.
- **A unit of work bounded by a budget must hold the budget's own meter.** `PlayCountImportWorker`
  needs a narrower ceiling than the invocation's 50, so it took `ScanBudget`'s approach — and then
  built a **local** `SubrequestCounter` for the batch loop's `canAfford` while every DAO charged
  the **scope's** own counter. Two counters are two numbers that disagree, and the disagreement
  was silent and total: the loop saw 44 remaining on a meter nothing else had spent, `requireSubrequests`
  threw on album seven, and `alarm`'s catch swallowed it into "could not read the import source"
  and re-armed. **The walk reported progress and made none, for ever.** So the rule is
  `scope.get(Tokens.SubrequestMeter)` with `setCeiling(...)` — one meter, narrowed, so the loop
  and every charge point below it read the same number. `test/import-execution.test.ts` walks
  twenty albums across several alarms to completion, which is the only assertion that would have
  seen it: a fixture of one page settles after one album and never reaches the branch.
- **Two refusals that mean different things must not be one answer, and a caller must not be
  left to guess.** `ImportSourceService.clientFor` returns `{ok:true, client}` or
  `{ok:false, reason}` because there are **two** refusals — the row is gone, or the host is no
  longer permitted because an operator tightened `ALLOW_PRIVATE_WEBDAV_HOSTS` after the run
  started — and a method answering `null` for one and *throwing* for the other left the Durable
  Object writing `=== null` and so believing it covered both, while a tightening arrived as a
  thrown `NotFoundError` that its `alarm` catch swallowed into a generic message. It then re-armed
  and retried a host the policy had just refused, for ever, with the real reason discarded.
  Over HTTP the two **do** collapse to one 404, deliberately — the distinction is not actionable
  there and saying which it is would leak that a row exists whose URL the caller may no longer
  use, the same reasoning `assertRemoteReachable` applies. What each caller does with each is
  stated at each caller.
- **An error class is not a status, and a route must not re-decide one.** `createSource` mapped
  every `BadRequestError` to a 409, which made "that URL is not allowed by the SSRF gate" and
  "that remote account is already registered" arrive under one number — and an operator reading a
  rejected URL as a conflict would go looking for a duplicate to rename. The class carries the
  status (`ConflictError` → 409, `BadRequestError` → 400) and `BaseRoute.toErrorResponse` is the
  single path, so a route has nothing to map.
- **A derived id needs an *injective* encoding, because a separator proves nothing.**
  An imported playlist's id must be stable across a retried Workflow step, so it is a hash of
  `(namespace, run, remotePlaylistId)`. The first version joined the parts with NUL and its
  docstring claimed the delimiter "cannot appear in a part" — which is false: joining
  `['ns','a','b']` and joining `['ns', 'a' + NUL + 'b']` produce the same string, so **any** delimiter is
  forgeable and two different playlists hash to one id, one overwriting the other. Length-prefixing
  each part (`3:ns1:a1:b`) is injective because the length is recoverable from the bytes. The
  comment was the false part and the test that caught it was written *because* the comment made a
  claim; asserted in `test/import-phases.test.ts`.
- **A column that is real to the code and absent from the database is invisible to every DAO
  test.** `import_runs.report_json` was in `ImportRunRow`, written by `writeReport` and read by
  `parseReport`, and **absent from `CREATE TABLE`** — every DAO test passed, because the phase
  tests drive a port, the route tests use a run with no report, and the migration lock records
  **bytes, not columns**. The write failed with "no such column" and the retry layer turned that
  into a `DatabaseError`. This is the second and third time in this repository
  (`songs.reader_version`, `scan_state.consecutive_failures`), and both times the instrument that
  found it was `test/schema.int.test.ts` reading `PRAGMA table_info`. So the import's tables now
  have an assertion naming **every** column a DAO writes — written out rather than derived from
  the DAOs, because a list derived from the code cannot detect a disagreement the code is part of.
- **A variable can be declared, parsed, validated, templated and read by nothing.**
  Five were, and they fail in three distinguishable ways, which is why one rule does not
  cover them. `STREAM_RATE_LIMIT` was inert: the limiter used a literal, so `600` lived in
  three places and an operator setting `50` got a clean validation pass and an unchanged
  limiter. `LOG_LEVEL` was inert for a structural reason — **both loggers are module-level
  constants**, so the level was resolved before `env` existed and `logger.debug` could never
  emit in a deployed Worker; the coverage report proved it rather than suggesting it, since
  every `console.*` call sat in an arm reachable only at `minLevel <= 0`. And
  `TAG_READ_TAIL_BYTES=0` was *reachable but inverted*: it read through a parser whose
  contract is `> 0`, so the documented "0 disables the second read" became the default.
  That parser's `>= 0` sibling had **no callers anywhere** in the repository — the helper
  for that value existing, unused, in the same layer, while the line beside it called the
  other one.
- **An endpoint registry nothing asserts is not a contract.** `ENDPOINT_NAMES` and
  `UNIMPLEMENTED` were imported by no test file, so 33 endpoints' `code=70` answers were
  correct by luck and a name in both maps — routed by whichever was assigned last — was
  invisible. `AGENTS.md` below records this gap as *found and not fixed*; it is fixed, in
  `test/endpoint-registry.test.ts`, which asserts the registry's shape rather than any one
  endpoint's behaviour.
- **A field the server hardcodes is a claim with nothing behind it, and the client that
  ignores it is why it survived.** `GET /user/libraries` published `songCount: 0` — a count
  nothing computed — and no client read it, so nothing failed and no test failed. It shipped
  alongside the operator's real complaint: *the page shows no scan progress*. The two are one
  defect seen from both ends, because the progress number was the field that lied. Fixed by
  making the list carry each library's `scan` (`status`, `scanned`, `lastError`) and a real
  `songCount` from `songs`, in one batched read per store.
  - **`scan` is `null` for a library that has never been scanned, and that is not `idle`.**
    `idle` means *scanned, nothing to do*; the null case is the one row an operator has to act
    on, and folding it into `idle` renders "Up to date" for a library with nothing indexed.
  - **`total_count` is written as `0` by `markScanning` and never updated**, so it is not a
    denominator — a client rendering `scanned / total` shows "12 of 0". It is excluded from
    this shape deliberately. Progress is `songCount`, which is the protocol's own unit: what
    `getScanStatus` publishes as `count`.
  - **The list is a read.** `ScanStateDAO.ensure` writes on first sight, so using it would make
    every `GET` a write on a page the operator polls — and would create the row whose absence
    carries the meaning. `listByLibraries` returns only rows that exist.
  - **No server test could see the page-side half.** Every assertion in `user-api.test.ts` is
    about what the server *sends*; the row held its state in `useState(null)` written only by
    the Rescan handler, so a background-driven scan rendered nothing on a green suite. Same gap
    as the `authorized` gate in `test/web-landing.test.tsx`.
- **A state the client cannot represent renders as a word, and the page then polls for ever.**
  `ScanStateSummary['status']` named three statuses; the server sends four. `failed` and
  `stalled` are the **same stored status**, separated only by the retry counter, so a terminal
  scan arrived as the bare word `stalled` and the operator's page had no way to know polling had
  nothing left to buy. `storedStatus` in `scanRetry.ts` is now the one mapping, shared by
  `ScanService.status` and the list projection, and asserted in `test/scan-progress.test.ts`.
- **A poll's failure mode is not the manual refresh's.** An unreachable user API renders as an
  empty list plus a notice, deliberately: the operator keeps reading the page. That is right for
  a **load** and wrong for an **unattended poll** — the same failure would turn four libraries
  into "No libraries yet" every few seconds, which is the one sentence on that page meaning
  something is genuinely absent. A failed poll keeps the list and marks it stale.
- **A bundle value and its inline default are one fact, and nothing compared them.** The header
  rendered as `Edge--Sonic`: `brand.rest` held `"-Sonic"` while the markup rendered its own `-`
  between two spans. Every surface was individually defensible — one well-formed key, a default
  that matched intent, correct markup — so it passed review and reached production, and it is
  only wrong to somebody who already knows the product's name. `scripts/i18n/validate_locales.ts`
  compared two *bundles* and checked that keys exist, and with one shipped language the per-tag
  body is skipped entirely: nothing in it read what a value **is**. It now captures the optional
  second argument of `t('key', 'default')` and **fails** on a disagreement, across all 88 call
  sites. The same drift existed at `libraries.reachable`.
- **A fallback string is a claim about who is looking.** The header's identity chip was
  `userEmail ?? 'Operator'`, so every signed-out visitor saw the word "Operator" in the top
  right of the landing page — the page asserting an identity it did not have, for somebody who
  had not signed in. A default is not an absence.
- **A comparison written twice is two answers, and the one that was *absent* is the one that
  shipped.** `nodes` has two writers: the scan's `reconcileFolder` and `TreeService`'s
  read-through `persistChildren`. Only the browse had a "does this row need writing" check;
  `reconcileFolder` **described** one in its own docstring and had no such branch. So the scan
  re-offered every row it had already written, `runWriteBatch` truncated that against the
  invocation's ceiling, and a folder with ≥45 entries could never be closed — 231,620 rows on
  one 80-album library, and a scan reporting `scanning` for ever. Meanwhile `persistChildren`'s
  header claimed *"both go through `persistChildren`, which is the only place a node row is
  written"* — **false**, and the false sentence is what made the invariant look enforced.
  `nodeWrite.ts` owns the comparison now. See `docs/issues/nodes-upsert-livelock.md`.
- **A shared builder is the point; a copy is a decision deferred until it disagrees.**
  Nine endpoint modules each carried `respond(context, payload)` and
  `type EnvelopeResponse = ReturnType<typeof successResponse>`. Eight were identical and
  the ninth had already diverged — `annotations.ts` hardcoded `successResponse(null, ...)`,
  so its handlers could not return a body at all. Same for `toIso`, which existed five times
  in two spellings (`song.created` kept `.000Z`, `playlist.created` did not), and for the
  album name, where `getSong` omitted `album` for a root-level track while `getAlbum`
  published `"Unknown Album"` for the same row.

- **A column with two writers needs both writers in its key.** `nodes.mtime_ms` is written
  by the scan *and* by `TreeService`'s read-through browse, from the same `Depth: 1`
  PROPFIND, so a stored mtime cannot say which of them wrote it — and the two mean opposite
  things. The scan writes it having *descended into that folder*; the browse writes it
  having read nothing at all below it. `reconcileFolder` read `!changed` as "already
  reconciled", so it closed every folder a browse had materialized. It shipped: a library
  of 80 albums where **none was ever opened**, `songs` empty, `scan_state` `idle`, and the
  page reporting "Up to date. 0 tracks indexed." Three things then made it permanent, and
  each is its own rule:
  - **`is_scanned` is an input to the descent decision, not only its output.** It is the
    only one of the two that says "someone actually descended", so `needsDescent` consults
    it: `known?.is_scanned !== 1 || mtimeMoved || etagMoved`. The browse path writes `0`
    (`isScanned` is optional and `undefined` binds to `0`), so `0` and "absent" both descend.
    This is the `reader_version` invariant one level up — the bytes *and* the thing that
    read them, or the second is unreachable.
  - **"Does this row need rewriting" and "does this folder need descending" are different
    questions**, and one `changed` flag was answering both. Pairing matters: the same cases
    assert that a folder the *scan* reconciled with an unchanged mtime is still closed, so
    the guard cannot be satisfied by disabling incrementality — which would cost one
    PROPFIND per folder per rescan against a 5,000-rows/day allowance.
  - **A completed scan that indexed nothing is not evidence the library is current.**
    `start`'s cheap path compared the root mtime and reported `idle`, which is only sound if
    the previous scan read something — and `scanned_count` counts folders *visited*, so a
    walk that visited the root and closed every child unread leaves it at `1`. With no floor,
    that library could never be re-walked: the origin's root mtime had to change, or the
    library be deleted, which cascades the index away. `start` now also requires
    `songs.countByLibrary > 0`, one indexed read, on `startScan` only.
  - **The chunk boundary is what makes it visible, so the test needs one.** `step` reads the
    frontier *once* and walks all of it, so at the default 40 a root chunk that wrongly
    closes its children still visits them in the same chunk and the library indexes fine.
    The case needs `chunkFolders: 1`, which is also what a root with 80 albums gets in
    practice.

- **A listing that placed nothing is not a listing that found nothing.** Every `toLibraryPath`
  refusal is a silent `continue`, so a listing whose hrefs none sit under the configured root
  path empties `childPaths` and `songPaths` — and the prune then concludes every existing
  child **vanished** and deletes the library recursively, on both planes, before reporting
  `idle`. "We could not place these paths" and "the operator deleted their music" were one
  observation. `reconcileFolder` now throws before a single row is written, so the folder
  stays on the frontier and `step`'s catch records the reason against the retry budget.
  **RFC 4918 §8.3 makes this reachable on a healthy origin**: a server may anchor `DAV:href`
  differently (`/owner/volume/…` vs `/dir/file.txt`), and both are correct. Two rules, and
  the second is how the first collapsed:
  - **The count excludes the folder's own entry.** A `Depth: 1` listing of an empty folder
    is exactly one entry — itself — so `resources.length > 0 && childPaths.length === 0` is
    true of every empty leaf directory, and the guard failed scans that were fine. Caught by
    `test/scan-do.test.ts` through a fixture whose album folder holds no tracks, surfacing as
    `stalled` where `idle` was expected.
  - **`probe` is the surface that can catch it, and it was discarding the evidence.** It
    threw away the `207` it had just received, so a reachable-but-unindexable library probed
    **perfectly clean**. It now reports `207` with a message naming the root path, and it is
    narrow on purpose — a `Depth: 0` listing holds one entry, so it asks only "could the root
    be placed?" An empty listing stays a success, because an empty folder is a legitimate
    library with zero tracks.

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
- `fakeDav` used to fail as a whole — `status` or `failAll` — so no test could stage an
  origin that **lists a file and then refuses its bytes**. That split is the live shape:
  a `207` on `PROPFIND` with a `503` on the ranged `GET`, which is what poisoned both
  the artwork negative cache and four enrichment rows. `setGetStatus` fails the `GET`s
  while the listings still succeed, and it is mutable mid-test because the defect is
  only visible across the moment the origin recovers.
- `fakeDav` used to answer any `Range` with the whole file and a `Content-Range` header
  claiming a prefix. That models a server lying about what it served, and it hid the one
  bug this product exists to avoid. It truncates now, and answers `416` past the end.
- `fakeKv` returned whatever `put` was given, so every cache round-trip in the suite was
  byte-exact while the real binding was **lossy**: KV's `get()` defaults to
  `type: 'text'`, and UTF-8 replaces every invalid sequence with U+FFFD, so a stored JPEG
  read back as text is *changed*. It destroyed the whole embedded-artwork feature and
  nothing failed — see `docs/issues/kv-default-text-read-corrupts-artwork.md`. The rule is
  the generalisation of every bullet above: **a double must model the platform's
  _defaults_, not only its shapes.** A default nobody wrote down is the part that ships,
  and a byte-exact round-trip test proves nothing about a lossy one. `fakeKv` now
  reproduces the decode and records the requested type, so `getBytes` has to say
  `'arrayBuffer'` or the suite reads a corrupted value exactly as production does.

## Commands

```bash
pnpm install --ignore-scripts
pnpm run checks          # everything below except the tests; use checks:fast for that
pnpm run checks:fast     # typecheck + lint + god-files + migrations + locales + SPA shell
pnpm run typecheck       # -r, plus scripts/ and functions/
pnpm run lint            # eslint --fix
pnpm run check:god-files
pnpm run validate:migrations   # read-only; refuses an edited or unlocked migration
pnpm run migrations:lock       # records a NEW migration; never re-hashes an applied one
pnpm run validate:locales
pnpm run verify:spa-shell      # needs `pnpm run build` first
pnpm run test
pnpm run test:coverage   # with the coverage gate
pnpm run test:integration
pnpm run build           # apps/web -> apps/api/src/generated/spa-shell.ts
pnpm run typegen         # wrangler types from the template
pnpm exec wrangler dev
```

The committed `wrangler.jsonc` is **local development only** and is the one config that
carries a `DEV_AUTH_EMAIL` bypass and the two raw 32-zero placeholder keys;
`apps/api/wrangler.template.jsonc` is what a deployment starts from, and it omits both.
`worker-configuration.d.ts` is generated and gitignored. The god-file guard is 300 warn /
400 error, and `test/` is a workspace project so both `pnpm -r typecheck` and `pnpm run
lint` reach it.

**`scripts/` and `functions/` are checked by `pnpm run typecheck` but are not workspace
packages**, so they need their own `typecheck:*` scripts to be reached at all. `functions/`
is a deployed Cloudflare Pages entrypoint whose `service` binding is the one place the two
wrangler templates are coupled, so it was outside every tsconfig until recently — a rename
in one template that missed the other was a deploy-time failure with no local signal. See
`scripts/README.md` for the layout and the entrypoint/module convention.

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
background        -> layers 0-3 (not apps/api)
apps/api          -> layers 0-3 + background (NOT backend-data values; type-only allowed)
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
| Background Workers            | `apps/background/AGENTS.md`                   |
| Tests, thresholds, doubles    | `docs/agents/testing/AGENTS.md`               |
| Repo tooling (`scripts/`)     | `scripts/README.md`                           |
| Backup, restore, Time Travel  | `docs/db-backup-recovery.md`                  |

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
