/**
 * A `musicFolderId` is a **position**, and both surfaces that publish it must agree.
 *
 * ### The contract, and why it needed its own file
 *
 * The protocol makes `getUser`'s `folder` list and `getMusicFolders` the same list: an
 * `id` from one is what any other request's `musicFolderId` refers to. So "the id" is
 * a position, and a position means nothing without one agreed order.
 *
 * They did not agree. `getUser` published positions and `getMusicFolders` published
 * library identifiers, so a client that read a folder id from `getUser` — which is what
 * the comment on `respondWithUser` told it to do — got `code 70` from every
 * folder-scoped endpoint. And **no test passed a `musicFolderId` at all**: the existing
 * assertions checked each shape in isolation, so both halves of the contract were green
 * and the round trip between them was never executed. A comment claimed an invariant
 * that nothing measured, which is the same defect as the bound that was never checked.
 *
 * So the two halves are asserted together here, deliberately: the shape assertions
 * alone would pass again on two surfaces that disagree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptData } from '@edge-sonic/backend-data/crypto';
import { NodeDAO } from '@edge-sonic/backend-data/dao';
import { createHarness, TEST_KEY, nowSeconds } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';

/**
A second library, `archive`, so the list has two positions and the order is `slug_ci`
rather than insertion order — `archive` sorts before `home`, so position 0 is the
library created second. A positional id means nothing unless the tests know which
library a position names.
*/
const ARCHIVE = 'L2';

async function addLibrary(harness: Harness, id: string, slug: string, name: string): Promise<void> {
  const secret = await encryptData('dav-password', TEST_KEY);
  const timestamp = nowSeconds();
  await harness.db.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'https://dav.example.com', '/remote.php/dav/files/alice/Music', 'alice', ?, ?, 1, ?, 1, ?, ?)`,
    )
    .bind(id, slug, slug, secret.ciphertext, secret.iv, name, timestamp, timestamp)
    .run();
}

async function grant(harness: Harness, libraryId: string): Promise<void> {
  const user = await harness.db.db.prepare('SELECT id FROM users WHERE username = ?').bind('ann').first<{ id: string }>();
  await harness.db.db
    .prepare('INSERT INTO user_libraries (user_id, library_id, created_at) VALUES (?, ?, ?)')
    .bind(user?.id, libraryId, nowSeconds())
    .run();
}

/**
 * A root folder only this library has. `getIndexes` lists a library's roots, so a root
 * one library has and another does not is how a test proves *which* library answered.
 */
async function addRoot(harness: Harness, libraryId: string, name: string): Promise<void> {
  await new NodeDAO(harness.db.db).upsertMany([{ libraryId, path: name, parentPath: '', name, mtimeMs: 1000, etag: '"z"', depth: 1, isScanned: true }]);
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

/**
Read a typed field out of the envelope.
*/
function field<T>(envelope: SubsonicBody['subsonic-response'], key: string): T {
  return (envelope as Record<string, unknown>)[key] as T;
}

/**
The two published folder lists, read the way a client reads them.
*/
async function publishedLists(): Promise<{ folder: unknown; musicFolder: Array<{ id: unknown; name: string }> }> {
  const user = field<{ folder: unknown }>(await call('getUser'), 'user');
  const folders = field<{ musicFolder: Array<{ id: unknown; name: string }> }>(await call('getMusicFolders'), 'musicFolders');
  return { folder: user.folder, musicFolder: folders.musicFolder };
}

interface IndexesEnvelope {
  error?: { code: number };
  indexes?: { shortcut: Array<{ name: string }> };
}

/**
The folder roots a `getIndexes` call answered with, and the error code if it refused.

Read from the top-level `shortcut` children, where the schema puts them — not from
inside the letter groups, which hold `artist` children. That nesting was the shape
this helper (and the endpoint) used to assert, written from the code rather than the
schema.
*/
async function browse(musicFolderId: string): Promise<{ names: string[]; code: number | undefined }> {
  const envelope = (await call('getIndexes', { musicFolderId })) as IndexesEnvelope;
  return { names: (envelope.indexes?.shortcut ?? []).map((shortcut) => shortcut.name), code: envelope.error?.code };
}

describe('a musicFolderId is a position both surfaces publish identically', () => {
  it('answers the same list, in the same order, from getUser and getMusicFolders', async () => {
    await addLibrary(harness, ARCHIVE, 'archive', 'Archive');
    await grant(harness, ARCHIVE);

    const { folder, musicFolder } = await publishedLists();

    // Deep equality on both, not "resolves to the same library": a regression to
    // library identifiers on either surface changes the values asserted here.
    expect(folder).toEqual([0, 1]);
    expect(musicFolder.map((entry) => entry.id)).toEqual([0, 1]);
    // And the names are the two libraries in `slug_ci` order — `archive` before `home`.
    expect(musicFolder.map((entry) => entry.name)).toEqual(['Archive', 'Home']);
  });

  it('resolves a position published by getMusicFolders back to that library', async () => {
    await addLibrary(harness, ARCHIVE, 'archive', 'Archive');
    await grant(harness, ARCHIVE);
    await addRoot(harness, ARCHIVE, 'Radiohead');
    const { musicFolder } = await publishedLists();

    expect(musicFolder.map((entry) => entry.id)).toEqual([0, 1]);
    for (const entry of musicFolder) {
      const { code, names } = await browse(String(entry.id));
      expect(code, `position ${String(entry.id)}`).toBeUndefined();
      expect(names.length, `position ${String(entry.id)}`).toBeGreaterThan(0);
    }

    // The proof that the two positions named *different* libraries: 0 is `archive`,
    // whose only root is `Radiohead`, and 1 is `home`, whose only root is `Bon Iver`.
    // Without this the loop above would pass on any value that resolved to anything.
    const first = await browse('0');
    expect(first.names).toContain('Radiohead');
    expect(first.names).not.toContain('Bon Iver');
    const second = await browse('1');
    expect(second.names).toContain('Bon Iver');
    expect(second.names).not.toContain('Radiohead');
  });

  it('refuses a position past the end of the list, rather than reading it as an id', async () => {
    await addLibrary(harness, ARCHIVE, 'archive', 'Archive');
    await grant(harness, ARCHIVE);
    expect((await browse('2')).code).toBe(70);
  });

  it('reads only a canonical position, so "00" is not position 0', async () => {
    await addLibrary(harness, ARCHIVE, 'archive', 'Archive');
    await grant(harness, ARCHIVE);
    // `00`, `-1` and `01` are not positions. If they were, a library whose identifier is
    // literally `"00"` would be unreachable through the id that resolves it.
    for (const value of ['00', '-1', '01']) {
      expect((await browse(value)).code, value).toBe(70);
    }
  });

  it('still accepts a library identifier, so a stored id from an older build works', async () => {
    await addLibrary(harness, ARCHIVE, 'archive', 'Archive');
    await grant(harness, ARCHIVE);
    await addRoot(harness, ARCHIVE, 'Radiohead');
    // Each identifier resolves to the same library as the position that names it, which
    // is what makes keeping the fallback safe: the raw id is authorized by the same
    // grant check, so it is a second spelling rather than a second way past it.
    const byId = await browse(ARCHIVE);
    const byPosition = await browse('0');
    expect(byId.code).toBeUndefined();
    expect(byId.names).toEqual(byPosition.names);
    expect(byId.names).toContain('Radiohead');

    const homeById = await browse('L1');
    expect(homeById.names).toEqual((await browse('1')).names);
    expect(homeById.names).toContain('Bon Iver');
  });

  it('refuses a library the caller was not granted, as a position or as an id', async () => {
    await addLibrary(harness, 'L9', 'other', 'Other');
    for (const id of ['L9', '5']) {
      expect((await browse(id)).code, id).toBe(70);
    }
  });

  it('reports a user with no grants as an empty list, not an absent key', async () => {
    expect(await publishedLists()).toEqual({ folder: [0], musicFolder: [{ id: 0, name: 'Home' }] });

    await harness.db.db.prepare('DELETE FROM user_libraries').run();
    // The position list is empty because the grant is, and both surfaces say so in the
    // shape a client iterates: `folder` is `[]` and `musicFolder` is `[]`.
    expect(await publishedLists()).toEqual({ folder: [], musicFolder: [] });
  });
});

describe('the folder list is the same document in every format', () => {
  it('carries the position as a bare number in XML too', async () => {
    await addLibrary(harness, ARCHIVE, 'archive', 'Archive');
    await grant(harness, ARCHIVE);
    const body = await (await harness.fetch(harness.restUrl('getUser', { f: 'xml' }))).text();
    // A record would be `<folder id="0"/>`; the scalar is `<folder>0</folder>`. Both
    // formats come from one node, so asserting one and not the other leaves a
    // serialization free to drift back to the record.
    expect(body).toContain('<folder>0</folder>');
    expect(body).toContain('<folder>1</folder>');
    expect(body).not.toContain('<folder id=');
  });

  it('carries the position as an integer attribute on musicFolder, which is a record', async () => {
    const body = await (await harness.fetch(harness.restUrl('getMusicFolders', { f: 'xml' }))).text();
    // `musicFolder` has a `name` beside the id, so it is a record — the one place a
    // folder id is an object rather than a number.
    expect(body).toContain('<musicFolder id="0" name="Home"/>');
  });
});
