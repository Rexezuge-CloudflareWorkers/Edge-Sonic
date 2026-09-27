/**
 * Subsonic request parameter access.
 *
 * Subsonic clients are not consistent about transport. The same call arrives as a
 * `GET` with a query string from one client and as a `POST` with a
 * `application/x-www-form-urlencoded` body from the next — several mobile
 * clients only ever use POST, because a long `songId` list does not fit
 * comfortably in a URL. Reading only the query string silently drops every
 * playlist a phone creates.
 *
 * Repeated parameters are the other half of it. The protocol specifies "use one
 * `songId` parameter for each song", and clients honour that in one of two ways:
 * repeated `songId=a&songId=b`, or a single comma-joined `songId=a,b`. Both are
 * in the wild and both must work.
 */
import { missingParameter } from './envelope';
import { ErrorCode, SubsonicError } from './errors';

/**
 * Parameters that may legitimately appear more than once, or comma-joined.
 *
 * `id` is here because `star`/`unstar`/`scrobble`/`savePlayQueue` repeat it.
 * It is *also* the singular parameter of `getAlbum`/`getSong`/`getArtist`, which
 * is why `ids()` and `get()` are separate methods: the singular accessors never
 * comma-split, because a comma inside a single opaque id must stay part of the
 * id (an id we do not recognize simply fails to resolve, which is correct).
 */
const MULTI_VALUE_PARAMS = new Set(['id', 'songId', 'songIdToAdd', 'songIndexToRemove', 'albumId', 'artistId', 'musicFolderId']);

class SubsonicParams {
  private readonly values: Map<string, string[]>;

  constructor(entries: Iterable<[string, string]> = []) {
    const values = new Map<string, string[]>();
    for (const [key, value] of entries) {
      const existing = values.get(key);
      if (existing) {
        existing.push(value);
      } else {
        values.set(key, [value]);
      }
    }
    this.values = values;
  }

  /**
   * Build from a request, merging the query string with a form-encoded body.
   *
   * The body is read only for a form-urlencoded POST. Reading it unconditionally
   * would consume the request body of a streaming call, and a `PUT`/`POST` with
   * any other content type carries bytes this parser must not touch.
   */
  static async fromRequest(request: Request): Promise<SubsonicParams> {
    const url = new URL(request.url);
    const entries: [string, string][] = [...url.searchParams.entries()];

    const method = request.method.toUpperCase();
    const contentType = request.headers.get('content-type') ?? '';
    if ((method === 'POST' || method === 'PUT') && contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
      const body = await request.text();
      if (body.length > 0) {
        entries.push(...new URLSearchParams(body).entries());
      }
    }

    return new SubsonicParams(entries);
  }

  /** First raw occurrence of a parameter. */
  public get(name: string): string | undefined {
    return this.values.get(name)?.[0];
  }

  /** First occurrence, or a fallback. */
  public getOr(name: string, fallback: string): string {
    const value = this.get(name);
    return value === undefined || value.length === 0 ? fallback : value;
  }

  /** Every raw occurrence, in request order. */
  public getAll(name: string): string[] {
    return this.values.get(name) ?? [];
  }

  public has(name: string): boolean {
    return this.values.has(name);
  }

  /** First occurrence, or a `code=10` failure naming the parameter. */
  public require(name: string): string {
    const value = this.get(name);
    if (value === undefined || value.length === 0) {
      throw missingParameter(name);
    }
    return value;
  }

  /**
   * All values for a multi-value parameter, comma-split.
   *
   * Empty segments are dropped rather than becoming an empty id: a trailing
   * comma (`songId=1,`) is a client quirk, and passing `""` onward would
   * resolve to a failure for the whole call instead of the intended one song.
   */
  public ids(name: string): string[] {
    if (!MULTI_VALUE_PARAMS.has(name)) {
      const single = this.get(name);
      return single === undefined || single.length === 0 ? [] : [single];
    }
    return this.getAll(name)
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  /**
   * Integer parameter with a default and a clamped range.
   *
   * A malformed value falls back to the default rather than failing the call.
   * Subsonic clients send these unvalidated, and `size=abc` is a client bug, not
   * a reason to refuse a page of results.
   */
  public int(name: string, fallback?: number, bounds?: { min?: number; max?: number }): number {
    const raw = this.get(name);
    if (raw === undefined || raw.trim().length === 0) return fallback ?? 0;
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) return fallback ?? 0;
    const min = bounds?.min ?? Number.MIN_SAFE_INTEGER;
    const max = bounds?.max ?? Number.MAX_SAFE_INTEGER;
    return Math.min(Math.max(parsed, min), max);
  }

  /** Boolean parameter. Only the literal `true`/`false` (any case) are truthy. */
  public bool(name: string, fallback: boolean): boolean {
    const raw = this.get(name)?.trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fallback;
  }
}

/**
 * Decode the legacy `p` parameter.
 *
 * `p=sesame` is a cleartext password and `p=enc:736573616d65` is the same bytes
 * hex-encoded. The `enc:` form predates token auth and exists only so a password
 * containing URL-unsafe characters survives a query string. Both are accepted;
 * neither is preferred, and clients that can compute `t=md5(password+salt)`
 * should.
 */
function decodeLegacyPassword(raw: string): string {
  if (!raw.startsWith('enc:')) return raw;
  const hex = raw.slice(4);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[\da-f]+$/i.test(hex)) {
    throw new SubsonicError(ErrorCode.WrongCredentials);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export { SubsonicParams, decodeLegacyPassword, MULTI_VALUE_PARAMS };
