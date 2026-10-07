# Edge-Sonic — Index

**Edge-Sonic** serves the Subsonic REST API v1.16.1 from a WebDAV library, and an operator
SPA behind Cloudflare Access. WebDAV is the only data source, D1 is the authoritative index,
and KV is a cache the server is built to work without.

This file is an index and the commit policy. Everything else has a home, and each home has a
reader: the split is by **who needs the answer**, not by directory.

## Guides

### Cross-cutting

| Area | Guide |
| --- | --- |
| Working in this repository: workspace, commands, layers, gates | [`docs/agents/repo/AGENTS.md`](docs/agents/repo/AGENTS.md) |
| Bindings, secrets, configuration, DI, the KV cache | [`docs/agents/runtime/AGENTS.md`](docs/agents/runtime/AGENTS.md) |
| The suite, the thresholds, the doubles | [`docs/agents/testing/AGENTS.md`](docs/agents/testing/AGENTS.md) |
| Deploying and undoing a deployment | [`README.md`](README.md), [`docs/db-backup-recovery.md`](docs/db-backup-recovery.md) |

### By audience

| Area | Guide |
| --- | --- |
| The Subsonic wire: ids, node model, serializers, the endpoint registry | [`docs/agents/protocol/AGENTS.md`](docs/agents/protocol/AGENTS.md) |
| Scanning: the walk, the chunk budget, what a status promises | [`docs/agents/scanning/AGENTS.md`](docs/agents/scanning/AGENTS.md) |
| D1, the DAOs, and the migrations | [`docs/agents/indexing/AGENTS.md`](docs/agents/indexing/AGENTS.md) |
| What an album **is**: grouping key, id, track order | [`docs/agents/albums/AGENTS.md`](docs/agents/albums/AGENTS.md) |
| Tags, enrichment and artwork | [`docs/agents/media/AGENTS.md`](docs/agents/media/AGENTS.md) |
| Import: moving a player's data in from another Subsonic server | [`docs/agents/import/AGENTS.md`](docs/agents/import/AGENTS.md) |

### By area

| Area | Guide |
| --- | --- |
| API worker, routes, `/rest`, `/user` | [`apps/api/AGENTS.md`](apps/api/AGENTS.md) |
| Operator SPA | [`apps/web/AGENTS.md`](apps/web/AGENTS.md) |
| Background Workers: the scan DO and the import Workflow | [`apps/background/AGENTS.md`](apps/background/AGENTS.md) |
| DAOs over D1 | [`packages/backend-data/AGENTS.md`](packages/backend-data/AGENTS.md) |
| Services, auth, composition | [`packages/backend-services/AGENTS.md`](packages/backend-services/AGENTS.md) |

### Packages

| Package | Guide |
| --- | --- |
| `subsonic` | [`packages/subsonic/README.md`](packages/subsonic/README.md) |
| `media-tags` | [`packages/media-tags/README.md`](packages/media-tags/README.md) |
| `webdav` | [`packages/webdav/README.md`](packages/webdav/README.md) |
| `backend-runtime` | [`packages/backend-runtime/README.md`](packages/backend-runtime/README.md) |
| `backend-errors` | [`packages/backend-errors/README.md`](packages/backend-errors/README.md) |
| `shared` | [`packages/shared/README.md`](packages/shared/README.md) |

### Decision records

Each is a defect that shipped, measured. They are the long form behind the invariant that
distils them, and are not kept in sync with it — the invariant is the current rule.

| Record | Covers |
| --- | --- |
| [`docs/issues/album-identity.md`](docs/issues/album-identity.md) | folder vs. release, and why the grouping is a setting |
| [`docs/issues/d1-daily-write-limit.md`](docs/issues/d1-daily-write-limit.md) | a spent allowance, and why `paused` is neither `failed` nor `stalled` |
| [`docs/issues/free-plan-subrequest-ceiling.md`](docs/issues/free-plan-subrequest-ceiling.md) | the scan that charged 40 and spent 240 |
| [`docs/issues/subrequest-budgets-are-two-not-one.md`](docs/issues/subrequest-budgets-are-two-not-one.md) | the measurement that made the pessimistic reading *conservatism* |
| [`docs/issues/scan-chunk-unbounded-work.md`](docs/issues/scan-chunk-unbounded-work.md) | why `getScanStatus` is not a status read |
| [`docs/issues/nodes-upsert-livelock.md`](docs/issues/nodes-upsert-livelock.md) | 231,620 rows on one library, and what made it converge |
| [`docs/issues/kv-default-text-read-corrupts-artwork.md`](docs/issues/kv-default-text-read-corrupts-artwork.md) | a `200` with a decodable placeholder, twice |

## The invariants

The rules that this repository learned the hard way, each written up once in the guide whose
reader needs it. A guide that grows a rule nobody can act on is a rule nobody reads — so when
one belongs to two areas, the guide that owns the *code* keeps it and the other links.

The single most repeated shape among them: **a claim nothing measures is not an
invariant.** A comment, a default, a typed constant beside the code it bounds, and a double
that shares the code's assumptions have all carried a defect through a green suite here.
