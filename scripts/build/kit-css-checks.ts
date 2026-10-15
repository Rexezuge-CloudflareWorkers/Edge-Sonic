/**
 * The Tailwind utilities the SPA cannot ship without.
 *
 * Tailwind v4 scans only the Vite root, `apps/web`, which excludes `node_modules`.
 * Every converged control the kit owns renders its styling as Tailwind class names
 * inside the package's `dist/*.js`, so without the `@source` directive in
 * `globals.css` none of them are candidates: the markup renders, the styles do not,
 * and the build stays green. This module is the gate for that one line.
 *
 * Each token is one a reader can see the absence of, and the list spans every kit
 * component this app imports that emits classes at all — a token from only one
 * component would let the other half regress unnoticed:
 *
 * - `py-8` — `AppPage`
 * - `shrink-0`, `text-[var(--color-info-text)]` — `Badge`
 * - `focus-visible:ring-[var(--color-accent)]`, `disabled:opacity-50`,
 *   `hover:brightness-125` — `Button`
 * - `p-5` — `Card`
 * - `disabled:opacity-60`, `placeholder:text-[var(--color-text-muted)]` — `Input`
 * - `sr-only`, `max-w-[calc(100vw-2rem)]`, `top-20` — `NoticeBar`
 * - `bg-[var(--color-accent)]`, `focus-visible:outline-2` — `Unauthorized`
 *
 * **Every token must appear nowhere under `apps/web/`.** Tailwind's scan root is
 * the Vite root and it reads Markdown as readily as JSX, so a class name written in
 * a source file or a doc paragraph is a class the scanner finds and Tailwind emits —
 * with the kit not a source at all. A token named in the scan root is therefore
 * satisfied by this repository's own text and measures nothing.
 * `test/kit-css-checks.test.ts` asserts that property, so the next person to
 * document a utility finds out from the suite rather than from a gate that has
 * quietly stopped measuring.
 *
 * Tokens were derived by scanning the kit's own `dist/<Component>.js` for the
 * components this app imports, and keeping the candidates that the pre-fix bundle
 * was missing. Candidates that are not utilities at all were dropped: the scanner
 * reads `"aria-busy": loading` (a JSX prop) and `react/jsx-runtime` (a module
 * specifier) as candidates, and Tailwind compiles neither.
 */
export const KIT_REQUIRED_CSS_TOKENS: readonly string[] = [
  'py-8',
  'shrink-0',
  'text-[var(--color-info-text)]',
  'focus-visible:ring-[var(--color-accent)]',
  'disabled:opacity-50',
  'hover:brightness-125',
  'p-5',
  'disabled:opacity-60',
  'placeholder:text-[var(--color-text-muted)]',
  'sr-only',
  'max-w-[calc(100vw-2rem)]',
  'top-20',
  'bg-[var(--color-accent)]',
  'focus-visible:outline-2',
];

/**
 * The problems with the built CSS bundle.
 *
 * `css` is the bundle text, or `null` when no bundle exists. A missing bundle is a
 * build that did not run; a bundle missing kit tokens means `globals.css` lost its
 * `@source` line, so every shared control in the SPA ships unstyled.
 *
 * Each token is matched as a class **selector**, never as a bare substring. A bare
 * match is satisfied by the theme variable of the same name — Tailwind ships
 * `--animate-spin` in its default theme whether or not anything uses it — so a
 * substring check would call a frozen spinner present. The leading `.` is what a
 * generated utility always has and a custom property never has. Backslashes are
 * stripped from both sides first, so Tailwind's escape form
 * (`.bg-\[var\(--color-accent\)\]`) and the plain token agree.
 */
export function checkKitCss(css: string | null): string[] {
  if (css === null) {
    return ['No CSS bundle found in apps/web/dist/assets — run `pnpm --filter @edge-sonic/web build`.'];
  }
  const selectors = css.replaceAll('\\', '');
  const missing = KIT_REQUIRED_CSS_TOKENS.filter((token) => !selectors.includes(`.${token}`));
  if (missing.length === 0) {
    return [];
  }
  return [
    'The built CSS is missing the kit primitive utilities ' +
      missing.map((token) => `\`${token}\``).join(', ') +
      ' — these only compile when `apps/web/src/globals.css` declares ' +
      '`@source "../node_modules/@rexezuge/web/dist/*.js";`. Without it every shared ' +
      'control renders unstyled. Re-run the web build after restoring the line.',
  ];
}
