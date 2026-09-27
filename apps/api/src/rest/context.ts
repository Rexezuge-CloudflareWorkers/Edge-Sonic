/**
 * The request context every `/rest` handler receives.
 *
 * One object, resolved once by the dispatcher, so a handler never re-reads the
 * query string, never re-derives the response format, and never re-runs
 * authentication. Those three are the parts of the protocol that are easy to get
 * subtly wrong and that a handler has no business repeating.
 */
import type { UserRow } from '@edge-sonic/backend-data/dao';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { SubsonicParams } from '@edge-sonic/subsonic';
import type { ResponseFormat } from '@edge-sonic/subsonic';
import type { LibraryService } from '@edge-sonic/backend-services/library';
import type { TreeService } from '@edge-sonic/backend-services/index';
import type { ScanService } from '@edge-sonic/backend-services/index';
import type { EnrichmentService } from '@edge-sonic/backend-services/index';
import type { SongDAO, PlaylistDAO, AnnotationDAO, UserDAO } from '@edge-sonic/backend-data/dao';

interface RestContext {
  readonly params: SubsonicParams;
  readonly format: ResponseFormat;
  readonly jsonpCallback: string | null;
  /** The original request, for the few endpoints that read a header (`Range`). */
  readonly request: Request;
  /** The authenticated user. Never null inside a handler. */
  readonly user: UserRow;
  /** `u` as sent by the client, which is what `owner` fields report. */
  readonly username: string;
  readonly client: string;
  readonly clientIp: string;
  readonly libraries: LibraryService;
  readonly tree: TreeService;
  readonly scan: ScanService;
  readonly enrichment: EnrichmentService;
  readonly songs: SongDAO;
  readonly users: UserDAO;
  readonly playlists: PlaylistDAO;
  readonly annotations: AnnotationDAO;
  /** Streaming timeout. Separate from the metadata timeout, which is much shorter. */
  readonly streamTimeoutMs: number;
  /** Page size already clamped to `MAX_PAGE_SIZE`. */
  readonly pageSize: (requested: number | undefined, fallback?: number) => number;
}

export type { RestContext };
export type { LibraryRow, UserRow };
