# `@edge-sonic/backend-errors`

The error taxonomy. Layer 0 — no dependency on anything in this repository, which is what
makes it usable from every other layer without a cycle.

Five classes and one rule each.

| Class             | Carries | Raised when                                            |
| ----------------- | ------- | ------------------------------------------------------ |
| `BadRequestError` | 400     | the request is wrong, and the caller can fix it        |
| `ForbiddenError`  | 403     | the caller is known and refused                        |
| `NotFoundError`   | 404     | the row is not there, or must look as though it is not |
| `ConflictError`   | 409     | the request is well-formed and collides with the world |
| `DatabaseError`   | 500     | D1 failed; the cause is logged and the body masked     |

## An error class is not a status, and a route must not re-decide one

Each class **carries its own status** (`getErrorCode()`), and one mapper turns a class into
a response. `createSource` used to map every `BadRequestError` to a 409, which made _"that
URL is not allowed by the SSRF gate"_ and _"that remote account is already registered"_
arrive under one number — and an operator reading a rejected URL as a conflict goes looking
for a duplicate to rename.

So there is nothing for a route to map. `apps/api`'s `BaseRoute.toErrorBody` is the single
path, and `packages/backend-services`' `ErrorMapper` is the single translation into each of
the two dialects (`/rest` envelope, `{Exception:{Type,Message}}` on `/user`).

## Why it is excluded from the coverage gate

Because it is a **pure taxonomy**: there is no logic here to exercise, only the _mapping out_,
and that is tested from the surfaces that map it (`test/enrichment-config.test.ts`).
`vitest.config.mts` says so in the exclude list, and says why.

## Why `NotFoundError` is also an answer

A `NotFoundError` becomes `code=70` on `/rest`, and it is used for a row the caller may not
see as well as one that does not exist. Those two must be indistinguishable: an unknown id
for a library you cannot see answers the same as an id that does not exist, because the
alternative is an oracle for what other people have. The _operator_ surface is different —
they can already see the row in their own list — which is why `probe` reports a missing row
by name while `/rest` does not.
