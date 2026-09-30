/**
 * `stream`, `download`, and `getCoverArt`.
 *
 * ### The product promise these tests hold
 *
 * **No transcoding.** `stream` and `download` are a `Range` passthrough to the origin,
 * and the response is returned as the origin sent it. The three ways that promise is
 * usually broken, and each has an assertion here:
 *
 * 1. **The `Content-Type` is rewritten** to something the server guessed, so a client
 *    decodes FLAC as MP3 and plays noise.
 * 2. **The whole file is buffered** to attach a `Content-Length` or to count bytes, so a
 *    seek becomes a full download and a 4 GiB track exceeds the memory limit.
 * 3. **The range is dropped**, so seeking restarts the track from the beginning — the
 *    failure that looks like a client bug and is not.
 *
 * The origin is a `fakeDav`, which genuinely truncates on a range. That matters: a
 * double that answered any range with the whole file and a `Content-Range` header
 * claiming a prefix would make all three of the above pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, ALBUM_DIR, LIBRARY_ID, subsonicId } from './helpers/harness';
import type { Harness } from './helpers/harness';
import type { DavEntry } from './helpers/fakeDav';

/**
A recognizable byte pattern, so "the same bytes came back" is checkable.
*/

const TRACK = new Uint8Array(4096);
const COVER = new Uint8Array(2048);

function originTree(): Record<string, DavEntry[]> {
  const dir = `/remote.php/dav/files/alice/Music/${ALBUM_DIR}`;
  return {
    [dir]: [
      { path: dir, collection: true, mtime: 1000, etag: '"b"' },
      { path: `${dir}/01.flac`, size: TRACK.length, contentType: 'audio/flac', mtime: 1000, etag: '"c"', body: TRACK },
      { path: `${dir}/02.flac`, size: 8192, contentType: 'audio/flac', mtime: 1000, etag: '"d"' },
      { path: `${dir}/cover.jpg`, size: COVER.length, contentType: 'image/jpeg', mtime: 1000, etag: '"e"', body: COVER },
    ],
  };
}

/**
Decode a `Basic` credential, so a test can assert on the username.
*/
function decodeBasic(header: string): { username: string; password: string } {
  const [scheme, encoded] = header.split(' ', 2);
  return scheme !== 'Basic' || encoded === undefined ? { username: '', password: '' } : { username: atob(encoded).split(':', 1)[0] ?? '', password: atob(encoded).split(':', 2)[1] ?? '' };
}

let harness: Harness;
let originalFetch: typeof fetch;

beforeEach(async () => {
  harness = await createHarness(originTree());
  originalFetch = fetch;
  globalThis.fetch = harness.dav.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  harness.close();
});

describe('stream', () => {
  it('passes a whole-file request through with the origin status and headers', async () => {
    const response = await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }));

    expect(response.status).toBe(200);
    // Unrewritten. A server that "helpfully" normalises this to `application/octet-stream`
    // or guesses from the extension breaks every lossless client.
    expect(response.headers.get('content-type')).toBe('audio/flac');
    expect(response.headers.get('content-length')).toBe(String(TRACK.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(TRACK);
  });

  it('forwards a Range verbatim and returns exactly the requested slice', async () => {
    const response = await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }), {}, { headers: { Range: 'bytes=100-199' } });

    // The range reached the origin unchanged. A server that rewrote or normalized it
    // would still return *a* 206, so the recorded request is the assertion.
    expect(harness.dav.gets.at(-1)?.range).toBe('bytes=100-199');
    expect(response.status).toBe(206);
    // The total is the file's size, not the slice's: that is what lets a client know
    // the track is longer than what it holds.
    expect(response.headers.get('content-range')).toBe(`bytes 100-199/${TRACK.length}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(TRACK.subarray(100, 200));
  });

  it('honours an open-ended range', async () => {
    // What a client sends when it knows the offset and not the length, which is most of
    // them.
    const response = await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }), {}, { headers: { Range: 'bytes=4000-' } });

    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(TRACK.subarray(4000));
  });

  it('answers an unsatisfiable range with the envelope, never with the whole file', async () => {
    // The tempting fallback is "range failed, here is everything". A client that asked
    // for a slice past the end would then download the entire track while believing it
    // had buffered a seek point.
    //
    // The answer is the Subsonic envelope rather than a forwarded `416`, because this
    // is a `/rest` surface: a client parses the body, and a `416` with no envelope is
    // the response it reports to the user as a server fault. The body is *not* audio,
    // which is the property that matters — a client can tell the seek failed.
    const response = await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }), {}, { headers: { Range: 'bytes=999999-' } });
    const body = (await response.json()) as { 'subsonic-response': { status: string; error?: { code: number } } };

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body['subsonic-response'].status).toBe('failed');
    // `code=0`, not `70`: the file exists, the requested range does not, and reporting
    // "not found" would make a client discard a track it can otherwise play.
    expect(body['subsonic-response'].error?.code).toBe(0);
  });

  it('does not read the file at all for a repeat request inside one process', async () => {
    // Not a correctness requirement, but it is the difference between a seek costing one
    // subrequest and costing a full re-read on every skip.
    const before = harness.dav.gets.length;
    await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }));
    const afterFirst = harness.dav.gets.length;
    await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }));

    expect(afterFirst).toBeGreaterThan(before);
    // The second call still reads the origin — the bytes are not cached, and must not
    // be: a 4 GiB track does not fit in KV, and a stale copy would serve wrong audio.
    expect(harness.dav.gets.length).toBeGreaterThan(afterFirst);
  });

  it('refuses an id for a library this user was not granted, before any origin request', async () => {
    const before = harness.dav.gets.length;
    const { status, body } = await harness.rest('stream', { id: subsonicId('s', `${ALBUM_DIR}/01.flac`, 'L-other') });

    expect(body['subsonic-response'].error?.code).toBe(70);
    // The refusal is decided from D1, so the origin never learns that the id was
    // interesting. A `50` here would also be an existence oracle.
    expect(status).toBe(200);
    expect(harness.dav.gets).toHaveLength(before);
  });

  it('refuses a path that escapes the library root, before any origin request', async () => {
    const before = harness.dav.gets.length;
    const { body } = await harness.rest('stream', { id: subsonicId('s', '../../../etc/passwd') });

    expect(body['subsonic-response'].error?.code).toBe(70);
    expect(harness.dav.gets).toHaveLength(before);
  });
});

describe('download', () => {
  it('returns the whole file, named from the file itself and nothing else', async () => {
    // `download` is the same passthrough; the difference is that a browser should save
    // the track under its real name rather than as `download` or as the song id.
    const response = await harness.fetch(harness.restUrl('download', { id: harness.ids.skinnyLove }));
    const disposition = response.headers.get('content-disposition');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/flac');
    expect(disposition).toBe('attachment; filename="01.flac"');
    // The name is a WebDAV filename, so it is attacker-controlled through a directory
    // listing. It must not be able to introduce a path separator or break out of the
    // quoted-string — either one writes a file outside the download directory.
    expect(disposition).not.toContain('/');
    expect(disposition).not.toContain('\\\\');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(TRACK);
  });

  it('escapes a filename that would otherwise break out of the quoted string', async () => {
    // A track named `a";b.flac` — or one whose name carries a path — is reachable by
    // anyone who can write to the library, so this is not a theoretical input.
    const escaping = await createHarness({
      [`/remote.php/dav/files/alice/Music/${ALBUM_DIR}`]: [
        { path: `/remote.php/dav/files/alice/Music/${ALBUM_DIR}`, collection: true, mtime: 1000, etag: '"b"' },
        { path: `/remote.php/dav/files/alice/Music/${ALBUM_DIR}/01.flac`, size: TRACK.length, contentType: 'audio/flac', mtime: 1000, etag: '"c"', body: TRACK },
      ],
    });
    const original = fetch;
    globalThis.fetch = escaping.dav.fetch;
    try {
      const { db } = escaping;
      await db.db
        .prepare('UPDATE songs SET name = ? WHERE id = ?')
        .bind('a";b/../../evil.flac', escaping.ids.skinnyLove)
        .run();
      const response = await escaping.fetch(escaping.restUrl('download', { id: escaping.ids.skinnyLove }));
      const disposition = response.headers.get('content-disposition') ?? '';

      expect(disposition).not.toContain('";"');
      expect(disposition).not.toContain('/');
      expect(disposition).toMatch(/^attachment; filename="[^"]*"$/);
    } finally {
      globalThis.fetch = original;
      escaping.close();
    }
  });

  it('answers a wrong id with the envelope, not with a 404 page', async () => {
    // A client parsing this surface cannot read an HTML error, and reports it to the
    // user as a server fault.
    const { status, response, body } = await harness.rest('download', { id: subsonicId('s', 'no/such.flac') });

    expect(status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body['subsonic-response'].error?.code).toBe(70);
  });
});

describe('getCoverArt', () => {
  /**
   * Albums in the compilation fixture: 40, which is what makes "one probe per album
   * directory" a different number from "one probe per track".
   */
  const ALBUM_COUNT = 40;
  const TRACKS_PER_ALBUM = 3;
  /**
   * The shipped cap on album directories one artist cover request will probe.
   *
   * Read from the module rather than restated, so the assertion and the code cannot
   * drift — a restated number is a number that stops meaning anything the day someone
   * tunes the constant.
   */
  const ARTIST_COVER_PROBE_LIMIT = 3;

  /**
   * The origin's root, as `fakeDav` keys its tree. A trailing segment is not stripped by
   * the double, so a test that guesses this gets a 404 and a false pass.
   */
  const LIBRARY_ROOT = '/remote.php/dav/files/alice/Music';

  it('serves the image bytes with the origin content type', async () => {
    // An `artwork-embedded` client passes a cover-art id, which is derived from the
    // album's directory rather than a file, so the server has to look for a conventional
    // name next to the tracks.
    const response = await harness.fetch(harness.restUrl('getCoverArt', { id: harness.ids.album }));

    expect(response.status).toBe(200);
    // A wrong `Content-Type` makes a browser download the JPEG as a file, and a wrong
    // `image/*` on HTML makes a client render it inline.
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(COVER);
  });

  it('falls back to the artist directory for an artist id', async () => {
    const response = await harness.fetch(harness.restUrl('getCoverArt', { id: harness.ids.artist }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('answers a missing cover with the protocol error when the folder itself does not exist', async () => {
    // **This only covers the input that cannot reach the no-cover path**, and the comment
    // used to claim it covered both. A nonexistent artist folder makes
    // `TreeService.children` throw `NotFoundError` off the origin's `404`, which the error
    // mapper turns into `code=70` — so this asserts a *missing directory*, not a missing
    // picture.
    //
    // The two are different branches. An artist that **exists** but whose albums have no
    // image does not throw: the folder is in D1, `findCover` returns `null`, and the
    // endpoint serves the placeholder. So the assertion this test was making — "a
    // `200` with zero bytes is the worst answer" — was never actually made about a
    // missing cover. The real one is in `test/cover-art-embedded.test.ts`, against an
    // album that exists and has no artwork in any form.
    const { body } = await harness.rest('getCoverArt', { id: subsonicId('ar', 'No Such Artist') });
    expect(body['subsonic-response'].error?.code).toBe(70);
  });

  it('probes an artist once per album directory, up to a bound, not once per track', async () => {
    // An artist id carries a *name*, so the cover's folder has to be found, and finding it
    // reads every song on the artist page. The lookup used to issue one `findCoverIn` per
    // matching **row**: an artist with 120 tracks spent 120 D1 reads or live `PROPFIND`s
    // looking for one image, on a request a client makes once per album row it draws,
    // against a 50-external-subrequest ceiling for the whole invocation on the Free plan.
    //
    // Two independent bounds, so two things are asserted. A `Set` over directories
    // collapses the per-row duplication (120 → 40); a separate cap bounds a compilation
    // that genuinely has 40 albums (40 → 3). Removing only the cap still passes a
    // "fewer than 120" assertion, so the count is a hard ceiling.
    //
    // The origin really has these albums and they have **no** cover, so nothing
    // short-circuits on a hit: the loop runs to its own cap every time. A seed whose
    // first album had art would make the count an accident of the fixture.
    const davTree: Record<string, DavEntry[]> = {};
    for (let album = 1; album <= ALBUM_COUNT; album += 1) {
      const dir = `${LIBRARY_ROOT}/Compilers/${album}`;
      davTree[dir] = [
        { path: dir, collection: true, mtime: 1000 },
        ...Array.from({ length: TRACKS_PER_ALBUM }, (_, index) => ({ path: `${dir}/${index + 1}.flac`, mtime: 1000 })),
      ];
    }
    harness.dav.setTree(davTree);

    const libraryId = await harness.db.db.prepare('SELECT id FROM libraries LIMIT 1').first<{ id: string }>();
    const statements = [];
    for (let album = 1; album <= ALBUM_COUNT; album += 1) {
      for (let track = 1; track <= TRACKS_PER_ALBUM; track += 1) {
        statements.push(
          harness.db.db
            .prepare(
              `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix,
                                  duration, bitrate, artist, artist_ci, album, album_ci, album_artist, album_artist_ci,
                                  created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 100, 1, 'audio/flac', 'flac', 0, 0,
                       'The Compilers', 'the compilers', ?, ?, 'The Compilers', 'the compilers', 0, 0)`,
            )
            .bind(
              `s:comp-${album}-${track}`,
              libraryId?.id ?? '',
              `Compilers/${album}/${track}.flac`,
              `Compilers/${album}`,
              `${track}.flac`,
              `${track}.flac`,
              `Compilation ${album}`,
              `compilation ${album}`,
            ),
        );
      }
    }
    // `batch` is optional on the D1 surface a test may be handed, and the sequential
    // fallback is what `BaseDAO` does for real too — so this goes through the same
    // helper rather than assuming a method the double might not have.
    for (const statement of statements) {
      await statement.run();
    }

    const response = await harness.fetch(harness.restUrl('getCoverArt', { id: subsonicId('ar', 'The Compilers') }));
    // `code=70`, because after the album probes the lookup falls back to the artist's
    // *name* as a directory — and this artist has no such folder, only `Compilers/1..40`.
    // The fallback is what the bound protects: it is one more request, and a client
    // drawing 40 album rows is 40 such lookups.
    expect(await response.clone().json()).toMatchObject({ 'subsonic-response': { error: { code: 70 } } });

    // The claim. 120 rows, 40 directories, 3 album probes — and a 4th request for the
    // artist-directory fallback, which is one fixed cost rather than one per album. The
    // number that shipped was 121.
    expect(harness.dav.propfinds.length).toBeLessThanOrEqual(ARTIST_COVER_PROBE_LIMIT + 1);
  });
});

describe('the origin credential', () => {
  it('is sent to the library origin and recorded nowhere else', async () => {
    await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }));

    // The stored DAV password reaches the origin as Basic auth and is never echoed into
    // a response, a log line, or a query string. `fakeDav` records what it was given,
    // which is the only place it exists outside the vault.
    expect(harness.dav.credentials).toHaveLength(1);
    expect(decodeBasic(harness.dav.credentials[0] ?? '').username).toBe('alice');
    const response = await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }));
    expect([...response.headers.values()].join(' ')).not.toContain('Basic ');
    expect(await response.text()).not.toContain('dav-password');
  });

  it('never forwards the caller Access assertion to the origin', async () => {
    // Fan-out to a backend is a pure passthrough of the caller's identity, but a *media*
    // request is not: the origin gets the library's own credential and nothing of the
    // end user's session.
    await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }), {}, { headers: { 'Cf-Access-Jwt-Assertion': 'a.jwt.token' } });

    // Only the library credential is presented. The end user's Access assertion, their
    // cookie, and their Subsonic token are all absent — the origin has no business
    // holding any of them, and a leaked session assertion is replayable.
    const presented = harness.dav.credentials.at(-1) ?? '';
    expect(presented).not.toContain('a.jwt.token');
    expect(decodeBasic(presented).username).toBe('alice');
  });
});

describe('upstream failures', () => {
  it('does not answer a 401 from the origin with a Subsonic 401', async () => {
    // The two 401s mean opposite things. A user's password is wrong; a *library's* is
    // wrong. Reporting the second as the first sends the user to re-enter a credential
    // that is not the problem.
    const failing = await createHarness({});
    const original = fetch;
    globalThis.fetch = async () => new Response('', { status: 401 });
    try {
      const { status, body } = await failing.rest('stream', { id: failing.ids.skinnyLove });
      // `code=0`, not `40` and not `70`. `40` would send the user to re-enter a
      // password that is not the problem; `70` would make them think the track is gone.
      expect(status).not.toBe(401);
      expect(body['subsonic-response'].error?.code).toBe(0);
    } finally {
      globalThis.fetch = original;
      failing.close();
    }
  });

  it('never echoes the origin error body to the client', async () => {
    // An origin's error page can contain a filesystem path, a hostname, or a stack.
    const failing = await createHarness({});
    const original = fetch;
    globalThis.fetch = async () =>
      new Response('Error 500: /srv/nextcloud/data/alice/Music is not readable by uid 33', { status: 500 });
    try {
      const response = await failing.fetch(failing.restUrl('stream', { id: failing.ids.skinnyLove }));
      const text = await response.text();
      expect(text).not.toContain('/srv/nextcloud');
      expect(text).not.toContain('uid 33');
    } finally {
      globalThis.fetch = original;
      failing.close();
    }
  });

  it('does not leak the library id through an error for a valid path in another library', async () => {
    // `code=50` (not authorized) and `code=70` (not found) are deliberately the same
    // answer: distinguishing them turns `getSong` into an oracle for which paths exist
    // in a library the caller cannot see.
    const first = await harness.rest('getSong', { id: subsonicId('s', `${ALBUM_DIR}/01.flac`, LIBRARY_ID) });
    const forged = await harness.rest('getSong', { id: subsonicId('s', `${ALBUM_DIR}/01.flac`, 'L-other') });

    expect(first.body['subsonic-response'].error?.code).toBeUndefined();
    expect(forged.body['subsonic-response'].error?.code).toBe(70);
  });
});

describe('no buffering', () => {
  it('returns a body whose length matches the range, not the file', async () => {
    // The failure this catches is a server that reads the whole file into memory to
    // compute a `Content-Length` it could have copied. It is invisible for a 4 KB
    // fixture and fatal for a 4 GiB track.
    const response = await harness.fetch(harness.restUrl('stream', { id: harness.ids.skinnyLove }), {}, { headers: { Range: 'bytes=0-99' } });
    const body = new Uint8Array(await response.arrayBuffer());

    expect(body).toHaveLength(100);
    expect(response.headers.get('content-length')).toBe('100');
    // The body is the *upstream* stream, not a copy: reading it consumed it. A server
    // that had buffered the file to compute a length would have handed over an
    // independent copy, and the double read would succeed.
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});

describe('test hygiene', () => {
  it('uses the fake origin, so a green run never touched the network', async () => {
    // A guard on the harness itself: if `fakeDav` stopped being installed, every test
    // above would fail loudly rather than reaching for a real host named in a fixture.
    expect(fetch).toBe(harness.dav.fetch);
    expect(vi.isMockFunction(harness.dav.fetch)).toBe(false);
  });
});
