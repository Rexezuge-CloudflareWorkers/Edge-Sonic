/**
 * The `/rest` reply, built once.
 *
 * ### Why this is a shared module and not nine copies of a three-line function
 *
 * Every endpoint module carried its own `respond(context, payload)` plus its own
 * `type EnvelopeResponse = ReturnType<typeof successResponse>`. They were byte-identical
 * in eight modules and **already diverged** in the ninth: `annotations.ts` declared
 * `respond(context)` with no payload and hardcoded `successResponse(null, …)`, so its
 * three handlers could not have returned a body even if they had wanted to.
 *
 * That is this repository's own recorded rule — "the same album, built once", where two
 * literals for one thing had already diverged on `created` and a client declaring
 * `@SerialName("created") val createdAt: Instant` with no default failed on **every**
 * `getAlbum`. Nine copies of a response builder is the same shape nine times over.
 *
 * The three things a reply has to get right, in one place:
 *
 * 1. **The format and the JSONP callback come from the request**, never from a
 *    parameter a caller can forget. `?f=xml` and `?callback=cb` are what make the answer
 *    parseable by the client that asked for it, and a handler that answered in the
 *    default format would be indistinguishable from a server that ignored it.
 * 2. **`payload: null` is the empty success**, which serializes to an envelope with
 *    `status: "ok"` and no payload key. That is what `star`, `scrobble` and
 *    `savePlayQueue` answer, and it is a real answer rather than an error.
 * 3. **An error is not this function's job.** Failures go through `errorResponse`, which
 *    is where the envelope's `status: "failed"` and its `code` are decided — one dialect,
 *    one place, and the reason `/rest` can be answered without a second decoder.
 */
import { successResponse } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { RestContext } from './context';

type EnvelopeResponse = ReturnType<typeof successResponse>;

/**
 * A successful `/rest` reply carrying `payload`.
 *
 * @param payload The one element to attach, or `null` for an empty success. Pass a list
 *   through `elList`, which knows the repeated child's name — an absent list key and an
 *   empty list are different wire shapes, and only the builder knows which was meant.
 */
function respond(context: RestContext, payload: ElementNode | null = null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

export { respond };
export type { EnvelopeResponse };