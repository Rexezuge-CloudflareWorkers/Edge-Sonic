/**
 * Library registry, and the SSRF gate in front of it.
 *
 * ### Why a library URL is more dangerous than a router backend URL
 *
 * The reference project this was scaffolded from stored **no credentials at all**
 * and forwarded the caller's own, so a registered `baseUrl` was only a routing
 * hint. Here the worker holds the WebDAV password and attaches it to every
 * request to that origin. A library pointed at `http://169.254.169.254/` or a
 * loopback admin port therefore turns the worker into a *credentialed* proxy into
 * its own network, and the response is readable back through `getMusicDirectory`.
 *
 * That is why `normalizeBaseUrl` rejects private, loopback, link-local, and
 * encoded-numeric hosts, and why the check is re-applied on **read** as well as on
 * write: a row written before this rule existed, or by a migration, must not be
 * exempt because it is already in the database.
 */
import { BadRequestError, ConflictError, NotFoundError } from '@edge-sonic/backend-errors';
import { decryptData, encryptData } from '@edge-sonic/backend-data/crypto';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { isPrivateOrInternalHost, MAX_URL_LENGTH as SSRF_MAX_URL_LENGTH } from '@edge-sonic/shared/utils';
import { WebDavClient, WebDavError } from '@edge-sonic/webdav';

interface LibraryStore {
  findById(id: string): Promise<LibraryRow | null>;
  findBySlug(slug: string): Promise<LibraryRow | null>;
  list(): Promise<LibraryRow[]>;
  listForUser(userId: string): Promise<LibraryRow[]>;
  countForUser(userId: string): Promise<number>;
  create(input: {
    slug: string;
    baseUrl: string;
    rootPath: string;
    davUsername: string;
    passwordCiphertext: string;
    passwordIv: string;
    displayName?: string | null;
  }): Promise<LibraryRow>;
  update(
    id: string,
    input: { slug: string; baseUrl: string; rootPath: string; davUsername: string; displayName?: string | null },
  ): Promise<void>;
  updatePassword(id: string, passwordCiphertext: string, passwordIv: string, keyVersion: number): Promise<void>;
  setEnabled(id: string, isEnabled: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}

interface LibraryDeps {
  libraries: LibraryStore;
  resolveKey: () => Promise<string>;
  timeoutMs: number;
  /**
   * Whether a private origin is permitted.
   *
   * `null` follows the environment: allowed outside production so a co-located
   * `wrangler dev` against a LAN Nextcloud works, denied in production. A
   * deny-list (`!== 'production'`) is not an option — it would treat `staging`
   * and a typo as development, and this is a credential-routing decision.
   */
  allowPrivateHosts: () => boolean;
}

/** RFC 3986 unreserved set, minus `.` which is handled by the slug rule below. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Validate and canonicalize a WebDAV origin.
 *
 * Returns a bare origin — scheme + host + optional port, no path, no query, no
 * fragment, no credentials. Enforcing "no path" here is what lets
 * `buildDavUrl` concatenate `rootPath` without having to reason about a join
 * that might already contain a path.
 */
function normalizeBaseUrl(raw: string, allowPrivate: boolean): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) throw new BadRequestError('Library URL is required.');
  if (value.length > SSRF_MAX_URL_LENGTH) throw new BadRequestError('Library URL is too long.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError('Library URL is not a valid absolute URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestError('Library URL must use http or https.');
  }
  // Plaintext is allowed only for the loopback case a local dev server needs.
  // Everywhere else a Basic credential must not cross the network in the clear.
  if (url.protocol === 'http:' && !isLoopbackOrPrivate(url.hostname)) {
    throw new BadRequestError('Library URL must use https.');
  }
  if (url.username !== '' || url.password !== '') {
    // A credential embedded in the URL would be stored in `base_url`, returned by
    // the admin API, and written to logs. Refuse rather than strip it, so the
    // caller learns the shape is wrong.
    throw new BadRequestError('Library URL must not embed credentials.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new BadRequestError('Library URL must be a bare origin; put the path in the root path field.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new BadRequestError('Library URL must not contain a query or fragment.');
  }
  if (!allowPrivate && isPrivateOrInternalHost(url.hostname)) {
    throw new BadRequestError(
      'Library URL points at a private, loopback, or link-local address. Set ALLOW_PRIVATE_WEBDAV_HOSTS to permit this deliberately.',
    );
  }

  return url.origin;
}

function isLoopbackOrPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || isPrivateOrInternalHost(host);
}

/** Canonicalize the in-origin path prefix. Always starts with `/`, never ends with one. */
function normalizeRootPath(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) return '/';
  if (value.includes('?') || value.includes('#')) throw new BadRequestError('Library root path must not contain a query or fragment.');
  if (value.includes('\\') || value.includes('\0')) throw new BadRequestError('Library root path contains an illegal character.');
  // Percent-decoded first: a root path of `/music%2F..%2Fetc` is a traversal
  // attempt that only becomes visible on decode.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new BadRequestError('Library root path is not valid percent-encoding.');
  }
  if (decoded.split('/').includes('..')) throw new BadRequestError('Library root path must not contain "..".');
  const normalized = `/${decoded.split('/').filter((segment) => segment.length > 0).join('/')}`;
  return normalized;
}

function normalizeSlug(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!SLUG_PATTERN.test(value)) {
    throw new BadRequestError('Library slug must be 1-64 characters of letters, digits, hyphen, or underscore.');
  }
  return value;
}

/** An authorized library, with the decrypted credential already resolved. */
interface ResolvedLibrary {
  readonly row: LibraryRow;
  readonly name: string;
}

class LibraryService {
  constructor(private readonly deps: LibraryDeps) {}

  public async listAll(): Promise<LibraryRow[]> {
    return await this.deps.libraries.list();
  }

  public async listForUser(userId: string): Promise<LibraryRow[]> {
    return await this.deps.libraries.listForUser(userId);
  }

  /**
   * Resolve a library a user is allowed to see.
   *
   * Authorization is enforced **here**, on the way out of the registry, rather
   * than in each endpoint. A `musicFolderId` arrives from the client on nearly
   * every call, and a check that has to be remembered per call site is a check
   * that will be forgotten.
   *
   * A library the user cannot see is reported as `code=70`, not `code=50`:
   * `code=50` would confirm the id is real, turning `getMusicFolders` into an
   * oracle for which libraries exist.
   */
  public async requireForUser(userId: string, libraryId: string): Promise<LibraryRow> {
    const allowed = await this.deps.libraries.listForUser(userId);
    const found = allowed.find((library) => library.id === libraryId);
    if (found) return found;
    // A global lookup keeps the "not yours" and "does not exist" answers
    // identical; the row is not returned either way.
    const global = await this.deps.libraries.findById(libraryId);
    if (global) throw new NotFoundError('Library not found.');
    throw new NotFoundError('Library not found.');
  }

  public async findByIdForUser(userId: string, libraryId: string): Promise<LibraryRow | null> {
    const allowed = await this.deps.libraries.listForUser(userId);
    return allowed.find((library) => library.id === libraryId) ?? null;
  }

  /** Display name, falling back to the slug. */
  public static displayName(row: LibraryRow): string {
    const name = row.display_name?.trim();
    return name && name.length > 0 ? name : row.slug;
  }

  /**
   * Build an authenticated client for a library.
   *
   * The credential is decrypted here and nowhere else, and it is handed straight
   * to `WebDavClient`, which attaches it to the request. No caller ever holds the
   * plaintext — that is what makes "the stored password only ever goes to the
   * library's own origin" a property of the code rather than a convention.
   */
  public async clientFor(row: LibraryRow): Promise<WebDavClient> {
    const key = await this.deps.resolveKey();
    const password = await decryptData(row.password_ciphertext, row.password_iv, key);
    return new WebDavClient(row.base_url, row.root_path, { username: row.dav_username, password }, fetch);
  }

  public async create(input: {
    ownerId: string;
    slug: string;
    baseUrl: string;
    rootPath: string;
    davUsername: string;
    davPassword: string;
    displayName?: string | null;
  }): Promise<LibraryRow> {
    const slug = normalizeSlug(input.slug);
    const existing = await this.deps.libraries.findBySlug(slug);
    if (existing) throw new ConflictError(`A library with slug "${slug}" already exists.`);

    const baseUrl = normalizeBaseUrl(input.baseUrl, this.deps.allowPrivateHosts());
    const rootPath = normalizeRootPath(input.rootPath);
    const key = await this.deps.resolveKey();
    const encrypted = await encryptData(input.davPassword, key);

    return await this.deps.libraries.create({
      slug,
      baseUrl,
      rootPath,
      davUsername: input.davUsername,
      passwordCiphertext: encrypted.ciphertext,
      passwordIv: encrypted.iv,
      displayName: input.displayName ?? null,
    });
  }

  public async update(id: string, input: { slug: string; baseUrl: string; rootPath: string; davUsername: string; displayName?: string | null }): Promise<void> {
    const slug = normalizeSlug(input.slug);
    const existing = await this.deps.libraries.findBySlug(slug);
    if (existing && existing.id !== id) throw new ConflictError(`A library with slug "${slug}" already exists.`);
    await this.deps.libraries.update(id, {
      slug,
      baseUrl: normalizeBaseUrl(input.baseUrl, this.deps.allowPrivateHosts()),
      rootPath: normalizeRootPath(input.rootPath),
      davUsername: input.davUsername,
      displayName: input.displayName ?? null,
    });
  }

  public async setPassword(id: string, password: string): Promise<void> {
    const key = await this.deps.resolveKey();
    const encrypted = await encryptData(password, key);
    await this.deps.libraries.updatePassword(id, encrypted.ciphertext, encrypted.iv, 1);
  }

  public async delete(id: string): Promise<void> {
    await this.deps.libraries.delete(id);
  }

  /**
   * Re-check a stored origin against the current SSRF policy.
   *
   * Re-validating on read matters because the policy can change after a row is
   * written: an operator who tightens `ALLOW_PRIVATE_WEBDAV_HOSTS` must not leave
   * existing private-origin libraries usable, and a row written before this check
   * existed must not be grandfathered in.
   */
  public assertReachable(row: LibraryRow): void {
    let host: string;
    try {
      host = new URL(row.base_url).hostname;
    } catch {
      throw new BadRequestError('Stored library URL is malformed.');
    }
    if (!this.deps.allowPrivateHosts() && isPrivateOrInternalHost(host)) {
      throw new NotFoundError('Library not found.');
    }
  }

  /**
   * Probe a library root.
   *
   * A `Depth: 0` `PROPFIND` is the cheapest request that proves the credential
   * works. The error is reported by status class rather than passed through,
   * because the upstream body is attacker-influenced text and this server has no
   * use for it.
   */
  public async probe(row: LibraryRow): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    try {
      this.assertReachable(row);
      const client = await this.clientFor(row);
      await client.propfind('', { depth: 0, timeoutMs: this.deps.timeoutMs });
      return { ok: true, status: 207, error: null };
    } catch (error) {
      if (error instanceof WebDavError) {
        return { ok: false, status: error.status, error: describeWebDavStatus(error.status) };
      }
      return { ok: false, status: null, error: 'Library is unreachable.' };
    }
  }
}

function describeWebDavStatus(status: number): string {
  if (status === 401) return 'The WebDAV username or password was rejected.';
  if (status === 403) return 'The WebDAV account may not read that path.';
  if (status === 404) return 'The library root path does not exist on the WebDAV server.';
  if (status === 429) return 'The WebDAV server is rate limiting this worker.';
  if (status >= 500) return 'The WebDAV server returned a server error.';
  return `The WebDAV server responded ${status}.`;
}

export { LibraryService, normalizeBaseUrl, normalizeRootPath, normalizeSlug, describeWebDavStatus };
export type { LibraryDeps, ResolvedLibrary };
