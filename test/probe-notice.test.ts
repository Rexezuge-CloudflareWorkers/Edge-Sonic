/**
 * The operator surface's diagnostic decisions.
 *
 * ### Why this test exists in the root suite
 *
 * `apps/web` is deliberately outside the coverage gate, and its own
 * `AGENTS.md` says so — but it also says that what is testable without a DOM
 * harness is exercised from here. Before this file, `rg "apps/web" test/`
 * returned nothing, so that sentence described a suite that did not exist. These
 * two modules are the parts of the SPA that carry decisions rather than markup,
 * and they are the parts that were wrong.
 *
 * ### The defect
 *
 * A probe against a live origin, with correct credentials, was reported to the
 * operator as "unreachable". Three things had to be true for that sentence to be
 * the only thing they saw, and all three are asserted against below:
 *
 * 1. The service returned one sentence for four different faults (`LibraryService`).
 * 2. The client collapsed the result to a boolean, so the server's classification
 *    was never read.
 * 3. The runner reported **success** for the failure, because a failed probe is an
 *    HTTP `200`.
 *
 * The third is why the fix is a return value rather than a thrown error: the
 * request genuinely did succeed. What failed is the thing the operator asked
 * about, and the two are different facts.
 */
import { describe, expect, it } from 'vitest';
import { describeProbe, describeScan } from '../apps/web/src/lib/probe';
import { toPatch } from '../apps/web/src/lib/libraryDraft';
import type { ProbeResult } from '../apps/web/src/types';

const LABELS = { reachable: 'Reachable.', probed: 'The origin answered.', failed: 'The probe failed.' };

const REJECTED_PASSWORD: ProbeResult = { ok: false, status: 401, error: 'The WebDAV username or password was rejected.' };
const MISSING_ROOT: ProbeResult = { ok: false, status: 404, error: 'The library root path does not exist on the WebDAV server.' };
const UNREACHABLE: ProbeResult = { ok: false, status: null, error: 'Library is unreachable.' };
const OK: ProbeResult = { ok: true, status: 207, error: null };

describe('describeProbe', () => {
  it('reports a rejection as an error, carrying the server’s own sentence', () => {
    // Verbatim, not a local mapping: the server knows more than a client-side table
    // can, and the same reason `extractError` passes an `Exception` message through.
    const presented = describeProbe(REJECTED_PASSWORD, LABELS);
    expect(presented.tone).toBe('error');
    expect(presented.label).toBe('The WebDAV username or password was rejected.');
    // `type: 'error'` is what earns `role="alert"` in `NoticeBar`. A failed probe
    // must interrupt, not be replaced by the next polite message.
    expect(presented.notice.type).toBe('error');
  });

  it('keeps a 401 and a 404 distinguishable', () => {
    // The whole reason the classification exists. One badge reading "unreachable"
    // sent an operator to debug their WebDAV server for a typo in the root path.
    expect(describeProbe(REJECTED_PASSWORD, LABELS).label).not.toBe(describeProbe(MISSING_ROOT, LABELS).label);
  });

  it('reports success without borrowing the failure wording', () => {
    const presented = describeProbe(OK, LABELS);
    expect(presented.tone).toBe('success');
    expect(presented.notice.type).toBe('success');
    // The badge is a verdict the row keeps showing; the notice is a one-shot
    // confirmation. They used to be one string, which is how a success notice ended
    // up reading "Probe finished." next to a failure badge.
    expect(presented.label).toBe(LABELS.reachable);
    expect(presented.notice.text).toBe(LABELS.probed);
  });

  it('falls back to a label rather than rendering an empty badge', () => {
    // `error: null` with `ok: false` is not a shape the server produces. A client
    // that renders `result.error` blindly would put nothing in the badge.
    expect(describeProbe({ ok: false, status: null, error: null }, LABELS).label).toBe(LABELS.failed);
  });

  it('gives the badge and the notice the same text, so they cannot disagree', () => {
    // The invariant, asserted over every shape rather than one example: the two are
    // derived from one result precisely so they cannot drift.
    for (const result of [OK, REJECTED_PASSWORD, MISSING_ROOT, UNREACHABLE]) {
      const presented = describeProbe(result, LABELS);
      expect(presented.notice.text).toBe(result.ok ? LABELS.probed : presented.label);
    }
  });
});

describe('describeScan', () => {
  it('surfaces the stored reason, which the server now sends on every status', () => {
    // `lastError` was declared optional on the wire type and never populated, so a
    // failed scan rendered the bare word "failed" while the reason sat unread in
    // `scan_state`.
    expect(describeScan('WebDAV PROPFIND https://dav.example.com/x responded 401.')).toMatch(/401/);
  });

  it('renders nothing for no error, rather than an empty error line', () => {
    for (const absent of [null, undefined, '', ' '.repeat(3)]) {
      expect(describeScan(absent)).toBeNull();
    }
  });
});

describe('toPatch', () => {
  const draft = {
    slug: 'home',
    baseUrl: 'https://dav.example.com',
    rootPath: '/Music',
    davUsername: 'ann',
    davPassword: '',
    displayName: 'Home',
  };

  it('omits an untouched password so an edit cannot destroy the stored credential', () => {
    // The server skips `setPassword` only when the field is absent. Sending `''`
    // would re-encrypt an empty password over a working one and break every future
    // scan, with nothing in the response to say so.
    expect('davPassword' in toPatch(draft)).toBe(false);
  });

  it('treats whitespace as untouched, not as a new password', () => {
    // A stray space in a password field is the likeliest accident, and it must not
    // be mistaken for a deliberate replacement.
    expect('davPassword' in toPatch({ ...draft, davPassword: ' '.repeat(3) })).toBe(false);
  });

  it('sends the password when one was actually typed', () => {
    expect(toPatch({ ...draft, davPassword: ' hunter2 ' }).davPassword).toBe('hunter2');
  });

  it('omits a blank display name rather than clearing the stored one', () => {
    expect('displayName' in toPatch({ ...draft, displayName: '' })).toBe(false);
  });

  it('trims the fields the server compares exactly', () => {
    const patch = toPatch({ ...draft, slug: ' home ', baseUrl: ' https://dav.example.com ', rootPath: ' /Music ', davUsername: ' ann ' });
    expect(patch).toMatchObject({ slug: 'home', baseUrl: 'https://dav.example.com', rootPath: '/Music', davUsername: 'ann' });
  });
});
