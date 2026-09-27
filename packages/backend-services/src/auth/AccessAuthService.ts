/**
 * Cloudflare Access authentication, for the **admin API only**.
 *
 * ### It does not authenticate Subsonic clients
 *
 * `/rest/*` is authenticated by `SubsonicAuthService` against the `users` table,
 * because a Subsonic client can only speak `u` + `t` + `s` and has no way to
 * present an Access cookie. This service guards `/admin/*` — the human-facing
 * surface for registering libraries and users — where the operator is a person
 * already behind an Access policy.
 *
 * Keeping the two separate is a security property, not a convenience: an
 * operator's Access identity must not be usable as a Subsonic credential, or
 * "who can administer the server" and "who can stream the music" become the same
 * question.
 */
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { UnauthorizedError } from '@edge-sonic/backend-errors';
import { isValidEmailFormat } from '@edge-sonic/shared/utils';

interface AccessAuthEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  ENVIRONMENT?: string;
}

interface AccessIdentityContext {
  access?: {
    getIdentity: () => Promise<{ email?: string | null; emailVerified?: boolean | null; email_verified?: boolean | null } | null>;
  };
}

const DEMO_USER_EMAIL = 'demo@edge-sonic.invalid';

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function isValidAuthEmail(raw: string): boolean {
  return raw !== '' && !/\s/.test(raw) && isValidEmailFormat(raw);
}

class AccessAuthService {
  /** Bounded LRU of JWKS resolvers, keyed by team domain. */
  private static readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  private static jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
    const normalized = trimTrailingSlashes(teamDomain.trim().toLowerCase());
    const cached = AccessAuthService.jwksCache.get(normalized);
    if (cached) {
      // Refresh recency so a rotating domain cannot flush a live one.
      AccessAuthService.jwksCache.delete(normalized);
      AccessAuthService.jwksCache.set(normalized, cached);
      return cached;
    }
    const created = createRemoteJWKSet(new URL(`${normalized}/cdn-cgi/access/certs`));
    if (AccessAuthService.jwksCache.size >= 10) {
      const oldest = AccessAuthService.jwksCache.keys().next().value;
      if (oldest !== undefined) AccessAuthService.jwksCache.delete(oldest);
    }
    AccessAuthService.jwksCache.set(normalized, created);
    return created;
  }

  constructor(private readonly env: AccessAuthEnv) {}

  public async getAuthenticatedUserEmail(request: Request, accessCtx?: AccessIdentityContext): Promise<string> {
    const config = AppConfiguration.fromEnv(this.env);
    const bypassAllowed = config.isBypassAllowed();

    // Bypasses first, and only when the environment allow-list permits them. The
    // allow-list is deliberately not `!== 'production'`: a deny-list would enable
    // the bypass for `staging`, `Preview`, and a misspelled `prodcution`.
    if (bypassAllowed) {
      if (config.isDemoMode()) return DEMO_USER_EMAIL;
      const dev = this.env.DEV_AUTH_EMAIL?.trim() ?? '';
      if (dev && isValidAuthEmail(dev)) return dev.toLowerCase();
    }

    const fromJwt = await this.fromJwt(request, config);
    if (fromJwt !== null) return fromJwt;

    const fromBinding = await this.fromBinding(accessCtx);
    if (fromBinding !== null) return fromBinding;

    // Single throw site: the JWT strategy already attempted verification and
    // failed soft, so re-verifying here would only double the JWK fetch.
    throw new UnauthorizedError('Cloudflare Access authentication failed.');
  }

  private async fromJwt(request: Request, config: AppConfiguration): Promise<string | null> {
    const teamDomain = config.getTeamDomain();
    const policyAud = config.getPolicyAud();
    if (!teamDomain || !policyAud) return null;
    try {
      return await AccessAuthService.verifyAccessJwt(request, teamDomain, policyAud);
    } catch {
      return null;
    }
  }

  private async fromBinding(accessCtx?: AccessIdentityContext): Promise<string | null> {
    const identity = await accessCtx?.access?.getIdentity?.().catch(() => null);
    // Fail closed on an unverified identity. The binding is trusted; an
    // unverified identity inside it must still not authenticate.
    if (identity?.emailVerified === false || identity?.email_verified === false) return null;
    const email = identity?.email?.trim().toLowerCase() ?? '';
    return isValidAuthEmail(email) ? email : null;
  }

  public static async verifyAccessJwt(request: Request, teamDomain?: string, policyAud?: string): Promise<string> {
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) throw new UnauthorizedError('No Cloudflare Access JWT token provided in request headers.');
    if (!teamDomain || !policyAud) throw new UnauthorizedError('Missing required JWT verification configuration.');

    const issuer = trimTrailingSlashes(teamDomain.trim()).toLowerCase();
    const audience = policyAud.trim();
    if (!audience) throw new UnauthorizedError('Missing required JWT verification configuration.');
    // Multiple audiences are not supported, and a comma-joined value would fail
    // inside `jwtVerify` with a message that reads like a bad signature.
    if (audience.includes(',')) throw new UnauthorizedError('Multiple JWT audiences are not supported. Configure a single POLICY_AUD value.');

    try {
      const { payload } = await jwtVerify(token, AccessAuthService.jwksFor(issuer), { issuer, audience });
      if (payload.email_verified === false) throw new UnauthorizedError('Cloudflare Access authentication failed.');
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (!isValidAuthEmail(email)) throw new UnauthorizedError('Cloudflare Access authentication failed.');
      return email;
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      // Every JWT failure collapses to one message. A detailed one ("signature
      // verification failed" vs "expired") tells an unauthenticated caller which
      // part of the token they got right.
      throw new UnauthorizedError('Cloudflare Access authentication failed.');
    }
  }
}

export { AccessAuthService, DEMO_USER_EMAIL };
export type { AccessAuthEnv, AccessIdentityContext };
