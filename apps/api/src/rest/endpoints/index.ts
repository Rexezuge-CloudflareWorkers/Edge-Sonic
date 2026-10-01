/**
 * The endpoint registry.
 *
 * One table, so `/rest/<name>` answers the same for `.view`, `.do`, and a bare
 * name, and so the full implemented surface is greppable in one place.
 *
 * ### Endpoints this server does not have, and how each says so
 *
 * Videos, podcasts, shares, jukebox, chat, internet radio, last.fm info and lyrics are not
 * implemented — and **"not implemented" is three different answers**, because a client acts
 * on each one differently. They used to be one list answering `code=70`, which is the
 * right answer for none of them:
 *
 * - **`gone`** — retired from this server: HTTP 410 and a plain-text body. A client that
 *   keeps calling `getVideos` learns the endpoint is not coming back and can stop asking.
 *   Navidrome draws this line at video, captions and chat.
 * - **`not-implemented`** — deliberately not built: HTTP 501. The same idea with a different
 *   promise, "not now" rather than "never". Navidrome uses it for podcasts and the jukebox.
 * - **`not-authorized`** — the endpoint exists and this caller may not use it: `code=50`.
 *   Navidrome answers exactly that for the internet-radio mutations, and it is the only one
 *   of the three that is a statement about the *caller* rather than the server.
 * - **`empty`** — the endpoint exists, works, and has nothing to report, so it answers its
 *   own wrapper with no items. Not a failure at all, and `code=70` was actively wrong here:
 *   a client calling `getLyrics` for a track with no lyrics must render "no lyrics", not an
 *   error. Navidrome answers `{"lyrics":{"value":""}}`.
 *
 * The remaining entries are absent for want of an external service this server does not
 * have — last.fm, for artist and album info and for similarity — which is why they keep
 * `code=70` while `getLyrics` does not. Telling "I have no such integration" apart from "I
 * have it and there is nothing to say" is the whole point, and a single list could not say
 * either.
 *
 * Transcoding is a separate matter: `stream` and `download` **are** implemented and
 * simply ignore `maxBitRate`/`format`, serving the original bytes with the
 * original `Content-Type`. See `media.ts` for why lying would be worse.
 */
import { decodeId, ErrorCode, SubsonicError, elList } from '@edge-sonic/subsonic';
import { respond } from '../respond';
import type { RestContext } from '../context';
import { systemEndpoints } from './system';
import { browseEndpoints } from './browse';
import { structuredEndpoints } from './structured';
import { listEndpoints } from './lists';
import { searchEndpoints } from './search';
import { playlistEndpoints } from './playlists';
import { mediaEndpoints } from './media';
import { annotationEndpoints } from './annotations';
import { stateEndpoints } from './state';
import { userEndpoints } from './users';

/**
 * A handler returns either a finished `Response` (a binary endpoint such as
 * `stream`, which must not go through the envelope) or the envelope payload.
 *
 * The distinction is explicit rather than inferred from the endpoint name: a
 * binary endpoint wrapped in `<subsonic-response>` is unplayable, and the caller
 * of `stream` is the one place a mistake is immediately visible.
 */
type RestHandler = (context: RestContext) => Promise<Response | { response: Response }>;

/**
 * How an absent endpoint says so. See the module header for why these are four answers and
 * not one.
 *
 * - `gone` → HTTP 410, `text/plain`. Retired, and a client can stop asking.
 * - `not-implemented` → HTTP 501, `text/plain`. Deliberately not built.
 * - `not-authorized` → `code=50` in the envelope. The endpoint exists; this caller may not.
 * - `absent` → `code=70` in the envelope. No such integration on this server.
 */
type AbsentKind = 'gone' | 'not-implemented' | 'not-authorized' | 'absent';

interface AbsentEndpoint {
  readonly kind: AbsentKind;
  /**
   * Why, in a sentence an operator can read. It is not shown to the client — the client gets
   * a code or a status — but an entry with an empty reason is a placeholder, and a
   * placeholder in this map is indistinguishable from a deliberate one.
   */
  readonly reason: string;
}

/**
 * Endpoints that are recognised but not implemented.
 *
 * Listed explicitly so each failure is a deliberate, documented answer **with a name**,
 * rather than a generic "unknown endpoint" for something a client expects to exist. A client
 * that probes `getArtistInfo` then gets "not implemented here" instead of "you are typing it
 * wrong".
 *
 * The `kind` on each entry is the decision, and it is the thing worth getting right:
 * `getOpenSubsonicExtensions` once sat here with "no extensions are advertised", which
 * reads as "this server does not do that" when the truth was the opposite — it does the
 * thing and had nothing to say. `kind` is where that mistake becomes visible.
 */
const UNIMPLEMENTED: Readonly<Record<string, AbsentEndpoint>> = {
  getVideos: { kind: 'gone', reason: 'video streaming is not supported' },
  getVideoInfo: { kind: 'gone', reason: 'video streaming is not supported' },
  getCaptions: { kind: 'gone', reason: 'video streaming is not supported' },
  getChatMessages: { kind: 'gone', reason: 'chat is not supported' },
  addChatMessage: { kind: 'gone', reason: 'chat is not supported' },
  getPodcasts: { kind: 'not-implemented', reason: 'podcasts are not implemented' },
  getNewestPodcasts: { kind: 'not-implemented', reason: 'podcasts are not implemented' },
  refreshPodcasts: { kind: 'not-implemented', reason: 'podcasts are not implemented' },
  createPodcastChannel: { kind: 'not-implemented', reason: 'podcasts are not implemented' },
  deletePodcastChannel: { kind: 'not-implemented', reason: 'podcasts are not implemented' },
  deletePodcastEpisode: { kind: 'not-implemented', reason: 'podcasts are not implemented' },
  downloadPodcastEpisode: { kind: 'not-implemented', reason: 'podcasts are not implemented' },
  jukeboxControl: { kind: 'not-implemented', reason: 'the jukebox is not implemented' },
  createShare: { kind: 'not-implemented', reason: 'sharing is not implemented' },
  updateShare: { kind: 'not-implemented', reason: 'sharing is not implemented' },
  deleteShare: { kind: 'not-implemented', reason: 'sharing is not implemented' },
  getAvatar: { kind: 'not-implemented', reason: 'avatars are not implemented' },
  // The endpoint exists and this caller may not use it. The only kind that is a statement
  // about the caller rather than the server, which is why it gets `code=50` and not a
  // status: a client can act on it by asking somebody else.
  createInternetRadioStation: { kind: 'not-authorized', reason: 'internet radio is not enabled for this user' },
  updateInternetRadioStation: { kind: 'not-authorized', reason: 'internet radio is not enabled for this user' },
  deleteInternetRadioStation: { kind: 'not-authorized', reason: 'internet radio is not enabled for this user' },
  // `getOpenSubsonicExtensions` is deliberately **absent** from this list. It used to be
  // here with the reason "no extensions are advertised", which reads as "this server does
  // not do that" — but the endpoint exists, and the protocol says a server supporting no
  // extensions answers with an empty *list*. Answering `code=70` from the
  // capability-discovery call told a client it could not ask the question, which is the one
  // answer it cannot use. It is implemented in `system.ts`.
};

/**
 * An endpoint that exists, works, and has nothing to report.
 */
interface EmptyEndpoint {
  /**
   * The **wrapper element**, which is not the endpoint's name.
   *
   * `getLyrics` answers `<lyrics>`, `getTopSongs` answers `<topSongs>`, `getShares` answers
   * `<shares>`, and `getArtistInfo2` answers `<artistInfo2>` where `getArtistInfo` answers
   * `<artistInfo>`. Naming a wrapper after the endpoint it belongs to gets six of these
   * wrong, which is what happened first: the payload arrived under `getLyrics`, and a client
   * reading `lyrics` — the field the schema names — saw nothing at all. The two names are
   * independent, so both are stated.
   */
  readonly wrapper: string;
  /**
   * The wrapper's repeated child, or `null` when the payload is a record rather than a list.
   * A wrong key is not a cosmetic mistake: it is a field the client reads and that does not
   * exist.
   */
  readonly listKeys: readonly string[] | null;
  /**
   * The id kinds this endpoint accepts, or `null` when it takes no id.
   *
   * An endpoint that takes an `id` must still answer `code=70` for one it cannot resolve:
   * `getLyricsBySongId?id=x` asks for the lyrics *of a song that does not exist*, and "there
   * are no lyrics for that song" is a different claim. Navidrome draws this line **inside**
   * the empty result rather than outside it — it validates the id, then answers empty — so a
   * client that mistypes an id is told so rather than shown an empty panel.
   *
   * A list because the kind is not always one: `getArtistInfo` accepts an **artist or an
   * album** id, so demanding either specifically would refuse a valid request.
   */
  readonly idKinds: readonly string[] | null;
  /**
   * Parameters the endpoint cannot be asked without, whose absence is `code=10`.
   *
   * `getTopSongs` is keyed on an artist **name**, so it has no id to resolve — but it does
   * need `artist`, and answering `{"topSongs":{}}` to a request that named nobody told a
   * client the charts were empty when it had asked a different question. `code=10` says "name
   * an artist", which is the one thing the caller can act on.
   */
  readonly requiredParams: readonly string[];
  /**
   * Why there is nothing, for the operator rather than the client. The client gets an empty
   * wrapper, which is indistinguishable between "nothing to report" and "I have no such
   * integration" — so without this the distinction exists only in a diff.
   */
  readonly reason: string;
}

/**
 * Endpoints that work and have nothing to say.
 *
 * Not failures at all, which is why they are in neither `IMPLEMENTED` (they are not in
 * `system.ts`) nor `UNIMPLEMENTED`: a client calling `getLyrics` for an instrumental must
 * render "no lyrics", and `code=70` told it the server had failed. Navidrome answers
 * `{"lyrics":{"value":""}}` and `{"topSongs":{}}`.
 *
 * `getArtistInfo` and `getTopSongs` are here rather than in `UNIMPLEMENTED` despite having
 * no last.fm integration, which is the subtle half of this table. `getAlbumInfo` and
 * `getSimilarSongs` keep `code=70` and theirs do not, and the difference is deliberate: an
 * **artist page** and a **top-songs panel** are rendered from an empty result without an
 * error, while an album info card and a "more like this" row are *absence of a feature*, and
 * a client that hides the row when the server says `code=70` is doing the right thing.
 *
 * That line is a judgement about which empty answers read as "nothing here" and which read
 * as "not supported", and it is the reason `reason` is recorded on every entry: it is what
 * would be reviewed if one of these moved.
 */
const EMPTY_RESULT: Readonly<Record<string, EmptyEndpoint>> = {
  // No list at all: the protocol types this payload as a single `value`, so the wrapper is a
  // record and carries nothing. It also takes no `id` — the protocol lets it fall back to
  // `artist` and `title` — so there is nothing to validate.
  getLyrics: { wrapper: 'lyrics', listKeys: null, idKinds: null, requiredParams: [], reason: 'this track has no lyrics, and none are embedded' },
  getLyricsBySongId: { wrapper: 'lyricsList', listKeys: ['structuredLyrics'], idKinds: ['s'], requiredParams: [], reason: 'this track has no lyrics, and none are embedded' },
  // `getArtistInfo` takes an artist **or** an album id, per the protocol, so both are
  // accepted and neither is demanded.
  getArtistInfo: { wrapper: 'artistInfo', listKeys: ['biography', 'similarArtist'], idKinds: ['ar', 'al'], requiredParams: [], reason: 'last.fm artist info is not configured' },
  getArtistInfo2: { wrapper: 'artistInfo2', listKeys: ['biography', 'similarArtist'], idKinds: ['ar'], requiredParams: [], reason: 'last.fm artist info is not configured' },
  // Keyed on an artist *name*, so there is no id to resolve and nothing to validate.
  getTopSongs: { wrapper: 'topSongs', listKeys: ['song'], idKinds: null, requiredParams: ['artist'], reason: 'last.fm charts are not configured' },
  getInternetRadioStations: { wrapper: 'internetRadioStations', listKeys: ['internetRadioStation'], idKinds: null, requiredParams: [], reason: 'no internet radio stations are configured' },
  // Sharing is not implemented, so there is nothing to share and nothing to list. Here rather
  // than in `UNIMPLEMENTED` because this is a listing a client reads on every dashboard:
  // `code=70` there reads as "sharing is broken" rather than "you have no shares".
  getShares: { wrapper: 'shares', listKeys: ['share'], idKinds: null, requiredParams: [], reason: 'sharing is not implemented, so there are none' },
};

const IMPLEMENTED: Readonly<Record<string, RestHandler>> = {
  ...systemEndpoints,
  ...browseEndpoints,
  ...structuredEndpoints,
  ...listEndpoints,
  ...searchEndpoints,
  ...playlistEndpoints,
  ...mediaEndpoints,
  ...annotationEndpoints,
  ...stateEndpoints,
  ...userEndpoints,
};

/**
 * The two plain-text bodies, as Navidrome words them.
 *
 * Verbatim rather than invented: a client that pattern-matches a message — some log lines
 * do, and every operator who has ever read one has learned the exact phrasing — sees the
 * same text here as everywhere else. A reworded 501 is a 501 nobody recognises.
 */
const PLAIN_TEXT_BODIES: Readonly<Record<'gone' | 'not-implemented', { status: number; body: string }>> = {
  gone: { status: 410, body: 'This endpoint will not be implemented' },
  'not-implemented': { status: 501, body: 'This endpoint is not implemented, but may be in future releases' },
};

/**
 * The handler for an endpoint this server does not have.
 *
 * Three of the four kinds answer outside the envelope, and that is worth being explicit
 * about: `/rest` speaks the Subsonic dialect everywhere else, and `text/plain` on five
 * endpoints is a real exception. It is the one Navidrome makes, and it is worth it — a
 * `code=70` envelope is a *protocol* answer to "give me this", which invites the client to
 * report a server error, while 410 tells it the endpoint is retired and it can stop asking.
 * A client that parses only the envelope degrades to "could not read the response" on those
 * five, which is a worse failure than an error code but a rarer one, and it is bounded to
 * endpoints no client calls in a loop.
 *
 * `absent` stays in the envelope, because that one *is* a protocol-level statement: the
 * server has no such integration, and the client may ask a different server.
 */
function absentHandler(name: string, entry: AbsentEndpoint): RestHandler {
  if (entry.kind === 'gone' || entry.kind === 'not-implemented') {
    const { status, body } = PLAIN_TEXT_BODIES[entry.kind];
    return () =>
      Promise.resolve({
        response: new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
      });
  }
  if (entry.kind === 'not-authorized') {
    return () => {
      throw new SubsonicError(ErrorCode.NotAuthorized, 'User is not authorized for the given operation.');
    };
  }
  return () => {
    throw new SubsonicError(ErrorCode.NotFound, `${name}: ${entry.reason}.`);
  };
}

/**
 * The handler for an endpoint that exists and has nothing to report.
 *
 * @param wrapper The element to answer, which is **not** the endpoint's name — see
 *   `EmptyEndpoint.wrapper`, where six of the seven differ from it.
 * @param listKeys The wrapper's repeated child, or `null` for a record payload. `getLyrics`
 *   types its body as a single `value`, so there is nothing to list.
 * @param idKinds The id kinds this endpoint accepts, or `null` when it takes no id. An id
 *   that decodes to none of them is `code=70` rather than an empty answer — see
 *   `EmptyEndpoint.idKinds`.
 */
function emptyResultHandler(entry: EmptyEndpoint): RestHandler {
  const { wrapper, listKeys, idKinds, requiredParams } = entry;
  return async (context) => {
    // Required parameters first, so a request that named nobody is `code=10` rather than an
    // empty panel — the order the protocol reads them in, and the order that decides which of
    // the two claims the server is making about the request.
    for (const param of requiredParams) context.params.require(param);
    if (idKinds !== null) assertResolvableId(context, idKinds);
    return respond(context, elList(wrapper, listKeys === null ? undefined : listKeys, {}, []));
  };
}

/**
 * Throw unless `id` is present and decodes as one of `kinds`.
 *
 * Two different failures, and the order matters:
 *
 * - **Absent** → `code=10`. The parameter is required and was not sent, which is a client bug
 *   the client can fix.
 * - **Present but unresolvable** → `code=70`. It asked for something that does not exist,
 *   which is a different claim and deserves a different answer. Answering "nothing to report"
 *   here would tell a client that an instrumental has no lyrics when it actually asked for
 *   the lyrics of a song that is not in the library.
 *
 * `getLyricsBySongId?id=x` is the case that keeps this honest: "the lyrics of that song do
 * not exist" and "that song has no lyrics" look identical in a response and mean opposite
 * things to whoever is debugging a library.
 *
 * Each kind is *decoded* rather than the prefix read, because `decodeId` rejects a payload
 * that merely starts with the right prefix — a control character, a `%XX`, a NUL — and an
 * endpoint that accepted those would be validating an id it cannot then use.
 */
function assertResolvableId(context: RestContext, kinds: readonly string[]): void {
  const id = context.params.require('id');
  for (const kind of kinds) {
    try {
      decodeId(id, kind as never);
      return;
    } catch {
      // Try the next accepted kind; `getArtistInfo` takes an artist id *or* an album id.
    }
  }
  // No kind matched. Re-decode against the first so the thrown error is the one the rest of
  // the surface produces, rather than a message written here that could drift from it.
  decodeId(id, kinds[0] as never);
}

const ENDPOINTS: Record<string, RestHandler> = new Proxy(IMPLEMENTED, {
  get(target, property: string) {
    const handler = Reflect.get(target, property) as RestHandler | undefined;
    if (handler) return handler;
    // `hasOwn` rather than a `!== undefined` check: the record's type gives every key a
    // `string`, so the check reads as always-true to a reader and to the type checker
    // alike. What is being asked is "is this endpoint one we know about", which is a
    // question about the *key*.
    if (Object.hasOwn(UNIMPLEMENTED, property)) return absentHandler(property, UNIMPLEMENTED[property]);
    if (Object.hasOwn(EMPTY_RESULT, property)) return emptyResultHandler(EMPTY_RESULT[property]);
    return undefined;
  },
  has(target, property: string) {
    return Reflect.has(target, property) || property in UNIMPLEMENTED || property in EMPTY_RESULT;
  },
});

const ENDPOINT_NAMES: readonly string[] = [...Object.keys(IMPLEMENTED), ...Object.keys(UNIMPLEMENTED), ...Object.keys(EMPTY_RESULT)].sort((a, b) => a.localeCompare(b));

export { ENDPOINTS, ENDPOINT_NAMES, UNIMPLEMENTED, EMPTY_RESULT, PLAIN_TEXT_BODIES };
export type { RestHandler, AbsentKind, AbsentEndpoint };
