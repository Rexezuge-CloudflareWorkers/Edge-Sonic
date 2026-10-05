/**
 * The failure policy every Workflow in this repository shares.
 *
 * ### Why a function and not an abstract base class
 *
 * `WorkflowEntrypoint` lives in `cloudflare:workers`, and `backend-runtime` is **Layer 1** —
 * a package that must typecheck on its own, with no platform types and no generated
 * `worker-configuration.d.ts`. `AbstractEntrypointWorker` in this folder works around exactly
 * that by hand-declaring its own minimal context types; declaring a second, hand-written
 * `WorkflowEntrypoint` would be that workaround applied to a class the platform already
 * provides, and a hand-declared copy drifts.
 *
 * So the **policy** lives here — testable from the Node suite, with no Workers runtime — and the
 * **platform type** stays in `apps/background`, where the real `worker-configuration.d.ts` is.
 * A Workflow's `run` is three lines: call this, delegate.
 *
 * ### What the policy is, and why it is not bigger
 *
 * A `run` that swallows an error reports **success** to the platform while the instance has
 * stopped. So the engine records a completed instance whose steps did not all run, and the
 * operator's page reads "finished" off a run that imported three playlists — the same shape as
 * a scan that "finished" because its frontier emptied. So this logs and **rethrows**, and
 * nothing more.
 *
 * ### The retry decision stays with the step
 *
 * A step's `retries` policy is where the question "is this fault worth repeating?" is decided,
 * and it is configured per step where the work is known. Nothing here reclassifies an error: a
 * step that should not be retried raises `NonRetryableError` from `cloudflare:workflows`
 * itself, which reaches the engine as the fatal error it is.
 */

/**
 * Run a Workflow's body under the shared failure policy.
 *
 * @param label What to name in the log line. The class name, not the step's — a Workflow with
 *   thirty steps produces one of these lines per fault, so it has to say *which instance class*
 *   stopped.
 */
async function runWorkflow<TResult>(label: string, body: () => Promise<TResult>): Promise<TResult> {
  try {
    return await body();
  } catch (err: unknown) {
    // The message is a **literal**, never the error's own text: a `RemoteSubsonicError` carries
    // a URL and a remote's response fragment, and Cloudflare's CodeQL `js/clear-text-logging`
    // taints a variable built from them — which is why the error object is logged as a separate
    // argument rather than interpolated. The label alone is the thing this line is for.
    console.error(`[workflow] ${label} failed; the instance is recorded as failed, not complete`);
    console.error(err);
    // Rethrown, not returned. Returning normally is how a Workflow reports success.
    throw err;
  }
}

export { runWorkflow };