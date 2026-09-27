/**
 * `@edge-sonic/webdav` — an RFC 4918 **client**.
 *
 * Layer 0: no `@edge-sonic/*` dependencies and no runtime dependencies at all.
 *
 * This used to be the reverse-proxy helper surface of a different project. It is
 * now the only way this server reads a music library, so the shape is different:
 * there are no CORS helpers and no `SUPPORT_METHODS` advertisement, because this
 * server never *serves* WebDAV. There is a 207 parser, a URL builder with
 * explicit containment rules, and a client whose credential handling is the
 * reason it is a class and not a bare `fetch`.
 */
export * from './xml';
export * from './multistatus';
export * from './url';
export * from './client';
