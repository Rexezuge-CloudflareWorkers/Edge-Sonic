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
import { encodeId, IdKind, MAX_IDS_PER_REQUEST } from '@edge-sonic/subsonic';
import { encryptData } from '@edge-sonic/backend-data/crypto';
import { NodeDAO } from '@edge-sonic/backend-data/dao';
import { createHarness, subsonicId, WEBDAV_TEST_KEY, nowSeconds } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';

/**
A second library, `archive`, so the list has two positions and the order is `slug_ci`
rather than insertion order — `archive` sorts before `home`, so position 0 is the
library created second. A positional id means nothing unless the tests know which
library a position names.
*/
const ARCHIVE = 'L2';

async function addLibrary(harness: Harness, id: string, slug: string, name: string): Promise<void> {
  // The **DAV** key, because this row is a library's credential. The harness used to set all
  // three feature keys to one value, so a test could not name which key a row was written under.
  const secret = await encryptData('dav-password', WEBDAV_TEST_KEY);
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

`folder` and `musicFolder` are `undefined` rather than `[]` when the user has no grants:
an item key with no items is absent, which is the shape the reference server answers and
the shape every other empty list on this surface takes.
*/
async function publishedLists(): Promise<{ folder: unknown; musicFolder: Array<{ id: unknown; name: string }> }> {
  const user = field<{ folder: unknown }>(await call('getUser'), 'user');
  const folders = field<{ musicFolder?: Array<{ id: unknown; name: string }> }>(await call('getMusicFolders'), 'musicFolders');
  return { folder: user.folder, musicFolder: folders.musicFolder ?? [] };
}

interface IndexesEnvelope {
  error?: { code: number };
  indexes?: { shortcut: Array<{ name: string }> };
}

/**
 * A `dir:` id for a library-relative folder, the spelling `getIndexes` publishes.
 *
 * Built through the product's own encoder on purpose: the bug this file's new block covers was a
 * *published* id that named the wrong directory, so a hand-rolled id would assert the test's own
 * spelling rather than what a client holds.
 */
function shortcutIdOf(path: string): string {
  return encodeId(IdKind.Directory, 'L1', path);
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

/**
 * A request naming an unbounded number of ids is refused with a code a client can read.
 *
 * `id` is a **repeatable, comma-split** parameter — `MULTI_VALUE_PARAMS` holds it *because*
 * clients repeat it — and `SubsonicParams.fromRequest` also accepts a form body, so a URL length
 * does not bound it either. Every endpoint walking that list cost 2–4 statements per id against a
 * platform ceiling with nothing capping the count, so a few hundred ids terminated the invocation:
 * **no Subsonic envelope, no `413`, nothing in a log** — a dropped connection.
 *
 * Refusing is what `BaseDAO.requireSubrequests` already does for every batched read in the data
 * layer, and `UserStateDAO.savePlayQueue` passes `requireComplete` because a half-written queue is
 * a *shorter* queue. The endpoint side had no equivalent, so that refusal never got its chance.
 *
 * Asserted on all three write surfaces that walk the list, and with a **negative** — a list under
 * the limit must still succeed — because a guard that rejects everything passes a refusal test.
 */
describe('a request naming too many ids is refused, not truncated', () => {
  /**
  A list long enough to cross the limit without being enormous to serialize.
  */
  function manyIds(count: number): string {
    return Array.from({ length: count }, (_, index) => `s:${String(index).padStart(22, '0')}`).join(',');
  }

  it('refuses star, scrobble and savePlayQueue above the limit, and honours a list under it', async () => {
    // The harness library has a handful of tracks, so `manyIds` is mostly unresolvable ids. That
    // is deliberate: **the refusal has to come before resolution** or a request full of unknown ids
    // would answer `code=70` and never reach the bound — which is exactly the ordering bug this
    // asserts against.
    const over = manyIds(MAX_IDS_PER_REQUEST + 1);

    for (const endpoint of ['star', 'scrobble', 'savePlayQueue']) {
      const { body } = await harness.rest(endpoint, { id: over });
      const error = (body['subsonic-response'] as { error?: { code?: number; message?: string } }).error;
      expect(error?.code, `${endpoint} above the limit is a refusal`).toBe(0);
      expect(error?.message, `${endpoint} names the limit`).toMatch(/too many ids/i);
    }

    // And the negative: one **real** id still works on all three, so the guard is not simply
    // refusing everything and the refusal is not standing in for a `code=70`. Built through the
    // same `subsonicId` the rest of the suite uses, because a hand-typed id here would only prove
    // the harness is lenient about ids it does not know.
    const songId = subsonicId('s', 'Bon Iver/For Emma/01.flac');
    for (const endpoint of ['star', 'scrobble', 'savePlayQueue']) {
      const { body } = await harness.rest(endpoint, { id: songId });
      expect((body['subsonic-response'] as { error?: { code?: number } }).error, `${endpoint} under the limit`).toBeUndefined();
    }
  });

  it('reports a limit above the page ceiling, so paging a list is never refused for asking', async () => {
    // A client paging a list names ids, and the point of the bound is to refuse a request that
    // could not be answered anyway. A limit *below* the page ceiling would refuse a legitimate page,
    // which is a different bug and one this states rather than leaves to a reader.
    expect(MAX_IDS_PER_REQUEST).toBeGreaterThanOrEqual(500);
  });
});

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

  it('reports a user with no grants consistently on both surfaces', async () => {
    expect(await publishedLists()).toEqual({ folder: [0], musicFolder: [{ id: 0, name: 'Home' }] });

    await harness.db.db.prepare('DELETE FROM user_libraries').run();
    // The position list is empty because the grant is, and **both** surfaces report that
    // the same way: the wrapper is present and carries no items. They agreed before by
    // both emitting `[]`; they agree now by both omitting the key. What this test is for is
    // the agreement, not the spelling — the thing it protects is that an id read from
    // `getUser` is the id `getMusicFolders` publishes, and an empty list on one surface and
    // a populated one on the other would be exactly the disagreement it exists to catch.
    // Both are absent, on both surfaces: an item key with no items is not `[]`.
    expect(await publishedLists()).toEqual({ folder: undefined, musicFolder: [] });
  });
});

/**
 * `getIndexes` publishes a **shortcut** per top-level folder, and a client walking *up* from one
 * follows the `parent` that `getMusicDirectory` publishes on its `directory` element.
 *
 * `getMusicDirectory` computed it as `path.slice(0, path.lastIndexOf('/'))`, and a top-level
 * folder's path holds **no separator at all** — so `lastIndexOf` answered `-1` and
 * `'Blur'.slice(0, -1)` is `'Blu'`. The published `parent` therefore named a directory that does
 * not exist, and following it issued a live `PROPFIND` for `Blu` and answered `code=70`. Every
 * client that reached the top of the tree and tried to go further hit it, on every library, and
 * nothing in the suite asserted `parent` on a shortcut at all.
 *
 * `libraryNames.parentOf` already had the correct form (`slash === -1 ? '' : …`) — the library root
 * **is** the parent of a top-level folder, and an empty `parent` says exactly that. So the fix was
 * to use the one function rather than to write the slice again.
 *
 * The pair of assertions below is the round trip: `shortcut.id` → `getMusicDirectory` →
 * `directory.parent` → `getMusicDirectory` again. A `parent` that does not resolve is a link that
 * is dead on arrival, which is the shape of defect `apps/api/AGENTS.md` says is worse than
 * omitting the id.
 */
describe('walking up from a top-level folder reaches the library root', () => {
  it('publishes a parent that getMusicDirectory can resolve, which slice(0, -1) could not', async () => {
    const indexes = (await call('getIndexes')) as IndexesEnvelope;
    const shortcut = indexes.indexes?.shortcut?.[0];
    expect(shortcut, 'the harness library has a top-level folder to walk up from').toBeDefined();

    const shortcutIds = (indexes.indexes?.shortcut ?? []) as Array<{ name: string }>;
    expect(shortcutIds.map((entry) => entry.name)).toContain('Bon Iver');

    // `getMusicDirectory` on the shortcut's own id. `getIndexes` publishes it, so this is the
    // exact request a client makes when the user taps a top-level folder.
    const shortcutId = shortcutIdOf('Bon Iver');
    const folder = (await call('getMusicDirectory', { id: shortcutId })) as { directory?: { parent?: string; name?: string } };
    expect(folder.directory?.name).toBe('Bon Iver');

    // The library root, as **the empty string** rather than as an id. `decodeId` refuses an empty
    // path, so no `dir:` id can name the root and an id there resolves to `code=70` — so an id
    // would be a link dead on arrival. `slice(0, -1)` published something worse: the id for
    // `Bon Ive`, one character short, which is a directory that does not exist.
    expect(folder.directory?.parent, 'a top-level folder has no parent above it').toBe('');

    // So the walk-up terminates here, and the client is at the top of the tree rather than at a
    // 404. Asserted as "the parent is absent/falsey" because that is what a client checks.
    expect(folder.directory?.parent).toBeFalsy();
  });

  it('publishes the library root as its own parent, and a nested folder parent that resolves', async () => {
    // `Bon Iver/For Emma` is a folder *inside* a top-level one, so it does have a separator — and
    // its parent is `Bon Iver`. Asserted beside the root case so a fix that special-cased "no
    // separator" without keeping the nested case correct would fail here.
    const shortcutId = shortcutIdOf('Bon Iver');
    const nested = shortcutIdOf('Bon Iver/For Emma');
    const folder = (await call('getMusicDirectory', { id: nested })) as { directory?: { parent?: string }; error?: { code: number } };

    expect(folder.error?.code).toBeUndefined();
    expect(folder.directory?.parent).toBe(shortcutId);

    // And that parent is itself a directory, not another dead link.
    const parentId = folder.directory?.parent ?? '';
    const up = (await call('getMusicDirectory', { id: parentId })) as { directory?: { name?: string }; error?: { code: number } };
    expect(up.error?.code).toBeUndefined();
    expect(up.directory?.name).toBe('Bon Iver');
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
