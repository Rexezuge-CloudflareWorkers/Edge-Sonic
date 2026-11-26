/**
 * Shared fixtures for the two sharing suites.
 *
 * Split out because the owner-side suite (`test/shares.test.ts`) and the public-surface
 * suite (`test/share-public.test.ts`) are one decision measured from two sides, and a
 * second copy of the fixture would be free to drift from the first — the two would then
 * be asserting different products.
 */
import { ALBUM_DIR, ORIGIN, subsonicId } from './harness';
import type { Harness, SubsonicBody } from './harness';
import type { DavEntry } from './fakeDav';

export const SKINNY_LOVE = subsonicId('s', `${ALBUM_DIR}/01.flac`);
export const HOLOCENE = subsonicId('s', `${ALBUM_DIR}/02.flac`);

export const TRACK = new Uint8Array(4096).map((_, index) => index % 256);

/**
 * A tree whose `01.flac` has real bytes, so a stream can be asserted on content rather
 * than only on a status code.
 */
export function originTree(): Record<string, DavEntry[]> {
  const dir = `/remote.php/dav/files/alice/Music/${ALBUM_DIR}`;
  return {
    [dir]: [
      { path: dir, collection: true, mtime: 1000, etag: '"b"' },
      { path: `${dir}/01.flac`, size: TRACK.length, contentType: 'audio/flac', mtime: 1000, etag: '"c"', body: TRACK },
      { path: `${dir}/02.flac`, size: 8192, contentType: 'audio/flac', mtime: 1000, etag: '"d"' },
    ],
  };
}

export interface WireShare {
  id: string;
  url: string;
  description?: string;
  username: string;
  created: string;
  expires?: string;
  lastVisited?: string;
  visitCount: number;
  entry?: Array<{ id: string; title: string }> | { id: string; title: string };
}

export function payload<T>(body: SubsonicBody, key: string): T {
  return (body['subsonic-response'] as Record<string, unknown>)[key] as T;
}

/**
The `shares` wrapper, with its repeated `share` child always an array.
*/
export function sharesOf(body: SubsonicBody): WireShare[] {
  const wrapper = payload<{ share?: WireShare[] }>(body, 'shares');
  if (wrapper === undefined) throw new Error('shares wrapper is absent');
  return wrapper.share ?? [];
}

/**
The entries of one share, always as an array.
*/
export function entriesOf(share: WireShare): Array<{ id: string; title: string }> {
  if (share.entry === undefined) return [];
  return Array.isArray(share.entry) ? share.entry : [share.entry];
}

export async function createShare(harness: Harness, extra: Record<string, string> = {}): Promise<WireShare> {
  const { body } = await harness.rest('createShare', { id: `${SKINNY_LOVE},${HOLOCENE}`, ...extra });
  const shares = sharesOf(body);
  if (shares.length !== 1) throw new Error(`expected one share, got ${shares.length}`);
  return shares[0]!;
}

/**
The public URL of a share's landing page.
*/
export function sharePageUrl(id: string): string {
  return `${ORIGIN}/share/${encodeURIComponent(id)}`;
}

/**
The public URL of one track inside a share.
*/
export function shareStreamUrl(id: string, songId: string): string {
  return `${sharePageUrl(id)}/stream?song=${encodeURIComponent(songId)}`;
}

export { createHarness, type Harness, type SubsonicBody } from './harness';
