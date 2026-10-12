# `@edge-sonic/backend-errors`

A one-class shim over `@rexezuge/errors`, which is where the taxonomy lives
since the kit adoption. Layer 0 — no dependency on anything else in this
repository, which is what makes it usable from every other layer without a
cycle.

| Class                            | Carries | Raised when                                                                 |
| -------------------------------- | ------- | --------------------------------------------------------------------------- |
| `SubrequestBudgetExhaustedError` | 413     | the invocation's subrequest budget is spent and the write is all-or-nothing |

Every other class (`BadRequestError`, `ForbiddenError`, `NotFoundError`,
`ConflictError`, `DatabaseError`, …) is imported from `@rexezuge/errors`
directly. Each carries its own `status`/`type` as public fields (not methods),
and one mapper turns a class into a response — so there is nothing for a route
to map. `apps/api`'s `BaseRoute.toErrorBody` is the single path, and
`packages/backend-services`' `ErrorMapper` is the single translation into each
of the two dialects (`/rest` envelope, `{Exception:{Type,Message}}` on `/user`).

## Why the shim exists, and when it goes away

`SubrequestBudgetExhaustedError` shares `PayloadTooLargeError`'s 413 with a
distinct `type`, following the kit's `DatabaseError` precedent (the catalog
keeps one row per status). It is proposed to the kit in the same shape; until
the kit publishes it, this package holds the identical class so the consumer
stays on the released `@rexezuge/errors@1.3.0`. When that lands, delete this
package and re-point its importers at `@rexezuge/errors` — the name is
identical, so it is one specifier per file and no call-site change.

A write that must be all-or-nothing (a play queue, a playlist's `song_count`,
the derivation backfill) refuses with this rather than truncating, because half
a queue is a _shorter queue_ — a wrong answer rather than an unfinished one.
Resumable writes report `WriteBatchResult.truncated` instead and finish on the
next chunk.

## Why it is excluded from the coverage gate

Because it is a **pure taxonomy**: there is no logic here to exercise, only the
_mapping out_, and that is tested from the surfaces that map it
(`test/enrichment-config.test.ts`). `vitest.config.mts` says so in the exclude
list, and says why.

## Why `NotFoundError` is also an answer

A `NotFoundError` becomes `code=70` on `/rest`, and it is used for a row the
caller may not see as well as one that does not exist. Those two must be
indistinguishable: an unknown id for a library you cannot see answers the same
as an id that does not exist, because the alternative is an oracle for what
other people have. The _operator_ surface is different — they can already see
the row in their own list — which is why `probe` reports a missing row by name
while `/rest` does not.
