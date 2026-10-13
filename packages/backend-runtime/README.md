# `@edge-sonic/backend-runtime`

Configuration, the KV **domain table**, and the Workflow failure policy. Layer 1 —
may reach layer 0 only, plus the `@rexezuge/*` kernel packages the framework
floor now comes from.

This package used to also carry the DI container, the request scope, the logger,
`EnvParser`, the KV cache and its breaker. Each is `@rexezuge/runtime`'s now, and
each was written here first — so what follows is not a list of what was deleted but
of why the copies could not have stayed.

The **behaviour** reachable from configuration, bindings and secrets is documented in
[`docs/agents/runtime/AGENTS.md`](../../docs/agents/runtime/AGENTS.md). This file is what is
in the package.

## What is here

| Path                               | Holds                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `config/ConfigurationDefaults.ts`  | every default, in one file, beside the limit it belongs to                                                                   |
| `config/subrequests.ts`            | `WORKER_SUBSREQUEST_CEILING = 50` and **every bound derived from it**                                                        |
| `config/enrichSubrequests.ts`      | the library-wide enrich chunk's page, derived from the same ceiling (split out when `subrequests.ts` hit the god-file limit) |
| `config/ServiceEnv.ts`             | the declared shape of `env`                                                                                                  |
| `config/EnvParser.ts`              | a re-export of the kit's — and why both parsers matter                                                                       |
| `config/sections/`                 | `AuthConfig`, `LibraryLimits`                                                                                                |
| `config/validate.ts`               | the warnings, kept off the class so it stays a facade                                                                        |
| `kv/KvCache.ts`                    | `createKvCache` — the kit's cache bound to **this** repository's domain table                                                |
| `kv/KvDomains.ts`                  | the two domains, their TTLs and byte ceilings                                                                                |
| `base/runWorkflow.ts`              | the Workflow failure policy                                                                                                  |
| `logger.ts`, `config/EnvParser.ts` | re-exports of the kit's, carrying the reasons they were local                                                                |

## One platform number, and arithmetic rather than a typed constant

`subrequests.ts` holds `WORKER_SUBSREQUEST_CEILING = 50` and computes the chunk budget
(`50 − 8`), the folder count (`floor(42/6)`), the enrich cap (`floor(42/5)`), the derivation
page (`42 − 4 − 6`), the page-size ceiling, and the daily row-write budget (100,000 less a
10% reserve). **Nothing above is typed beside the code that has to honour it**, because a
number typed beside a query is right until the first `CREATE INDEX`, after which it silently
under-counts.

The ceiling is the **external** one. Measured on a Free account on 2026-10-05, D1 has 1,000
of its own in a separate pool, so charging D1 against the 50 is ~21× conservatism — kept
deliberately, because an _external_ overrun kills the invocation with nothing catchable
while a D1 overrun throws. A ceiling that is too small costs throughput; one that is too
large takes the product down.

`D1_DAILY_ROW_WRITE_LIMIT` was **5,000** for a while, under a comment claiming to be "the
platform number, not a choice". Correcting it _alone_ would have multiplied a ten-fold
under-count by twenty; the two were one change.

## Two integer parsers, and the distinction is load-bearing

`positiveInt` requires `> 0`; `nonNegativeInt` allows `0`. `TAG_READ_TAIL_BYTES=0` disables
the Ogg tail read — a supported configuration — and reading it through `positiveInt` silently
produced the default instead, so an operator who set it got a 64 KiB ranged read per Ogg
track for ever. `nonNegativeInt` had **no callers anywhere** at that moment: the helper for
that value existing, unused, in the same layer, while the line beside it called the other
one.

## What came from the kit, and what each copy was holding

| Was local                               | Now                              | What the copy was carrying                                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `di/Container.ts`, `di/RequestScope.ts` | `@rexezuge/runtime`              | Both were **dead in production** — only `test/alias-table.int.test.ts` still imported them. The fork also used a different scope key, so it could never have been used with a kit-installed scope.                                                                          |
| `logger.ts`                             | `@rexezuge/runtime`              | The level resolved **per emit** rather than per construction. Both loggers here are module-level constants, so a constructor-resolved level could only read `process.env`, which workerd does not have: `LOG_LEVEL=debug` shipped, was validated by nothing, and was inert. |
| `config/EnvParser.ts`                   | `@rexezuge/runtime`              | A guarded `readString` (the kit's cast threw on a `null` env, which is the fail-soft path every caller here is on) and `isValidNonNegativeInt`.                                                                                                                             |
| `kv/KvCache.ts`                         | `@rexezuge/runtime`              | The circuit breaker and the subrequest charge. Both are in the kit now.                                                                                                                                                                                                     |
| `kv/KvDomains.ts`                       | **local, and passed to the kit** | The TTL and byte policy, which is per-repo by definition. See below.                                                                                                                                                                                                        |
| `kv/KvDomains`'s key builder            | `@rexezuge/runtime`              | A 32-bit FNV digest where the kit ships `digest128`. A 32-bit digest over a shared keyspace whose longest keys embed a user-controlled path is collision-searchable.                                                                                                        |

`Container` carries both tiers again — `bind` with a factory plus `bindValue` —
where this repository's copy had deleted the factory tier as unreachable. All
thirty registrations in `createRequestScope` are still `bindValue`, so the factory
tier is still unused here; what changed is only where the class lives. The "no
binding for token" throw is the kit's, and it is still asserted for every entry in
`Tokens`.

## Why the domain table stays here

`songMeta` is keyed by the file's own mtime and lasts a week; the kit's `metadata`
domain lasts two minutes. A TTL is per-repo by definition — a cache holding album
artwork keyed by a file's mtime and a cache holding session profiles cannot share
a lifetime. So `KV_DOMAINS` is passed to the kit's `KvCache` rather than taken from
it, and adopting the kit's table under these names would have silently turned a
week-long cache into a two-minute one: a hundred extra origin reads a day per
library, with no error anywhere.

`createKvCache` is a **factory**, not a subclass. The kit's `KvCache` is generic over
its domain table, so the type has to be pinned somewhere; a subclass that pinned it
inherited every method with the type argument bound and consumers wrote
`new KvCache(...)` against it. A factory makes the binding explicit at the one place
it happens.

## The KV cache fails soft, and it fails _typed_

`KvCache` itself is the kit's. What follows is the behaviour this repository
depends on, and the reason the guard it uses is not optional.

A missing binding and a throwing binding are the same code path, and the responses are
byte-identical to a warm cache. D1 answers.

Every read states its `type`, because `get()`'s platform default is `'text'` — a **lossy**
codec for binary, and a stored JPEG read back as text comes back with every invalid UTF-8
sequence replaced. That took the whole embedded-artwork feature with it on a live 100%-Opus
library: 42 covers on the first sweep of 80 albums, 0 of 80 on the second, every one a `200`
with a decodable placeholder. `KvNamespaceLike.get` carries the `type` parameter so the
`arrayBuffer` overload can be _expressed_ — a narrowed hand-written interface hides the
wrong call as surely as a wrong one.
