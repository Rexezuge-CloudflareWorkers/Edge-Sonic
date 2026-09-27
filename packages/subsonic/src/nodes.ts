/**
 * The response node model.
 *
 * One declaration, three serializations (XML, JSON, JSONP). Writing each
 * endpoint three times is how the formats drift apart — a field added to the XML
 * and forgotten in the JSON is a bug that only a client with that exact feature
 * discovers. Every endpoint therefore builds a single node tree and the
 * serializers in `./serialize.ts` render it.
 *
 * The model is deliberately tiny: an element has a name, optional attributes,
 * children, and one flag that says how JSON should treat a repeated name.
 */

type Scalar = string | number | boolean;

interface ElementNode {
  readonly name: string;
  readonly attrs?: Readonly<Record<string, Scalar | null | undefined>>;
  readonly children?: readonly Node[];
  /**
   * Render as a JSON array in every case — including when there are no
   * children at all.
   *
   * Subsonic's own server emits `{"album": {...}}` for a single album and
   * omits the key entirely for none, so a client written against it has to
   * accept all three shapes. Emitting arrays unconditionally is the shape
   * Navidrome — the most widely deployed implementation — produces, and every
   * client already tolerates it. Without this flag, a serializer that collapses
   * a single element to a bare object would return a shape that some clients
   * reject outright, and the difference would only show up on single-item
   * results.
   */
  readonly array?: boolean;
}

type Node = ElementNode | Scalar | null | undefined | false;

/** Build an element node. */
function el(
  name: string,
  attrs?: Readonly<Record<string, Scalar | null | undefined>>,
  children?: readonly Node[],
): ElementNode {
  return { name, ...(attrs ? { attrs } : {}), ...(children ? { children } : {}) };
}

/**
 * Build a list element whose JSON form is always an array.
 *
 * The element itself is the *wrapper* the protocol specifies (`albumList2`
 * containing `album`s, `searchResult3` containing `artist`/`album`/`song`), so
 * the flag belongs on the children, not the wrapper. This helper takes the
 * wrapper's child element name and returns those children already flagged.
 */
function elList(
  name: string,
  attrs?: Readonly<Record<string, Scalar | null | undefined>>,
  children?: readonly Node[],
): ElementNode {
  return { name, ...(attrs ? { attrs } : {}), ...(children ? { children } : {}), array: true };
}

function isElementNode(node: Node): node is ElementNode {
  return typeof node === 'object' && node !== null && 'name' in node;
}

export { el, elList, isElementNode };
export type { ElementNode, Node, Scalar };
