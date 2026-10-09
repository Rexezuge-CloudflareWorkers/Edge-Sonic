import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, MAX_XML_BYTES, childText, decodeEntities, findDescendants, firstChild, localName, parseXml } from '@edge-sonic/webdav';
import { XmlParseError } from '@edge-sonic/webdav';

/**
 * The XML reader's own contracts, asserted against the reader rather than through a client.
 *
 * `test/webdav-client.test.ts` exercises this parser, but only through `207` documents that
 * happen to parse. Everything the reader *refuses* — a `DOCTYPE`, an unterminated comment,
 * an unquoted attribute value, a closing tag carrying attributes, nesting past the depth cap —
 * is unreachable from a client test that only feeds it well-formed responses, which is why
 * the two XXE-shaped branches in this file's subject had no test at all.
 *
 * It was also refactored. The lexical layer moved to `xmlCursor.ts` and the tree surgery into
 * `applyTag`, taking `parseXml` from a cognitive complexity of 110 to under 20. A parser that
 * reads from an operator-chosen remote origin is the one module in this repository where
 * "the tests still pass" is not sufficient evidence, so the refactor's claims are pinned
 * here directly: same tree, same refusals, same messages.
 */

const wrap = (inner: string): string => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`;

/**
 * The single `response` element inside the multistatus wrapper, so assertions read as tree
 * shape rather than as wrapper names.
 *
 * Two hops, not one: `parseXml` returns the synthetic `#document` root, whose only child is
 * the `d:multistatus` the wrapper contributes. A helper that stopped at `children[0]` would
 * silently assert against the wrapper and every structural assertion below would pass while
 * testing nothing about the body.
 */
function root(source: string) {
  return parseXml(wrap(source)).children[0]!.children[0]!;
}

describe('parseXml — structure', () => {
  it('reads elements, nesting them as children', () => {
    const element = root('<response><a>1</a><b>2</b></response>');
    expect(element.name).toBe('response');
    expect(element.children.map((child) => child.name)).toEqual(['a', 'b']);
    expect(childText(element, 'a')).toBe('1');
  });

  it('places a child under the element that is open, not under the last one seen', () => {
    // The refactor replaced `stack.at(-1)!` with a tracked `current`. If the tracking drifted
    // from the stack, every subsequent child would land on a sibling rather than its parent —
    // a flat tree, and a `207` whose properties attach to the wrong href.
    const element = root('<response><a><b><c/></b><d/></a></response>');
    const a = firstChild(element, 'a')!;
    const b = firstChild(a, 'b')!;
    expect(firstChild(b, 'c')).toBeDefined();
    expect(firstChild(b, 'd')).toBeUndefined();
    expect(firstChild(a, 'd')).toBeDefined();
  });

  it('reads attributes with either quote style', () => {
    const element = root(`<response code='404'><a href="one" b='two'/></response>`);
    expect(element.attrs).toEqual({ code: '404' });
    expect(firstChild(element, 'a')!.attrs).toEqual({ href: 'one', b: 'two' });
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(root('<response code = "404"/>').attrs).toEqual({ code: '404' });
  });

  it('preserves text split across an entity reference and a newline', () => {
    // Trims the ends and nothing else. Collapsing internal whitespace would be a different
    // function with a different risk: a WebDAV href or a path can legitimately contain a
    // space, and rewriting one to find it "prettier" would point the index at a path that
    // does not exist. The trim exists so `<d:displayname>\n  Sgt. Pepper\n</d:displayname>`
    // does not render with its own indentation.
    expect(childText(root('<response><a>one &amp;\n two</a></response>'), 'a')).toBe('one &\n two');
    expect(childText(root('<response><a>  padded  </a></response>'), 'a')).toBe('padded');
  });

  it('reports an empty element and a value-bearing one the same way', () => {
    // A property may be written as `<d:getcontentlength>0</d:getcontentlength>` or as an
    // empty element; both mean "present". The reader must not distinguish them.
    expect(childText(root('<response><a>0</a></response>'), 'a')).toBe('0');
    expect(childText(root('<response><a/></response>'), 'a')).toBe('');
  });

  it('matches on local names, so a server choosing D: or d: cannot change the result', () => {
    const element = root('<response><DAV:href>/x</DAV:href><d:href>/y</d:href></response>');
    expect(element.children.map((child) => localName(child.name))).toEqual(['href', 'href']);
  });
});

describe('parseXml — namespaces', () => {
  it('accepts and ignores a namespace declaration, and does not record it as an attribute', () => {
    // Half-parsing this is the failure: the `=` would be read as the start of the next
    // attribute, and a real attribute after the declaration would never be seen.
    const element = root('<response xmlns="DAV:" xmlns:d="DAV:" code="200"><a/></response>');
    expect(element.attrs).toEqual({ code: '200' });
    expect(Object.keys(element.attrs).some((key) => key.startsWith('xmlns'))).toBe(false);
  });

  it('still reads the attributes that follow a declaration', () => {
    expect(root('<response xmlns:d="DAV:" code="200" href="/x"/>').attrs).toEqual({ code: '200', href: '/x' });
  });

  it('reports a declaration with no value as its own failure, not as a generic attribute error', () => {
    expect(() => parseXml(wrap('<response xmlns:d/>'))).toThrow('Malformed namespace declaration.');
  });
});

describe('parseXml — CDATA', () => {
  it('contributes CDATA text verbatim, without decoding entities', () => {
    expect(childText(root('<response><a><![CDATA[a &amp; <b> c]]></a></response>'), 'a')).toBe('a &amp; <b> c');
  });

  it('skips a comment without contributing text', () => {
    expect(childText(root('<response><!-- <a>ignored</a> --><a>real</a></response>'), 'a')).toBe('real');
  });
});

describe('parseXml — refusals', () => {
  /**
   * Each of these is a hard error, never a partial result: a half-parsed `207` would put
   * wrong paths into the index, and index rows become stream targets.
   */
  const refusals: ReadonlyArray<readonly [string, string, string]> = [
    ['a DOCTYPE, which is the entry point for every entity attack', '<!DOCTYPE x><response/>', 'DOCTYPE declarations are not accepted.'],
    ['an unterminated comment', '<response><!-- oops</response>', 'Unterminated comment.'],
    ['an unterminated CDATA section', '<response><![CDATA[oops</response>', 'Unterminated CDATA section.'],
    ['an unterminated processing instruction', '<response><?oops</response>', 'Unterminated processing instruction.'],
    ['an unquoted attribute value', '<response code=200/>', 'Unquoted attribute value.'],
    ['an unterminated attribute value', '<response code="200/>', 'Unterminated attribute value.'],
    ['a tag with no name', '<><response/></>', 'Malformed tag name.'],
    ['an attribute with no name', '<response =x/>', 'Malformed attribute name.'],
    ['an attribute with no equals sign', '<response code/>', 'Malformed attribute.'],
    ['a closing tag carrying an attribute', '<response></response code="1">', 'Unexpected content in a closing tag.'],
    ['a closing tag that closes nothing', '<response></nope></response>', 'Mismatched closing tag </nope>.'],
    ['a closing tag in the wrong order', '<response><a><b></a></response>', 'Mismatched closing tag </a>.'],
  ];

  for (const [what, source, message] of refusals) {
    it(`refuses ${what}`, () => {
      expect(() => parseXml(wrap(source))).toThrow(message);
    });
  }

  it('reports a document that simply stops with elements open', () => {
    // Not reachable through `wrap`, which always closes its own root — the mismatch check
    // fires on the wrapper's closing tag before the end-of-input check can. So this one is
    // asserted on a bare document, which is the only shape that reaches it.
    expect(() => parseXml('<?xml version="1.0"?><response><a>text')).toThrow('Unclosed element.');
  });

  it('throws XmlParseError, so a caller can distinguish a refusal from a defect', () => {
    // The distinction matters: `client.ts` treats a refusal as "this origin answered
    // something I will not read", which is a different operator message from a bug.
    expect(() => parseXml(wrap('<nope>'))).toThrow(XmlParseError);
  });

  it('refuses a document past the size cap before reading it', () => {
    const oversized = 'x'.repeat(MAX_XML_BYTES + 1);
    expect(() => parseXml(oversized)).toThrow(`XML document exceeds ${MAX_XML_BYTES} bytes.`);
  });

  it('refuses nesting past the depth cap, and accepts the deepest nesting it allows', () => {
    // The cap is checked before a push, and the stack already holds three frames from the
    // wrapper (`#document`, `d:multistatus`, `response`), so the body gets `MAX_DEPTH - 3`.
    // Asserting both sides of that boundary is what makes the cap a limit rather than a
    // threshold that happens to reject the one input in the test.
    const atCap = (levels: number): string => {
      const body = `${'<a>'.repeat(levels)}${'</a>'.repeat(levels)}`;
      return `<response>${body}</response>`;
    };

    expect(() => parseXml(wrap(atCap(MAX_DEPTH - 3)))).not.toThrow();
    expect(() => parseXml(wrap(atCap(MAX_DEPTH - 2)))).toThrow(`XML nesting deeper than ${MAX_DEPTH}.`);
  });
});

describe('decodeEntities', () => {
  it('expands the five predefined names and numeric references', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an unknown reference verbatim rather than dropping it', () => {
    // A filename containing `&foo;` is a real thing; silently deleting it would point the
    // index at a different file than the one on disk.
    expect(decodeEntities('a&foo;b')).toBe('a&foo;b');
    expect(decodeEntities('100% & 50%')).toBe('100% & 50%');
  });

  it('leaves an out-of-range character reference verbatim', () => {
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
  });

  it('is case-insensitive on the predefined names', () => {
    expect(decodeEntities('&AMP;&Amp;')).toBe('&&');
  });
});

describe('findDescendants', () => {
  it('collects matching descendants at every depth, not just direct children', () => {
    const element = root('<response><a><b><href>/deep</href></b></a><href>/shallow</href></response>');
    expect(findDescendants(element, 'href').map((found) => found.text)).toEqual(['/deep', '/shallow']);
  });

  it('matches on local names', () => {
    expect(findDescendants(root('<response><d:href>/x</d:href></response>'), 'href')).toHaveLength(1);
  });
});
