# `@edge-sonic/webdav`

An RFC 4918 **client**. This is the only way Edge-Sonic reads a music library.

**Zero runtime dependencies** — `src/` imports nothing but its own relative modules, which
is why there is no XML library below. Layer 0.

## What is here

| Module | Role |
| --- | --- |
| `xml.ts` | A small strict XML reader for `207 Multi-Status` |
| `multistatus.ts` | `207` body → `DavResource[]` |
| `url.ts` | Origin + root + relative path → an absolute URL |
| `multistatus.ts` | also owns `decodeHrefPath`/`toLibraryPath`, the containment check — open this file, not `url.ts` |
| `client.ts` | `WebDavClient`: `propfind`, `get` (with `Range`), `readPrefix`, `readTail`, `readRange` |

## Why there is no XML library

A parser that expands entities is a denial-of-service and XXE surface, and this
origin is chosen by a user and fetched on their behalf. `xml.ts` therefore:

- **rejects `<!DOCTYPE` outright**, so an entity declaration cannot be introduced;
- expands only the five predefined entities and numeric character references,
  leaving anything else verbatim (a filename really can contain `&foo;`, and
  dropping it would point the index at a different file);
- **caps nesting depth** at 32, which no legitimate `207` approaches and which a
  hostile origin cannot use to exhaust the stack;
- **caps document size** at 8 MiB.

All four failure modes are hard errors. A half-parsed `207` would put wrong
paths into the index, and index rows become `stream` targets.

## Matching is by local name

`D:href`, `d:href` and bare `href` are all `href`. Namespace prefixes are
stripped before matching and `xmlns` declarations are skipped, so a server is
free to choose its prefix without changing the result — and cannot use the prefix
to hide a property.

## `propstat` filtering

RFC 4918 §16 lets a server answer `200` for the properties it has and `404` for
the ones it does not. A `404` section's properties are **absent, not empty**.
Merging them unfiltered is how a file gets indexed with `contentLength: 0`
because the server said "no such property" rather than "empty file".

This is also why the client asks for an explicit `<D:prop>` list rather than
`<D:allprop/>`: `allprop` is a request for whatever the server feels like
returning, so a server that omits `getlastmodified` yields an index that can
never detect a change and a rescan that can never converge.

## The credential

`Authorization` is set in exactly one place — inside `WebDavClient.request`,
after the caller has named a library and a path. No call site ever holds the
stored WebDAV password, so no call site can leak it to the wrong host. This is
the reason `WebDavClient` is a class rather than a `fetch` wrapper at each call
site.

## Range is forwarded, and the body is never touched

`get({ range })` forwards the header verbatim and returns the `Response`
unmodified. Edge-Sonic does not transcode, so nothing in this package is
permitted to rewrite media bytes: a `206` has to stay a `206` with its
`Content-Range`, because that is how every Subsonic client seeks.

`readPrefix` and `readTail` exist for tag enrichment and are ranged reads for the same
reason — an ID3v2 tag can declare itself hundreds of megabytes, and a 3 MB FLAC must
not be pulled through the worker to learn its duration. **`readTail` is the harder case
and cannot be answered by a prefix at all**: an Ogg duration is the granule of the *last*
page, so the read has to be at the end of the file. `readRange` serves embedded artwork,
where the picture block is itself as large as the image.
