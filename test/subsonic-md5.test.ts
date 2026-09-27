/**
 * MD5 against the RFC 1321 test suite.
 *
 * This is the one algorithm in the repository that cannot be "obviously right", and
 * a wrong `md5` does not fail loudly — it fails as *every user being unable to log
 * in*, which is indistinguishable from a broken server. Hence the standard vectors,
 * the specification's own worked example, and a non-ASCII case.
 */
import { describe, expect, it } from 'vitest';
import { md5Bytes, md5Hex } from '@edge-sonic/subsonic';

/** RFC 1321 appendix A.5. */
const RFC_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];

describe('md5', () => {
  it('matches the RFC 1321 test vectors', () => {
    for (const [input, expected] of RFC_VECTORS) {
      expect(md5Hex(input), `md5(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it('reproduces the worked example from the Subsonic API reference', () => {
    // The spec's own example: password `sesame`, salt `c19b2d`.
    expect(md5Hex('sesamec19b2d')).toBe('26719a1196d2a940705a59634eb18eab');
  });

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // The failure this guards is invisible for an ASCII password and total for a
    // non-ASCII one: a UTF-16 hash produces a token mismatch that looks exactly
    // like a wrong password, on every client, forever.
    expect(md5Hex('pässwörd')).toBe('12841e4ba5e37d2fbfc78458c6714ade');
    expect(md5Hex('🎵')).not.toBe(md5Hex('🎵'.slice(0, 1)));
  });

  it('handles the block-boundary lengths where padding is easy to get wrong', () => {
    // 55, 56 and 64 bytes straddle the "one block", "two blocks" and
    // "exactly two blocks" padding cases. An off-by-one in the length field shows
    // up here and nowhere else for short inputs.
    const expectations: readonly [number, string][] = [
      [55, 'ef1772b6dff9a122358552954ad0df65'],
      [56, '3b0c8ac703f828b04c6c197006d17218'],
      [63, 'b06521f39153d618550606be297466d5'],
      [64, '014842d480b571495a4a0363793f7367'],
    ];
    for (const [length, expected] of expectations) {
      const bytes = new Uint8Array(length).fill('a'.charCodeAt(0));
      expect(md5Bytes(bytes), `md5 of ${length} bytes`).toBe(expected);
    }
  });

  it('emits lowercase hex of exactly 32 characters', () => {
    const digest = md5Hex('anything');
    expect(digest).toHaveLength(32);
    expect(digest).toMatch(/^[\da-f]{32}$/);
  });
});
