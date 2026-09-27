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
 */

/**
Refuse beyond this nesting depth. A real `207` is 4 levels deep.
*/
const MAX_DEPTH = 32;

/**
Refuse beyond this document size, to bound a hostile response.
*/
const MAX_XML_BYTES = 8 * 1024 * 1024;

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode character and predefined entity references.
 *
 * Anything not in the table is left **verbatim** rather than dropped. A
 * filename containing `&foo;` is a real thing; silently deleting it would point
 * the index at a different file than the one on disk.
 */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : match;
    }
    return PREDEFINED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

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

class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const NAME_START = /[A-Z_:]/i;
const NAME_CHAR = /[-\w.:]/i;

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
  const stack: XmlElement[] = [root];
  let index = 0;

  const fail = (message: string): never => {
    throw new XmlParseError(message);
  };

  while (index < source.length) {
    const open = source.indexOf('<', index);

    if (open === -1) {
      appendText(stack.at(-1)!, decodeEntities(source.slice(index)));
      break;
    }

    if (open > index) {
      appendText(stack.at(-1)!, decodeEntities(source.slice(index, open)));
    }

    // A DOCTYPE can declare entities, and is the entry point for every entity
    // attack there is. This server never needs one.
    if (source.startsWith('<!DOCTYPE', open)) fail('DOCTYPE declarations are not accepted.');

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end === -1) fail('Unterminated comment.');
      index = end + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      if (end === -1) fail('Unterminated CDATA section.');
      // CDATA is verbatim by definition — no entity decoding, no escaping.
      appendText(stack.at(-1)!, source.slice(open + 9, end));
      index = end + 3;
      continue;
    }

    // Processing instructions (`<?xml …?>`, `<?xml-stylesheet …?>`) carry no
    // data this reader uses.
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      if (end === -1) fail('Unterminated processing instruction.');
      index = end + 2;
      continue;
    }

    const closing = source.startsWith('</', open);
    let cursor = open + (closing ? 2 : 1);

    if (cursor >= source.length || !NAME_START.test(source[cursor] ?? '')) fail('Malformed tag name.');

    let nameEnd = cursor;
    while (nameEnd < source.length && NAME_CHAR.test(source[nameEnd])) nameEnd += 1;
    const name = source.slice(cursor, nameEnd);
    cursor = nameEnd;

    const attrs: Record<string, string> = {};
    let selfClosing = false;

    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (cursor >= source.length) fail('Unterminated tag.');

      if (source[cursor] === '>') {
        cursor += 1;
        break;
      }
      if (source.startsWith('/>', cursor)) {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (closing) fail('Unexpected content in a closing tag.');

      const attrStart = cursor;
      while (cursor < source.length && NAME_CHAR.test(source[cursor])) cursor += 1;
      if (cursor === attrStart) fail('Malformed attribute name.');
      const attrName = source.slice(attrStart, cursor);
      if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) {
        // Namespace declarations are accepted and ignored: the reader matches on
        // local names precisely so that a server choosing `D:` or `d:` cannot
        // change the result.
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        if (source[cursor] !== '=') fail('Malformed namespace declaration.');
        cursor += 1;
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        const quote = source[cursor];
        if (quote !== '"' && quote !== "'") fail('Unquoted attribute value.');
        const end = source.indexOf(quote, cursor + 1);
        if (end === -1) fail('Unterminated attribute value.');
        cursor = end + 1;
        continue;
      }

      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] !== '=') fail('Malformed attribute.');
      cursor += 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;

      const quote = source[cursor];
      if (quote !== '"' && quote !== "'") fail('Unquoted attribute value.');
      const valueEnd = source.indexOf(quote, cursor + 1);
      if (valueEnd === -1) fail('Unterminated attribute value.');
      attrs[attrName] = decodeEntities(source.slice(cursor + 1, valueEnd));
      cursor = valueEnd + 1;
    }

    if (closing) {
      const current = stack.pop();
      if (!current || localName(current.name) !== localName(name)) fail(`Mismatched closing tag </${name}>.`);
      index = cursor;
      continue;
    }

    const element: XmlElement = { name, attrs, children: [], text: '' };
    stack.at(-1)!.children.push(element);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) fail(`XML nesting deeper than ${MAX_DEPTH}.`);
      stack.push(element);
    }
    index = cursor;
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

export { parseXml, decodeEntities, localName, firstChild, childText, findDescendants, XmlParseError, MAX_DEPTH, MAX_XML_BYTES };
export type { XmlElement };
