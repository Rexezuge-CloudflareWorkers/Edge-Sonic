# Edge-Sonic — API Worker

Scope: `apps/api/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — `fetch` only, via `EdgeSonicWorker` (stateless: no cron, no Durable
  Objects, no `scheduled`).
- `src/workers/EdgeSonicWorker.ts` — Hono routes, no file routing, in this order:
  `securityHeaders` → `onError` → `/health` + SPA shell → `scopeMiddleware` →
  `OPTIONS *` preflight → rate limits → `/admin/*` (Access) → `/rest/*` (Subsonic).
  Runs `AppConfiguration.validate()` once per isolate on the first request.
- `src/rest/dispatch.ts` — the `/rest` dispatcher: version check, authentication, the
  `RestContext`, and the endpoint table.
- `src/rest/endpoints/` — one module per protocol area. `index.ts` holds the table and
  the known-but-unimplemented list.
- `src/rest/context.ts` — the per-request shape: `songs` (row state) and `songIndex`
  (the aggregate reads), plus `params`, `format`, and `pageSize`.
- `src/admin/routes.ts` — the operator API behind Access.
- `src/middleware/` — `scopeMiddleware`, `adminAuth`, `rateLimit`, `securityHeaders`.

## Relative imports, not the `@/` alias

`apps/api` uses relative paths. A tsconfig `paths` alias resolves under `tsc` and under
Vite, so it looks fine everywhere, and fails only where a bundler does not read tsconfig.
The Workers pool was one such bundler; a pre-bundled entry with an alias table was
another. A few `../` segments need no toolchain configuration at all, and the alias is
gone from `apps/api/tsconfig.json` so it cannot be reintroduced silently.

## Route order

The preflight precedes auth because a Fetch-spec preflight carries no credentials by
design, and a browser never issues the real request after a failed one. It is gated on
`Access-Control-Request-Method` so it cannot shadow anything else. The rate limiter
precedes auth so it can key on the resolved identity.

## `onError` speaks both dialects

`/rest` answers with the Subsonic envelope, because a client parsing that surface has no
way to interpret anything else. Everything else answers through `toAdminResponse`,
which keeps a 4xx and its message and masks a 5xx. The blanket 500 this replaced meant a
missing field, a duplicate slug, and a grant for a library that does not exist were all
"InternalServerError" — an answer an operator cannot act on and a support ticket that
cannot be reproduced.

## The two list shapes

- `elList(name, listKey, attrs, children)` declares the repeated element's name, so an
  **empty** list serializes as `[]` rather than as an absent key. The name is a
  parameter, not inferred: with no children there is nothing to infer it from.
- It flags **only** the child named by `listKey`. `playQueue` and `bookmarks` mix a
  repeated element with scalar siblings (`current`, `position`, `username`), and
  flagging those made `playQueue.current` a one-element array.
- An element's **name is the JSON key a client reads**. A `song` element inside a
  `bookmarks` wrapper produces `bookmarks.song` and leaves `bookmarks.bookmark` as its
  empty seed, so a client following the schema sees nothing.
- An element with no attributes and exactly one scalar child **is** that scalar:
  `<position>42000</position>` is `42000` in JSON, not `{"#text": 42000}`.

## Paging

`context.pageSize(context.params.optionalInt('size'), 10)`. `params.int` returns the
**number** `0` for an absent parameter, `0` is not nullish, so the fallback never applies
and `pageSize`'s floor turns it into exactly one item. Every paged endpoint shipped that
way at least once.

## Ids

`kind:base64url(libraryId \n path)`, kinds `s:`/`al:`/`ar:`/`dir:`/`vid:`/`mf:`/`dira:`.
Album and artist ids derive from the **directory**, never the name, so a starred album
resolves back to its songs after a folder is renamed. Decoding rejects control characters
and `%XX`, because the payload is split on a newline and a forged id must not be able to
move the boundary.

Refusals are deliberately uniform. An id for a library the caller cannot see answers
`code=70`, not `code=50`, and not `code=10`: `50` would confirm the id is real, turning
the endpoint into an oracle for which paths exist.

## Stream and download

A `Range` is forwarded verbatim and the upstream `Response` is returned as it arrived —
status, `Content-Range`, `Content-Length`, `Content-Type`. `estimateContentLength` is
deliberately unset: with no transcoding there is nothing to estimate, and a wrong value
makes a player seek to the wrong byte. `download` adds only a `Content-Disposition` whose
filename is stripped of quotes, control characters, **and path separators** — a WebDAV
name is attacker-controlled through a directory listing.

An unsatisfiable range answers with the protocol envelope rather than a forwarded `416`,
because a client parsing this surface cannot read anything else; what matters is that the
body is not audio.

## Never

- Never import `@edge-sonic/backend-data` **values** in a route (type-only is fine).
- Never write a D1 predicate that lowercases a column. See the parent index.
- Never let a list wrapper's child name disagree with its declared list key.
- Never mark a `5xx` with a raw error message. A D1 error names tables and columns.
