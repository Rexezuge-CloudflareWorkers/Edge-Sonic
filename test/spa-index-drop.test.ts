/**
 * `lib/indexDrop.ts` — the Danger Zone's decisions, from the root suite.
 *
 * `apps/web` is excluded from the coverage gate **visibly**, so a decision placed in a
 * component is one nothing measures until a jsdom harness is written for it. This file is the
 * cheaper half: every function here is pure, takes its labels as parameters, and is reachable
 * without a DOM — which is the arrangement `lib/probe.ts` and `lib/scanStatus.ts` exist to
 * demonstrate.
 *
 * ### The case that mattered
 *
 * `describeDropCost` and `describeDropped` interpolate `{{rows}}` while the field they are
 * handed is `billedRows`. That mismatch does not throw and does not warn: i18next renders the
 * template with the placeholder **missing**, so the confirmation dialog quoted a cost and
 * printed no figure, and the notice reported what was spent and printed nothing.
 *
 * Every other assertion here would have passed. The two that would not are the ones below that
 * assert the rendered string **carries the number** — a test on the key, or on the sentence
 * with the figure excluded, passes on a broken one.
 */
import { describe, expect, it } from 'vitest';
import {
  DROP_ALL_PHRASE,
  confirmPhraseForAll,
  confirmPhraseForLibrary,
  describeAllDrop,
  describeDropCost,
  describeDropOutageRisk,
  describeDropped,
  describeLibraryDrop,
} from '../apps/web/src/lib/indexDrop';

/**
 * `t`, as i18next actually behaves.
 *
 * Deliberately faithful rather than a stub that returns its second argument: the bug this file
 * exists for lives in the gap between "the key exists" and "the placeholders resolved", and a
 * stub that ignored interpolation would reproduce that gap in the test harness.
 */
function t(key: string, fallback: string, vars?: Record<string, string | number>): string {
  return fallback.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) => (vars && name in vars ? String(vars[name]) : match));
}

describe('the confirm phrases', () => {
  it('names a library by its slug', () => {
    // The slug because it is unique (`idx_libraries_slug_ci`) and the display name is
    // operator-chosen text two libraries can both carry. A phrase two libraries satisfy is not a
    // confirmation of anything.
    expect(confirmPhraseForLibrary('home')).toBe('home');
    expect(confirmPhraseForLibrary('work')).toBe('work');
  });

  it('gives two libraries sharing a display name two different phrases', () => {
    expect(confirmPhraseForLibrary('home')).not.toBe(confirmPhraseForLibrary('work'));
  });

  it('uses a literal for the global drop, because nothing in the request can be named', () => {
    // `libraries`, `songs`, `nodes` and `scan_state` are tables, and the operator is not typing
    // a table name to confirm a decision. So they type the **scope** — a short phrase that is
    // true of this action and false of every other on the page.
    expect(confirmPhraseForAll()).toBe(DROP_ALL_PHRASE);
    expect(DROP_ALL_PHRASE).toBe('drop-all-index');
  });

  it('is not satisfied by any library slug', () => {
    // Nothing in a global drop names a library, so a library's name must not confirm it.
    for (const slug of ['home', 'work', 'music', 'library']) {
      expect(slug).not.toBe(confirmPhraseForAll());
    }
  });
});

describe('the descriptions name what survives, not only what goes', () => {
  it('says the registration and the password stay', () => {
    // The difference from `DELETE /user/libraries/:id`, which cascades `libraries` and the
    // encrypted credential with it. An operator may be carrying a wrong-password remedy in their
    // head from an older version of this product.
    const text = describeLibraryDrop(t, 'home');
    expect(text).toContain('stay registered');
    expect(text).toContain('WebDAV password');
  });

  it('says the annotations are kept, and why they come back', () => {
    // Stars, play counts and playlists have **no foreign key** to `songs`. They survive only
    // because a song id is derived from `(libraryId, path)`, so a rescan recreates it
    // byte-identically. A dialog that overstates its own cost trains operators to confirm
    // without reading, which defeats both gates above it.
    const text = describeLibraryDrop(t, 'home');
    expect(text).toContain('stars, play counts and playlists are kept');
    expect(text).toContain('rescan restores them');
  });

  it('says what to do next, because a drop leaves nothing to poll', () => {
    // The library reads as "never scanned" afterwards, so the next action is an explicit Rescan.
    expect(describeLibraryDrop(t, 'home')).toMatch(/Rescan/);
  });

  it('names the library in its own description', () => {
    expect(describeLibraryDrop(t, 'home')).toContain('home');
  });

  it('says “every” in words for the global drop, not just in the phrase', () => {
    // The phrase is a literal, so the sentence is the only place the scope is explained in prose.
    expect(describeAllDrop(t, 3)).toContain('all 3 registered libraries');
  });

  it('has a singular form, because “1 libraries” reads as a template nobody checked', () => {
    expect(describeAllDrop(t, 1)).toContain('the one registered library');
    expect(describeAllDrop(t, 1)).not.toContain('1 registered libraries');
  });

  it('keeps the global description honest about what it does not remove', () => {
    const text = describeAllDrop(t, 4);
    expect(text).toContain('No library registration, WebDAV password, star, play count or playlist is removed');
  });
});

describe('the cost sentence carries the number', () => {
  it('renders the figure the server sent', () => {
    // `40 * 10 + 12 * 4 = 448` — the arithmetic is `billedRowsForTable` over the real index
    // counts, asserted against `sqlite_schema` in `test/schema.int.test.ts`.
    expect(describeDropCost(t, { songs: 40, nodes: 12, billedRows: 448 })).toBe(
      '40 tracks and 12 folders, billing about 448 rows against the daily write allowance.',
    );
  });

  it('does not leave the placeholder unresolved', () => {
    /**
     * The regression, asserted on the **rendered** string.
     *
     * The bug was `{ songs, nodes, billedRows }` into a `{{rows}}` template, which renders as a
     * sentence with a missing figure rather than an error — a dialog that quotes a cost and
     * prints no number, which is worse than no dialog because it looks like it worked.
     *
     * `not.toContain('{{')` is the assertion that catches it; a test checking the key or
     * checking the sentence without its figure would pass on the broken version.
     */
    const text = describeDropCost(t, { songs: 1, nodes: 1, billedRows: 16 });
    expect(text).not.toContain('{{');
    expect(text).toContain('16 rows');
  });

  it('says a zero-cost drop is zero, rather than omitting the figure', () => {
    // A library that was never indexed is what most of a new deployment's libraries are. The
    // sentence must still carry a number, so the dialog is never "a cost" with no cost in it.
    const text = describeDropCost(t, { songs: 0, nodes: 0, billedRows: 0 });
    expect(text).not.toContain('{{');
    expect(text).toContain('0 rows');
  });
});

describe('the outage sentence is unconditional', () => {
  it('names midnight UTC and says reads are refused too', () => {
    /**
     * The one sentence that tells an operator the difference between an expensive action and an
     * outage: past the daily row-write allowance D1 refuses **every** query — streaming included
     * — so this does not slow the scan down, it takes the product offline.
     *
     * Asserted on "reads" and "midnight UTC" rather than on the whole string, so a rewording
     * that loses either of those two facts fails.
     */
    const text = describeDropOutageRisk(t);
    expect(text).toContain('midnight UTC');
    expect(text).toContain('including reads');
    expect(text).toContain('streaming');
  });
});

describe('the notice after a drop', () => {
  it('carries the measured figure and the number of libraries', () => {
    const text = describeDropped(t, 40, 3, 448);
    expect(text).not.toContain('{{');
    expect(text).toContain('3 libraries');
    expect(text).toContain('40 tracks');
    expect(text).toContain('448 rows');
  });

  it('says “1 library” rather than “1 libraries”', () => {
    expect(describeDropped(t, 1, 1, 10)).toContain('1 library');
    expect(describeDropped(t, 1, 1, 10)).not.toContain('1 libraries');
  });
});
