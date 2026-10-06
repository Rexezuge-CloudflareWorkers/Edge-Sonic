# `@edge-sonic/subsonic`

The Subsonic REST API **v1.16.1**: ids, the envelope, the node model, three serializers,
the error codes and MD5. Layer 0 — no dependency on anything in this repository.

Everything a client reads passes through here, which is why the rules about *shape* live in
[`docs/agents/protocol/AGENTS.md`](../../docs/agents/protocol/AGENTS.md). A wrong envelope
answers `200`, renders plausibly, and is invisible from inside the server.

## What is here

| Module | Role |
| --- | --- |
| `nodes.ts` | the element builders — `el`, `elList`, `elArray`, and what each shape means |
| `serialize.ts` | XML / JSON / JSONP from one tree, so the three cannot disagree |
| `envelope.ts` | `successResponse` / `errorResponse`, and the three formats' outer wrapper |
| `builders.ts` | the protocol's records: albums, songs, `musicFolder`, `playlist` |
| `ids.ts` | `encodeId` / `decodeId`, and the eight id kinds |
| `albumKey.ts` | the album grouping key, as a value |
| `params.ts` | query-parameter coercion — and why `int` and `optionalInt` differ |
| `errors.ts` | the error codes and their HTTP statuses |
| `extensions.ts` | which OpenSubsonic extensions this server advertises, and why |
| `md5.ts`, `constants.ts`, `types.ts` | |

## The one model, three serializers

An element tree is built once and rendered three ways. That is the whole reason a shape bug
cannot be fixed in one format and left in another: there is no per-format builder to forget.

The three shapes a child element can be, and only three:

| Built as | Renders | Example |
| --- | --- | --- |
| `el(name, attrs)` | a record | `musicFolder` |
| `el(name, {}, [value])` | a bare scalar | `user.folder`'s entries |
| `elList(name, listKey, attrs, children)` | an object with a declared list at `listKey` | `getAlbum`'s `song` |
| `elArray(name, attrs, children)` | a **bare array** at the parent's key | `openSubsonicExtensions` |

An element carrying an attribute is a record to every serializer, and the serializer cannot
tell a record's scalar child from a record's list child — so the builder that knows says so.
`user.folder` is typed `Array of int` and building it as a record renders `[{"id": 0}]`,
which a client modelling `folder: List<Int>` throws on **inside its login path**. Asserted
in `test/client-decoding.test.ts`, which decodes real answers with a model written from the
schema rather than from this repository's reading of it.

**A declared list key with no items is an absent key, not `[]`** — deliberately, and the
reasoning is in the protocol guide. `array: true` is the exception.

## Ids are reversible, and two of them carry a key

`kind:base64url(libraryId \n path)`, so an id can be decoded back to a row rather than
looked up in a table. `decodeId` refuses `..`, empty segments, control characters and `%XX`,
because `normalizeRelativePath` runs over the payload and a hostile id is a traversal.

Eight kinds exist and **three are never minted**: `mf:` (the music folder is a position, not
a row), `dira:` (reserved; `getIndexes` mints `ar:`) and `vid:` (reserved for video). An id
kind nobody mints is still accepted, because one stored before it was retired must keep
resolving — `al:` is the same story, and a star written against it still has to be found.

`alk:` — the album id — carries base64url segments of the grouping **key**, not a raw name,
for the same reason: a name holding `..`, `/` or `%` mints an id this server cannot read
back.

## What is deliberately absent

No endpoint implementations and no registry. Those are `apps/api`'s, because whether an
endpoint exists is a statement about the deployment rather than about the protocol — see the
measured registry table in the protocol guide.