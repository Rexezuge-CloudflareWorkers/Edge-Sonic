# Edge-Sonic — Operator SPA

Scope: `apps/web/**`. Parent index: `../../AGENTS.md`.

A Vite + React 19 SPA for the operator surface: registering a WebDAV library, managing
users, and granting them access. It speaks only to `/user/*`, which is behind Cloudflare
Access — it has no Subsonic credential and could not use one.

- `src/main.tsx` — `BrowserRouter` → `SpaApp`.
- `src/views/` — `LibrariesView`, `UsersView`.
- `src/components/` — `AppHeader`, `NoticeBar`, and the `ui/` primitives.
- `src/hooks/useNotice.ts` — the transient status message, whose timer is cleared on
  replace so a fast sequence of messages does not leave an earlier timeout cutting a
  later one short.
- `src/lib/api.ts` — the typed client for `/user/*`.
- `src/i18n.ts` — i18next, English-only for now.

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

What is testable without a DOM harness — `src/lib/api.ts` and the formatters — is
exercised from the root suite instead. The two `useEffect` cancellation guards are the
load-bearing logic in this app, and the lint rule that catches a missing one is on.

## Style

English UI text is Title Case. No component reaches for `fetch` directly: the typed client
in `src/lib/api.ts` is the only thing that knows a request shape.
