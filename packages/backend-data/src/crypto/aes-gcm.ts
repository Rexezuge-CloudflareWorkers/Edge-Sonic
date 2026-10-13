/**
 * AES-256-GCM for stored credentials.
 *
 * The envelope itself is `@rexezuge/d1`'s — `encryptSecret` / `decryptSecret`
 * over `{ ciphertext, iv }`. The local copy it replaced called
 * `decryptData(ciphertext, iv, key)` and let the platform's raw `OperationError`
 * escape when the key was wrong, so a rotated key surfaced as an opaque
 * decryption failure with nothing to act on. The kit's throws
 * `AesGcmKeyError`, which every call site above can catch and name.
 *
 * The two aliases below exist so the call sites do not all change shape in one
 * commit: `encryptData(plaintext, key)` and
 * `decryptData(ciphertext, iv, key)`. The **decrypt** one is a local shim rather
 * than a rename, because this repository stores the ciphertext and the IV in two
 * separate columns (`password_ciphertext`, `password_iv`) and the kit takes them
 * as one envelope — see `fromColumns`.
 *
 * What stays here is the two operations that are **this repository's**, not the
 * algorithm's:
 *
 * - `generateAesGcmKey` — what `scripts/deploy/init-secrets.ts` writes into a
 *   fresh deployment's secrets. The kit ships no generator: producing a key is a
 *   one-time bootstrap, and a library that hands out keys on request is a library
 *   that will be asked to.
 * - `isUsableKey` — what `serviceFactory` asks before accepting a key from the
 *   environment. The kit validates a key only when it uses one; a deployment with
 *   a malformed key should say so at boot, against the raw var, rather than at the
 *   first credential read.
 */
import { base64ToBytes, bytesToBase64 } from '@rexezuge/shared';
import { decryptSecret } from '@rexezuge/d1';
import type { EncryptedEnvelope } from '@rexezuge/d1';

const KEY_BYTES = 32;

/**
 * A fresh base64 AES-256-GCM key.
 *
 * Base64 of exactly 32 bytes, because that is what `crypto.subtle.importKey`
 * accepts for `AES-GCM` and the length is the one thing a caller cannot recover.
 */
function generateAesGcmKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return bytesToBase64(bytes);
}

/**
 * Whether a configured key is one this layer could actually use.
 *
 * Reports rather than throws, because the caller is a configuration check that
 * wants to name the problem and keep booting: a deployment whose key is
 * misconfigured should still serve every route that does not touch a credential.
 * A wrong **length** or a value that is not base64 at all is caught here; a
 * wrong-but-well-formed key is not, and cannot be, until a decrypt fails.
 */
function isUsableKey(keyBase64: string | null | undefined): boolean {
  if (typeof keyBase64 !== 'string' || keyBase64.length === 0) return false;
  try {
    return base64ToBytes(keyBase64).length === KEY_BYTES;
  } catch {
    return false;
  }
}

/**
 * The kit's envelope, assembled from this repository's two columns.
 *
 * The columns are the storage decision and the envelope is the API's; keeping
 * them apart means a migration to a single `envelope` column touches one
 * function rather than every credential read.
 */
function decryptData(ciphertext: string, iv: string, encodedKey: string | null | undefined): Promise<string> {
  return decryptSecret({ ciphertext, iv }, encodedKey);
}

export { decryptData, generateAesGcmKey, isUsableKey };
export { encryptSecret as encryptData, IV_BYTES, KEY_BYTES } from '@rexezuge/d1';
export { timingSafeEqualStrings } from '@rexezuge/shared';
/**
 * This repository's stored shape: an envelope plus the flattened pair the
 * `libraries` and `users` tables actually keep in columns.
 */
type Encrypted = EncryptedEnvelope & { ciphertext: string; iv: string };

export type { Encrypted };
