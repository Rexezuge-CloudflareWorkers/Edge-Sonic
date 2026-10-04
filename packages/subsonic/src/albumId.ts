/**
 * How an album's **id** names it.
 *
 * ### The one thing this file has to get right, and it is not the base64
 *
 * An album id's payload is the `path` half of an encoded id, and `decodeId` runs
 * `normalizeRelativePath` over that string. So the payload cannot hold `.`, `..`, an empty
 * segment, a control character or a `%XX` — and a raw album name can hold every one of them,
 * because `(`/`)` and `&` and `,` appear throughout this product's own live library and a title
 * may hold anything at all. An album name written into the payload literally is an id `decodeId`
 * refuses, and an id that cannot be decoded is an album a client can never come back to:
 * `getAlbum` answers `code=70`, `getCoverArt` serves the placeholder, and nothing says why.
 *
 * So the segments are base64url — an alphabet of `A-Za-z0-9-_`, none of which the path validator
 * can object to.
 *
 * ### Three payload shapes, and why there is no sentinel
 *
 * `a/<album>`, `aa/<artist>/<album>` and `an/<album>`. The third means "no album artist", and it
 * is a **separate tag** rather than a missing segment or a placeholder string:
 * `normalizeRelativePath` refuses an empty segment, so the shape this started as —
 * `aa/<album>/` — is rejected before anything gets to read it, and every album on a library with
 * no `ALBUMARTIST` would answer `code=70`. A sentinel string standing in for NULL has the mirror
 * problem: it is a value a real tag could collide with. Neither shape is expressible as another.
 *
 * ### Why `folder` keeps its own id kind
 *
 * `ALBUM_GROUP_BY=folder` mints `IdKind.Album` with the directory path — byte for byte the id this
 * server minted before an album's identity became configurable, which is what makes that setting a
 * genuine no-op for an existing deployment rather than a migration: its ids, its stars and its
 * clients' cached ids are the same strings they were.
 *
 * The tag keys need `IdKind.AlbumKey` because a payload of `<b64>/<b64>` is itself a valid relative
 * path, so a folder key encoded the same way could not be told from a tag key and one library's
 * `Artist/Album` folder would decode as some album's key. The prefix is what says which reading
 * applies, so the two coexist without a heuristic and a decode can refuse rather than guess.
 *
 * What an album *is* — and therefore what the key is — is `albumKey.ts`. The split is because they
 * fail differently: a key is derived from a row this server read, and never parsed out of anything
 * untrusted, while a payload here is a string a client sent.
 */
import { decodeId, encodeId, IdKind } from './ids';
import { albumKeySpec } from './albumKey';
import type { AlbumGroupingValue, AlbumKeyRow } from './albumKey';

function encodeSegment(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeSegment(segment: string): string | null {
  try {
    const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // A malformed id is `code=70`, not a `500`: the payload came from a client, and a forged one
    // must not be able to reach the error mapper as anything but "not found".
    return null;
  }
}

/**
 * A row's album id, or `undefined` when it has no album to point at.
 *
 * One construction for every publisher — `songToModel`, `songToChild`, `groupAlbums`, the search
 * grouping — because an album id minted two ways is two ids for one album, and a client that
 * drilled one and got the other back has no way to tell which is stale.
 *
 * `undefined` under a tag grouping for a row with no album tag, and that is deliberate: the row is
 * absent from the album lists (they filter on `album_ci`), so minting it an id would let a client
 * drill into an album nothing else can reach. Under `folder` it always has an id, since the
 * directory is the album.
 */
function albumIdOf(row: AlbumKeyRow, libraryId: string, grouping: AlbumGroupingValue): string | undefined {
  if (grouping !== 'folder' && (row.album_ci === null || row.album_ci === '')) return undefined;
  return encodeAlbumKey(libraryId, albumKeySpec(row, grouping).string);
}

/**
 * Encode an album key as a protocol id.
 *
 * A **new kind** for the tag groupings and the original kind for `folder` — see the module header
 * for why both, and why the folder form is byte-identical to what this server used to mint.
 */
function encodeAlbumKey(libraryId: string, key: string): string {
  const separator = key.indexOf(':');
  const tag = separator === -1 ? '' : key.slice(0, separator);
  const rest = separator === -1 ? '' : key.slice(separator + 1);
  if (tag === 'folder') return encodeId(IdKind.Album, libraryId, rest);
  if (tag === 'album') return encodeId(IdKind.AlbumKey, libraryId, `a/${encodeSegment(rest)}`);
  if (tag === 'aa') {
    // **Split on the first colon of the remainder**, exactly as `trySpecFromKey` does — not on the
    // key's parts. `aa:album` is "no album artist" and `aa:artist:album` is one, and reading the
    // artist out of `parts[1]` instead makes the first shape mean artist=`album`: the encoder
    // writes an empty second segment, `normalizeRelativePath` refuses it, and every album on a
    // library with no `ALBUMARTIST` answers `code=70` to an id this server minted. The two halves
    // of this grammar have to read it the same way, which is the same reason `trySpecFromKey` is
    // not exported for a second caller to re-derive.
    const cut = rest.indexOf(':');
    if (cut === -1) return encodeId(IdKind.AlbumKey, libraryId, `an/${encodeSegment(rest)}`);
    return encodeId(IdKind.AlbumKey, libraryId, `aa/${encodeSegment(rest.slice(0, cut))}/${encodeSegment(rest.slice(cut + 1))}`);
  }
  return encodeId(IdKind.AlbumKey, libraryId, `k/${encodeSegment(key)}`);
}

/**
 * Read an album-key payload back into the key it carries.
 *
 * `null` for anything that is not a well-formed payload, and the strictness is the contract: these
 * values reach SQL as bound parameters, so a caller that trusted a forged payload would be
 * querying a column the key never named. It is also what turns a malformed id into `code=70` at
 * the call site rather than a masked `500`.
 */
function decodeAlbumKey(payload: string): string | null {
  const segments = payload.split('/');
  const read = (segment: string): string | null => {
    const value = decodeSegment(segment);
    return value === null || value === '' ? null : value;
  };
  if (segments.length === 2 && segments[0] === 'a') {
    const album = read(segments[1]);
    return album === null ? null : `album:${album}`;
  }
  if (segments.length === 2 && segments[0] === 'an') {
    const album = read(segments[1]);
    return album === null ? null : `aa:${album}`;
  }
  if (segments.length === 3 && segments[0] === 'aa') {
    const artist = read(segments[1]);
    const album = read(segments[2]);
    return artist === null || album === null ? null : `aa:${artist}:${album}`;
  }
  if (segments.length === 2 && segments[0] === 'k') {
    const raw = read(segments[1]);
    return raw === null ? null : raw;
  }
  return null;
}

/**
 * Either kind of album id, resolved to the key it names.
 *
 * The folder form resolves **through the directory** rather than straight to `folder:<dir>`,
 * because under a tag grouping a directory is not an album — it is *part of* one, and the part a
 * pre-existing star points at is not the album the lists publish. Returning the directory's own key
 * would resolve such an id to a single-directory album, which is two answers to "what album is
 * this" for one id, one of them reachable only from a starred list.
 *
 * @param resolveDirRows The rows in a directory, for a folder id. Supplied by the caller because
 *   this module has no database: it knows what a key *means*, not how to find rows.
 * @returns The resolved key, or `null` when the id is not an album id or names nothing.
 */
async function resolveAlbumId(
  raw: string,
  grouping: AlbumGroupingValue,
  resolveDirRows: (dirPath: string) => Promise<readonly AlbumKeyRow[]>,
): Promise<string | null> {
  let decoded: ReturnType<typeof decodeId>;
  try {
    decoded = decodeId(raw);
  } catch {
    return null;
  }
  if (decoded.kind === IdKind.AlbumKey) return decodeAlbumKey(decoded.path);
  if (decoded.kind !== IdKind.Album) return null;
  const rows = await resolveDirRows(decoded.path);
  return rows.length === 0 ? null : albumKeySpec(rows[0], grouping).string;
}

export { albumIdOf, encodeAlbumKey, decodeAlbumKey, resolveAlbumId };

export {type AlbumKeySpec} from './albumKey';