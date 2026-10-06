# `@edge-sonic/shared`

i18n bundles and small utilities. Layer 0 — no dependency on anything in this repository, and
no `apps` or `packages` may be reached from here.

The smallest package in the repository, and the one most likely to grow into a second
vocabulary. Both rules below came from it doing that.

## What is here

| Path | Holds |
| --- | --- |
| `src/i18n/` | the locale bundles and `SUPPORTED_LANGUAGES` |
| `src/utils/` | `UUIDUtil` — `getRandomUUID` and `deterministicId` |

`src/constants/` used to hold `DEMO_USER_EMAIL`, and it is **gone**: `AccessAuthService`
carried its own literal and `AuthConfig` read a variable no caller asked for, so there were
two constants with *different values* and a getter that answered neither. The one value lives
in `ConfigurationDefaults` now. A shared constant is not a neutral thing to have — it is a
place two answers can meet, and nothing in a `constants/` directory says which one is right.

## `deterministicId` is length-prefixed, and that is the point

An imported playlist's id must be stable across a retried Workflow step, so it is a hash of
`(namespace, run, remotePlaylistId)`. The first version joined the parts with NUL and its
docstring claimed the delimiter "cannot appear in a part" — which is false. Joining
`['ns','a','b']` and joining `['ns', 'a' + NUL + 'b']` produce the same string, so **any**
delimiter is forgeable: two different playlists hash to one id and one overwrites the other.

Length-prefixing each part (`3:ns1:a1:b`) is **injective**, because the length is recoverable
from the bytes. The comment was the false part and the test that caught it was written
*because* the comment made a claim — asserted in `test/import-phases.test.ts`.

## A bundle value and its inline default are one fact

`t('brand.rest', 'Sonic')` carries the value twice: once in `translation.json` and once in
the markup. Nothing compared them, so the header rendered `Edge--Sonic` — one well-formed
key, a default that matched intent, correct markup, and it is only wrong to somebody who
already knows the product's name. It reached production because every surface was
individually defensible.

`scripts/i18n/validate_locales.ts` now captures the optional second argument and fails on a
disagreement, across all **130** call sites. It also reads the call sites at all, which a
bundle-to-bundle diff cannot express — with one shipped language the original check skipped
its entire per-tag body and printed `ALL OK` having examined nothing.

A **default is not an absence**: the identity chip was `userEmail ?? 'Operator'`, so every
signed-out visitor saw the page asserting an identity it did not have.