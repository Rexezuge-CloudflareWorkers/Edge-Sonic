/**
 * The SPA's two pure decision modules, and the error decoder between them.
 *
 * ### Why these and not the components
 *
 * `apps/web/AGENTS.md` is explicit that the coverage gate excludes `apps/web` deliberately
 * and that "excluded is not untested": a decision placed in a pure function under `lib/` is
 * testable from the root suite today, and `test/probe-notice.test.ts` does exactly that for
 * `lib/probe.ts` and `lib/libraryDraft.ts`.
 *
 * That rule was followed for the two modules with the *least* input surface. The two with
 * the most were not tested at all, and they are the ones that decide what an operator is
 * told when something goes wrong:
 *
 * - **`lib/api.ts`'s error decoder.** `apps/web/AGENTS.md` calls it out itself — "the error
 *   decoder matters more than it looks" — because it has to survive a Cloudflare Access
 *   login page arriving where JSON was expected, a body from either of the two error
 *   dialects, and a platform error page. Its output is the **only** thing in the notice bar
 *   when a probe or a rescan fails, so a wrong answer here is the whole diagnosis.
 * - **`describeStopReason` / `STOP_REASON_LABELS`.** Untouched by any test, so
 *   `apps/web/AGENTS.md`'s claim that all three are asserted was false — and it is the
 *   sentence that tells an operator which of two configuration knobs to raise.
 *
 * `describeProbe` and `describeScan` are asserted in `probe-notice.test.ts` and not repeated
 * here; the labels are **parameters** rather than imports by design ("translation is a
 * parameter, not an import"), so each test supplies its own and cannot assert against the
 * real bundle unless it reads it.
 */
import { describe, expect, it } from 'vitest';
import { BackendError } from '../apps/web/src/lib/api';
import { describeStopReason, STOP_REASON_LABELS, PROBE_LABELS } from '../apps/web/src/lib/probe';

/**
 * The decoder is not exported — `apiGet` is its only door — so it is reached the way the
 * app reaches it: through a `fetch` that returns a chosen response. That is also the shape
 * the failures take, so nothing is stubbed that production does not also do.
 */
async function decode(response: Response): Promise<{ message: string; type: string | null; status: number }> {
  const original = fetch;
  globalThis.fetch = async () => response;
  try {
    await apiGetJson('/probe');
    throw new Error('expected the decoder to reject');
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    return { message: error.message, type: error.errorType, status: error.status };
  } finally {
    globalThis.fetch = original;
  }
}

async function apiGetJson(path: string): Promise<unknown> {
  const { apiGet } = await import('../apps/web/src/lib/api');
  return await apiGet(path);
}

describe("lib/api.ts's error decoder", () => {
  it('reads the `{Exception:{Type,Message}}` dialect the user API speaks', async () => {
    const decoded = await decode(
      Response.json({ Exception: { Type: 'Conflict', Message: 'The slug is already in use.' } }, { status: 409, headers: { 'content-type': 'application/json' } }),
    );
    expect(decoded).toEqual({ message: 'The slug is already in use.', type: 'Conflict', status: 409 });
  });

  it('reads the `{error:{code,message}}` dialect the reference project used', async () => {
    // Both dialects are still accepted on purpose — "during the transition" is in the
    // docstring, and a deployment mid-migration sends both. Accepting only the current one
    // would turn every old error into "Request failed with status N".
    const decoded = await decode(
      Response.json({ error: { code: 'NotFound', message: 'Library not found.' } }, { status: 404, headers: { 'content-type': 'application/json' } }),
    );
    expect(decoded).toEqual({ message: 'Library not found.', type: null, status: 404 });
  });

  it('prefers `Exception.Message` over the legacy body, so the newer dialect wins when both are present', async () => {
    const decoded = await decode(
      Response.json({ Exception: { Type: 'BadRequest', Message: 'newer' }, error: { message: 'older' } }, { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    expect(decoded.message).toBe('newer');
  });

  it('survives a body that is not JSON at all, which is what an Access login page is', async () => {
    // The most important case, and the one a decode-and-assert test on the happy path can
    // never reach. Behind Cloudflare Access, an expired session answers `200 text/html` with
    // a login form. `response.json()` throws on it, and a decoder that only caught that to
    // re-throw would render an operator a JSON parse error instead of "your session
    // expired" — or a blank notice bar.
    const decoded = await decode(new Response('<!doctype html><title>Access</title>', { status: 401, headers: { 'content-type': 'text/html' } }));
    // Markup is **refused**, not quoted: pasting a login form into the notice bar reads as
    // the app rendering garbage. What the operator needs is the status, and that the
    // answer did not come from this API.
    expect(decoded.message).toBe('Request failed with status 401.');
    expect(decoded.status).toBe(401);
    // And it is **not** silently empty: a notice bar with a blank message is the one thing
    // an operator cannot act on.
    expect(decoded.message.trim().length).toBeGreaterThan(0);
  });

  it('shows a plain-text body, because that is a message a server can legitimately send', async () => {
    // The other half of the previous case. A body that is prose and not markup is what a
    // misconfigured reverse proxy sends, and it usually names the actual fault — so
    // refusing every non-JSON body would throw away the only useful thing in the response.
    //
    // This is the branch `response.json()` + `response.text()` could never reach: `json()`
    // consumes the body, so the fallback read `''` and reported the generic sentence for
    // every one of these.
    const decoded = await decode(new Response('upstream connect error or disconnect/reset before headers', { status: 502, headers: { 'content-type': 'text/plain' } }));
    expect(decoded.message).toBe('upstream connect error or disconnect/reset before headers');
    expect(decoded.status).toBe(502);
  });

  it('falls back to a sentence naming the status when the body says nothing usable', async () => {
    // An HTML error page that happens to be empty, and a JSON body with neither a message
    // nor a type. Both must still produce something a person can read.
    const empty = await decode(new Response('', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(empty.message).toBe('Request failed with status 502.');

    const bare = await decode(Response.json({ unrelated: true }, { status: 500, headers: { 'content-type': 'application/json' } }));
    expect(bare.message).toBe('Request failed with status 500.');
    expect(bare.type).toBeNull();
  });

  it('uses a type on its own when there is no message, so the category survives', async () => {
    const decoded = await decode(Response.json({ Exception: { Type: 'RateLimited' } }, { status: 429, headers: { 'content-type': 'application/json' } }));
    expect(decoded).toEqual({ message: 'RateLimited (HTTP 429)', type: 'RateLimited', status: 429 });
  });

  it('bounds a very long message, because a 5xx body can be a whole page', async () => {
    // A masked 5xx from the server is short, but a proxy's HTML error page is not, and a
    // multi-kilobyte string in a notice bar pushes every control off screen.
    const decoded = await decode(Response.json({ Exception: { Message: 'x'.repeat(5000) } }, { status: 500, headers: { 'content-type': 'application/json' } }));
    expect(decoded.message.length).toBeLessThan(1000);
  });

  it('treats an empty message as absent rather than rendering nothing', async () => {
    // `Message: ''` reaches here from a server that stringifies a null. Rendering the empty
    // string would give the operator a notice bar with no text in it, which reads as the
    // app being broken rather than the request having failed.
    const decoded = await decode(Response.json({ Exception: { Type: 'BadRequest', Message: '' } }, { status: 400, headers: { 'content-type': 'application/json' } }));
    expect(decoded.message).toBe('BadRequest (HTTP 400)');
  });

  it('carries the status, which is the one part of the answer a client acts on', async () => {
    // `BackendError.status` was unused — no accessor and no caller — while the SPA branched
    // on nothing to tell a 401 (re-authenticate) from a 409 (fix the slug) from a 500 (retry
    // later). The field existed and was unreachable, which is the "wired is not called"
    // shape one layer below this.
    const decoded = await decode(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    expect(decoded.status).toBe(503);
  });
});

describe('describeStopReason', () => {
  it('is silent when no bound stopped the chunk', () => {
    // `null` is the "say nothing" answer and is why the component renders `{scanPaused !== null && …}`.
    // Three spellings, because a read-only status **omits** the field entirely and
    // `undefined` is what an absent key gives — and `'frontier'` is the fourth: the chunk
    // ran out of folders, which is not a bound and must not be described as one.
    expect(describeStopReason(undefined)).toBeNull();
    expect(describeStopReason(null)).toBeNull();
    expect(describeStopReason('frontier')).toBeNull();
  });

  it('names the request ceiling without telling an operator to raise a knob that cannot help', () => {
    const sentence = describeStopReason('requests', STOP_REASON_LABELS);
    expect(sentence).toBe(STOP_REASON_LABELS.requests);

    // It used to say "Raise SCAN_CHUNK_MAX_REQUESTS to index more per poll", and that was
    // **wrong on the plan this deployment runs**. Workers Free allows 50 subrequests per
    // invocation and does not raise it from the wrangler config; the server clamps the value to
    // what fits; and a chunk that spends more is terminated by the runtime rather than slowed.
    // So the advice walked an operator into a scan that could not finish at all — and the
    // sentence was asserted to *contain the knob*, which made the harmful advice the contract.
    //
    // The sentence still has to be actionable, so it says the two things that are true: this is
    // the plan's limit rather than a fault, and the scan is still advancing.
    expect(sentence).not.toContain('SCAN_CHUNK_MAX_REQUESTS');
    expect(sentence).toMatch(/limit/i);
    expect(sentence).toMatch(/continues|still/i);
  });

  it('names the deadline separately, because the two have different remedies', () => {
    const sentence = describeStopReason('deadline', STOP_REASON_LABELS);
    expect(sentence).toBe(STOP_REASON_LABELS.deadline);
    expect(sentence).toContain('SCAN_CHUNK_DEADLINE_MS');
    // And the two are genuinely different sentences — a bound that reported one cause for
    // both would send the operator to raise the wrong number.
    expect(sentence).not.toBe(STOP_REASON_LABELS.requests);
  });

  it('takes its labels as a parameter, so translation is not an import', () => {
    // The module's own rule: "translation is a parameter, not an import". Asserted here
    // because it is the thing that lets this test avoid i18next — and because a badge that
    // forgets the parameter (as `LibraryRow` did for its notice) renders English in the
    // one place the surrounding text is translated.
    const labels = { requests: 'Requests.', deadline: 'Time.' };
    expect(describeStopReason('requests', labels)).toBe('Requests.');
    expect(describeStopReason('deadline', labels)).toBe('Time.');
  });

  it('does not reach for PROBE_LABELS by mistake', () => {
    // Two label maps, one module. Passing the wrong one is a type error today and would
    // render "The probe failed." under a scan that did not fail.
    expect(Object.keys(PROBE_LABELS).sort()).toEqual(['failed', 'probed', 'reachable']);
    expect(Object.keys(STOP_REASON_LABELS).sort()).toEqual(['deadline', 'requests']);
  });
});