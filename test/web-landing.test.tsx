// @vitest-environment jsdom
/**
 * The signed-out surface: the landing page, the `Unauthorized` gate, and the
 * `/user/` redirect that makes a successful sign-in land somewhere real.
 *
 * ### Why these need a DOM and are still worth asserting
 *
 * `apps/web` is excluded from the coverage gate deliberately (see
 * `vitest.config.mts`), so nothing here moves a number — these are correctness tests.
 * They exist because the branch they cover **cannot be seen from the server suite**:
 * every assertion in `test/user-auth.test.ts` and `test/worker.int.test.ts` is about
 * `/user/*` rejecting a caller, and not one of them involves what the browser renders
 * after being refused. The 401 they assert is exactly the 401 that reaches
 * `LibrariesView`, which renders an empty list and a notice.
 *
 * So the whole gate could be deleted and the server suite would stay green, because
 * `useCurrentUser`'s contract is "set `authorized: false`", and whether any component
 * reads it is invisible to every test that exists. That is the shape of defect this
 * repository's own guidance warns about: a decision with no evidence.
 *
 * The cases below are paired the way the parent index requires — a guard needs a test
 * proving it has teeth, because a test that only asserts the correct branch passes
 * forever with the branch removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SpaViewRouter } from '../apps/web/src/components/layout/SpaViewRouter';
import { LandingView } from '../apps/web/src/views/LandingView';
import { AppHeader } from '../apps/web/src/components/layout/AppHeader';
import { SIGN_IN_ATTEMPT_KEY } from '../apps/web/src/lib/signInLoop';
import '../apps/web/src/i18n';

/**
 * A signed-in render mounts `LibrariesView`, whose load effect calls `/user/libraries`
 * for real. Stubbed rather than left to hit `fetch`, so the assertion is about what the
 * router chose and not about what an unawaited request happens to resolve to — and so
 * the state update lands inside `act` instead of warning.
 */
function stubLibraryList() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ libraries: [] }, { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

function renderRouter(authorized: boolean | null, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SpaViewRouter authorized={authorized} showNotice={() => undefined} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('the signed-out surface', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('offers a landing page to a caller the API refused', () => {
    // The headline: `/` must not render `LibrariesView` for someone who cannot have
    // libraries. Before the gate it did, and the result was an empty list beside a
    // notice about a failed request — the honest-looking answer to "you have no
    // libraries", for a caller who is not allowed to know whether any exist.
    renderRouter(false);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The Subsonic API, Served From A WebDAV Library');
    expect(screen.queryByText('Music libraries')).toBeNull();
  });

  it('shows no libraries and no users anywhere on the signed-out surface', () => {
    // A landing page that still linked to `/libraries` would be a page whose two dead
    // links advertise a surface the visitor cannot reach.
    renderRouter(false);
    expect(screen.queryByRole('link', { name: 'Libraries' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
  });

  it.each(['/libraries', '/users'])('answers %s with a sign-in gate rather than an empty list', (path) => {
    renderRouter(false, path);
    expect(screen.getByText('Access required')).toBeTruthy();
    // Named per route, so a visitor who followed a link knows what they were reaching
    // for. One shared "access required" would not say.
    expect(screen.getByRole('button', { name: 'Sign in with Cloudflare Access' })).toBeTruthy();
    expect(screen.queryByText('Music libraries')).toBeNull();
    expect(screen.queryByText('Subsonic users')).toBeNull();
  });

  it('renders the real views for a signed-in caller', async () => {
    // The other direction, and the one a deleted gate would still pass.
    stubLibraryList();
    renderRouter(true);
    expect(screen.getByText('Music libraries')).toBeTruthy();
    expect(screen.queryByText('Access required')).toBeNull();
  });

  it('renders a spinner, not the landing page, while the session is still resolving', () => {
    // The third state. Rendering `LandingView` here would flash the signed-out page at
    // every signed-in operator on every load, for the length of one request.
    renderRouter(null);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('The Subsonic API, Served From A WebDAV Library')).toBeNull();
    expect(screen.queryByText('Music libraries')).toBeNull();
  });

  it('keeps the header off a signed-out visitor, and on a signed-in one', () => {
    const { unmount } = render(
      <MemoryRouter>
        <AppHeader userEmail={null} signedIn={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('navigation')).toBeNull();
    unmount();
    render(
      <MemoryRouter>
        <AppHeader userEmail="operator@example.com" signedIn={true} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('navigation')).toBeTruthy();
  });

  it('keeps the nav off while the session resolves rather than guessing either way', () => {
    // `null` is neither. Showing the nav could flash it at a signed-out visitor;
    // showing chrome could flash its absence at a signed-in one. The header is small
    // and the router is covering the page with a spinner for these frames, so absent is
    // the quieter wrong answer.
    render(
      <MemoryRouter>
        <AppHeader userEmail={null} signedIn={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('a sign-in that changed nothing', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('says so, and names the two variables to check', () => {
    // The loop: no Access application in front of the deployment. `/user/` redirects
    // to `/`, the SPA mounts, `/user/me` answers 401, and the operator is back on the
    // same page with a button they already pressed. Without this line the page is
    // indistinguishable from one nobody has clicked yet.
    sessionStorage.setItem(SIGN_IN_ATTEMPT_KEY, '1');
    render(<LandingView />);
    expect(screen.getByText(/returned here without a session/)).toBeTruthy();
    // The server collapses "no session" and "misconfigured" into one 401 on purpose, so
    // the sentence names what to check rather than asserting which is wrong.
    expect(screen.getByText(/POLICY_AUD/)).toBeTruthy();
    expect(screen.getByText(/TEAM_DOMAIN/)).toBeTruthy();
  });

  it('stays silent on a first visit, so the hint cannot become wallpaper', () => {
    render(<LandingView />);
    expect(screen.queryByText(/returned here without a session/)).toBeNull();
  });

  it('records the attempt before navigating, because the navigation ends the page load', () => {
    // Ordering is the whole mechanism: `assign` throws away this JavaScript context, so
    // a flag set after it would never run and the hint would never appear on the page
    // that needs it.
    //
    // Asserted from an **empty** store rather than a pre-seeded one. Seeding first would
    // pass even with `rememberSignInAttempt` deleted, because the assertion would then be
    // reading back its own setup — the guard proving nothing about the guard.
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    render(<LandingView />);
    expect(sessionStorage.getItem(SIGN_IN_ATTEMPT_KEY)).toBeNull();
    screen.getByRole('button', { name: 'Sign In With Cloudflare Access' }).click();
    expect(sessionStorage.getItem(SIGN_IN_ATTEMPT_KEY)).toBe('1');
    expect(assign).toHaveBeenCalledWith('/user/');
  });

  it('shows the hint only on the page after a sign-in, never on the one that requested it', () => {
    // The two halves of the loop, and the reason the flag is read rather than written
    // here: the page that *asks* for a sign-in must not accuse the deployment before it
    // has had a chance to authenticate. Asserted as a pair because the first of the two
    // tests above covers only the "after" case in isolation.
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const { unmount } = render(<LandingView />);
    expect(screen.queryByText(/returned here without a session/)).toBeNull();
    screen.getByRole('button', { name: 'Sign In With Cloudflare Access' }).click();
    unmount();
    render(<LandingView />);
    expect(screen.getByText(/returned here without a session/)).toBeTruthy();
  });
});
