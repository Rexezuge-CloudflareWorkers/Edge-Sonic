/**
 * The owner's side of sharing: `getShares`, `createShare`, `updateShare`, `deleteShare`.
 *
 * The public landing page and its stream are [`share-public.test.ts`](./share-public.test.ts);
 * the fixtures are shared with it, because the two files measure one decision from two
 * sides and a second copy of the fixture would be free to drift.
 *
 * ### What is asserted here that a shape test would not
 *
 * - **A foreign share answers `code=70`, never `code=50`** and is left untouched. `50`
 *   would confirm the id exists and turn every mutation into an oracle.
 * - **A failed create leaves no link behind.** The entries are a second statement after the
 *   share row, so a rollback is a decision, not an accident.
 * - **`expires` is epoch milliseconds in and ISO-8601 out**, with the column in seconds.
 * - **The id is random**, so the same selection twice produces two different ids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALBUM_DIR, LIBRARY_ID, ORIGIN, subsonicId } from './helpers/harness';
import type { Harness } from './helpers/harness';
import { createHarness, createShare, entriesOf, HOLOCENE, originTree, payload, sharesOf, SKINNY_LOVE } from './helpers/shares';
import { resetRateLimitForTests } from '../apps/api/src/middleware/rateLimit';

let harness: Harness;

beforeEach(async () => {
  resetRateLimitForTests();
  harness = await createHarness(originTree());
});

afterEach(() => harness.close());

/**
Insert a share owned by somebody else, without going through the endpoints.
*/
async function someoneElsesShare(): Promise<string> {
  await harness.db.db
    .prepare(
      `INSERT INTO users (id, username, username_ci, password_ciphertext, password_iv, key_version, is_admin, is_enabled, scrobbling_enabled, created_at, updated_at)
       VALUES ('u-bob', 'bob', 'bob', 'x', 'y', 1, 0, 1, 1, 0, 0)`,
    )
    .run();
  const id = '11111111-2222-4333-8444-555555555555';
  await harness.db.db
    .prepare(
      'INSERT INTO shares (id, owner_user_id, description, created_at, expires_at, last_visited_at, visit_count) VALUES (?, ?, NULL, 0, NULL, NULL, 0)',
    )
    .bind(id, 'u-bob')
    .run();
  return id;
}

describe('getShares', () => {
  it('is an empty wrapper, not an error, before anything is created', async () => {
    // The shape `getShares` had when it was an `EMPTY_RESULT` entry, kept as the starting
    // point: a client's dashboard must not distinguish "you have no shares" from "the
    // server cannot list them".
    const { body } = await harness.rest('getShares');
    expect(sharesOf(body)).toEqual([]);
  });

  it('returns a created share with its entries, in the order they were named', async () => {
    const created = await createShare(harness);
    expect(created.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
    // Built from the origin that answered the create, not from configuration.
    expect(created.url).toBe(`${ORIGIN}/share/${created.id}`);
    expect(created.username).toBe('ann');
    expect(created.created).toMatch(/Z$/);
    expect(created.visitCount).toBe(0);
    expect(created.lastVisited).toBeUndefined();
    expect(entriesOf(created).map((entry) => entry.id)).toEqual([SKINNY_LOVE, HOLOCENE]);

    const listed = sharesOf((await harness.rest('getShares')).body);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
  });

  it('renders one entry and many as an array in both cases', async () => {
    // The collapse that fails at n=1 and only at n=1. `elList` states it for `share`, and
    // `shareElement` states it again for `entry`, because a single-track share is an
    // ordinary share and a client declaring `List<Child>` throws on a bare object.
    const one = await createShare(harness, { id: SKINNY_LOVE });
    expect(Array.isArray(one.entry)).toBe(true);
    expect(entriesOf(one)).toHaveLength(1);

    await createShare(harness);
    expect(sharesOf((await harness.rest('getShares')).body)).toHaveLength(2);
  });

  it('carries the description and the expiry it was given, converting millis to ISO', async () => {
    const expires = Date.now() + 3_600_000;
    const created = await createShare(harness, { description: 'For the road', expires: String(expires) });
    expect(created.description).toBe('For the road');
    // Truncated to the second by the stored representation, so compare to the second.
    expect(created.expires).toBe(new Date(Math.floor(expires / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  });
});

describe('createShare', () => {
  it('requires at least one id', async () => {
    const { body } = await harness.rest('createShare');
    expect(payload<{ code: number }>(body, 'error').code).toBe(10);
  });

  it('refuses an id that does not resolve, rather than minting a partial share', async () => {
    const { body } = await harness.rest('createShare', { id: `${SKINNY_LOVE},nope` });
    expect(payload<{ code: number }>(body, 'error').code).toBe(70);
    // Nothing was left behind: a failed create must not leave a live link.
    expect(sharesOf((await harness.rest('getShares')).body)).toEqual([]);
  });

  it('refuses an id in a library the caller cannot see, with the same code', async () => {
    // "Not yours" and "does not exist" are one answer on this protocol, so the caller cannot
    // use the create call to learn which libraries hold which paths.
    await harness.db.db.prepare('DELETE FROM user_libraries').run();
    const { body } = await harness.rest('createShare', { id: SKINNY_LOVE });
    expect(payload<{ code: number }>(body, 'error').code).toBe(70);
  });

  it('deduplicates repeated ids, preserving the first occurrence order', async () => {
    const created = await createShare(harness, { id: `${HOLOCENE},${SKINNY_LOVE},${HOLOCENE}` });
    expect(entriesOf(created).map((entry) => entry.id)).toEqual([HOLOCENE, SKINNY_LOVE]);
  });
});

describe('updateShare and deleteShare', () => {
  it('changes the description and clears it with an empty value', async () => {
    const created = await createShare(harness, { description: 'first' });
    await harness.rest('updateShare', { id: created.id, description: 'second' });
    expect(sharesOf((await harness.rest('getShares')).body)[0]?.description).toBe('second');

    // Present but empty means "clear", which is distinct from omitting it.
    await harness.rest('updateShare', { id: created.id, description: '' });
    expect(sharesOf((await harness.rest('getShares')).body)[0]?.description).toBeUndefined();
  });

  it('removes a share from the listing, and its public link with it', async () => {
    const created = await createShare(harness);
    const { body } = await harness.rest('deleteShare', { id: created.id });
    expect((body['subsonic-response'] as { status: string }).status).toBe('ok');
    expect(sharesOf((await harness.rest('getShares')).body)).toEqual([]);
    expect((await harness.fetch(`${ORIGIN}/share/${created.id}`)).status).toBe(404);
  });

  it('answers code=70 — not 50 — for an id that does not exist', async () => {
    const updated = await harness.rest('updateShare', { id: 'nope', description: 'x' });
    expect(payload<{ code: number }>(updated.body, 'error').code).toBe(70);
    const removed = await harness.rest('deleteShare', { id: 'nope' });
    expect(payload<{ code: number }>(removed.body, 'error').code).toBe(70);
  });

  it("answers code=70 for somebody else's share, and leaves it untouched", async () => {
    // `code=50` would confirm the id is real and turn these into an oracle. Both mutations
    // answer the same `70` as an unknown id, and the foreign row is asserted intact.
    const id = await someoneElsesShare();
    const update = await harness.rest('updateShare', { id, description: 'mine now' });
    expect(payload<{ code: number }>(update.body, 'error').code).toBe(70);
    const remove = await harness.rest('deleteShare', { id });
    expect(payload<{ code: number }>(remove.body, 'error').code).toBe(70);

    const row = harness.db.raw.prepare('SELECT owner_user_id, description FROM shares WHERE id = ?').get(id) as
      { owner_user_id: string; description: string | null } | undefined;
    expect(row).toEqual({ owner_user_id: 'u-bob', description: null });
    // And it is not in ann's listing.
    expect(sharesOf((await harness.rest('getShares')).body)).toEqual([]);
  });
});

describe('the credential is not derivable', () => {
  it('is a random UUID rather than an encoding of the songs it names', async () => {
    // The same selection twice must produce two different ids: an id derived from the song
    // ids would be reconstructable by anyone who knows a track, which is the difference
    // between a secret and a link.
    const first = await createShare(harness);
    const second = await createShare(harness);
    expect(second.id).not.toBe(first.id);
    expect(first.id).not.toContain(LIBRARY_ID);
    expect(first.id).not.toContain(subsonicId('s', `${ALBUM_DIR}/01.flac`));
  });
});
