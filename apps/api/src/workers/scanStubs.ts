/**
 * Durable Object stubs for the per-library background and media objects.
 *
 * Git `doStubs.ts` pattern: one stub per entity via `getByName`, so each library's scan loop and
 * its tag/artwork CPU run in their own isolate. Callers check the binding first and fall back to
 * the direct service when none is configured (tests, local dev without DO) — the fallback is what
 * keeps the suite green without workerd.
 *
 * ### Three resolvers, because the objects are three objects
 *
 * `getScanStub`, `getMediaStub` and `getEnrichStub` are **not** one resolver over a union, and the split is the
 * point rather than tidiness. A Durable Object handles one event at a time, so a scan chunk
 * walking the origin blocks every RPC to the same object — and `getCoverArt` is handed
 * `streamTimeoutMs` (30 s) against a chunk that may spend `SCAN_CHUNK_DEADLINE_MS` (20 s) of it.
 * Resolving them separately is what lets `getCoverArt` reach an object the scan cannot be holding.
 * The enrich loop is separate for the same lifecycle reason the template states for `IMPORT_DO`:
 * one namespace would let one loop's terminal `deleteAlarm` silently disarm the other.
 *
 * They are also independently absent. A deployment can carry `SCAN` without `MEDIA_DO`, and the
 * answers differ per object: with no scan object the walk is client-driven, with no media object the
 * picture parse runs in-fetch, and with no enrich object a library-wide enrichment runs one
 * chunk per operator step.
 *
 * ### The stub's type is **the class itself**
 *
 * `DurableObjectStub & ScanWorker` rather than a hand-written `{ getStatus(): Promise<...> }`. A
 * signature written beside the class is a second claim about it and nothing measures the two —
 * and it shipped disagreeing: `stub.start()` typechecked against a hand-written `{ start(): ... }`
 * that declared no parameter, while the class read `request.runId` off the first argument, which
 * arrives `undefined` over RPC. The class is the statement.
 */
import type { EnrichWorker, MediaWorker, ScanWorker } from '@edge-sonic/background';
import type { SubrequestMeter } from '@edge-sonic/shared';

type ScanStub = DurableObjectStub & ScanWorker;
type MediaStub = DurableObjectStub & MediaWorker;
type EnrichStub = DurableObjectStub & EnrichWorker;

function hasScanBinding(env: unknown): env is { SCAN: DurableObjectNamespace } {
  return (env as { SCAN?: DurableObjectNamespace }).SCAN !== undefined;
}

function hasMediaBinding(env: unknown): env is { MEDIA_DO: DurableObjectNamespace } {
  return (env as { MEDIA_DO?: DurableObjectNamespace }).MEDIA_DO !== undefined;
}

function hasEnrichBinding(env: unknown): env is { ENRICH: DurableObjectNamespace } {
  return (env as { ENRICH?: DurableObjectNamespace }).ENRICH !== undefined;
}

/**
 * @param meter The invocation's counter. A Durable Object RPC is a subrequest, so a stub the
 *   scan or a cover lookup calls into is spending from the same 50 as everything else. It was
 *   not counted, which is why `getCoverArt` — the one endpoint that may make a DO call *and* up
 *   to six ranged reads — was the hardest request in the product to reason about and the
 *   easiest to overrun.
 */
function getScanStub(env: unknown, libraryId: string, meter?: SubrequestMeter): ScanStub {
  const ns = (env as { SCAN?: DurableObjectNamespace }).SCAN;
  if (!ns) throw new Error('SCAN binding is not configured');
  meter?.charge(1, 'rpc');
  return ns.getByName(libraryId) as unknown as ScanStub;
}

/**
 * The media object's stub, charged the same single RPC the scan's is.
 *
 * Charged on **resolution** rather than per call, which is the only place the count can be
 * right: a caller that resolved and then took the direct-service branch would have been charged
 * for a call it never made. `getScanStub`'s comment carries the reasoning in full; this is the
 * same argument applied to the second object rather than a second opinion about the first.
 */
function getMediaStub(env: unknown, libraryId: string, meter?: SubrequestMeter): MediaStub {
  const ns = (env as { MEDIA_DO?: DurableObjectNamespace }).MEDIA_DO;
  if (!ns) throw new Error('MEDIA_DO binding is not configured');
  meter?.charge(1, 'rpc');
  return ns.getByName(libraryId) as unknown as MediaStub;
}

/**
 * The enrichment loop's stub, charged the same single RPC the scan's is.
 *
 * A **separate namespace** rather than a second name on `SCAN`, for the reason the
 * template states for `IMPORT_DO`: a Durable Object's lifecycle is its alarm, so one
 * namespace would put a scan and an enrichment in the same object, where one loop's
 * terminal `deleteAlarm` silently disarms the other.
 */
function getEnrichStub(env: unknown, libraryId: string, meter?: SubrequestMeter): EnrichStub {
  const ns = (env as { ENRICH?: DurableObjectNamespace }).ENRICH;
  if (!ns) throw new Error('ENRICH binding is not configured');
  meter?.charge(1, 'rpc');
  return ns.getByName(libraryId) as unknown as EnrichStub;
}

export { getScanStub, getMediaStub, getEnrichStub, hasScanBinding, hasMediaBinding, hasEnrichBinding };
export type { ScanStub, MediaStub, EnrichStub };
