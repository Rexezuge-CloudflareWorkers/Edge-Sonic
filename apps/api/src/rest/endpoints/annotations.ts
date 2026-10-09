/**
 * Media annotation: `star`, `unstar`, `setRating`, `scrobble`.
 *
 * All four are writes with an **empty** success envelope, and all four accept the
 * same three id parameters (`id`, `albumId`, `artistId`) because the protocol
 * reuses the same shape across them.
 */
import { decodeId, ErrorCode, MAX_IDS_PER_REQUEST, SubsonicError } from '@edge-sonic/subsonic';
import type { RestContext } from '../context';
import { respond } from '../respond';
import { librariesForId } from './libraries';
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

  // **Refused, not truncated.** `star`, `unstar` and `setRating` all route through here, and each
  // id costs 2 statements (a lookup, a grant check) against a platform ceiling. The list is
  // comma-split and repeatable — `id` is in `MULTI_VALUE_PARAMS` because clients do repeat it — and
  // it arrives in a form body too, so no URL length bounds it. Nothing here did, so a few hundred
  // ids terminated the invocation with no envelope at all. `subsonic/idLimits.ts` says why the
  // number is what it is.
  const songIds = ID_PARAMS.filter(([, itemType]) => itemType === 'song').flatMap(([param]) => context.params.ids(param));
  if (songIds.length > MAX_IDS_PER_REQUEST) {
    throw new SubsonicError(ErrorCode.Generic, `Too many ids in one request: ${songIds.length} (limit ${MAX_IDS_PER_REQUEST}).`);
  }
  // Resolved in **one batched read**, and the length checked against what was sent — `star` with
  // one unknown id must be `code=70` for that id, not a partial success that wrote the rest.
  const songs = await context.songs.listIdsAcrossLibraries(songIds);
  if (songs.length !== songIds.length) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');

  const authorized = new Map<string, string>();
  for (const song of songs) {
    await context.libraries.requireForUser(context.user.id, song.library_id);
    authorized.set(song.id, song.id);
  }

  for (const [param, itemType] of ID_PARAMS) {
    for (const raw of context.params.ids(param)) {
      if (itemType === 'song') {
        // Resolved through the row: a short id carries no library to decode, so the row is
        // how the library is found. The batch above already resolved and authorized every id, so
        // this is a lookup in a map rather than a second statement — and the `undefined` cannot
        // fire, because the length check above refused anything that did not resolve.
        const canonical = authorized.get(raw);
        if (canonical === undefined) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
        targets.push({ id: canonical, itemType });
        continue;
      }
      const decoded = decodeId(raw);
      // Awaited, before anything is written: a forged library id fails here. And it goes
      // through `librariesForId` rather than straight to `requireForUser`, because an album or
      // artist id carries the **sentinel** — it names a group, not one library — and asking
      // `requireForUser` for it would refuse every album star on a multi-library user. The
      // union it returns is still only the caller's grants, so a forged id names nothing that
      // is not already visible.
      await librariesForId(context, decoded.libraryId);
      targets.push({ id: raw, itemType });
    }
  }
  if (targets.length === 0) {
    throw new SubsonicError(ErrorCode.MissingParameter, 'Required parameter is missing: id, albumId or artistId');
  }
  return targets;
}

/**
 * Distinct targets, in first-seen order.
 *
 * `id` is a repeatable, comma-split parameter, so a client that sends `id=a&id=a` — or `id=a,a` —
 * names one target twice, and `collectTargets` returns it twice. `star` is `INSERT OR REPLACE` so
 * the stored answer was already a set, but the **statements** were not: each duplicate cost another
 * write, and the starred list is the slowest request a client makes already.
 *
 * Keyed by item type as well as id, because `star?id=<song>&albumId=<the same string>` is two
 * different targets that happen to share an id — and `stars` is keyed `(user_id, item_id, item_type)`
 * for the same reason.
 */
function distinctTargets(
  targets: ReadonlyArray<{ id: string; itemType: 'song' | 'album' | 'artist' }>,
): Array<{ id: string; itemType: 'song' | 'album' | 'artist' }> {
  const seen = new Set<string>();
  const unique: Array<{ id: string; itemType: 'song' | 'album' | 'artist' }> = [];
  for (const target of targets) {
    const key = `${target.itemType}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

async function star(context: RestContext): Promise<EnvelopeResponse> {
  for (const target of distinctTargets(await collectTargets(context))) {
    await context.annotations.star(context.user.id, target.id, target.itemType);
  }
  return respond(context);
}

async function unstar(context: RestContext): Promise<EnvelopeResponse> {
  for (const target of distinctTargets(await collectTargets(context))) {
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
  for (const target of distinctTargets(await collectTargets(context))) {
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

  // **Refused up front, not truncated.** This costs 3 statements per id (a lookup, a grant check,
  // a play count) against a platform ceiling, and nothing bounded the loop — so a client naming a
  // few hundred ids spent past it and the runtime terminated the invocation with no envelope and
  // nothing in a log. A `413` is the answer a client can act on, and refusing is what
  // `BaseDAO.requireSubrequests` already does for every batched read in the data layer; this is the
  // same refusal at the edge of it. See `subsonic/idLimits.ts` for why it is a constant and not
  // configuration.
  if (ids.length > MAX_IDS_PER_REQUEST) {
    throw new SubsonicError(ErrorCode.Generic, `Too many ids in one request: ${ids.length} (limit ${MAX_IDS_PER_REQUEST}).`);
  }

  // Resolved once, in **one batched read**, rather than one lookup per id. `findBySongId` is
  // individually authorized below — the point of the loop is the grant check, which is per id and
  // per library — but the *lookup* does not have to be. `listIdsAcrossLibraries` returns rows in the
  // caller's order, so `ids` and the resolved rows line up index for index.
  const resolved = await context.songs.listIdsAcrossLibraries(ids);

  const submission = context.params.bool('submission', true);
  const playerName = context.params.get('p') ?? null;
  const playerId = context.params.get('i') ?? null;

  for (const id of resolved) {
    // Awaited. `void` here started the grant check and discarded its rejection, so the
    // play it was guarding was recorded for a library the caller cannot see — see
    // `collectTargets` for why that is invisible rather than merely wrong.
    await context.libraries.requireForUser(context.user.id, id.library_id);
    if (submission) {
      // `PlayCountDAO.recordPlay` rather than an annotation method — see
      // `packages/backend-data/src/dao/playCounts.ts`: incrementing and overwriting the same
      // table is the distinction that file exists to keep legible.
      // The row's own id, so the count names the row rather than the client's spelling.
      await context.playCounts.recordPlay(context.user.id, id.id);
    }
  }

  // **A missing song is still `code=70`, and it is checked against what was sent.** The loop above
  // iterates what resolved, so an id with no row would otherwise be silently skipped — which is the
  // difference between "recorded the plays" and "recorded the plays that exist". The batch omits
  // unresolvable ids by design (`songIdLookup.ts`), so the count is what decides.
  if (resolved.length !== ids.length) {
    throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
  }

  // One row for the whole batch, holding the first id: `getNowPlaying` reports a
  // user's current track, and writing one row per scrobbled id would have the last
  // one win arbitrarily. The loop above already resolved and authorized it, so this is
  // the first resolved row rather than another lookup.
  await context.annotations.setNowPlaying({
    userId: context.user.id,
    username: context.username,
    songId: resolved[0]?.id ?? ids[0],
    playerName,
    playerId,
  });

  return respond(context);
}

const annotationEndpoints = { star, unstar, setRating, scrobble };

export { annotationEndpoints };
