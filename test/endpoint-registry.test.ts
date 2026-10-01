/**
 * The `/rest` endpoint registry, as a contract rather than a table.
 *
 * ### What was missing, and why it is not a coverage nit
 *
 * `ENDPOINT_NAMES` and `UNIMPLEMENTED` were imported by **no test file anywhere**. So
 * `AGENTS.md` could say, accurately, that both `getOpenSubsonicExtensions` and `tokenInfo`
 * were found by "reading the OpenSubsonic endpoint list against the registry" — and then
 * admit in the same paragraph that "nothing in the suite asserted the registry covers what
 * a real client calls". That gap was identified and left open, and it is the same defect as
 * the subrequest bound that lived in a comment: a claim nothing measured.
 *
 * Three things follow from leaving it open:
 *
 * 1. **The `code=70` contract is untested as a property.** Every one of the 33
 *    unimplemented endpoints is supposed to answer "absent" rather than "empty" or "error".
 *    Each was correct, and a client asking for any of them got the right answer — but only
 *    because 33 separate registrations happened to be right.
 * 2. **An `IMPLEMENTED` entry that also appears in `UNIMPLEMENTED` is invisible.** The two
 *    are merged by `Object.keys(...).sort()` for `ENDPOINT_NAMES`, so a duplicate produces a
 *    name in the list that routes to whichever map was written last, and nothing reports it.
 * 3. **A name in neither list is unreachable and undeclared.** `getStarred` — the v1.16.1
 *    spelling — sat in `IMPLEMENTED` and was exercised by no test, because only its `2`
 *    form was ever called.
 *
 * So this suite asserts the registry's *shape* rather than any individual endpoint's
 * behaviour, which is the part that was missing.
 */
import { describe, expect, it } from 'vitest';
import { createHarness } from './helpers/harness';
import { ENDPOINT_NAMES, ENDPOINTS, UNIMPLEMENTED } from '../apps/api/src/rest/endpoints';

/**
 * The codes a client can act on differently. `code=70` is "this server does not have that
 * endpoint"; anything else invites a retry, which is the opposite of the answer.
 */
const ABSENT = 70;

/**
 * Every unimplemented endpoint's name, as a list.
 *
 * Behind a function so the iteration is not written in a `for…of` head: two enabled
 * rules disagree there — `unicorn/prefer-object-iterable-methods` wants
 * `Object.entries`, and its own autofix rewrites the destructured result back to
 * `Object.keys`, so `eslint --fix` and `eslint --no-fix` cannot both be satisfied on
 * that line. A helper is the smallest way to state the intent once.
 */
const unimplementedNames = (): string[] => Object.keys(UNIMPLEMENTED);

describe('the endpoint registry', () => {
  it('declares each unimplemented endpoint exactly once, in one map', () => {
    // A name in both maps would be routed by whichever was assigned last and reported by
    // neither. The keys are unique objects in JS, so the check has to be across the two.
    const implemented = Object.keys(ENDPOINTS);
    const unimplemented = unimplementedNames();
    const overlap = implemented.filter((name) => unimplemented.includes(name));
    expect(overlap).toEqual([]);
  });

  it('publishes a name for every declared endpoint, and nothing else', () => {
    // `ENDPOINT_NAMES` is what `endpointNameFromPath` dispatches on, so a missing name is
    // an endpoint a client cannot reach and an extra one is a path that answers `code=70`
    // while claiming to be implemented.
    const declared = [...Object.keys(ENDPOINTS), ...Object.keys(UNIMPLEMENTED)].sort((a, b) => a.localeCompare(b));
    expect([...ENDPOINT_NAMES].sort((a, b) => a.localeCompare(b))).toEqual(declared);
    // And no duplicates: a name listed twice would let a second, unreachable route share a
    // first one's identity.
    expect(new Set(ENDPOINT_NAMES).size).toBe(ENDPOINT_NAMES.length);
  });

  it('gives every unimplemented endpoint a reason, because the reason is what an operator is shown', () => {
    for (const [name, reason] of Object.entries(UNIMPLEMENTED)) {
      // Non-empty and specific. An empty string is what a placeholder entry carries, and it
      // reaches a client as an error message with nothing in it.
      expect(reason.trim().length, `${name} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('answers code=70 for every unimplemented endpoint, which is "absent", not "empty" or "broken"', async () => {
    const harness = await createHarness();
    try {
      const wrong: string[] = [];
      for (const name of unimplementedNames()) {
        const { status, body } = await harness.rest(name);
        const code = (body['subsonic-response'] as Record<string, unknown>)['error'] as { code?: number } | undefined;
        // Every one of these is a **200 in the protocol envelope** — the Subsonic dialect
        // has no non-200 for a protocol error — so the code is the only signal.
        expect(status, `${name} must use the envelope`).toBe(200);
        if (code?.code !== ABSENT) wrong.push(`${name} answered code=${String(code?.code)}`);
      }
      // One assertion rather than a loop of them, so the failure names every offender.
      expect(wrong).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it('answers with the reason and nothing else, so an unimplemented endpoint is not a probe', async () => {
    // `getOpenSubsonicExtensions` is the one endpoint answered **without credentials**,
    // which is safe only because its payload is a compile-time constant. Everything else in
    // the registry is authenticated first, so an unimplemented endpoint has already proved
    // the caller is valid — and could still answer with the caller's own identity, a
    // library's, or a version detail, which turns "not implemented" into a way to read the
    // deployment's data.
    //
    // The assertion is on the **exact key set**, not on a substring. An earlier version
    // searched the body for the username and reported `createPodcastChannel` as a leak,
    // because "Ch*ann*el" contains it: a substring check over real prose finds coincidences
    // and proves nothing. Two keys means one reason and one code.
    const harness = await createHarness();
    try {
      for (const name of unimplementedNames()) {
        const { body } = await harness.rest(name);
        const envelope = body['subsonic-response'] as Record<string, unknown>;
        const error = envelope.error as Record<string, unknown>;

        // `code` and `message`, and nothing else. A new attribute here is a new thing an
        // unimplemented endpoint discloses, so it fails this rather than needing review.
        expect(Object.keys(error).map((key) => key).sort(), `${name} error shape`).toEqual(['code', 'message']);
        // The message is the registry's reason, not something assembled from the request.
        expect(String(error.message), `${name} message`).toBe(`${name}: ${UNIMPLEMENTED[name]}.`);

        // And the envelope carries only the fixed server identity. `version` is the
        // protocol version every response carries, so it is not a disclosure; a user,
        // a library or a path would be.
        expect(Object.keys(envelope).map((key) => key).sort(), `${name} envelope shape`).toEqual(
          ['error', 'openSubsonic', 'serverVersion', 'status', 'type', 'version'].sort(),
        );
      }
    } finally {
      harness.close();
    }
  });
});