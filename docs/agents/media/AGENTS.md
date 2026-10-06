# Edge-Sonic — Tags, Enrichment And Artwork

Scope: `packages/media-tags`, and the enrichment and cover-art paths in
`packages/backend-services`. Reads for: anyone reading a byte out of an audio file.

Three rules run through all of it. **Nothing reads a whole file** — a prefix is bounded by
`TAG_READ_BYTES` and a tail by `TAG_READ_TAIL_BYTES`, and where a byte lives outside both
the answer is a **range** the caller must fetch, never a partial image. **What a row holds
is a function of the file *and* of the reader that extracted it**, so invalidation carries
`reader_version` as well as `mtime_ms`. And **a failure that says nothing about the file
earns no stamp**, because `enriched_at` means "already read" and every later decision
trusts it.

Formats: MP3 (ID3v2), FLAC (metadata block table) and Ogg Vorbis/Opus (segment tables,
which are not page boundaries).

## Invariants

Violating any of these reintroduces a fixed defect. The suite asserts each one.

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

## See also

- [`packages/media-tags/README.md`](../../../packages/media-tags/README.md)
- [`docs/agents/testing/AGENTS.md`](../testing/AGENTS.md) — why the fixtures here are
  written from the specifications and decode themselves back
- [`docs/issues/kv-default-text-read-corrupts-artwork.md`](../../issues/kv-default-text-read-corrupts-artwork.md)
