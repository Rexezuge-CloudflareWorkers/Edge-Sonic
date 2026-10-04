import {
  
  SCAN_CHUNK_FOLDER_LIMIT,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SCAN_ENRICH_MAX_PER_FOLDER,
} from './subrequests';

/**
 * Re-exported rather than re-declared: the derivation and this default are one fact, and a
 * second copy of `MAX_PAGE_SIZE_CEILING` is a second thing that can be wrong.
 */


export const DEFAULT_DEBUG_MODE = 'false';
export const DEFAULT_ENVIRONMENT = 'production';
export const DEFAULT_SITE_URL = '';

/**
Cap on how many media folders one user may be granted.
*/
export const DEFAULT_MAX_LIBRARIES = '10';

/**
 * What decides which tracks are one album: `folder`, `album` or `album_artist`.
 *
 * `album` rather than `folder`, and the reason is a measured one rather than a preference.
 * A library whose folders are laid out per release answers identically either way, so the
 * default is invisible there — which is exactly why making it a *decision* rather than an
 * accident matters. Measured against a live library of 113 tracks: 80 album folders carrying
 * 71 distinct `ALBUM` values, because nine releases were split across folders and one of them
 * across six. `folder` published `MementoMori (メメントモリ)` six times and split
 * `Ex-Otogibanashi` in half.
 *
 * `folder` remains available for the libraries that want it — a DJ set of 400 folders, each
 * one album with an inconsistent `ALBUM` tag, is a real layout and grouping on the tag merges
 * them. The full argument, including what each value costs, is in `subsonic/albumKey.ts`;
 * this is only the default.
 */
export const DEFAULT_ALBUM_GROUP_BY = 'album';

/**
Per-WebDAV-request timeout.
*/
export const DEFAULT_WEBDAV_TIMEOUT_MS = '10000';

/**
Folders a single scan chunk will descend into.

**Derived** from the platform's subrequest ceiling, in `subrequests.ts` — not typed here,
because a number typed beside the code that has to honour it is a number that is wrong by
the time the platform changes. It was `40`, documented as a bound on D1 *row writes* against
the 5,000-rows/day allowance — which it still is, and which is not what stopped working.

What stopped working is the subrequest ceiling, and the same 40 folders are ~42 external
requests and ~160 D1 statements, so the chunk died at the ceiling with 40 folders of
indexing still ahead of it. The two bounds guard different resources and both are needed;
they are simply not independent, so the folder count is now computed from the ceiling
instead of chosen beside it.
*/
export const DEFAULT_SCAN_CHUNK_FOLDERS = String(SCAN_CHUNK_FOLDER_LIMIT);

/**
Subrequests one scan chunk may issue.

**Derived**: the platform's ceiling less the invocation's own overhead — see
`subrequests.ts`, which is where the arithmetic lives. It was a literal `40`, which was wrong
twice over: it counted only `fetch`, and the `40` was reached by subtracting from a ceiling
of 50 as if nothing else in the invocation spent anything.

A **total**: D1 statements, KV operations and WebDAV requests alike, because D1 states its
own limit as *queries per Worker invocation — 50 (Free)*. Exceeding it does not make a chunk
slow, it **kills the invocation**, with an error no `catch` in the chunk can see. So this is
a hard ceiling and not a target, and it is spent deliberately rather than overrun.
*/
export const DEFAULT_SCAN_CHUNK_MAX_REQUESTS = String(SCAN_CHUNK_SUBSREQUEST_BUDGET);

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
The largest page this server will accept, whatever `MAX_PAGE_SIZE` says.

**Derived** in `subrequests.ts` from the same ceiling a scan chunk is sized against, and
exported here so the configuration layer has one name for it. It was `2200`, derived from the
right principle — a page of N groups costs a grouped query plus `ceil(N / groupsPer…)`
statements — but from a quantity that does not bound what the page *spends*: the follow-on
statement count is driven by the page's **track** count, so 2,200 albums of twelve tracks
each fetches 26,400 rows in 45 statements before the annotation reads are counted. See the
derivation there for the arithmetic, and `test/subrequest-budget.test.ts` for the assertion
that the relationship holds rather than the numeral.
*/

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

**Derived** from the chunk budget in `subrequests.ts`, and a bound on the *shape* of a
folder rather than on the chunk: without it, one album of 500 changed tracks takes every
poll for itself and the folders behind it are never walked.

It was `20`, and the number that actually mattered — the per-track cost it was checked
against — was `MAX_REQUESTS_PER_TRACK = 2`, counting the two **external** range reads and
forgetting the `songMeta` KV read, the `applyMetadata` write and the `songMeta` KV write
that every enriched track also costs. A cold chunk therefore spent 20 × 5 against a ceiling
that charged it none of that, and died partway through its first album. See
`docs/issues/free-plan-subrequest-ceiling.md`.

What does not fit keeps `enriched_at = null` and is enriched on first play instead: a
degraded answer, rather than a chunk that dies.
*/
export const DEFAULT_SCAN_ENRICH_MAX_PER_FOLDER = String(SCAN_ENRICH_MAX_PER_FOLDER);

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

export {MAX_PAGE_SIZE_CEILING} from './subrequests';