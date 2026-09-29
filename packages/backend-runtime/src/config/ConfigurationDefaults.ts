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
 * The number is a *subrequest* budget, not a politeness knob: one folder costs
 * one `PROPFIND`, and Workers allow 1,000 subrequests per request. 40 leaves
 * headroom for the root probe, the D1 reads, and the client's own `getSong`
 * enrichment, so a chunk can never be the thing that trips the limit.
 */
export const DEFAULT_SCAN_CHUNK_FOLDERS = '40';

/**
Upper bound on a single page of results, matching the protocol's own maximum.
*/
export const DEFAULT_MAX_PAGE_SIZE = '500';

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

An Ogg track costs two range reads, and the default chunk is 20 folders, so 20 keeps a
fully-cold chunk at roughly 800 subrequests against the 1,000 limit. What does not fit
is enriched on first play instead.
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
