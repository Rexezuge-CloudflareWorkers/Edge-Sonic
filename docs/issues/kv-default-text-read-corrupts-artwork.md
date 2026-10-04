# KV's default text read corrupted every cached cover

## What was reported

> a lot of albums images are not extracted from songs. (some are working). the entire
> library is ogg files (opus).

Instance `sonic.550441.xyz`, one WebDAV library, 113 indexed tracks across 80 albums, every
track an Opus file with the picture embedded as a base64 `METADATA_BLOCK_PICTURE` and **no**
sidecar image anywhere.

"Some are working" is the whole of the report, and it is the part that mattered: it said the
extraction was *intermittent*, which pointed at the readers, the origin, or the limits. It was
none of those, and the shape of the answer is what pinned it.

## What the platform says

Workers KV's `get()` takes an optional `type`, and **the default is `text`**:

```
type: "text" | "json" | "arrayBuffer" | "stream"
Optional. The type of the value to be returned. text is the default.
```

The platform's own types make it unambiguous, because the overloads are the return type:

```ts
get(key: K, options?: Partial<KVNamespaceGetOptions<undefined>>): Promise<string | null>;
get(key, type: "text"): Promise<string | null>;
get(key, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
```

So `get(key)` returns a **`string`**, for any value, and UTF-8 is not a byte-preserving
codec. A JPEG read as text is lossy-decoded — every sequence that is not valid UTF-8 becomes
U+FFFD — and re-encoding it expands each of those to three bytes:

```text
put:  ff d8 ff db 00 84 00 08           8 bytes, intact
get:  ef bf bd ef bf bd ef bf bd ...   18 bytes, and no longer an image
```

A PNG is mangled differently (`89` is a UTF-8 continuation byte), which is worth knowing: a
fix or a fixture that handled only one of the two formats would still have looked correct.

## What the code did

`KvCache.getBytes` — the only binary reader in the product, and the one the artwork feature
depends on:

```ts
const raw = await this.namespace!.get(buildKvKey(domain, parts));   // default: text
if (raw === null || raw === undefined) return null;
return typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
```

The `typeof raw === 'string'` branch is written as though it were an edge case. On a real
binding it is **every** read, and it re-encodes a value that was already corrupted.

`putBytes` was correct — `value.slice().buffer`, an `ArrayBuffer` — so the bytes on the wire
were intact. Only the read destroyed them.

And `KvNamespaceLike` declared:

```ts
get(key: string): Promise<string | ArrayBuffer | null>;
```

No `type` parameter, so the `arrayBuffer` overload **could not be expressed**. The correct
call was a compile error; the wrong one was the only one available.

## Why the whole feature died, silently

`embeddedAlbumArt` re-derives a cached image's media type from the bytes themselves rather
than storing it beside them — a deliberate rule, because a key holding a content type and a
value is two things that can disagree, and the disagreement is a cover served with a
`Content-Type` its bytes do not have.

So the cached entry came back as `ef bf bd …`, `sniffImageType` answered `null`, and the
endpoint served `PLACEHOLDER_PNG`.

Three properties of that path turned a cache bug into a permanent, invisible one:

- **The corrupt entry has a non-zero length**, so it cannot be mistaken for the zero-length
  entry that means "this album has no artwork". Every response was a `200` with a decodable
  image. A client cached the placeholder and never asked again, and no log line anywhere named
  a cause.
- **The key is the tracks' `mtimeMs`+`size`**, so nothing about the library could invalidate
  it. The `albumArt` TTL is 30 days.
- **The answer came from the cache**, so nothing re-derived it.

## The measurement

The reported instance, 80 albums, every cover requested twice:

| sweep  | real images | placeholders |
| ------ | ----------- | ------------ |
| first  | 42          | 38           |
| second | **0**       | 80           |
| third  | 0           | 80           |

Monotonic decay to zero, and each album answered correctly **exactly once** — on the request
that missed the cache and extracted the picture itself. That is the signature of a cache whose
writes work and whose reads do not, and it is what ruled out the readers: extraction never
failed.

The latency split said the same thing from the other side. A failing `getCoverArt` cost
1.25–1.39 s; pure-D1 calls (`getMusicFolders`, `getIndexes`) cost 0.66–1.39 s; the same cover
*when it worked* cost 2.2–3.8 s. The extra second is the ranged read the failures were not
making.

Ruled out along the way, each with a measurement rather than an argument:

- **The origin.** 18/18 three-megabyte ranged reads served intact, no short reads, no failures.
- **The readers.** The repository's own `embeddedAlbumArt`, run against the live origin with
  an honest KV double: Akane → 148 469 B JPEG, Anytime Anywhere → 274 288 B JPEG, and a clean
  cache hit on calls two and three.
- **`songs.size`.** `getAlbum` reported real sizes (`6109804`), so the `ogg-comment` claim's
  clamp against a zero size was not in play.
- **The deployment.** `getAlbumList`, `getIndexes`, `getUser.folder`, the XML namespace and
  the OpenSubsonic fields all match this tree, and no commit after the art path's last change
  touches it. The art code on the instance is the art code in this repository.

## Why the suite was green

`test/cover-art-embedded.test.ts` has asserted, since the feature landed, that **the second
request for an album serves the same bytes out of KV and does not touch the origin**. That
assertion is correct, it is the one that should have caught this, and it passed — because
`fakeKv` returned whatever `put` was given:

```ts
async put(key: string, value: string): Promise<void> { store.set(key, value); }
async get(key: string): Promise<string | null> { return store.get(key) ?? null; }
```

Every round-trip in the repository was byte-exact while the real binding was lossy. This is
the same defect as the D1 double that lowercased both sides of a predicate and the FLAC fixture
that shared a byte offset with the FLAC reader: **a double that shares an assumption with the
code it tests makes both look right.** Here the shared assumption was an *encoding*, which is
why a byte-exact round-trip assertion proved nothing — and why the fixture matters too: a
cover beginning `ff d8 ff e0` (JFIF) survives some UTF-8 round trips well enough to look fine,
so the fixture now starts `ff d8 ff db`, which is what every real cover in this library starts
with.

## The fix

`packages/backend-runtime/src/kv/KvCache.ts`:

```ts
const raw = await this.namespace!.get(buildKvKey(domain, parts), 'arrayBuffer');
```

`getText` states `'text'` for the same reason — a reader that does not say what it wants gets
the default, and the two defaults are not the same.

`KvNamespaceLike.get` gains the parameter, so the platform's overloads are modelled rather than
erased.

`test/helpers/fakeKv.ts` now stores `string | ArrayBuffer`, returns the `ArrayBuffer` only for
`type: 'arrayBuffer'`, and otherwise performs the same lossy decode the platform performs. It
also records the requested type, so a reader that forgets to state its decision is visible
rather than inferred from the bytes.

`embeddedAlbumArt` logs the cached-but-unrecognisable branch. No writer on that path can
produce such an entry — `resolveImageBytes` refuses a non-image before it is stored — so it
means the bytes changed in transit, which is worth a line.

### No purge, and no version bump

`putBytes` wrote an `ArrayBuffer`, so every stored entry is intact. The fix makes them readable;
all 80 albums recover on the first request, and albums that genuinely have no artwork keep
their correct zero-length entry.

`READER_VERSION` is **not** bumped. Nothing about an extraction changed — the bytes were always
extracted correctly — so bumping it would orphan a working cache and force a re-read of every
album in the library for nothing.

### What is asserted, and what proves the assertion has teeth

`test/kv-outage.test.ts`, `binary values survive the cache`:

- the exact bytes come back, for both domains;
- the requested type **is** `'arrayBuffer'` — the decision, asserted rather than inferred;
- **the pair**: reading the same key the way the platform reads by default is *not* the same
  value, and `sniffImageType` says `null` for it and `image/jpeg` for the correct read. Without
  this, a byte-exact double makes the whole block pass;
- a PNG's magic is destroyed too, so a fix handling one format cannot pass;
- a zero-length entry stays zero-length, because that is the cached *absence*.

`test/cover-art-embedded.test.ts` asserts both requests and the requested type.

Reverting `getBytes` to the default type turns **6 tests red** across the two files, including
the pre-existing second-request check — which is the point: that check was always right, and
the double was always wrong.

## The generalisation

**A double must model the platform's _defaults_, not only its shapes.**

Every earlier instance in this repository was a wrong *value* or a wrong *shape*. This one was
a default nobody had written down: `get()` returns text unless told otherwise, `SQLITE_MAX_VARIABLE_NUMBER`
is 100 in D1 and 32 766 in Node, `lower(col)` cannot use an index, a `subrequest` is not only
`fetch`. In each case the platform's behaviour is documented, discoverable, and absent from the
thing standing in for it — so the code and its double agree perfectly and the product is wrong
about the world.