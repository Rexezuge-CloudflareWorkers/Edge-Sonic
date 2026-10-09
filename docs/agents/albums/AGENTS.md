# Edge-Sonic — Album Identity

Scope: what an album **is** — the grouping key, the id that names it, and the order of
its tracks. Reads for: anyone touching `ALBUM_GROUP_BY`, album ids, or an album list.

There is no `albums` table, and that is the decision rather than an omission: an album is
a **group**, and a folder and a release routinely disagree. Measured on a live library,
113 tracks in 80 album folders carried **71 distinct `ALBUM` values** — nine releases split
across folders, one across six, so `MementoMori (メメントモリ)` appeared six times and
`Ex-Otogibanashi` was cut in half. A folder is a storage layout; a release is a fact about
a recording. Which of them wins is a modelling question with no right answer, so it is a
**setting**: `ALBUM_GROUP_BY` ∈ `folder | album | album_artist`, default `album` — the same
question the reference server exposes as `PID.Album`.

Three modules own it and none of them may answer it alone:

- `packages/subsonic/src/albumKey.ts` — the key, as a value
- `packages/backend-data/src/dao/albumKeySql.ts` — the key, as SQL (`GROUP BY` per grouping)
- `apps/api/src/rest/albumIdentity.ts` — the key, carried per request

The invariants below are each a way the previous one collapsed: a disagreement between the
SQL group and the TypeScript group, then a grouping the protocol cannot name, then an order
written out twice.

## Invariants

Violating any of these reintroduces a fixed defect. The suite asserts each one.

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
- **An album is a _configuration_, because a folder and a release routinely disagree.**
  Unifying the grouping on `dir_path` made a library whose folders split a release report one
  album per folder: measured on a live library, 113 tracks in 80 album folders carrying **71
  distinct `ALBUM` values**, nine releases split across folders and one across six, so
  `MementoMori (メメントモリ)` appeared six times and `Ex-Otogibanashi` was cut in half. The
  answer is `ALBUM_GROUP_BY` ∈ `folder | album | album_artist`, default `album` — the same
  decision the reference server exposes as `PID.Album`, and a modelling question with no
  right answer is a _setting_, not a bug. `subsonic/albumKey.ts` owns the question,
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
    still points at the merged album — and an album annotation lookup checks the folder-shaped id
    too, or a correctly-stored star is reported by nothing. This is **not** the same as the song-id
    fallback, which is retired: an album id is reversible by construction, so `al:` is a spelling
    this server still mints under `folder` grouping, while a song id is derived and never minted in
    two forms.
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

## See also

- [`docs/issues/album-identity.md`](../../issues/album-identity.md) — the measurement and
  the full decision record
- [`The Subsonic Wire`](../protocol/AGENTS.md) — how an album id reaches a client
- [`packages/backend-data/AGENTS.md`](../../../packages/backend-data/AGENTS.md) — the key
  as SQL, and the paging that keeps the two in agreement
