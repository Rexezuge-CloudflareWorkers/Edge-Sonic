// @vitest-environment jsdom
/**
 * The library page as an operator sees it: the scan badge, the track count, and the poll that
 * keeps them current.
 *
 * ### Why this needs a DOM and is still worth asserting
 *
 * The scan state lives on the component now — `library.scan`, carried by the list response —
 * so **no server test can see this defect**. Everything in `test/user-api.test.ts` asserts what
 * the server *sends*; nothing there asserts that a page load renders it. And the defect was
 * exactly that gap: the row held scan state in `useState(null)` set only by the rescan handler,
 * so a library being scanned by the background worker rendered with no scan line at all, on a
 * green server suite, because the server had been answering correctly the whole time.
 *
 * The same class as the gate in `test/web-landing.test.tsx`: `useCurrentUser`'s contract there
 * was "set `authorized: false`", and whether anything read it was invisible to every test that
 * existed. Here the contract is "the list carries `scan`", and whether anything renders it is
 * invisible to every server test that exists.
 *
 * ### Why the poll is tested rather than the fetch
 *
 * `poll` is the reason this page works unattended. It is also the thing that can quietly spend
 * an operator's rate-limit budget for ever, so both directions are asserted: it fires while
 * something is advancing, and it **stops**. A guard with only the first half is a timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LibrariesView } from '../apps/web/src/views/LibrariesView';
import { AppHeader } from '../apps/web/src/components/layout/AppHeader';
import { SCAN_POLL_INTERVAL_MS } from '../apps/web/src/lib/constants';
import '../apps/web/src/i18n';

interface LibraryWire {
  id: string;
  slug: string;
  displayName: string | null;
  baseUrl: string;
  rootPath: string;
  davUsername: string;
  isEnabled: boolean;
  songCount: number;
  scan: { status: 'idle' | 'scanning' | 'failed' | 'stalled'; scanned: number; lastError: string | null } | null;
  createdAt: number;
}

function library(overrides: Partial<LibraryWire> = {}): LibraryWire {
  return {
    id: 'L1',
    slug: 'home',
    displayName: 'Home',
    baseUrl: 'https://dav.example.com',
    rootPath: '/remote.php/dav/files/alice/Music',
    davUsername: 'alice',
    isEnabled: true,
    songCount: 0,
    scan: null,
    createdAt: 0,
    ...overrides,
  };
}

/**
 * Serve the library list, and record how many times it was asked for.
 *
 * `responder` is re-read on every call so a test can change the answer mid-run — which is the
 * only way the "stops polling" case can be expressed, because stopping is a consequence of a
 * *later* response than the one that started it.
 */
/**
 * The URL of a request the app made.
 *
 * `fetch` takes a `Request`, a string or a `URL`, and `String(...)` on any of them is
 * `[object Object]` for the first — which would make every "unexpected request" guard below
 * compare against that string and pass for the wrong reason. `lib/api.ts` builds its URLs as
 * strings, so that is the one shape asserted here.
 */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function stubList(responder: () => LibraryWire[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (!url.includes('/user/libraries')) throw new Error(`unexpected request: ${url}`);
    return Response.json({ libraries: responder() }, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const listCalls = (fetchMock: ReturnType<typeof stubList>): number => fetchMock.mock.calls.length;

function renderView() {
  return render(
    <MemoryRouter>
      <LibrariesView showNotice={() => undefined} />
    </MemoryRouter>,
  );
}

/**
 * Advance past one poll interval and let the resulting state updates land.
 *
 * `act` around the clock advance rather than around the interval alone: the timer callback
 * starts an async fetch, and its `setState` lands on a later microtask, so advancing the clock
 * outside `act` produces exactly the React warning this file would otherwise be asserting past.
 */
async function tick(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCAN_POLL_INTERVAL_MS);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the scan state an operator can see', () => {
  it('says a library has never been scanned, on first load and with no click', async () => {
    // The headline. `scan: null` is what the server sends for a library with no `scan_state`
    // row, and the row used to render nothing at all in that case — the state it did render
    // came from a `useState` only the Rescan button wrote. A library nobody has scanned is the
    // one row on this page the operator has to act on.
    stubList(() => [library({ scan: null })]);
    renderView();
    expect(await screen.findByText('Not scanned yet.')).toBeTruthy();
    // And it is not reported as a finished scan, and not as a measurement of zero.
    expect(screen.queryByText('Up to date.')).toBeNull();
    expect(screen.queryByText('0 tracks indexed')).toBeNull();
  });

  it('shows the indexed track count and the scanning status together', async () => {
    // The number is the whole point of watching a scan, and it is the figure `getScanStatus`
    // publishes as `count` — the same unit a Subsonic client reads for the same library.
    stubList(() => [library({ songCount: 412, scan: { status: 'scanning', scanned: 7, lastError: null } })]);
    renderView();
    expect(await screen.findByText('Scanning.')).toBeTruthy();
    expect(screen.getByText('412 tracks indexed')).toBeTruthy();
  });

  it('reports a failed scan as retrying, and shows the reason the server stored', async () => {
    // Both halves. The word alone says "working on it", which is true; the reason is what
    // tells the operator whether their password is wrong, and it lives in `scan_state`.
    stubList(() => [library({ scan: { status: 'failed', scanned: 3, lastError: 'the origin refused the connection' } })]);
    renderView();
    expect(await screen.findByText('Retrying after an error.')).toBeTruthy();
    expect(screen.getByText('the origin refused the connection')).toBeTruthy();
  });

  it('names the action for a stalled scan, which nothing else will do', async () => {
    // A stalled scan is terminal: the retry budget is spent and no alarm is scheduled. The
    // label has to say so, because "Retrying after an error." beside a library that will
    // never retry again is the page telling the operator the server is working on it.
    stubList(() => [library({ scan: { status: 'stalled', scanned: 3, lastError: 'credentials rejected' } })]);
    renderView();
    expect(await screen.findByText('Stopped retrying. Fix the cause, then rescan.')).toBeTruthy();
    expect(screen.queryByText('Retrying after an error.')).toBeNull();
  });
});

describe('polling', () => {
  it('re-reads the list while a scan is advancing, and the number it shows moves', async () => {
    // Not just "a second request happened" — the *rendered* count changes, because a poll that
    // fires but does not update the page is a timer and a lie.
    let tracks = 10;
    stubList(() => [library({ songCount: tracks, scan: { status: 'scanning', scanned: 2, lastError: null } })]);
    renderView();
    expect(await screen.findByText('10 tracks indexed')).toBeTruthy();

    tracks = 55;
    await tick(1);
    expect(await screen.findByText('55 tracks indexed')).toBeTruthy();
  });

  it('stops polling once nothing is advancing', async () => {
    // The paired guard, and the half that costs money rather than correctness. `/user/*` is
    // limited to 60 requests a minute keyed on the Access identity — the same bucket probe and
    // rescan spend — so a timer that never stops spends the budget an operator needs for the
    // actions they actually want to take.
    let scan = library({ songCount: 4, scan: { status: 'scanning', scanned: 1, lastError: null } });
    const fetchMock = stubList(() => [scan]);
    renderView();
    await screen.findByText('4 tracks indexed');
    await tick(1);

    // The scan finishes — on the server, between polls.
    scan = library({ songCount: 40, scan: { status: 'idle', scanned: 9, lastError: null } });
    await tick(1);
    expect(await screen.findByText('40 tracks indexed')).toBeTruthy();

    const settled = listCalls(fetchMock);
    await tick(3);
    expect(listCalls(fetchMock)).toBe(settled);
  });

  it('does not poll a page whose libraries are all idle', async () => {
    // The same guard from the other end: nothing ever started the timer, so a page of
    // finished libraries costs exactly one request however long it is left open.
    const fetchMock = stubList(() => [library({ songCount: 2, scan: { status: 'idle', scanned: 9, lastError: null } })]);
    renderView();
    await screen.findByText('2 tracks indexed');
    await tick(3);
    expect(listCalls(fetchMock)).toBe(1);
  });

  it('does not poll a library that has never been scanned', async () => {
    // The `null` case, which is the easiest to forget when the guard is written as
    // `status === 'scanning'`. A newly registered library would otherwise be polled forever to
    // learn that it has still never been scanned — the emptiest request this page can make,
    // and the most common state a new deployment is in.
    const fetchMock = stubList(() => [library({ scan: null })]);
    renderView();
    await screen.findByText('Not scanned yet.');
    await tick(3);
    expect(listCalls(fetchMock)).toBe(1);
  });

  it('keeps the list on screen when a poll fails, and says the numbers are stale', async () => {
    // A poll runs unattended, so folding its failure into the documented "empty list plus a
    // notice" would blank the page out from under an operator reading it — turning a list of
    // four libraries into "No libraries yet", which is the one sentence on this page that means
    // something is genuinely absent.
    let failing = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (failing) throw new TypeError('fetch failed');
      const url = requestUrl(input);
      if (!url.includes('/user/libraries')) throw new Error(`unexpected request: ${url}`);
      return Response.json(
        { libraries: [library({ songCount: 88, scan: { status: 'scanning', scanned: 4, lastError: null } })] },
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderView();
    expect(await screen.findByText('88 tracks indexed')).toBeTruthy();

    failing = true;
    await tick(1);

    // Still there, and marked as not current.
    await waitFor(() => expect(screen.getByText(/Showing the last known state/)).toBeTruthy());
    expect(screen.getByText('88 tracks indexed')).toBeTruthy();
    expect(screen.queryByText('No libraries yet')).toBeNull();
  });

  it('does not overlap polls when one response is slower than the interval', async () => {
    // A boolean in component state would be one render behind, which is exactly long enough
    // for two intervals to fire before the first response lands. Against a 60/minute bucket the
    // cost of a slow response is several requests spent re-reading an answer already in flight.
    let release: (() => void) | null = null;
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls > 1) {
        // Every poll after the first hangs until the test releases it, so a second in-flight
        // request would be visible as `calls` climbing without the first ever settling.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return Response.json(
        { libraries: [library({ songCount: 3, scan: { status: 'scanning', scanned: 1, lastError: null } })] },
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderView();
    await screen.findByText('3 tracks indexed');
    await tick(5);

    expect(calls).toBe(2); // the first load, plus exactly one in-flight poll
    await act(async () => {
      release?.();
    });
  });
});

describe('the header', () => {
  it('shows the operator identity only to a signed-in caller', async () => {
    // The landing page rendered the literal word "Operator" in the top right for every
    // anonymous visitor, because the chip was `userEmail ?? 'Operator'` — a fallback string
    // standing in for an identity the page did not have. The page was asserting who was looking
    // at it, for somebody who had not signed in.
    const { unmount } = render(
      <MemoryRouter>
        <AppHeader userEmail={null} signedIn={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Operator')).toBeNull();
    unmount();

    render(
      <MemoryRouter>
        <AppHeader userEmail="operator@example.com" signedIn={true} />
      </MemoryRouter>,
    );
    expect(screen.getByText('operator@example.com')).toBeTruthy();
  });

  it('shows nothing while the session is still resolving', async () => {
    // The paired case. `null` is neither signed in nor signed out, and the router is covering
    // these frames with a full-page spinner — so the chip flashing in and out here is noise on
    // top of a spinner nobody is reading.
    render(
      <MemoryRouter>
        <AppHeader userEmail={null} signedIn={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Operator')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('renders the brand once, with one separator', async () => {
    // `brand.rest` held `"-Sonic"` while this markup rendered its own `-` between two spans,
    // so the header read `Edge--Sonic`. Every individual surface was defensible — the bundle
    // had one well-formed key, the inline default said "Sonic", the markup was correct — which
    // is why `scripts/i18n/validate_locales.ts` now compares each default against the bundle. This
    // is the render-level assertion that the separator is markup and not vocabulary.
    render(
      <MemoryRouter>
        <AppHeader userEmail="operator@example.com" signedIn={true} />
      </MemoryRouter>,
    );
    const brand = screen.getByRole('link', { name: /Edge/ });
    expect(brand.textContent).toBe('Edge-Sonic');
  });
});
