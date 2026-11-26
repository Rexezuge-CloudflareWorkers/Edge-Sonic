/**
 * The `share` protocol model.
 *
 * ### Why this is its own module and not a `builders.ts` append
 *
 * `builders.ts` sits at its god-file budget, and a share is a distinct protocol type rather
 * than another spelling of a song or album. Keeping the builder here also keeps the one
 * decision that is easy to get wrong — the repeated child is named `entry`, and it must be
 * **declared** so a share holding a single track still serialises it as an array — beside the
 * type it belongs to.
 *
 * ### Why `entries` are `Song`s and not ids
 *
 * The protocol's `share.entry` is a `Child` element. This server has one builder for a track
 * and it is `songElement`; re-declaring the attribute set here would let the share's view of a
 * track drift from every other endpoint's. The element is therefore a `songElement` with its
 * name replaced, which is a rename of the shape rather than a second shape.
 */
import { elList } from './nodes';
import type { ElementNode } from './nodes';
import { songElement } from './builders';
import type { Song } from './types';

interface Share {
  readonly id: string;
  readonly url: string;
  /**
  Absent when the owner gave none; Subsonic marks `description` optional.
  */
  readonly description?: string;
  readonly username: string;
  /**
  ISO-8601, like every other timestamp on the wire.
  */
  readonly created: string;
  /**
  ISO-8601, or absent for a share that never expires.
  */
  readonly expires?: string;
  /**
  ISO-8601, or absent until the page has been opened once.
  */
  readonly lastVisited?: string;
  readonly visitCount: number;
  readonly entries: readonly Song[];
}

function shareElement(share: Share): ElementNode {
  return elList(
    'share',
    'entry',
    {
      id: share.id,
      url: share.url,
      description: share.description,
      username: share.username,
      created: share.created,
      expires: share.expires,
      lastVisited: share.lastVisited,
      visitCount: share.visitCount,
    },
    share.entries.map((song) => ({ ...songElement(song), name: 'entry' })),
  );
}

export { shareElement };
export type { Share };
