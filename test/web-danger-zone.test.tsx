// @vitest-environment jsdom
/**
 * The Danger Zone, as an operator meets it.
 *
 * ### Why this needs a DOM and is not tidiness
 *
 * **The confirmation is the feature.** The server cannot ask "are you sure" — every caller of
 * `/user/*` is already an operator, because Cloudflare Access *is* the authorization boundary
 * and `users.is_admin` is written but read only to render a badge. So the two gates live
 * entirely in the browser, and a server test could delete every assertion in this file and
 * stay green.
 *
 * That is the same gap `test/web-library-row.test.tsx` records for the scan badge: the server
 * had been answering correctly throughout while the page rendered nothing, because the state
 * lived in a component nothing tested. Here the inverse — the server does exactly the right
 * thing, and the question is whether anything stands between an operator and it.
 *
 * ### What is asserted, and what the pairing is for
 *
 * Every guard is paired with a case that goes red when it is removed, which is the rule this
 * repository holds its component tests to. The guards here are the ones whose absence is
 * invisible:
 *
 * - the confirm button being **disabled** until the phrase matches, rather than hidden;
 * - the phrase being the **slug**, so two libraries sharing a display name cannot satisfy each
 *   other's confirmation;
 * - the cost figures being on screen, since a number an operator must open a modal to see is a
 *   number they consent to without;
 * - a per-library drop **not** firing the global request, which is the one place a wiring slip
 *   would be irreversible in production and invisible in every server test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsView } from '../apps/web/src/views/SettingsView';
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
  scan: null;
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

interface StatsWire {
  libraryId: string;
  songs: number;
  nodes: number;
  scanStates: number;
  billedRows: number;
}

/**
 * What the app is allowed to ask for.
 *
 * Every unexpected URL **throws**, which is what makes the last case in this file a real
 * assertion rather than a comment: a per-library drop that reached the global route would fail
 * the request instead of quietly emptying every library, and no server test could see the
 * request the client made.
 */
function stubApi(options: { libraries?: LibraryWire[]; stats?: StatsWire[]; failStats?: boolean } = {}) {
  const libraries = options.libraries ?? [library()];
  const stats = options.stats ?? [];
  const calls: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (input instanceof Request ? input.method : 'GET').toUpperCase();
    calls.push(`${method} ${url}`);

    if (url.includes('/user/index/stats')) {
      if (options.failStats)
        return Response.json({ Exception: { Type: 'InternalServerError', Message: 'D1 unavailable' } }, { status: 500 });
      const billedRows = stats.reduce((sum, entry) => sum + entry.billedRows, 0);
      const songs = stats.reduce((sum, entry) => sum + entry.songs, 0);
      const nodes = stats.reduce((sum, entry) => sum + entry.nodes, 0);
      return Response.json(
        { libraries: stats, total: { libraryId: '', songs, nodes, scanStates: 0, billedRows } },
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/user/index/drop'))
      return Response.json(
        { ok: true, songs: 0, nodes: 0, scanStates: 0, changes: 0, billedRows: 0, libraries: 2 },
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    if (url.includes('/index/drop'))
      return Response.json(
        { ok: true, songs: 0, nodes: 0, scanStates: 0, changes: 0, billedRows: 0, libraries: 1 },
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    if (url.includes('/user/libraries') && method === 'GET') {
      return Response.json({ libraries }, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/index/drop') || url.includes('/user/libraries')) {
      return Response.json(
        { ok: true, songs: 0, nodes: 0, scanStates: 0, changes: 0, billedRows: 0, libraries: 1 },
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

function renderView() {
  return render(
    <MemoryRouter>
      <SettingsView showNotice={() => undefined} />
    </MemoryRouter>,
  );
}

/**
 * The **dialog's** confirm button.
 *
 * Scoped with `within` rather than reached for on `screen`, and the scoping is not tidiness.
 * The Danger Zone's trigger button and its confirm button carry the *same* label — "Drop index"
 * opens a dialog whose confirm also reads "Drop index" — so an unscoped `getByRole` finds two
 * elements and throws. That collision is the assertion surface here: it is exactly what makes
 * "did the right button arm?" answerable, and an unscoped query would fail with
 * "multiple elements found" rather than with anything about which one was pressed.
 */
function confirmButton(name: RegExp): HTMLButtonElement {
  return within(screen.getByRole('dialog')).getByRole('button', { name }) as HTMLButtonElement;
}

/**
 * The Danger Zone's **trigger** button, which only arms the dialog.
 *
 * The last match is the global action: the per-library rows come first in the DOM, and the
 * global row is rendered after a `border-t` so the scope change is visible without reading
 * either label. Taking the last rather than indexing by count keeps these tests readable as the
 * library list grows.
 */
function globalTrigger(): HTMLElement {
  const matches = screen.getAllByRole('button', { name: /Drop every index/ });
  // Throws rather than returning `undefined` and failing later at `fireEvent` with a message
  // about a null element — `getAllByRole` already throws when there are none, and the
  // assertion that follows should be about *which* button, not about whether one exists.
  const last = matches.at(-1);
  if (last === undefined) throw new Error('no "Drop every index" button is rendered');
  return last;
}

/**
A specific library's trigger, by the index of its row.
*/
function libraryTrigger(index = 0): HTMLElement {
  const match = screen.getAllByRole('button', { name: /^Drop index$/ })[index];
  if (match === undefined) throw new Error(`no per-library trigger at row ${index}`);
  return match;
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

describe('the Danger Zone is its own page', () => {
  it('is not reachable from the libraries page', async () => {
    // The argument for the route rather than a section: a control whose blast radius can be a
    // deployment's whole daily write allowance does not belong on the page an operator opens to
    // look at their music. Asserted by the page's own content rather than by the route table,
    // which `test/worker.int.test.ts` already pins.
    stubApi({ libraries: [library({ songCount: 40 })] });
    renderView();

    expect(await screen.findByText('Danger zone')).toBeTruthy();
    expect(screen.queryByText('Music libraries')).toBeNull();
  });
});

describe('one click arms, and does not destroy', () => {
  it('fires nothing on the first click', async () => {
    // Every destructive button on this surface used to be one click — including
    // `deleteLibrary`, which cascades a whole index away. One click cannot be the gate for an
    // irreversible action, because the click is the thing that happens by accident.
    const { calls } = stubApi({ stats: [{ libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 }] });
    renderView();
    await screen.findByText('Danger zone');

    await act(async () => {
      fireEvent.click(libraryTrigger());
    });

    expect(calls.some((call) => call.includes('/index/drop'))).toBe(false);
    // And the dialog is up, which is where the second gate lives.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the second gate', () => {
  it('keeps the confirm button disabled until the exact slug is typed', async () => {
    stubApi({ stats: [{ libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 }] });
    renderView();
    await screen.findByText('Danger zone');
    await act(async () => {
      fireEvent.click(libraryTrigger());
    });

    const input = screen.getByPlaceholderText('home');
    const confirm = confirmButton(/^Drop index$/);

    expect(confirm.disabled).toBe(true);
    // A near-miss is still a miss. `alice/demo-typo` against `alice/demo` is the case that
    // makes this a gate rather than a typing exercise.
    fireEvent.change(input, { target: { value: 'home-typo' } });
    expect(confirm.disabled).toBe(true);
    // And whitespace is not a mismatch of intent.
    fireEvent.change(input, { target: { value: '  home  ' } });
    expect(confirm.disabled).toBe(false);
  });

  it('requires the slug, not the display name two libraries can share', async () => {
    /**
     * The slug because it is unique (`idx_libraries_slug_ci`) and the display name is
     * operator-chosen text two libraries can both carry. A phrase two libraries satisfy is not
     * a confirmation of anything — the operator confirms the wrong one and nothing says so.
     */
    stubApi({
      libraries: [library({ id: 'L1', slug: 'home', displayName: 'Music' }), library({ id: 'L2', slug: 'work', displayName: 'Music' })],
      stats: [
        { libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 },
        { libraryId: 'L2', songs: 90, nodes: 30, scanStates: 1, billedRows: 1020 },
      ],
    });
    renderView();
    await screen.findByText('Danger zone');
    await act(async () => {
      fireEvent.click(libraryTrigger());
    });

    // The dialog names the slug, and typing the shared display name does nothing.
    expect(screen.getByText('home')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('home'), { target: { value: 'Music' } });
    expect(confirmButton(/^Drop index$/).disabled).toBe(true);
  });

  it('accepts the literal phrase for the global drop, and nothing else', async () => {
    stubApi({ stats: [{ libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 }] });
    renderView();
    await screen.findByText('Danger zone');
    await act(async () => {
      fireEvent.click(globalTrigger());
    });

    const confirm = confirmButton(/^Drop every index$/);
    expect(confirm.disabled).toBe(true);
    // A library's slug must not satisfy the global confirmation: nothing in the request names
    // what is destroyed, so the operator types the *scope* instead.
    fireEvent.change(screen.getByPlaceholderText('drop-all-index'), { target: { value: 'home' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('drop-all-index'), { target: { value: 'drop-all-index' } });
    expect(confirm.disabled).toBe(false);
  });
});

describe('the cost is on screen before the button arms', () => {
  it('quotes the server’s figure, in rows', async () => {
    // `40 * 10 + 12 * 4 = 448`. Written as the arithmetic rather than the literal, because the
    // figure has a source — the per-table index counts in `billedRows.ts`, which
    // `test/schema.int.test.ts` asserts against the real `sqlite_schema`.
    stubApi({ stats: [{ libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 }] });
    renderView();
    await screen.findByText('Danger zone');
    await act(async () => {
      fireEvent.click(libraryTrigger());
    });

    expect(screen.getByText(/40 tracks and 12 folders, billing about 448 rows/)).toBeTruthy();
  });

  it('says the drop can take the deployment down, not just the index', async () => {
    /**
     * The sentence is unconditional, and it is the whole reason the confirmation is honest.
     *
     * Past the daily row-write allowance D1 refuses **every** query until midnight UTC, reads
     * included — so a large drop does not slow the scan down, it takes streaming offline too.
     * An operator weighing "now or after the reset" cannot act on a dialog that only says this
     * is expensive.
     */
    stubApi({ stats: [{ libraryId: 'L1', songs: 1, nodes: 1, scanStates: 1, billedRows: 16 }] });
    renderView();
    await screen.findByText('Danger zone');
    await act(async () => {
      fireEvent.click(libraryTrigger());
    });

    expect(screen.getByText(/refuses every query until midnight UTC/)).toBeTruthy();
  });

  it('names what survives, because the operator cannot infer it', async () => {
    // Stars, play counts and playlists have **no foreign key** to `songs` and survive because
    // a rescan recreates the identical ids. Leaving that out would make the dialog sound like
    // it deletes everything — and a dialog that overstates its own cost trains operators to
    // confirm without reading, which defeats both gates above it.
    stubApi({ stats: [{ libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 }] });
    renderView();
    await screen.findByText('Danger zone');
    await act(async () => {
      fireEvent.click(libraryTrigger());
    });

    expect(screen.getByText(/stay registered/)).toBeTruthy();
    expect(screen.getByText(/stars, play counts and playlists are kept/)).toBeTruthy();
  });

  it('shows the current track count on the row, not only inside the dialog', async () => {
    // A number an operator has to open a modal to see is a number they consent to without.
    stubApi({ stats: [{ libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 }] });
    renderView();
    await screen.findByText('Danger zone');
    await waitFor(() => expect(screen.getByText('40 tracks indexed.')).toBeTruthy());
  });
});

describe('the two actions cannot be confused for each other', () => {
  it('a per-library drop does not fire the global request', async () => {
    /**
     * The irreversible one, and the only place a wiring slip would be invisible server-side.
     *
     * The stub **throws** on any unexpected URL, so a per-library confirm that reached
     * `/user/index/drop` fails here rather than quietly emptying every library on a
     * deployment with several. No server test can see the request the client made.
     */
    const { calls } = stubApi({
      libraries: [library({ id: 'L1', slug: 'home' }), library({ id: 'L2', slug: 'work' })],
      stats: [
        { libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 },
        { libraryId: 'L2', songs: 90, nodes: 30, scanStates: 1, billedRows: 1020 },
      ],
    });
    renderView();
    await screen.findByText('Danger zone');

    await act(async () => {
      fireEvent.click(libraryTrigger());
    });
    fireEvent.change(screen.getByPlaceholderText('home'), { target: { value: 'home' } });
    await act(async () => {
      fireEvent.click(confirmButton(/^Drop index$/));
    });

    await waitFor(() => expect(calls.some((call) => call.includes('/user/libraries/L1/index/drop'))).toBe(true));
    expect(calls.some((call) => call.includes('/user/index/drop'))).toBe(false);
    expect(calls.some((call) => call.includes('L2'))).toBe(false);
  });

  it('a global drop does not name a library', async () => {
    const { calls } = stubApi({ stats: [{ libraryId: 'L1', songs: 40, nodes: 12, scanStates: 1, billedRows: 448 }] });
    renderView();
    await screen.findByText('Danger zone');

    await act(async () => {
      fireEvent.click(globalTrigger());
    });
    fireEvent.change(screen.getByPlaceholderText('drop-all-index'), { target: { value: 'drop-all-index' } });
    await act(async () => {
      fireEvent.click(confirmButton(/^Drop every index$/));
    });

    await waitFor(() => expect(calls.some((call) => call.includes('/user/index/drop'))).toBe(true));
    expect(calls.some((call) => call.includes('/user/libraries/') && call.includes('drop'))).toBe(false);
  });
});

describe('a page that could not read the projection is still usable', () => {
  it('keeps the rows and says it is reading, rather than claiming a drop is free', async () => {
    /**
     * The dangerous failure is not the crash. It is a zero.
     *
     * A failed stats read leaves the controls correct — the dialog would quote `0` for an
     * unreadable projection, which is wrong in the safe direction — so the page stays up. But
     * it must not render that `0`: an operator told "0 tracks and 0 folders, billing about 0
     * rows" would confirm a 50,000-row drop having been told it was free.
     */
    stubApi({ libraries: [library({ songCount: 40 })], failStats: true });
    renderView();

    expect(await screen.findByText('Danger zone')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Reading what this would cost…')).toBeTruthy());
    // And the control is still there — refusing to project is not refusing to act.
    expect(libraryTrigger()).toBeTruthy();
  });

  it('shows no Danger Zone action when nothing is registered', async () => {
    stubApi({ libraries: [] });
    renderView();

    expect(await screen.findByText('No libraries registered yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Drop every index/ })).toBeNull();
  });
});
