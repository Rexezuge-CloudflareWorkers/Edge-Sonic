/**
 * SHA-256 against the standard vectors.
 *
 * This is the one algorithm in this package that cannot be "obviously right",
 * and a wrong `sha256` does not fail loudly — it derives a *different* short
 * song id from every other runtime, so a rescan orphans every annotation while
 * reporting success. Hence the FIPS vectors, the block-boundary lengths where
 * padding is easy to get wrong, and a non-ASCII case.
 */
import { describe, expect, it } from 'vitest';
import { sha256Bytes, sha256Hex } from '@edge-sonic/subsonic';

/**
 * FIPS 180-4 §8 plus the two-block message, all over well-known inputs.
 */
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

describe('sha256', () => {
  it('matches the standard test vectors', () => {
    for (const [input, expected] of VECTORS) {
      expect(sha256Hex(input), `sha256(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // The failure this guards is invisible for an ASCII path and total for a
    // CJK one: a UTF-16 hash derives a different id from the same file on no
    // other implementation, and the orphaned annotations say nothing.
    expect(sha256Hex('pässwörd')).toBe('46970bef70aced8123f0d5d094717e2a5cd412041e03b26376049fe65b2834a4');
    expect(sha256Hex('🎵')).not.toBe(sha256Hex('🎵'.slice(0, 1)));
  });

  it('handles the block-boundary lengths where padding is easy to get wrong', () => {
    // 55, 56, 63 and 64 bytes straddle the "one block", "two blocks" and
    // "exactly two blocks" padding cases. An off-by-one in the length field shows
    // up here and nowhere else for short inputs.
    const expectations: ReadonlyArray<readonly [number, string]> = [
      [55, '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
      [56, 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
      [63, '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34'],
      [64, 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
    ];
    for (const [length, expected] of expectations) {
      const bytes = new Uint8Array(length).fill('a'.charCodeAt(0));
      const hex = Array.from(sha256Bytes(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(hex, `sha256 of ${length} bytes`).toBe(expected);
    }
  });
});
