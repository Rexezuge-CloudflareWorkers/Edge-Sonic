// The entrypoint base class lives in `@rexezuge/runtime` now
// (`AbstractEntrypointWorker`, with the `scheduled(event, env, ctx)` entry and
// the `WorkerScheduledController` type the cron fanout is wired through).
// What stays here is the one piece the kit does not own:
// The Workflow failure policy. A **function** rather than an abstract base class: this is
// Layer 1, which may not import `cloudflare:workers`, so `WorkflowEntrypoint` belongs in the
// app where the generated binding types live. The policy — log and rethrow, so a stopped
// instance is never recorded as complete — stays here, testable with no Workers runtime.
export { runWorkflow } from './runWorkflow';
