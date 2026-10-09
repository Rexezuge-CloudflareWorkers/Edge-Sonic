/**
 * The OpenSubsonic extension layer.
 *
 * ### Why this is a module and not more of `builders.ts`
 *
 * Because "what the core protocol requires" and "what an OpenSubsonic-aware client reads"
 * are two questions with two different answers, and putting them in one file made the
 * difference invisible: every extension field sat in the same literal as the fields the XSD
 * declares, so a reviewer reading `songElement` had no way to tell which attributes a client
 * can rely on in a legacy Subsonic build and which arrive only when a client checks
 * `openSubsonic` first.
 *
 * The split is also load-bearing in the other direction. `builders.ts` is the one place a
 * Subsonic **field name** is spelled, and it is the file a reader opens to answer "what does
 * this server publish?". A question about `displayArtist` is a different question from one
 * about `duration`, and they now have different files.
 *
 * ### Why only these fields
 *
 * OpenSubsonic declares around thirty optional additions to `Child`. The spec's rule is that a
 * server supporting one must return it *with an empty default* so a client can detect support —
 * which makes every omission a capability claim in the negative, and makes advertising a field
 * this server cannot fill worse than not advertising it at all.
 *
 * So the set is drawn from two constraints rather than from the specification's table:
 *
 * 1. **A client branches on it when rendering.** `artists[]` and `albumArtists[]` are the
 *    multi-artist credit line, `displayArtist`/`displayAlbumArtist` its single-value form,
 *    `genres[]` the genre chip, `sortName` the ordering key, and `samplingRate`/`channelCount`
 *    the line under a track that says what it is made of. The rest — `works`, `movements`,
 *    `contributors`, `replayGain`, `moods`, `groupings`, `displayComposer`, `bpm`, `isrc`,
 *    `comment`, `musicBrainzId`, `explicitStatus` — are read by no common client, and a server
 *    that emits them from nowhere emits a default, which is a claim it cannot back.
 * 2. **The value already exists.** Every field below reads a column `songs` carries, so this
 *    costs no WebDAV request, no scan work, no migration and no new index. That is the whole
 *    reason for stopping where this stops.
 *
 * `bitDepth` is the instructive exclusion: `media-tags` extracts it for FLAC, and there is no
 * column for it. Emitting `bitDepth: 0` would satisfy the spec's "empty default" rule and
 * assert a support this server does not have — and `0` is a claim about the audio rather than
 * an absence of it. Storing it is a schema change and its own commit.
 *
 * ### What is deliberately still missing
 *
 * `path`. The protocol allows it on `Child` and Navidrome publishes it, but it publishes the
 * **storage layout of someone's WebDAV bucket** to every authenticated client, and nothing in
 * the protocol needs it back — the ids already carry the path for the server's own use. This is
 * a deliberate divergence from the reference server and the only one on this surface.
 */
import { el, elArray } from './nodes';
import type { ElementNode } from './nodes';
import type { Song } from './types';

/**
 * Leading articles: dropped from a sort name, and reported to clients as `ignoredArticles`.
 *
 * One constant for both, because they must agree. A client that strips `The` from a display
 * name and files the track under G expects the same article list in `sortName` that
 * `getIndexes` advertises; two spellings would mean the two surfaces disagree about the same
 * string, and a client's ordering would differ between the index and the track list.
 *
 * The list is Navidrome's, which is longer than the protocol's own example. The example is an
 * example, and this is the list clients are written against.
 */
const IGNORED_ARTICLES = 'The El La Los Las Le Les Os As O A';

/**
 * The same list, one word at a time, lowercased — the form the comparison below wants.
 *
 * Derived from the published string rather than typed out twice, because the two spellings
 * drifting is the exact failure `IGNORED_ARTICLES`' note describes.
 */
const IGNORED_ARTICLE_WORDS = IGNORED_ARTICLES.toLowerCase().split(' ');

/**
 * The sort name: the title lowercased, with a leading article dropped.
 *
 * What a tag's own `TITLESORT` holds when the file carries one, and what a client's own
 * ordering does when it does not.
 *
 * **Derived rather than only passed through**, so it is never absent. It needs no tag, only a
 * title, and every track has one — so a caller that never reads a tag still gets an ordering
 * key, and a caller that reads the tag's own `TITLESORT` still wins by supplying it.
 *
 * An article is dropped only when it is a whole word and something follows it, so `The` in
 * `The Bird` goes and the `The` in `Theme` stays. Case-insensitive, because the display name is
 * whatever the tag said and may be `THE great escape`.
 */
function sortNameOf(title: string): string {
  const lowered = title.trim().toLowerCase();
  for (const article of IGNORED_ARTICLE_WORDS) {
    if (lowered.length > article.length && lowered.startsWith(`${article} `)) return lowered.slice(article.length + 1);
  }
  return lowered;
}

/**
 * The extension fields a track carries that are **attributes**.
 *
 * Every one is `undefined` rather than a default when the underlying value is unknown, so a
 * client can tell "this server has not read the file" from "read, and the answer is none". That
 * is a distinction `duration` cannot afford — a client treats a missing `duration` as a
 * malformed record and hides the track — which is why `samplingRate` and `channelCount` are
 * both `number | undefined` and `duration` is `number`.
 */
function songExtensionAttrs(song: Song): Record<string, string | number | undefined> {
  return {
    // The single-value forms of the two credit lists. A client rendering one line reads these;
    // one rendering per-artist chips reads the arrays `songExtensionChildren` builds.
    displayArtist: song.artist,
    displayAlbumArtist: song.albumArtist,
    samplingRate: song.samplingRate,
    channelCount: song.channelCount,
    sortName: song.sortName ?? sortNameOf(song.title),
  };
}

/**
 * The extension fields a track carries that are **child elements**.
 *
 * `artists[]`, `albumArtists[]` and `genres[]` are arrays of records, and an attribute is a
 * scalar in every serializer — `artists="Silent Siren"` is a string where the client expects a
 * list of `{id, name}`, and a wrong shape fails to decode exactly as an absent key does.
 *
 * `elArray` rather than `elList`, and the difference is the whole point: the wrapper and the
 * child here are the same word in two grammatical forms, and the array belongs at the
 * **wrapper's** key. `albumList2.album` is the other shape, where the value belongs under the
 * child's key.
 *
 * Emitted only when there is something to name. An empty `artists[]` on a track whose tags were
 * never read claims the server supports the field *and* knows the answer is none; an absent key
 * claims nothing, which is the honest state.
 *
 * `albumArtists[]` reuses `artistId` for its element id, which is right when the album artist
 * is the track artist and wrong otherwise. It is the only id available without resolving a
 * second name to an id, and `displayAlbumArtist` beside it carries the name a client displays —
 * so a client that renders the array gets an id it can drill and a client that renders the
 * line gets the right text.
 */
function songExtensionChildren(song: Song): ElementNode[] {
  const children: ElementNode[] = [];
  if (song.artist !== undefined) children.push(elArray('artists', 'artist', {}, [el('artist', { id: song.artistId, name: song.artist })]));
  if (song.albumArtist !== undefined)
    children.push(elArray('albumArtists', 'artist', {}, [el('artist', { id: song.artistId, name: song.albumArtist })]));
  if (song.genre !== undefined) children.push(elArray('genres', 'genre', {}, [el('genre', { name: song.genre })]));
  return children;
}

export { IGNORED_ARTICLES, sortNameOf, songExtensionAttrs, songExtensionChildren };
