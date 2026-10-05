/**
 * Media annotation: `star`, `unstar`, `setRating`, `scrobble`.
 *
 * All four are writes with an **empty** success envelope, and all four accept the
 * same three id parameters (`id`, `albumId`, `artistId`) because the protocol
 * reuses the same shape across them.
 */
import { decodeId, ErrorCode, IdKind, SubsonicError } from '@edge-sonic/subsonic';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';

/**
 * The `(param, type)` pairs the protocol accepts for an annotation call.
 *
 * Mapping the *parameter* to the stored `item_type` here — once — is what keeps
 * `star?id=<song>` and `getStarred2` agreeing on what was starred. Getting this
 * wrong is silent: a star stored under the wrong type simply never appears again.
 */
const ID_PARAMS: readonly (readonly [string, 'song' | 'album' | 'artist'])[] = [
  ['id', 'song'],
  ['albumId', 'album'],
  ['artistId', 'artist'],
];

/**
 * Collect the ids a client asked to annotate, validating each against this user.
 *
 * An id for a library the caller cannot see is a `code=70` *before* anything is
 * written, so a partial call cannot leave half its ids starred.
 *
 * ### Why this is `async`, and why that is the whole point
 *
 * The grant check used to be `void context.libraries.requireForUser(...)`. A `void`ed
 * promise **starts** the check and discards it, and `requireForUser` throws
 * `NotFoundError` — so the rejection surfaced as an unhandled rejection while the write
 * it was guarding went ahead. `stars`, `ratings`, `bookmarks`, `play_counts` and
 * `now_playing` have a foreign key to `users` and **none to `songs`**, so a caller with no
 * grant on another library could write rows naming ids in it; the read paths filter those
 * back out, so nothing reported the pollution either. It is the same defect the play
 * queue's `savePlayQueue` had, and the same rule: an unawaited authorization check is not
 * a check.
 */
async function collectTargets(context: RestContext): Promise<Array<{ id: string; itemType: 'song' | 'album' | 'artist' }>> {
  const targets: Array<{ id: string; itemType: 'song' | 'album' | 'artist' }> = [];
  for (const [param, itemType] of ID_PARAMS) {
    for (const raw of context.params.ids(param)) {
      const decoded = decodeId(raw);
      // Awaited, before anything is written: a forged library id fails here.
      await context.libraries.requireForUser(context.user.id, decoded.libraryId);
      targets.push({ id: raw, itemType });
    }
  }
  if (targets.length === 0) {
    throw new SubsonicError(ErrorCode.MissingParameter, 'Required parameter is missing: id, albumId or artistId');
  }
  return targets;
}

async function star(context: RestContext): Promise<EnvelopeResponse> {
  for (const target of await collectTargets(context)) {
    await context.annotations.star(context.user.id, target.id, target.itemType);
  }
  return respond(context);
}

async function unstar(context: RestContext): Promise<EnvelopeResponse> {
  for (const target of await collectTargets(context)) {
    await context.annotations.unstar(context.user.id, target.id, target.itemType);
  }
  return respond(context);
}

/**
 * `setRating` — 1..5, or 0 to clear.
 *
 * Ratings below 1 or above 5 are **clamped** rather than rejected. A client sending
 * `rating=9` is a client bug, and refusing the whole call loses the user's intent
 * where clamping records it.
 */
async function setRating(context: RestContext): Promise<EnvelopeResponse> {
  const raw = context.params.int('rating', NaN);
  if (!Number.isFinite(raw)) throw new SubsonicError(ErrorCode.MissingParameter, 'Required parameter is missing: rating');
  const rating = Math.min(5, Math.max(0, raw));
  for (const target of await collectTargets(context)) {
    if (rating === 0) {
      // There is no protocol call to clear a rating, so 0 is implemented as a
      // delete-by-replacement: storing 0 would make a "no rating" item look rated.
      await context.annotations.setRating(context.user.id, target.id, target.itemType, 0);
      continue;
    }
    await context.annotations.setRating(context.user.id, target.id, target.itemType, rating);
  }
  return respond(context);
}

/**
 * `scrobble` — a play.
 *
 * `submission=true` (the default) counts a real play; `submission=false` is the
 * "now playing" notification, which is how `getNowPlaying` gets populated. Only the
 * `true` case increments the play count, and only the `true` case is worth a D1
 * write for a count.
 *
 * Multiple `id`/`time` pairs are accepted; `times` is a comma-joined variant some
 * clients send.
 */
async function scrobble(context: RestContext): Promise<EnvelopeResponse> {
  const ids = [...context.params.ids('id'), ...context.params.ids('songId')];
  if (ids.length === 0) throw new SubsonicError(ErrorCode.MissingParameter, 'Required parameter is missing: id');

  const submission = context.params.bool('submission', true);
  const playerName = context.params.get('p') ?? null;
  const playerId = context.params.get('i') ?? null;

  for (const id of ids) {
    const decoded = decodeId(id, IdKind.Song);
    // Awaited. `void` here started the grant check and discarded its rejection, so the
    // play it was guarding was recorded for a library the caller cannot see — see
    // `collectTargets` for why that is invisible rather than merely wrong.
    await context.libraries.requireForUser(context.user.id, decoded.libraryId);
    if (submission) {
      // `PlayCountDAO.recordPlay` rather than an annotation method — see
      // `packages/backend-data/src/dao/playCounts.ts`: incrementing and overwriting the same
      // table is the distinction that file exists to keep legible.
      await context.playCounts.recordPlay(context.user.id, id);
    }
  }

  // One row for the whole batch, holding the first id: `getNowPlaying` reports a
  // user's current track, and writing one row per scrobbled id would have the last
  // one win arbitrarily.
  //
  // The id is already decoded and authorized above, so it is not decoded again here —
  // the second `decodeId` was the same throwing call on the same bytes with its result
  // discarded.
  await context.annotations.setNowPlaying({
    userId: context.user.id,
    username: context.username,
    songId: ids[0],
    playerName,
    playerId,
  });

  return respond(context);
}

const annotationEndpoints = { star, unstar, setRating, scrobble };

export { annotationEndpoints };
