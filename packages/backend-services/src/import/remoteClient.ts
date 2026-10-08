/**
 * A read-only Subsonic client, for importing from *another* server.
 *
 * ### The mirror image of `dispatch.ts`
 *
 * Everything in `packages/subsonic` **builds** protocol elements; this **reads** them, off a server
 * this repository does not control. The shapes it must survive are the ones *other*
 * implementations produce, which is a strictly larger set than the ones this one does — so the
 * parse rules live in `remoteParse.ts` and this file owns only the transport: the URL, the token,
 * the timeout, the body limit, and the subrequest charge.
 *
 * That split is the reason both files exist rather than one. The parse half is **pure**, so it is
 * testable from the Node suite with no Workers runtime; the transport half is four `fetch` facts,
 * each of which is a decision about the *credential* rather than about the protocol.
 *
 * ### `f=json` is forced, and the parse is tolerant on purpose
 *
 * A shape comparison cannot be read off XML, so every call forces `f=json`. What comes back is
 * then parsed **defensively** — `remoteParse.ts` states why, and the two rules that matter are a
 * single-element list collapsing to a bare object, and a protocol error arriving as HTTP **200**.
 *
 * ### Token auth, so the password is never in the URL
 *
 * `t=md5(password + salt)` with a fresh random salt per call, which the protocol permits and which
 * is why this client never sends `p=`. A password in a query string lands in the remote's access
 * log, in every proxy's between here and there, and in whatever the remote's own request log
 * writes down — none of which is visible from here, which is what makes it the kind of thing
 * nobody notices until somebody reads a log. Asserted in `test/import-client.test.ts`.
 *
 * ### Every call is a subrequest, and charged **before** it is issued
 *
 * `onRequest` is invoked inside {@link RemoteSubsonicClient.call}, the one place a request is
 * issued — the same discipline `WebDavClient` follows and for the same reason: a charge per call
 * site is a dozen chances to forget one, and a forgotten charge is invisible until the platform
 * terminates the invocation. Charged *before* rather than after, because a charge that happens
 * once the work is done cannot stop the request that crosses the ceiling, which is the only
 * reason to count at all.
 *
 * ### The client is built per request and never cached
 *
 * It holds the plaintext password for its lifetime, so a client held on a Workflow instance or in
 * a module scope is a plaintext credential in a longer-lived scope than the one that fetched it.
 */
import { md5Hex } from '@edge-sonic/subsonic';
import { RemoteSubsonicError, asArray, bool, num, songsOf, str, toSong, unwrapEnvelope } from './remoteParse';
import type { RemoteAlbum, RemoteArtist, RemoteBookmark, RemotePlaylist, RemoteQueueEntry, RemoteSong } from './remoteParse';

const CLIENT_VERSION = '1.16.1';

/**
Client name, which some servers log and some show in an admin page.
*/
const CLIENT_NAME = 'EdgeSonicImport';

/**
The largest response this client will read. A 500-song album is ~150 KB of JSON.
*/
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;





/**
 * Coerce a protocol wrapper's child to an array.
 *
 * The single most important function in this file, because the failure it prevents is
 * silent: a one-entry playlist read as an object yields a playlist of zero songs, which is
 * indistinguishable from a playlist whose tracks did not resolve, and both look like an
 * import that worked.
 */

interface RemoteSubsonicClientOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  /**
   * Charged once per issued request, inside {@link RemoteSubsonicClient.call}.
   *
   * Not optional in practice: an import issues hundreds of requests against the Free plan's
   * 50-per-invocation external ceiling, and an unmetered client spends until the runtime
   * terminates the step with an error nothing can catch.
   */
  readonly onRequest: () => void;
}

/**
 * One remote instance.
 *
 * Deliberately not pooled or reused across credentials: it holds the plaintext password for
 * its lifetime, and a client that outlives the request that made it is a plaintext password
 * in a longer-lived scope.
 */
class RemoteSubsonicClient {
  constructor(private readonly options: RemoteSubsonicClientOptions) {}

  /**
   * Issue one protocol call and return its payload.
   *
   * `params` values that are `null` are **omitted** rather than sent as the string
   * `"null"` — the parameter's presence is what the remote reads, so sending it empty would
   * look like an empty id rather than an absent one.
   */
  public async call(endpoint: string, params: Record<string, string | number | null | undefined> = {}): Promise<Record<string, unknown>> {
    const salt = crypto.randomUUID().replaceAll('-', '');
    const query = new URLSearchParams({
      u: this.options.username,
      // Token auth rather than `p=`: a password in a query string is written to the remote's
      // access log and to every proxy's on the way there.
      t: md5Hex(this.options.password + salt),
      s: salt,
      v: CLIENT_VERSION,
      c: CLIENT_NAME,
      f: 'json',
    });
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) continue;
      query.set(key, String(value));
    }

    // Charged **before** the request, not after: a charge that happens once the work is done
    // cannot stop the request that crosses the ceiling, and the whole point of counting is to
    // refuse the request rather than to account for it afterwards.
    this.options.onRequest();

    const response = await this.fetchWithTimeout(`${this.options.baseUrl}/rest/${endpoint}.view?${query}`);
    const text = await this.readBounded(response);
    return unwrapEnvelope(text, response.status, endpoint);
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    try {
      return await fetch(url, { signal: timeout });
    } catch (error) {
      // An `AbortSignal.timeout` rejection is neither an `Error` shape nor an HTTP status, so
      // without this translation a slow remote is indistinguishable from an unreachable one
      // — and the operator is told to debug their own server, which is the mistake
      // `probeOutcome.ts` exists to prevent.
      if (timeout.aborted) throw new RemoteSubsonicError('The import source did not answer in time.', 408, null);
      throw new RemoteSubsonicError(`The import source could not be reached: ${error instanceof Error ? error.message : 'unknown error'}.`, null, null);
    }
  }

  /**
   * Read at most {@link MAX_RESPONSE_BYTES}.
   *
   * A remote server is an untrusted input as far as this Worker is concerned, and
   * `response.json()` on an unbounded body is an unbounded `JSON.parse` against a 10 ms CPU
   * budget. The limit is generous for any real Subsonic response and small enough that a
   * hostile or broken one cannot end the import.
   */
  private async readBounded(response: Response): Promise<string> {
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new RemoteSubsonicError('The import source returned a response too large to read.', null, null);
    }
    const text = await response.text();
    // **Bytes, not `String.length`.** This is a UTF-16 code-unit count compared against a byte
    // budget, so a body of 3-byte CJK characters — or 4-byte astral ones — passed at up to 3x the
    // intended size. The intent of the limit is stated three lines above; the measurement did not
    // match it. `BaseRoute.readJson` (`apps/api`) already measures `TextEncoder().encode(text)
    // .byteLength`, and the same limit implemented two ways is how one of them is wrong.
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new RemoteSubsonicError('The import source returned a response too large to read.', null, null);
    }
    return text;
  }

  // --- Reads, one per protocol endpoint. Each unwraps exactly one wrapper. ---

  public async getPlaylists(): Promise<RemotePlaylist[]> {
    const payload = await this.call('getPlaylists');
    const wrapper = (payload['playlists'] ?? {}) as Record<string, unknown>;
    return asArray(wrapper['playlist']).map((node) => ({
      id: str(node, 'id') ?? '',
      name: str(node, 'name'),
      comment: str(node, 'comment'),
      isPublic: bool(node, 'public'),
      songCount: num(node, 'songCount'),
    })).filter((playlist) => playlist.id !== '');
  }

  public async getPlaylist(id: string): Promise<RemoteSong[]> {
    const payload = await this.call('getPlaylist', { id });
    // `entry`, not `song`. The protocol's own child name for a playlist's members.
    return songsOf(payload['playlist'], 'entry');
  }

  /**
   * Stars, as three lists.
   *
   * `getStarred2` rather than `getStarred`: `AlbumID3` carries the album's own fields,
   * which is what makes an album matchable at all, and the ID3 variants are what a
   * tag-organized source publishes. Ratings ride along on the same songs, so the ratings
   * phase costs no extra call.
   */
  public async getStarred(): Promise<{ songs: RemoteSong[]; albums: RemoteAlbum[]; artists: RemoteArtist[] }> {
    const payload = await this.call('getStarred2');
    const wrapper = (payload['starred2'] ?? {}) as Record<string, unknown>;
    return {
      songs: songsOf(wrapper),
      albums: asArray(wrapper['album']).map((node) => ({
        id: str(node, 'id') ?? '',
        name: str(node, 'name'),
        artist: str(node, 'artist'),
        artistId: str(node, 'artistId'),
        songCount: num(node, 'songCount'),
      })).filter((album) => album.id !== ''),
      artists: asArray(wrapper['artist']).map((node) => ({ id: str(node, 'id') ?? '', name: str(node, 'name') })).filter((artist) => artist.id !== ''),
    };
  }

  public async getBookmarks(): Promise<RemoteBookmark[]> {
    const payload = await this.call('getBookmarks');
    const wrapper = (payload['bookmarks'] ?? {}) as Record<string, unknown>;
    return asArray(wrapper['bookmark'])
      .map((node) => ({ song: toSong(node), positionMs: num(node, 'position'), comment: str(node, 'comment') }))
      .filter((entry): entry is { song: RemoteSong; positionMs: number | null; comment: string | null } => entry.song !== null);
  }

  /**
   * The saved queue.
   *
   * `current` names the id of the entry currently playing and `position` is the offset into
   * **that** entry — so both are preserved rather than normalised. An offset that no longer has
   * a current entry is not ours to fix up: writing `0` against the first track would claim the
   * user was at the start of a queue they were halfway through.
   */
  public async getPlayQueue(): Promise<{ entries: RemoteQueueEntry[]; currentId: string | null; positionMs: number | null }> {
    const payload = await this.call('getPlayQueue');
    const wrapper = (payload['playQueue'] ?? {}) as Record<string, unknown>;
    return {
      entries: asArray(wrapper['entry'])
        .map((node) => ({ song: toSong(node), position: num(node, 'position') }))
        .filter((entry): entry is RemoteQueueEntry => entry.song !== null),
      currentId: str(wrapper, 'current'),
      positionMs: num(wrapper, 'position'),
    };
  }

  /**
   * One page of albums, in a **stable** order.
   *
   * `alphabeticalByName` rather than `random`, and that is the whole reason this walk is
   * resumable: `random` returns a different page every call, so an interrupted walk could
   * not be resumed without either repeating or skipping albums — and for a play-count
   * import, repeating means *adding to counts that were already set*.
   *
   * This is one call per page rather than a walk of `getArtists` → `getArtist` →
   * `getAlbum`, which is the difference between ~1 call per 500 albums and ~3 per album.
   */
  public async listAlbums(offset: number, size: number): Promise<RemoteAlbum[]> {
    const payload = await this.call('getAlbumList2', { type: 'alphabeticalByName', size, offset });
    const wrapper = (payload['albumList2'] ?? {}) as Record<string, unknown>;
    return asArray(wrapper['album'])
      .map((node) => ({
        id: str(node, 'id') ?? '',
        name: str(node, 'name'),
        artist: str(node, 'artist'),
        artistId: str(node, 'artistId'),
        songCount: num(node, 'songCount'),
      }))
      .filter((album) => album.id !== '');
  }

  /**
  One album's songs, which is where `playCount` is published.
  */
  public async getAlbumSongs(id: string): Promise<RemoteSong[]> {
    const payload = await this.call('getAlbum', { id });
    return songsOf(payload['album']);
  }
}

export { RemoteSubsonicClient };
// The parse half is re-exported here so a caller has **one** import for "talk to a remote
// Subsonic server" — and a second answer would be free to disagree about how a collapsed list is
// read. `remoteParse` is where the rules live; this is where the transport does.

export type { RemoteSubsonicClientOptions };


export {RemoteSubsonicError, asArray, unwrapEnvelope, type RemoteSong, type RemoteAlbum, type RemoteArtist, type RemotePlaylist, type RemoteBookmark, type RemoteQueueEntry} from './remoteParse';