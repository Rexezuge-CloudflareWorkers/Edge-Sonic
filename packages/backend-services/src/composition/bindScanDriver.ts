/**
 * The scan driver's binding, out of `requestScope.ts`.
 *
 * ### Why this is its own module
 *
 * Because `requestScope.ts` is over the god-file limit, and the same reason `bindIndexDrop.ts`
 * exists. What moves here is the **wiring** for one feature; the decisions stay where they are
 * reachable — what a driver may do is `ScanDriver`'s, and which strategy a deployment gets is
 * `apps/api`'s.
 *
 * ### Why the driver is bound **last**
 *
 * Because the default strategy reads `ScanService` through a **thunk**: at the point
 * `createRequestScope` binds it, the scope exists but the walk does not, and `Container` is an
 * eager `Map` with no lazy tier — the factory tier was deleted precisely because nothing used it.
 * A thunk is the same answer `scopeMiddleware`'s `meterOf` gives for the same reason.
 *
 * ### And why it is bound at all, when the app could bind it
 *
 * The app *does* bind it — `resolveScanDriver` is passed in — and this line is what happens when
 * it does not. `ScanWorkerFactory` and every background class omit it, and every one of those is
 * a scope with no `SCAN` binding by construction, so the default has to be a working strategy
 * rather than a throw. Layer 3 cannot construct the object-backed one (a namespace stub is
 * `apps/api`'s business), so the default is the one whose only dependency is in this package.
 */
import type { Container } from '@edge-sonic/backend-runtime/di';
import { InProcessScanDriver } from '../library/ScanDriver';
import type { ScanDriver } from '../library/ScanDriver';
import { Tokens } from './tokens';

/**
 * Bind the driver a caller did not supply, defaulting to the in-process strategy.
 *
 * `supplied` is the app's decision — it is the only place that can see whether a `SCAN` binding
 * exists — and `null` is what "there is none" arrives as, rather than being inferred here.
 */
function bindScanDriver(scope: Container, supplied?: ScanDriver): void {
  if (supplied !== undefined) {
    scope.bindValue(Tokens.ScanDriver, supplied);
    return;
  }
  scope.bindValue(Tokens.ScanDriver, new InProcessScanDriver(() => scope.get(Tokens.ScanService)));
}

export { bindScanDriver };