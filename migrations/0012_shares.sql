-- ---------------------------------------------------------------------------
-- Shares: an unguessable capability over a frozen selection of songs
-- ---------------------------------------------------------------------------
--
-- A share is **not** a second identity system. There is no password, no Access
-- session, and no role: the id in the URL *is* the credential. That is why it is
-- a random UUID rather than a derived value -- an id minted from the song ids (as
-- an album id is) would let anyone who knows a track's id reconstruct a share.
--
-- The selection is frozen at creation. A later scan that adds a track to the same
-- album must not silently add it to a share somebody already sent, and a track
-- that is deleted or loses its owner's grant drops out of the rendered list
-- instead of 404-ing the whole share. So `share_entries.song_id` deliberately
-- has **no foreign key to `songs`**, exactly as `playlist_entries` and
-- `bookmarks` do not: the scan prunes `songs`, and a cascade would make a share
-- shorter with no record that it happened.
--
-- `expires_at` and `last_visited_at` are **epoch seconds**, like every other
-- timestamp in this schema. The protocol speaks epoch milliseconds for the
-- `expires` request parameter and ISO-8601 for the response fields; both
-- conversions happen at the endpoint boundary, in one named place. Storing
-- milliseconds here would make an expiry comparison silently valid for ~50,000
-- years the first time a caller forgot the factor.
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  -- NULL means never expires. A value at or before `now` is a share that is
  -- already over: it answers the same 404 as one that does not exist, because
  -- distinguishing them would say the id is real.
  expires_at INTEGER,
  last_visited_at INTEGER,
  -- Counted on the landing page, not on a stream. A share page fetched by a
  -- link preview counts; a track played from it does not. The distinction is
  -- stated on the wire in the guide because `visitCount` is a claim.
  visit_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS share_entries (
  share_id TEXT NOT NULL,
  -- Zero-based and part of the primary key, so the order is the share's rather
  -- than an insertion accident. Duplicates are removed before the write: a
  -- share is a selection, not a playlist.
  position INTEGER NOT NULL,
  song_id TEXT NOT NULL,
  PRIMARY KEY (share_id, position),
  -- The parent is `shares`, so a deleted share takes its entries with it.
  -- `song_id` is deliberately unconstrained; see the header.
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_entries_song ON share_entries(song_id);
