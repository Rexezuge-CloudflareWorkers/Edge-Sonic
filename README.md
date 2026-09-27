# Edge-Sonic

A Cloudflare Worker that speaks the **Subsonic REST API v1.16.1** over a **WebDAV**
library. No transcoding, no Durable Objects, no cron: WebDAV is the only data source,
D1 is the index, and KV is a cache the server works without.

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
- **One key per feature.** `SUBSONIC_USER_ENCRYPTION_KEY_SECRET` and
  `WEBDAV_ENCRYPTION_KEY_SECRET` are separate Cloudflare Secrets Store entries, so
  rotating one never invalidates the other. Merging them is forbidden.
- **Incremental, client-driven scanning.** A `Depth: 0` root probe settles "is anything
  new" in one subrequest; only folders whose mtime moved are descended. `getScanStatus`
  advances one chunk, so no cron, no Durable Object, and no scheduled trigger.

## Layout

```
apps/api          the Worker: /rest, /admin, the SPA shell
apps/web          the admin SPA
packages/subsonic the protocol: ids, envelope, node model, serializers, MD5
packages/webdav   the 207 reader and the PROPFIND/GET client
packages/media-tags  MP3, FLAC, Ogg Vorbis/Opus header readers
packages/shared   i18n and small utilities
packages/backend-errors    the error taxonomy
packages/backend-data      DAOs over D1Queryable
packages/backend-runtime   config, KV cache + breaker, the worker base class
packages/backend-services  auth, library, scan, enrichment, composition
migrations        one baseline schema
test              the suite; runs under Node, no workerd
```

The layer rules are in [`eslint.config.mjs`](eslint.config.mjs) and summarized in
[`AGENTS.md`](AGENTS.md).

## Getting started

```bash
pnpm install --ignore-scripts
pnpm run checks            # typecheck + lint + god-files + SPA shell
pnpm run test              # the whole suite
pnpm run test:coverage     # with the coverage gate
pnpm run build             # builds apps/web into the worker
pnpm exec wrangler dev
```

## Configuring a deployment

`apps/api/wrangler.template.jsonc` is the starting point. It declares two
`secrets_store_secrets[]` entries, one per feature:

```jsonc
"secrets_store_secrets": [
  { "store_id": "<store id>", "name": "SUBSONIC_USER_ENCRYPTION_KEY_SECRET" },
  { "store_id": "<store id>", "name": "WEBDAV_ENCRYPTION_KEY_SECRET" }
]
```

`scripts/init-secrets.ts` creates the store and writes both 32-byte keys. Each is
AES-256-GCM under its own key: user passwords under one, WebDAV credentials under the
other. The bindings they resolve to are named `edge-sonic-subsonic-user-encryption-key`
and `edge-sonic-webdav-encryption-key`.

`ENVIRONMENT` is an **allow-list**, not a deny-list: `development` enables the
`DEV_AUTH_EMAIL` bypass and `production` is the only other value that does anything, so
`staging`, `Preview`, and a misspelled `prodcution` all fall on the safe side.
`AppConfiguration.validate()` runs once per isolate and reports the things that are
wrong but not fatal, including a bypass variable that is live in production and a
`base_url` that would send a stored credential to a private address.

## What is deliberately not here

No `dav-store`, no Durable Objects, no cron triggers, no queues, no transcoding, no
FTS5 (the migration names it as the answer to the one search that has to scan), and no
second identity system: `/rest` is a Subsonic password and `/admin` is Cloudflare
Access, and neither credential opens the other surface.

## Where to read next

| Area                          | Guide                             |
| ----------------------------- | --------------------------------- |
| The Worker, routes, `/rest`   | [`apps/api/AGENTS.md`](apps/api/AGENTS.md) |
| The admin SPA                 | [`apps/web/AGENTS.md`](apps/web/AGENTS.md) |
| DAOs and the D1 rules         | [`packages/backend-data/AGENTS.md`](packages/backend-data/AGENTS.md) |
| Services, auth, composition   | [`packages/backend-services/AGENTS.md`](packages/backend-services/AGENTS.md) |
| Bindings, wrangler, secrets   | [`docs/agents/runtime/AGENTS.md`](docs/agents/runtime/AGENTS.md) |
| Tests and the doubles         | [`docs/agents/testing/AGENTS.md`](docs/agents/testing/AGENTS.md) |
| The invariants                | [`AGENTS.md`](AGENTS.md) |
