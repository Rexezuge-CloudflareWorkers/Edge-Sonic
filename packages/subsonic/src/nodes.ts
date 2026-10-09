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
   * Render the element's children **directly** as the JSON value of this key — a bare
   * `[...]` rather than an object wrapping the repeated child.
   *
   * OpenSubsonic's `Child.artists` is the case: the specification's own example is
   * `"artists": [{"id": "ar-1", "name": "Artist 1"}]` and Navidrome emits exactly that. It is a
   * different shape from a Subsonic list wrapper, where the wrapper's name and the child's
   * differ — `albumList2.album` — and the value belongs under the *child's* key.
   *
   * Here they are the same word in two grammatical forms: the wrapper is `artists` and the
   * child is `artist`. A client's model is a `List<Artist>` bound to `artists`, so the array
   * belongs at the wrapper's key. `{"artist":[{…}]}` is not a near miss — a client decoding
   * `artists` as a list reads an object there and throws.
   *
   * Pairs with `array: true`, which collapses the wrapper's single occurrence back to the
   * array it already is; `array` alone would wrap the array in another array.
   */
  readonly jsonArray?: boolean;
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

/**
Build an element node.
*/
function el(name: string, attrs?: Readonly<Record<string, Scalar | null | undefined>>, children?: readonly Node[]): ElementNode {
  return { name, ...(attrs && { attrs }), ...(children && { children }) };
}

/**
 * Build a list element: a wrapper whose repeated child is **always** a JSON array.
 *
 * ### Why `listKey` is a parameter and not inferred
 *
 * One thing has to be true of a Subsonic list in JSON that cannot be read off the
 * children: a single element must render as an array rather than a bare object.
 *
 * With no children there is no name to infer from, and the *empty* case needs no
 * declaration at all — an empty list renders as an absent key. Navidrome answers
 * `{"starred2":{}}` for a user who has starred nothing, and so does this.
 *
 * That inverts what the parameter used to be for. It was declared so an empty list would
 * render as `[]`, on the grounds that a client reading `response.starred2.song.map(...)`
 * throws on an absent key. That fixed the symptom rather than the cause: the throw is a
 * client that cannot tolerate an absent optional field, and emitting `[]` made this server
 * the only implementation answering differently from the one clients are written against.
 *
 * @param name The wrapper element, e.g. `albumList2`.
 * @param listKey The repeated child element, e.g. `album`. Only that child is flagged:
 *   `playQueue` and `bookmarks` mix a repeated element with scalar siblings, and flagging
 *   those turned `playQueue.current` into a one-element array where the schema says a song
 *   id. A wrapper holding several kinds of repeated child — `starred2` is `album` *and*
 *   `song` — takes both, and gets one list per kind rather than a merged one.
 */
function elList(
  name: string,
  listKey: string | readonly string[] | undefined,
  attrs?: Readonly<Record<string, Scalar | null | undefined>>,
  children?: readonly Node[],
): ElementNode {
  // The child **named by `listKey`** is flagged, so a single one still serializes as an
  // array: Subsonic's own server emits a bare object there, and clients written against
  // it have to accept all three shapes, so arrays are the safe choice.
  //
  // Only that child. `playQueue` and `bookmarks` both mix a repeated element with
  // scalar siblings — `current`, `position`, `username` — and flagging those turned
  // `playQueue.current` into a one-element array, so a client reading the current track
  // got an array where the schema says a song id.
  const keys = new Set(listKey === undefined ? [] : typeof listKey === 'string' ? [listKey] : [...listKey]);
  const flagged = children?.map((child) => (isElementNode(child) && keys.has(child.name) ? { ...child, array: true } : child));
  return {
    name,
    ...(attrs && { attrs }),
    ...(flagged && { children: flagged }),
    ...(listKey !== undefined && { listKey }),
  };
}

function isElementNode(node: Node): node is ElementNode {
  return typeof node === 'object' && node !== null && 'name' in node;
}

/**
 * Build a wrapper whose children are the JSON value of this key: `{"artists": [ … ]}`.
 *
 * Not `elList`, because the two differ in where the array lands. `elList('artists', 'artist')`
 * puts it under the *child's* key — `{"artists": {"artist": [ … ]}}` — which is right for a
 * Subsonic list wrapper (`albumList2.album`) and wrong for OpenSubsonic's `artists`, where the
 * wrapper and the child are the same word and the client's model is a list bound to the
 * wrapper's own key.
 *
 * @param name The wrapper element, and the JSON key the array lands at.
 * @param childName The repeated child element. Singular where the wrapper is plural.
 */
function elArray(
  name: string,
  childName: string,
  attrs: Readonly<Record<string, Scalar | null | undefined>>,
  children: readonly Node[],
): ElementNode {
  return {
    name,
    ...(Object.keys(attrs).length > 0 && { attrs }),
    children: children.map((child) => (isElementNode(child) && child.name === childName ? { ...child, array: true } : child)),
    array: true,
    jsonArray: true,
  };
}

export { el, elList, elArray, isElementNode };
export type { ElementNode, Node, Scalar };
