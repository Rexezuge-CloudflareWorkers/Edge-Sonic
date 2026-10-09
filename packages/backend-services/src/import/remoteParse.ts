/**
 * Parsing a Subsonic response from a server this repository does not control.
 *
 * ### Why this is a module and not the client's own helpers
 *
 * Because it is **pure** — no `fetch`, no credential, no state — and every rule in it is a statement
 * about the *protocol* rather than about this client. That makes it testable from the Node suite
 * with no Workers runtime and no double, which is the same reason `packages/subsonic` is Layer 0
 * and holds everything else protocol-shaped.
 *
 * ### Two shapes a server may answer, and both are ordinary
 *
 * 1. **A single-element list collapses to a bare object.** `getPlaylist` with one entry returns
 *    `{"entry": {…}}` where this server would return `[{…}]`. Read naively, a one-track playlist
 *    imports as an **empty** one — indistinguishable from a playlist whose tracks did not resolve,
 *    and both look like an import that worked. `asArray` is the whole defence, and every read of a
 *    repeated child goes through it.
 * 2. **A wrapper is sometimes absent.** `getBookmarks` on a server with no bookmarks may omit the
 *    key entirely. An absent key is `[]`, because "nothing to report" is not a failure.
 *
 * The alternative — asserting the shape and failing loudly — is right for *this* server's output
 * and wrong for a remote's, because the remote's output is not a defect when it differs.
 *
 * ### And a protocol error arrives as HTTP **200**
 *
 * `{"status": "failed", "error": {…}}` with a 200 status code, so a client that checks only the
 * HTTP status reads an error as an empty payload. For `getPlaylists` that is indistinguishable
 * from a server with no playlists, and the import would then report success having imported
 * nothing. So {@link unwrapEnvelope} checks `status` and refuses — which is why it is here and
 * not left to each call site.
 */
/**
One song as a remote server describes it — enough to match on, and nothing more.
*/
interface RemoteSong {
  readonly id: string;
  /**
   * The remote's library-relative path, when it publishes one.
   *
   * **Often absent, and that is worth knowing before designing around it.** The Subsonic
   * schema has `Child.path`, and Navidrome emits it — but *this* server deliberately does
   * not (`builders.ts`: publishing it "leaks the storage layout of someone's WebDAV
   * bucket"). So path matching works against most third-party sources and **never** against
   * another Edge-Sonic, which is backwards from the intuition that "the same product means
   * the same ids".
   */
  readonly path: string | null;
  readonly title: string | null;
  readonly album: string | null;
  readonly artist: string | null;
  readonly track: number | null;
  readonly discNumber: number | null;
  readonly duration: number | null;
  /**
  `Child.playCount`. Optional in practice — a server may omit it entirely.
  */
  readonly playCount: number | null;
  readonly userRating: number | null;
  readonly starred: string | null;
}

interface RemoteAlbum {
  readonly id: string;
  readonly name: string | null;
  readonly artist: string | null;
  readonly artistId: string | null;
  readonly songCount: number | null;
}

interface RemoteArtist {
  readonly id: string;
  readonly name: string | null;
}

interface RemotePlaylist {
  readonly id: string;
  readonly name: string | null;
  readonly comment: string | null;
  readonly isPublic: boolean;
  readonly songCount: number | null;
}

interface RemoteBookmark {
  readonly song: RemoteSong;
  readonly positionMs: number | null;
  readonly comment: string | null;
}

/**
 * One play-queue entry: a **`Child`**, plus the `position` OpenSubsonic adds to it.
 *
 * ### Why the whole `Child` and not `{ id, position }`
 *
 * Because a `Child` is what the protocol declares `playQueue.entry` to be, and it is what a
 * server that supports `Child.path` actually sends — `id`, `title`, `album`, `artist`, `path`
 * and the rest, all on one element.
 *
 * Narrowing it to `{ id, position }` is the plausible-looking mistake, and it is **total**: the
 * matcher has nothing to match on, every entry resolves to nothing, and the phase writes an
 * **empty queue while reporting success**. The queue is the one category where a shorter list is
 * not a partial result but a different object — a queue is a *sequence with a current position*,
 * so an empty one resumes playback from nothing.
 *
 * So the port carries the `Child` and the position, and the phase matches on the song.
 */

/**
 * One play-queue entry: a **`Child`**, plus the `position` OpenSubsonic adds to it.
 *
 * ### Why the whole `Child` and not `{ id, position }`
 *
 * Because a `Child` is what the protocol declares `playQueue.entry` to be, and it is what a
 * server that supports `Child.path` actually sends — `id`, `title`, `album`, `artist`, `path`
 * and the rest, all on one element.
 *
 * Narrowing it to `{ id, position }` is the plausible-looking mistake, and it is **total**: the
 * matcher has nothing to match on, every entry resolves to nothing, and the phase writes an
 * **empty queue while reporting success**. The queue is the one category where a shorter list is
 * not a partial result but a different object — a queue is a *sequence with a current position*,
 * so an empty one resumes playback from nothing.
 *
 * So the port carries the `Child` and the position, and the phase matches on the song.
 */
interface RemoteQueueEntry {
  readonly song: RemoteSong;
  readonly position: number | null;
}

/**
 * Coerce a protocol wrapper's child to an array.
 *
 * The single most important function in this file, because the failure it prevents is
 * silent: a one-entry playlist read as an object yields a playlist of zero songs, which is
 * indistinguishable from a playlist whose tracks did not resolve, and both look like an
 * import that worked.
 */
function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
Read a string attribute, tolerating a number or an absent key.
*/
function str(node: unknown, key: string): string | null {
  if (!node || typeof node !== 'object') return null;
  const value = (node as Record<string, unknown>)[key];
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
Read a numeric attribute, tolerating a numeric string — some servers send counts as text.
*/
function num(node: unknown, key: string): number | null {
  if (!node || typeof node !== 'object') return null;
  const value = (node as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function bool(node: unknown, key: string): boolean {
  if (!node || typeof node !== 'object') return false;
  return (node as Record<string, unknown>)[key] === true || (node as Record<string, unknown>)[key] === 'true';
}

function toSong(node: unknown): RemoteSong | null {
  const id = str(node, 'id');
  if (id === null) return null;
  return {
    id,
    path: str(node, 'path'),
    title: str(node, 'title'),
    album: str(node, 'album'),
    artist: str(node, 'artist'),
    track: num(node, 'track'),
    discNumber: num(node, 'discNumber'),
    duration: num(node, 'duration'),
    playCount: num(node, 'playCount'),
    userRating: num(node, 'userRating'),
    starred: str(node, 'starred'),
  };
}

/**
 * Songs out of a wrapper's repeated child.
 *
 * @param childKey **Not** always `song`. `getPlaylist` names its children `entry`, while
 *   `getAlbum` and `getStarred2` name them `song`. A helper hardcoded to `song` returns `[]` for
 *   every playlist — which is the one-line difference between importing a playlist and silently
 *   reporting that it had none, and which is why the key is a parameter rather than a constant.
 *
 * Drops the ones with no id: an entry with no id cannot be matched against anything local, and
 * keeping it would put `undefined` into an `id IN (...)`.
 */
function songsOf(wrapper: unknown, childKey: 'song' | 'entry' = 'song'): RemoteSong[] {
  if (!wrapper || typeof wrapper !== 'object') return [];
  return asArray((wrapper as Record<string, unknown>)[childKey])
    .map(toSong)
    .filter((song): song is RemoteSong => song !== null);
}

/**
A fault from the remote, carrying what an operator can act on.
*/
/**
 * The envelope's own attributes, which are never the payload.
 *
 * A **keep**-list's complement: anything named here is dropped from the returned object.
 *
 * Spelled out rather than inferred from the type, and a **drop**-list rather than an omit-destructure,
 * for one reason: an omit-destructure has to name every attribute to remove it, which means a
 * *future* envelope attribute is returned to the caller by default — and the direction that leaks
 * is the one nobody notices. Here an attribute nobody thought of is dropped unless it is listed.
 *
 * The five below are all the protocol defines on `subsonic-response`. `error` is deliberately
 * **absent**: it only appears on a `failed` envelope, which is refused before this runs, so
 * stripping it could only ever hide a diagnostic that is already an exception.
 */
const ENVELOPE_ATTRIBUTES: ReadonlySet<string> = new Set(['status', 'version', 'type', 'serverVersion', 'openSubsonic']);

/**
A fault from the remote, carrying what an operator can act on.
*/

class RemoteSubsonicError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly remoteCode: string | null,
  ) {
    super(message);
    this.name = 'RemoteSubsonicError';
  }
}

/**
 * Unwrap `{"subsonic-response": {...}}` and refuse a protocol-level error.
 *
 * A Subsonic error arrives as **HTTP 200** with `status: "failed"` and an `error` object, so
 * a client that only checks the HTTP status reads an error as an empty payload — which for
 * `getPlaylists` is indistinguishable from a server with no playlists, and would start an
 * import that imports nothing and reports success.
 */
function unwrapEnvelope(text: string, httpStatus: number, endpoint: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON body from a server that was asked for JSON is almost always an HTML error
    // page from a proxy, and saying so is more use to an operator than "parse error".
    throw new RemoteSubsonicError(
      `The import source answered ${endpoint} with a non-JSON body (HTTP ${httpStatus}). It may not be a Subsonic server, or a proxy in front of it returned an error page.`,
      httpStatus,
      null,
    );
  }

  const envelope = (parsed as Record<string, unknown> | null)?.['subsonic-response'];
  if (!envelope || typeof envelope !== 'object') {
    throw new RemoteSubsonicError(`The import source answered ${endpoint} without a subsonic-response envelope.`, httpStatus, null);
  }
  const body = envelope as Record<string, unknown>;
  if (body['status'] !== 'ok') {
    const error = body['error'];
    const code = error && typeof error === 'object' ? str(error, 'code') : null;
    const message = error && typeof error === 'object' ? str(error, 'message') : null;
    throw new RemoteSubsonicError(
      `The import source refused ${endpoint}: ${message ?? `error ${code ?? httpStatus}`}. Check the username and password.`,
      httpStatus,
      code,
    );
  }

  // The envelope's own attributes are **not** the payload, and returning them would let a caller
  // read `status: 'ok'` as a result — or `version` as an album list. Stripped here, once, where the
  // shape is known, rather than at each of the seven call sites (seven chances to forget, and one
  // caller that reads `status: 'ok'` as an album).
  //
  // Built by **copying the keys the protocol defines**, not by destructuring the five to omit:
  // an omit-list needs every one of them renamed to `_`-prefixed bindings, which is five unused
  // variables the linter is right to complain about — and it silently keeps working when a
  // *sixth* envelope attribute appears, which is the direction that leaks. A `delete` per known
  // key is the same list with the same weakness; this one is a **keep**-list, so an attribute
  // nobody thought of is dropped by default.
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!ENVELOPE_ATTRIBUTES.has(key)) payload[key] = value;
  }
  return payload;
}

// The readers are exported individually rather than only through `remoteClient`, so a test can
// reach a pure rule without constructing a client. `str`, `num`, `bool` and `toSong` are internal
// in spirit but exported for exactly that reason: the fixtures in `test/import-client.test.ts`
// read real remote responses, and a rule that can only be reached by making a request is a rule
// that needs a network to be tested.
export { asArray, bool, num, songsOf, str, toSong, unwrapEnvelope, ENVELOPE_ATTRIBUTES, RemoteSubsonicError };
// `RemoteSong` and the other row types are declared here because the readers **build** them, and a
// reader that could not describe what it produces would be a reader nobody can check.
export type { RemoteSong, RemoteAlbum, RemoteArtist, RemotePlaylist, RemoteBookmark, RemoteQueueEntry };
