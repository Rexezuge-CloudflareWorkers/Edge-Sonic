/**
 * Minimal `cloudflare:workflows` stand-in for the Node unit pool.
 *
 * ### Why this module exists at all
 *
 * `LibraryImportWorkflow` needs `NonRetryableError`, and that class lives in
 * `cloudflare:workflows` — a specifier **Node cannot resolve**, so importing the workflow
 * from the root suite was an unresolvable-specifier startup error. It broke three suites that
 * reach `@edge-sonic/background` for `ScanWorker` and nothing else, which is the confusing
 * shape: the file a test imports has nothing to do with the file that failed.
 *
 * The alternative was to stop re-exporting the workflow from `apps/background/src/index.ts`,
 * which would have meant `apps/api/src/index.ts` reaching for a subpath — and *that* is the
 * drift `apps/background`'s own package exports already had entries for. A second platform
 * module needed a second mock, and the table that holds them is shared by both Vitest configs,
 * so one addition covers both.
 *
 * ### What the mock must model, and what it must not
 *
 * It models **identity**, because that is the whole contract this repository relies on: the
 * engine distinguishes "retryable" from "fatal" by whether the thrown value is one of these
 * classes, so a mock that returned a bare `Error` for both would make a test pass that
 * production fails — the step would be retried three times on a fault that can never succeed.
 *
 * It models nothing else. There is no `WorkflowEntrypoint` here on purpose: that comes from
 * `cloudflare:workers`, which already has a mock, and a second definition of it would be a
 * second answer to "what does a Workflow extend".
 */
class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export { NonRetryableError };
