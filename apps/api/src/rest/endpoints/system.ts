/**
 * System endpoints: connectivity, licensing, and scan control.
 */
import { el, elList, scanStatusElement, successResponse } from '@edge-sonic/subsonic';
import { isAdvancing } from '@edge-sonic/backend-services/index';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { musicFolderElementsFor } from './libraries';

/**
Every handler here returns a finished envelope.
*/
type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

/**
 * Resolve the one library a call that has no `musicFolderId` applies to.
 *
 * `getScanStatus` and `startScan` have no folder parameter in the protocol, so
 * they apply to "the" library. With several granted, the first by slug is chosen —
 * deterministic, and the admin UI is where a real choice belongs. Returning `null`
 * rather than throwing is deliberate: a client polling before an operator has
 * configured anything should see "not scanning", not a failure.
 */
async function resolveSingleLibrary(context: RestContext): Promise<LibraryRow | null> {
  const libraries = await context.libraries.listForUser(context.user.id);
  return libraries.length > 0 ? libraries[0] : null;
}

/**
 * `ping` — connectivity and credential check.
 *
 * The most-called endpoint in the protocol: every client hits it on connect and on
 * every settings screen. It is therefore the cheapest possible success path — no D1
 * read beyond the authentication lookup, no library enumeration — and it returns
 * an **empty** envelope, because the spec defines it that way and some clients
 * treat an unexpected child element as a protocol violation.
 */
async function ping(context: RestContext): Promise<EnvelopeResponse> {
  return respond(context, null);
}

/**
 * `getLicense` — always valid, and never expires.
 *
 * Edge-Sonic is free software with no premium tier, so there is nothing to
 * enforce. A client uses this to decide whether to show an "upgrade" nag, and an
 * expired license is the one thing that would make a working server look broken.
 */
async function getLicense(context: RestContext): Promise<EnvelopeResponse> {
  return respond(context, el('license', { valid: true, email: 'admin@edge-sonic.invalid', licenseExpires: '2099-12-31T00:00:00Z' }));
}

/**
 * `getMusicFolders` — the libraries this user may see.
 *
 * Filtered by the `user_libraries` grant, so a user never learns a library
 * exists that they have not been given. The `id` is the **position** in that list
 * rather than the library's own key, because the schema types it as an `integer`
 * and every other endpoint's `musicFolderId` resolves through it. `./libraries`
 * publishes the identical list on `getUser`, so the two cannot disagree about what
 * position 1 is.
 */
async function getMusicFolders(context: RestContext): Promise<EnvelopeResponse> {
  const folders = await musicFolderElementsFor(context, context.user.id);
  return respond(context, elList('musicFolders', 'musicFolder', {}, folders));
}

/**
 * `getScanStatus` — **and the thing that advances the scan.**
 *
 * Polling this is what drives the chunked scan, which is why it is not a passive
 * read: with no client polling, the scan does not advance. See `ScanService` for
 * why that is acceptable and what the upgrade path is.
 *
 * ### A poll that returns is a poll that succeeded
 *
 * This call does real work, so a client that asks "how far along am I?" is doing
 * more of the scan — and that shaped how long it can take. A chunk is bounded by a
 * subrequest ceiling and a wall-clock deadline, and it **returns early** when it
 * reaches either, leaving the rest of the frontier for the next poll.
 *
 * That matters for how a client should read a timeout. Before the bounds, a chunk
 * on a slow origin ran ~88 s while clients gave up at ~45 s, so the scan appeared
 * stalled and backing off genuinely stopped it. A bounded chunk returns inside its
 * deadline, so "still scanning" is an answer and not a symptom. A client that does
 * back off should keep polling rather than lengthen its interval: polling is the
 * scan.
 *
 * Neither bound is visible in the protocol's `scanStatus` element, which carries
 * only `scanning` and `count`. Which bound ended a chunk is on `ChunkResult.stoppedBy`,
 * which the operator surface reads through `POST /user/libraries/:id/scan/step`.
 *
 * `count` is the protocol's single progress number, and it reports folders
 * scanned — the number that actually moves. Reporting song count instead would
 * need a full library count on every poll.
 */
async function getScanStatus(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveSingleLibrary(context);
  if (library === null) return respond(context, scanStatusElement({ scanning: false, count: 0 }));
  const result = await context.scan.step(library);
  return respond(context, scanStatusElement({ scanning: isAdvancing(result.status), count: result.scanned }));
}

/**
 * `scanning` answers "will more work happen if I poll again", which is the only question
 * it can usefully answer to a client — see `isAdvancing` in `backend-services`, and the
 * defect it records: a retried scan reported `scanning: false`, every client read that
 * as *stop polling*, and the library was never scanned.
 *
 * The reason a scan failed is not on this surface. `scanStatus` carries only `scanning`
 * and `count`, and a reason here would be a non-standard attribute some strict clients
 * reject. It is on `scan_state.last_error`, read through the operator API.
 */

/**
`startScan` — probes the root and seeds the frontier. The work happens on later polls.
*/
async function startScan(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveSingleLibrary(context);
  if (library === null) return respond(context, scanStatusElement({ scanning: false, count: 0 }));
  const result = await context.scan.start(library);
  return respond(context, scanStatusElement({ scanning: isAdvancing(result.status), count: result.scanned }));
}

/**
 * The extensions a client may be told about, kept beside the endpoint that reports them.
 *
 * ### Why this is a list of finished nodes and not a list of names
 *
 * Because an entry is not a name. The protocol's shape is
 * `{"name": "transcodeOffset", "versions": [1]}` — and `versions` is an **array**, which
 * `el`'s attribute map cannot hold, since its values are scalars. So a list of names would
 * need a builder that silently could not express the shape it was promising, and the
 * mistake would surface as a malformed entry on the wire rather than as a type error. A
 * list of `ElementNode`s makes adding an extension a type-checked edit, and the empty
 * default is the honest answer today.
 *
 * Empty, and asserted empty in `test/endpoints.test.ts`. A list that drifts from what the
 * product actually implements is worse than an empty one: a client reads it as a promise,
 * calls the extension, and gets `code=70` from a server that just said it would work. So
 * adding an extension is a change **here and in the test**, which is the point of naming
 * the set rather than inlining `[]` in the handler.
 */
const OPEN_SUBSONIC_EXTENSIONS: readonly ElementNode[] = [];

/**
 * `getOpenSubsonicExtensions` — the extensions this server supports, which is none.
 *
 * ### Why it answers `[]` and not `code=70`
 *
 * Because the two are different statements. `code=70` says "this server does not do that",
 * and the protocol uses it for endpoints that are *absent*. This one is **present** and
 * reports **nothing**, and the spec is explicit that a server supporting no extensions
 * returns an empty list — `openSubsonicExtensions` is a required field. It was listed
 * under `UNIMPLEMENTED` with the reason "no extensions are advertised", which is a
 * category error: the endpoint is implemented, its answer is empty.
 *
 * The difference is not cosmetic. This is the **capability-discovery** call, so a client
 * that receives a failure rather than a list has learned nothing it can act on. The
 * `openSubsonic: true` flag carried in every envelope is what sends clients looking for
 * exactly this answer.
 *
 * An empty array rather than an absent key, for the reason the rest of this codebase uses
 * `elList`: a client doing `response.openSubsonicExtensions.length` throws on `undefined`
 * and renders nothing on `[]`.
 *
 * Empty is also the *truthful* answer rather than a dodge. The extensions the spec defines
 * are `apiKeyAuthentication`, `transcoding`, `songLyrics`, `sonicSimilarity`,
 * `transcodeOffset`, `formPost`, `playbackReport`, `indexBasedQueue`, `template`,
 * `topSongsByArtistId` and `getPodcastEpisode` — none of which this server implements. We
 * authenticate with `u` + `t` rather than with an `apiKey` parameter, so advertising
 * `apiKeyAuthentication` would be a claim about a credential path we do not have. A client
 * that reads this list and adapts to it is being told the truth, which is the entire
 * purpose of the endpoint.
 */
async function getOpenSubsonicExtensions(context: RestContext): Promise<EnvelopeResponse> {
  return respond(context, openSubsonicExtensionsPayload());
}

/**
 * The payload, as a function of nothing.
 *
 * Separate from the handler because the protocol requires this endpoint to be reachable
 * **without credentials**, and the dispatcher's unauthenticated path has no `RestContext`
 * to hand a handler. One implementation behind two callers rather than an element literal
 * written twice: a copy is how two answers would drift, and the drift would be invisible
 * because both shapes are well-formed envelopes.
 */
function openSubsonicExtensionsPayload(): ElementNode {
  // Built by hand rather than with `elList`, and the reason is the *shape*.
  //
  // The protocol's JSON puts a **bare array** at this key:
  // `"openSubsonicExtensions": [ { "name": ..., "versions": [...] } ]`
  // — not an object wrapping a repeated child. `elList(name, listKey, …)` produces the
  // wrapped form, because that is the shape every other Subsonic list uses, so using it
  // here would answer a different question than the one asked.
  //
  // `array: true` is what makes the serializer emit a JSON array, and it also carries the
  // XML guarantee that the element renders even when empty — which is the "an absent value
  // is a value" rule, and the reason a client reading `.length` gets `0` rather than
  // throwing on `undefined`.
  return {
    name: 'openSubsonicExtensions',
    array: true,
    ...(OPEN_SUBSONIC_EXTENSIONS.length > 0 && { children: [...OPEN_SUBSONIC_EXTENSIONS] }),
  };
}

/**
 * `tokenInfo` — who the presented credentials belong to.
 *
 * A client holding a stored token calls this to check that the token still works, which is
 * why it exists as an endpoint rather than as a client-side cache: the server is the only
 * party that can say. The answer is the username the dispatcher **already authenticated**,
 * so nothing here is a new authorization decision — there is no id to forge and no
 * credential re-read.
 *
 * `username` is an **attribute**, so this is a record in JSON and an attribute in XML; a
 * child element would give `{"username": {"#text": ...}}` and break a client reading it as
 * the string the schema declares. The value is the `u` the caller sent, which is the same
 * identity every other endpoint already treats as the caller's — `getBookmarks` reports it
 * as `username` beside each bookmark.
 */
async function tokenInfo(context: RestContext): Promise<EnvelopeResponse> {
  return respond(context, el('tokenInfo', { username: context.username }));
}

const systemEndpoints = { ping, getLicense, getMusicFolders, getScanStatus, startScan, getOpenSubsonicExtensions, tokenInfo };

export {
  systemEndpoints,
  ping,
  getLicense,
  getMusicFolders,
  getScanStatus,
  startScan,
  getOpenSubsonicExtensions,
  openSubsonicExtensionsPayload,
  tokenInfo,
  OPEN_SUBSONIC_EXTENSIONS,
};
