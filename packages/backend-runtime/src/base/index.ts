export { AbstractEntrypointWorker } from './AbstractEntrypointWorker';
// `WorkerScheduledController` is deliberately not re-declared. The reference
// project needed it for a cron trigger; Edge-Sonic has no cron in v1 — the library
// scan is advanced by client polling of `getScanStatus` — and an unused platform
// type is an invitation to add a cron nobody has scoped.
export type { WorkerExecutionContext } from './AbstractEntrypointWorker';
