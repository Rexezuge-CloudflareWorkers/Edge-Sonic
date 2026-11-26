# Edge-Sonic — Sharing

Scope: `/rest/getShares|createShare|updateShare|deleteShare`, the public `/share/:id`
surface, `packages/backend-services/src/share`, `packages/backend-data/src/dao/shares.ts`,
and `migrations/0012_shares.sql`. Reads who changes any of them.

## What a share is

A share is a **capability**, not a second identity system. There is no password, no Access
session, and no role: the id in the URL is the credential. Everything below follows from
that one sentence.

- **The id is random.** `UUIDUtil.getRandomUUID()` — 122 bits — never an encoding of the
  songs it names. An id derived from the song ids, as an album id is derived from its
  grouping key, would let anyone who knows a track reconstruct the link. Asserted by
  creating the same selection twice and comparing ids.
- **The selection is frozen; the authorization is not.** `share_entries` holds song ids
  resolved at creation and never re-resolves them, so a scan that adds a track to the album
  does not silently add it to a share somebody already sent. But the _grant_ is read at
  every read: `ShareService.view` filters the entries against the owner's current
  `user_libraries`. Revoking a library grant empties the share rather than 404-ing it — the
  link is still the user's, and the truth is that it reaches nothing.
- **A deleted song is absent, not an error.** `share_entries.song_id` has no foreign key to
  `songs`, and the read is an `INNER JOIN`, so a pruned row simply stops being listed.
  A cascade would shorten a share that had already been sent, with no record that it
  happened — the same rule `getBookmarks` and `getPlayQueue` apply.

## The two surfaces

| Surface                     | Auth                 | Counts a visit |
| --------------------------- | -------------------- | -------------- |
| `/rest/getShares` etc.      | Subsonic credentials | no             |
| `/share/:id` (landing page) | the id itself        | **yes**        |
| `/share/:id/stream?song=…`  | the id itself        | no             |

### Why sharing is not in `/rest`

`dispatchRest` authenticates every request except a named `PUBLIC_ENDPOINTS` set. Putting a
capability link there would mean either a second auth path inside the dispatcher or a
capability check every future endpoint has to remember to skip. A separate surface keeps
the rule visible: those two routes read a share, and nothing else on the worker is
reachable without credentials.

`/share/:id/stream` takes the **song id from the query**, and picks it out of the already
grant-filtered entry list. Appending a song id that is real but outside the share is a 404,
because the entry list is the allow-list.

### A visit is the landing page, and only the landing page

`ShareService.visit` counts; `ShareService.visible` (used by the stream) does not. A player
fetching ranges is not opening the link, and counting those would turn `visitCount` into a
play counter under a different name. `ShareDAO.recordVisit` is one `UPDATE … RETURNING`
with the expiry check in the `WHERE`, so the increment and the answer are the same
statement, and an expired id matches nothing.

The landing page is a **write** on an unauthenticated endpoint, which is why `share` is its
own rate-limit surface with a tighter page bucket than the stream's.

## One answer for every failure

Unknown, malformed, expired, and deleted are all the same `404: Not found.` Distinguishing
"expired" from "does not exist" would confirm the id was real, which is the one thing an
unguessable link must not reveal. `ShareService.visit`/`visible` return `null` for both,
and the route has one branch.

`/share` is also a **sensitive path**: `Cache-Control: no-store` (a cached page hands the
capability to whoever shares the cache), `Referrer-Policy: no-referrer` (the id must not
travel to the next site), and `default-src 'none'` CSP (the SPA's policy allows inline
script, and this page lists attacker-controlled filenames). Asserted in
`test/security-headers.test.ts`.

## The wire

```
shares
  share id url description? username created expires? lastVisited? visitCount
    entry …   (the ordinary `songElement`, renamed)
```

- `share` and `entry` are both **declared lists** (`elList`). A one-track share is an
  ordinary share, and a client declaring `List<Child>` throws on a bare object — the
  `n=1` collapse that `elList` exists to prevent.
- `entry` is `songElement` with its name replaced rather than a second attribute set, so
  the share's view of a track cannot drift from every other endpoint's.
- `expires`, `lastVisited` and `created` are ISO-8601. The `expires` _parameter_ is epoch
  **milliseconds** and the columns are epoch **seconds**; `expiresAtFrom` in
  `endpoints/shares.ts` is the single conversion, so a missing factor of 1000 cannot hide
  in a service that also stores timestamps.
- `url` is built from `new URL(context.request.url).origin` — the origin that answered the
  create — rather than from configuration, because a deployment may be reached under a
  custom domain, an Access-protected hostname, or a preview URL.
- `createShare` answers the `shares` wrapper with its one new share; `getShares` answers
  the same wrapper; `updateShare`/`deleteShare` answer the empty success, as the protocol
  specifies.

## Owner scoping

`getShares` lists only the caller's own, and the owner predicate lives in
`ShareDAO.listForOwner` rather than in the endpoint, so a future caller cannot forget it.
Every mutation pre-reads ownership and answers `code=70` — **not** `code=50` — for another
user's share: `50` would confirm the id exists and turn the endpoint into an oracle. A
plain `DELETE … WHERE id = ? AND owner_user_id = ?` that matched zero rows cannot tell
"already gone" from "not yours", which is why `remove` reads first and returns `boolean`.

## The tables

`shares` — `id` (the capability), `owner_user_id`, `description`, `created_at`,
`expires_at`, `last_visited_at`, `visit_count`. `owner_user_id` cascades from `users`.
`expires_at IS NULL` means never; a value at or before `now` is a share that is over.

`share_entries` — `(share_id, position)` primary key (the order is the share's, not an
insertion accident), `song_id` deliberately unconstrained. The parent cascades, so a
deleted share takes its entries with it. `idx_share_entries_song` supports the song-side
read; `idx_shares_owner` the owner listing.

The entry write is chunked multi-row `INSERT` sized from `bindChunkSize(3, 0)`, with
`requireComplete`. A share is a set, so half a share is a **wrong** share rather than an
unfinished one — and on failure `ShareService.create` deletes the share row so a failed
create leaves no live link that promises nothing. `createShare` deduplicates ids in request
order and refuses more than `MAX_IDS_PER_REQUEST`.

`billedRows.ts` carries `shares: 2` and `share_entries: 2`, derived from the indexes in
`test/schema.int.test.ts` like every other row.

## See also

- [`docs/agents/protocol/AGENTS.md`](../protocol/AGENTS.md) — the wire shapes, and why the
  registry's counts moved to 56 / 17 / 1
- [`docs/agents/indexing/AGENTS.md`](../indexing/AGENTS.md) — the DAO and migration rules
- [`apps/api/AGENTS.md`](../../../apps/api/AGENTS.md) — route order, and where the public
  surface sits relative to auth
