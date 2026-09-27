/**
 * The contracts `ScanService` needs from the outside world.
 *
 * Split out because they are a different kind of thing from the service. The service is a
 * state machine over a scan; these are the shape of that state machine's inputs, and
 * keeping them here means the file that documents what the service requires is also the
 * file a test's fakes are written against.
 *
 * They are structural rather than nominal on purpose. `ScanService` never imports a DAO -
 * it receives narrow interfaces - so a test can supply a store that answers only the
 * handful of queries its case needs, and a change to a DAO that the scan does not depend
 * on is not a change here.
 */
import type { LibraryRow, NodeRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import type { WebDavClient } from '@edge-sonic/webdav';

interface ScanNodeInput {
  libraryId: string;
  path: string;
  parentPath: string;
  name: string;
  mtimeMs: number | null;
  etag: string | null;
  depth: number;
  isScanned?: boolean;
}

interface ScanSongInput {
  id: string;
  libraryId: string;
  path: string;
  dirPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  contentType: string | null;
  suffix: string;
}

interface ScanNodeStore {
  find(libraryId: string, path: string): Promise<NodeRow | null>;
  listChildren(libraryId: string, parentPath: string): Promise<NodeRow[]>;
  listRoots(libraryId: string): Promise<NodeRow[]>;
  listFrontier(libraryId: string, limit: number): Promise<NodeRow[]>;
  upsertMany(inputs: readonly ScanNodeInput[]): Promise<number>;
  patch(libraryId: string, path: string, patch: { mtimeMs?: number | null; etag?: string | null; isScanned?: boolean }): Promise<void>;
  deleteChildrenNotIn(libraryId: string, parentPath: string, keepPaths: readonly string[]): Promise<number>;
  deleteSubtree(libraryId: string, path: string): Promise<number>;
  countByLibrary(libraryId: string): Promise<number>;
}

interface ScanSongStore {
  upsertFileFacts(inputs: readonly ScanSongInput[]): Promise<number>;
  deleteInDirectoryNotIn(libraryId: string, dirPath: string, keepPaths: readonly string[]): Promise<number>;
  deleteSubtree(libraryId: string, dirPath: string): Promise<number>;
  countByLibrary(libraryId: string): Promise<number>;
}

interface ScanStateStore {
  find(libraryId: string): Promise<ScanStateRow | null>;
  ensure(libraryId: string): Promise<ScanStateRow>;
  markScanning(libraryId: string, totalCount: number): Promise<void>;
  saveProgress(libraryId: string, scannedCount: number, cursorPath: string | null): Promise<void>;
  complete(libraryId: string, scannedCount: number): Promise<number>;
  fail(libraryId: string, error: string): Promise<void>;
}

interface ScanDeps {
  nodes: ScanNodeStore;
  songs: ScanSongStore;
  scanState: ScanStateStore;
  clientFor: (row: LibraryRow) => Promise<WebDavClient>;
  timeoutMs: number;
  /**
  Folders descended into per chunk. Sized against the 1,000-subrequest limit.
  */
  chunkFolders: number;
}

export type { ScanDeps, ScanNodeInput, ScanNodeStore, ScanSongInput, ScanSongStore, ScanStateStore };
