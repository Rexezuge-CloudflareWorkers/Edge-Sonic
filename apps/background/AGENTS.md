# Edge-Sonic — Background Worker

Scope: `apps/background/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — re-exports `ScanWorker` (also re-exported by `apps/api/src/index.ts` for DO bindings).
- `ScanWorker` (`src/ScanWorker.ts`) — thin facade (routing + composition only): one Durable Object per library (`SCAN.getByName(libraryId)` — the library `id` is already stable, so no key normalization); alarm-driven chunk loop over the same `ScanService` the fetch isolate used to call directly, plus `enrichSong`/`coverArt` RPCs over the same `EnrichmentService`/`embeddedAlbumArt` a `getSong` uses. Factory wiring in `ScanWorkerFactory`.
- Composition: resolve per-request state via `createRequestScope(env).get(Tokens.X)`; never `new XDAO(env.DB)` inline.
