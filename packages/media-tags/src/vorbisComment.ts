/**
 * The `VORBIS_COMMENT` / `OpusTags` comment list, over a {@link ByteSource}.
 *
 * ### Why this is a source and not a buffer
 *
 * The list is length-prefixed, so reading field *n+1* means stepping over field *n* — and on a real
 * file the field you step over is usually the artwork: `METADATA_BLOCK_PICTURE` on a 9 MB Opus
 * track is 1,158,176 bytes of base64, sitting *inside* the comment list, usually before the tags
 * anyone wants. A bounded prefix read therefore stops inside it.
 *
 * So the reader is given a {@link ByteSource} rather than a `Uint8Array`: a contiguous buffer
 * is one, and an Ogg `LogicalPacket` is another whose bytes are split by every page header the
 * packet continues across. Reading both through one walk is the point — **two copies of the
 * framing are free to disagree about where a comment ends, and that disagreement is invisible
 * until a picture silently decodes to the wrong bytes.**
 *
 * ### A field that runs past what is there ends the walk, and that is the whole design
 *
 * The list is sequential, so there is no way to reach field *n+1* without stepping over field *n*.
 * Treating "the buffer stopped here" as a parse failure reports **no tags at all** for a file
 * whose `TITLE`, `ARTIST` and `ALBUM` are all in the first four hundred bytes — which is what
 * this server reported for every Opus track it had. So the walk stops, keeping everything it
 * read, and hands the oversized field back as a *range*. "Where is it" and "what does it say"
 * are therefore separate questions, and the artwork is the case where only the first is asked.
 */
import { normalizeCommentKey, readUintLE } from './bits';
/**
 * Somewhere a length-prefixed structure can be read from.
 */
interface ByteSource {
  /**
   * Bytes available from offset 0. Named for what it is rather than for the whole structure,
   * because on a bounded read the two differ: a `LogicalPacket` reports how much of the packet it
   * can reach, which is what decides whether the walk can continue.
   */
  readonly available: number;
  /**
   @param maxBytes Refuse a copy larger than this, so a length field read from a file
    cannot ask for a gigabyte.
   @returns The bytes, or `null` when they are not all available or are over the bound.
     Never a short read.
   */
  read(offset: number, length: number, maxBytes?: number): Uint8Array | null;
}

/**
 * A `ByteSource` over one contiguous buffer.
 *
 * `maxBytes` is ignored: the buffer is already the bound, and there is nothing to protect
 * against by refusing to read from it.
 */
function contiguousSource(bytes: Uint8Array): ByteSource {
  return {
    available: bytes.length,
    read: (offset, length) => (offset < 0 || length < 0 || offset + length > bytes.length ? null : bytes.subarray(offset, offset + length)),
  };
}

/**
 *  The largest comment value this module will **decode as text**.
 *
 *  A field longer than this is not a tag. Real ones are tens of bytes; the one field that
 *  runs to hundreds of kilobytes is `METADATA_BLOCK_PICTURE`, and it is reported as an
 *  extent instead of decoded.
 *
 *  This bound is what lets the walk step *over* the picture instead of trying to hold it.
 *  Its absence is a second way the artwork went missing, and it is the one that survived
 *  the packet-size fix: the walk called `read` with no bound, so a value over the
 *  `LogicalPacket`'s materialization limit came back `null`, the walk ended, and a file
 *  read **in full** — 819,417 packet bytes available, every one of them present — still
 *  reported no picture.
 */
const MAX_COMMENT_VALUE_BYTES = 64 * 1024;

/**
 * How much of a field is read to recover its **key**.
 *
 * The key identifies the field and is a few dozen bytes at the front of it —
 * `METADATA_BLOCK_PICTURE` is 22 — so this is all that has to be read when the value is too
 * large to decode.
 *
 * It has to be a bound: the alternative is reading the field to find the `=`, and the field is
 * the thing that was too large. An unbounded read of an 819 KB value comes back `null` under the
 * packet's materialization limit, the empty result has no `=` in it, and the field is reported as
 * nothing at all — this bug, reappearing one level down.
 */
const MAX_COMMENT_KEY_BYTES = 256;

/**
 * One comment's **value**, as a byte range into its {@link ByteSource}.
 *
 * The value and not the field: the field carries the key and the `=`, and a caller told "your bytes
 * are here" hands all three to a decoder that wanted only the value.
 *
 * A range rather than a string, because the one comment whose value is not text is routinely
 * **larger than any buffer this server will hold**. Handing the caller its
 * extent is what lets it ask for exactly those bytes instead of giving up on the picture —
 * or reading a megabyte of base64 to throw most of it away.
 */

interface CommentValue {
  readonly offset: number;
  readonly length: number;
}

/**
 * Report a field whose bytes cannot be materialized, and end the walk.
 *
 * Two reasons land here and need identical handling: the bytes are not all present (a bounded
 * read stopped inside the field), or the value is too large to be text (the artwork). Either way
 * the **length prefix has already told us how long it is**, and the key is a few dozen bytes at
 * the front, so the field is still identifiable from what is present. That is the only reason a
 * cover 1.16 MB into a file is findable from a 128 KiB read.
 *
 * There is nothing after it to reach — the list is sequential — so the walk ends here with
 * everything it did read kept.
 *
 * The extent reported is the **value's**, never the field's: the field carries the key and the
 * `=`, and a caller told "here are your bytes" hands all three to a decoder that wanted only the
 * value. That is a base64 payload with `METADATA_BLOCK_PICTURE=` prepended to it, which decodes
 * to nothing at all.
 */
function reportExtentOnly(
  source: ByteSource,
  start: number,
  length: number,
  present: number,
  visit: (key: string, value: string | null, extent: CommentValue) => boolean | void,
): void {
  if (present <= 0) return;
  const key = new TextDecoder().decode(source.read(start, Math.min(present, MAX_COMMENT_KEY_BYTES)) ?? new Uint8Array(0));
  const equals = key.indexOf('=');
  if (equals <= 0) return;
  visit(normalizeCommentKey(key.slice(0, equals)), null, { offset: start + equals + 1, length: length - equals - 1 });
}

/**
 * Walk a `VORBIS_COMMENT` / `OpusTags` comment list.
 *
 * Length-prefixed strings, little-endian 32-bit. The `vendor_length` and
 * `comment_count` are read defensively: a bogus count would otherwise make this loop walk
 * off the end of the buffer, which the per-field bounds check catches, but it is cheaper
 * to bound the loop too.
 *
 * @param visit Receives the normalized key, the decoded value **or `null`** when the
 *   value was too large or too far away to materialize, and the value's range either
 *   way. A `null` value with a non-null range is not an error — it is the artwork case.
 */
function walkVorbisCommentSource(
  source: ByteSource,
  offset: number,
  visit: (key: string, value: string | null, extent: CommentValue) => boolean | void,
  maxValueBytes = MAX_COMMENT_VALUE_BYTES,
): void {
  const readLength = (at: number): number | null => {
    const bytes = source.read(at, 4);
    return bytes === null ? null : readUintLE(bytes, 0, 4);
  };

  const vendorLength = readLength(offset);
  if (vendorLength === null) return;
  let cursor = offset + 4 + vendorLength;

  const count = readLength(cursor);
  if (count === null) return;
  cursor += 4;

  // A real library has tens of comments per file; the cap is a bound on a
  // hostile header, not a policy limit.
  const limit = Math.min(count, 4096);

  for (let index = 0; index < limit; index += 1) {
    const length = readLength(cursor);
    if (length === null) break;
    const start = cursor + 4;

    // Two reasons a field is reported as an extent rather than decoded, and they need the
    // same handling: its bytes are not all here (a bounded read stopped inside it), or it
    // is too large to be text (the artwork). Either way the **length prefix has already
    // told us how long it is**, and the key is a few dozen bytes at the front, so the field
    // is still identifiable from what is present. That is the only reason a cover 1.16 MB
    // into a file is findable from a 128 KiB read.
    //
    // There is nothing after it to reach — the list is sequential — so the walk ends here
    // with everything it did read kept.
    const present = Math.max(0, Math.min(length, source.available - start));
    const decodable = present >= length && length <= maxValueBytes && length > 0;
    if (!decodable) {
      reportExtentOnly(source, start, length, present, visit);
      return;
    }

    const raw = source.read(start, length, maxValueBytes);
    if (raw === null) return;
    cursor = start + length;
    const comment = new TextDecoder().decode(raw);

    const equals = comment.indexOf('=');
    if (equals <= 0) continue;
    const value = comment.slice(equals + 1);
    if (value.length === 0) continue;
    if (visit(normalizeCommentKey(comment.slice(0, equals)), value, { offset: start + equals + 1, length: value.length }) === false) return;
  }
}

/**
 * Parse a `VORBIS_COMMENT` / `OpusTags` payload from anywhere readable.
 *
 * A field whose value is past the end of the source is skipped rather than fatal, so a
 * bounded read of a file whose picture precedes a later tag keeps the tags it can reach.
 *
 * Two normalizations, both measured against files the reference server reads
 * differently:
 *
 * - A whitespace-only value is absent. A `GENRE= ` tag is a junk genre the aggregates
 *   would otherwise publish with a song count beside it. Values that merely carry
 *   edge whitespace are kept byte-identical: the reference preserves them in place
 *   (`Holiday Holiday / Tragic Drops `, `... Kotoha & megu `), so trimming would
 *   trade agreement for tidiness.
 * - A repeated key resolves to its **last** parsable value. `Stella☆` carries
 *   `album artist=SILENT SIREN` ahead of `ALBUMARTIST=Silent Siren`, and first-wins
 *   publishes the stale all-caps spelling against the file's own `ARTIST`.
 */
/**
 * The extent of one comment's value, without decoding it.
 *
 * For the key whose value is not text. `METADATA_BLOCK_PICTURE` is how an Ogg file
 * carries artwork: the value is a base64-encoded FLAC `PICTURE` block, so it is artwork
 * in a comment list and this module has to reach the list to find it.
 *
 * @returns The value's byte range within `source`, or `null` when the comment is absent.
 *   Present with a value larger than any read is the normal answer here, not a failure.
 */
function findVorbisCommentExtent(source: ByteSource, offset: number, wanted: string): CommentValue | null {
  const target = normalizeCommentKey(wanted);
  // A box rather than a `let`: the assignment happens inside a callback, and a
  // narrowed-to-`null` local would be reported as unreachable at the return.
  const box: { extent: CommentValue | null } = { extent: null };
  walkVorbisCommentSource(source, offset, (key, _value, extent) => {
    if (key !== target) return;
    box.extent = extent;
    return false;
  });
  return box.extent;
}

/**
 * The first value for one comment key, or `null`.
 *
 * The decoded form of {@link findVorbisCommentExtent}, for a value that fits in a read.
 * A comment whose value is too large to decode comes back `null` here while
 * {@link findVorbisCommentExtent} still reports where it is — which is the artwork case,
 * and the reason the two are separate functions.
 */
function findVorbisComment(bytes: Uint8Array, offset: number, wanted: string): string | null {
  const target = normalizeCommentKey(wanted);
  const box: { value: string | null } = { value: null };
  walkVorbisCommentSource(contiguousSource(bytes), offset, (key, value) => {
    if (key !== target || value === null) return;
    box.value = value;
    return false;
  });
  return box.value;
}

export {
  findVorbisComment,
  findVorbisCommentExtent,
  walkVorbisCommentSource,
  contiguousSource,
  MAX_COMMENT_VALUE_BYTES,
  MAX_COMMENT_KEY_BYTES,
};
export type { ByteSource, CommentValue };
// Re-exported so the module's published surface is unchanged by the split.
export { parseVorbisCommentSource, parseVorbisComments } from './commentFields';
