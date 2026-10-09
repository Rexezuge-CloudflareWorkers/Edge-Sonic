/**
 * Tag scanning: turning a `<` into a name, a set of attributes, and a position.
 *
 * The layer above [`xmlCursor.ts`](./xmlCursor.ts), which knows only about characters. This file
 * knows about markup — what a tag is, what may follow its name, and where it ends — and nothing
 * about the document tree, which [`xml.ts`](./xml.ts) owns. Three layers rather than two because
 * `scanAttributes` is where the reader's real branching lives: `>` versus `/>`, a namespace
 * declaration versus a real attribute, and four distinct ways to be malformed. Folding that into
 * either neighbour is what took the original single function to a cognitive complexity of 110.
 *
 * Nothing here touches the tree, so every function is testable against a string.
 */
import {
  NAME_CHAR,
  NAME_START,
  atEnd,
  cursorAt,
  decodeEntities,
  fail,
  peek,
  scanAssignedValue,
  scanThrough,
  skipNamespaceDeclaration,
  skipWhitespace,
  startsWith,
} from './xmlCursor';
import type { Cursor } from './xmlCursor';

/**
One `<name …>` or `</name>`: what it names, what it carries, and where it ends.
*/
interface ScannedTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  /**
  Index just past the tag's `>`, which is where scanning resumes.
  */
  end: number;
}

/**
 * Non-tag markup: a comment, a CDATA section, or a processing instruction.
 *
 * Returns the resume index, or `null` when the `<` at `open` begins something else. One case
 * because they share both properties that matter here: they carry no data this reader uses,
 * and each is closed by a fixed terminator.
 */
function scanOpaqueMarkup(source: string, open: number): number | null {
  const cursor = cursorAt(source, open);
  if (startsWith(cursor, '<!--')) {
    cursor.index = open + 4;
    scanThrough(cursor, '-->', 'Unterminated comment.');
    return cursor.index;
  }
  if (startsWith(cursor, '<![CDATA[')) {
    cursor.index = open + 9;
    // CDATA is verbatim by definition — no entity decoding, no escaping.
    const end = source.indexOf(']]>', open + 9);
    if (end === -1) fail('Unterminated CDATA section.');
    return end + 3;
  }
  if (startsWith(cursor, '<?')) {
    cursor.index = open + 2;
    // Processing instructions (`<?xml …?>`, `<?xml-stylesheet …?>`) carry no data this reader uses.
    scanThrough(cursor, '?>', 'Unterminated processing instruction.');
    return cursor.index;
  }
  return null;
}

/**
 * Read one element's attributes, up to and including its `>`.
 *
 * Its own function because this is where the reader's real branching lives — `>` versus `/>`, a
 * namespace declaration versus a real attribute, and four ways to be malformed. Returns the
 * attributes and whether the tag closed itself; the cursor carries the position.
 */
function scanAttributes(cursor: Cursor, closing: boolean): { attrs: Record<string, string>; selfClosing: boolean } {
  const attrs: Record<string, string> = {};
  let selfClosing = false;

  for (;;) {
    skipWhitespace(cursor);
    if (atEnd(cursor)) fail('Unterminated tag.');

    if (peek(cursor) === '>') {
      cursor.index += 1;
      break;
    }
    if (startsWith(cursor, '/>')) {
      selfClosing = true;
      cursor.index += 2;
      break;
    }
    // Nothing but the name may follow `</`. Without this a closing tag could carry
    // attributes, and the tree would record them on an element that never opened.
    if (closing) fail('Unexpected content in a closing tag.');

    const attrStart = cursor.index;
    while (!atEnd(cursor) && NAME_CHAR.test(peek(cursor))) cursor.index += 1;
    if (cursor.index === attrStart) fail('Malformed attribute name.');
    const attrName = cursor.source.slice(attrStart, cursor.index);

    if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) {
      skipNamespaceDeclaration(cursor);
      continue;
    }

    attrs[attrName] = decodeEntities(scanAssignedValue(cursor));
  }

  return { attrs, selfClosing };
}

/**
 * Read a name at the cursor, leaving it on the first character after.
 *
 * Fails on a leading character that cannot begin a name: the only place the reader
 * distinguishes "not a tag" from "a tag it cannot read", and it reports the second, because a
 * `<` followed by punctuation is a malformed document rather than text.
 */
function scanName(cursor: Cursor): string {
  if (atEnd(cursor) || !NAME_START.test(peek(cursor))) fail('Malformed tag name.');
  const start = cursor.index;
  while (!atEnd(cursor) && NAME_CHAR.test(peek(cursor))) cursor.index += 1;
  return cursor.source.slice(start, cursor.index);
}

/**
 * Read one `<name …>` or `</name>` at `open`, which the caller has established is a `<` and is
 * not a `DOCTYPE`, comment, CDATA section or processing instruction.
 */
function scanTag(source: string, open: number): ScannedTag {
  const closing = source.startsWith('</', open);
  const cursor = cursorAt(source, open + (closing ? 2 : 1));
  const name = scanName(cursor);
  const { attrs, selfClosing } = scanAttributes(cursor, closing);
  return { name, attrs, selfClosing, end: cursor.index };
}

export { scanAttributes, scanName, scanOpaqueMarkup, scanTag };
export type { ScannedTag };
