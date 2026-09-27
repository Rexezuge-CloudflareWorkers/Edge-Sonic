/**
 * Server-side strings.
 *
 * ### One locale, deliberately
 *
 * The reference project this was scaffolded from carried twelve locale bundles
 * for a WebDAV router's admin UI. That surface does not exist here, and the
 * strings that *do* matter are not localizable in a useful way:
 *
 * - **Subsonic protocol errors are not ours to translate.** The protocol
 *   specifies an `error` element with a numeric `code` and an English `message`,
 *   and clients localize *by code*. Emitting a translated message changes what an
 *   unrecognized client displays without making it any more correct — and
 *   routing protocol messages through a localization layer is exactly how a
 *   translated string ends up inside a `<subsonic-response>`. They live in
 *   `@edge-sonic/subsonic` and are deliberately English-only.
 * - **What is left** is the handful of strings the admin API returns, and English
 *   is the only locale with a real audience for a self-hosted music server today.
 *
 * The `Locale` type, the fallback chain, and `scripts/validate_locales.mjs` all
 * still exist, because adding a second locale should be a data change and not a
 * structural one. A translator is a one-file addition; if that stops being true,
 * this file is the thing to fix.
 */

/**
Every locale the server ships. `en` is the fallback and must never be empty.
*/
type Locale = 'en';

const DEFAULT_LOCALE: Locale = 'en';

interface BackendStrings {
  readonly common: {
    readonly internalError: string;
    readonly notFound: string;
    readonly unauthorized: string;
    readonly forbidden: string;
    readonly badRequest: string;
    readonly conflict: string;
    readonly tooManyRequests: string;
    readonly serviceUnavailable: string;
  };
}

const en: BackendStrings = {
  common: {
    internalError: 'An internal error occurred.',
    notFound: 'The requested resource was not found.',
    unauthorized: 'Authentication is required.',
    forbidden: 'You are not authorized to perform this operation.',
    badRequest: 'The request was malformed.',
    conflict: 'The request conflicts with the current state.',
    tooManyRequests: 'Too many requests. Please slow down.',
    serviceUnavailable: 'The service is temporarily unavailable. Please retry.',
  },
};

const BUNDLES: Record<Locale, BackendStrings> = { en };

/**
 * Resolve a language tag to a bundle.
 *
 * A tag like `en-GB` or `zh-Hant-TW` falls back to `en` rather than to a partial
 * match: a wrong-but-close locale is worse than an honest English string, because
 * the user cannot tell which one they are reading.
 */
function getBackendStrings(locale?: string | null): BackendStrings {
  return typeof locale !== 'string' || locale.length === 0 ? BUNDLES[DEFAULT_LOCALE] : BUNDLES[locale.trim().toLowerCase() as Locale] ?? BUNDLES[DEFAULT_LOCALE];
}

export { getBackendStrings, BUNDLES, DEFAULT_LOCALE };
export type { BackendStrings, Locale };
