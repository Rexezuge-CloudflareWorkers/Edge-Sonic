# Edge-Sonic — The Subsonic Wire

Scope: `packages/subsonic` and the `/rest` surface that serves it — ids, the node model,
the three serializers, and the endpoint registry. Reads for: anyone changing what goes
on the wire.

Every invariant here was a **shape** defect. A wrong envelope answers `200`, renders
something plausible, and is invisible from inside the server — the suite parses what the
server produced with the same leniency a client does, so a document that violates the
schema still passes. The instrument that finds this class is `scripts/compare-reference.ts`
and a decoder written from the schema rather than from our own output; see
[Testing](../testing/AGENTS.md).

## The registry, measured

`apps/api/src/rest/endpoints/index.ts` holds three maps. The counts are asserted in
`test/endpoint-registry.test.ts`; re-derive rather than trust them if one moves.

| Map | Entries | Answers |
| --- | ---: | --- |
| `IMPLEMENTED` | 43 | the real thing |
| `UNIMPLEMENTED` | 20 | 410 ×5 `gone`, 501 ×12 `not-implemented`, `code=50` ×3 `not-authorized` |
| `EMPTY_RESULT` | 7 | an empty wrapper, after validating the request |
| `ENDPOINT_NAMES` | 70 | — |

`kind: 'absent'` → `code=70` is a **type member and a handler branch with no entry**, so
`code=70` from this registry is unreachable. It is still reached two other ways, both
correct: an unresolvable `id` (`apps/api/src/rest/dispatch.ts`) and an endpoint a
directory-based album or artist grouping cannot resolve.

`getOpenSubsonicExtensions` is the sole entry in `PUBLIC_ENDPOINTS`, because the protocol
requires it to answer without credentials.

## Invariants

Violating any of these reintroduces a fixed defect. The suite asserts each one.

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
- **"Not implemented" is four answers, and `code=70` was right for none of them.**
  `getLyrics`, `getLyricsBySongId`, `getArtistInfo`, `getArtistInfo2`, `getTopSongs`,
  `getInternetRadioStations` and `getShares` answered `code=70` while being endpoints a
  client calls routinely — `getLyrics` on every track — so `code=70` said the server had
  *failed* where the truth was that there is nothing to report. `EMPTY_RESULT` answers each with its own
  wrapper and no items, after validating the request: an unresolvable `id` is `code=70`
  and an absent required parameter is `code=10`, because "the lyrics of that song do not
  exist" and "that song has no lyrics" look identical in a response and mean opposite
  things. `UNIMPLEMENTED` carries a `kind`: `gone` → 410, `not-implemented` → 501,
  `not-authorized` → `code=50`, `absent` → `code=70`. **No entry uses `absent`
  today**: the table holds 5 `gone`, 12 `not-implemented` and 3 `not-authorized`, so the
  registry answers 410, 501 and `code=50`, so `code=70` from here is unreachable — which
  is the answer `EMPTY_RESULT` was introduced to replace. **A name in two registry tables
  is routed by whichever was assigned last and reported by neither**, and five were when
  `EMPTY_RESULT` was introduced because the overlap test existed and did not look there.
- **The wrapper element's name is not the endpoint's name.** **All seven** empty-result
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
  - **The declaration cannot move into the shared builder.** The serializer cannot tell a
    record's scalar child from a record's list child, so the builder that knows says so —
    and `AlbumID3` declares no `song` field at all, so putting the declaration on the
    shared album builder publishes one on every album in `getAlbumList2`/`getArtist`/
    `search2`, which is the same defect as the `title`/`isDir` half above. So an album is
    **two** elements: `albumElement` (a list child) and `albumWithSongs` (`getAlbum`'s
    payload), over one `albumAttrs`.

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
- **`params.int(name, undefined)` is not `undefined`.** It returns the number `0`, which
  is not nullish, so a `pageSize(params.int('count', undefined), 10)` fallback never
  applies and the floor turns it into one. Use `optionalInt` for "was it sent".
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
  `test/endpoint-registry.test.ts` asserts the registry's shape, each entry's answer
  through the real dispatcher — **410 for `gone`, 501 for `not-implemented`, `code=50` for
  `not-authorized`** — and the exact error key set of each — so the next endpoint
  that lands in the wrong map fails a test rather than answering.
- **A value the protocol declares as a timestamp cannot be published from a `Set`.**
  `getArtists` decorated a starred artist with `starred: undefined`, and `undefined` is
  dropped by **both** serializers — so no attribute in XML and no key in JSON, for a star
  that was stored correctly. `getStarred` deliberately does not expand artist stars, so
  `getArtists` was the only surface that reports them and it reported nothing. The lookup
  was a `Set<string>`, which made `undefined` the only value the mapper could produce: a
  type making the wrong answer the only available one *is* a field saying it is missing.
  `AnnotationLookup.stars` is a `Map` of id to epoch second, and `stars.starred_at` was
  already stored and already the sort key — it was simply never selected.
- **An endpoint registry nothing asserts is not a contract.** `ENDPOINT_NAMES` and
  `UNIMPLEMENTED` were imported by no test file, so 20 endpoints' absent-endpoint answers were
  correct by luck and a name in both maps — routed by whichever was assigned last — was
  invisible. The root guide recorded this gap as *found and not fixed*; it is fixed, in
  `test/endpoint-registry.test.ts`, which asserts the registry's shape rather than any one
  endpoint's behaviour.
- **A shared builder is the point; a copy is a decision deferred until it disagrees.**
  Nine endpoint modules each carried `respond(context, payload)` and
  `type EnvelopeResponse = ReturnType<typeof successResponse>`. Eight were identical and
  the ninth had already diverged — `annotations.ts` hardcoded `successResponse(null, ...)`,
  so its handlers could not return a body at all. Same for `toIso`, which existed five times
  in two spellings (`song.created` kept `.000Z`, `playlist.created` did not), and for the
  album name, where `getSong` omitted `album` for a root-level track while `getAlbum`
  published `"Unknown Album"` for the same row.

## See also

- [`apps/api/AGENTS.md`](../../../apps/api/AGENTS.md) — routing, the two error dialects,
  rate-limit order, and the endpoints that build these elements
- [`packages/subsonic/`](../../../packages/subsonic/README.md) — the package itself
- [`docs/issues/album-identity.md`](../../issues/album-identity.md) — what an album *is*,
  which several invariants above depend on
