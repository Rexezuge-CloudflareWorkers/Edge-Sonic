/**
 * What a comment **means**: which `VORBIS_COMMENT` keys fill which field of an {@link AudioTags}.
 *
 * Split out of [`vorbisComment.ts`](./vorbisComment.ts) because the two halves answer different
 * questions and neither needs the other. That file asks _where does this comment end_ — the
 * framing, the length prefixes, the artwork that must not be materialized — and this one asks
 * _what does this comment say_. Keeping them apart is what makes the key table readable: the
 * list of keys this server publishes is a fact about the output, and it was buried under the
 * byte arithmetic that finds them.
 */
import { parseIndex, parseYear } from './bits';
import { contiguousSource } from './vorbisComment';
import type { ByteSource } from './vorbisComment';
import { walkVorbisCommentSource } from './vorbisComment';
import type { CommentFields } from './bits';

/**
 * Comment keys whose value is a **string**, and the field each fills.
 *
 * A table rather than a `switch` because the switch had no branching in it at all: nine cases,
 * each assigning one field, none of which could send control anywhere but the next. As a table it
 * is the list of keys this server reads, which is the thing worth being able to read in a glance.
 * `ALBUMARTIST` and `ALBUMARTISTSORT` are one field, so they are one row's two keys.
 */
const FIELD_BY_KEY: Readonly<Record<string, 'title' | 'artist' | 'album' | 'albumArtist' | 'genre'>> = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ALBUMARTIST: 'albumArtist',
  ALBUMARTISTSORT: 'albumArtist',
  GENRE: 'genre',
};

/**
 * Comment keys whose value is **parsed**, and the field each fills.
 *
 * Separate from the string keys because these three do not assign: the first spelling that
 * **parses** wins, not the first one seen. `DATE=unknown` followed by `YEAR=1969` must report
 * 1969, and a plain assignment would keep the unparseable string and leave the year absent.
 * Reading them the other way round also reports 1969, because the second does not parse and does
 * not overwrite — order-independent in both directions, which is the only property worth having
 * for a tag set written by tools that disagree about spelling.
 */
const PARSED_BY_KEY: Readonly<Record<string, 'year' | 'track' | 'disc'>> = {
  DATE: 'year',
  YEAR: 'year',
  ORIGINALDATE: 'year',
  TRACKNUMBER: 'track',
  DISCNUMBER: 'disc',
};

/**
Record a comment into `fields`, or ignore a key this server does not publish.
*/
function assignComment(fields: CommentFields, key: string, value: string): void {
  const field = FIELD_BY_KEY[key];
  if (field !== undefined) {
    fields[field] = value;
    return;
  }
  const parsed = PARSED_BY_KEY[key];
  switch (parsed) {
    case 'year': {
      fields.year = parseYear(value) ?? fields.year;
      break;
    }
    case 'track': {
      fields.track = parseIndex(value) ?? fields.track;
      break;
    }
    case 'disc': {
      fields.disc = parseIndex(value) ?? fields.disc;
      // No default
      break;
    }
  }
}

function parseVorbisCommentSource(source: ByteSource, offset: number): CommentFields {
  const fields: CommentFields = {
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    genre: null,
    year: null,
    track: null,
    disc: null,
  };

  walkVorbisCommentSource(source, offset, (key, value) => {
    // A whitespace-only value is absent. A `GENRE= ` tag is a junk genre the aggregates would
    // otherwise publish with a song count beside it.
    if (value === null || value.trim().length === 0) return;
    assignComment(fields, key, value);
  });

  return fields;
}

/**
 * Parse a `VORBIS_COMMENT` / `OpusTags` payload (vendor string and framing
 * already stripped by the caller).
 */
function parseVorbisComments(bytes: Uint8Array, offset: number): CommentFields {
  return parseVorbisCommentSource(contiguousSource(bytes), offset);
}

export { parseVorbisCommentSource, parseVorbisComments };
