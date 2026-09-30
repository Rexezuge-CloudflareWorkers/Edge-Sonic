export const DEFAULT_DEBUG_MODE = 'false';
export const DEFAULT_ENVIRONMENT = 'production';
export const DEFAULT_SITE_URL = '';

/**
Cap on how many media folders one user may be granted.
*/
export const DEFAULT_MAX_LIBRARIES = '10';

/**
Per-WebDAV-request timeout.
*/
export const DEFAULT_WEBDAV_TIMEOUT_MS = '10000';

/**
 * Folders a single scan chunk will descend into.
 *
 * This bounds **D1 work** — frontier rows read and rows written — against the
 * 5,000-rows/day allowance, and it is deliberately *not* the subrequest bound:
 * that is `SCAN_CHUNK_MAX_REQUESTS`, and the two are separate because a chunk can
 * run out of either first.
 *
 * It was once documented as a subrequest budget ("one folder costs one `PROPFIND`,
 * and Workers allow 1,000 subrequests per request"). Both halves of that are now
 * wrong: the ceiling is per *external* subrequest, and it is 50 on the Free plan.
 */
export const DEFAULT_SCAN_CHUNK_FOLDERS = '40';

/**
 * Subrequests one scan chunk may issue.
 *
 * The platform counts subrequests per invocation, and exceeding the ceiling does
 * not make a chunk slow — it makes it **fail**. So this is a hard ceiling, not a
 * target.
 *
 * ### Why 40, and not 1,000
 *
 * The number this replaces was sized against "1,000 subrequests per request",
 * which Cloudflare retired on 2026-02-11. The current limits are **50 external**
 * subrequests on the Free plan and 10,000 on Paid, so a default of 1,000 was a
 * chunk that fails outright on a Free-plan account. 40 leaves ten for redirect
 * chains, which the platform also counts.
 *
 * A deployment on Workers Paid should raise this, or set `limits.subrequests` in
 * its own wrangler config. The conservative default is the one that cannot fail.
 */
export const DEFAULT_SCAN_CHUNK_MAX_REQUESTS = '40';

/**
 * Milliseconds one scan chunk may take.
 *
 * A chunk is `folders × per-request latency` with no other bound, and on an origin
 * answering a ranged `GET` in 2.2 s a 40-folder chunk is ~88 s — work a client
 * abandoned at 45 s, which then completed server-side where nobody was watching.
 * A client that backs off stops advancing the scan, because polling *is* the scan.
 *
 * Checked between units of work, so a chunk overruns by at most one in-flight
 * request. 20 s sits under the ~45 s a Subsonic client was observed giving up at,
 * with room for a single slow request on top.
 */
export const DEFAULT_SCAN_CHUNK_DEADLINE_MS = '20000';

/**
Upper bound on a single page of results, matching the protocol's own maximum.
*/
export const DEFAULT_MAX_PAGE_SIZE = '500';

/**
 * The largest page this server will accept, whatever `MAX_PAGE_SIZE` says.
 *
 * ### A limit the platform imposes is not a number the code may choose
 *
 * `MAX_PAGE_SIZE` was raised by an operator the same way `SCAN_CHUNK_MAX_REQUESTS` is
 * meant to be, and the two do not behave alike. The scan ceiling is a *budget* the chunk
 * spends and leaves the remainder of; a page size is a promise to **answer** — so raising it
 * does not make a page slower, it makes a request unservable.
 *
 * A page of *N* album groups costs one grouped query plus `ceil(N / groupsPerStatement)`
 * further statements to fetch their songs, and each of those statements binds
 * `D1_MAX_BIND_PARAMETERS` parameters (`backend-data`'s `bindChunkSize`, which derives the
 * 49 from the platform's 100-parameter ceiling rather than carrying the number). D1 queries
 * are subrequests, so the page has to fit inside the same budget as everything else: on the
 * Free plan that is **50**. Leaving headroom for the grouped query itself, for the
 * annotation reads every list endpoint makes, and for redirect chains — also counted — caps
 * the statement count well below 50.
 *
 * So the ceiling is derived from two numbers the platform sets rather than chosen to be
 * comfortable, exactly as `bindChunkSize` is derived from the 100-parameter ceiling. The
 * value below is what that derivation produces.
 */
export const MAX_PAGE_SIZE_CEILING = 2200;

/**
Default page size when a client does not send `size`.
*/
export const DEFAULT_PAGE_SIZE = '20';

/**
Bytes read from a file's head when enriching duration and bitrate.
*/
export const DEFAULT_TAG_READ_BYTES = '131072';

/**
Bytes read from a file's *end* when the duration is recorded there — Ogg.

One whole Ogg page body is 255 segments of 255 bytes, plus a 27-byte header and a
255-byte segment table, so 65,536 guarantees the final page's header is inside the
range regardless of where the file's size puts it.
*/
export const DEFAULT_TAG_READ_TAIL_BYTES = '65536';

/**
Tracks the scan enriches per folder, per chunk.

A bound on the *shape* of a folder, not on the chunk: the chunk's own ceiling is
`SCAN_CHUNK_MAX_REQUESTS`, and enrichment shares whatever the `PROPFIND`s leave of it.
This number exists so one album of 500 changed tracks cannot take the whole budget and
starve the walk of the folders behind it.

An Ogg track costs two range reads — a prefix and a tail — and the scan admits one on the
cost of two. What does not fit keeps `enriched_at = null` and is enriched on first play
instead: a degraded answer, rather than a chunk that fails.
*/
export const DEFAULT_SCAN_ENRICH_MAX_PER_FOLDER = '20';

/**
Failed logins from one (user, IP) pair before the throttle engages.
*/
export const DEFAULT_AUTH_FAILURE_LIMIT = '10';

/**
Window the failure counter covers.
*/
export const DEFAULT_AUTH_FAILURE_WINDOW_SECONDS = '900';

/**
Streaming requests per minute per authenticated user.
*/
export const DEFAULT_STREAM_RATE_LIMIT = '600';

/**
Upstream connection/response timeout for streaming, separate from metadata.
*/
export const DEFAULT_STREAM_TIMEOUT_MS = '30000';
