/**
 * Shares: `getShares`, `createShare`, `updateShare`, `deleteShare`.
 *
 * ### The id is the credential, and these four endpoints are the owner's side of it
 *
 * Creating a share mints an unguessable id (`ShareService`), and the *public* landing page
 * is a separate surface (`src/share/routes.ts`) so that `/rest`'s authentication never has
 * to grow a capability branch. These four are still owner-scoped: `getShares` lists only the
 * caller's own, and every mutation answers `code=70` — not `code=50` — for another user's
 * share, because `50` would confirm the id exists and turn the endpoint into an oracle.
 *
 * ### Millis in, seconds stored, ISO out
 *
 * The protocol's `expires` parameter is epoch **milliseconds** and its response fields are
 * ISO-8601. The database stores epoch seconds. Both conversions happen here, in one named
 * helper, so a missing factor of 1000 cannot hide in a service that also stores timestamps.
 */
import { elList, ErrorCode, MAX_IDS_PER_REQUEST, shareElement, SubsonicError } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { songToModel, toIso } from '../mappers';
import type { ShareView } from '@edge-sonic/backend-services/share';

/**
Epoch milliseconds from the protocol, as epoch seconds, or `null` for "never".
*/
function expiresAtFrom(context: RestContext, name: string): number | null | undefined {
  if (!context.params.has(name)) return undefined;
  const milliseconds = context.params.optionalInt(name, { min: 0 });
  // A present-but-unparseable `expires` is treated as absent rather than as "never expires":
  // the two are different promises, and silently minting a permanent link from a typo is the
  // worse one.
  if (milliseconds === undefined) return undefined;
  return Math.floor(milliseconds / 1000);
}

/**
 * The one builder for a `share` element, from a service view.
 *
 * The URL is built from the request's origin rather than from configuration: this server
 * may be reached under a custom domain, an Access-protected hostname or a preview URL, and a
 * link minted from a configured base would be wrong on two of the three. The protocol has no
 * "base URL" setting, so the origin that answered the create is the honest one.
 */
async function shareElements(context: RestContext, views: readonly ShareView[]): Promise<ElementNode[]> {
  const origin = new URL(context.request.url).origin;
  const albumsFor = context.albumsForScope(await context.libraries.listForUser(context.user.id));
  return views.map(({ share, songs }) =>
    shareElement({
      id: share.id,
      url: `${origin}/share/${share.id}`,
      description: share.description ?? undefined,
      username: context.username,
      created: toIso(share.created_at) ?? '',
      expires: toIso(share.expires_at),
      lastVisited: toIso(share.last_visited_at),
      visitCount: share.visit_count,
      entries: songs.map((song) => songToModel(song, albumsFor)),
    }),
  );
}

async function getShares(context: RestContext): Promise<EnvelopeResponse> {
  const views = await context.shares.list(context.user.id);
  return respond(context, elList('shares', 'share', {}, await shareElements(context, views)));
}

/**
 * `createShare` — freeze the named songs into a new capability.
 *
 * `id` is required and names songs, not a share. The service refuses an id it cannot resolve
 * *or* one in a library the caller cannot see, and both are `code=70`: "not yours" and "does
 * not exist" already look identical everywhere else in this protocol.
 */
async function createShare(context: RestContext): Promise<EnvelopeResponse> {
  const songIds = context.params.ids('id');
  if (songIds.length === 0) {
    throw new SubsonicError(ErrorCode.MissingParameter, 'Required parameter is missing: id');
  }
  if (songIds.length > MAX_IDS_PER_REQUEST) {
    throw new SubsonicError(ErrorCode.Generic, `Too many ids in one request: ${songIds.length} (limit ${MAX_IDS_PER_REQUEST}).`);
  }

  const created = await context.shares.create(
    context.user.id,
    songIds,
    context.params.get('description') || null,
    expiresAtFrom(context, 'expires') ?? null,
  );
  if (created === null) throw new SubsonicError(ErrorCode.NotFound, 'Share could not be created from those ids.');
  return respond(context, elList('shares', 'share', {}, await shareElements(context, [created])));
}

/**
 * `updateShare` — change the description and/or expiry.
 *
 * `undefined` means "leave it", which is why a sent-but-empty `description` clears it rather
 * than being read as absent. The response is the empty success, as the protocol specifies;
 * returning the share would be an undated claim in a spec that says nothing is returned.
 */
async function updateShare(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const updated = await context.shares.update(context.user.id, id, {
    description: context.params.has('description') ? context.params.get('description') || null : undefined,
    expiresAt: expiresAtFrom(context, 'expires'),
  });
  if (updated === null) throw new SubsonicError(ErrorCode.NotFound, 'Share not found.');
  return respond(context, null);
}

async function deleteShare(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const removed = await context.shares.remove(context.user.id, id);
  if (!removed) throw new SubsonicError(ErrorCode.NotFound, 'Share not found.');
  return respond(context, null);
}

const shareEndpoints = { getShares, createShare, updateShare, deleteShare };

export { shareEndpoints };
