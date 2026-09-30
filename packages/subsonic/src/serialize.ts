/**
 * XML and JSON serialization for the Subsonic envelope.
 *
 * No XML library, by design. A DOM parser is available in the runtime, but
 * building documents by string concatenation over a node tree is both smaller
 * and — more importantly — auditable in one place. The only XML that reaches
 * this module is generated here, so there is no untrusted markup on this path;
 * the escaping below exists for *values* (artist names, filenames, comments),
 * which absolutely are untrusted.
 */
import type { ElementNode, Node, Scalar } from './nodes';
import { isElementNode } from './nodes';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
Escape a value for an XML text node or attribute value.
*/
function escapeXml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/**
 * JSON has no `undefined`, and Subsonic fields are optional rather than null
 * when absent: a client distinguishes "no duration" from "duration 0", and
 * `null` is not one of the values the XSD allows. Omitting is the only correct
 * encoding, so `undefined` and `null` attributes are dropped entirely.
 */
function isPresent(value: Scalar | null | undefined): value is Scalar {
  return value !== null && value !== undefined;
}

function serializeXmlNode(node: Exclude<Node, null | undefined | false>, out: string[]): void {
  if (!isElementNode(node)) {
    out.push(escapeXml(String(node)));
    return;
  }

  out.push('<', node.name);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (!isPresent(value)) continue;
    out.push(' ', key, '="', escapeXml(String(value)), '"');
  }

  const children = (node.children ?? []).filter((child) => child !== null && child !== undefined && child !== false);
  if (children.length === 0) {
    out.push('/>');
    return;
  }

  out.push('>');
  for (const child of children) {
    serializeXmlNode(child, out);
  }
  out.push('</', node.name, '>');
}

function serializeXml(root: ElementNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  serializeXmlNode(root, out);
  return out.join('');
}

/**
 * Collapse a node's children into JSON keys.
 *
 * Two children sharing a name become an array, and the array position follows
 * document order, which is the order the endpoint produced — `searchResult3`
 * must not reorder its artist/album/song groups, and a `directory`'s `child`
 * order is the sort order the client asked for.
 */
function childrenToJsonObject(children: readonly Node[]): Record<string, unknown> {
  const groups = new Map<string, unknown[]>();
  const flags = new Map<string, boolean>();

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    const value = isElementNode(child) ? childToJsonValue(child) : child;
    if (isElementNode(child) && child.array) flags.set(child.name, true);
    const existing = groups.get(childName(child));
    if (existing) {
      existing.push(value);
    } else {
      groups.set(childName(child), [value]);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [name, values] of groups) {
    // A lone list element *is* that list, not a one-element array holding it.
    //
    // `childToJsonValue` already returns `[]` for an empty flagged element and the
    // children themselves for a populated one, so the grouping step has to collapse a
    // single occurrence back down or the caller reads `[[]]` and `[a, b]`. This is the
    // same rule `childToJsonValue` applies one level up for an element with a single
    // scalar child, and it is what makes `array: true` mean "render as a JSON array"
    // rather than "render as an array, wrapped in another array".
    if (flags.get(name) && values.length === 1 && Array.isArray(values[0])) {
      result[name] = values[0];
      continue;
    }
    result[name] = flags.get(name) ? values : values.length === 1 ? values[0] : values;
  }
  return result;
}

function childName(node: Node): string {
  return isElementNode(node) ? node.name : '#text';
}

/**
The declared list keys, normalized to an array.
*/
function listKeysOf(node: ElementNode): readonly string[] {
  if (node.listKey === undefined) return [];
  return typeof node.listKey === 'string' ? [node.listKey] : node.listKey;
}

function childToJsonValue(node: ElementNode): unknown {
  const children = (node.children ?? []).filter((child) => child !== null && child !== undefined && child !== false);
  const attributeEntries = Object.entries(node.attrs ?? {}).filter(([, value]) => isPresent(value));

  // An element with no attributes and exactly one **scalar** child is that scalar.
  //
  // Subsonic uses text content for values — `<position>42000</position>`,
  // `<username>ann</username>`, `<minutesAgo>3</minutesAgo>` — and a JSON client reads
  // `bookmark.position` as a number. Flattening the child into a key instead produces
  // `{"position": {"#text": 42000}}`, which is a number nested under a magic string
  // that appears in no schema. The condition is deliberately narrow: an element with
  // attributes is a record, and an element with element children is a record.
  if (attributeEntries.length === 0 && children.length === 1) {
    const only = children[0];
    if (!isElementNode(only)) return only;
  }

  // An element declared as a list, with nothing in it, is an empty **array**.
  //
  // The third shape a Subsonic list can take, and the one the protocol's own JSON uses for
  // `openSubsonicExtensions`: a bare `[...]` at the parent key rather than an object
  // wrapping the repeated child. Without this, a childless flagged element serialised as
  // `{}` (or `[{}]`, since the flag also forces the array), and a client reading
  // `response.openSubsonicExtensions.length` got `undefined` — a throw on the capability
  // call, which is the one call whose failure mode is a client deciding the server is
  // broken. It is the same rule as the `listKey` seeding below, one level out: an absent
  // value is a value.
  if (node.array === true && children.length === 0 && attributeEntries.length === 0) return [];

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (isPresent(value)) result[key] = value;
  }
  // A list wrapper with a declared key always carries that key, even with no children:
  // `{"starred2": {}}` makes a client reading `.song.map(...)` throw, where
  // `{"starred2": {"song": []}}` renders an empty screen. The values are seeded *before*
  // the children are merged over them, so a non-empty list still wins — and a child
  // whose name is not declared replaces its seed rather than adding a second key.
  for (const key of listKeysOf(node)) result[key] = [];
  // An element with attributes and no children is a leaf whose value lives in
  // the attributes; merging children over attributes cannot collide because
  // Subsonic never uses the same name for both.
  Object.assign(result, childrenToJsonObject(children));
  return result;
}

function serializeJson(root: ElementNode): string {
  const children = (root.children ?? []).filter((child) => child !== null && child !== undefined && child !== false);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root.attrs ?? {})) {
    if (isPresent(value)) body[key] = value;
  }
  Object.assign(body, childrenToJsonObject(children));
  return JSON.stringify({ [root.name]: body });
}

/**
 * Validate a JSONP callback name.
 *
 * JSONP executes the response as script, so the callback name is the one place
 * where a Subsonic response is a code-execution vector: an attacker who can get
 * a victim's browser to issue `/rest/ping.view?f=jsonp&callback=alert(1)//`
 * runs arbitrary script in this origin, next to the admin SPA. The response
 * bytes are already inside a `<script>` context before any check could run, so
 * the check has to happen *before* the body is produced.
 *
 * `f=jsonp` is deprecated in the protocol, so a rejected callback falls back to
 * plain JSON rather than failing the call: a broken client gets usable data,
 * and no client gets script execution.
 */
const JSONP_CALLBACK_PATTERN = /^[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)*$/i;

function isValidJsonpCallback(callback: string): boolean {
  // Bounded because the name is spliced into the response verbatim; the
  // character class already excludes the dangerous characters, and the length
  // cap keeps a megabyte-long "name" from becoming a megabyte-long identifier.
  return callback.length > 0 && callback.length <= 128 && JSONP_CALLBACK_PATTERN.test(callback);
}

function serializeJsonp(root: ElementNode, callback: string): string {
  return `${callback}(${serializeJson(root)});`;
}

export { escapeXml, serializeXml, serializeJson, serializeJsonp, isValidJsonpCallback };
