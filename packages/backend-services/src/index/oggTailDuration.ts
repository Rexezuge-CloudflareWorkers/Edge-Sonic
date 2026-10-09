/**
 * The one duration a prefix read cannot supply.
 *
 * ### Why this is its own module
 *
 * Because the second read is a **separate question** from the first, and it has three
 * answers rather than two. The prefix read either found a duration or it did not; this
 * read either found one, did not, or failed in a way that says nothing about the file —
 * and the third must not be written at all, because writing it stamps the row and strands
 * the duration at `0` with the same permanence as a refused prefix read.
 *
 * Inlining it in `EnrichmentService` put that distinction three `if`s deep in a `try`,
 * where a reader comparing it with the prefix-read failure path had to hold both in mind
 * to see that they answer opposite questions.
 *
 * ### Which containers record their length at the end
 *
 * Ogg, and only Ogg. Its granule position is in the **final page's** header, so a prefix
 * read structurally cannot see it. MP4 puts `moov` at the end and needs a different parse
 * entirely, so this does not pretend to cover it — a file this returns `null` for is a file
 * with no duration available, not one that failed.
 */
import { readOggTailDuration } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { WebDavClient } from '@edge-sonic/webdav';
import { isTransientEnrichmentFailure } from './enrichmentRetry';

/**
 * The three answers, as a result object rather than a union with a sentinel.
 *
 * `duration: null, transient: false` and `duration: null, transient: true` are different
 * observations and they must not merge: the first is "we looked and the tail did not contain
 * the end of the file", and the second is "we were not allowed to look". Only the second is
 * worth repeating, and only the first is worth writing.
 */
interface TailDuration {
  readonly duration: number | null;
  /**
   * `true` means **do not write anything**: not the duration, and not the good prefix tags
   * this read came to complete. They belong to the same attempt, and writing them while the
   * duration stays `0` strands the row permanently.
   */
  readonly transient: boolean;
}

/**
 * What this module answers when there is no tail read to do.
 *
 * One named value, because there are three places that produce it and each of them was
 * written out separately — and because `transient: false` is the load-bearing half in all
 * three. A default that guessed `transient: true` here would silently stop every row from
 * being written.
 */
const NO_TAIL_DURATION: TailDuration = { duration: null, transient: false };

/**
 * Only Ogg records its length this way. Named rather than tested inline, because the
 * container strings come from the reader and a typo in one of them reads as "not Ogg" —
 * which is indistinguishable from a container this does not support.
 */
function recordsLengthAtTheEnd(container: string): boolean {
  return container === 'ogg-opus' || container === 'ogg-vorbis';
}

/**
 * The duration of a container whose length is recorded at the **end** of the file.
 *
 * ### Why `null` is a real answer
 *
 * A tail that does not contain the final page's header leaves the duration unknown, and
 * the row is written as `0`. That is the honest value — the alternative is a confident
 * wrong one, and a client seeks by it. A 240.61 s track was served as 3 s at 15329 kbps
 * instead of 191, because the prefix read's truncated page was taken for the file's last.
 *
 * ### And `transient` is the third answer
 *
 * It means the read failed in a way that says nothing about the file, so even the good
 * prefix tags stay out of D1. It shipped the other way round, twice: every failure was
 * recorded as an attempt, so four tracks of a live library caught a flapping origin and
 * reported duration `0` for ever.
 */
async function resolveTailDuration(
  client: WebDavClient,
  facts: { readonly path: string; readonly size: number },
  tags: AudioTags,
  readTailBytes: number | undefined,
  timeoutMs: number,
): Promise<TailDuration> {
  const tailBytes = readTailBytes ?? 0;
  // Three of the four returns below are this one value: no tail configured, nothing to
  // sample against, or a size of 0 to anchor the range. None is a failure, and none is
  // worth a stamp.
  if (tailBytes <= 0 || tags.sampleRate === null || facts.size === 0) return NO_TAIL_DURATION;
  if (!recordsLengthAtTheEnd(tags.container)) return NO_TAIL_DURATION;

  try {
    const bytes = await client.readTail(facts.path, tailBytes, facts.size, timeoutMs);
    // The granule includes the pre-skip and the duration must not, and the pre-skip is in
    // the identification header at the *front* of the file — which the prefix read already
    // read, and which is why it is carried on `AudioTags` rather than re-read here.
    return { duration: readOggTailDuration(bytes, tags.sampleRate, tags.preskip ?? 0), transient: false };
  } catch (error) {
    // The same classification the prefix read uses, and for the same reason: `413` here is
    // this server's own body bound or an origin that answered the range with the whole
    // file, and neither says the file is unreadable.
    return { duration: null, transient: isTransientEnrichmentFailure(error) };
  }
}

export { resolveTailDuration, recordsLengthAtTheEnd, NO_TAIL_DURATION };
export type { TailDuration };
