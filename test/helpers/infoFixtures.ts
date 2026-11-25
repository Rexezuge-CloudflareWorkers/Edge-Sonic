/**
Byte and row fixtures for the info endpoints, built from the container layouts.
*/
import { SongDAO } from '@edge-sonic/backend-data/dao';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { ALBUM_DIR, DERIVED_MARKER, LIBRARY_ID, subsonicId } from './harness';
import type { DavEntry } from './fakeDav';
import type { Harness } from './harness';

export const ROOT = '/remote.php/dav/files/alice/Music';

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function concat(...parts: readonly (readonly number[])[]): number[] {
  return parts.flat();
}

/**
 * A FLAC file whose `VORBIS_COMMENT` carries the given entries.
 */
export function flacWithComments(comments: readonly string[]): Uint8Array {
  const body = concat(u32le(0), u32le(comments.length), ...comments.map((entry) => concat(u32le(ascii(entry).length), ascii(entry))));
  const header = (type: number, length: number, last: boolean): number[] => [
    last ? type | 0x80 : type,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  ];
  return Uint8Array.from(
    concat(
      ascii('fLaC'),
      header(0, 34, false),
      Array.from({ length: 34 }, () => 0),
      header(4, body.length, true),
      body,
      [0xff, 0xf8],
    ),
  );
}

/**
 * An origin with the fixture album's two tracks, where track 01 carries `comments`.
 */
export function originWithComments(comments: readonly string[]): Record<string, DavEntry[]> {
  const track = flacWithComments(comments);
  return {
    [ROOT]: [
      { path: ROOT, collection: true, mtime: 1000, etag: '"root"' },
      { path: `${ROOT}/Bon Iver`, collection: true, mtime: 1000, etag: '"a"' },
      { path: `${ROOT}/${ALBUM_DIR}`, collection: true, mtime: 1000, etag: '"b"' },
      { path: `${ROOT}/${ALBUM_DIR}/01.flac`, size: track.length, contentType: 'audio/flac', mtime: 1000, etag: '"c"', body: track },
      { path: `${ROOT}/${ALBUM_DIR}/02.flac`, size: track.length, contentType: 'audio/flac', mtime: 1000, etag: '"d"', body: track },
    ],
  };
}

/**
 * A tagged song row in the harness's library, written through the production DAO so the
 * `_ci` twins and the enrichment stamp are what a real scan would have left.
 */
export async function addSong(
  harness: Harness,
  path: string,
  seed: { artist: string; album: string; genre?: string },
  libraryId = LIBRARY_ID,
): Promise<string> {
  const songs = new SongDAO(harness.db.db, DERIVED_MARKER);
  const id = subsonicId('s', path, libraryId);
  await songs.upsertFileFacts([
    {
      id,
      libraryId,
      path,
      dirPath: path.slice(0, path.lastIndexOf('/')),
      name: path.slice(path.lastIndexOf('/') + 1),
      size: 4096,
      mtimeMs: 1000,
      contentType: 'audio/flac',
      suffix: 'flac',
    },
  ]);
  await songs.applyMetadata(id, {
    title: 'Track',
    artist: seed.artist,
    album: seed.album,
    albumArtist: seed.artist,
    genre: seed.genre ?? null,
    duration: 120,
    bitrate: 900,
    readerVersion: READER_VERSION,
  });
  return id;
}

/**
 * A library the caller was **not** granted, for the "id in an invisible library" assertion.
 */
export async function addHiddenLibrary(harness: Harness, id: string): Promise<void> {
  await harness.db.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv,
        key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'https://dav.example.com', '/music', 'alice', 'cipher', 'iv', 1, ?, 1, 1, 1)`,
    )
    .bind(id, id, id, id)
    .run();
}
