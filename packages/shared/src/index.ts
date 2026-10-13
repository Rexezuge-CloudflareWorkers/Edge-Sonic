/**
 * The backend string bundle, and nothing else.
 *
 * `packages/shared/src/utils` used to hold byte-identical copies of the kit's
 * pure utilities — `SubrequestMeter` (274 lines, zero code differences from
 * `@rexezuge/shared`), `UUIDUtil`, `ErrorSanitizationUtil`, `Identity` and
 * `SsrfHosts` — behind a barrel that re-exported them under this package's own
 * scope. Every one of them is now imported from `@rexezuge/shared` directly, and
 * this barrel is only what remains local.
 *
 * ## What stays here, and why
 *
 * **Subsonic protocol errors are not ours to translate.** A client localises by
 * the numeric `code`, so routing a protocol message through a localisation layer
 * is how a translated string ends up inside a `<subsonic-response>`. That block
 * belongs to `@edge-sonic/subsonic` and is English-only by policy.
 *
 * **The bundle is one locale, eight keys, and that is the product's decision.**
 * `@rexezuge/i18n` ships twelve locales of three keys. Adopting it would mean
 * dropping five strings this mapper needs, adopting status-line phrasing for
 * three its clients read as sentences, and shipping eleven locales nobody has
 * translated. The kit made the same call about this repo and recorded it
 * (`BackendStrings.ts`: "Noted, not ported").
 *
 * The SPA's own catalogue is a third, separate mechanism at
 * `apps/web/src/locales/**` — nested JSON for ~130 keys with interpolation,
 * validated by `scripts/i18n/validate_locales.ts`. The two catalogues share no
 * key; they are consumed by different processes.
 */
export * from './i18n';
