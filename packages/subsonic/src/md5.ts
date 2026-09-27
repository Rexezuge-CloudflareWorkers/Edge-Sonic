/**
 * MD5, because the Subsonic protocol requires it.
 *
 * `t = md5(password + salt)`, lowercase hex, UTF-8. The protocol has no
 * alternative, so this is not a choice — but it *is* a security decision, and the
 * file exists to make that decision visible in one place rather than smuggled in
 * as a dependency or reimplemented at three call sites.
 *
 * What MD5 is and is not, for anyone reading this later:
 *
 * - It is a **credential transport**, not a password hash. The server never
 *   stores `md5(password)`; it stores the password reversibly and recomputes
 *   `md5(password + salt)` per request. There is no MD5 hash table to steal.
 * - The threat MD5 genuinely creates is **offline brute force of a captured
 *   request**: `u`+`t`+`s` is exactly as much information as the password,
 *   because an attacker who captures it can test candidate passwords locally
 *   forever without touching the server. That is why the auth throttle is
 *   D1-authoritative and fails closed, and why the README does not describe this
 *   as safe.
 * - The per-request salt means captured requests do not replay against each
 *   other: the same password yields a different `t` every time.
 *
 * This is a from-scratch implementation because the Workers runtime has no
 * built-in MD5, and the alternative — a general-purpose crypto dependency for
 * one function — is a larger supply-chain surface than the function itself. It
 * is verified against the RFC 1321 test vectors in `test/subsonic-md5.test.ts`.
 */

/** Per-round left-rotation amounts, RFC 1321 §3.4. */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16,
  23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/** `floor(2^32 × abs(sin(i + 1)))` for i in 0..63, RFC 1321 §3.4. */
const K = [
  0xd76a_a478, 0xe8c7_b756, 0x2420_70db, 0xc1bd_ceee, 0xf57c_0faf, 0x4787_c62a, 0xa830_4613, 0xfd46_9501, 0x6980_98d8, 0x8b44_f7af, 0xffff_5bb1,
  0x895c_d7be, 0x6b90_1122, 0xfd98_7193, 0xa679_438e, 0x49b4_0821, 0xf61e_2562, 0xc040_b340, 0x265e_5a51, 0xe9b6_c7aa, 0xd62f_105d, 0x0244_1453,
  0xd8a1_e681, 0xe7d3_fbc8, 0x21e1_cde6, 0xc337_07d6, 0xf4d5_0d87, 0x455a_14ed, 0xa9e3_e905, 0xfcef_a3f8, 0x676f_02d9, 0x8d2a_4c8a, 0xfffa_3942,
  0x8771_f681, 0x6d9d_6122, 0xfde5_380c, 0xa4be_ea44, 0x4bde_cfa9, 0xf6bb_4b60, 0xbebf_bc70, 0x289b_7ec6, 0xeaa1_27fa, 0xd4ef_3085, 0x0488_1d05,
  0xd9d4_d039, 0xe6db_99e5, 0x1fa2_7cf8, 0xc4ac_5665, 0xf429_2244, 0x432a_ff97, 0xab94_23a7, 0xfc93_a039, 0x655b_59c3, 0x8f0c_cc92, 0xffef_f47d,
  0x8584_5dd1, 0x6fa8_7e4f, 0xfe2c_e6e0, 0xa301_4314, 0x4e08_11a1, 0xf753_7e82, 0xbd3a_f235, 0x2ad7_d2bb, 0xeb86_d391,
] as const;

/** 32-bit modular addition. `| 0` is the wrap. */
function add32(a: number, b: number): number {
  return (a + b) | 0;
}

/**
 * Logical left rotate.
 *
 * `>>> 0` matters: without it a value with the high bit set would sign-extend
 * through `>>>` and produce a negative, which poisons the rest of the round.
 */
function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function toLittleEndianWords(bytes: Uint8Array, count: number): number[] {
  const words: number[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const at = index * 4;
    words[index] = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  }
  return words;
}

function toLittleEndianBytes(words: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    bytes[index * 4] = word & 0xff;
    bytes[index * 4 + 1] = (word >>> 8) & 0xff;
    bytes[index * 4 + 2] = (word >>> 16) & 0xff;
    bytes[index * 4 + 3] = (word >>> 24) & 0xff;
  }
  return bytes;
}

/** The per-round mixing function and message-word index for round `i`. */
function roundFunction(i: number, b: number, c: number, d: number): number {
  if (i < 16) return (b & c) | (~b & d);
  if (i < 32) return (d & b) | (~d & c);
  if (i < 48) return b ^ c ^ d;
  return c ^ (b | ~d);
}

function wordIndexFor(i: number): number {
  if (i < 16) return i;
  if (i < 32) return (5 * i + 1) % 16;
  if (i < 48) return (3 * i + 5) % 16;
  return (7 * i) % 16;
}

/** MD5 of raw bytes, lowercase hex. */
function md5Bytes(input: Uint8Array): string {
  // Append 0x80, pad with zeros until the length is 56 mod 64, then append the
  // bit count as a little-endian 64-bit integer.
  const bitLength = input.length * 8;
  const paddedLength = ((((input.length + 8) >>> 6) + 1) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  // `bitLength` is exact in a JS number below 2^53 bits, so the 64-bit split
  // below is lossless for any input this server will ever hash.
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_0000_0000), true);

  const words = toLittleEndianWords(padded, paddedLength / 4);

  let a0 = 0x6745_2301;
  let b0 = 0xefcd_ab89;
  let c0 = 0x98ba_dcfe;
  let d0 = 0x1032_5476;

  for (let block = 0; block < words.length; block += 16) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      const f = add32(add32(add32(roundFunction(i, b, c, d), a), K[i]), words[block + wordIndexFor(i)]);
      const next = add32(b, rotateLeft(f, SHIFTS[i]));
      // RFC 1321 §3.3: A←D, D←C, C←B, B←B+leftrotate(F).
      a = d;
      d = c;
      c = b;
      b = next;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  return toHex(toLittleEndianBytes([a0, b0, c0, d0]));
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * MD5 of a string, as the Subsonic protocol specifies it: UTF-8 bytes,
 * lowercase hex.
 *
 * UTF-8 rather than UTF-16 is the part that is easy to get wrong and produces a
 * token mismatch that looks exactly like a wrong password — a non-ASCII
 * password would fail authentication on every client, forever.
 */
function md5Hex(input: string): string {
  return md5Bytes(new TextEncoder().encode(input));
}

export { md5Hex, md5Bytes };
