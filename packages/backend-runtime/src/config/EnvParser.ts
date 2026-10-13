/**
 * Typed readers for a Worker `env` binding.
 *
 * `EnvParser` is `@rexezuge/runtime`'s. Two things this copy carried went into the
 * kit, and both are properties of the reader rather than of this product:
 *
 * ### The `env` guard
 *
 * The kit's `readString` cast `env` and indexed it, so a `null` or a partial
 * object threw a `TypeError`. Every caller's path here is a fail-soft one —
 * `env` may be `null` — and a throw in the reader replaces a default with a 500,
 * which is the exact failure the class exists to prevent, caused by the class
 * that prevents it.
 *
 * ### `isValidNonNegativeInt`
 *
 * The predicate for `nonNegativeInt`, which the kit has but the predicate did
 * not. `validate()` has to be able to *name* a bad value for a setting whose zero
 * is meaningful: `TAG_READ_TAIL_BYTES=0` disables the Ogg tail read, which that
 * limit's own documentation calls "a supported configuration and not a degraded
 * one". Reporting it invalid would generate a warning about the one correct value.
 */
export { EnvParser } from '@rexezuge/runtime';
