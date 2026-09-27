/**
 * System endpoints: connectivity, licensing, and scan control.
 */
import { el, elList, scanStatusElement, successResponse } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';

/** Every handler here returns a finished envelope. */
type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

/** Display name, falling back to the slug. */
function libraryName(library: LibraryRow): string {
  const name = library.display_name?.trim();
  return name && name.length > 0 ? name : library.slug;
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
  return libraries.length > 0 ? libraries[0]! : null;
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
 * exists that they have not been given. The ids are library ids, which is what
 * every other endpoint's `musicFolderId` resolves through.
 */
async function getMusicFolders(context: RestContext): Promise<EnvelopeResponse> {
  const libraries = await context.libraries.listForUser(context.user.id);
  return respond(context, elList('musicFolders', {}, libraries.map((library) => el('musicFolder', { id: library.id, name: libraryName(library) }))));
}

/**
 * `getScanStatus` — **and the thing that advances the scan.**
 *
 * Polling this is what drives the chunked scan, which is why it is not a passive
 * read: with no client polling, the scan does not advance. See `ScanService` for
 * why that is acceptable and what the upgrade path is.
 *
 * `count` is the protocol's single progress number, and it reports folders
 * scanned — the number that actually moves. Reporting song count instead would
 * need a full library count on every poll.
 */
async function getScanStatus(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveSingleLibrary(context);
  if (library === null) return respond(context, scanStatusElement({ scanning: false, count: 0 }));
  const result = await context.scan.step(library);
  return respond(context, scanStatusElement({ scanning: result.status === 'scanning', count: result.scanned }));
}

/** `startScan` — probes the root and seeds the frontier. The work happens on later polls. */
async function startScan(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveSingleLibrary(context);
  if (library === null) return respond(context, scanStatusElement({ scanning: false, count: 0 }));
  const result = await context.scan.start(library);
  return respond(context, scanStatusElement({ scanning: result.status === 'scanning', count: result.scanned }));
}

const systemEndpoints = { ping, getLicense, getMusicFolders, getScanStatus, startScan };

export { systemEndpoints, ping, getLicense, getMusicFolders, getScanStatus, startScan };
