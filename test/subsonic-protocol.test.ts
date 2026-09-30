/**
 * The protocol surface: parameter transport, the envelope, and ID parsing.
 *
 * These are the three places where a bug is invisible in a unit test and fatal in a
 * client — a POST body that is never read (every playlist a phone creates
 * disappears), an unescaped artist name (a track called `A & B` corrupts the
 * document), and an over-permissive ID decoder (a forged path streams a file
 * outside the library).
 */
import { describe, expect, it } from 'vitest';
import {
  albumElement,
  albumWithSongs,
  decodeId,
  decodeLegacyPassword,
  el,
  elList,
  encodeId,
  ErrorCode,
  errorResponse,
  IdKind,
  isClientVersionSupported,
  isValidJsonpCallback,
  resolveFormat,
  successResponse,
  SubsonicParams,
  SubsonicError,
} from '@edge-sonic/subsonic';

function get(url: string): Request {
  return new Request(`https://edge-sonic.example${url}`);
}

function form(body: string): Request {
  return new Request('https://edge-sonic.example/rest/ping.view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

describe('SubsonicParams', () => {
  it('reads the query string', async () => {
    const params = await SubsonicParams.fromRequest(get('/rest/ping.view?u=ann&v=1.16.1&c=droid&f=json'));
    expect(params.get('u')).toBe('ann');
    expect(params.get('v')).toBe('1.16.1');
    expect(params.get('c')).toBe('droid');
    expect(params.get('f')).toBe('json');
  });

  it('reads a form-encoded POST body, which several mobile clients use exclusively', async () => {
    const params = await SubsonicParams.fromRequest(form('u=ann&t=abc&s=salt&songId=1&songId=2'));
    expect(params.get('u')).toBe('ann');
    // The regression this guards: reading only the query string drops every
    // playlist a phone creates, because the ids are in the body.
    expect(params.ids('songId')).toEqual(['1', '2']);
  });

  it('merges the query string and the body when a client splits them', async () => {
    const params = await SubsonicParams.fromRequest(
      new Request('https://edge-sonic.example/rest/createPlaylist.view?name=Mix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'u=ann&songId=7',
      }),
    );
    expect(params.get('name')).toBe('Mix');
    expect(params.get('u')).toBe('ann');
    expect(params.ids('songId')).toEqual(['7']);
  });

  it('accepts a comma-joined list as well as a repeated parameter', async () => {
    // Both spellings are in the wild; the spec only documents the repeated one.
    const joined = await SubsonicParams.fromRequest(get('/rest/x.view?songId=1,2,3'));
    const repeated = await SubsonicParams.fromRequest(get('/rest/x.view?songId=1&songId=2&songId=3'));
    expect(joined.ids('songId')).toEqual(['1', '2', '3']);
    expect(repeated.ids('songId')).toEqual(['1', '2', '3']);
  });

  it('drops empty segments from a comma list instead of resolving an empty id', async () => {
    // A trailing comma is a client quirk. Resolving `""` would fail the whole call
    // rather than the intended one song.
    const params = await SubsonicParams.fromRequest(get('/rest/x.view?songId=1,2,'));
    expect(params.ids('songId')).toEqual(['1', '2']);
  });

  it('does not comma-split a singular id', async () => {
    // A comma inside a single opaque id must stay part of the id; splitting it
    // would produce two lookups that both fail.
    const params = await SubsonicParams.fromRequest(get('/rest/getSong.view?id=weird,id'));
    expect(params.get('id')).toBe('weird,id');
    expect(params.ids('id')).toEqual(['weird', 'id']);
  });

  it('reports a missing required parameter as code=10, naming it', async () => {
    const params = await SubsonicParams.fromRequest(get('/rest/getSong.view'));
    try {
      params.require('id');
      expect.unreachable('require should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SubsonicError);
      expect((error as SubsonicError).code).toBe(ErrorCode.MissingParameter);
      expect((error as SubsonicError).message).toContain('id');
    }
  });

  it('falls back rather than failing on a malformed number', async () => {
    // `size=abc` is a client bug, not a reason to refuse a page of results.
    const params = await SubsonicParams.fromRequest(get('/rest/x.view?size=abc'));
    expect(params.int('size', 10)).toBe(10);
  });

  it('clamps a number into range', async () => {
    const params = await SubsonicParams.fromRequest(get('/rest/x.view?size=9999&offset=-4'));
    expect(params.int('size', 10, { min: 1, max: 500 })).toBe(500);
    expect(params.int('offset', 0, { min: 0 })).toBe(0);
  });

  it('does not consume the body of a non-form request', async () => {
    // A `stream` POST carries no form body; reading it unconditionally would consume
    // bytes this server must not touch.
    const request = new Request('https://edge-sonic.example/rest/stream.view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'binary',
    });
    const params = await SubsonicParams.fromRequest(request);
    expect(params.get('u')).toBeUndefined();
  });
});

describe('legacy password decoding', () => {
  it('passes a cleartext password through', () => {
    expect(decodeLegacyPassword('sesame')).toBe('sesame');
  });

  it('decodes the enc: hex form', () => {
    expect(decodeLegacyPassword('enc:736573616d65')).toBe('sesame');
  });

  it('decodes non-ASCII hex as UTF-8', () => {
    // `päss` is `70 c3 a4 73 73` in UTF-8. Decoding byte-wise (latin1) would give
    // mojibake and fail every authentication for a non-ASCII password.
    expect(decodeLegacyPassword('enc:70c3a47373')).toBe('päss');
  });

  it('rejects malformed hex as a credential failure, not a parse error', () => {
    // The distinction matters: telling a caller "your hex was malformed" rather than
    // "those credentials are wrong" is an oracle for nothing useful, and the
    // protocol has one code for both.
    for (const bad of ['enc:zz', 'enc:abc', 'enc:']) {
      try {
        decodeLegacyPassword(bad);
        expect.unreachable(`${bad} should have thrown`);
      } catch (error) {
        expect((error as SubsonicError).code).toBe(ErrorCode.WrongCredentials);
      }
    }
  });
});

describe('client version negotiation', () => {
  it('accepts the same major with a lower or equal minor', () => {
    // The string comparison `1.9.0 < 1.16.1` is false, so a naive check rejects every
    // client older than 1.10.
    expect(isClientVersionSupported(1, 16)).toBe(true);
    expect(isClientVersionSupported(1, 9)).toBe(true);
    expect(isClientVersionSupported(1, 13)).toBe(true);
  });

  it('rejects a higher minor and a different major', () => {
    expect(isClientVersionSupported(1, 17)).toBe(false);
    expect(isClientVersionSupported(2, 0)).toBe(false);
    expect(isClientVersionSupported(0, 9)).toBe(false);
  });
});

describe('format resolution', () => {
  it('accepts the three documented formats', () => {
    expect(resolveFormat('xml')).toBe('xml');
    expect(resolveFormat('json')).toBe('json');
    expect(resolveFormat('jsonp')).toBe('jsonp');
  });

  it('falls back to the default for anything unrecognized', () => {
    // `f` is advisory. Refusing the call over a cosmetic difference would break a
    // client that sends a value from a newer protocol revision.
    expect(resolveFormat('yaml')).toBe('xml');
    expect(resolveFormat(null)).toBe('xml');
  });
});

describe('envelope', () => {
  it('renders XML with the root attributes a client depends on', async () => {
    const response = successResponse(el('song', { id: 's:1', title: 'Holocene' }), { format: 'xml' });
    const body = await response.text();
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('status="ok"');
    expect(body).toContain('version="1.16.1"');
    expect(body).toContain('openSubsonic="true"');
    expect(body).toContain('<song id="s:1" title="Holocene"/>');
    expect(response.headers.get('Content-Type')).toContain('text/xml');
  });

  it('renders a bare envelope for an empty success, as ping specifies', async () => {
    const body = await (await successResponse(null, { format: 'xml' })).text();
    expect(body).toContain('status="ok"');
    // Some clients treat any child element as a protocol violation, so the root
    // must be self-closing. The XML declaration is the only other `<`.
    expect(body).toContain('<subsonic-response status="ok"');
    expect(body).toMatch(/<subsonic-response[^>]*\/>/);
  });

  it('wraps JSON under the response element name', async () => {
    const response = successResponse(elList('indexes', 'shortcut', {}, [el('shortcut', { id: 'dir:a', name: 'Blur' })]), { format: 'json' });
    const body = (await response.json()) as Record<string, { status: string; indexes: { shortcut: unknown } }>;
    expect(body['subsonic-response']!.status).toBe('ok');
    // `array: true` means one item is still an array. Subsonic's own server emits a
    // bare object here, and the difference is a client-visible shape.
    expect(Array.isArray(body['subsonic-response']!.indexes.shortcut)).toBe(true);
  });

  it('escapes untrusted values in XML', async () => {
    // An artist name is attacker-controlled through a filename.
    const body = await (await successResponse(el('artist', { name: 'A & B <script>"x"' }), { format: 'xml' })).text();
    expect(body).toContain('A &amp; B &lt;script&gt;&quot;x&quot;');
    expect(body).not.toContain('<script>');
  });

  it('escapes untrusted values in JSON', async () => {
    const response = successResponse(el('artist', { name: String.raw`quote " and \ backslash` }), { format: 'json' });
    const body = await response.text();
    // `JSON.stringify` handles the escaping; the assertion is that the value
    // round-trips rather than being dropped or truncated.
    const parsed = JSON.parse(body) as { 'subsonic-response': { artist: { name: string } } };
    expect(parsed['subsonic-response'].artist.name).toBe(String.raw`quote " and \ backslash`);
  });

  it('renders an empty list as [], not as an absent key', async () => {
    // Subsonic's own server omits the key entirely when a list is empty, and a client
    // written against it then does `response.starred2.song.map(...)` and throws. Emitting
    // `[]` renders an empty screen instead.
    const body = (await (await successResponse(elList('starred2', 'song', {}, []), { format: 'json' })).json()) as {
      'subsonic-response': { starred2: { song: unknown[] } };
    };
    expect(body['subsonic-response'].starred2.song).toEqual([]);
  });

  it('renders a one-item list as an array, not as a bare object', async () => {
    const body = (await (await successResponse(elList('starred2', 'song', {}, [el('song', { id: 's:1' })]), { format: 'json' })).json()) as {
      'subsonic-response': { starred2: { song: unknown } };
    };
    expect(Array.isArray(body['subsonic-response'].starred2.song)).toBe(true);
  });

  it('renders a one-item list inside a record element as an array too', async () => {
    // The one above covers a list **wrapper**, and a wrapper declares its key, so it was
    // always safe. This is the shape that was not: a repeated child of an element that
    // carries attributes, which is a *record* to the serializer and therefore has no
    // declared key of its own. `getAlbum` is the only endpoint in the product that builds
    // one — `album` with `song` children — and it did so by spreading a builder's node and
    // attaching children, which bypasses the declaration entirely.
    //
    // So the collapse is invisible at n≥2 and total at n=1, which is why the fixture album
    // (two tracks) kept the suite green. Asserted here at both sizes, so removing the
    // declaration fails one of them.
    const at = async (n: number): Promise<unknown> => {
      const album = albumWithSongs(
        { id: 'al:1', name: 'A', songCount: n, duration: 0 },
        Array.from({ length: n }, (_, i) => ({ id: `s:${i}`, title: `t${i}`, mediaType: 'song' as const, duration: 0, bitRate: 0, size: 0, contentType: 'audio/flac', suffix: 'flac', playCount: 0 })),
      );
      const body = (await (await successResponse(album, { format: 'json' })).json()) as { 'subsonic-response': { album: { song: unknown } } };
      return body['subsonic-response'].album.song;
    };
    expect(Array.isArray(await at(1))).toBe(true);
    expect(Array.isArray(await at(2))).toBe(true);
    expect(await at(1)).toHaveLength(1);
  });

  it('leaves an album used as a list child without a song key', async () => {
    // The counterweight to the fix. `listKey` seeds its key **unconditionally**, so
    // declaring `song` on the shared album builder would attach an empty `"song": []` to
    // every album in `getAlbumList2`, `getArtist` and `search2`/`search3` — a list of
    // albums that each claim to carry no songs, which is a different wrong answer.
    const body = (await (await successResponse(elList('albumList2', 'album', {}, [albumElement({ id: 'al:1', name: 'A', songCount: 12, duration: 3600 })]), { format: 'json' })).json()) as {
      'subsonic-response': { albumList2: { album: Array<Record<string, unknown>> } };
    };
    expect(body['subsonic-response'].albumList2.album[0]).not.toHaveProperty('song');
  });

  it('drops null and undefined attributes but keeps zero', async () => {
    // `duration=0` means "not read yet" and clients tolerate it; a *missing*
    // duration is read as a malformed record and hides the track.
    const body = await (await successResponse(el('song', { id: 's:1', duration: 0, title: undefined, album: null }), { format: 'xml' })).text();
    expect(body).toContain('duration="0"');
    expect(body).not.toContain('title=');
    expect(body).not.toContain('album=');
  });

  it('returns 200 for a protocol failure, with the code in the body', async () => {
    // Subsonic clients branch on the envelope, not the status. A 400 with a correct
    // body is reported to the user as "server error".
    const response = errorResponse(new SubsonicError(ErrorCode.NotFound, 'Album not found.'), { format: 'xml' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('status="failed"');
    expect(body).toContain('<error code="70" message="Album not found."/>');
  });

  it('returns 401 for a credential failure, keeping code=40 in the body', async () => {
    // Both signals are correct: HTTP-level tooling can see the failure, and a client
    // that reads the envelope still gets "wrong username or password".
    const response = errorResponse(new SubsonicError(ErrorCode.WrongCredentials), { format: 'json' });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { 'subsonic-response': { status: string; error: { code: number } } };
    expect(body['subsonic-response'].error.code).toBe(40);
  });

  it('is never cached', async () => {
    // Responses are per-user; a shared cache must never serve one user's library to
    // another.
    const response = successResponse(null, { format: 'xml' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('JSONP callback validation', () => {
  it('accepts dotted identifiers', () => {
    for (const name of ['cb', '_cb', '$cb', 'my.callback', 'a1._b2']) {
      expect(isValidJsonpCallback(name), name).toBe(true);
    }
  });

  it('rejects anything that could break out of the script context', () => {
    // The response is already inside a <script> by the time any check could run, so
    // the check has to happen before the body is produced. `alert(1)//` here is
    // arbitrary script execution in this origin, next to the admin SPA.
    for (const name of ['alert(1)//', 'a;b', 'a b', 'a-b', '', '<script>', "a'", 'a\nb', '1abc', 'a'.repeat(200)]) {
      expect(isValidJsonpCallback(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('falls back to XML for JSONP with an invalid callback', async () => {
    const response = successResponse(el('song', { id: 's:1' }), { format: 'jsonp', jsonpCallback: 'alert(1)//' });
    const body = await response.text();
    // A broken client gets usable data; no client gets script execution.
    expect(body.startsWith('<?xml')).toBe(true);
    expect(body).not.toContain('alert(1)');
  });

  it('wraps a valid callback', async () => {
    const response = successResponse(el('song', { id: 's:1' }), { format: 'jsonp', jsonpCallback: 'handleIt' });
    const body = await response.text();
    expect(body.startsWith('handleIt({')).toBe(true);
    expect(body.endsWith(');')).toBe(true);
  });
});

describe('Subsonic ids', () => {
  const libraryId = 'L1abc';
  const path = 'Bon Iver/For Emma, Forever Ago/01 - Holocene.flac';

  it('round-trips a path with spaces, commas, and unicode', () => {
    const encoded = encodeId(IdKind.Song, libraryId, path);
    expect(decodeId(encoded, IdKind.Song)).toEqual({ kind: IdKind.Song, libraryId, path });
  });

  it('is stable across calls, so a saved playlist keeps working', () => {
    // A client holds these for weeks. An id that changed on restart would silently
    // empty every playlist and orphan every star.
    expect(encodeId(IdKind.Song, libraryId, path)).toBe(encodeId(IdKind.Song, libraryId, path));
  });

  it('distinguishes kinds for the same path', () => {
    // An album and the song directly in it are the same directory path but
    // different resources.
    const album = encodeId(IdKind.Album, libraryId, 'Bon Iver/For Emma');
    const song = encodeId(IdKind.Song, libraryId, 'Bon Iver/For Emma/01.flac');
    expect(album).not.toBe(song);
    expect(() => decodeId(album, IdKind.Song)).toThrow(SubsonicError);
  });

  describe('rejects a forged id', () => {
    /**
    Craft the payload an attacker would send, bypassing `encodeId`.
    */
    function forge(kind: string, library: string, rawPath: string): string {
      const bytes = new TextEncoder().encode(`${library}\n${rawPath}`);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `${kind}:${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
    }

    it('refuses a path that escapes the library root', () => {
      for (const attempt of ['../etc/passwd', 'a/../../etc/passwd', '/etc/passwd', '..', 'a/./b']) {
        expect(() => decodeId(forge('s', libraryId, attempt), IdKind.Song), attempt).toThrow(SubsonicError);
      }
    });

    it('refuses a percent-encoded path', () => {
      // `encodeId` stores the path decoded, so an escape here means the id was not
      // produced by this server. Refusing it means no consumer has to decide whether
      // `%2e%2e%2f` is a literal filename or an encoded traversal.
      expect(() => decodeId(forge('s', libraryId, '%2e%2e%2fetc%2fpasswd'), IdKind.Song)).toThrow(SubsonicError);
      expect(() => decodeId(forge('s', libraryId, '100%25.flac'), IdKind.Song)).toThrow(SubsonicError);
    });

    it('refuses an absolute path', () => {
      expect(() => decodeId(forge('s', libraryId, '/music/song.flac'), IdKind.Song)).toThrow(SubsonicError);
    });

    it('refuses a library id carrying the separator', () => {
      // Without refusing control characters, a crafted id could shift the boundary
      // between the two fields of the payload: the library half would read as `L1`
      // and the rest would land inside the path.
      expect(() => decodeId(forge('s', 'L1\nother/evil', 'song.flac'), IdKind.Song)).toThrow(SubsonicError);
    });

    it('refuses an unknown kind', () => {
      expect(() => decodeId(forge('zz', libraryId, 'a.flac'))).toThrow(SubsonicError);
    });

    it('refuses a malformed prefix or payload', () => {
      for (const bad of ['', ':', 's:', ':abc', 's', 's:!!!', 's:' + 'A'.repeat(3000)]) {
        expect(() => decodeId(bad), JSON.stringify(bad)).toThrow(SubsonicError);
      }
    });

    it('refuses a NUL byte and a backslash', () => {
      expect(() => decodeId(forge('s', libraryId, 'a\u{0}b.flac'), IdKind.Song)).toThrow(SubsonicError);
      expect(() => decodeId(forge('s', libraryId, String.raw`a\b.flac`), IdKind.Song)).toThrow(SubsonicError);
    });

    it('reports a rejection as not-found, not as forbidden', () => {
      // `code=50` would confirm the id is real, turning the endpoint into an oracle.
      try {
        decodeId(forge('s', libraryId, '../etc/passwd'), IdKind.Song);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as SubsonicError).code).toBe(ErrorCode.NotFound);
      }
    });
  });
});
