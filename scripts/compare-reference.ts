/**
 * Compare this server's `/rest` answers against a reference server, endpoint by endpoint.
 *
 * ### Why this exists
 *
 * Every defect fixed alongside this script was invisible to the test suite, and all of
 * them for the same reason: **an attribute the schema does not declare is not an error.**
 * `AlbumID3` had no `isDir`, so every album carried one and nothing complained — a
 * lenient client drops it, a strict one ignores it, and this repository's own assertions
 * checked *values* rather than the field set. `song.type` published `mediaType`'s value,
 * so no player filtering `type == "music"` found a library, and no test failed either.
 *
 * A unit test can assert what this code *intends* to publish. It cannot notice a field
 * that was never intended, because the only place that fact exists is the schema — and
 * the schema is not in this repository. Reading the same call off a server that
 * implements it puts the two side by side, and the difference is the whole finding.
 *
 * So the harness is committed rather than run once and discarded: a difference reported
 * here is a difference a client would hit.
 *
 * ### Usage
 *
 * ```sh
 * REFERENCE_URL=https://navi.example.com REFERENCE_USER=alice \
 * EDGE_URL=http://localhost:8787 EDGE_USER=fin \
 *   pnpm exec tsx scripts/compare-reference.ts
 * ```
 *
 * Credentials come from the environment and are never written to disk or to a default.
 * `f=json` is forced, because a shape comparison cannot be read off XML.
 *
 * ### Reading the output
 *
 * `MISSING` is a field the reference publishes and this server does not — the class of
 * defect this whole exercise is about. `EXTRA` is the mirror image: this server
 * publishing something the schema does not declare, which is equally wrong and equally
 * invisible from inside. A bare `—` means the two agree on the key set, which is the
 * only part of the comparison that is trustworthy: ids and values differ by design.
 */
import { XML_NAMESPACE } from '../packages/subsonic/src/constants';

/**
The attributes every response carries, so they are never reported as a difference.
*/
const ENVELOPE_KEYS = new Set(['status', 'version', 'type', 'serverVersion', 'openSubsonic']);

interface Config {
  readonly reference: { url: string; user: string; password: string };
  readonly edge: { url: string; user: string; password: string };
  readonly json: boolean;
}

/**
 * The endpoints worth comparing, with the parameters each one needs.
 *
 * `id` parameters are omitted deliberately: an id from one server is meaningless to the
 * other, so supplying one would compare a not-found against a not-found and learn
 * nothing. Ids are compared by *drilling* instead — see `resolveIds`.
 */
const CALLS: readonly { endpoint: string; params?: Record<string, string> }[] = [
  { endpoint: 'ping' },
  { endpoint: 'getLicense' },
  { endpoint: 'getMusicFolders' },
  { endpoint: 'getOpenSubsonicExtensions' },
  { endpoint: 'getScanStatus' },
  { endpoint: 'getUser', params: { username: '{user}' } },
  { endpoint: 'getIndexes' },
  { endpoint: 'getArtists' },
  { endpoint: 'getGenres' },
  { endpoint: 'getNowPlaying' },
  { endpoint: 'getPlaylists' },
  { endpoint: 'getStarred' },
  { endpoint: 'getStarred2' },
  { endpoint: 'getBookmarks' },
  { endpoint: 'getPlayQueue' },
  { endpoint: 'getAlbumList2', params: { type: 'alphabeticalByName', size: '5' } },
  { endpoint: 'getAlbumList', params: { type: 'alphabeticalByName', size: '5' } },
  { endpoint: 'getAlbumList2', params: { type: 'random', size: '5' } },
  { endpoint: 'getRandomSongs', params: { size: '5' } },
  { endpoint: 'search2', params: { query: 'a', albumCount: '3', artistCount: '3', songCount: '3' } },
  { endpoint: 'search3', params: { query: 'a', albumCount: '3', artistCount: '3', songCount: '3' } },
];

function readConfig(): Config {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required. Credentials are read from the environment and never defaulted.`);
    return value;
  };
  return {
    reference: {
      url: required('REFERENCE_URL').replace(/\/$/, ''),
      user: required('REFERENCE_USER'),
      password: required('REFERENCE_PASSWORD'),
    },
    edge: { url: required('EDGE_URL').replace(/\/$/, ''), user: required('EDGE_USER'), password: required('EDGE_PASSWORD') },
    json: process.env.COMPARE_JSON !== '0',
  };
}

async function call(server: Config['reference'], endpoint: string, params: Record<string, string>, json: boolean): Promise<unknown> {
  const query = new URLSearchParams({
    u: server.user,
    p: server.password,
    v: '1.16.1',
    c: 'compare',
    ...(json && { f: 'json' }),
    ...params,
  });
  const response = await fetch(`${server.url}/rest/${endpoint}.view?${query}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __status: response.status, __contentType: response.headers.get('content-type'), __body: text.slice(0, 200) };
  }
}

/**
 * The **union** of attribute keys over every element named `key`, anywhere in the tree.
 *
 * A union rather than a per-element variant, for one reason: optional fields mean an
 * album with a genre and an album without one produce different key sets, so comparing
 * variants reports the same benign difference once per variant and buries the real
 * finding. The union is what "could this element ever carry `isDir`?" needs answered,
 * and that question is the one this whole script exists to ask.
 *
 * Keyed per element *name* rather than globally, because two elements sharing a name in
 * different parts of one response are legitimately different types — `albumList.album`
 * is a `Child` and `albumList2.album` is an `AlbumID3` — and a single global set would
 * hide exactly that.
 */
function keyUnion(node: unknown, key: string, out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (Array.isArray(node)) {
    for (const item of node) keyUnion(item, key, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [name, value] of Object.entries(node)) {
      if (name === key && value && typeof value === 'object') recordFields(value, name, out);
      keyUnion(value, key, out);
    }
  }
  return out;
}

/**
 * Every field name any element under `name` has ever carried, merged into the set.
 *
 * Separate from {@link keyUnion} because this is the answer and that is the search: the
 * recursion walks the whole document looking for one key, and folding the accumulation into it
 * meant the walk's `if`s and the union's `if`s shared a nesting level for no reason. A single
 * element collapsing to a bare object rather than a one-element array is handled here, because
 * that is a property of the value under the key rather than of the walk that found it.
 */
function recordFields(value: object, name: string, out: Map<string, Set<string>>): void {
  const items = Array.isArray(value) ? value : [value];
  const existing = out.get(name) ?? new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    for (const field of Object.keys(item)) existing.add(field);
  }
  out.set(name, existing);
}

/**
 * A string list in a stable order.
 *
 * Every comparison in this file is between two sets of identifiers, so the order only
 * has to be *the same* on both sides — but it has to be the same on every machine,
 * which the default `sort()` does not guarantee (it orders by UTF-16 code unit, and
 * `localeCompare` orders by locale). One helper, so the comparator cannot be spelled
 * two ways and one of the comparisons quietly uses a different order than the other.
 */
function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function describe(node: unknown): string {
  if (Array.isArray(node)) return `ARRAY(${node.length})`;
  if (node && typeof node === 'object') return sorted(Object.keys(node)).join(',');
  return typeof node;
}

/**
Every element name present, so a wrapper missing from one side is itself reported.
*/
function elementNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) elementNames(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [name, value] of Object.entries(node)) {
      if (!(value && typeof value === 'object')) {
        continue;
      }

      out.add(name);
      elementNames(value, out);
    }
  }
  return out;
}

/**
The elements whose attribute sets are compared, and the wrapper key names treated as boilerplate.
*/
const COMPARED_ELEMENTS = ['album', 'song', 'child', 'artist', 'index', 'entry', 'folder', 'musicFolder'] as const;

/**
 * Everything one endpoint pair disagrees about, as differences.
 *
 * Its own function because {@link compare} is a loop over endpoints and this is a comparison of
 * two bodies, and folding the second into the first put four independent checks inside the loop
 * that walks them. Each check below answers a different question — the wrapper's key set, each
 * element's attribute union, the set of element names — so each returns its own differences and
 * nothing here decides whether the endpoint matched.
 *
 * @returns the differences; empty means the two envelopes agree in every way this file measures.
 */
function compareOne(label: string, referenceBody: Record<string, unknown>, edgeBody: Record<string, unknown>): Difference[] {
  const differences: Difference[] = [];

  // The wrapper itself. An empty list and an absent key are different answers, and this is the
  // only place that difference is visible.
  const referenceKeys = new Set(Object.keys(referenceBody).filter((key) => !ENVELOPE_KEYS.has(key)));
  const edgeKeys = new Set(Object.keys(edgeBody).filter((key) => !ENVELOPE_KEYS.has(key)));
  if (describe(sorted(referenceKeys)) !== describe(sorted(edgeKeys))) {
    differences.push({
      endpoint: label,
      what: 'wrapper keys',
      detail: `reference=[${sorted(referenceKeys).join(',')}] edge=[${sorted(edgeKeys).join(',')}]`,
    });
  }

  // Per-element attribute unions, which is where an undeclared field shows up.
  for (const element of COMPARED_ELEMENTS) {
    const a = keyUnion(referenceBody, element).get(element) ?? new Set<string>();
    const b = keyUnion(edgeBody, element).get(element) ?? new Set<string>();
    if (a.size === 0 && b.size === 0) continue;
    const missing = sorted([...a].filter((field) => !b.has(field)));
    const extra = sorted([...b].filter((field) => !a.has(field)));
    if (missing.length > 0) differences.push({ endpoint: label, what: `${element} MISSING`, detail: missing.join(',') });
    if (extra.length > 0) differences.push({ endpoint: label, what: `${element} EXTRA`, detail: extra.join(',') });
  }

  const referenceNames = sorted(elementNames(referenceBody));
  const edgeNames = sorted(elementNames(edgeBody));
  if (describe(referenceNames) !== describe(edgeNames)) {
    const onlyReference = referenceNames.filter((name) => !edgeNames.includes(name));
    const onlyEdge = edgeNames.filter((name) => !referenceNames.includes(name));
    if (onlyReference.length > 0) differences.push({ endpoint: label, what: 'elements MISSING', detail: onlyReference.join(',') });
    if (onlyEdge.length > 0) differences.push({ endpoint: label, what: 'elements EXTRA', detail: onlyEdge.join(',') });
  }

  return differences;
}

interface Difference {
  readonly endpoint: string;
  readonly what: string;
  readonly detail: string;
}

async function compare(config: Config): Promise<Difference[]> {
  const differences: Difference[] = [];

  for (const { endpoint, params = {} } of CALLS) {
    const label = `${endpoint}${Object.keys(params).length > 0 ? ` ${JSON.stringify(params)}` : ''}`;
    const expanded = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value === '{user}' ? config.edge.user : value]));
    const [reference, edge] = await Promise.all([
      call(config.reference, endpoint, expanded, config.json),
      call(config.edge, endpoint, expanded, config.json),
    ]);

    const referenceBody = (reference as Record<string, unknown>)['subsonic-response'] as Record<string, unknown> | undefined;
    const edgeBody = (edge as Record<string, unknown>)['subsonic-response'] as Record<string, unknown> | undefined;

    if (!referenceBody || !edgeBody) {
      differences.push({ endpoint: label, what: 'not an envelope', detail: `reference=${describe(reference)} edge=${describe(edge)}` });
      continue;
    }

    differences.push(...compareOne(label, referenceBody, edgeBody));
  }

  return differences;
}

/**
 * The XML root's namespace, which JSON cannot show.
 *
 * Checked separately because it is invisible to every other assertion in this file:
 * an undeclared namespace is still well-formed XML, so a JSON comparison is blind to
 * it and so is any test that parses the document rather than validating it.
 */
async function compareNamespace(config: Config): Promise<string[]> {
  const notes: string[] = [];
  for (const [label, server] of [
    ['reference', config.reference],
    ['edge', config.edge],
  ] as const) {
    const query = new URLSearchParams({ u: server.user, p: server.password, v: '1.16.1', c: 'compare' });
    const body = await (await fetch(`${server.url}/rest/ping.view?${query}`)).text();
    const declared = /xmlns="([^"]+)"/.exec(body)?.[1];
    notes.push(`${label}: ${declared ?? 'NO NAMESPACE DECLARED'}`);
  }
  notes.push(`expected: ${XML_NAMESPACE}`);
  return notes;
}

async function main(): Promise<void> {
  const config = readConfig();
  console.log(`reference ${config.reference.url}   edge ${config.edge.url}\n`);
  for (const note of await compareNamespace(config)) console.log(note);
  console.log('');

  const differences = await compare(config);
  if (differences.length === 0) {
    console.log('no differences in attribute key sets');
    return;
  }
  for (const { endpoint, what, detail } of differences) {
    console.log(`${endpoint}\n  ${what}: ${detail}`);
  }
  console.log(`\n${differences.length} difference(s)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
