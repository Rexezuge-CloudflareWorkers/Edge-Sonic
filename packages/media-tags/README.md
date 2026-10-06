# `@edge-sonic/media-tags`

MP3 (ID3v2), FLAC (metadata block table) and Ogg Vorbis/Opus readers. Layer 0 — no
dependency on anything in this repository, and **no dependency on a tag library**: every byte
offset below is one this repository owns.

The rules these readers live under are in
[`docs/agents/media/AGENTS.md`](../../docs/agents/media/AGENTS.md).

## Nothing here reads a whole file

Every entry point takes a **bounded** buffer, and a caller that cannot answer from one gets
a **range to fetch** rather than a partial answer:

| Module | Answers from |
| --- | --- |
| `mp3.ts` | an ID3v2 prefix; walks the frame list when the `APIC` frame is past the prefix |
| `flac.ts` | a `STREAMINFO` block; `flacPicture.ts` locates a `PICTURE` block **by range** |
| `ogg.ts`, `vorbisComment.ts` | the comment packet; `oggFraming.ts` decodes the **segment** table |

A truncated cover is a cover that "loaded" and renders as a grey box, so a picture whose
block header is past the prefix is reported as **not locatable** and the caller answers the
placeholder — never as a partial image.

## An Ogg page is not a packet

Packets are delimited by the **segment table**: a packet ends where a lacing entry is below
255, and one page may carry several. `libavformat` writes Opus's identification header and
its comment block as two packets in **one** page, so a reader that looks for them only at
page starts finds the first and never looks again — and since `getArtists`,
`getAlbumList2`, `getGenres` and `search3` all group on the columns a tag supplies, a
library of 81 artists answers all four with `[]`.

A packet longer than a page continues onto the next one, split by that page's header, so its
bytes are not adjacent and must be **reassembled**.

A **granule is only a duration on the last page**. Read off any other page — or off one the
buffer truncated — it is a number that is not the file's length: a 240.61 s track served as
3 s at 15329 kbps, and a client seeks by it. So the Ogg reader returns `null` rather than a
wrong answer, and the enrichment path issues a **tail** read.

## The fixtures decode themselves back

A fixture and the reader that consumes it can be wrong the same way, and then no test fails.
So `test/ogg-packet-layout.test.ts` builds the **lacing table** from the specification and
then decodes it back through `packetStarts` before asserting anything about the reader, and
`test/embedded-art.test.ts` does the same for a FLAC block table and an ID3 frame list.

That paid for itself immediately: five of its own bugs surfaced as reader failures — a 4-byte
Ogg granule where the specification has 8, a 36-byte `STREAMINFO` where it has 34, a
syncsafe *decoder* that ORed the whole value into its low byte, a `packetStarts` that
reported where a packet's last segment began, and a `Uint8Array` image body that
`Array.prototype.flat` refused to flatten, so every offset after it was wrong. In every case
the reader was right and the fixture was not — which is the only outcome that makes the
remaining assertions mean anything.

## Where the bytes come from

`readPrefix` and `readTail` in `packages/webdav` are both ranged reads. The bound is
`TAG_READ_BYTES` (128 KiB) and `TAG_READ_TAIL_BYTES` (64 KiB), and `TAG_READ_TAIL_BYTES=0`
disables the second read — a supported configuration, not a degraded one.