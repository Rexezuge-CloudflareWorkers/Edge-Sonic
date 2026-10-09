/**
 * A deliberately small, strict XML reader for RFC 4918 `207 Multi-Status`.
 *
 * ### Why not an XML library
 *
 * This parses one document shape — a fixed, shallow tree of properties — from
 * an origin this server fetches on a user's behalf. Two properties of the
 * hand-rolled reader matter more than generality:
 *
 * 1. **No entity expansion beyond the five predefined names and numeric
 *    character references.** An XML parser that expands entities is a denial of
 *    service surface (billion laughs) and an XXE surface, and a *remote* origin
 *    chosen by a user is exactly the wrong place to accept one. `<!DOCTYPE` is
 *    rejected outright, so an entity declaration cannot be introduced at all.
 * 2. **A depth cap.** A hostile or broken server can nest tags arbitrarily deep;
 *    the reader refuses past a depth no legitimate `207` document reaches,
 *    before a recursive walk can exhaust the stack.
 *
 * Both failure modes are hard errors, never partial results: a half-parsed
 * `207` would put wrong paths into the index, and index rows become stream
 * targets.
 *
 * ### The shape of the reader
 *
 * Markup scanning lives in [`xmlCursor.ts`](./xmlCursor.ts): a cursor, and the primitives
 * that advance it. This file owns the document tree and the parse loop. It used to be one
 * function doing both, which interleaved character handling with tree handling down to five
 * levels of nesting for a cognitive complexity of 110 — past the point where "read it and
 * check it" is a review technique, on the one parser in the repository that reads from a
 * user-chosen remote origin.
 *
 * ### The parse loop
 *
 * One loop, one job per iteration: find the next `<`, emit the text before it, then dispatch
 * on what kind of markup is there. Every construct except a tag **returns the index it
 * should resume at**, and every tag returns the cursor past its own `>`. That is what keeps
 * the loop flat — the alternative shape, where each handler mutates a shared index, is how
 * the loop grew five deep in the first place.
 */
import { XmlParseError, decodeEntities, fail } from './xmlCursor';
import { scanOpaqueMarkup, scanTag } from './xmlTag';
import type { ScannedTag } from './xmlTag';

/**
 Refuse beyond this nesting depth. A real `207` is 4 levels deep.
 */
const MAX_DEPTH = 32;

/**
 Refuse beyond this document size, to bound a hostile response.
 */
const MAX_XML_BYTES = 8 * 1024 * 1024;

/**
 Drop a namespace prefix, leaving the local name.
 */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/**
 * The open element a tag leaves the reader inside.
 *
 * A tag does one of three things to the tree, and it is this function rather than the parse
 * loop that knows which: close the current element, open a child, or open and immediately
 * close a child. Keeping that decision here is what lets the loop stay a loop — it becomes
 * one `if` on whether the markup was a tag, and the three-way tree surgery moves to a
 * function whose name is the question it answers.
 *
 * The depth check belongs here rather than in the loop for the same reason: it is a
 * precondition of *opening*, not of reading, and a limit that is checked in the loop is a
 * limit the loop can forget on a path that opens an element.
 */
function applyTag(stack: XmlElement[], current: XmlElement, source: string, open: number, tag: ScannedTag): XmlElement {
  if (source.startsWith('</', open)) {
    const closed = stack.pop();
    if (!closed || localName(closed.name) !== localName(tag.name)) {
      fail(`Mismatched closing tag </${tag.name}>.`);
    }
    // Popping past the root is impossible: the root is never matched by a closing tag, so a
    // stray `</#document>` fails the name check above first.
    return stack.at(-1) ?? current;
  }

  const element: XmlElement = { name: tag.name, attrs: tag.attrs, children: [], text: '' };
  current.children.push(element);
  if (tag.selfClosing) return current;
  if (stack.length >= MAX_DEPTH) fail(`XML nesting deeper than ${MAX_DEPTH}.`);
  stack.push(element);
  return element;
}

/**
 * Parse an XML document into a shallow tree.
 *
 * @throws XmlParseError on malformed markup, a `DOCTYPE`, or excessive depth.
 */
function parseXml(source: string): XmlElement {
  if (source.length > MAX_XML_BYTES) {
    throw new XmlParseError(`XML document exceeds ${MAX_XML_BYTES} bytes.`);
  }

  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  // `current` rather than `stack.at(-1)`. The stack is still needed for the close check, but
  // reading the open element off it four times was four non-null assertions resting on an
  // invariant nothing in the type system checked; one binding and two updates is the same
  // information with no assertion.
  const stack: XmlElement[] = [root];
  let current = root;
  let index = 0;

  while (index < source.length) {
    const open = source.indexOf('<', index);

    if (open === -1) {
      appendText(current, decodeEntities(source.slice(index)));
      break;
    }

    if (open > index) {
      appendText(current, decodeEntities(source.slice(index, open)));
    }

    // A DOCTYPE can declare entities, and is the entry point for every entity
    // attack there is. This server never needs one.
    if (source.startsWith('<!DOCTYPE', open)) fail('DOCTYPE declarations are not accepted.');

    const opaque = scanOpaqueMarkup(source, open);
    if (opaque !== null) {
      // CDATA is the one construct here that contributes text, and it is contributed
      // verbatim. Everything else in this branch carries nothing this reader uses.
      if (source.startsWith('<![CDATA[', open)) {
        appendText(current, source.slice(open + 9, source.indexOf(']]>', open + 9)));
      }
      index = opaque;
      continue;
    }

    const tag = scanTag(source, open);
    current = applyTag(stack, current, source, open, tag);
    index = tag.end;
  }

  if (stack.length !== 1) fail('Unclosed element.');
  return root;
}

function appendText(element: XmlElement, text: string): void {
  if (text.length > 0) element.text += text;
}

function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => localName(child.name) === name);
}

function childText(element: XmlElement, name: string): string | null {
  const child = firstChild(element, name);
  if (!child) return null;
  // A property may be written as `<d:getcontentlength>0</d:getcontentlength>`
  // or as an empty element; both mean "present, value is below".
  return child.text.trim();
}

function findDescendants(element: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const child of element.children) {
    if (localName(child.name) === name) out.push(child);
    findDescendants(child, name, out);
  }
  return out;
}

export { XmlParseError, decodeEntities } from './xmlCursor';
export type { Cursor } from './xmlCursor';
export type { ScannedTag } from './xmlTag';

export { MAX_DEPTH, MAX_XML_BYTES, childText, findDescendants, firstChild, localName, parseXml };
export type { XmlElement };
