# `@edge-sonic/backend-runtime`

Configuration, the KV cache and its breaker, the worker base class, and the subrequest meter
every bound in this repository is derived from. Layer 1 — may reach layer 0 only.

The **behaviour** reachable from configuration, bindings and secrets is documented in
[`docs/agents/runtime/AGENTS.md`](../../docs/agents/runtime/AGENTS.md). This file is what is
in the package.

## What is here

| Path                                                      | Holds                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `config/ConfigurationDefaults.ts`                         | every default, in one file, beside the limit it belongs to                                                                   |
| `config/subrequests.ts`                                   | `WORKER_SUBSREQUEST_CEILING = 50` and **every bound derived from it**                                                        |
| `config/enrichSubrequests.ts`                             | the library-wide enrich chunk's page, derived from the same ceiling (split out when `subrequests.ts` hit the god-file limit) |
| `config/ServiceEnv.ts`                                    | the declared shape of `env`                                                                                                  |
| `config/EnvParser.ts`                                     | the parsers — `positiveInt`, `nonNegativeInt`, and why both                                                                  |
| `config/sections/`                                        | `AuthConfig`, `LibraryLimits`                                                                                                |
| `config/validate.ts`                                      | the warnings, kept off the class so it stays a facade                                                                        |
| `di/RequestScope.ts`, `di/Container.ts`                   | the per-request registry                                                                                                     |
| `kv/KvCache.ts`, `kv/KvDomains.ts`                        | the cache, the two domains, the breaker                                                                                      |
| `base/AbstractEntrypointWorker.ts`, `base/runWorkflow.ts` | the Worker entrypoint                                                                                                        |
| `logger.ts`                                               | the logger                                                                                                                   |

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

## `Container` is a map, and it says so

`bindValue` is the only registration this codebase uses — **thirty** of them — so the factory
tier was deleted rather than kept. That took the "no binding for token" throw with it, the
only diagnostic for a correctly-spelled-but-unbound token; the throw is back and is asserted
for every entry in `Tokens`.

## The KV cache fails soft, and it fails _typed_

A missing binding and a throwing binding are the same code path, and the responses are
byte-identical to a warm cache. D1 answers.

Every read states its `type`, because `get()`'s platform default is `'text'` — a **lossy**
codec for binary, and a stored JPEG read back as text comes back with every invalid UTF-8
sequence replaced. That took the whole embedded-artwork feature with it on a live 100%-Opus
library: 42 covers on the first sweep of 80 albums, 0 of 80 on the second, every one a `200`
with a decodable placeholder. `KvNamespaceLike.get` carries the `type` parameter so the
`arrayBuffer` overload can be _expressed_ — a narrowed hand-written interface hides the
wrong call as surely as a wrong one.
