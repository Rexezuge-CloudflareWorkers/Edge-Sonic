export { AbstractEntrypointWorker } from './AbstractEntrypointWorker';
// `WorkerScheduledController` is deliberately not re-declared. The reference
// project needed it for a cron trigger; Edge-Sonic has no cron in v1 — the library
// scan is advanced by client polling of `getScanStatus`, and the import runs in a
// Workflow — and an unused platform type is an invitation to add a cron nobody has
// scoped.
export type { WorkerExecutionContext } from './AbstractEntrypointWorker';
// The Workflow failure policy. A **function** rather than an abstract base class: this is
// Layer 1, which may not import `cloudflare:workers`, so `WorkflowEntrypoint` belongs in the
// app where the generated binding types live. The policy — log and rethrow, so a stopped
// instance is never recorded as complete — stays here, testable with no Workers runtime.
export { runWorkflow } from './runWorkflow';
