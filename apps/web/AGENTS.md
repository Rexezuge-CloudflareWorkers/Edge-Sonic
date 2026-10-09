# Edge-Sonic — Operator SPA

Scope: `apps/web/**`. Parent index: `../../AGENTS.md`.

A Vite + React 19 SPA for the operator surface: registering a WebDAV library, managing
users, and granting them access. It speaks only to `/user/*`, which is behind Cloudflare
Access — it has no Subsonic credential and could not use one.

- `src/main.tsx` — `BrowserRouter` → `SpaApp`.
- `src/SpaApp.tsx` — thin composition root: `useCurrentUser` + `useSpaLanguage` +
  `useNotice` hook slices, `AppHeader`/`NoticeBar`, then `SpaViewRouter`. No data
  fetching in the shell and none in the router either — each view owns its own
  loading.
- `src/components/layout/` — `AppHeader` (global, with the nav shown only for a
  session), `AppPage` (`wide`/`narrow`/`hero` container; `wide` is `max-w-5xl` for this
  surface, not the reference `max-w-7xl`), `NoticeBar`, `PageState` (`LoadingSpinner` +
  `EmptyState`), `Unauthorized`, `SpaViewRouter`.
- `src/components/ui/` — one component per file (`Card`, `Button`, `Input`, `Badge`), so
  a change to one cannot arrive in a diff that claims to be about another. A grab-bag
  `panels.tsx`/`controls.tsx` was the previous shape and is not to be reintroduced.
- `src/components/library/` — `LibraryForm` + `LibraryRow`, colocated by domain rather
  than sitting at the root of `components/`.
- `src/components/settings/DangerZoneCard.tsx` — the two index-drop rows and their
  confirmations. **Not** on the libraries page; see the section below.
- `src/components/modals/` — `ModalShell` (the portal and the click-outside) +
  `TypeToConfirmModal` (the second gate). Ported from the reference project; `ModalHeader`,
  `ModalBody`, `ModalRow`, `ModalEmpty` and `WIDE_MODAL_CLASS` were **deliberately not**
  ported, because every one is an export with no caller here.
- `src/views/SettingsView.tsx` — `/settings`, the Danger Zone's page. Owns the two reads
  and the drop handlers; the decisions are in `lib/indexDrop.ts`.
- `src/views/LandingView.tsx` — what a signed-out visitor sees at `/`.
- `src/lib/scanStatus.ts` — the two scan decisions: `isAdvancingStatus` (when to keep
  polling) and `describeScanState` (what is said). Pure, so it is testable from the root suite
  — see `test/scan-progress.test.ts`.
- `src/hooks/` — `useNotice` (`showNotice(type, text)` + `clearNotice` for the
  dismissible banner; timeout from `lib/constants`), `useCurrentUser`
  (inflight-deduped `GET /user/me`, `authorized` tri-state), `useSpaLanguage`
  (detection precedence, `<html lang>` sync, manual-change flow; English-only, but
  the shape a second locale plugs into).
- `src/lib/api.ts` — generic transport primitives only (`apiGet/Post/Patch/
Delete`, `BackendError`, `buildQuery`). Domain calls live in `src/services/*`
  (`libraryService`, `userService`); no component reaches for `fetch` directly.
- `src/types.ts` — thin facade over `libraryTypes.ts` + `userTypes.ts` (plus
  `CurrentUser` and `Notice`), so existing `from '../types'` imports keep working.
- `src/lib/probe.ts`, `src/lib/libraryDraft.ts`, `src/lib/signInLoop.ts` — the decisions,
  not the markup. See below for why they are not in a component.
- `src/lib/indexDrop.ts` — the Danger Zone's confirm phrases and its five sentences. Pure,
  labels as parameters, so `test/spa-index-drop.test.ts` reaches it from the root suite.
- `src/lib/constants.ts` — `NOTICE_TIMEOUT_MS` and `ZERO_TRUST_AUTHENTICATION_PATH`
  (`/user/`, the path inside the Access application that the landing page navigates to).

## Three files here were documented and did not exist

`src/lib/locale.ts` (delegating `normalizeLocale`/`resolveLocale` to the single `i18n`
canonicalizer), `unwrapList` in `src/lib/api.ts`, and `Unauthorized` in
`components/layout/` were all listed in this file and absent from the tree. Found while
adding a landing page, and fixed as part of it — but recorded here because the failure is
worth naming: **a documentation list of files reads exactly like an inventory, and nothing
distinguishes the two.** The two smaller claims are the same defect as
`ENDPOINT_NAMES` in the parent index, where a registry nothing asserted turned out to be
correct by luck.

`lib/locale.ts` and `unwrapList` were **not** added — no call site wanted them, and an
export with no callers is a second vocabulary to keep in sync. The claims were deleted
rather than satisfied.

## `authorized` is three states, and only one of them gates

`useCurrentUser` returns a tri-state, and the router branches on all three:

| `authorized`       | `/`               | `/libraries`, `/users` |
| ------------------ | ----------------- | ---------------------- |
| `null` (in flight) | full-page spinner | full-page spinner      |
| `false` (refused)  | `LandingView`     | `Unauthorized`         |
| `true`             | `LibrariesView`   | the real view          |

`null` is a spinner because rendering `LandingView` during the request flashes the
signed-out page at every signed-in operator on every load.

`false` gates because **the SPA shell is public**. `EdgeSonicWorker` serves `SPA_HTML` for
`/`, `/libraries` and `/users` _above_ `app.use('/user/*', userAuthentication())`, because
a browser navigating to a client-side route sends no API call for the worker to
authenticate. Without the gate, `LibrariesView` calls `/user/libraries`, takes the 401, and
renders its documented **empty list plus a notice** — the honest-looking answer to "you
have no libraries", from a caller who is not allowed to know whether any exist.

The gate is a courtesy, not a control. `/user/*` is independently guarded, so nothing is
readable by ignoring the component.

**What the gate does not cover.** A 401 raised _after_ this branch — an Access session
expiring mid-use — still renders as an empty list plus a notice, because the views cannot
classify it. Distinguishing it needs the API to say _why_ it refused, which it will not do
for an unauthenticated caller (see below). So the signed-out landing page is a correct
answer to "no session" and an incomplete one to "a session I cannot use".

## The header is global here, and root-only in the reference

`../Git` renders `TopHeader` on `/` only, because every other route there renders a
`ContextBar` instead. This surface has two **sibling** routes with no hierarchy between
them, so a root-only header would leave `/libraries` with no way back — hence global, with
the **nav links** gated on `authorized === true` instead.

`signedIn === true` and not `userEmail !== null`, because those two differ in two
directions and only one of them is a gate: while `/user/me` is in flight `userEmail` is
`null`, so the email test would flash the nav off at a signed-in operator — harmless,
since the router is covering those frames with a spinner anyway.

## A sign-in that changed nothing

`/user/` is inside the Cloudflare Access application, so navigating there starts the
login. A deployment with **no Access application in front of it** therefore loops: `/`
serves the landing page → Sign In → `/user/` redirects to `/` → `/user/me` answers 401 →
the same page, with a button that was pressed and did nothing. Every click is a real
navigation and every one lands on the same page, which is the only symptom.

`lib/signInLoop.ts` detects the loop — an attempt recorded in `sessionStorage` and this
page _still_ anonymous — and `LandingView` renders a muted line naming `POLICY_AUD` and
`TEAM_DOMAIN`. Muted and beside the button, not in the error tone: the button is still
correct, and this is the same reasoning as a scan that stops at a subrequest bound being
rendered muted rather than red.

**The client cannot be told the cause, and must not ask.** `AccessAuthService` throws one
`UnauthorizedError` for a missing session _and_ for a `TEAM_DOMAIN`/`POLICY_AUD` typo,
because the JWT strategy fails soft at `fromJwt` and the configuration cause is discarded
before the single throw site. That collapse is deliberate — a detailed message tells an
unauthenticated caller which part of their token they got right. Both reach the browser as
`401 / Exception.Type === 'Unauthorized'`, so the page names the two variables to check
rather than asserting which is wrong. The inference it _does_ make is stronger than a guess
about the cause: the loop was witnessed.

`clearSignInAttempt` runs once `authorized === true`, so an operator signed out later by an
expired cookie is an ordinary signed-out visitor rather than a page claiming the
deployment is broken.

**`/user/` is a route, not just a constant.** Access redirects back to whatever it
interrupted, so a _successful_ sign-in arrives at `/user/` and hits the worker. With no
route registered it fell through to `notFound` and answered JSON `Exception{NotFound}` —
the one screen in the product guaranteed to be reached by an operator who did exactly what
the landing page asked. `EdgeSonicWorker` registers `app.get('/user/', (c) => c.redirect('/'))`,
above `scopeMiddleware` and above `/user/*` authentication, and `test/worker.int.test.ts`
pins it against being widened into something that shadows `/user/me`.

- `src/i18n.ts` — i18next, English-only for now (`SUPPORTED_LANGUAGES` is `['en']`;
  `validate:locales` guards key/placeholder parity and bundle-dir parity when a
  second locale ships).

## Rebuild before deploying

**`pnpm run build`.** The Worker serves `SPA_HTML` from the _last local build_, and both
`dist/` and `apps/api/src/generated/` are gitignored, so a source change here is inert
until `vite build` runs again. `scripts/build/verify-spa-shell.ts` rejects a missing,
stubbed, or mismatched artifact, and it runs in `pnpm run checks`.

It is **also** a CI job now — `spa-shell` in
`.github/workflows/continuous-integration.yml`, which builds and then verifies. It used not
to be, which is a gap worth recording because the reasoning generalises: a check that
only runs locally fails on a merge rather than on a machine, and this one guards an
artifact the _deploy_ serves. It cannot detect a stale-but-self-consistent pair, which is
why the rebuild before `wrangler deploy` remains an operational duty and not only a
checked one.

## Data loading owns its own cancellation

Each view's `load` callback does the fetching and the effect that runs it owns the
"am I still mounted" check:

```ts
useEffect(() => {
  let cancelled = false;
  void load().then((next) => {
    if (!cancelled) setState(next);
  });
  return () => {
    cancelled = true;
  };
}, [load]);
```

The effect has to own the guard because only the effect knows when the component goes
away. Without it a slow first response can land after a faster refresh the user triggered,
and React 18 turns a set-state-after-unmount into a silent leak rather than a warning.
The fetch itself is a separate `useCallback` so the initial load and every refresh button
share it without the effect reaching into component state.

An unreachable user API renders as an **empty list plus a notice**, not an error screen:
the operator can still read what is on the page, and the notice says what went wrong.

## Not in the coverage gate

`apps/web` is deliberately **not** in `vitest.config.mts`'s coverage `include`. The
reference project added it on a comment claiming a vitest config in `apps/web` that never
existed; the entire SPA was then invisible and the floor quietly dropped from 80 to 64
with 44 presentational modules at 0%. Publishing a number that is mostly untested UI is
worse than saying "not measured yet" — so it is excluded **visibly**, and re-including it
is meant to be a deliberate act once the components have tests.

**Excluded is not untested.** What is testable without a DOM harness is exercised from
the root suite: `test/probe-notice.test.ts` for `lib/probe.ts` and
`lib/libraryDraft.ts`, and `test/spa-decisions.test.ts` for `lib/api.ts`'s error decoder
and `describeStopReason`. That file exists because the decisions below were wrong and lived
inside a component, where a component with no test is a decision with no evidence. Put a
decision in a pure function under `lib/` and it is testable from the root suite today; the
coverage `include` list is a separate, deliberate decision.

`test/web-landing.test.tsx` is the first **jsdom component** test here (`// @vitest-environment
jsdom` pragma + Testing Library, both already devDependencies at the root). It drives
`SpaViewRouter` through all three `authorized` states, and it exists because **no server
test can see this branch**: every assertion in `user-auth.test.ts` and `worker.int.test.ts`
is about `/user/*` refusing a caller, and not one involves what the browser renders after
being refused. The 401 they assert _is_ the 401 that reaches `LibrariesView`. So the entire
gate could be deleted and the server suite would stay green, because `useCurrentUser`'s
contract is only "set `authorized: false`" and whether anything reads it is invisible to
every test that exists.

It is written the way this repository requires: every guard is paired with a case that goes
red when the guard is removed. Verified by mutation — deleting the `/user/` route, forcing
`signedOut = false`, stubbing `hasPriorSignInAttempt` to `false`, and dropping the
`rememberSignInAttempt()` call each turn tests red.

One of those mutations is worth recording, because the **first** version of that test
passed against a broken guard: it seeded `sessionStorage` before clicking and then asserted
the flag was set, so it was reading back its own setup. It now starts from an empty store
and is paired with a case that asserts the hint is _absent_ on the page that requests the
sign-in — a guard that reads back its own arrangement is not a guard.

**There is no lint rule that catches a missing cancellation guard.** This file claimed one
was on. `eslint.config.mjs` applies `react-hooks.configs['recommended-latest']`, which is
17 rules including `exhaustive-deps`, `rules-of-hooks` and `set-state-in-effect` — **none** of which detects an
un-guarded `setState` after an `await` in an event handler. The two `useEffect` guards above
are correct because they were written that way, not because something enforces it.

So an **event handler** that awaits has to own its guard explicitly, and `LibraryRow` is the
worked example: `rescan` makes three sequential round trips against an origin slow enough
that a chunk is bounded in seconds, and both its handlers now check a ref the mount effect
sets. The effect form below is unaffected — an effect _can_ own its cleanup, because only
the effect knows when the component goes away.

## A diagnostic is rendered, not summarised

The probe had one `catch` on the server and a boolean in the client, and the operator saw
the single word "unreachable" for a rejected password, a wrong root path, a missing
Secrets Store binding, and a dead host alike. Three things have to hold, and all three
are asserted in `test/probe-notice.test.ts`:

- **The server's sentence is the badge.** `describeProbe` passes `result.error` through
  verbatim rather than mapping a status to a local string, for the same reason
  `extractError` surfaces an `Exception` message: the server knows more than a client
  table can. "Unreachable" is now produced by exactly one branch up there.
- **The badge and the notice are derived from one value**, so they cannot disagree. They
  used to be computed separately and they did: a failed probe is an HTTP `200`, so the
  runner reported **success** — a green "Probe finished." beside a red badge, for the one
  action whose whole job is to report a failure. `run` therefore takes an action that
  returns a `Notice | void`; returning a notice overrides the success message. This is
  not a convenience shape: the request genuinely did succeed, and what failed is a
  different fact.
- **The reason outlives the notice.** `useNotice` clears after 6 s, so the server's
  sentence is also rendered under the row. A diagnosis read once and gone is not a
  diagnosis.

A scan failure carries the same treatment via `lastError`, which the server now sends on
every status — nullable, not optional, so a client can tell "no error" from "field
absent".

A scan that **pauses** carries it too, via `stoppedBy`. A chunk is bounded by a subrequest
ceiling and a wall-clock deadline, and returns when it reaches either;
`describeStopReason` turns that into a sentence naming the bound, because an operator
reading "still scanning" is reading a _status_, and one reading "still scanning, because
your origin takes two seconds a request and the chunk is capped at twenty" is reading a
**diagnosis** — the second has an action and the first does not. The two limits are named
separately because their remedies differ (`SCAN_CHUNK_DEADLINE_MS` against the subrequest
ceiling), and "it stopped" is neither.

**The request sentence no longer names a knob, because on Free there is none.** It used to
say _"Raise `SCAN_CHUNK_MAX_REQUESTS` to index more per poll"_, and `test/spa-decisions.test.ts`
asserted the sentence **contained** that variable name — so the harmful advice was the
contract. Workers Free allows 50 subrequests per invocation and does not raise it from the
wrangler config, the server clamps the value to what fits, and a chunk that spends more is
_terminated_ by the runtime rather than slowed. Following the old advice therefore turned a
scan that pauses into a scan that cannot finish. The sentence now says the two things that
are true — this is the plan's limit rather than a fault, and the scan is still advancing — and
`stoppedBy: 'requests'` is a state a Free-plan deployment reaches **by design**, not a
misconfiguration. It is rendered **muted**, not in
the error tone: a chunk that hit a bound did its job and left the rest of the frontier
for the next poll, and colouring that as a fault would train an operator to ignore the
line that does mean something went wrong.

`Rescan` calls `stepLibraryScan` as well as `startLibraryScan`, and both halves are
needed. The scan is client-driven and `/rest/getScanStatus` was the only thing that
advanced it, so before the step route this button started a scan that only progressed
while some _Subsonic client_ happened to be polling — which is not a thing an operator
can arrange. The row shows the persisted state a `/rest` poll would see, because `onRun`
reloads the list and that list carries every library's state — not because a status was
re-read per library.

This paragraph used to say the status "is then re-read with `libraryScanStatus`", which is
the other half of this file's contradiction: line ~350 says the rescan handler does **not**
read the status back, `LibraryRow.tsx` says the same, and `libraryScanStatus` had zero
callers — kept alive by this sentence. A wrapper whose only justification is a paragraph
describing a call it never received is not documentation. The wrapper is gone; the
`GET /user/libraries/:id/scan` **route** stays, because it is part of the operator API and is
asserted in `test/user-api.test.ts`.

## An untouched password is absent, not empty

`updateLibrary` has existed on the server and in `lib/api.ts` since the surface was
written, and nothing called it, so the only remedy for a rejected credential was deleting
the library — which cascades the whole index away. `LibraryForm` is now shared by create
and edit, and `toPatch` omits `davPassword` when the field was left blank. That is not
tidiness: `BaseRoute.updateLibrary` calls `setPassword` only when the field is **present**,
so sending `''` re-encrypts an empty password over a working one and breaks every future
scan, with nothing in the response to say so. The trim happens before the emptiness test
so a stray space is not mistaken for a deliberate replacement.

## The library page reads its scan state from the list, and polls it

The page showed **no scan state at all** until an operator clicked Rescan, and never updated
after that. The state was `useState<… | null>(null)` in `LibraryRow`, written only by the
rescan handler — so a scan the background worker was driving, which is the normal case,
rendered as a row with nothing on it. The server had been answering correctly throughout:
`GET /user/libraries` now carries each library's `status`, `scanned`, `lastError` and a real
`songCount`. **No server test could see this**, because every assertion in `user-api.test.ts`
is about what the server _sends_ and none is about what a page load renders — the same gap
`test/web-landing.test.tsx` records for the `authorized` gate. Hence
`test/web-library-row.test.tsx`.

Four decisions, each a place the obvious implementation is wrong:

- **`songCount` is tracks, and it is the progress number.** It is the figure
  `getScanStatus` publishes as `count`, so the operator and a Subsonic client reading the same
  library are looking at the same number. `scan.scanned` counts **folders**, and
  `scan_state.total_count` is written as `0` by `markScanning` and never updated — so a
  `scanned / total` fraction renders "12 of 0". `total` is therefore absent from the wire
  shape, deliberately.
- **The poll is passive.** It re-reads `GET /user/libraries`, which advances nothing; the scan
  is driven by `ScanWorker`'s alarm or by `/rest/getScanStatus`. So `SCAN_POLL_INTERVAL_MS` is
  a _display_ cadence, not a claim about scan speed, and polling faster would change nothing
  but the request count.
- **Polling stops, and the stop is a `stalled` case.** `/user/*` is limited to **60 requests
  per minute** keyed on the Access identity — the same bucket probe and rescan spend — so a
  timer that never stops spends the budget an operator needs for the actions they want to take.
  `isAdvancingStatus` is the guard, and `idle`, `stalled`, `paused` and `null` are all terminal. Each is
  asserted, because a guard written as `status === 'scanning'` gets `null` wrong and a newly
  registered library is the most common state a new deployment is in.
- **A failed poll keeps the list on screen.** It does _not_ reuse `load`'s documented
  "empty list plus a notice", because a poll runs unattended: folding its failure in would
  blank the page out from under an operator reading it and turn four libraries into "No
  libraries yet", which is the one sentence on this page that means something is genuinely
  absent. A `stale` line says the numbers are not current instead.

`isAdvancingStatus` is a **twin** of `backend-services`' `isAdvancing`, not a delegation:
`apps/web` ships zero `@edge-sonic/*` runtime dependencies, so the package is not reachable
from a browser bundle. It is pinned against the same vocabulary in
`test/scan-progress.test.ts`. Import it when the SPA gains runtime dependencies; do not add
them for this.

`stoppedBy` is **row-local** and does not survive a reload. It is a property of a chunk, not of
stored state — the only place it exists is the response to `POST …/scan/step` — so persisting it
would mean a column, a migration, a lock entry and a write on every chunk, for a sentence an
operator reads once with the page open. The rescan handler no longer reads the status back
afterwards: `onRun` reloads the list, which carries the state, and the extra round trip's only
effect was overwriting `stoppedBy` with `null`.

## The Danger Zone is a page, two gates, and a number the operator can see

`/settings` carries `DangerZoneCard`: a row per library plus one global row, each behind
`TypeToConfirmModal`. Four decisions, and each is a place the obvious implementation is wrong.

- **It is its own route, not a section on the libraries page.** A drop's blast radius is not the
  index: a large one spends the deployment's whole daily row-write allowance, and past that D1
  refuses **every** query until midnight UTC — reads included, so streaming goes down too. That
  does not belong on the page an operator opens to look at their music. `/settings` is in
  `SPA_ROUTES` in `EdgeSonicWorker.ts` as well as in `SpaViewRouter`, and the two lists are
  compared as source text by `test/worker.int.test.ts`.
- **The button arms; the phrase destroys.** Every destructive button on this surface used to be
  one click — including `deleteLibrary`, which cascades a whole index away — and a click cannot
  be the gate for an irreversible action, because the click is what happens by accident. The
  confirm button is **disabled** rather than hidden until the phrase matches: hidden would
  remove the affordance and leave the operator hunting, disabled says the requirement and
  leaves it visible.
- **The phrase is the slug for one library and the literal `drop-all-index` for all of them.**
  The slug because it is unique (`idx_libraries_slug_ci`) and the display name is
  operator-chosen text two libraries can both carry — a phrase two libraries satisfy is not a
  confirmation of anything. The literal because nothing in a global request names what is
  destroyed, so the operator types the **scope** instead.
- **The cost is rendered above the input, from the server's figure.** `GET /user/index/stats`
  projects it with the same `billedRowsForTable` that will charge the delete, so the estimate
  and the bill cannot drift. Reading it off `songCount` instead would mean multiplying by ten in
  the browser — a copy of a per-table table this layer cannot see, in the one place nothing would
  catch it being wrong. A number an operator must open a modal to see is a number they consent to
  without, so the row also shows the current track count.

**There is no server-side confirmation, and that is a decision.** Every caller of `/user/*` is
already an operator — Cloudflare Access _is_ the authorization boundary, and `users.is_admin` is
written but read only to render a badge — so a token here would be a second gate with no second
authority behind it. `test/web-danger-zone.test.tsx` asserts the browser half, and every case
there exists because a server test could delete the whole file and stay green.

**A failed projection read leaves the page up and the figures blank.** `stats` stays `null`,
which renders as "reading what this would cost…" rather than as a zero — a zero there reads as
"this costs nothing", and an operator would confirm a 50,000-row drop having been told it was
free. The rows and the controls are still correct, so blanking the page would take away the one
thing the operator can still read. This is the one deliberate silent `catch` on this surface,
and `lib/probe.ts` makes the same call for the same reason.

**The dialog says what survives, because the operator cannot infer it.** Stars, play counts and
playlists have no foreign key to `songs` and are kept — a rescan recreates the identical ids, so
they re-attach. A dialog that overstates its own cost trains operators to confirm without
reading, which defeats both gates above it. The outage sentence is **unconditional**: it reads as
alarmist on a library of nine tracks and is still true, since the allowance is per account and
other libraries share it.

## `stalled` is a status the client was unable to represent

`ScanStateSummary['status']` was `'idle' | 'scanning' | 'failed'`. The server sends `stalled`
— `failed` and `stalled` are the **same** stored status, separated only by the retry counter
(`storedStatus` in `scanRetry.ts`) — so a terminal scan rendered as the bare word `stalled`,
and the page had no way to know that polling had nothing left to buy. It is also the one status
whose remedy is the operator's action, which is why its label names it.

## `never` is not enough, and a zero count beside "up to date" is the claim that hid it

`scan === null` was separated from `idle` so a never-scanned library would not render as a
finished one. That left the **other** half uncovered, and it is the half that shipped: a
library whose scan _finished_ and indexed **zero** tracks. `songCount` is `0`, the status is
`idle`, and the row rendered a success-toned "Up to date." next to "0 tracks indexed" — two
claims on screen, contradicting, and the badge won. `test/scan-progress.test.ts` asserted
`idle` + `2` and had no `idle` + `0` case, so the one untrue thing on the page could not fail
a test.

`describeScanState` now has an `empty` case: an error tone, a remedy in the label, an
`error` notice, and `detail: null` — because rendering the count under a label denying there
is any hands the number to the badge it contradicts.

**It is gated on `idle && songCount === 0`, not on `songCount === 0`.** Zero tracks is the
_expected_ state of a library for the whole length of a first scan, and a guard written the
second way paints every cold scan as a failure. The `it.each` over `scanning`/`failed`/
`stalled` is there so that over-correction is caught too.

## A fallback string is a claim about who is looking

The header's identity chip was `userEmail ?? 'Operator'`, so **every signed-out visitor saw the
word "Operator"** in the top right of the landing page — the page asserting an identity it did
not have, for somebody who had not signed in. It is now gated on `signedIn === true`, the same
test as the nav and for the same reason (while `/user/me` is in flight both are null, and the
router is covering those frames with a spinner).

## A bundle value and its inline default are one fact, and nothing compared them

The header rendered as **`Edge--Sonic`**: `brand.rest` held `"-Sonic"` while the markup rendered
its own `-` between two spans. Every individual surface was defensible — the bundle had one
well-formed key with one well-formed value, the inline default said `"Sonic"` and matched what
the author meant, and the markup was correct — which is why it survived review. It is only wrong
to somebody who already knows the product is called "Edge-Sonic".

So `scripts/i18n/validate_locales.ts` now captures the optional second argument of `t('key',
'default')` and **fails** when it disagrees with the bundle, across all 130 call sites. Everything
else in that script compares two bundles or checks that a key exists; nothing in it read what a
value _is_, and with one shipped language the per-tag body is skipped entirely. Verified by
mutation: restoring `"-Sonic"` fails both the validator and the render assertion in
`test/web-library-row.test.tsx`.

`libraries.reachable` had drifted the same way (`"Reachable"` against a `"Reachable."` default)
and was resolved to `"Reachable."`, the default. `nav.operator` and `libraries.scan` were
**deleted** rather than left unreferenced — no caller is a second vocabulary to keep in sync.

## The import page is the second "what happened" surface, and it repeats the libraries page's decisions

`views/ImportView.tsx` (+ `components/import/RunReport.tsx`, `services/importService.ts`) move a
user's player data in from another Subsonic server. Three of its decisions are copies of
`LibrariesView`'s, and they are copies **on purpose** — `apps/web` ships zero `@edge-sonic/*`
runtime dependencies, so the package is not reachable from a browser bundle and a delegation would
mean adding a dependency for one function:

- **`load` fetches and returns; the effect owns the cancellation and is the only place that sets
  state.** A `load` that also called `setState` had to close over the state it sets in order to
  build its own stale fallback, which made every poll re-create the effect that depends on it — so
  a timer's lifetime was decided by the data it fetched.
- **A failed poll keeps the list and marks it stale.** It does _not_ reuse `load`'s documented
  "empty list plus a notice", because this is a poll: folding the failure in would turn "No
  imports yet" — the one sentence on this page meaning something is genuinely absent — into a
  sentence appearing every four seconds.
- **The poll only runs while something is going**, and only for the run that is open.

### The unresolved list is rendered, never summarised

`RunReport.tsx` holds `reasonText` and the two components that render it, because a **decision**
inside a component is a decision with no test, and this one maps a machine reason
(`ambiguous` ≠ `not-found`) onto the words an operator acts on. Collapsing them would send somebody
to index a library that already holds the album. It is re-exported from the view so the root suite
can reach it without a DOM.

### The phase list is checkboxes, and the play queue is **off**

The categories cost wildly different amounts — playlists are most of a Free account's daily
row-write allowance, the queue is one call, play counts are a walk that runs for days — so an
operator who cannot see that cannot choose. The queue is the one that is off by default: a saved
queue is transient state, and a default-on imports yesterday's half-finished queue without anybody
deciding to.

### `/import` had to be added to `SPA_ROUTES`, and nothing held them together

`SpaViewRouter`'s `<Route>` list and the worker's `SPA_ROUTES` are one decision written twice. The
failure is **asymmetric**: a route in the router but missing from `SPA_ROUTES` works perfectly for
an operator who clicked a nav link in an already-loaded tab and answers **404** for anyone who
bookmarked it or followed a link. `test/worker.int.test.ts` reads the two files as source text and
compares the path sets — rendering the router would only establish that the router renders.

## Style

Locale **values are sentence case** — "Display name", "No users registered yet." — which
is what the bundle actually contains. The parent index says Title Case; that does not
match the file, and following it means re-casing every existing string whenever a key is
added. Worth settling in one place rather than drifting.

No component reaches for `fetch` directly: the primitives in `src/lib/api.ts` plus
the per-domain `src/services/*` are the only things that know a request shape.
