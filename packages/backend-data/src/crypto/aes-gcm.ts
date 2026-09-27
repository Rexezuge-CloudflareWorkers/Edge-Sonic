/**
 * AES-256-GCM, over the WebCrypto API available in the Workers runtime.
 *
 * ### Why credentials are stored reversibly here at all
 *
 * Subsonic token authentication is `t = md5(password + salt)`. That is a one-way
 * function of the *plaintext*, so a server that stores only a password **hash**
 * cannot compute `t` and cannot authenticate a token client. This is a protocol
 * wart, not an implementation shortcut — navidrome#202 is titled "Passwords are
 * stored in clear text" and explains the same thing.
 *
 * So the password is stored encrypted rather than hashed. **Be precise about
 * what that buys:** it protects against a leaked D1 dump or a leaked
 * `songs`-adjacent export, because the key lives in Cloudflare Secrets Store and
 * not in the database. It does **not** protect against a full worker compromise,
 * where the key is in the same process. Treating it as more than that is how a
 * deployment ends up shipping it with a key in a `vars` block.
 *
 * ### Why GCM and not CBC
 *
 * GCM authenticates. A CBC ciphertext with no MAC is malleable, so a database
 * write primitive would let an attacker flip plaintext in a stored password and
 * the server would happily decrypt to a different — chosen — password. GCM makes
 * that a decryption failure.
 */

/** AES-256 key, base64. 32 bytes. */
type Base64Key = string;

/** GCM nonces must never repeat under one key. 96 bits is the standard choice. */
const IV_BYTES = 12;

/** A key of the wrong length fails at `importKey` with an opaque message; check early. */
const KEY_BYTES = 32;

function keyBytes(keyBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(keyBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

async function importKey(keyBase64: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const bytes = keyBytes(keyBase64);
  if (bytes.length !== KEY_BYTES) {
    // Named explicitly because the alternative is an `InvalidAccessError` from
    // `importKey` that reads like a platform bug rather than a misconfigured key.
    throw new Error(`Encryption key must decode to ${KEY_BYTES} bytes, got ${bytes.length}.`);
  }
  return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage]);
}

/**
 * A fresh GCM nonce. Typed to a non-shared buffer because `crypto.subtle`
 * rejects a `SharedArrayBuffer`-backed view, and `getRandomValues` widens to
 * `ArrayBufferLike`.
 */
function freshIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(IV_BYTES)) as Uint8Array<ArrayBuffer>;
}

/** Generate a new AES-256 key as base64. Used by `scripts/init-secrets.ts`. */
async function generateAesGcmKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

/** True when a secret is present and is a usable 256-bit base64 key. */
function isUsableKey(keyBase64: string | null | undefined): boolean {
  if (!keyBase64) return false;
  try {
    return keyBytes(keyBase64).length === KEY_BYTES;
  } catch {
    return false;
  }
}

interface Encrypted {
  readonly ciphertext: string;
  readonly iv: string;
}

/**
 * Encrypt a UTF-8 string.
 *
 * A fresh IV per call. Reusing one under a single key destroys GCM's security
 * outright — it leaks the XOR of two plaintexts and, for the auth check value,
 * would let a forged token be constructed — so the IV is always generated here
 * and stored alongside the ciphertext rather than derived.
 */
async function encryptData(plaintext: string, keyBase64: string): Promise<Encrypted> {
  const key = await importKey(keyBase64, 'encrypt');
  const iv = freshIv();
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

/**
 * Decrypt. Throws when the ciphertext, IV, key, or authenticated data do not
 * match — which is the intended behaviour for a tampered row, and the reason no
 * caller should wrap this in a `catch` that returns a default.
 */
async function decryptData(ciphertext: string, iv: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64, 'decrypt');
  const ivBytes = keyBytes(iv);
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, keyBytes(ciphertext));
  return new TextDecoder().decode(opened);
}

/**
 * Constant-time comparison for token and salt checks.
 *
 * `===` on a hex digest short-circuits on the first differing byte, which leaks
 * a prefix of the expected value to an attacker who can time responses. That is a
 * real attack against an MD5 token check, where the expected value is exactly
 * what the attacker is trying to guess.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return bytesEqual(left, right);
}

export { generateAesGcmKey, encryptData, decryptData, isUsableKey, timingSafeEqualStrings, KEY_BYTES, IV_BYTES };
export type { Encrypted, Base64Key };
