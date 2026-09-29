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
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from './helpers/harness';
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
  if (!Array.isArray(list)) throw new Error(`Expected JsonArray, but had ${describeValue(list)} as the serialized body of musicFolders.musicFolder`);
  return list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`Expected JsonObject at path: $.musicFolder.${index}`);
    const record = entry as Record<string, unknown>;
    return { id: decodeInt(record['id'], `musicFolder.${index}.id`), name: String(record['name']) };
  });
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => {
  harness.close();
});

async function call(endpoint: string): Promise<SubsonicBody['subsonic-response']> {
  const { body } = await harness.rest(endpoint);
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
});

/**
 * The paired case. A guard nobody has seen fail is not a guard, and the two above would
 * pass forever against a decoder that accepted anything — so each is run against the
 * shape that actually shipped, and must reject it.
 */
describe('the decoder has teeth', () => {
  it('rejects a folder entry that is a record, which is what shipped', () => {
    // Exactly the response that produced "Failed to connect … check your credentials".
    expect(() => decodeUserFolder({ folder: [{ id: 0 }] })).toThrow(/had JsonObject as the serialized body of int at path: \$\.user\.folder\.0/);
  });

  it('rejects a quoted folder id, which the schema docs example shows', () => {
    expect(() => decodeUserFolder({ folder: ['0'] })).toThrow(/as the serialized body of int/);
  });

  it('rejects an absent folder key, the way a `!!` on it does', () => {
    expect(() => decodeUserFolder({ username: 'ann' })).toThrow(/Expected JsonArray/);
  });

  it('rejects a musicFolder id that is a library identifier rather than a position', () => {
    expect(() => decodeMusicFolders({ musicFolder: [{ id: 'L1', name: 'Home' }] })).toThrow(/had JsonPrimitive\("a string"\) as the serialized body of int/);
  });

  it('rejects a quoted boolean role, which the schema docs example shows', () => {
    expect(() => decodeBoolean('true', 'user.adminRole')).toThrow(/as the serialized body of boolean/);
  });
});
