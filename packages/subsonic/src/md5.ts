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

/**
Per-round left-rotation amounts, RFC 1321 §3.4.
*/
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/**
`floor(2^32 × abs(sin(i + 1)))` for i in 0..63, RFC 1321 §3.4.
*/
const K = [
  0xd7_6a_a4_78, 0xe8_c7_b7_56, 0x24_20_70_db, 0xc1_bd_ce_ee, 0xf5_7c_0f_af, 0x47_87_c6_2a, 0xa8_30_46_13, 0xfd_46_95_01, 0x69_80_98_d8,
  0x8b_44_f7_af, 0xff_ff_5b_b1, 0x89_5c_d7_be, 0x6b_90_11_22, 0xfd_98_71_93, 0xa6_79_43_8e, 0x49_b4_08_21, 0xf6_1e_25_62, 0xc0_40_b3_40,
  0x26_5e_5a_51, 0xe9_b6_c7_aa, 0xd6_2f_10_5d, 0x02_44_14_53, 0xd8_a1_e6_81, 0xe7_d3_fb_c8, 0x21_e1_cd_e6, 0xc3_37_07_d6, 0xf4_d5_0d_87,
  0x45_5a_14_ed, 0xa9_e3_e9_05, 0xfc_ef_a3_f8, 0x67_6f_02_d9, 0x8d_2a_4c_8a, 0xff_fa_39_42, 0x87_71_f6_81, 0x6d_9d_61_22, 0xfd_e5_38_0c,
  0xa4_be_ea_44, 0x4b_de_cf_a9, 0xf6_bb_4b_60, 0xbe_bf_bc_70, 0x28_9b_7e_c6, 0xea_a1_27_fa, 0xd4_ef_30_85, 0x04_88_1d_05, 0xd9_d4_d0_39,
  0xe6_db_99_e5, 0x1f_a2_7c_f8, 0xc4_ac_56_65, 0xf4_29_22_44, 0x43_2a_ff_97, 0xab_94_23_a7, 0xfc_93_a0_39, 0x65_5b_59_c3, 0x8f_0c_cc_92,
  0xff_ef_f4_7d, 0x85_84_5d_d1, 0x6f_a8_7e_4f, 0xfe_2c_e6_e0, 0xa3_01_43_14, 0x4e_08_11_a1, 0xf7_53_7e_82, 0xbd_3a_f2_35, 0x2a_d7_d2_bb,
  0xeb_86_d3_91,
] as const;

/**
 * 32-bit modular addition — the wrap MD5 is defined over.
 *
 * `| 0` is that wrap, and `Math.trunc` is not: the two agree inside the 32-bit range and
 * differ outside it, and MD5's running sum is routinely pushed outside it. Written as
 * the specification words it rather than "cleaned up".
 */
function add32(a: number, b: number): number {
  // eslint-disable-next-line unicorn/prefer-math-trunc -- the 32-bit wrap IS the spec.
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
  const words: number[] = Array.from({ length: count });
  for (let index = 0; index < count; index += 1) {
    const at = index * 4;
    words[index] = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  }
  return words;
}

function toLittleEndianBytes(words: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  for (const [index, word] of words.entries()) {
    bytes[index * 4] = word & 0xff;
    bytes[index * 4 + 1] = (word >>> 8) & 0xff;
    bytes[index * 4 + 2] = (word >>> 16) & 0xff;
    bytes[index * 4 + 3] = (word >>> 24) & 0xff;
  }
  return bytes;
}

/**
The per-round mixing function and message-word index for round `i`.
*/
function roundFunction(i: number, b: number, c: number, d: number): number {
  if (i < 16) return (b & c) | (~b & d);
  if (i < 32) return (d & b) | (~d & c);
  return i < 48 ? b ^ c ^ d : c ^ (b | ~d);
}

function wordIndexFor(i: number): number {
  if (i < 16) return i;
  if (i < 32) return (5 * i + 1) % 16;
  return (i < 48 ? 3 * i + 5 : 7 * i) % 16;
}

/**
MD5 of raw bytes, lowercase hex.
*/
function md5Bytes(input: Uint8Array): string {
  // Append 0x80, pad with zeros until the length is 56 mod 64, then append the
  // bit count as a little-endian 64-bit integer.
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  // `bitLength` is exact in a JS number below 2^53 bits, so the 64-bit split
  // below is lossless for any input this server will ever hash.
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_00_00_00_00), true);

  const words = toLittleEndianWords(padded, paddedLength / 4);

  let a0 = 0x67_45_23_01;
  let b0 = 0xef_cd_ab_89;
  let c0 = 0x98_ba_dc_fe;
  let d0 = 0x10_32_54_76;

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
