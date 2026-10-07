/**
 * SHA-256, because a short song id must be derived synchronously.
 *
 * `deriveShortSongId` runs inside the indexers' per-file loops, while the
 * Workers runtime only offers `crypto.subtle.digest` — async. Awaiting a
 * digest for every file would add promise scheduling to each scan and browse
 * pass, so the primitive lives here instead, beside `md5.ts`: one pure function
 * the node suite can check against standard vectors with no runtime or double.
 *
 * FIPS 180-4 §6.2.2, over the input bytes as given.
 */

/**
 * The cube-root fractional constants, FIPS 180-4 §4.2.2.
 */
const K = [
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5,
  0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74,
  0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da,
  0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47, 0x06_ca_63_51, 0x14_29_29_67,
  0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
  0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70,
  0x19_a4_c1_16, 0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f, 0x68_2e_6f_f3,
  0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08, 0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
] as const;

/**
 * The initial hash value, FIPS 180-4 §5.3.3.
 */
const H_INIT = [0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19] as const;

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function add(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) total = (total + value) >>> 0;
  return total;
}

/**
 * SHA-256 of raw bytes.
 *
 * Returns the 32-byte digest. Callers truncating it to fewer bytes keep the
 * prefix property the standard assumes: every output bit is still a function
 * of every input bit.
 */
function sha256Bytes(input: Uint8Array): Uint8Array {
  // The high 32 bits of the *bit* count start at 2^29 bytes. Using a
  // 32-bit shift here would wrap before the input gets that long.
  const bitLengthHi = Math.floor(input.length / 0x20_00_00_00);
  const bitLengthLo = (input.length * 8) >>> 0;

  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLengthHi);
  view.setUint32(paddedLength - 4, bitLengthLo);

  const h: number[] = [...H_INIT];
  const w = Array.from({ length: 64 }, () => 0);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(block + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ ((w[i - 15]) >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ ((w[i - 2]) >>> 10)) >>> 0;
      w[i] = add(w[i - 16], s0, w[i - 7], s1);
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = add(hh, s1, ch, K[i], w[i]);
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = add(s0, maj);
      hh = g;
      g = f;
      f = e;
      e = add(d, t1);
      d = c;
      c = b;
      b = a;
      a = add(t1, t2);
    }

    h[0] = add(h[0], a);
    h[1] = add(h[1], b);
    h[2] = add(h[2], c);
    h[3] = add(h[3], d);
    h[4] = add(h[4], e);
    h[5] = add(h[5], f);
    h[6] = add(h[6], g);
    h[7] = add(h[7], hh);
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i += 1) out.setUint32(i * 4, h[i]);
  return digest;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * SHA-256 of a string's UTF-8 bytes, lowercase hex.
 *
 * UTF-8 rather than UTF-16 for the same reason as `md5Hex`: the two agree on
 * ASCII and diverge everywhere else, and a CJK path hashed as UTF-16 would
 * derive a different id from the same file on no other implementation.
 */
function sha256Hex(input: string): string {
  return toHex(sha256Bytes(new TextEncoder().encode(input)));
}

export { sha256Bytes, sha256Hex };
