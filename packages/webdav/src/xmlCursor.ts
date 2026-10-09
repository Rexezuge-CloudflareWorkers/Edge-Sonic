/**
 * The lexical layer of the strict XML reader: a cursor over the source plus the
 * primitives that advance it.
 *
 * Split out of [`xml.ts`](./xml.ts) because the reader has two jobs that fail differently. This
 * file knows about characters, quoting and terminators; `xml.ts` knows about the document tree.
 * While both lived in one function the two interleaved down to five levels of nesting at a
 * cognitive complexity of 110, on the one parser that reads from a user-chosen remote origin.
 *
 * Everything here is **strict**: every failure throws {@link XmlParseError} rather than
 * returning a partial result. A half-parsed `207` would put wrong paths into the index, and
 * index rows become stream targets, so there is no recovery path and no lenient mode.
 */

/**
The five names XML predefines. Nothing else is expanded, and that is the whole point.
*/
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
 * Anything not in the table is left **verbatim** rather than dropped. A filename containing
 * `&foo;` is a real thing; silently deleting it would point the index at a different file than
 * the one on disk.
 *
 * It lives in the lexical layer rather than beside the tree because an entity is resolved
 * when the characters are read, before anything knows which element they belong to — and the
 * same call has to run on attribute values, which are scanned in this file too.
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

class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

/**
 * A position in the source, advanced in place.
 *
 * Mutable rather than a value threaded through every return type: `scanAttributes` alone passes a
 * position across four loop iterations and two nested reads, and threading it by return value
 * turned one function into four with no clearer contract. Every function documents where it
 * leaves it.
 */
interface Cursor {
  readonly source: string;
  index: number;
}

/**
The only whitespace XML permits between markup tokens.
*/
const WHITESPACE = /\s/;

/**
A character that may begin an element or attribute name.
*/
const NAME_START = /[A-Z_:]/i;

/**
A character that may continue one.
*/
const NAME_CHAR = /[-\w.:]/;

/**
Always throws. Named so call sites read as a decision rather than as a `throw`.
*/
function fail(message: string): never {
  throw new XmlParseError(message);
}

function cursorAt(source: string, index: number): Cursor {
  return { source, index };
}

function startsWith(cursor: Cursor, token: string): boolean {
  return cursor.source.startsWith(token, cursor.index);
}

function atEnd(cursor: Cursor): boolean {
  return cursor.index >= cursor.source.length;
}

function peek(cursor: Cursor): string {
  return cursor.source[cursor.index] ?? '';
}

/**
Advance past every whitespace character, leaving the cursor on the first non-space one.
*/
function skipWhitespace(cursor: Cursor): void {
  while (!atEnd(cursor) && WHITESPACE.test(peek(cursor))) cursor.index += 1;
}

/**
 * Consume through the next occurrence of `terminator`, leaving the cursor just past it.
 *
 * The reason every unterminated construct reports is here rather than at each call site:
 * they all fail the same way and all mean the same thing — the document ended inside a
 * construct it promised to close.
 */
function scanThrough(cursor: Cursor, terminator: string, message: string): void {
  const end = cursor.source.indexOf(terminator, cursor.index);
  if (end === -1) fail(message);
  cursor.index = end + terminator.length;
}

/**
 * Read one quoted attribute value.
 *
 * XML requires the quotes, and an unquoted value is refused rather than guessed at: a lenient
 * reader here would have to decide where the value ends, and every wrong answer puts a wrong
 * filename in the index.
 */
function scanQuotedValue(cursor: Cursor): string {
  const quote = peek(cursor);
  if (quote !== '"' && quote !== "'") fail('Unquoted attribute value.');
  const end = cursor.source.indexOf(quote, cursor.index + 1);
  if (end === -1) fail('Unterminated attribute value.');
  const value = cursor.source.slice(cursor.index + 1, end);
  cursor.index = end + 1;
  return value;
}

/**
 * Read an `=` and the value after it, tolerating whitespace on either side.
 *
 * `message` exists so the two callers can name their own failure. They were separate
 * functions differing only in that string, and two implementations of "the value after an
 * equals sign" is two answers to one question — the next edit to one would not have reached
 * the other, and which of the two reports "malformed" would have started depending on which
 * route a declaration arrived by.
 */
function scanAssignedValue(cursor: Cursor, message = 'Malformed attribute.'): string {
  skipWhitespace(cursor);
  if (peek(cursor) !== '=') fail(message);
  cursor.index += 1;
  skipWhitespace(cursor);
  return scanQuotedValue(cursor);
}

/**
 * Consume a namespace declaration whole, without recording it.
 *
 * Namespace declarations are accepted and ignored, because the reader matches on local
 * names precisely so that a server choosing `D:` or `d:` cannot change the result — but
 * they still have to be *parsed*, or the `=` would be read as the start of the next
 * attribute. Consuming them as a unit is also why an `xmlns` cannot half-register and
 * then be re-read as a real attribute.
 */
function skipNamespaceDeclaration(cursor: Cursor): void {
  scanAssignedValue(cursor, 'Malformed namespace declaration.');
}

export {
  NAME_CHAR,
  NAME_START,
  PREDEFINED_ENTITIES,
  WHITESPACE,
  XmlParseError,
  atEnd,
  cursorAt,
  decodeEntities,
  fail,
  peek,
  scanAssignedValue,
  scanQuotedValue,
  scanThrough,
  skipNamespaceDeclaration,
  skipWhitespace,
  startsWith,
};
export type { Cursor };
