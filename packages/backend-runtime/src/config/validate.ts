/**
 * The fail-fast misconfiguration report.
 *
 * ### Why this is a module rather than a method
 *
 * Because it is a list of checks and not a per-setting getter, and `AppConfiguration` is
 * otherwise exactly that — a facade with one method per setting. The two grew together until the
 * facade was carrying a hundred and eighty lines of policy that has nothing to do with being a
 * facade, and it crossed the god-file limit. A check belongs beside the policy it enforces, not
 * on the object a caller reads settings from.
 *
 * ### Why it is a function taking the section objects
 *
 * So a check reads the setting the same way every other caller does — through the section that
 * owns its parsing, including its fallback. A check that re-read `env` with its own parser is a
 * second answer to the same question, which is the defect this whole method exists to catch.
 *
 * ### Why the report is a string list, printed once
 *
 * Every failure mode here is **silent at request time**: a malformed numeric var falls back to
 * its default, a `TEAM_DOMAIN` typo presents as a Cloudflare Access outage, and a bypass identity
 * set in production authenticates every unauthenticated request as a fixed user. There is no
 * error response a client could see, so this is the only place any of it surfaces.
 */
import { EnvParser } from './EnvParser';
import { isAlbumGrouping, ALBUM_GROUPINGS } from '@edge-sonic/subsonic';
import { isLogLevel } from '../logger';
import { clampWarningsFor } from './validateClamps';
import { authBypassWarnings, privateHostWarnings } from './validateAuth';
import type { AuthConfig } from './sections/AuthConfig';
import type { LibraryLimits, RequestLimits, ScanLimits } from './sections/LibraryLimits';

/**
 * The longest a `DERIVED_MARKER` may be.
 *
 * Moved here rather than kept as a static on `AppConfiguration` for one reason: the check and the
 * limit have to move together, and a limit read from the class while the check that enforces it
 * lives in a module is two places to forget. `AppConfiguration` re-exports it so a caller
 * asserting the boundary is reading the number the check used.
 */
const DERIVED_MARKER_MAX_LENGTH = 64;

/**
 * A control character: C0 plus DEL.
 *
 * Spelled as a class over code points rather than a Unicode category because the set that
 * matters is the one `normalizeRelativePath` refuses when it decodes an id, and that is this
 * list. A category would be a second answer to a question the decoder already answers, and a
 * disagreement between the two is an id that validates here and fails there.
 *
 * `no-control-regex` is disabled for the line below, and the reason is that this rule's entire
 * purpose is to find control characters — this is the one place in the repository where the
 * subject of the check *is* the thing being looked for. The alternative, code-point arithmetic
 * in a loop, is the shape a hand-rolled scanner invites; matching the range is linear, and the
 * range is the specification.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * `TEAM_DOMAIN` feeds the JWKS URL, so a scheme-less value throws inside `jose`.
 */
function isParsableTeamDomain(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Keys whose value must parse as a positive integer.
 *
 * `TAG_READ_TAIL_BYTES` is deliberately **absent**: its contract is `>= 0`, because zero is a
 * supported value that disables the Ogg tail read, and `isValidPositiveInt` would report zero
 * as invalid. Two contracts, two checks — see {@link validateConfiguration}.
 */
const POSITIVE_INT_KEYS: readonly string[] = [
  'MAX_LIBRARIES',
  'WEBDAV_TIMEOUT_MS',
  'SCAN_CHUNK_FOLDERS',
  'SCAN_CHUNK_MAX_REQUESTS',
  'SCAN_CHUNK_DEADLINE_MS',
  'SCAN_ENRICH_MAX_PER_FOLDER',
  'TAG_READ_BYTES',
  'MAX_PAGE_SIZE',
  'DEFAULT_PAGE_SIZE',
  'STREAM_RATE_LIMIT',
  'STREAM_TIMEOUT_MS',
  'AUTH_FAILURE_LIMIT',
  'AUTH_FAILURE_WINDOW_SECONDS',
];

function validateConfiguration(
  library: LibraryLimits,
  scan: ScanLimits,
  requests: RequestLimits,
  auth: AuthConfig,
  env: unknown,
): string[] {
  const warnings: string[] = [];
  for (const key of POSITIVE_INT_KEYS) {
    if (!EnvParser.isValidPositiveInt(env, key)) {
      warnings.push(`Invalid configuration: ${key} must be a positive integer`);
    }
  }

  // `TAG_READ_TAIL_BYTES` is absent from the list above, so a typo'd value fell back to
  // the 64 KB default and the Ogg duration was quietly absent for every track — the
  // exact failure the header says this method exists to catch. Checked separately
  // rather than by adding it to `numericKeys`, because its contract is `>= 0` and zero is
  // a supported value (`getTagReadTailBytes`), which `isValidPositiveInt` would report as
  // invalid. Two contracts, two checks.
  if (!EnvParser.isValidNonNegativeInt(env, 'TAG_READ_TAIL_BYTES')) {
    warnings.push('Invalid configuration: TAG_READ_TAIL_BYTES must be a non-negative integer (0 disables the Ogg tail read)');
  }

  // Reported separately from the loop above because the configured value *is* a valid positive integer —
  // it is the request it implies that is unservable, and nothing else here would say so.
  warnings.push(...clampWarningsFor(scan, requests));

  // `LOG_LEVEL` is checked separately because it is an enum rather than a number, and
  // because it is the one variable whose value was silently unobservable: both loggers
  // are module-level constants, so the level was resolved before `env` existed and an
  // operator who set `LOG_LEVEL=debug` got silence — the log level you cannot see is not
  // a setting. `validate()` is where a typo becomes visible at all.
  const logLevel = EnvParser.string(env, 'LOG_LEVEL', '').trim();
  if (logLevel.length > 0 && !isLogLevel(logLevel.toLowerCase())) {
    warnings.push(`Invalid configuration: LOG_LEVEL must be one of debug, info, warn, error (got ${JSON.stringify(logLevel)})`);
  }

  // `ALBUM_GROUP_BY` decides what an album **is**, so an unrecognised value is not a
  // degraded answer — it is a different answer than the operator asked for, delivered
  // without saying so. Every other variable in this method either falls back to a default
  // that is close to what was meant, or clamps a bound. Neither is true here: `folder`,
  // `album` and `album_artist` partition a library into different albums, and the default is
  // a *different* partition rather than a safe approximation of the configured one.
  //
  // So it is named. Silently grouping by `album` when an operator wrote `ALBUM_GROUP_BY=album
  // artist` is the "an unrecognised `type` is a different failure and stays a different one"
  // rule applied to a setting rather than a parameter — and it is the more dangerous half,
  // because a mistyped setting has no error response for a client to see.
  const albumGroupBy = requests.getRequestedAlbumGroupBy();
  if (albumGroupBy.length > 0 && !isAlbumGrouping(albumGroupBy)) {
    warnings.push(
      `Invalid configuration: ALBUM_GROUP_BY must be one of ${ALBUM_GROUPINGS.join(', ')} (got ${JSON.stringify(albumGroupBy)}). ` +
        `It decides which tracks are one album, so a value that is not recognised is a different grouping rather than a degraded one; ` +
        `the default is in force until it is corrected.`,
    );
  }

  // `DERIVED_MARKER` is the one variable whose value reaches a stored column *and* an
  // album id, so two classes of bad value are worth naming and neither throws.
  //
  // A control character is refused because of the id, not because of the SQL. `decodeId`
  // runs `normalizeRelativePath` over a decoded payload and refuses control characters,
  // so a marker carrying one mints an `alk:` id this server cannot read back — `getAlbum`
  // answers `code=70` and `getCoverArt` serves the placeholder, with nothing naming a
  // cause. That is the `Sgt. Pepper's` defect one level down, and it is why a marker
  // cannot be arbitrary text.
  //
  // Length is refused because the marker is appended to every derived name and therefore
  // lands in a base64url id and a `WHERE` clause; the ceiling is stated rather than
  // guessed at, and an operator who genuinely needs more is told which number to raise.
  //
  // `%` and `_` are **not** refused: they are ordinary characters, because the marker is
  // bound as a parameter and the guard is a column comparison rather than a `LIKE` against
  // the stored value. Refusing them would preserve the confusion that column removed.
  const derivedMarker = requests.getRequestedDerivedMarker();
  if (CONTROL_CHARACTERS.test(derivedMarker)) {
    warnings.push(
      `Invalid configuration: DERIVED_MARKER must not contain control characters (got ${JSON.stringify(derivedMarker)}). ` +
        `It is appended to every derived album and artist name and encoded into every album id, and an id this server cannot ` +
        `decode is an album that answers code=70 with nothing saying why.`,
    );
  } else if (derivedMarker.length > DERIVED_MARKER_MAX_LENGTH) {
    warnings.push(
      `Invalid configuration: DERIVED_MARKER is ${derivedMarker.length} characters, over the ${DERIVED_MARKER_MAX_LENGTH} supported. ` +
        `It is appended to every derived name and encoded into every album id, so it is paid for on every request.`,
    );
  }

  // The bypass present but inert is the dangerous direction: one edit to
  // ENVIRONMENT away from authenticating everyone as a fixed identity. An
  // *active* bypass is the intended local setup and is not reported.
  warnings.push(...authBypassWarnings(auth));

  // An unparsable TEAM_DOMAIN silently degrades JWT verification into a 401 for
  // every real user, which reads as an Access outage rather than a typo.
  const teamDomain = auth.getTeamDomain();
  if (teamDomain !== null && !isParsableTeamDomain(teamDomain)) {
    warnings.push(`Invalid configuration: TEAM_DOMAIN must be a hostname (got ${JSON.stringify(teamDomain)})`);
  }
  const policyAud = auth.getPolicyAud();
  if (policyAud !== null && policyAud.includes(',')) {
    warnings.push('Invalid configuration: POLICY_AUD must be a single audience; multiple values are not supported');
  }

  warnings.push(...privateHostWarnings(library, auth));

  return warnings;
}

export { DERIVED_MARKER_MAX_LENGTH, validateConfiguration };
