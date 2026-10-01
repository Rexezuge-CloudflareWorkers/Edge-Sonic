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
import { createHarness, subsonicId } from './helpers/harness';
import { EMPTY_RESULT, ENDPOINT_NAMES, ENDPOINTS, PLAIN_TEXT_BODIES, UNIMPLEMENTED } from '../apps/api/src/rest/endpoints';

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
    // A name in two maps is routed by whichever was assigned last and reported by neither.
    // The keys are unique objects in JS, so the check has to be across the maps — and
    // `EMPTY_RESULT` counts. Five names sat in both `UNIMPLEMENTED` and `EMPTY_RESULT` when
    // that table was introduced, and nothing failed: the overlap test existed and did not
    // look there, so a name in two maps was as invisible as a name in none.
    const implemented = Object.keys(ENDPOINTS);
    const overlap = (a: readonly string[], b: readonly string[]): string[] => a.filter((name) => b.includes(name));
    expect(overlap(implemented, unimplementedNames())).toEqual([]);
    expect(overlap(implemented, Object.keys(EMPTY_RESULT))).toEqual([]);
    // And the two tables that say opposite things about the same endpoint.
    expect(overlap(unimplementedNames(), Object.keys(EMPTY_RESULT))).toEqual([]);
  });

  it('gives every endpoint that answers an empty wrapper a reason too', () => {
    // The client cannot tell "nothing to report" from "I have no such integration" — both
    // arrive as an empty wrapper — so the reason exists only here, and an entry without one
    // is indistinguishable from a placeholder.
    for (const [name, entry] of Object.entries(EMPTY_RESULT)) {
      expect(entry.reason.trim().length, `${name} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('publishes a name for every declared endpoint, and nothing else', () => {
    // `ENDPOINT_NAMES` is what `endpointNameFromPath` dispatches on, so a missing name is
    // an endpoint a client cannot reach and an extra one is a path that answers a failure
    // while claiming to be implemented. `EMPTY_RESULT` counts: those endpoints route through
    // the same proxy and would otherwise be unreachable.
    const declared = [...Object.keys(ENDPOINTS), ...Object.keys(UNIMPLEMENTED), ...Object.keys(EMPTY_RESULT)].sort((a, b) => a.localeCompare(b));
    expect([...ENDPOINT_NAMES].sort((a, b) => a.localeCompare(b))).toEqual(declared);
    // And no duplicates: a name listed twice would let a second, unreachable route share a
    // first one's identity.
    expect(new Set(ENDPOINT_NAMES).size).toBe(ENDPOINT_NAMES.length);
  });

  it('gives every absent endpoint a reason, because the reason is what an operator is shown', () => {
    for (const [name, entry] of Object.entries(UNIMPLEMENTED)) {
      // Non-empty and specific. An empty string is what a placeholder entry carries, and it
      // is the kind of entry that cannot be told from a deliberate one.
      expect(entry.reason.trim().length, `${name} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('answers each absent endpoint with the contract its kind promises', async () => {
    // The four kinds, asserted per endpoint rather than once for the whole map.
    //
    // This used to be a single assertion that every entry answered `code=70`, which is the
    // assertion that made the distinction invisible: one code for four different situations
    // means the registry could not say whether an endpoint was retired, unbuilt,
    // unauthorized, or merely unintegrated, and nothing failed when one of those changed.
    const harness = await createHarness();
    try {
      const wrong: string[] = [];
      for (const name of unimplementedNames()) {
        const kind = UNIMPLEMENTED[name].kind;
        const response = await harness.fetch(harness.restUrl(name));

        if (kind === 'gone' || kind === 'not-implemented') {
          // Outside the envelope, deliberately. A `code=70` envelope is a *protocol* answer
          // to "give me this" and invites the client to report a server error; a status says
          // the endpoint is retired, and the client can stop asking. Navidrome draws this
          // line identically.
          const expected = kind === 'gone' ? 410 : 501;
          if (response.status !== expected) wrong.push(`${name}: status ${response.status}, wanted ${expected}`);
          if (!(response.headers.get('content-type') ?? '').includes('text/plain')) wrong.push(`${name}: not text/plain`);
          // Verbatim, so an operator reading a log sees the phrasing they know.
          const text = await response.text();
          if (text !== PLAIN_TEXT_BODIES[kind].body) wrong.push(`${name}: body differs from the reference wording`);
          continue;
        }

        // The two envelope kinds stay 200, which is the protocol dialect: there is no non-200
        // for a protocol error, so the code is the only signal.
        if (response.status !== 200) wrong.push(`${name}: status ${response.status}, wanted 200`);
        const envelope = ((await response.json()) as Record<string, Record<string, unknown>>)['subsonic-response'];
        const code = (envelope.error as { code?: number } | undefined)?.code;
        const wanted = kind === 'not-authorized' ? 50 : ABSENT;
        if (code !== wanted) wrong.push(`${name}: code=${String(code)}, wanted ${wanted}`);
      }
      // One assertion rather than a loop of them, so the failure names every offender.
      expect(wrong).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it('answers the endpoints that exist with an empty wrapper, never a failure', async () => {
    // `getLyrics`, `getArtistInfo`, `getTopSongs`, `getShares` and the radio listing were
    // all `code=70`. Each of them is an endpoint a client calls routinely — `getLyrics` on
    // every track, `getShares` on every dashboard — and `code=70` told it the server had
    // failed where the truth is that there is nothing to report. This is the same mistake
    // `getOpenSubsonicExtensions` was removed from this list for.
    //
    // The wrapper is present and carries no items: `{"lyrics":{}}`, not an error and not an
    // absent payload, so a client can tell "nothing to report" from "not implemented".
    const harness = await createHarness();
    try {
      const wrong: string[] = [];
      for (const [name, entry] of Object.entries(EMPTY_RESULT)) {
        // A valid request wherever one is needed: an id the endpoint can resolve, plus any
        // parameter it declares required. Calling these bare asserts `code=10` or `code=70`
        // and proves nothing about the wrapper — which is a different test, below.
        const id: Record<string, string> =
          entry.idKinds === null ? {} : { id: subsonicId(entry.idKinds[0] as 's', 'Bon Iver/For Emma, Forever Ago/01 - Skinny Love.flac') };
        const request = { ...id, ...Object.fromEntries(entry.requiredParams.map((param) => [param, 'Bon Iver'])) };
        const { status, body } = await harness.rest(name, request);
        if (status !== 200) {
          wrong.push(`${name}: status ${status}`);
          continue;
        }
        const envelope = body['subsonic-response'] as Record<string, unknown>;
        if (envelope.error) {
          wrong.push(`${name}: answered ${JSON.stringify(envelope.error)}`);
          continue;
        }
        // Under the declared `wrapper`, **not** the endpoint name. Six of the seven differ,
        // and looking under `name` is precisely how a payload arriving under the wrong
        // element goes unnoticed: the endpoint answers 200 and the client's field is simply
        // absent, which reads as "no data" rather than "wrong key".
        const wrapper = envelope[entry.wrapper];
        if (!wrapper || typeof wrapper !== 'object') wrong.push(`${name}: no ${entry.wrapper} wrapper`);
        // Present and empty. A wrapper carrying items would mean the endpoint answered
        // something, which for these is the one thing it must not do silently.
        else if (Object.keys(wrapper as Record<string, unknown>).length > 0) wrong.push(`${name}: wrapper is not empty`);
      }
      expect(wrong).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it('refuses a request it cannot act on, rather than answering "nothing to report"', async () => {
    // The half that pairs with the wrapper test, and the reason `idKinds` and `requiredParams`
    // are declared at all. `getLyricsBySongId?id=x` asks for the lyrics of a song that does
    // not exist, which is a different claim from "this song has no lyrics" — and the first is
    // an error the client can act on by fixing its request.
    //
    // Navidrome draws the line here: it validates, and *then* answers empty. Both halves are
    // asserted because either alone passes for an implementation that always refuses or one
    // that never does.
    const harness = await createHarness();
    try {
      for (const [name, entry] of Object.entries(EMPTY_RESULT)) {
        if (entry.idKinds !== null) {
          // Present but unresolvable: `code=70`.
          const unresolvable = await harness.rest(name, { ...Object.fromEntries(entry.requiredParams.map((p) => [p, 'Bon Iver'])), id: 'not-an-id' });
          expect(unresolvable.status, `${name} must answer 200 in the envelope`).toBe(200);
          expect((unresolvable.body['subsonic-response'] as Record<string, unknown>).error, name).toMatchObject({ code: 70 });
        }
        // Absent entirely: `code=10`, one level up — a required parameter was not sent.
        const absent = await harness.rest(name);
        if (entry.idKinds !== null || entry.requiredParams.length > 0) {
          expect((absent.body['subsonic-response'] as Record<string, unknown>).error, `${name} bare`).toMatchObject({ code: 10 });
        } else {
          // Nothing is required, so a bare request is a real one and gets the empty answer.
          expect((absent.body['subsonic-response'] as Record<string, unknown>)[entry.wrapper], name).toEqual({});
        }
      }
    } finally {
      harness.close();
    }
  });

  it('answers with the reason and nothing else, so an absent endpoint is not a probe', async () => {
    // `getOpenSubsonicExtensions` is the one endpoint answered **without credentials**,
    // which is safe only because its payload is a compile-time constant. Everything else in
    // the registry is authenticated first, so an absent endpoint has already proved the
    // caller is valid — and could still answer with the caller's own identity, a library's,
    // or a version detail, which turns "not implemented" into a way to read the deployment's
    // data.
    //
    // The assertion is on the **exact key set**, not on a substring. An earlier version
    // searched the body for the username and reported `createPodcastChannel` as a leak,
    // because "Ch*ann*el" contains it: a substring check over real prose finds coincidences
    // and proves nothing.
    //
    // Only the two envelope kinds are in scope. The plain-text bodies disclose nothing by
    // construction, which is the point of them.
    const harness = await createHarness();
    try {
      for (const name of unimplementedNames()) {
        const kind = UNIMPLEMENTED[name].kind;
        if (kind !== 'absent' && kind !== 'not-authorized') continue;

        const { body } = await harness.rest(name);
        const envelope = body['subsonic-response'] as Record<string, unknown>;
        const error = envelope.error as Record<string, unknown>;

        // `code` and `message`, and nothing else. A new attribute here is a new thing an
        // absent endpoint discloses, so it fails this rather than needing review.
        expect(Object.keys(error).map((key) => key).sort(), `${name} error shape`).toEqual(['code', 'message']);

        // The envelope carries only the fixed server identity. `version` is the protocol
        // version every response carries, so it is not a disclosure; a user, a library or a
        // path would be.
        expect(Object.keys(envelope).map((key) => key).sort(), `${name} envelope shape`).toEqual(
          ['error', 'openSubsonic', 'serverVersion', 'status', 'type', 'version'].sort(),
        );
      }
    } finally {
      harness.close();
    }
  });
});