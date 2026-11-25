/**
 * Lyric **text**: decoding it, and turning it into lines.
 *
 * ### Two questions, and why they are separate
 *
 * "What do the lyrics say" and "when does each line start" are different values. A
 * plain-text tag answers the first and says nothing about the second, while an LRC sidecar
 * answers both. The Subsonic surface has an endpoint for each: `getLyrics` carries a single
 * `value` string, and OpenSubsonic's `getLyricsBySongId` carries `structuredLyrics.line`
 * with millisecond offsets.
 *
 * So this module is the half that works on text from **any** source — a tag, an `.lrc`, a
 * `.txt` — and `lyrics.ts` is the half that reads a container. The split matters because
 * precedence between a sidecar and the tags is the service's decision, and a parser that
 * also knew about containers would have to be told which one it was looking at.
 *
 * ### Layer 0
 *
 * Pure functions: no fetch, no credential, no cache, no byte offsets outside the argument.
 */
/**
 * One line of a lyric, and the lines a parse produced.
 */
interface LyricsLine {
  /**
   * Milliseconds from the start of the track, or `null` for an unsynced line.
   */
  readonly startMs: number | null;
  readonly text: string;
}

interface ParsedLyrics {
  /**
   * True when at least one line carried an LRC timestamp.
   */
  readonly synced: boolean;
  readonly lines: readonly LyricsLine[];
}

/**
 * Decode lyric bytes to text.
 *
 * A file can carry lyrics in any of the encodings ID3 allows, and a sidecar can be written
 * by any editor. Byte-order marks are honoured first because they are unambiguous; without
 * one the bytes are tried as strict UTF-8, and Latin-1 is the fallback because it is the one
 * single-byte encoding that is never invalid — it decodes every byte string to *something*,
 * which is what makes it a better fallback than replacement characters for a lyric a user
 * still wants to read.
 */
function decodeLyricsText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return normalizeNewlines(new TextDecoder('utf-8').decode(bytes.subarray(3)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return normalizeNewlines(new TextDecoder('utf-16le').decode(bytes.subarray(2)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return normalizeNewlines(new TextDecoder('utf-16be').decode(bytes.subarray(2)));
  }
  try {
    return normalizeNewlines(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    let latin = '';
    for (const byte of bytes) latin += String.fromCharCode(byte);
    return normalizeNewlines(latin);
  }
}

function normalizeNewlines(text: string): string {
  return text.replaceAll(/\r\n?/g, '\n');
}

/**
 * Turn lyric text into lines, honouring LRC timestamps when present.
 *
 * LRC is plain text with `[mm:ss.xx]` markers at the start of a line; one line may carry
 * several markers when a chorus repeats. Metadata lines (`[ar:…]`, `[ti:…]`, `[length:…]`)
 * are not lyrics and are dropped, and `[offset:+500]` shifts every timestamp — it is part
 * of the format, and ignoring it would put every line half a second out on files that use
 * it.
 *
 * A line with no timestamp-and-text at all falls back to unsynced text: the whole input's
 * non-empty lines, with their content preserved. That is the `.txt` case, and also the
 * case of an LRC file whose timestamps are malformed — better readable lyrics than none.
 */
function parseLyricsText(raw: string): ParsedLyrics {
  const text = normalizeNewlines(raw);
  const offset = readOffset(text);
  const timed: LyricsLine[] = [];
  const plain: string[] = [];
  let sawTimestamp = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) {
      plain.push('');
      continue;
    }

    const groups = readBracketGroups(line);
    // A metadata line is not a lyric: `[ar:Bon Iver]` carries nothing a panel draws. It is
    // dropped only when no timestamp came with it — `[offset:500][00:01.00]text` is one.
    if (groups.metadata && groups.stamps.length === 0) continue;

    if (groups.stamps.length === 0) {
      plain.push(line);
      continue;
    }

    sawTimestamp = true;
    const lyric = line.slice(groups.end);
    for (const startMs of groups.stamps) timed.push({ startMs: Math.max(0, startMs + offset), text: lyric });
  }

  if (!sawTimestamp) {
    return { synced: false, lines: trimBlankEdges(plain).map((text) => ({ startMs: null, text })) };
  }

  timed.sort((left, right) => (left.startMs ?? 0) - (right.startMs ?? 0));
  return { synced: true, lines: timed };
}

interface BracketGroups {
  /**
   * Milliseconds of every timestamp the line opened with, in order.
   */
  readonly stamps: readonly number[];
  /**
   * Where the lyric text starts — past every leading bracket group.
   */
  readonly end: number;
  /**
   * Whether any leading group was a `key:value` metadata field.
   */
  readonly metadata: boolean;
}

/**
 * Read a line's leading bracket groups: timestamps, metadata, or neither.
 *
 * A group that parses as a time is a timestamp; a `key:value` group is metadata; anything
 * else is lyric text that happens to start with a bracket (`[Chorus]`), which is left
 * alone. LRC also allows several timestamps on one line — a repeated chorus — so the walk
 * continues while the line keeps opening with a bracket.
 */
function readBracketGroups(line: string): BracketGroups {
  const stamps: number[] = [];
  let cursor = 0;
  let metadata = false;

  while (line[cursor] === '[') {
    const close = line.indexOf(']', cursor + 1);
    if (close === -1) break;
    const body = line.slice(cursor + 1, close);
    const time = parseTimestamp(body);
    if (time !== null) {
      stamps.push(time);
      cursor = close + 1;
      continue;
    }
    if (!isMetadataField(body)) break;
    metadata = true;
    cursor = close + 1;
  }

  return { stamps, end: cursor, metadata };
}

/**
 * A `key:value` group, where the key is alphabetic — `ar`, `ti`, `length`, `offset`.
 */
function isMetadataField(body: string): boolean {
  const separator = body.indexOf(':');
  return separator > 0 && /^[A-Z]+$/i.test(body.slice(0, separator));
}

/**
 * The `[offset:±ms]` a file declares, or `0`.
 *
 * Ignoring it puts every line of a file that uses it half a second out, which a lyric
 * panel shows rather than hides. Read from the whole text rather than from a line, because
 * the field is a file-level declaration and may sit beside the metadata header.
 */
function readOffset(text: string): number {
  const match = /\[offset:\s*([+-]?\d+)\]/i.exec(text);
  if (match === null) return 0;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * `mm:ss`, `mm:ss.xx` or `mm:ss.xxx` → milliseconds, or `null` when the body is not a time.
 *
 * LRC's fraction is hundredths by convention, but three digits are milliseconds in the
 * wild, and one digit is tenths. Treating all three as hundredths puts a `.500` marker
 * five seconds late, which is a lyric panel visibly out of sync rather than an error.
 */
function parseTimestamp(body: string): number | null {
  const match = /^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/.exec(body.trim());
  if (match === null) return null;
  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  if (seconds > 59) return null;
  const fraction = match[3];
  let milliseconds = 0;
  if (fraction !== undefined) {
    milliseconds = fraction.length === 1 ? Number(fraction) * 100 : fraction.length === 2 ? Number(fraction) * 10 : Number(fraction);
  }
  return minutes * 60_000 + seconds * 1000 + milliseconds;
}

function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

export { decodeLyricsText, parseLyricsText };
export type { LyricsLine, ParsedLyrics };
