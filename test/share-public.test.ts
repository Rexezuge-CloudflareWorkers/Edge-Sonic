/**
 * The public sharing surface: `/share/:id` and `/share/:id/stream`.
 *
 * These two routes read a share and nothing else, and neither is on `/rest`'s
 * authentication path. Three properties follow from "the id is the credential", and each is
 * asserted below because each is invisible to a shape test:
 *
 * 1. **Unknown, malformed, and expired ids are one 404 with one body.** Distinguishing them
 *    would confirm that an id was once real.
 * 2. **The owner's grant is re-checked at read time.** The entries are frozen; the
 *    permission is not, so a revoked library empties the share rather than 404-ing it.
 * 3. **The visit counter counts page views.** The landing page increments it; the stream
 *    does not; an expired page does not because it 404s.
 *
 * The owner endpoints are [`shares.test.ts`](./shares.test.ts); the fixtures are shared.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from './helpers/harness';
import {
  createHarness,
  createShare,
  entriesOf,
  HOLOCENE,
  originTree,
  sharePageUrl,
  shareStreamUrl,
  sharesOf,
  SKINNY_LOVE,
  TRACK,
} from './helpers/shares';
import { resetRateLimitForTests } from '../apps/api/src/middleware/rateLimit';

let harness: Harness;
let originalFetch: typeof fetch;

beforeEach(async () => {
  resetRateLimitForTests();
  harness = await createHarness(originTree());
  originalFetch = fetch;
  globalThis.fetch = harness.dav.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  harness.close();
});

/**
The owner's view of the first (only) share, which is where a write becomes visible.
*/
async function onlyShare(): Promise<ReturnType<typeof sharesOf>[number]> {
  return sharesOf((await harness.rest('getShares')).body)[0]!;
}

describe('the landing page', () => {
  it('serves the share, and counts the visit', async () => {
    const created = await createShare(harness, { description: 'Mixtape' });
    const response = await harness.fetch(sharePageUrl(created.id));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Mixtape');
    expect(html).toContain(`/share/${created.id}/stream?song=${encodeURIComponent(SKINNY_LOVE)}`);

    const after = await onlyShare();
    expect(after.visitCount).toBe(1);
    expect(after.lastVisited).toMatch(/Z$/);

    await harness.fetch(sharePageUrl(created.id));
    expect((await onlyShare()).visitCount).toBe(2);
  });

  it('answers one 404 for unknown, malformed and expired ids alike', async () => {
    const expired = await createShare(harness, { expires: String(Date.now() - 60_000) });
    for (const id of ['does-not-exist', '../../etc/passwd', expired.id]) {
      const response = await harness.fetch(sharePageUrl(id));
      expect(response.status, id).toBe(404);
      expect(await response.text(), id).toBe('Not found.');
    }
    // The expired share is still the owner's — it expired, it was not deleted — but its
    // page counted nothing.
    expect((await onlyShare()).visitCount).toBe(0);
  });

  it('escapes every value on the page, since a filename is attacker-controlled', async () => {
    const created = await createShare(harness);
    await harness.db.db.prepare('UPDATE songs SET title = ? WHERE id = ?').bind('<script>alert(1)</script>', SKINNY_LOVE).run();
    const html = await (await harness.fetch(sharePageUrl(created.id))).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('drops a track whose row was deleted, keeping the rest', async () => {
    const created = await createShare(harness);
    await harness.db.db.prepare('DELETE FROM songs WHERE id = ?').bind(SKINNY_LOVE).run();

    const html = await (await harness.fetch(sharePageUrl(created.id))).text();
    expect(html).toContain('Holocene');
    expect(html).not.toContain('Skinny Love');
    // The link itself still exists: the truth is that a track is gone, not that the share is.
    expect(sharesOf((await harness.rest('getShares')).body)).toHaveLength(1);
  });

  it('drops a track whose library grant was revoked, on both surfaces', async () => {
    const created = await createShare(harness);
    await harness.db.db.prepare('DELETE FROM user_libraries').run();

    const html = await (await harness.fetch(sharePageUrl(created.id))).text();
    expect(html).toContain('This share has no playable tracks.');
    // The owner's own listing applies the same grant filter, so the two views cannot
    // disagree about what the share reaches.
    expect(entriesOf(await onlyShare())).toEqual([]);
  });

  it('never puts the capability in a Referer or a shared cache', async () => {
    const created = await createShare(harness, { id: SKINNY_LOVE });
    const response = await harness.fetch(sharePageUrl(created.id));
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the stream', () => {
  it('serves the bytes and forwards Range verbatim', async () => {
    const created = await createShare(harness);
    const whole = await harness.fetch(shareStreamUrl(created.id, SKINNY_LOVE));
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(TRACK);
    expect(whole.headers.get('content-type')).toContain('audio/flac');

    const ranged = await harness.fetch(shareStreamUrl(created.id, SKINNY_LOVE), {}, { headers: { Range: 'bytes=0-15' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-15/${TRACK.length}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toHaveLength(16);
  });

  it('does not count a play as a visit', async () => {
    // `visitCount` is a count of page views. A player fetching ranges is not a view, and
    // counting it would turn the field into a play counter with a different name.
    const created = await createShare(harness);
    await harness.fetch(shareStreamUrl(created.id, SKINNY_LOVE));
    await harness.fetch(shareStreamUrl(created.id, HOLOCENE), {}, { headers: { Range: 'bytes=0-1' } });
    expect((await onlyShare()).visitCount).toBe(0);
  });

  it('refuses a song id the share does not hold, and a missing one', async () => {
    const created = await createShare(harness, { id: SKINNY_LOVE });
    // `HOLOCENE` is a real song, but not one of this share's entries — the entry list is
    // the allow-list, so a valid song id outside it is still a 404.
    expect((await harness.fetch(shareStreamUrl(created.id, HOLOCENE))).status).toBe(404);
    expect((await harness.fetch(`${sharePageUrl(created.id)}/stream`)).status).toBe(404);
  });

  it('refuses an expired share', async () => {
    const expired = await createShare(harness, { id: SKINNY_LOVE, expires: String(Date.now() - 1000) });
    expect((await harness.fetch(shareStreamUrl(expired.id, SKINNY_LOVE))).status).toBe(404);
  });

  it('drops a track whose grant was revoked instead of serving it', async () => {
    // The entries are frozen; the authorization is not. This is the assertion that makes
    // that sentence a property rather than a comment.
    const created = await createShare(harness, { id: SKINNY_LOVE });
    await harness.db.db.prepare('DELETE FROM user_libraries').run();
    expect((await harness.fetch(shareStreamUrl(created.id, SKINNY_LOVE))).status).toBe(404);
  });
});
