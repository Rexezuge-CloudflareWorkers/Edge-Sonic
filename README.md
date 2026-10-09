# Edge-Sonic

A Cloudflare Worker that speaks the **Subsonic REST API v1.16.1** over a **WebDAV**
library, plus the operator SPA that drives it. No transcoding: WebDAV is the only data
source, D1 is the index, and KV is a cache the server works without.

- **No transcoding.** `stream` and `download` are a `Range` passthrough to the origin.
  The response is the origin's response, so the `Content-Type` is never rewritten and
  seeking is a seek.
- **D1 is authoritative; KV is only a cache.** Every response is reconstructible from
  `nodes` + `songs` plus a `PROPFIND`, so a missing or broken `CACHE` binding costs
  latency and nothing else. `test/worker.int.test.ts` asserts byte-identical responses
  with a poisoned cache entry, a corrupt one, no binding at all, and every operation
  throwing.
- **The protocol, honestly.** A `NotFoundError` becomes `code=70`, an
  `UnauthorizedError` never becomes `code=40`, a library whose credential is wrong never
  tells the user their password is wrong, and an unknown id for a library you cannot see
  answers the same as an id that does not exist.
- **One key per feature.** Three Cloudflare Secrets Store entries — user passwords,
  WebDAV credentials, and remote (import) credentials — so rotating one never invalidates
  another. Merging them is forbidden, and each merge would cost something different.
- **Incremental, client-driven scanning.** A `Depth: 0` root probe settles "is anything
  new" in one subrequest; only folders whose mtime moved are descended. The scan itself is
  alarm-driven and chunked by a Durable Object, and `getScanStatus` advances a chunk when no
  `SCAN` binding is configured — so it still works under `wrangler dev` and in tests.

## Layout

```
apps/api          the Worker: /rest, /user, the SPA shell
apps/background   ScanWorker (a Durable Object), LibraryImportWorkflow, PlayCountImportWorker
apps/web          the operator SPA
packages/subsonic the protocol: ids, envelope, node model, serializers, MD5
packages/webdav   the 207 reader and the PROPFIND/GET client
packages/media-tags  MP3, FLAC, Ogg Vorbis/Opus header readers
packages/shared   i18n and small utilities
packages/backend-errors    the error taxonomy
packages/backend-data      DAOs over D1Queryable
packages/backend-runtime   config, KV cache + breaker, the worker base class
packages/backend-services  auth, library, scan, enrichment, composition
functions        the Cloudflare Pages catch-all that forwards to the Worker
scripts          repo tooling, grouped by who runs it; see scripts/README.md
migrations        a squashed baseline plus the import migration
test              the suite; runs under Node, no workerd
```

The layer rules are in [`eslint.config.mjs`](eslint.config.mjs); the workspace, the commands
and the gates are in [`docs/agents/repo/AGENTS.md`](docs/agents/repo/AGENTS.md), and the
rules the code is held to are split across the guides in [`AGENTS.md`](AGENTS.md).

## Getting started

```bash
pnpm install --ignore-scripts
pnpm run checks            # typecheck, lint, god-files, migrations, locales, shell, coverage, integration
pnpm run test              # the whole suite
pnpm run test:coverage     # with the coverage gate
pnpm run build             # builds apps/web into the worker
pnpm exec wrangler dev
```

`pnpm run build` is what makes a frontend change real: the SPA is embedded into the worker
at build time, and `verify:spa-shell` refuses a stale one.

## Configuring a deployment

`apps/api/wrangler.template.jsonc` is the starting point. It declares **three**
`secrets_store_secrets[]` entries, one per feature:

```jsonc
"secrets_store_secrets": [
  {
    "binding": "SUBSONIC_USER_ENCRYPTION_KEY_SECRET",
    "store_id": "00000000000000000000000000000000",
    "secret_name": "edge-sonic-subsonic-user-encryption-key"
  },
  {
    "binding": "WEBDAV_ENCRYPTION_KEY_SECRET",
    "store_id": "00000000000000000000000000000000",
    "secret_name": "edge-sonic-webdav-encryption-key"
  },
  {
    "binding": "SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET",
    "store_id": "00000000000000000000000000000000",
    "secret_name": "edge-sonic-subsonic-remote-encryption-key"
  }
]
```

The 32-zero `store_id` is a **placeholder**: `scripts/deploy/prepare-wrangler-config.ts` creates
the store and patches the real id in, then `scripts/deploy/init-secrets.ts` writes all three
32-byte key values. Use that exact sentinel — the patcher matches it by string equality, and any
other placeholder is skipped without a word and fails at deploy time as Cloudflare error 10182. Each value is AES-256-GCM under its own key: user passwords under one, WebDAV
credentials under the second, and an imported server's credentials under the third.

The SPA deploys to **two** targets. The Worker serves the SPA and the API from one
origin; `apps/web/wrangler.template.jsonc` is the Cloudflare Pages target, and
`functions/[[path]].ts` forwards `/user`, `/rest`, and `/health` to the Worker over a
service binding, because Pages would otherwise 404 them against static assets.

`ENVIRONMENT` is an **allow-list**, not a deny-list: `development` enables the
`DEV_AUTH_EMAIL` bypass and `production` is the only other value that does anything, so
`staging`, `Preview`, and a misspelled `prodcution` all fall on the safe side.
`AppConfiguration.validate()` runs once per isolate and reports the things that are
wrong but not fatal, including a bypass variable that is live in production and a
`base_url` that would send a stored credential to a private address.

## What is deliberately not here

No `dav-store`, no Worker cron triggers, no transcoding, no FTS5 (the migration names
it as the answer to the one search that has to scan), and no second identity system:
`/rest` is a Subsonic password and `/user` is Cloudflare Access, and neither credential
opens the other surface. The background work is alarm-driven — a Durable Object and a
Workflow — rather than a scheduled trigger, because it is a resumption of a bounded amount
of work rather than a clock.

The database **is** backed up: `backup-d1.yml` exports it daily at 04:15 UTC, encrypts,
and uploads to any combination of S3-compatible storage and WebDAV. Set at least
`BACKUP_ENCRYPTION_KEY` plus one destination — the preflight refuses to run a destination
without it, because the in-database credential encryption is described in the schema as
_obfuscation against a D1 dump_. See [`docs/db-backup-recovery.md`](docs/db-backup-recovery.md).

## Where to read next

[`AGENTS.md`](AGENTS.md) is the index, and it is the only file to read before knowing where
anything else lives.

| I want to…                               | Read                                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| work in this repository                  | [`docs/agents/repo/AGENTS.md`](docs/agents/repo/AGENTS.md)         |
| change what goes on the wire             | [`docs/agents/protocol/AGENTS.md`](docs/agents/protocol/AGENTS.md) |
| change the scan, the budget, or a status | [`docs/agents/scanning/AGENTS.md`](docs/agents/scanning/AGENTS.md) |
| write SQL or add a migration             | [`docs/agents/indexing/AGENTS.md`](docs/agents/indexing/AGENTS.md) |
| change what an album is                  | [`docs/agents/albums/AGENTS.md`](docs/agents/albums/AGENTS.md)     |
| read a byte out of an audio file         | [`docs/agents/media/AGENTS.md`](docs/agents/media/AGENTS.md)       |
| import from another Subsonic server      | [`docs/agents/import/AGENTS.md`](docs/agents/import/AGENTS.md)     |
| add a binding, a secret or a variable    | [`docs/agents/runtime/AGENTS.md`](docs/agents/runtime/AGENTS.md)   |
| write or trust an assertion              | [`docs/agents/testing/AGENTS.md`](docs/agents/testing/AGENTS.md)   |
| restore after a bad deploy               | [`docs/db-backup-recovery.md`](docs/db-backup-recovery.md)         |
