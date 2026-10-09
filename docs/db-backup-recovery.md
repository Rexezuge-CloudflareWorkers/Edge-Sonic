# Database Backup, Restore, and Time Travel

Operational playbooks for the Edge-Sonic D1 database: backup automation, restore flows, and point-in-time recovery.

> [!NOTE]
> Backups run from GitHub Actions, so the repository you deploy from must already have the Cloudflare secrets in place: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — the same pair the [Continuous Deployment](../README.md) workflow uses. A token with `Account → D1: Edit` can do both jobs.

## GitHub Actions Backups

`.github/workflows/backup-d1.yml` exports the D1 database daily at **04:15 UTC** and uploads the encrypted dump to one or more destinations (S3-compatible storage and/or WebDAV). Both destinations are optional; enable either, or both.

The run is split into four jobs so a broken destination never blocks the other:

| Job             | Runs when                                   | What it does                                                     |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `check-secrets` | always                                      | Detects configured secrets; fails the run on an incomplete setup |
| `export-d1`     | Cloudflare credentials + encryption key set | Resolves the config, exports D1, compresses, encrypts            |
| `backup-s3`     | S3 secrets set                              | Uploads to S3 and prunes backups past the retention window       |
| `backup-webdav` | WebDAV secrets set                          | Uploads via rclone and prunes backups past the retention window  |

> [!IMPORTANT]
>
> - **Encryption is required, not optional.** The dump holds `users.password_ciphertext` and `libraries.password_ciphertext`, which are AES-256-GCM — and `migrations/0008_squash.sql` describes that as _"obfuscation against a D1 dump, not protection against a full worker compromise"_. An unencrypted backup inverts that assumption: dump plus the Secrets Store is a complete credential set for every Subsonic user and every WebDAV origin, and the WebDAV key is read on every scan and every stream. Separately, the dump is a listening history — `play_counts`, `play_queue`, `now_playing`, `stars`, `ratings`, `auth_failures`, and the full library topology in `nodes` and `songs`. So the workflow refuses to run without `BACKUP_ENCRYPTION_KEY`. See [What a backup contains](#what-a-backup-contains).
> - **An empty database is refused, not backed up.** Provisioning auto-creates a missing D1 database, so a backup scheduled against a fresh fork would create one and then upload its empty dump — a green run every night and nothing to restore. `export-d1` reads what the provisioning step reported creating and fails if the D1 database is in that list.
> - **Manual trigger required for the first run:** scheduled workflows only start after you run the workflow once from the Actions tab (GitHub → Actions → Backup D1 Database → Run workflow).
> - **Keep backups off this Cloudflare account.** The Worker, its D1 database, and the Secrets Store holding the WebDAV encryption key all live in one account. Storing backups in R2 in that _same_ account means a single suspension or ban takes down production and recovery alike. Use a different S3-compatible provider (AWS S3, Backblaze B2, MinIO) or a separate Cloudflare account.
> - **If you configure no destination at all, every backup job skips silently.** That is the intended state for a repository that does not want off-site backups — not a failure.

### Backup destination secrets

Add these to your fork (`Settings → Secrets and variables → Actions`).

#### Cloudflare (required)

These already exist for Continuous Deployment; the same values work here.

| Secret                  | Required | Description                                                  |
| ----------------------- | -------- | ------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | yes      | Token with `Account → D1: Edit` (deploy and backup share it) |
| `CLOUDFLARE_ACCOUNT_ID` | yes      | Your Cloudflare account ID                                   |

#### Encryption (required)

| Secret                  | Required | Description                                                                                                |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `BACKUP_ENCRYPTION_KEY` | yes      | Passphrase for AES-256-CBC (PBKDF2, 100k iterations). Losing it makes every backup permanently unreadable. |

#### S3-compatible storage (optional)

| Secret                 | Required     | Description                                                                                                                                  |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_ACCESS_KEY_ID`     | yes (for S3) | S3 access key ID                                                                                                                             |
| `S3_SECRET_ACCESS_KEY` | yes (for S3) | S3 secret access key                                                                                                                         |
| `S3_BUCKET`            | yes (for S3) | Bucket name                                                                                                                                  |
| `S3_REGION`            | no           | Defaults to `auto`, which is what R2 expects. Set it only for providers that need a concrete region (Backblaze B2: `us-west-000`, Wasabi, …) |
| `S3_ENDPOINT`          | no           | Custom endpoint URL. Required for S3-compatible services (MinIO, R2, Backblaze B2)                                                           |

Keep the bucket private. The workflow uploads with the `aws s3 cp` CLI, so bucket policy must allow `PutObject` and `DeleteObject` for the configured key.

Objects are written under `edge-sonic/production/` and the prune only ever considers that prefix — a bucket shared with another project is safe from it.

#### WebDAV (optional)

| Secret             | Required         | Description                                                                       |
| ------------------ | ---------------- | --------------------------------------------------------------------------------- |
| `WEBDAV_URL`       | yes (for WebDAV) | Endpoint URL (e.g. Nextcloud: `https://example.com/remote.php/dav/files/<user>/`) |
| `WEBDAV_USER`      | yes (for WebDAV) | Username                                                                          |
| `WEBDAV_PASSWORD`  | yes (for WebDAV) | Password                                                                          |
| `WEBDAV_VENDOR`    | no               | rclone vendor (`nextcloud`, `owncloud`, `other`). Defaults to `other`             |
| `WEBDAV_BASE_PATH` | no               | Base path for backups on the remote. Defaults to `edge-sonic`                     |

Backups land in `<WEBDAV_BASE_PATH>/production/`.

#### Common (optional)

| Secret                  | Required | Description                          |
| ----------------------- | -------- | ------------------------------------ |
| `BACKUP_RETENTION_DAYS` | no       | Days to keep backups. Defaults to 30 |

> [!WARNING]
> **GitHub automatically disables scheduled workflows after 60 days of repository inactivity.** If your fork receives no commits to the default branch for 60 days, the backup workflow (and every other cron-triggered workflow) is disabled, and you get an email beforehand. Periodically sync with upstream or re-enable it from the Actions tab. See [GitHub docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

### Backup features

- **Automatic daily backups** at 04:15 UTC, with a `check-secrets` preflight so misconfiguration fails fast with a named missing secret.
- **Fail-closed encryption.** Without `BACKUP_ENCRYPTION_KEY` the export job is skipped and a configured destination without a key fails the run — it never writes plaintext.
- **xz compression before encryption.** Chosen for ratio over speed: this runs once a day against a dump that is mostly SQL text, and LZMA typically beats gzip by 20–30% there.
- **Encryption before upload, always.** The passphrase comes from the environment via `openssl`'s `env:` source, never from argv — command-line arguments are visible to any process on the runner through `ps`.
- **The plaintext is deleted after encrypting.** `xz` leaves its input in place, so `encrypt-backup.ts` removes both `backup.sql` and `backup.sql.xz` explicitly; otherwise the plaintext survives into the artifact store the upload jobs read from.
- **One-day artifact retention.** The Actions artifact is the handoff between `export-d1` and the upload jobs, not the backup. The durable copy is whatever the destination holds; keeping a second encrypted dump in artifact storage for a month is one more place to leak one.
- **Per-destination isolation.** A broken S3 destination does not fail the WebDAV upload, or vice versa.

## What a backup contains

Everything in the D1 database, in one encrypted file.

| Table                                                            | Contents                                                       | Sensitivity                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `users`                                                          | Usernames, **encrypted** passwords, email, admin/enabled flags | Credentials (encrypted), PII              |
| `libraries`                                                      | WebDAV origins, paths, usernames, **encrypted** passwords      | Credentials (encrypted), network topology |
| `nodes`                                                          | Every folder path in every library                             | Library topology                          |
| `songs`                                                          | Every track's path, tags, duration, bitrate                    | Library contents                          |
| `play_counts`, `now_playing`, `play_queue`, `play_queue_entries` | What each user listens to, and when                            | Listening history                         |
| `stars`, `ratings`, `bookmarks`                                  | Per-user favourites, scores, playback positions                | Taste and usage history                   |
| `playlists`, `playlist_entries`                                  | User-created playlists                                         | Personal organization                     |
| `auth_failures`                                                  | Failed-authentication counters by identity                     | Security telemetry                        |
| `settings`                                                       | Server-wide settings                                           | Low                                       |

No credential is stored in plaintext — but that is exactly why the **backup** must be encrypted. The in-database encryption is described in the schema as _obfuscation against a D1 dump_, so it protects a database at rest and protects nothing once the dump is in someone else's hands.

Backups do **not** contain the Secrets Store. The two `*-encryption-key` secrets and the WebDAV signing secret live there, and a backup cannot be decrypted without `BACKUP_ENCRYPTION_KEY` (which is also not in the database).

## Restoring from a backup

> [!CAUTION]
> **A restore overwrites the live database.** Every row in the tables above is replaced with what the backup holds. If anything has been indexed, scanned, starred or played since the backup was taken, that is lost. Take a fresh export first if there is any doubt.

### 1. Get the dump out of storage and decrypt it

From S3:

```bash
aws s3 cp "s3://$S3_BUCKET/edge-sonic/production/edge-sonic_prod_<timestamp>.sql.xz.enc" ./backup.sql.xz.enc \
  ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"}
```

Then, with `BACKUP_ENCRYPTION_KEY` set to the passphrase:

```bash
# Remove both encryption layers, in reverse order.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in backup.sql.xz.enc -out backup.sql.xz -pass env:BACKUP_ENCRYPTION_KEY
unxz backup.sql.xz
```

### 2. Stop anything that writes

The Worker writes to D1 on every scan, and the scan is alarm-driven — a `SCAN` Durable Object keeps working until it is told not to. **Disable the deployed Worker first** (Cloudflare dashboard → Workers & Pages → your Worker → Deactivate), or the restore races an active scan and the result is a mixture of the two databases.

### 3. Restore

```bash
pnpm exec wrangler d1 execute DB --remote --file=./backup.sql
```

Then re-apply any migration newer than the backup's schema. A dump from an older deployment restores the schema **as it was**, and the Worker expects the current one — a missing column fails every statement that names it, which is the failure this project's own migration lock exists to prevent.

```bash
pnpm exec wrangler d1 migrations apply DB --remote
```

### 4. Rebuild the index

The dump restores `nodes` and `songs` as they were, so a consistent backup needs no rescan. If you are restoring into a database that has drifted, or from a dump whose index was incomplete, start a scan from the operator UI — the index is a materialized view, and WebDAV remains authoritative for what actually exists.

### 5. Re-enable and verify

```bash
curl -s "https://<your-worker>/rest/ping.view?u=<user>&p=<password>&v=1.16.1&c=restore-check&f=json"
```

Then browse in a real client. A restored `users` row whose password no longer decrypts — because the Secrets Store key was rotated after the backup was taken — will fail at `login` with no useful message, so check one known account before walking away.

## Time Travel

D1 has its own point-in-time recovery, and it is **not a substitute for the daily backup** on a Free-plan account.

| Plan         | Time Travel window |
| ------------ | ------------------ |
| Workers Free | **7 days**         |
| Workers Paid | 30 days            |

With the default `BACKUP_RETENTION_DAYS` of 30, Time Travel on Free covers roughly a fifth of the retention window, and it is gone entirely the moment the daily job fails. Treat Time Travel as the fast path for "something happened in the last week" and the backups as the record.

To restore to a point in time:

```bash
pnpm exec wrangler d1 time-travel restore <timestamp> --remote
```

List what is available first:

```bash
pnpm exec wrangler d1 time-travel list <database-name> --remote
```

Time Travel does not help with a **schema** mistake that is already applied — it rewinds the data, not the migrations. For that, restore from a backup taken before the migration, or add a new numbered migration; never edit an applied one (see `migrations/migrations.lock.json`).

## Verifying a backup

A backup you have never restored is a hypothesis. Once a month:

1. Decrypt one dump and check it is valid SQL — `head -50 backup.sql` should show `PRAGMA defer_foreign_keys=TRUE;` and `CREATE TABLE` statements.
2. Confirm the object dates in your destination advance daily and the oldest is within the retention window.
3. Restore it into a **throwaway** D1 database and run `pnpm exec wrangler d1 execute <scratch-db> --remote --file=./backup.sql`, then check the table count.

## Troubleshooting

| Symptom                                                     | Cause and fix                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Every job skipped, run green                                | No destination secret is set. Intentional — see [above](#backup-destination-secrets).                   |
| `check-secrets` fails on `BACKUP_ENCRYPTION_KEY`            | A destination is configured without an encryption key. Set it; the workflow will not upload plaintext.  |
| `check-secrets` fails on `CLOUDFLARE_API_TOKEN`             | A destination is configured without Cloudflare credentials. The token needs `Account → D1: Edit`.       |
| `export-d1` refuses with "created by the provisioning step" | The D1 database did not exist. Deploy once, then the next scheduled run backs it up.                    |
| `Resolve D1 Database` cannot read the database              | The Cloudflare token lacks `D1: Edit`, or the account id is wrong.                                      |
| S3 upload fails on an empty region                          | Set `S3_REGION`, or leave it unset — the default `auto` is what R2 expects.                             |
| `Upload Backup Artifact` fails with "no files found"        | The filename shape moved. It must match `edge-sonic_prod_*.sql.xz.enc`; see `scripts/backup/naming.ts`. |
| Decryption fails with a bad magic                           | `BACKUP_ENCRYPTION_KEY` is not the one used at backup time. It cannot be recovered.                     |
| WebDAV upload fails with 401                                | `WEBDAV_VENDOR` does not match the host, so rclone negotiates the wrong auth flavour. Try `nextcloud`.  |

## Related

- [`scripts/backup/`](../scripts/README.md) — the scripts, and why each one refuses rather than guesses.
- [`docs/agents/runtime/AGENTS.md`](agents/runtime/AGENTS.md) — bindings, secrets, and the subrequest ceiling.
