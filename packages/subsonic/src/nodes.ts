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
   * Render as a JSON array in every case.
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
  /**
   * The repeated child element(s) this wrapper always carries in JSON.
   *
   * Declared rather than inferred so an **empty** list still renders as `[]`; see
   * `elList`. An array is for a list that legitimately holds more than one kind of
   * child — `starred2` is `album` *and* `song`, and a client reading `.album` on a
   * user who has starred only songs would otherwise get `undefined`.
   */
  readonly listKey?: string | readonly string[];
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
 * Build a list element: a wrapper whose `listKey` is **always** a JSON array.
 *
 * ### Why `listKey` is a parameter and not inferred
 *
 * Two things have to be true of a Subsonic list in JSON, and only one of them is
 * visible from the children:
 *
 * 1. a repeated child renders as an array rather than a bare object, and
 * 2. an **empty** list renders as `[]` rather than being absent.
 *
 * (1) can be inferred from the children. (2) cannot: with no children there is no name
 * to infer. Omitting the key then produces `{"starred2": {}}` for a user who has
 * starred nothing, and a client that reads `response.starred2.song.map(...)` throws
 * instead of rendering an empty screen.
 *
 * So the name is stated. A caller that omits it gets a wrapper that renders only its
 * attributes — correct for the endpoints whose payload is optional rather than
 * required, and never a silently wrong shape for the ones that are.
 *
 * @param name The wrapper element, e.g. `albumList2`.
 * @param listKey The repeated child element, e.g. `album`. Omit only when an empty
 *   list should render as an absent key.
 */
function elList(
  name: string,
  listKey: string | readonly string[] | undefined,
  attrs?: Readonly<Record<string, Scalar | null | undefined>>,
  children?: readonly Node[],
): ElementNode {
  // Each child is flagged so a single one still serializes as an array: Subsonic's
  // own server emits a bare object there, and clients written against it have to
  // accept all three shapes, so arrays are the safe choice.
  const flagged = children?.map((child) => (isElementNode(child) ? { ...child, array: true } : child));
  return {
    name,
    ...(attrs ? { attrs } : {}),
    ...(flagged ? { children: flagged } : {}),
    ...(listKey === undefined ? {} : { listKey }),
  };
}

function isElementNode(node: Node): node is ElementNode {
  return typeof node === 'object' && node !== null && 'name' in node;
}

export { el, elList, isElementNode };
export type { ElementNode, Node, Scalar };
