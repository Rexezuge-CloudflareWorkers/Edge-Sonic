/**
 * The request context every `/rest` handler receives.
 *
 * One object, resolved once by the dispatcher, so a handler never re-reads the
 * query string, never re-derives the response format, and never re-runs
 * authentication. Those three are the parts of the protocol that are easy to get
 * subtly wrong and that a handler has no business repeating.
 */
import type { LibraryRow, UserRow } from '@edge-sonic/backend-data/dao';
import type { AlbumIdentity } from './albumIdentity';

import type { SubsonicParams } from '@edge-sonic/subsonic';
import type { ResponseFormat } from '@edge-sonic/subsonic';
import type { LibraryService } from '@edge-sonic/backend-services/library';
import type { TreeService } from '@edge-sonic/backend-services/index';
import type { ScanService } from '@edge-sonic/backend-services/index';
import type { EnrichmentService } from '@edge-sonic/backend-services/index';
import type { ScanStub } from '../workers/scanStubs';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { SongDAO, PlaylistDAO, AnnotationDAO, PlayCountDAO, UserDAO, SongIndexDAO } from '@edge-sonic/backend-data/dao';

interface RestContext {
  readonly params: SubsonicParams;
  readonly format: ResponseFormat;
  readonly jsonpCallback: string | null;
  /**
  The original request, for the few endpoints that read a header (`Range`).
  */
  readonly request: Request;
  /**
  The authenticated user. Never null inside a handler.
  */
  readonly user: UserRow;
  /**
  `u` as sent by the client, which is what `owner` fields report.
  */
  readonly username: string;
  readonly client: string;
  readonly clientIp: string;
  readonly libraries: LibraryService;
  readonly tree: TreeService;
  readonly scan: ScanService;
  readonly enrichment: EnrichmentService;
  /**
   * The per-library scan worker stub, or `null` when no `SCAN` binding is
   * configured (tests, local dev). A present stub means scan/enrich/cover CPU
   * runs in the DO isolate; a null means the direct service runs in-fetch.
   */
  readonly scanStubFor: (libraryId: string) => ScanStub | null;
  readonly songs: SongDAO;
  /**
   * The aggregate reads: album pages, artist pages, genres.
   *
   * Separate from `songs` because they shape their own result - one page of albums, not
   * one song - and a caller that wants an album has to go through the group-then-rows
   * dance that lives on this one.
   */
  readonly songIndex: SongIndexDAO;
  readonly users: UserDAO;
  readonly playlists: PlaylistDAO;
  readonly annotations: AnnotationDAO;
  /**
   * Play counts, separately from the annotations.
   *
   * A second field rather than two more methods on `annotations`, because play counts carry **two
   * semantics** — a scrobble increments and an import overwrites — and the difference is silent.
   * `packages/backend-data/src/dao/playCounts.ts` is where those two writers sit next to each other;
   * handing them out from a class that also owns stars and bookmarks would put them back on
   * opposite sides of a boundary.
   */
  readonly playCounts: PlayCountDAO;
  /**
   * The KV cache, for the endpoints that read something expensive off the origin.
   *
   * Never load-bearing: a miss or an open circuit means the value is recomputed from
   * the origin, so a handler may use it to *avoid* work and must not use it to avoid
   * answering. `getCoverArt`'s embedded-artwork path is the current caller.
   */
  readonly cache: KvCache;
  /**
  Streaming timeout. Separate from the metadata timeout, which is much shorter.
  */
  readonly streamTimeoutMs: number;
  /**
  Page size already clamped to `MAX_PAGE_SIZE`.
  */
  readonly pageSize: (requested: number | undefined, fallback?: number) => number;
  /**
  The album identity for a library — its grouping, its key, and its id.

  **Resolved from the request's configuration and never from a module constant**, because a
  module-level value is resolved before `env` exists: that is how `LOG_LEVEL` was inert in
  every deployed Worker while passing validation. Built per call rather than stored on the
  context because the id embeds the library, and one context serves every library a caller may
  see.
  */
  readonly albumsFor: (library: LibraryRow) => AlbumIdentity;
}

export type { RestContext };


export {type LibraryRow, type UserRow} from '@edge-sonic/backend-data/dao';