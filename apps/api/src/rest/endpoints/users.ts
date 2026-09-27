/**
 * User surface: `getUsers` and `getUser` (the plural, implemented one).
 *
 * Subsonic clients read `getUser` to display "signed in as" and check whether the
 * account is an admin. Edge-Sonic's admin surface is the `/admin/*` API behind
 * Cloudflare Access, so a Subsonic user's `isAdmin` here means "may administer
 * *Subsonic* users" and grants nothing on the Access-gated side. The two identity
 * systems are deliberately not connected: an operator's Access identity must not be
 * usable as a streaming credential.
 */
import { decodeId, el, elList, ErrorCode, IdKind, SubsonicError, successResponse, userElement } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { UserRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';

type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

/**
 * `getUsers` — every account, admin only.
 *
 * A non-admin caller gets `code=50` rather than an empty list: an empty list would
 * be indistinguishable from "this server has one user", which is information.
 */
async function getUsers(context: RestContext): Promise<EnvelopeResponse> {
  if (context.user.is_admin !== 1) {
    throw new SubsonicError(ErrorCode.NotAuthorized, 'Only an admin may list users.');
  }
  const users = await context.users.list();
  return respond(context, elList('users', {}, users.map((user) => userElement(toView(user)))));
}

function toView(user: UserRow) {
  return {
    username: user.username,
    email: user.email ?? undefined,
    isAdmin: user.is_admin === 1,
    scrobblingEnabled: user.scrobbling_enabled === 1,
  };
}

/**
 * `getUser` — one account, or the caller's own when no `username` is given.
 *
 * A non-admin may read only themselves. Reading another user is `code=50`, not
 * `code=70`: unlike a playlist, a user row is not a secret, and hiding its
 * existence would only make a legitimate admin lookup fail confusingly.
 */
async function getUser(context: RestContext): Promise<EnvelopeResponse> {
  const requested = context.params.get('username');
  if (requested === undefined || requested.toLowerCase() === context.username.toLowerCase()) {
    return respond(context, { ...userElement(toView(context.user)), children: [] });
  }
  if (context.user.is_admin !== 1) {
    throw new SubsonicError(ErrorCode.NotAuthorized, 'Only an admin may read another user.');
  }
  const users = await context.users.list();
  const found = users.find((user) => user.username.toLowerCase() === requested.toLowerCase());
  if (!found) throw new SubsonicError(ErrorCode.NotFound, 'User not found.');
  return respond(context, { ...userElement(toView(found)), children: [] });
}

const userEndpoints = { getUsers, getUser };

export { userEndpoints, getUsers, getUser, toView };
export { decodeId, IdKind, el };
