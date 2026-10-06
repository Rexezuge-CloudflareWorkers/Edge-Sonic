/**
 * `MediaWorker` — the request-path media offload, on its own object.
 *
 * ### What this suite is actually for
 *
 * Two things, and the second is the one that would otherwise be unmeasured.
 *
 * The first is the moved behaviour: enrichment by id, artwork for a directory, and the refusal
 * for a library that is not registered. Those cases lived in `scan-do.test.ts` while the methods
 * lived on `ScanWorker`; they are here because the methods live here now.
 *
 * The second is the **split itself**. A Durable Object handles one event at a time, so a scan
 * chunk walking the origin blocks every RPC to the same object — and `getCoverArt` is handed
 * `streamTimeoutMs` (30 s) against a chunk that may spend `SCAN_CHUNK_DEADLINE_MS` (20 s) of it.
 * Nothing in the product could see that: both workloads were on one class, one object, one input
 * gate, and every test was green.
 *
 * ### A double that cannot observe a failure is worse than no double
 *
 * There is no workerd in this suite, so the split cannot be observed directly — the input gate is
 * the platform's and Node has none. What *can* be modelled is the platform fact the split rests
 * on: **routing is namespace-scoped**, so the same name in two namespaces is two objects, and
 * the same name in one namespace is one. `namespacesRoutingByName` below models exactly that, and
 * the contention cases are written against it rather than against a comment claiming the split
 * happened.
 *
 * The teeth are paired deliberately. One case asserts the two stubs are distinct objects; its
 * pair asserts that routing both through a *single* namespace returns the *same* object — which
 * is the arrangement the split prevents. Without the pair, the first assertion could be satisfied
 * by two resolvers that each minted their own stub regardless of the namespace, which would be
 * the defect wearing the fix's clothes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaWorker } from '@edge-sonic/background';
import { getMediaStub, getScanStub, hasMediaBinding, hasScanBinding } from '../apps/api/src/workers/scanStubs';
import { createHarness } from './helpers/harness';
import type { Harness } from './helpers/harness';
import type { SubrequestKind, SubrequestMeter } from '@edge-sonic/shared';

let harness: Harness;

beforeEach(async () => {
  const root = '/remote.php/dav/files/alice/Music';
  harness = await createHarness({
    [root]: [
      { path: root, collection: true, mtime: 1000 },
      { path: `${root}/Bon Iver`, collection: true, mtime: 2000 },
    ],
    [`${root}/Bon Iver`]: [{ path: `${root}/Bon Iver`, collection: true, mtime: 2000 }],
  });
});

afterEach(() => {
  harness.close();
  vi.unstubAllGlobals();
});

/**
 * The minimum a Durable Object needs here: this object holds no state, so there is nothing for
 * storage to answer and nothing that could quietly stand in for the input gate the split is about.
 */
function fakeState(): DurableObjectState {
  return {} as unknown as DurableObjectState;
}

function workerFor(ctx: DurableObjectState): MediaWorker {
  return new MediaWorker(ctx, harness.env() as unknown as Cloudflare.Env);
}

describe('MediaWorker', () => {
  it('enriches a known track and answers null for an unknown one', async () => {
    vi.stubGlobal('fetch', harness.dav.fetch);
    const worker = workerFor(fakeState());
    const enriched = await worker.enrichSong('L1', harness.ids.skinnyLove);
    expect(enriched?.id).toBe(harness.ids.skinnyLove);
    await expect(worker.enrichSong('L1', 's:bm8=')).resolves.toBeNull();
  });

  it('answers no artwork for an empty candidate list without touching the origin', async () => {
    const worker = workerFor(fakeState());
    const before = harness.dav.propfinds.length;
    await expect(worker.coverArt('L1', 'Bon Iver/For Emma', [], 10_000)).resolves.toBeNull();
    expect(harness.dav.propfinds).toHaveLength(before);
  });

  it('refuses a library that is not registered, rather than answering null', async () => {
    // A throw rather than a null, because `getSong` and `getCoverArt` have already resolved the
    // library through the grant check — so reaching this means the two disagree, and a silent
    // null would turn that into a blank cover or an unenriched track.
    const worker = workerFor(fakeState());
    await expect(worker.enrichSong('L-nope', harness.ids.skinnyLove)).rejects.toThrow(/L-nope/);
    await expect(worker.enrichFacts('L-nope', { id: 's1', path: 'A/01.opus', size: 1, mtimeMs: 1 })).rejects.toThrow(/L-nope/);
    await expect(worker.coverArt('L-nope', 'Bon Iver/For Emma', [], 10_000)).rejects.toThrow(/L-nope/);
  });

  it('carries neither half of the scan, and the scan carries neither half of the media', async () => {
    // The structural half of the split, asserted on instances rather than on types, because a
    // type assertion would pass on a method that was declared and never reachable and fail on a
    // correct one that a subclass added.
    const media = workerFor(fakeState());
    for (const method of ['enrichSong', 'enrichFacts', 'coverArt']) {
      expect(typeof (media as unknown as Record<string, unknown>)[method], method).toBe('function');
    }
    for (const method of ['startScan', 'stepOnce', 'getStatus', 'reset', 'charge']) {
      expect(method in media, `MediaWorker must not carry ${method}`).toBe(false);
    }
  });
});

/**
 * A namespace stub whose `getByName` mints one object per name, per namespace.
 *
 * This is the platform fact and the whole basis for the split: Durable Object routing is
 * `(namespace, name)`, so the same name reached through two namespaces is two objects with two
 * input gates, and one name through one namespace is one object with one.
 *
 * Each namespace gets its **own** `seen` map — which is the part that matters. A single shared
 * map would make two namespaces answer the same object, and every case below would pass against
 * exactly the arrangement the split exists to undo.
 */
function namespacesRoutingByName(): Record<string, DurableObjectNamespace> {
  const namespaceFor = (): DurableObjectNamespace => {
    const seen = new Map<string, object>();
    return {
      getByName: (name: string) => {
        let stub = seen.get(name);
        if (!stub) {
          stub = { id: name };
          seen.set(name, stub);
        }
        return stub;
      },
    } as unknown as DurableObjectNamespace;
  };
  return { SCAN: namespaceFor(), MEDIA_DO: namespaceFor() };
}

/**
 * A meter that records charges. Structural, and complete against `SubrequestMeter`, because a
 * partial stand-in would satisfy the signature without modelling the thing being asserted.
 */
function recordingMeter(): { readonly meter: SubrequestMeter; charges: SubrequestKind[] } {
  const charges: SubrequestKind[] = [];
  const meter = {
    charge: (count?: number, kind?: SubrequestKind): void => {
      if (kind !== undefined) for (let i = 0; i < (count ?? 1); i += 1) charges.push(kind);
    },
    spent: 0,
    ceiling: Infinity,
    remaining: Infinity,
    exhausted: false,
  } as unknown as SubrequestMeter;
  return { meter, charges };
}

describe('the scan and the media object are two objects', () => {
  it('routes one library to two distinct stubs through two namespaces', () => {
    const env = { ...harness.env(), ...namespacesRoutingByName() };
    expect(hasScanBinding(env)).toBe(true);
    expect(hasMediaBinding(env)).toBe(true);

    // The property the split buys: same library, same name, **different** object — so a chunk
    // walking the origin holds one input gate and an artwork request reaches the other.
    expect(getMediaStub(env, 'L1')).not.toBe(getScanStub(env, 'L1'));
    // And each is still stable for its own namespace, or the double would be modelling
    // something the platform does not: two calls to one namespace are one object.
    expect(getMediaStub(env, 'L1')).toBe(getMediaStub(env, 'L1'));
    expect(getScanStub(env, 'L1')).toBe(getScanStub(env, 'L1'));
  });

  it('gives the same object to both workloads when they share a namespace — the case that failed', () => {
    // The teeth. `namespacesRoutingByName` is what makes the case above meaningful; this is what
    // makes the case above a measurement. A single namespace routes `(SCAN, 'L1')` and
    // `(MEDIA_DO, 'L1')` to one stub, and one stub has one input gate — which is the
    // serialization the split removes. If the split were reverted and both resolvers pointed at
    // one namespace, this is what production would do, and the assertion above would still pass
    // unless it were written against this.
    const shared: DurableObjectNamespace = namespacesRoutingByName().SCAN;
    const env = { ...harness.env(), SCAN: shared, MEDIA_DO: shared };
    expect(getMediaStub(env, 'L1')).toBe(getScanStub(env, 'L1'));
  });

  it('charges one subrequest per resolution, on the shared meter and for both objects', () => {
    // A DO RPC is a subrequest, so an uncharged resolver is a path that spends nothing because
    // nothing was watching it — and `getCoverArt` is the endpoint that may make a DO call *and*
    // several ranged reads against the same ceiling of 50.
    const { meter, charges } = recordingMeter();
    const env = { ...harness.env(), ...namespacesRoutingByName() };
    getScanStub(env, 'L1', meter);
    getMediaStub(env, 'L1', meter);
    expect(charges).toEqual(['rpc', 'rpc']);
  });

  it('reports no media binding in the harness env, and throws when a stub is demanded', () => {
    // The fallback the suite depends on: without a binding the endpoints run the direct service
    // in-fetch, which is what lets every other suite exercise them without workerd.
    expect(hasMediaBinding(harness.env())).toBe(false);
    expect(() => getMediaStub(harness.env(), 'L1')).toThrow(/MEDIA_DO/);
  });
});