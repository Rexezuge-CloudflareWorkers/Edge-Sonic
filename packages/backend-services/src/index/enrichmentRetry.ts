/**
 * When enrichment reads a file again, and when a failure earns no stamp at all.
 *
 * Split from `EnrichmentService` because the stamp is a promise — "already read" — and
 * the two functions here are the two halves of keeping it: `shouldEnrich` decides who
 * to read, and `isTransientEnrichmentFailure` decides whose failure is not an answer.
 * The service does the reading; this module owns what "already read" means. It sits
 * beside `scanRetry.ts`, which owns the same decision for the scan.
 */
import { READER_VERSION } from '@edge-sonic/media-tags';
import type { SongRow } from '@edge-sonic/backend-data/dao';
import { WebDavError } from '@edge-sonic/webdav';

/**
 * A row worth another read.
 *
 * The guard is a **pair** of facts, not one. A row with `duration = 0` is either
 * *not yet read* or *unreadable by this module* — MP4/M4A puts `moov` at the end of
 * the file, so a prefix read cannot reach it. Retrying those on every `getSong`
 * would be one wasted subrequest per play, forever, for a format that needs a tail
 * read instead. So:
 *
 * - mtime moved → re-read (the file changed, it may be readable now);
 * - mtime unchanged and `enriched_at` is set → never read again;
 * - mtime unchanged and `enriched_at` is null → never scanned, read once.
 *
 * ### The second fact is the reader, and omitting it shipped
 *
 * That third rule above is only sound while the reader is fixed. What it extracts is a
 * property of the *reader* as much as of the bytes, and a reader that learns to read
 * something it previously could not leaves every row it already wrote looking current:
 * mtime matches, so nothing is re-read, and the wrong value is served for ever. It
 * shipped — a deploy carrying a corrected Ogg reader left a library reporting a 240.61 s
 * track as 3 s at 15329 kbps with no artist, album, genre, track or year, and neither a
 * `getSong` nor a full rescan repaired it.
 *
 * So `reader_version` is the other half of the condition, and a row that does not carry
 * this reader's version is re-read whatever its mtime says.
 */
function shouldEnrich(song: SongRow): boolean {
  return song.enriched_at === null || song.reader_version !== READER_VERSION;
}

/**
 * Whether a read failure is about something other than the file.
 *
 * The stamp this module writes means "already read", and `shouldEnrich` trusts it — so
 * writing it over a failure that says nothing about the file makes the failure
 * permanent. That much is the `503` defect below. This function is the same rule with
 * the question asked properly, and the answer changed because asking it properly
 * changed the answer:
 *
 * **A status that describes *this revision of this file* earns the stamp. A status that
 * describes the request, the session or the network does not.** There is exactly one of
 * the first kind on this path, and the whole class that used to be lumped in with it —
 * `400`, `401`, `403`, `413`, `416` — is the second.
 *
 * ### Why the class was wrong
 *
 * The old list called `400`, `404` and `413` "deterministic", which is true of the
 * *request* and says nothing about the file. `413` is the sharpest case, and it is the
 * one that shipped: it is thrown by `WebDavClient.readBounded`, which is **this
 * server's own limit** on a body it was asked to read, and it is thrown routinely by an
 * origin that answers a `Range` request with `200` and the whole file — a server that
 * has not heard of ranges answers "here is everything" rather than "no". Stamping
 * `enriched_at` over that records "we looked and this file is unreadable" for a file
 * this server never managed to read, and the row then says so for ever: `shouldEnrich`
 * declines it, `getSong` re-reads nothing, and `songs.duration` stays `0` with the
 * path-derived `(derived)` names still on the row.
 *
 * It is the `503` defect with a different status code, and it is worse than the `503`
 * because it is *systematic*: one origin that ignores `Range` poisons a whole library
 * in a single scan, with no error anywhere and nothing on the operator's page — a
 * Subsonic client showing every track with no duration and no tags, which is what an
 * unreadable library looks like and is not one.
 *
 * ### What is left, and why it is safe to retry the rest
 *
 * Only `404` stamps: this revision of this path is not there. A file deleted between
 * the scan's listing and its enrichment looks exactly like it, and re-reading it for
 * ever would cost a subrequest per play for a file that is gone.
 *
 * Everything else leaves the row untouched, and the next call tries again — no queue, no
 * backoff. That is a real cost when the fault is permanent (`403` from a rotated
 * credential costs one ranged read per play), and it is the same trade the `503` case
 * already makes: a row that does not claim to have been read is recoverable when the
 * cause is fixed, and a row that claims it was read is not recoverable at all.
 *
 * It shipped the other way round twice: first every read failure was recorded, so four
 * tracks of a live library caught a flapping origin during the scan and reported
 * duration `0` for ever; then the "deterministic" list above, so a whole library whose
 * origin ignores `Range` reported duration `0` for ever instead.
 */
function isTransientEnrichmentFailure(error: unknown): boolean {
  if (error instanceof WebDavError) {
    // `404` is the only answer about the file. Everything else — `400`, `401`, `403`,
    // `408`, `413`, `416`, `429`, `5xx` — describes the request, the session or the
    // network, and stamping over one of those makes it permanent.
    return error.status !== 404;
  }
  return true;
}

export { shouldEnrich, isTransientEnrichmentFailure };
