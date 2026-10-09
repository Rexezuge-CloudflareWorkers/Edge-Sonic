/**
 * The JSON we answer is decodable by a model of the **schema's** types.
 *
 * ### Why a decoder in the test suite
 *
 * Every assertion in this repository so far has compared our output to a shape *we*
 * wrote down. That cannot see a client failing, because the shape under test and the
 * expectation come from the same reading of the spec — the FLAC fixture and the FLAC
 * reader sharing a wrong byte offset, the Ogg fixture and the Ogg reader sharing a
 * wrong framing assumption, and here: `user.folder` asserted as `[{"id": 0}]` by a test
 * that read the element as a record, while the schema types it as `Array of int`.
 *
 * It shipped. A client whose `User` model is `folder: List<Int>` throws
 * `Expected JsonPrimitive, but had JsonObject as the serialized body of int at path:
 * $.0` on a response that was otherwise correct, and that throw lands in its **login**
 * path — so the report is "failed to connect, please check your credentials" from a
 * server that had answered `ping` and authenticated the request correctly. Nothing in
 * the product could tell a wrong shape from a wrong password.
 *
 * So the expectation here is not a shape of ours: it is a decoder written from the
 * schema, with the same strictness the client uses. A record where the schema says a
 * number is a decode failure here, which is the point.
 *
 * The same defect arrived a second time on `getAlbum`, one level down: the songs were a
 * repeated child of a **record** element and were never declared as a list, so one track
 * rendered `{"song": {...}}` and two rendered `{"song": [{...}, {...}]}` — the shape
 * changing with the data, invisible on a two-track fixture. `getAlbum` also omitted
 * `created`, which the same client requires. Both are decoded here, so the endpoint is
 * held to a client's model rather than to ours.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, ALBUM_DIR, subsonicId } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';

/**
 * Describe a JSON value the way kotlinx.serialization names it in a decoding error, so
 * a failure here reads like the failure a client reports.
 */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'JsonArray';
  if (typeof value === 'object' && value !== null) return 'JsonObject';
  if (typeof value === 'string') return 'JsonPrimitive("a string")';
  return 'JsonPrimitive';
}

/**
 * A strict `Int` decode: a JSON **number** and nothing else.
 *
 * `isLenient` is false in the client, so a quoted number is as fatal as an object. Both
 * matter — the schema's own docs example quotes its folder ids as `"1"`, so "fixing" our
 * output to match that page would break the same client this file exists to protect.
 */
function decodeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`Expected JsonPrimitive, but had ${describeValue(value)} as the serialized body of int at path: $.${path}`);
  }
  return value;
}

/**
 * A strict `Boolean` decode, for the same reason.
 */
function decodeBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Expected JsonPrimitive, but had ${describeValue(value)} as the serialized body of boolean at path: $.${path}`);
  }
  return value;
}

/**
 * `User.folder: List<Int>` — the client passes the server's array through untouched
 * and decodes it as a list of ints, so an object in element 0 is fatal.
 */
function decodeUserFolder(user: unknown): number[] {
  if (typeof user !== 'object' || user === null) throw new Error('Expected a user object.');
  const folder = (user as Record<string, unknown>)['folder'];
  if (!Array.isArray(folder)) throw new Error(`Expected JsonArray, but had ${describeValue(folder)} as the serialized body of user.folder`);
  return folder.map((entry, index) => decodeInt(entry, `user.folder.${index}`));
}

/**
 * `MusicFolder.id: Int` and `name: String`, a record with an integer key.
 */
function decodeMusicFolders(folders: unknown): Array<{ id: number; name: string }> {
  if (typeof folders !== 'object' || folders === null) throw new Error('Expected a musicFolders object.');
  const list = (folders as Record<string, unknown>)['musicFolder'];
  if (!Array.isArray(list))
    throw new Error(`Expected JsonArray, but had ${describeValue(list)} as the serialized body of musicFolders.musicFolder`);
  return list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`Expected JsonObject at path: $.musicFolder.${index}`);
    const record = entry as Record<string, unknown>;
    return { id: decodeInt(record['id'], `musicFolder.${index}.id`), name: String(record['name']) };
  });
}

/**
 * `Album` and `Song` as a client declares them.
 *
 * Written from `dev.zt64.subsonic`'s `Album`/`Song`, not from our reading of the XSD, and
 * reproducing the three properties of it that decide whether a response decodes at all:
 *
 * - **Required fields are those with neither `?` nor a default.** In `Album` that is
 *   `id` and `created`; in `Song` it is `id`, `title` and `artist`. An absent key is
 *   `MissingFieldException`, which is a different failure from a wrong type and is not
 *   caught by checking types.
 * - **`duration` is a strict `Int`.** The client's `SubsonicDurationSerializer` has
 *   `PrimitiveKind.INT` and calls `decodeInt()`, with `isLenient` off — so a quoted
 *   `"251"` is as fatal as an object. Our `songs.duration` column is `INTEGER`, so the
 *   number is right; this pins that it stays a number.
 * - **`created`/`starred` are `kotlin.time.Instant`**, parsed from ISO-8601 text. The
 *   protocol's own format is what `toIso` emits, and the millisecond form
 *   `2024-03-01T00:00:00.000Z` is equally valid — the rule is that it parses as an instant,
 *   not that it has a particular number of digits.
 *
 * The one field deliberately **not** decoded is `genres`. The client wraps it in a
 * `JsonTransformingSerializer` that does `element.jsonArray.map { it.jsonObject["name"]!! }`
 * — an array of objects, with no fallback to the singular `genre` string, so a server
 * sending `"genre": "Indie"` and nothing else is fine (the key is absent, the default
 * applies, the serializer never runs) while one sending `"genres": "Indie"` throws. We
 * emit neither, and the test asserts the key is absent so a future `genres` cannot be
 * added in the wrong shape.
 */
function decodeString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `Expected JsonPrimitive("a string"), but had ${describeValue(value)} as the serialized body of String at path: $.${path}`,
    );
  }
  return value;
}

function decodeRequired<T>(record: Record<string, unknown>, key: string, path: string, decode: (value: unknown, at: string) => T): T {
  if (!(key in record)) {
    // The wording kotlinx.serialization uses, because "the field was not there" and "the
    // field was the wrong shape" are different bugs and the message is how you tell them
    // apart from a bug report.
    throw new TypeError(
      `Field '${key}' is required for type with serial name 'dev.zt64.subsonic.api.model.${path}', but it was missing at path: $.${path}.${key}`,
    );
  }
  return decode(record[key], `${path}.${key}`);
}

function decodeOptional<T>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  decode: (value: unknown, at: string) => T,
): T | undefined {
  return key in record && record[key] !== null ? decode(record[key], `${path}.${key}`) : undefined;
}

/**
 * `SubsonicDurationSerializer`: whole seconds, as a JSON integer.
 */
function decodeDuration(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(
      `Expected JsonPrimitive, but had ${describeValue(value)} as the serialized body of kotlin.time.DurationSeconds at path: $.${path}`,
    );
  }
  return value;
}

/**
 * `kotlin.time.Instant`, from ISO-8601 text.
 */
function decodeInstant(value: unknown, path: string): string {
  const text = decodeString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new TypeError(
      `Field 'created' is required for type with serial name 'kotlin.time.Instant', but it was not an instant at path: $.${path}`,
    );
  }
  return text;
}

interface DecodedSong {
  id: string;
  title: string;
  artist: string;
  duration: number | undefined;
  created: string | undefined;
}

function decodeSong(value: unknown, path: string): DecodedSong {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Expected JsonObject at path: $.${path}`);
  const record = value as Record<string, unknown>;
  return {
    id: decodeRequired(record, 'id', path, decodeString),
    title: decodeRequired(record, 'title', path, decodeString),
    artist: decodeRequired(record, 'artist', path, decodeString),
    duration: decodeOptional(record, 'duration', path, decodeDuration),
    created: decodeOptional(record, 'created', path, decodeInstant),
  };
}

interface DecodedAlbum {
  id: string;
  name: string | undefined;
  songCount: number;
  created: string;
  songs: DecodedSong[];
}

function decodeAlbum(value: unknown, path = 'album'): DecodedAlbum {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Expected JsonObject at path: $.${path}`);
  const record = value as Record<string, unknown>;
  return {
    id: decodeRequired(record, 'id', path, decodeString),
    name: decodeOptional(record, 'name', path, decodeString),
    songCount: decodeOptional(record, 'songCount', path, decodeInt) ?? 0,
    // Required, no default: the field `getAlbum` used to omit.
    created: decodeRequired(record, 'created', path, decodeInstant),
    // `List<Song>` decoded by plain kotlinx.serialization, which does not accept an object
    // where an array belongs. This is the line the reported failure died on.
    songs: decodeRequired(record, 'song', path, (songs, at) => {
      if (!Array.isArray(songs))
        throw new TypeError(
          `Expected JsonArray, but had ${describeValue(songs)} as the serialized body of kotlin.collections.ArrayList at path: $.${at}`,
        );
      return songs.map((song, index) => decodeSong(song, `${at}.${index}`));
    }),
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => {
  harness.close();
});

async function call(endpoint: string, extra: Record<string, string> = {}): Promise<SubsonicBody['subsonic-response']> {
  const { body } = await harness.rest(endpoint, extra);
  return body['subsonic-response'];
}

function field<T>(envelope: SubsonicBody['subsonic-response'], key: string): T {
  return (envelope as Record<string, unknown>)[key] as T;
}

describe('the answers decode as the schema types them', () => {
  it('decodes getUser as a client modelling folder as a list of ints', async () => {
    const envelope = await call('getUser');
    const user = field<Record<string, unknown>>(envelope, 'user');

    // The reported failure, exactly: the folder list is a list of numbers.
    expect(decodeUserFolder(user)).toEqual([0]);
    // And the role booleans are booleans. The schema types them `boolean` while its own
    // docs example quotes them, so this guards a plausible "fix" that would break the
    // same client a second time.
    expect(decodeBoolean(user['scrobblingEnabled'], 'user.scrobblingEnabled')).toBe(true);
    expect(decodeBoolean(user['adminRole'], 'user.adminRole')).toBe(true);
    expect(decodeBoolean(user['streamRole'], 'user.streamRole')).toBe(true);
    expect(decodeBoolean(user['podcastRole'], 'user.podcastRole')).toBe(false);
  });

  it('decodes getMusicFolders as a client modelling the id as an int', async () => {
    const envelope = await call('getMusicFolders');
    expect(decodeMusicFolders(field(envelope, 'musicFolders'))).toEqual([{ id: 0, name: 'Home' }]);
  });

  it('decodes getAlbum as a client modelling song as a list of songs', async () => {
    const envelope = await call('getAlbum', { id: subsonicId('al', ALBUM_DIR) });
    const album = decodeAlbum(field(envelope, 'album'));

    expect(album.name).toBe('For Emma, Forever Ago');
    expect(album.songCount).toBe(2);
    // The field that has no `?` and no default, and that `getAlbum` used to omit.
    expect(album.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(album.songs.map((song) => song.title)).toEqual(['Skinny Love', 'Holocene']);
    expect(album.songs[0]).toMatchObject({ artist: 'Bon Iver', duration: 251 });
    // `genres` is wrapped in a serializer that throws on anything but `[{"name":…}]`, so
    // its absence is the only safe state. Asserted so adding it in the wrong shape fails
    // here rather than on a client.
    expect(field<Record<string, unknown>>(envelope, 'album')).not.toHaveProperty('genres');
  });

  it('decodes getAlbum for a one-track album, which is the case that shipped broken', async () => {
    // The collapse is invisible at n≥2, so the two-track fixture is exactly the fixture
    // that cannot see it. This deletes a track so the album holds one, and asserts the
    // shape the client decodes.
    await harness.db.db
      .prepare('DELETE FROM songs WHERE id = ?')
      .bind(subsonicId('s', `${ALBUM_DIR}/02.flac`))
      .run();
    const envelope = await call('getAlbum', { id: subsonicId('al', ALBUM_DIR) });
    const album = decodeAlbum(field(envelope, 'album'));

    expect(album.songCount).toBe(1);
    expect(album.songs).toHaveLength(1);
    expect(album.songs[0]?.title).toBe('Skinny Love');
  });
});

/**
 * The paired case. A guard nobody has seen fail is not a guard, and the two above would
 * pass forever against a decoder that accepted anything — so each is run against the
 * shape that actually shipped, and must reject it.
 */
describe('the decoder has teeth', () => {
  it('rejects a folder entry that is a record, which is what shipped', () => {
    // Exactly the response that produced "Failed to connect … check your credentials".
    expect(() => decodeUserFolder({ folder: [{ id: 0 }] })).toThrow(
      /had JsonObject as the serialized body of int at path: \$\.user\.folder\.0/,
    );
  });

  it('rejects a quoted folder id, which the schema docs example shows', () => {
    expect(() => decodeUserFolder({ folder: ['0'] })).toThrow(/as the serialized body of int/);
  });

  it('rejects an absent folder key, the way a `!!` on it does', () => {
    expect(() => decodeUserFolder({ username: 'ann' })).toThrow(/Expected JsonArray/);
  });

  it('rejects a musicFolder id that is a library identifier rather than a position', () => {
    expect(() => decodeMusicFolders({ musicFolder: [{ id: 'L1', name: 'Home' }] })).toThrow(
      /had JsonPrimitive\("a string"\) as the serialized body of int/,
    );
  });

  it('rejects a quoted boolean role, which the schema docs example shows', () => {
    expect(() => decodeBoolean('true', 'user.adminRole')).toThrow(/as the serialized body of boolean/);
  });

  it('rejects a one-track album whose song collapsed to an object, which is what shipped', () => {
    // The reported failure, verbatim: `getAlbum` on a single-track album rendered
    // `"song": {...}`, and the client's `Album` model decodes that field as a `List<Song>`.
    const album = { id: 'al:1', name: 'A', songCount: 1, created: '2024-03-01T00:00:00Z', song: { id: 's:1', title: 't', artist: 'a' } };
    expect(() => decodeAlbum(album)).toThrow(
      /Expected JsonArray, but had JsonObject as the serialized body of kotlin\.collections\.ArrayList at path: \$\.album\.song/,
    );
  });

  it('rejects an album with no created, which is the second failure it was masking', () => {
    // A non-nullable field with no default is a *missing-key* failure, not a type failure,
    // so no amount of type checking on the fields that are present would have caught it.
    const album = { id: 'al:1', name: 'A', songCount: 1, song: [{ id: 's:1', title: 't', artist: 'a' }] };
    expect(() => decodeAlbum(album)).toThrow(/Field 'created' is required/);
  });

  it('rejects a song with no artist, which the server could emit and now falls back for', () => {
    // `songToModel` derived `album` from the folder and left `artist` absent in the same
    // object literal. A track at the library root has no folder to read a name from, and
    // the client's `Song.artistName` is non-nullable.
    const song = { id: 's:1', title: 't' };
    expect(() => decodeSong(song, 'album.song.0')).toThrow(/Field 'artist' is required/);
  });

  it('rejects a quoted duration, which a lenient server would emit', () => {
    // `SubsonicDurationSerializer` is `PrimitiveKind.INT` with `isLenient` off.
    expect(() => decodeDuration('251', 'song.duration')).toThrow(/as the serialized body of kotlin\.time\.DurationSeconds/);
  });

  it('rejects a fractional duration, which decodeInt cannot take', () => {
    expect(() => decodeDuration(240.61, 'song.duration')).toThrow(/as the serialized body of kotlin\.time\.DurationSeconds/);
  });

  it('rejects a created that is not an instant', () => {
    expect(() => decodeInstant('last tuesday', 'album.created')).toThrow(/was not an instant/);
  });
});
