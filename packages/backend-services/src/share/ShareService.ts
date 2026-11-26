/**
 * Shares: a capability over a frozen selection of songs.
 *
 * Three decisions live here rather than in the route or the DAO:
 *
 * - **The id is random.** A share is its own credential, so it must not be derivable from
 *   the songs it names. `UUIDUtil` is 122 bits of randomness; a client cannot guess one by
 *   knowing a track id, which is exactly what an id built like an album's would allow.
 * - **A share never exceeds its owner's *current* grants.** The entries are resolved at read
 *   time and filtered against the owner's libraries, so revoking access revokes the share's
 *   reach. Freezing the ids at creation is right; freezing the authorization is not.
 * - **A deleted `songs` row is absent, not an error.** The join drops it (see the DAO), and
 *   the remaining entries still render. A share with every track deleted is an empty share,
 *   not a 404 — the link is still the user's, and the truth is that its tracks are gone.
 *
 * The service knows nothing about Subsonic error codes. It answers `null` for "not found or
 * not yours", and the endpoint is the one place that turns that into `code=70`.
 */
import { UUIDUtil } from '@rexezuge/shared';
import type { ShareRow, SongRow } from '@edge-sonic/backend-data/dao';

interface ShareView {
  readonly share: ShareRow;
  readonly songs: readonly SongRow[];
}

/**
 * The store port, as narrow as the two callers need it.
 *
 * Closures rather than the `ShareDAO` instance itself, because the composition root binds DAOs
 * as lazy thunks and a service that held one would force it to be constructed on every request
 * that touches a share. This is the shape `LibraryService` and `TreeService` already take.
 */
interface ShareStore {
  findById(id: string): Promise<ShareRow | null>;
  listForOwner(ownerUserId: string): Promise<ShareRow[]>;
  listEntries(shareId: string): Promise<Array<{ share_id: string; position: number; song_id: string }>>;
  listEntrySongs(shareId: string): Promise<SongRow[]>;
  listEntrySongsForOwner(ownerUserId: string): Promise<Array<SongRow & { share_id: string }>>;
  create(input: {
    id: string;
    ownerUserId: string;
    description: string | null;
    createdAt: number;
    expiresAt: number | null;
  }): Promise<ShareRow>;
  replaceEntries(shareId: string, songIds: readonly string[]): Promise<unknown>;
  update(id: string, input: { description: string | null; expiresAt: number | null }): Promise<ShareRow | null>;
  delete(ownerUserId: string, id: string): Promise<void>;
  recordVisit(id: string, now: number): Promise<ShareRow | null>;
}

interface ShareServiceDeps {
  readonly shares: ShareStore;
  readonly songs: {
    listIdsAcrossLibraries(ids: readonly string[]): Promise<SongRow[]>;
  };
  readonly libraries: {
    listForUser(userId: string): Promise<ReadonlyArray<{ id: string }>>;
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

class ShareService {
  constructor(private readonly deps: ShareServiceDeps) {}

  /**
   * The caller's own shares with their entries.
   *
   * Two statements for the whole list rather than one per share: `listEntrySongsForOwner` is
   * a single join, and the grouping happens in memory. A dashboard with a hundred shares
   * would otherwise be a hundred D1 calls against a ceiling of fifty.
   */
  public async list(ownerUserId: string): Promise<ShareView[]> {
    const shares = await this.deps.shares.listForOwner(ownerUserId);
    if (shares.length === 0) return [];

    const granted = await this.grantedLibraries(ownerUserId);
    const rows = await this.deps.shares.listEntrySongsForOwner(ownerUserId);
    const byShare = new Map<string, SongRow[]>();
    for (const row of rows) {
      if (!granted.has(row.library_id)) continue;
      const existing = byShare.get(row.share_id);
      if (existing) existing.push(row);
      else byShare.set(row.share_id, [row]);
    }
    return shares.map((share) => ({ share, songs: byShare.get(share.id) ?? [] }));
  }

  /**
   * Create a share from `requestedIds`.
   *
   * Returns `null` when an id does not resolve **or** names a library the owner cannot see.
   * The two are the same answer on purpose: "that song is not yours" and "that song does not
   * exist" already look identical everywhere else in the protocol.
   *
   * Ids are deduplicated in request order. A share is a selection, not a playlist — the same
   * track twice is a client mistake rather than an ordering intent.
   */
  public async create(
    ownerUserId: string,
    requestedIds: readonly string[],
    description: string | null,
    expiresAt: number | null,
  ): Promise<ShareView | null> {
    const songIds = [...new Set(requestedIds)];
    if (songIds.length === 0) return null;

    const rows = await this.deps.songs.listIdsAcrossLibraries(songIds);
    if (rows.length !== songIds.length) return null;

    const granted = await this.grantedLibraries(ownerUserId);
    if (rows.some((row) => !granted.has(row.library_id))) return null;

    // The batch read returns rows in index order, not request order, so re-order from the
    // caller's list: the share's order is what was sent.
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = songIds.map((id) => byId.get(id)!);

    const id = UUIDUtil.getRandomUUID();
    const share = await this.deps.shares.create({
      id,
      ownerUserId,
      description,
      createdAt: nowSeconds(),
      expiresAt,
    });

    try {
      await this.deps.shares.replaceEntries(
        id,
        ordered.map((row) => row.id),
      );
    } catch (error) {
      // A share row with no entries would be a live link that promises nothing. If the
      // entries cannot be written, remove the row so the caller's failure is the whole
      // truth, then re-throw so the endpoint reports it.
      try {
        await this.deps.shares.delete(ownerUserId, id);
      } catch {
        // The original failure is the one worth surfacing; a cleanup failure must not
        // replace it.
      }
      throw error;
    }

    return { share, songs: ordered };
  }

  /**
   * Update the description and/or expiry of a share the caller owns.
   *
   * `undefined` means "leave this field alone", `null` means "clear it" — the distinction
   * the protocol's optional parameters need. A share owned by somebody else is `null`, so
   * the endpoint answers the same `code=70` as for an id that does not exist.
   */
  public async update(
    ownerUserId: string,
    id: string,
    input: { description?: string | null; expiresAt?: number | null },
  ): Promise<ShareRow | null> {
    const existing = await this.deps.shares.findById(id);
    if (!existing || existing.owner_user_id !== ownerUserId) return null;
    return await this.deps.shares.update(id, {
      description: input.description === undefined ? existing.description : input.description,
      expiresAt: input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
    });
  }

  /**
   * Delete one of the caller's shares.
   *
   * The ownership check is a read first, unlike the DAO's `delete`, because the endpoint must
   * answer `code=70` for somebody else's share. A DAO delete that matched zero rows cannot tell
   * "already gone" from "not yours", so the answer would silently succeed for the wrong caller.
   * Returns `false` for both absent and not-owned, which are the same answer on the wire.
   */
  public async remove(ownerUserId: string, id: string): Promise<boolean> {
    const existing = await this.deps.shares.findById(id);
    if (!existing || existing.owner_user_id !== ownerUserId) return false;
    await this.deps.shares.delete(ownerUserId, id);
    return true;
  }

  /**
   * The landing-page read, which counts the visit.
   *
   * `recordVisit` performs the expiry check and the increment in one statement, so an
   * expired id and an unknown id both return `null` — there is nothing to distinguish.
   */
  public async visit(id: string): Promise<ShareView | null> {
    const share = await this.deps.shares.recordVisit(id, nowSeconds());
    return share === null ? null : await this.view(share);
  }

  /**
   * A share for media, without counting the visit.
   *
   * `visitCount` is a count of page views, and a stream is not a page view. Keeping the two
   * reads separate is what makes that statement literal rather than aspirational.
   */
  public async visible(id: string): Promise<ShareView | null> {
    const share = await this.deps.shares.findById(id);
    if (share === null) return null;
    if (share.expires_at !== null && share.expires_at <= nowSeconds()) return null;
    return await this.view(share);
  }

  private async view(share: ShareRow): Promise<ShareView> {
    const [songs, granted] = await Promise.all([this.deps.shares.listEntrySongs(share.id), this.grantedLibraries(share.owner_user_id)]);
    return { share, songs: songs.filter((song) => granted.has(song.library_id)) };
  }

  private async grantedLibraries(ownerUserId: string): Promise<Set<string>> {
    return new Set((await this.deps.libraries.listForUser(ownerUserId)).map((library) => library.id));
  }
}

export { ShareService };
export type { ShareView, ShareServiceDeps, ShareStore };
