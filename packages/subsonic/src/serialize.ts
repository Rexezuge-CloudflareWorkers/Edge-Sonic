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
import { XML_NAMESPACE } from './constants';
import type { ElementNode, Node, Scalar } from './nodes';
import { isElementNode } from './nodes';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape a value for an XML text node or attribute value. */
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
    result[name] = flags.get(name) ? values : values.length === 1 ? values[0] : values;
  }
  return result;
}

function childName(node: Node): string {
  return isElementNode(node) ? node.name : '#text';
}

function childToJsonValue(node: ElementNode): unknown {
  const children = (node.children ?? []).filter((child) => child !== null && child !== undefined && child !== false);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (isPresent(value)) result[key] = value;
  }
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
const JSONP_CALLBACK_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

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
