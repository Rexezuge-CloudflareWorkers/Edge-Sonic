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
import { createHash } from 'node:crypto';
import {
  albumElement,
  albumWithSongs,
  albumIdOf,
  decodeAlbumKey,
  decodeId,
  decodeLegacyPassword,
  deriveShortSongId,
  el,
  elList,
  encodeId,
  ErrorCode,
  errorResponse,
  IdKind,
  isClientVersionSupported,
  isShortSongId,
  isValidJsonpCallback,
  resolveFormat,
  songElement,
  successResponse,
  SubsonicParams,
  SubsonicError,
} from '@edge-sonic/subsonic';
import type { Song } from '@edge-sonic/subsonic';

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
    expect(body).toMatch(/<subsonic-response[^>]*\/>/);
  });

  /**
   * The namespace, and the fact that it is `http://`.
   *
   * It shipped absent. Nothing here can see a missing `xmlns`: an undeclared
   * namespace is still well-formed XML, so every parser in this repository's own
   * tests accepted the document, and a lenient client ignores the attribute
   * entirely. A client that resolves element names *against* the namespace —
   * which is what the protocol's own schema tells it to do — finds no elements at
   * all and reports an empty library.
   *
   * The scheme is asserted literally because "correcting" it to `https://` is
   * indistinguishable from a fix on every client that ignores the namespace. It is
   * an identifier: nothing resolves it. Subsonic and Navidrome both emit exactly
   * `http://subsonic.org/restapi`.
   */
  it('roots the document in the protocol XML namespace', async () => {
    const body = await (await successResponse(null, { format: 'xml' })).text();
    expect(body).toContain('xmlns="http://subsonic.org/restapi"');
  });

  it('declares the namespace on the root only, and not in the other formats', async () => {
    const payload = elList('albumList2', 'album', {}, [el('album', { id: 'al:1', name: 'Akane' })]);

    const xml = await (await successResponse(payload, { format: 'xml' })).text();
    // One declaration. A per-element one would be redundant rather than wrong,
    // but it is an attribute in the output and belongs to the document, not a node.
    expect(xml.match(/xmlns=/g)).toHaveLength(1);

    // JSON and JSONP have no namespace concept, so an `xmlns` carried in `attrs`
    // would put a field the protocol does not define in front of every client.
    // The namespace lives in the serializer's root handling, never in `attrs`, and
    // this is the assertion that says so.
    for (const format of ['json', 'jsonp'] as const) {
      // `jsonp` needs a callback name: with none it deliberately falls back to XML,
      // which would make this assertion pass for the wrong reason.
      const rendered = await (await successResponse(payload, { format, jsonpCallback: 'cb' })).text();
      expect(rendered).not.toContain('xmlns');
      expect(rendered).not.toContain('subsonic.org/restapi');
    }
  });

  it('wraps JSON under the response element name', async () => {
    const response = successResponse(elList('indexes', 'shortcut', {}, [el('shortcut', { id: 'dir:a', name: 'Blur' })]), {
      format: 'json',
    });
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

  it('renders an empty list as an absent key, matching the reference server', async () => {
    // Subsonic's own server omits the key when a list is empty, and so does Navidrome —
    // measured on the same library: `{"starred2":{}}` against the
    // `{"starred2":{"song":[],"album":[]}}` this used to emit.
    //
    // It was the other way round on purpose. A client whose model is
    // `@SerialName("song") val songs: List<Song>` throws `MissingFieldException` on the
    // absent key, and `[]` renders an empty screen instead — a real incident, recorded in
    // this repository's own history.
    //
    // That fix aimed at the symptom. The throw is a client that cannot tolerate an absent
    // optional field, and every field here is optional in the schema; answering differently
    // from the implementation clients are written against is the more expensive half of the
    // trade, because such a client works against Navidrome and fails only here. Being right
    // about the shape and wrong about the ecosystem is not the same as being right.
    //
    // Paired with the tests below, because a rule about the empty case alone would also
    // pass for an implementation that renders nothing at all as an array.
    const body = (await (await successResponse(elList('starred2', 'song', {}, []), { format: 'json' })).json()) as {
      'subsonic-response': { starred2: Record<string, unknown> };
    };
    expect(body['subsonic-response'].starred2).not.toHaveProperty('song');
  });

  it('declares only the list keys it has items for', async () => {
    // The paired half. `starred2` carries albums *and* songs, so a user who has starred only
    // songs gets `song` and nothing for `album`. The previous behaviour seeded every
    // declared key, which is why one assertion could cover both halves at once and neither
    // was distinguishable from the other.
    const body = (await (
      await successResponse(elList('starred2', ['album', 'song'], {}, [el('song', { id: 's:1' })]), { format: 'json' })
    ).json()) as {
      'subsonic-response': { starred2: Record<string, unknown> };
    };
    expect(Object.keys(body['subsonic-response'].starred2)).toEqual(['song']);
  });

  it('renders a one-item list as an array, not as a bare object', async () => {
    const body = (await (
      await successResponse(elList('starred2', 'song', {}, [el('song', { id: 's:1' })]), { format: 'json' })
    ).json()) as {
      'subsonic-response': { starred2: { song: unknown } };
    };
    expect(Array.isArray(body['subsonic-response'].starred2.song)).toBe(true);
  });

  it('renders a declared array with no items as [], which is the exception', async () => {
    // `array: true` is a bare list at a key rather than a record wrapping one, so it has no
    // "absent" reading: `getOpenSubsonicExtensions` must answer `[]` with no extensions, or
    // a client reading `.length` gets `undefined` on the capability call — the one call
    // whose failure mode is a client concluding the server is broken. The two shapes are
    // not interchangeable, and this is the case that separates them.
    const body = (await (await successResponse({ name: 'openSubsonicExtensions', array: true }, { format: 'json' })).json()) as {
      'subsonic-response': { openSubsonicExtensions: unknown };
    };
    expect(body['subsonic-response'].openSubsonicExtensions).toEqual([]);
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
        Array.from({ length: n }, (_, i) => ({
          id: `s:${i}`,
          title: `t${i}`,
          mediaType: 'song' as const,
          duration: 0,
          bitRate: 0,
          size: 0,
          contentType: 'audio/flac',
          suffix: 'flac',
          playCount: 0,
        })),
      );
      const body = (await (await successResponse(album, { format: 'json' })).json()) as {
        'subsonic-response': { album: { song: unknown } };
      };
      return body['subsonic-response'].album.song;
    };
    expect(Array.isArray(await at(1))).toBe(true);
    expect(Array.isArray(await at(2))).toBe(true);
    expect(await at(1)).toHaveLength(1);
  });

  /**
   * The attribute key set of `song`, against the schema's own enumeration.
   *
   * `type` and `mediaType` are different fields: the protocol types `type` as the
   * generic container `[music/podcast/audiobook/video]` and `mediaType` as the shape
   * `[song/album/artist]`. `songElement` wrote `mediaType`'s value into `type`, so
   * every track published `type="song"` — a value outside `type`'s enumeration — and
   * published no `mediaType` at all.
   *
   * Nothing here could see it. The attribute was syntactically valid, the tests that
   * existed asserted *values* rather than the field set, and a lenient client drops
   * an unknown attribute. What it cost is the field every client filters on: a
   * player filtering `type == "music"` sees an empty library, and one reading
   * `mediaType` to tell a song from an album reads nothing.
   */
  it('publishes type as the container and mediaType as the shape', async () => {
    const song: Song = {
      id: 's:1',
      title: 'Akane',
      mediaType: 'song',
      duration: 256,
      bitRate: 200,
      size: 1,
      contentType: 'audio/ogg',
      suffix: 'opus',
    };
    const body = (await (await successResponse(songElement(song), { format: 'json' })).json()) as {
      'subsonic-response': { song: Record<string, unknown> };
    };
    // Read under `song`, not at the envelope: the envelope has a `type` of its own
    // (the server name), and asserting at that level would pass against a `song`
    // carrying any value at all.
    expect(body['subsonic-response'].song.type).toBe('music');
    expect(body['subsonic-response'].song.mediaType).toBe('song');
    // The enumeration is the point; a value outside it is what shipped.
    expect(['music', 'podcast', 'audiobook', 'video']).toContain(body['subsonic-response'].song.type);
  });

  it('renders artists and genres as bare arrays, where the specification puts them', async () => {
    // OpenSubsonic's `Child.artists` is `"artists": [{…}]`, not `{"artist": [{…}]}`.
    //
    // The wrapper and the child are the same word in two grammatical forms — `artists` and
    // `artist` — and unlike `albumList2.album` the array belongs at the **wrapper's** key.
    // Emitting the wrapped form is not a near miss: a client whose model is
    // `artists: List<Artist>` reads an object there and throws, which is the same failure
    // mode as an absent key and just as invisible from inside this repository.
    const song: Song = {
      id: 's:1',
      title: 'Akane',
      artist: 'Silent Siren',
      albumArtist: 'SILENT SIREN',
      genre: 'J-Rock',
      artistId: 'ar:1',
      samplingRate: 48_000,
      channelCount: 2,
      sortName: 'akane',
      mediaType: 'song',
      duration: 256,
      bitRate: 200,
      size: 1,
      contentType: 'audio/ogg',
      suffix: 'opus',
    };
    const body = (await (await successResponse(songElement(song), { format: 'json' })).json()) as {
      'subsonic-response': { song: Record<string, unknown> };
    };
    const element = body['subsonic-response'].song;

    expect(Array.isArray(element.artists), 'artists').toBe(true);
    expect(element.artists).toEqual([{ id: 'ar:1', name: 'Silent Siren' }]);
    expect(Array.isArray(element.genres), 'genres').toBe(true);
    expect(element.genres).toEqual([{ name: 'J-Rock' }]);
    // The album artist is its own list, and differs from the track artist here — which is the
    // whole point of the field on a compilation.
    expect(element.albumArtists).toEqual([{ id: 'ar:1', name: 'SILENT SIREN' }]);
    // And the single-value forms beside them.
    expect(element.displayArtist).toBe('Silent Siren');
    expect(element.displayAlbumArtist).toBe('SILENT SIREN');
    expect(element.samplingRate).toBe(48_000);
    expect(element.channelCount).toBe(2);
    expect(element.sortName).toBe('akane');
  });

  it('derives a sort name, dropping a leading article and only a whole-word one', async () => {
    // `sortName` is what a client orders by, and `ignoredArticles` is the list it is told to
    // ignore — so both come from one source. Asserted against the same article list
    // `getIndexes` advertises.
    const at = async (title: string): Promise<unknown> => {
      const song: Song = {
        id: 's:1',
        title,
        mediaType: 'song',
        duration: 0,
        bitRate: 0,
        size: 1,
        contentType: 'audio/flac',
        suffix: 'flac',
      };
      const body = (await (await successResponse(songElement(song), { format: 'json' })).json()) as {
        'subsonic-response': { song: { sortName: unknown } };
      };
      return body['subsonic-response'].song.sortName;
    };

    expect(await at('The Bird')).toBe('bird');
    expect(await at('Akane')).toBe('akane');
    // Not a whole word: `Theme` starts with `The` and must keep it.
    expect(await at('Theme Song')).toBe('theme song');
    // A bare article is the whole title and stays — there is nothing left to sort by.
    expect(await at('The')).toBe('the');
    // Case-insensitive, because the tag may shout.
    expect(await at('THE GREAT ESCAPE')).toBe('great escape');
  });

  it('omits the extension lists entirely when there is nothing to name', async () => {
    // A track whose tags were never read must not claim the server supports these fields
    // *and* knows the answer is none — an absent key claims nothing, which is the honest state.
    // Paired with the test above deliberately: together they say the key tracks the data,
    // rather than that it is always present or never present.
    const song: Song = {
      id: 's:1',
      title: '01 - untagged',
      mediaType: 'song',
      duration: 0,
      bitRate: 0,
      size: 1,
      contentType: 'audio/flac',
      suffix: 'flac',
    };
    const body = (await (await successResponse(songElement(song), { format: 'json' })).json()) as {
      'subsonic-response': { song: Record<string, unknown> };
    };
    for (const field of ['artists', 'albumArtists', 'genres', 'displayArtist', 'displayAlbumArtist', 'samplingRate', 'channelCount']) {
      expect(body['subsonic-response'].song, field).not.toHaveProperty(field);
    }
    // `sortName` needs no tag: it is derived from the title, so it is always there.
    expect(body['subsonic-response'].song.sortName).toBe('01 - untagged');
  });

  it('publishes only the fields AlbumID3 declares', async () => {
    // `AlbumID3` has `name` and no `title`, and no `isDir`. `albumAttrs` published
    // both: `title` duplicated `name` (so every album carried two identical fields
    // and a client reading the one the schema names still worked, which is why it
    // was invisible), and `isDir: true` asserted a field the schema does not have.
    const body = (await (
      await successResponse(albumElement({ id: 'al:1', name: 'Akane', songCount: 1, duration: 256 }), { format: 'json' })
    ).json()) as {
      'subsonic-response': { album: Record<string, unknown> };
    };
    expect(body['subsonic-response'].album).not.toHaveProperty('title');
    expect(body['subsonic-response'].album).not.toHaveProperty('isDir');
    expect(body['subsonic-response'].album.name).toBe('Akane');
  });

  it('leaves an album used as a list child without a song key', async () => {
    // The counterweight to the fix. `listKey` seeds its key **unconditionally**, so
    // declaring `song` on the shared album builder would attach an empty `"song": []` to
    // every album in `getAlbumList2`, `getArtist` and `search2`/`search3` — a list of
    // albums that each claim to carry no songs, which is a different wrong answer.
    const body = (await (
      await successResponse(elList('albumList2', 'album', {}, [albumElement({ id: 'al:1', name: 'A', songCount: 12, duration: 3600 })]), {
        format: 'json',
      })
    ).json()) as {
      'subsonic-response': { albumList2: { album: Array<Record<string, unknown>> } };
    };
    expect(body['subsonic-response'].albumList2.album[0]).not.toHaveProperty('song');
  });

  it('drops null and undefined attributes but keeps zero', async () => {
    // `duration=0` means "not read yet" and clients tolerate it; a *missing*
    // duration is read as a malformed record and hides the track.
    const body = await (
      await successResponse(el('song', { id: 's:1', duration: 0, title: undefined, album: null }), { format: 'xml' })
    ).text();
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

  it('answers a credential failure with 200 and code=40', async () => {
    // The envelope is the contract, so a protocol failure is a 200 — including
    // `code=40`, which used to be a 401. Every real server (Navidrome, Gonic, Airsonic)
    // sends 200 here, and a client that treats a non-2xx as a transport fault cannot tell
    // a wrong password from a broken network: `fin` calls `.error_for_status()` before it
    // parses, so it reported a bare `401 Unauthorized` with no message on a server whose
    // credentials were simply wrong.
    const response = errorResponse(new SubsonicError(ErrorCode.WrongCredentials), { format: 'json' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { 'subsonic-response': { status: string; error: { code: number; message: string } } };
    expect(body['subsonic-response'].status).toBe('failed');
    expect(body['subsonic-response'].error.code).toBe(40);
    expect(body['subsonic-response'].error.message.length).toBeGreaterThan(0);
  });

  it('answers 429 only for a throttle, since a client has to be able to back off', async () => {
    // The one non-200 on this surface, and the reason it is the exception: throttling is a
    // transport condition, and a client that reads only the envelope cannot tell "you are
    // being throttled" from "you are wrong". Both are reported — 429 *and* a valid failed
    // envelope — because a client that only looks at one of them still needs the other.
    const throttled = errorResponse(new SubsonicError(ErrorCode.Generic, 'Too many requests.'), { format: 'json' }, true);
    expect(throttled.status).toBe(429);
    const body = (await throttled.json()) as { 'subsonic-response': { status: string; error: { code: number } } };
    expect(body['subsonic-response'].status).toBe('failed');
    expect(body['subsonic-response'].error.code).toBe(ErrorCode.Generic);

    // …and unthrottled it is a plain 200, so the status reports the transport condition
    // rather than the protocol one.
    const plain = errorResponse(new SubsonicError(ErrorCode.Generic), { format: 'json' });
    expect(plain.status).toBe(200);
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

  describe('short song ids', () => {
    it('derives a 24-char filename-safe id', () => {
      // A client files downloads under the id, and a path component over 255
      // bytes is ENAMETOOLONG with no server-side error — the defect this
      // scheme exists to fix.
      const id = deriveShortSongId(libraryId, path);
      expect(id).toMatch(/^s:[\w-]{22}$/);
      expect(id).toHaveLength(24);
      expect(isShortSongId(id)).toBe(true);
      expect(isShortSongId(encodeId(IdKind.Song, libraryId, path))).toBe(false);
      const longPath = `音楽/${'界'.repeat(120)}.flac`;
      expect(encodeId(IdKind.Song, libraryId, longPath).length).toBeGreaterThan(255);
      expect(deriveShortSongId(libraryId, longPath)).toHaveLength(24);
    });

    it('derives the same id for the same file, so a rescan re-attaches every annotation', () => {
      // The index drop keeps stars, play counts and bookmarks while deleting
      // the rows; the rescan recreates them. Byte-identical ids are what makes
      // that safe — a random id per index would orphan every one of them.
      expect(deriveShortSongId(libraryId, path)).toBe(deriveShortSongId(libraryId, path));
    });

    it('derives a different id for a different file or a different library', () => {
      // The same relative path in two libraries is two files, so the library
      // is part of the preimage rather than a prefix the hash cannot see.
      expect(deriveShortSongId(libraryId, 'other.flac')).not.toBe(deriveShortSongId(libraryId, path));
      expect(deriveShortSongId('other-library', path)).not.toBe(deriveShortSongId(libraryId, path));
    });

    it('matches SHA-256 truncated to 128 bits, computed independently', () => {
      // `node:crypto` is the oracle and the vendored `sha256.ts` is what
      // production runs. Agreeing here is what makes the derivation portable
      // across runtimes rather than an accident of one implementation.
      const digest = createHash('sha256').update(`${libraryId}\n${path}`, 'utf8').digest().subarray(0, 16);
      expect(deriveShortSongId(libraryId, path)).toBe(`s:${Buffer.from(digest).toString('base64url')}`);
    });

    it('is the only song id this server mints, and the reversible one is not it', () => {
      // The reversible form is retired with the rotation, so this is now a statement about what a
      // client can still be *holding* rather than about a lookup: a pre-rotation id is well-formed
      // and decodes cleanly, and no lookup resolves it. `songIdLookup.ts` asserts the second half
      // over real SQLite; what belongs here is that the two spellings cannot be confused.
      const reversible = encodeId(IdKind.Song, libraryId, path);
      expect(isShortSongId(reversible)).toBe(false);
      expect(reversible).not.toBe(deriveShortSongId(libraryId, path));
      // Still decodable, which is why a stale id reads as a well-formed request rather than garbage.
      expect(decodeId(reversible, IdKind.Song)).toEqual({ kind: IdKind.Song, libraryId, path });
    });
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

/**
 * The album id's round trip, and the payload rules `decodeId` imposes on it.
 *
 * ### Why this is a protocol test and not a mapper test
 *
 * Because the constraint is not ours. `encodeAlbumKey` writes into the `path` half of an encoded
 * id, and `decodeId` runs `normalizeRelativePath` over that string — refusing `.`, `..`, empty
 * segments, control characters and `%XX`. So an album name written into the payload literally is an
 * id this server itself cannot read back, and the failure is silent in the worst way: `getAlbum`
 * answers `code=70`, `getCoverArt` serves the placeholder, and nothing says the id was minted
 * here.
 *
 * Every name below is one that appears in a real library or a real title. `'`/`&'`/`,` are on most
 * of this product's own live folders — Japanese album and artist names carry them routinely — and
 * `.` and `..` are on every artist with an album called `Sgt. Pepper's` or a self-titled record.
 */
describe('the album id', () => {
  const LIBRARY = 'lib-1';
  const row = (
    over: Partial<{
      dir_path: string;
      album: string | null;
      album_ci: string | null;
      album_artist: string | null;
      album_artist_ci: string | null;
    }> = {},
  ) => ({
    dir_path: 'Some/Album',
    album: 'Album',
    album_ci: 'album',
    album_artist: null,
    album_artist_ci: null,
    ...over,
  });

  /**
   * Encode under a grouping, then decode, and hand back the key.
   *
   * Through the public surface only — `albumIdOf` and `decodeAlbumKey` — so a test cannot pass by
   * reading an intermediate representation this module happens to share.
   */
  async function roundTrip(albumRow: ReturnType<typeof row>, grouping: 'folder' | 'album' | 'album_artist'): Promise<string | null> {
    const id = albumIdOf(albumRow, LIBRARY, grouping);
    if (id === undefined) return null;
    const decoded = decodeId(id);
    expect(decoded.kind).toBe(IdKind.AlbumKey);
    return decodeAlbumKey(decoded.path);
  }

  it('round-trips names that a literal payload could not carry', async () => {
    // Each of these is refused by `normalizeRelativePath` in at least one position, so each is a
    // case where writing the name plainly produces an id the server cannot decode.
    const names = [
      'Ex-Otogibanashi',
      "Sgt. Pepper's Lonely Hearts Club Band",
      '..',
      'a/b',
      '100%',
      String.raw`a\b`,
      '超かぐや姫！',
      'TVアニメ『無職転生Ⅱ ～異世界行ったら本気だす～』 エンディングテーマコレクション',
      '「負けヒロインが多すぎる！」マケイン応援！カバーソングコレクション',
      '   leading and trailing   ',
    ];

    for (const name of names) {
      // An album name is keyed on its `_ci` twin, which is what the column holds.
      const albumRow = row({ album: name, album_ci: name.toLowerCase() });
      expect(await roundTrip(albumRow, 'album'), `album name ${JSON.stringify(name)} did not survive the round trip`).toBe(
        `album:${name.toLowerCase()}`,
      );
    }
  });

  it('keeps a colon in an album name, which is also the key separator', async () => {
    // The separator between the key's parts and the separator inside a name are the same character,
    // so the split has to be positional. `aa:` with no artist is the *absent* artist artist, and
    // `aa:artist:album` is a present one — a parser that split on the first `:` would read
    // `Ex-Otogibanashi: deluxe` as an artist called `Ex-Otogibanashi`.
    const deluxe = row({ album: 'Ex-Otogibanashi: deluxe', album_ci: 'ex-otogibanashi: deluxe' });
    expect(await roundTrip(deluxe, 'album')).toBe('album:ex-otogibanashi: deluxe');

    const withArtist = row({ album: 'Album', album_ci: 'album', album_artist: 'A: B', album_artist_ci: 'a: b' });
    expect(await roundTrip(withArtist, 'album_artist')).toBe('aa:a: b:album');
  });

  it('tells the three album_artist shapes apart, and an absent artist from an empty one', async () => {
    // Three distinct payloads, and the difference between them is a tag's absence — which is a
    // value in its own right. Collapsing "no album artist" and "an empty album artist" would merge
    // every untagged row into every album that happens to share its name.
    const absent = row({ album_artist: null, album_artist_ci: null });
    expect(await roundTrip(absent, 'album_artist')).toBe('aa:album');

    const empty = row({ album_artist: '', album_artist_ci: '' });
    // Treated as absent by the key, so it is the same group — asserted so a change that started
    // distinguishing them is a deliberate diff rather than a silent one.
    expect(await roundTrip(empty, 'album_artist')).toBe('aa:album');

    const present = row({ album_artist: 'Artist', album_artist_ci: 'artist' });
    expect(await roundTrip(present, 'album_artist')).toBe('aa:artist:album');
  });

  it('publishes no id for a row with no album tag, under a tag grouping', async () => {
    // Such a row is filtered out of every album list, so minting it an id would let a client drill
    // into an album nothing else can reach. Under `folder` it always has one, because the directory
    // is the album.
    // An **empty** tag as well as an absent one: the aggregates filter on `album_ci <> ''`, so a
    // group under the empty name would be a blank row at the top of every album list — the defect
    // `NodeDAO.listRoots` had with the library root.
    for (const untagged of [row({ album: null, album_ci: null }), row({ album: '', album_ci: '' })]) {
      expect(albumIdOf(untagged, LIBRARY, 'album')).toBeUndefined();
      expect(albumIdOf(untagged, LIBRARY, 'album_artist')).toBeUndefined();
    }
    const untagged = row({ album: null, album_ci: null });

    // `folder` mints the **original** id kind with the raw directory, byte for byte what this
    // server minted before the identity became configurable — which is what makes that setting a
    // real no-op for an existing deployment rather than a migration.
    const id = albumIdOf(untagged, LIBRARY, 'folder');
    expect(id).toBe(encodeId(IdKind.Album, LIBRARY, 'Some/Album'));
  });

  it('refuses a payload that is not one of the three shapes', () => {
    // The gate for untrusted input, and `null` is what becomes `code=70` at the call site rather
    // than a masked `500` from a query built out of a parsed fragment.
    for (const payload of ['', 'x', 'a/', '/b', 'a/b/c', 'aa/artist', 'aa/a/b/c', 'zz/album', 'a/b/c']) {
      expect(decodeAlbumKey(payload), `payload ${JSON.stringify(payload)} should not decode`).toBeNull();
    }
  });
});
