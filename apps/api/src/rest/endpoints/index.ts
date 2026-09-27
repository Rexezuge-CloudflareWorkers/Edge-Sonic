/**
 * The endpoint registry.
 *
 * One table, so `/rest/<name>` answers the same for `.view`, `.do`, and a bare
 * name, and so the full implemented surface is greppable in one place.
 *
 * ### Endpoints that are deliberately absent
 *
 * Videos, podcasts, shares, jukebox, chat, internet radio, last.fm info, and
 * lyrics are **not** implemented. They answer `code=70` from the dispatcher
 * rather than 404, which is the difference between "this server does not do that"
 * and "you typed the URL wrong" as far as a client is concerned.
 *
 * Transcoding is a separate matter: `stream` and `download` **are** implemented and
 * simply ignore `maxBitRate`/`format`, serving the original bytes with the
 * original `Content-Type`. See `media.ts` for why lying would be worse.
 */
import { ErrorCode, SubsonicError } from '@edge-sonic/subsonic';
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
 * Endpoints that are recognised but not implemented.
 *
 * Listed explicitly so the failure is a deliberate, documented `code=70` with a
 * name, rather than a generic "unknown endpoint" for something a client expects
 * to exist. A client that probes `getArtistInfo` then gets "not implemented here"
 * instead of "you are typing it wrong".
 */
const UNIMPLEMENTED: Readonly<Record<string, string>> = {
  getVideos: 'video streaming is not implemented',
  getVideoInfo: 'video streaming is not implemented',
  getCaptions: 'video streaming is not implemented',
  getLyrics: 'lyrics are not implemented',
  getLyricsBySongId: 'lyrics are not implemented',
  getArtistInfo: 'last.fm artist info is not implemented',
  getArtistInfo2: 'last.fm artist info is not implemented',
  getAlbumInfo: 'last.fm album info is not implemented',
  getAlbumInfo2: 'last.fm album info is not implemented',
  getSimilarSongs: 'last.fm similarity is not implemented',
  getSimilarSongs2: 'last.fm similarity is not implemented',
  getTopSongs: 'last.fm charts are not implemented',
  getShares: 'sharing is not implemented',
  createShare: 'sharing is not implemented',
  updateShare: 'sharing is not implemented',
  deleteShare: 'sharing is not implemented',
  getPodcasts: 'podcasts are not implemented',
  getNewestPodcasts: 'podcasts are not implemented',
  refreshPodcasts: 'podcasts are not implemented',
  createPodcastChannel: 'podcasts are not implemented',
  deletePodcastChannel: 'podcasts are not implemented',
  deletePodcastEpisode: 'podcasts are not implemented',
  downloadPodcastEpisode: 'podcasts are not implemented',
  jukeboxControl: 'the jukebox is not implemented',
  getInternetRadioStations: 'internet radio is not implemented',
  createInternetRadioStation: 'internet radio is not implemented',
  updateInternetRadioStation: 'internet radio is not implemented',
  deleteInternetRadioStation: 'internet radio is not implemented',
  getChatMessages: 'chat is not implemented',
  addChatMessage: 'chat is not implemented',
  getAvatar: 'avatars are not implemented',
  getOpenSubsonicExtensions: 'no extensions are advertised',
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

const ENDPOINTS: Record<string, RestHandler> = new Proxy(IMPLEMENTED, {
  get(target, property: string) {
    const handler = Reflect.get(target, property) as RestHandler | undefined;
    if (handler) return handler;
    // `hasOwn` rather than a `!== undefined` check: the record's type gives every key a
    // `string`, so the check reads as always-true to a reader and to the type checker
    // alike. What is being asked is "is this endpoint one we know about", which is a
    // question about the *key*.
    if (Object.hasOwn(UNIMPLEMENTED, property)) {
      const reason = UNIMPLEMENTED[property];
      return () => {
        throw new SubsonicError(ErrorCode.NotFound, `${property}: ${reason}.`);
      };
    }
    return undefined;
  },
  has(target, property: string) {
    return Reflect.has(target, property) || property in UNIMPLEMENTED;
  },
});

const ENDPOINT_NAMES: readonly string[] = [...Object.keys(IMPLEMENTED), ...Object.keys(UNIMPLEMENTED)].sort((a, b) => a.localeCompare(b));

export { ENDPOINTS, ENDPOINT_NAMES, UNIMPLEMENTED };
export type { RestHandler };
