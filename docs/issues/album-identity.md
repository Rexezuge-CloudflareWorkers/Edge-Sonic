# An album is a configuration, not a folder

**Status:** fixed. `ALBUM_GROUP_BY` ships with `album` as the default.
**Measured on:** a live library — 113 tracks, 80 album folders, one WebDAV origin.

## The report

`getAlbumList2` and `search3` returned `Ex-Otogibanashi` twice: one album with tracks 1 and 2, one
with track 3, and a different `artist` on each. The report was "songs from a single album appear to
be in multiple albums with the same album name, but different artists".

## What was actually there

The two albums' ids decoded to two different `dir_path`s, and a `PROPFIND` against the origin
confirmed two real folders:

```
ryo (supercell), かぐや(cv.夏吉ゆうこ) & 月見ヤチヨ(cv.早見沙織) - Ex-Otogibanashi/
  01 - Ex-Otogibanashi.opus
  02 - ワールドイズマイン (かぐや&月見ヤチヨ ver.) [CPK! Remix].opus
ryo (supercell) & かぐや(cv.夏吉ゆうこ) - Ex-Otogibanashi/
  03 - メルト (かぐや ver.) [CPK! Remix].opus
```

All 113 tracks carry `ALBUM` and `ARTIST`. **None carries `ALBUMARTIST`** — verified across all 80
albums through `getAlbum`. So the folders differ only in the per-track `ARTIST` string, and `ALBUM`
is the only thing the release's tracks share.

The layout is a per-artist rip: the folder is named after the track's performer, so one release is
one directory per artist. Across the library:

| Album name                                                  | Folders | Tracks |
| ----------------------------------------------------------- | ------- | ------ |
| `Ex-Otogibanashi`                                           | 2       | 3      |
| `MementoMori (メメントモリ)`                                | 6       | 6      |
| `超かぐや姫！`                                              | 5       | 5      |
| `魔法少女ノ魔女裁判 コンプリートオリジナルサウンドトラック` | 6       | 9      |
| 5 more                                                      | 2 each  |        |

80 album rows for **71 distinct `ALBUM` values**.

## Why it shipped

Album membership was `songs.dir_path`. `listAlbums` did `GROUP BY dir_path`, and `groupAlbums` keyed
on `dir_path` — which was a _deliberate_ unification. `listAlbums` used to group on
`(album_artist_ci, album_ci)` while the caller regrouped by `dir_path`, and the disagreement between
them shipped a page holding between one and five albums. Commit `36cc0f3` fixed it by making both
sides `dir_path`, and its message said what that left open:

> Not changed, and deliberately: an album is still identified by its **folder**, so a compilation
> spread across six directories is six albums here and one there. […] That is a modelling decision,
> not a protocol one, and it wants its own change.

So the defect was a deferred decision, and the deferral was the defect: nothing recorded that the
library layout which makes it _correct_ — one folder per release — is a layout, not a law.

## Why a setting rather than a fix

There is no right answer. A library with one folder per release and a consistent `ALBUM` tag
answers identically under `folder` and `album`. A DJ set of 400 folders with sloppy tags answers
_wrongly_ under `album`, which merges them. And the reference server makes the same choice
explicit and configurable:

> You can group albums by musicbrainz_albumid, discogs_release_id, folder, or any other tag you
> want. — Navidrome, `PID.Album`

Its default is `albumartistid,album,albumversion,releasedate`, i.e. the tag pair. Its FAQ is explicit
that a release split across album artists needs `ALBUMARTIST` set consistently on every track, and
that `PID.Album=folder` is the escape hatch. So "match Navidrome" was never a single answer either —
which is the argument for exposing the choice rather than picking one silently.

`ALBUM_GROUP_BY` ∈ `folder | album | album_artist`, default `album`.

## What `album_artist` is worth, honestly

Less than it looks, and the mode's docstring says so:

- For a library with **no `ALBUMARTIST` anywhere** — which is this one — `album_artist` and `album`
  are the same grouping. A missing album artist is one _value_ (`(NULL, album)`), not a wildcard.
- On a **per-artist folder layout**, `upsertFileFacts` derives `album_artist` from the folder, and
  the folder is named after the performer — so `album_artist` reproduces the split even with the tag
  absent.

It fixes a properly tagged compilation and nothing else. Both facts have a fixture in
`test/schema.int.test.ts`, because a mode that silently does nothing on the deployment that reaches
for it is the failure this repository keeps recording.

## A related defect, found while measuring it

`album_artist` is **NULL on all 113 rows of the live library**, and the path derivation that is
supposed to fill it explains why: `upsertFileFacts` and `applyDerivation` both write a derived
`album_artist`, but `songDerivation`'s backfill selects on `derived_version`, and `DERIVED_VERSION`
was never bumped when the album-artist half was added. A library indexed before that change is never
re-selected, so the column stays NULL for ever.

This is the third instance of the invariant the root `AGENTS.md` already records twice ("indexing
only happens on change, so deriving there is not enough"). `reader_version` and `derived_version` are
the mechanism for correcting a derivation, and the mechanism was not used here.

**Not fixed in this change**, deliberately: bumping `DERIVED_VERSION` makes every row re-selected,
and `applyDerivation` runs with `requireComplete: true` against a ~42-statement budget, so a library
larger than the budget would fail the backfill on _every_ poll. That is a separate fix with its own
blast radius, and it changes `album_artist` for every deployment.

## The second defect, which is not a grouping question at all

`Silent Siren Selection` is **one directory**. `getAlbum` returned:

```
disc=1 trk=2  Stella☆
disc=2 trk=3  Koi Yuki      <- disc 2, between two disc-1 tracks
disc=2 trk=6  KAKUMEI
disc=1 trk=8  I x U
disc=2 trk=14 Cherry Bomb
```

`getAlbum` sorted by `(track, name)`; `groupAlbums` sorted by `(disc, track, name)`; `getCoverArt`'s
artwork probe sorted by `(track, name)` _deliberately, to match `getAlbum`_. The two copies missing
`disc` therefore matched each other, so no comparison between surfaces disagreed and nothing
anywhere reported an error. Every field in the response is correct and the order is wrong.

It also reached further than rendering: `albumModel` reads `created`, `year` and `genre` from
`songs[0]`, so a differing "first track" means `getAlbum` and `getAlbumList2` could publish
**different `created` for one album id** — the drift this repository already recorded for `getAlbum`'s
omitted `created`, arriving through the sort rather than the literal.

`compareAlbumTracks` is now the single definition, used by `groupAlbums`, `getAlbum` and the artwork
probe. One test needed a fixture whose names differ only by case to catch the remaining `name_ci`
versus `name` difference between the SQL `ORDER BY` and the comparator.

## A correction worth recording

The first analysis of this library claimed `魔法少女ノ魔女裁判` had "two track 1s and two track 2s —
the numbering came per-artist, and no server can repair it". That was wrong: `(disc, track)` is unique
across all nine tracks. Disc 1 holds 1, 2, 3, 19, 20, 21, 22 and disc 2 holds 1 and 2. Merging the
six folders produces a correct two-disc, nine-track album, and the interleaving above is the
comparator bug wearing a different hat.

## Also found, not fixed

The starred-album paths read album ids one at a time and dedupe by nothing. Two stored ids that now
name one album published it twice in a list whose whole job is to be a set. Fixed here, because the
grouping change is what makes it reachable — but the N+1 was already there.
