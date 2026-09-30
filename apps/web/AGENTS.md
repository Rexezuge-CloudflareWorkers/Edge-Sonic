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
- `src/components/layout/SpaViewRouter.tsx` — the route switch (`/`, `/libraries`,
  `/users`, `*` localized 404 `Card`). Props are the already-composed hook slices;
  routes render speculatively because the views answer an unreachable API with an
  empty list plus a notice.
- `src/components/layout/` — `AppHeader` (always rendered; shows the session email
  once `/me` answers, else the operator label), `AppPage` (`wide`/`narrow`/`hero`
  container; `wide` is `max-w-5xl` for this surface, not the reference `max-w-7xl`),
  `NoticeBar`, `Unauthorized` (exported for a future explicit gate; Access enforces
  the surface at the edge, so no route gates on the session today).
- `src/hooks/` — `useNotice` (`showNotice(type, text)` + `clearNotice` for the
  dismissible banner; timeout from `lib/constants`), `useCurrentUser`
  (inflight-deduped `GET /user/me`, `authorized` tri-state), `useSpaLanguage`
  (detection precedence, `<html lang>` sync, manual-change flow; English-only, but
  the shape a second locale plugs into).
- `src/lib/api.ts` — generic transport primitives only (`apiGet/Post/Patch/Put/
  Delete`, `BackendError`, `buildQuery`, `unwrapList`). Domain calls live in
  `src/services/*` (`libraryService`, `userService`); no component reaches for
  `fetch` directly.
- `src/types.ts` — thin facade over `libraryTypes.ts` + `userTypes.ts` (plus
  `CurrentUser` and `Notice`), so existing `from '../types'` imports keep working.
- `src/lib/locale.ts` — `normalizeLocale`/`resolveLocale` delegating to the single
  `i18n` canonicalizer (no duplicated logic).
- `src/lib/probe.ts`, `src/lib/libraryDraft.ts` — the decisions, not the markup. See
  below for why they are not in a component.
- `src/i18n.ts` — i18next, English-only for now (`SUPPORTED_LANGUAGES` is `['en']`;
  `validate:locales` guards key/placeholder parity and bundle-dir parity when a
  second locale ships).

## Rebuild before deploying

**`pnpm run build`.** The Worker serves `SPA_HTML` from the *last local build*, and both
`dist/` and `apps/api/src/generated/` are gitignored, so a source change here is inert
until `vite build` runs again. `scripts/verify-spa-shell.mjs` runs in `pnpm run checks` and
rejects a missing, stubbed, or mismatched artifact. It cannot detect a stale-but-
self-consistent pair, which is why the rebuild is an operational duty and not only a
checked one.

## Data loading owns its own cancellation

Each view's `load` callback does the fetching and the effect that runs it owns the
"am I still mounted" check:

```ts
useEffect(() => {
  let cancelled = false;
  void load().then((next) => { if (!cancelled) setState(next); });
  return () => { cancelled = true; };
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
the root suite, and `test/probe-notice.test.ts` does exactly that for `lib/probe.ts` and
`lib/libraryDraft.ts`. That file exists because the decisions below were wrong and lived
inside a component, where a component with no test is a decision with no evidence. The
two `useEffect` cancellation guards are the other load-bearing logic here, and the lint
rule that catches a missing one is on. Put a decision in a pure function under `lib/`
and it is testable from the root suite today; the coverage `include` list is a separate,
deliberate decision.

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
reading "still scanning" is reading a *status*, and one reading "still scanning, because
your origin takes two seconds a request and the chunk is capped at twenty" is reading a
**diagnosis** — the second has an action and the first does not. The two limits are named
separately because their remedies differ (`SCAN_CHUNK_MAX_REQUESTS` against
`SCAN_CHUNK_DEADLINE_MS`), and "it stopped" is neither. It is rendered **muted**, not in
the error tone: a chunk that hit a bound did its job and left the rest of the frontier
for the next poll, and colouring that as a fault would train an operator to ignore the
line that does mean something went wrong.

`Rescan` calls `stepLibraryScan` as well as `startLibraryScan`, and both halves are
needed. The scan is client-driven and `/rest/getScanStatus` was the only thing that
advanced it, so before the step route this button started a scan that only progressed
while some *Subsonic client* happened to be polling — which is not a thing an operator
can arrange. The status is then re-read with `libraryScanStatus`, so the row shows the
persisted state a `/rest` poll would see.

## An untouched password is absent, not empty

`updateLibrary` has existed on the server and in `lib/api.ts` since the surface was
written, and nothing called it, so the only remedy for a rejected credential was deleting
the library — which cascades the whole index away. `LibraryForm` is now shared by create
and edit, and `toPatch` omits `davPassword` when the field was left blank. That is not
tidiness: `BaseRoute.updateLibrary` calls `setPassword` only when the field is **present**,
so sending `''` re-encrypts an empty password over a working one and breaks every future
scan, with nothing in the response to say so. The trim happens before the emptiness test
so a stray space is not mistaken for a deliberate replacement.

## Style

Locale **values are sentence case** — "Display name", "No users registered yet." — which
is what the bundle actually contains. The parent index says Title Case; that does not
match the file, and following it means re-casing every existing string whenever a key is
added. Worth settling in one place rather than drifting.

No component reaches for `fetch` directly: the primitives in `src/lib/api.ts` plus
the per-domain `src/services/*` are the only things that know a request shape.
