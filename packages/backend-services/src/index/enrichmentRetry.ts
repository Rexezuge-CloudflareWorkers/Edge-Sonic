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
 * Whether a read failure is about the network rather than the file.
 *
 * The stamp this module writes means "already read", and `shouldEnrich` trusts it — so
 * writing it over a failure that says nothing about the file makes the failure
 * permanent. Only a definitive answer earns the stamp: an unknown container, a `400`
 * (the request was refused before any file was involved), a `404` (this revision of
 * the file is not there), a `413` (the bound refused it, deterministically).
 *
 * Everything else — a timeout, a `429`, a `5xx`, or an error with no status at all
 * (DNS, TLS, a reset connection) — leaves the row untouched, and the next call tries
 * again. That is the whole retry path for a flapping origin: there is no queue and no
 * backoff, just a row that does not claim to have been read.
 *
 * It shipped the other way round: every read failure was recorded as an attempt, so
 * four tracks of a live library caught a flapping origin during the scan and reported
 * duration `0` for ever — the stamp said "already read", and nothing ever re-read
 * them.
 */
function isTransientEnrichmentFailure(error: unknown): boolean {
  if (error instanceof WebDavError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

export { shouldEnrich, isTransientEnrichmentFailure };
