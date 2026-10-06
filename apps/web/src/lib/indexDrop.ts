/**
 * The decisions the Danger Zone makes, apart from the markup.
 *
 * Every function here is pure and every label is a **parameter**, because `apps/web` ships
 * zero `@edge-sonic/*` runtime dependencies and a `t()` call in this module would put
 * `i18next` in a file the root suite imports directly. `lib/probe.ts` and `lib/scanStatus.ts`
 * set the pattern; this follows it.
 *
 * The reason these are extracted rather than computed inline in the component is the one
 * `apps/web/AGENTS.md` states for every decision in `lib/`: a decision inside a component is a
 * decision with no test, and the Danger Zone's is the decision an operator is asked to consent
 * to.
 */

/**
 * The phrase the global drop requires.
 *
 * A **literal**, not a library name, and that is the whole content of the choice. The
 * per-library drop can name the thing it destroys because the thing has a name — its slug,
 * unique per `idx_libraries_slug_ci`, so the phrase cannot be satisfied by another library's.
 * The global drop has nothing to name: `libraries`, `songs`, `nodes` and `scan_state` are
 * tables, and the operator is not typing a table name to confirm a decision.
 *
 * So they type the *scope*. `drop-all-index` says the thing that is true of this action and
 * false of every other one on the page — it will empty every library's index — and it is short
 * enough to type without the modal becoming a typing exercise, which is what makes it a gate
 * rather than a penalty.
 */
const DROP_ALL_PHRASE = 'drop-all-index';

/**
 * The phrase for dropping one library's index: its slug.
 *
 * The slug rather than the display name because the slug is unique and the display name is
 * operator-chosen text that two libraries can share — a phrase two libraries both satisfy is
 * not a confirmation of anything. An operator who gave two libraries the same display name
 * would be confirming the wrong one.
 */
function confirmPhraseForLibrary(slug: string): string {
  return slug;
}

/**
 * The phrase for the global drop.
 *
 * A function rather than an exported constant so the confirmation's decision has one place
 * that answers it, and a test that can assert the constant and the rendered dialog agree
 * without either reading the other's file. Exported for that test and for the dialog's
 * `expectedName`; nothing else should reach for it.
 */
function confirmPhraseForAll(): string {
  return DROP_ALL_PHRASE;
}

/**
 * What dropping one library's index destroys, as one sentence.
 *
 * Names what is removed **and what is kept**, because the second half is the part an operator
 * cannot infer and would otherwise have to decide by asking: their stars, play counts and
 * playlists survive, because a rescan recreates the same song ids. Leaving it out would make
 * the dialog sound like it deletes everything, which is both untrue and more frightening than
 * the action is — and a dialog that overstates its own cost trains operators to confirm
 * without reading, which defeats the two gates above it.
 *
 * The library's registration and credential surviving is stated for the same reason: it is
 * the difference between this and `deleteLibrary`, and the operator may reasonably be
 * carrying a wrong-password remedy in their head from an older version of this product.
 */
function describeLibraryDrop(t: Translate, slug: string): string {
  return t(
    'danger.libraryDropDescription',
    'Deletes the scanned index for {{slug}}: every indexed track and every folder. The library and its saved WebDAV password stay registered, and stars, play counts and playlists are kept — a rescan restores them, because track ids are derived from the file path. Press Rescan on the library afterwards to index it again from scratch.',
    { slug },
  );
}

/**
 * The global drop's sentence.
 *
 * Says **every** library in words rather than "all libraries", because the confirm phrase is
 * a literal and the sentence is the only place the scope is explained in prose. An operator
 * with two libraries should not have to infer from the phrase what is about to happen to the
 * other one.
 */
function describeAllDrop(t: Translate, libraryCount: number): string {
  const scope =
    libraryCount === 1
      ? t('danger.allDropOneLibrary', 'the one registered library')
      : t('danger.allDropManyLibraries', 'all {{count}} registered libraries', { count: libraryCount });
  return t(
    'danger.allDropDescription',
    'Deletes the scanned index for {{scope}}: every indexed track and every folder. No library registration, WebDAV password, star, play count or playlist is removed. Press Rescan afterwards to index from scratch.',
    { scope },
  );
}

/**
 * The cost block the confirmation renders, as the sentences an operator reads.
 *
 * The billed-rows figure is named as a *share of a daily allowance* rather than as a raw
 * number, and the number itself is not translated — it is formatted by `formatRows`. A raw
 * integer labelled "rows" is the abstraction an operator cannot act on; the thing they need to
 * know is that this spends a large fraction of a budget that resets at midnight UTC, and that
 * going past it takes the whole deployment's reads down with it.
 *
 * The consequence sentence is unconditional. It reads as alarmist on a library of nine tracks
 * and it is still true — the allowance is per account and other libraries share it — so
 * gating it on a threshold would be a second place for that threshold to be wrong.
 */
function describeDropCost(t: Translate, stats: { songs: number; nodes: number; billedRows: number }): string {
  /**
   * `rows`, not `billedRows`, as the interpolation name.
   *
   * The field is `billedRows` everywhere else and the sentence calls it `rows`. That is a
   * deliberate mismatch in spelling and it was a real bug: passing `{ billedRows }` into a
   * template reading `{{rows}}` leaves the placeholder unresolved, so i18next renders the
   * sentence **without a figure at all** — a confirmation dialog that quotes a cost and prints
   * no number. `test/web-danger-zone.test.tsx` asserts the rendered sentence carries the figure,
   * and asserting the sentence alone would have passed.
   */
  return t('danger.dropCost', '{{songs}} tracks and {{nodes}} folders, billing about {{rows}} rows against the daily write allowance.', {
    songs: stats.songs,
    nodes: stats.nodes,
    rows: stats.billedRows,
  });
}

/**
 * What happens to the deployment if the drop exceeds the day's allowance.
 *
 * Stated as a fact rather than a warning, because it is one: past the limit D1 refuses
 * **every** query — reads included — until midnight UTC, so this does not slow the scan down,
 * it takes the product offline. An operator weighing whether to drop a large index now or
 * after the reset needs that sentence, and a dialog that only said "this is expensive" does
 * not tell them the difference between an expensive action and an outage.
 */
function describeDropOutageRisk(t: Translate): string {
  return t(
    'danger.dropOutageRisk',
    'A drop this large can exceed the daily row-write allowance. Past that limit the database refuses every query until midnight UTC, including reads — so streaming stops too, not just scanning.',
  );
}

/**
 * The notice after a drop, naming what was removed and what it cost.
 *
 * The **measured** `billedRows` rather than the projection from the dialog, because they
 * differ whenever the index moved while the dialog was open and the measured one is what was
 * actually spent. Reporting the projection after the fact would be reporting a number about
 * something that is no longer happening.
 */
function describeDropped(t: Translate, songs: number, libraries: number, billedRows: number): string {
  // The same `{{rows}}` spelling as `describeDropCost`, for the same reason: the field is
  // `billedRows` and the sentence says `rows`, and a mismatch leaves the figure out of a
  // sentence whose whole job is to report one.
  const scope =
    libraries === 1 ? t('danger.droppedOne', '1 library') : t('danger.droppedMany', '{{count}} libraries', { count: libraries });
  return t('danger.dropped', 'Index dropped for {{scope}} — {{songs}} tracks removed, about {{rows}} rows billed.', {
    scope,
    songs,
    rows: billedRows,
  });
}

/**
 * `t` with interpolation, as a type rather than an import.
 *
 * Declared structurally because the module must be importable from the root suite without
 * pulling in `i18next`. `react-i18next`'s `TFunction` is not referenced here on purpose: that
 * would make this file's types depend on a package the browser bundle does not ship, which is
 * the coupling `lib/probe.ts` exists to avoid.
 */
interface Translate {
  (key: string, fallback: string, vars?: Record<string, string | number>): string;
}

export {
  DROP_ALL_PHRASE,
  confirmPhraseForLibrary,
  confirmPhraseForAll,
  describeLibraryDrop,
  describeAllDrop,
  describeDropCost,
  describeDropOutageRisk,
  describeDropped,
};
export type { Translate };
