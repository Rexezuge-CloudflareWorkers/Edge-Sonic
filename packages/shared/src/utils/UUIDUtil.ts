/**
Primary keys.

A v4 UUID in canonical dashed form is the whole requirement for a row whose id is
never on the wire, and a **derived** UUID is the whole requirement for a row an
import must be able to recreate.
*/
class UUIDUtil {
  public static getRandomUUID(): string {
    return crypto.randomUUID();
  }

  /**
   * A UUID-shaped id derived from a namespace and its parts, stable across runs.
   *
   * ### Why this exists
   *
   * **Because "create this playlist" is not idempotent.** A Cloudflare Workflow step is
   * cached by name and may be retried, so an import that mints a fresh id per attempt writes
   * the *same playlist twice* on every retry — and a user who pressed the button three times
   * finds four copies. `PlaylistDAO.create` generating a v4 is right for the protocol path,
   * where each `createPlaylist` really is a new playlist, and wrong for an import, where a
   * retried step is the *same* playlist.
   *
   * So an imported playlist's id is a function of `(namespace, run, remotePlaylistId)`: a
   * retry resolves the same id, `replaceEntries` rewrites it, and the outcome does not depend
   * on how many times the step ran.
   *
   * ### SHA-256, and why not the MD5 already in the repository
   *
   * `md5Hex` exists for the Subsonic token scheme, which specifies it. This is a collision
   * question with a consequence: two different playlists sharing an id means one overwrites
   * the other, and MD5's collision resistance is not something to lean on when
   * `crypto.subtle` is available. 128 bits of SHA-256, in canonical dashed form so the value
   * is a UUID by inspection rather than 32 hex characters used as one.
   *
   * ### Every part is **length-prefixed**, because a separator proves nothing
   *
   * The obvious implementation joins the parts with a delimiter, and the obvious claim is that
   * the delimiter cannot appear inside a part. That claim is **false**, and it was false here:
   * joining `[ns, a, b]` and joining `[ns, a\u0000b]` both produce the same string, so a
   * delimiter — *any* delimiter — is forgeable by choosing a part containing it. Two
   * different playlists then hash to one id, and one overwrites the other.
   *
   * So each part contributes its **length** before its bytes: `3:ns1:a1:b`. That encoding is
   * injective, because the length is recoverable from the bytes themselves — there is exactly
   * one way to parse it — so no choice of parts produces the same string.
   *
   * Asserted in `test/import-phases.test.ts`, and asserted *because the first version was wrong*:
   * the delimiter-joined version passed every other test in this feature.
   */
  public static async deterministicId(namespace: string, ...parts: readonly string[]): Promise<string> {
    const payload = [namespace, ...parts].map((part) => `${part.length}:${part}`).join('');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const hex = Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
}

export { UUIDUtil };
