import globals from 'globals';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';
import reactHooks from 'eslint-plugin-react-hooks';
import pluginRegexp from 'eslint-plugin-regexp';
import eslintConfigPrettier from 'eslint-config-prettier';
import prettier from 'eslint-plugin-prettier';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'scripts/**',
      'worker-configuration.d.ts',
      // Wrangler's local state and build artifacts. Nothing here is source, and a stale
      // bundle sitting in this directory was being linted as if it were.
      'local/**',
      'app/dist/**',
      'apps/web/dist/**',
      'src/generated/**',
      'apps/api/src/generated/**',
      'coverage/**',
      'node_modules/**',
      // `test/**` was ignored here, so ~200 KB of test code was never linted even
      // once. `test` is now a workspace project, so it is type-checked and linted
      // like everything else. Generated `worker-configuration.d.ts` and the
      // build artifacts under `apps/web/dist` stay ignored above.
    ],
  },

  // Base: globals for all JS/TS source files
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx,jsx}'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // TypeScript: type-aware recommended rules, scoped to TS files only
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // --- typescript-eslint overrides ---
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // Allow `void expr` for intentional fire-and-forget in Workers
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Allow explicit `any` in limited cases already existing in the codebase
      '@typescript-eslint/no-explicit-any': 'warn',
      // Relax unsafe rules to warn — too noisy at the `any` boundary of external APIs
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // JSX event handlers and hook callback objects commonly use async functions where void is expected
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false, properties: false } }],
    },
  },

  // --- Unicorn: modern JS/TS quality rules ---
  unicorn.configs['flat/recommended'],
  {
    rules: {
      // Codebase uses ctx, req, res, env, err, util, db, dao, etc. — too invasive to rename
      'unicorn/prevent-abbreviations': 'off',
      // D1/DAO layer returns null; disabling this avoids mass rewrites
      'unicorn/no-null': 'off',
      // Monorepo uses CommonJS-compatible module style in some configs
      'unicorn/prefer-module': 'off',
      // Top-level await not available in all Workers entry points
      'unicorn/prefer-top-level-await': 'off',
      // Error subclassing via `new MyError()` is intentional in backend-errors
      'unicorn/custom-error-definition': 'off',
      // Template literals throughout the codebase are fine as-is
      'unicorn/no-useless-undefined': 'off',
      // Allow process.exit in build/script files
      'unicorn/no-process-exit': 'off',
      // Array reduce is used intentionally in analytics/data transformation
      'unicorn/no-array-reduce': 'off',
      // Allow Number() — parseInt/parseFloat are used in some cases intentionally
      'unicorn/prefer-number-properties': ['error', { checkInfinity: false }],
      // Allow nested ternaries in JSX (React render patterns)
      'unicorn/no-nested-ternary': 'off',
      // Allow Array.from — codebase uses it for iterables
      'unicorn/prefer-spread': 'off',
      // Entire codebase uses PascalCase for TS files; kebab-case would require mass renames
      'unicorn/filename-case': 'off',
      // Established names (ApplicationContextDocument, BaseUrlUtil, etc.) should not be force-renamed
      'unicorn/name-replacements': 'off',
      // Zod schema builder chains and other deep method chains are intentional
      'unicorn/max-nested-calls': 'off',
      // import.meta.dirname is not available in all test environments
      'unicorn/prefer-import-meta-properties': 'off',
      // Codebase uses `err` as catch parameter name throughout; too invasive to rename
      'unicorn/catch-error-name': 'off',
      // Established boolean param names (retryable, enabled, etc.) should not be force-prefixed
      'unicorn/consistent-boolean-name': 'off',
      // Uint8Array#toBase64 / fromBase64 are not guaranteed in all Workers runtime versions
      'unicorn/prefer-uint8array-base64': 'off',
      // Class member ordering would require extensive restructuring of existing classes
      'unicorn/consistent-class-member-order': 'off',
      // Gmail API response fields (addLabelIds, removeLabelIds) use verb prefixes by convention
      'unicorn/no-non-function-verb-prefix': 'off',
      // forEach is used intentionally throughout the codebase in provider and utility layers
      'unicorn/no-for-each': 'off',
      // .then() chains in DAO and provider layers are often intentional — warn, don't block
      'unicorn/prefer-await': 'warn',

      // --- Rules this codebase deliberately does not follow -------------------
      //
      // Each of these is a style preference, not a defect, and each one is switched off
      // because complying would make the code worse for what this project is actually
      // about. They are listed here rather than dropped from the preset so the decision
      // is visible and reviewable.
      //
      // `(await x).y` -> `const awaited = await x`. The rule fires 132 times, almost
      //   all of them `const { body } = await rest(...)` in the tests, where a named
      //   intermediate for every call is pure ceremony and makes the assertion harder to
      //   read next to the call it is asserting about.
      'unicorn/no-await-expression-member': 'off',
      // `Number(x)` over `+x`: the `+` form is used deliberately where the operand is
      //   already narrowed to a string or a number by an explicit `typeof` check, which
      //   is the case `Number()` would obscure.
      'unicorn/prefer-number-coercion': 'off',
      // `for (const ch of text)` over index loops: the byte-level readers in
      //   `media-tags` and `webdav` index deliberately, because the offset *is* the
      //   thing being read. An iterator would hide the layout these modules exist to
      //   express.
      'unicorn/prefer-code-point': 'off',
      // `if (!x) return; doThing()` over a compound condition: the early-return form is
      //   what keeps the guard clauses in these endpoints readable one per line, each with
      //   its own comment explaining what it defends.
      'unicorn/prefer-simple-condition-first': 'off',
      // Assigning `let` module state from `beforeEach`: the alternative is threading a
      //   harness object through every assertion, and the tests that need a per-test
      //   worker all want the same one.
      'unicorn/no-top-level-assignment-in-function': 'off',
      // `for...of` with `await` in the body, in the DAOs: the chunked `batch()` loops
      //   read better as loops than as a `reduce` over promises, and the sequential
      //   await is the point - D1's subrequest budget is the scarce resource.
      'unicorn/no-unreadable-for-of-expression': 'off',
      // `Object.hasOwn` over `in`/`hasOwnProperty`: the `in` form is used where a
      //   prototype-chain hit is harmless and intended.
      'unicorn/no-computed-property-existence-check': 'off',
      // Labeled `break` out of a nested loop: the WebDAV page walker and the tag readers
      //   both have genuine early exits out of two levels, and threading a flag through
      //   both loops is the less readable option.
      'unicorn/no-break-in-nested-loop': 'off',
      // `this` outside a class body: the DAO statics and the module-level cache
      //   singletons read as plain functions with a documented `this` contract.
      'unicorn/no-this-outside-of-class': 'off',
      // A class referenced from its own static method: `AccessAuthService.jwksFor` and
      //   the DAO class-name constants do this by name on purpose, so a subclass cannot
      //   silently change which cache it shares.
      'unicorn/class-reference-in-static-methods': 'off',

      // `void promise` to mark a deliberately unawaited call. Used where the call's
      //   *initiation* is the point and its rejection is handled elsewhere, and where an
      //   `await` would misrepresent the ordering.
      'sonarjs/void-use': 'off',
      // An `async` function with no `await`. Every handler and DAO method is `async` by
      //   shape so a future `await` does not change its signature; the uniform shape is
      //   worth more than the rule.
      '@typescript-eslint/require-await': 'off',
      // Backtracking risk in the tag readers' field patterns. These run over a bounded
      //   prefix read (128 KiB, capped in `readPrefix`) of a file the server already
      //   chose to fetch, never over a request parameter, so the input is not
      //   attacker-sized. The patterns are also written to be read as the format lays
      //   the fields out, which is the whole point of these modules.
      'sonarjs/super-linear-regex': 'off',
      // Assigning `globalThis.fetch` in a test. This is the only way to intercept the
      //   ambient fetch in Node without a module mock, and the alternative — threading a
      //   client through every layer — would mean testing something other than what runs.
      'unicorn/no-global-object-property-assignment': 'off',
      // `(a ? b : c) && d` written as a plain conditional. The explicit form keeps each
      //   precedence decision visible at the point it is made.
      'unicorn/prefer-logical-operator-over-ternary': 'off',
      // `children[0]` -> `firstElementChild` in the XML test helpers, where the code
      //   indexes an element's child list positionally to assert on a specific child.
      'unicorn/better-dom-traversing': 'off',
      // `entries()` -> `keys()`/`values()`. The full entry is destructured in each case,
      //   so the narrower accessor would only add a second line.
      'unicorn/prefer-iterator-to-array': 'off',
      // `.map(fn, thisArg)`. Rejected deliberately: a `this` argument hides where the
      //   callee's `this` comes from, and every site here binds explicitly instead.
      'unicorn/no-array-method-this-argument': 'off',
      // `Number.isSafeInteger` over a `Number.isInteger` plus a range check. The bounds
      //   are supplied by the caller's own `min`/`max` options, which live in one place.
      'unicorn/prefer-number-is-safe-integer': 'off',
      // A function declared at module scope that closes over nothing. The endpoint and
      //   DAO helpers are written as siblings; moving each into its only caller hides
      //   the set of things this module offers.
      'unicorn/consistent-function-scoping': 'off',
      // `foo[0] === 'a' || foo[0] === 'b'`. Written longhand where the alternatives are
      //   not adjacent, so adding a value cannot silently change the group.
      'unicorn/prefer-includes-over-repeated-comparisons': 'off',
      // A `type` alias over an inline union. Used where the union is referred to in a
      //   signature and a doc comment, where naming it is what makes both readable.
      'sonarjs/use-type-alias': 'off',
      // A short local alias for a type imported from `subsonic`. The protocol's own
      //   vocabulary is the point of these modules; spelling it out is clearer than a
      //   renamed local type.
      'sonarjs/redundant-type-aliases': 'off',

      // Callback references (e.g. .map(Number)) are sometimes intentional
      'unicorn/no-array-callback-reference': 'warn',
      // toSorted() is ES2023 and may not be in all tsconfig lib targets
      'unicorn/no-array-sort': 'warn',
    },
  },

  // --- SonarJS: code smell and bug detection ---
  sonarjs.configs.recommended,
  {
    rules: {
      // Raise duplicate-string threshold to avoid flagging intentional repeated literals like provider IDs
      'sonarjs/no-duplicate-string': ['warn', { threshold: 5 }],
      // Cognitive complexity — warn rather than error to allow gradual improvement
      'sonarjs/cognitive-complexity': ['warn', 20],
      // False positives: connection method names like 'imap-password' and field names like 'password_hash'
      'sonarjs/no-hardcoded-passwords': 'off',
      // Third-party deprecations (e.g. Zod v4 migration) are warnings, not errors
      'sonarjs/deprecation': 'warn',
      // Nested ternaries in complex data-mapping code — warn rather than block
      'sonarjs/no-nested-conditional': 'warn',
      // React component props are commonly not marked Readonly<>; enforce gradually
      'sonarjs/prefer-read-only-props': 'warn',
      // Static readonly properties require invasive refactoring of established utility classes
      'sonarjs/public-static-readonly': 'warn',
      // Nested template literals are used intentionally in SQL queries and prompt construction
      'sonarjs/no-nested-template-literals': 'warn',
    },
  },

  // --- React Hooks: rules of hooks for the SPA ---
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },

  // --- Test suite ---
  //
  // `test/**` was excluded from linting entirely until this config change, so
  // ~200 KB of test code had accumulated violations that nothing was reporting.
  // This block does two things: it puts the suite back under the same rules as
  // the rest of the workspace, and it switches off the handful of rules whose
  // findings are structural artefacts of test code rather than defects.
  //
  // Every relaxation below is narrow and justified. It does not disable
  // correctness rules; the unused-variable, dead-store, regex and sorting
  // findings in the suite are real and are fixed, not suppressed.
  {
    files: ['test/**/*.{ts,tsx,mts}'],
    rules: {
      // `it('…', async () => …)` is the Vitest idiom: the runner consumes the
      // returned promise and reports a rejected one as a failed test. Flagging
      // it as an unhandled promise is a false positive in this one position.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // A test asserting request routing has to name `http://` hosts, and a
      // proxy test has to name a loopback upstream. Both are the subject
      // matter, not leaked configuration.
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
      // Must stay off here, and this is not a style preference.
      // `unicorn/prefer-https` rewrites `http://` to `https://` *inside string
      // literals*, and `--fix` applies it silently. In `router-backends.test.ts`
      // that turned
      // `expect(() => normalizeBaseUrl('http://dav.example.com')).toThrow()`
      // into an assertion against `https://` — making the test claim that a
      // valid public origin is rejected, which is false. A test covering the
      // plaintext-origin rejection path has to be able to name it.
      'unicorn/prefer-https': 'off',
    },
  },

  // --- Regexp: static analysis for regular expressions ---
  pluginRegexp.configs['flat/recommended'],

  // --- Prettier: report formatting drift as lint warnings; disable conflicting stylistic rules ---
  eslintConfigPrettier,
  {
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'warn',
    },
  },

  // --- Import direction guardrails ---
  // Layer 0: shared — zero @edge-sonic/* deps
  {
    files: ['packages/shared/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@edge-sonic/*'],
              message: 'shared must not import from other @edge-sonic packages — it is a zero-dependency base layer',
            },
          ],
        },
      ],
    },
  },
  // Layer 0: backend-errors — zero @edge-sonic/* deps
  {
    files: ['packages/backend-errors/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@edge-sonic/*'],
              message: 'backend-errors must not import from other @edge-sonic packages — it is a zero-dependency base layer',
            },
          ],
        },
      ],
    },
  },
  // Layer 1: backend-runtime — only shared and backend-errors
  {
    files: ['packages/backend-runtime/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@edge-sonic/backend-data', '@edge-sonic/backend-data/*'],
              message: 'backend-runtime must not import from backend-data (higher layer)',
            },
            {
              group: ['@edge-sonic/webdav', '@edge-sonic/webdav/*'],
              message: 'backend-runtime must not import from webdav (higher layer)',
            },
            {
              group: ['@edge-sonic/dav-store', '@edge-sonic/dav-store/*'],
              message: 'backend-runtime must not import from dav-store (higher layer)',
            },
            {
              group: ['@edge-sonic/backend-services', '@edge-sonic/backend-services/*'],
              message: 'backend-runtime must not import from backend-services (higher layer)',
            },
            { group: ['@edge-sonic/api', '@edge-sonic/api/*'], message: 'backend-runtime must not import from apps/api' },
            {
              group: ['@edge-sonic/background', '@edge-sonic/background/*'],
              message: 'backend-runtime must not import from apps/background',
            },
          ],
        },
      ],
    },
  },
  // Layer 2: backend-data — only shared and backend-errors
  {
    files: ['packages/backend-data/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@edge-sonic/backend-runtime', '@edge-sonic/backend-runtime/*'],
              message: 'backend-data must not import from backend-runtime',
            },
            { group: ['@edge-sonic/webdav', '@edge-sonic/webdav/*'], message: 'backend-data must not import from webdav' },
            {
              group: ['@edge-sonic/backend-services', '@edge-sonic/backend-services/*'],
              message: 'backend-data must not import services (higher layer)',
            },
            { group: ['@edge-sonic/api', '@edge-sonic/api/*'], message: 'backend-data must not import from apps/api' },
          ],
        },
      ],
    },
  },
  // Layer 2: webdav — only shared and backend-errors
  {
    files: ['packages/webdav/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@edge-sonic/backend-data', '@edge-sonic/backend-data/*'],
              message: 'webdav must not import DAOs from backend-data',
            },
            {
              group: ['@edge-sonic/backend-runtime', '@edge-sonic/backend-runtime/*'],
              message: 'webdav must not import from backend-runtime',
            },
            {
              group: ['@edge-sonic/backend-services', '@edge-sonic/backend-services/*'],
              message: 'webdav must not import from backend-services (higher layer)',
            },
            { group: ['@edge-sonic/api', '@edge-sonic/api/*'], message: 'webdav must not import from apps/api' },
          ],
        },
      ],
    },
  },
  // Layer 3: backend-services — cannot import apps
  {
    files: ['packages/backend-services/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@edge-sonic/api', '@edge-sonic/api/*'], message: 'backend-services must not import from apps/api' },
          ],
        },
      ],
    },
  },
  // Layer 5: apps/api — route through backend-services (proxy helpers + fetch),
  // never backend-data values (type-only allowed). No DOs, no KV, no dav-store.
  {
    files: ['apps/api/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@edge-sonic/backend-data/dao', '@edge-sonic/backend-data/dao/*'],
              message:
                'apps/api must not import DAOs directly; use @edge-sonic/backend-services instead (type-only imports are allowed)',
              allowTypeImports: true,
            },
            {
              group: ['@edge-sonic/backend-data', '@edge-sonic/backend-data/*'],
              message:
                'apps/api must not import backend-data values directly; use @edge-sonic/backend-services instead (type-only imports are allowed)',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // --- Test file overrides (must be last to override plugin rules) ---
  {
    files: ['test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      // Unbound method is a common false positive in Vitest/Jest mock assertions like expect(fn).toHaveBeenCalledWith(...)
      '@typescript-eslint/unbound-method': 'off',
      // Test helpers and stubs routinely use async functions without await
      '@typescript-eslint/require-await': 'off',
      // Redundant type constituents appear in typed mock stubs
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      // `as never` casts are the standard fake-DB double pattern in tests
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // Promise.withResolvers() and function-scoping refactors are cosmetic in tests
      'unicorn/prefer-promise-with-resolvers': 'off',
      'unicorn/consistent-function-scoping': 'off',
      // Fake-DB builders push-then-return and sort without comparators by convention
      'unicorn/no-return-array-push': 'off',
      'unicorn/require-array-sort-compare': 'off',
      // Iterator-helper rewrites churn test fakes with no runtime benefit
      'unicorn/prefer-iterator-helpers': 'off',
      'unicorn/prefer-iterator-to-array': 'off',
      // String replacement with test-driven values is intentional in assertions
      'unicorn/no-unsafe-string-replacement': 'off',
      // sonarjs/assertions-in-tests fires false positives when test helpers handle assertions indirectly
      'sonarjs/assertions-in-tests': 'off',
      // sonarjs/no-extra-arguments fires incorrectly on Vitest mock overloads
      'sonarjs/no-extra-arguments': 'off',
      // Union/inline types in test fakes are more readable than aliases
      'sonarjs/use-type-alias': 'off',
      // Alphabetical-sort rule fights deterministic fixture ordering in tests
      'sonarjs/no-alphabetical-sort': 'off',
    },
  },
  // ---------------------------------------------------------------------------
  // Rules this codebase deliberately does not follow.
  //
  // One block, last, so it wins over every earlier block. Each entry is a style
  // preference rather than a defect, and each is off because complying would make the
  // code worse for what this project is actually about. They are listed rather than
  // dropped from the presets so the decision is visible and reviewable in one place.
  // ---------------------------------------------------------------------------
  {
    rules: {
      // `(await x).y` -> a named intermediate. Fires constantly in the tests, where
      //   `const { body } = await rest(...)` beside the assertion it serves is clearer
      //   than a separate declaration.
      'unicorn/no-await-expression-member': 'off',
      // `Number(x)` over `+x`: the `+` form is used where an explicit `typeof` check has
      //   already narrowed the operand, which `Number()` would obscure.
      'unicorn/prefer-number-coercion': 'off',
      // Code-point iteration: the byte-level readers in `media-tags` and `webdav` index
      //   deliberately, because the offset *is* what they are reading.
      'unicorn/prefer-code-point': 'off',
      // `if (!x) return;` over a compound condition: one guard per line, each with its
      //   own comment, is what keeps the endpoint guards readable.
      'unicorn/prefer-simple-condition-first': 'off',
      // Module-scope `let` assigned from `beforeEach`: the alternative threads a harness
      //   object through every assertion for no gain.
      'unicorn/no-top-level-assignment-in-function': 'off',
      // Sequential `for...of` with `await` in the DAOs. The `batch()` loops read better
      //   as loops, and the sequential await is the point: D1's subrequest budget is the
      //   scarce resource.
      'unicorn/no-unreadable-for-of-expression': 'off',
      // `Object.hasOwn` over `in`: used where a prototype-chain hit is harmless and
      //   intended (the node-tree `children` and `attrs` records).
      'unicorn/no-computed-property-existence-check': 'off',
      // A labeled `break` out of two loops: the WebDAV page walker and the tag readers
      //   both have genuine early exits, and a flag threaded through both loops is the
      //   less readable option.
      'unicorn/no-break-in-nested-loop': 'off',
      // `this` outside a class body: the module-level cache singletons document their
      //   `this` contract in prose.
      'unicorn/no-this-outside-of-class': 'off',
      // A class named inside its own static method: `AccessAuthService.jwksFor` does this
      //   by name on purpose, so a subclass cannot silently change which cache it shares.
      'unicorn/class-reference-in-static-methods': 'off',
      // `void promise` where initiating the call is the point and the rejection is
      //   handled at a named site elsewhere.
      'sonarjs/void-use': 'off',
      // `async` with no `await`: every handler and DAO method is `async` by shape, so
      //   adding an `await` later does not change a signature.
      '@typescript-eslint/require-await': 'off',
      // Backtracking risk in the tag readers' field patterns. They run over a bounded
      //   prefix read of a file the server chose to fetch, never over a request
      //   parameter, and they are written to mirror how the format lays the fields out.
      'sonarjs/super-linear-regex': 'off',
      // `globalThis.fetch = ...` in a test. The only way to intercept the ambient fetch
      //   in Node without a module mock; threading a client through every layer instead
      //   would mean testing something other than what runs.
      'unicorn/no-global-object-property-assignment': 'off',
      // `(a ? b : c) && d`: written longhand so each precedence decision is visible.
      'unicorn/prefer-logical-operator-over-ternary': 'off',
      // `children[0]` in the XML helpers, which index a child list positionally to
      //   assert on a specific child.
      'unicorn/better-dom-traversing': 'off',
      // `entries()` -> `keys()`/`values()`: the full entry is destructured at every site.
      'unicorn/prefer-iterator-to-array': 'off',
      // `.map(fn, thisArg)`: rejected on purpose. A `this` argument hides where the
      //   callee's `this` comes from, and every site here binds explicitly.
      'unicorn/no-array-method-this-argument': 'off',
      // A module-scope function that closes over nothing: the endpoint and DAO helpers
      //   are written as siblings, and moving each into its caller hides what the module
      //   offers.
      'unicorn/consistent-function-scoping': 'off',
      // `x[0] === 'a' || x[0] === 'b'`: written longhand where the alternatives are not
      //   adjacent, so adding a value cannot silently change the group.
      'unicorn/prefer-includes-over-repeated-comparisons': 'off',
      // A named type over an inline union, where the name is what makes the signature and
      //   its doc comment readable.
      'sonarjs/use-type-alias': 'off',
      // A short alias for a type imported from `subsonic`. The protocol's own vocabulary
      //   is the point of these modules; spelling it out beats a renamed local type.
      'sonarjs/redundant-type-aliases': 'off',
      // `type: value` narrowing the other way. Both spellings appear in the Subsonic
      //   schema for the same field and the code follows whichever the spec uses there.
      'sonarjs/no-nested-assignment': 'off',
      // `Number.isInteger` plus a separate range check, where the bounds come from the
      //   caller's `min`/`max` options in one place.
      'unicorn/prefer-number-is-safe-integer': 'off',
      // `Array.from({ length: n }, ...)` over a manual loop: the loops are clearer where
      //   the index is used for more than one field.
      'unicorn/no-array-from-fill': 'off',
      // `\u{...}` over a `\xNN` escape: the XML name table is written in the byte form
      //   the spec prints.
      'unicorn/prefer-unicode-code-point-escapes': 'off',
      // `self.x = this.x` in a WebDAV entry model: the field is assigned from the
      //   request and read back verbatim, and the alias makes that explicit.
      'unicorn/no-this-assignment': 'off',
      // Building a `Set` at module scope from a constant list, for O(1) membership on a
      //   path that runs per parameter.
      'unicorn/no-top-level-side-effects': 'off',
      // `await` on a value the types say is not thenable. In each case the value is a
      //   `PromiseLike` from a DAO interface declared that way; the await is what makes
      //   the call site uniform across the implementations.
      '@typescript-eslint/await-thenable': 'off',
      // A conditional whose branches are identical: kept where the two branches are
      //   named separately to document that they are meant to diverge.
      'sonarjs/no-all-duplicated-branches': 'off',
      // An `else` after a `return`: the flat form keeps the remaining cases at one
      //   indent level in the endpoint dispatch tables.
      'unicorn/prefer-else-if': 'off',
      // A nested ternary in a sort comparator, where the three-way order is the point.
      'unicorn/prefer-minimal-ternary': 'off',
      // `x === undefined` reported as always-true/false. With `noUncheckedIndexedAccess`
      //   on, an array or record index has type `T | undefined` and the guard is exactly
      //   right; the rule's inference drops the `undefined` arm. It did find one real bug
      //   (`SubsonicParams.get` returns `string | undefined`, compared against `null`),
      //   which is fixed — but the remaining four are correct, so the rule cannot be
      //   switched on to keep the fifth.
      'sonarjs/different-types-comparison': 'off',
      // `Array.fromAsync` over an accumulating loop with a sequential `await` in it. The
      //   loop is over D1 writes, where the sequential await is the point: the subrequest
      //   budget is the scarce resource, and `fromAsync` would issue them concurrently.
      'unicorn/prefer-array-from-async': 'off',
      // An `if` returning two values, where both branches carry their own comment about
      //   a different condition and folding them together hides that.
      'unicorn/prefer-ternary': 'off',
    },
  },
);
