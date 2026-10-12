-- ---------------------------------------------------------------------------
-- Address registry and mutable sign-in address (the kit's identity design)
-- ---------------------------------------------------------------------------
--
-- `users.email` is a free-form nullable column nobody resolves: login is by
-- username (`username_ci`), and nothing reads `email` back except the admin
-- list. That makes an address change a silent overwrite — the old address is
-- gone, rows written under it unattributable, and a reused address inherits
-- whatever the previous holder left behind.
--
-- So `email` freezes as the anchor (first-seen address, never rewritten by an
-- update path — and there is no update path today), `current_email` is the
-- mutable sign-in address, and `user_emails` is the registry: `is_verified = 1`
-- may authenticate, `0` is retained for attribution and re-pointable by a
-- later legitimate claimant. Converged from `@rexezuge/identity`'s
-- `UPGRADE_USER_IDENTITY` (phases 2–3; phase 1 is skipped because `users.id`
-- is already `TEXT PRIMARY KEY`, and no `*_user_id` backfill is needed because
-- every child already keys on `users(id)`).
--
-- Purely additive: one column, one index, one table, one index, one guarded
-- backfill. `users` parents ten tables, so it is never rebuilt — a parent
-- `DROP TABLE` becomes a cascading `DELETE` under D1's implicit transaction.
-- `NULL` emails stay `NULL`: SQLite `UNIQUE` permits multiple `NULL`s, so
-- address-less accounts neither conflict nor enter the registry.
--
-- The registry is written by `UserDAO.create` (verified, matching the backfill
-- below) beside the user row, in the same choke point that owns the insert.

ALTER TABLE users ADD COLUMN current_email TEXT;

UPDATE users SET current_email = lower(email) WHERE current_email IS NULL AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_current_email ON users(current_email);

CREATE TABLE IF NOT EXISTS user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_emails_user ON user_emails(user_id);

INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at)
SELECT lower(email), id, 1, created_at FROM users WHERE email IS NOT NULL;
