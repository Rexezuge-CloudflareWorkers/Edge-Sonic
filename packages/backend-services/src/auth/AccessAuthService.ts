/**
 * Cloudflare Access authentication, for the **user API only**.
 *
 * ### It does not authenticate Subsonic clients
 *
 * `/rest/*` is authenticated by `SubsonicAuthService` against the `users` table,
 * because a Subsonic client can only speak `u` + `t` + `s` and has no way to
 * present an Access cookie. This service guards `/user/*` — the human-facing
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
import type { AppConfiguration as AppConfigurationType } from '@edge-sonic/backend-runtime/config';
import { UnauthorizedError } from '@edge-sonic/backend-errors';
import { isValidEmailFormat } from '@edge-sonic/shared/utils';

/**
 * The identity the `ACCESS` binding reports.
 *
 * `getIdentity` resolves `undefined` — not `null` — when no Access application is in
 * front of the request, and Cloudflare has used both spellings of the verification
 * flag, so both are refused below.
 */
interface AccessIdentity {
  email?: string | null;
  emailVerified?: boolean | null;
  email_verified?: boolean | null;
}

/**
 * The `ACCESS` binding, as the platform provides it.
 *
 * Cloudflare provisions this binding for a Worker sitting behind an Access
 * application, and it therefore **cannot be declared in a wrangler config** — so
 * `wrangler types` never emits it and `worker-configuration.d.ts` has no `ACCESS`.
 * The shape is declared here rather than imported from the generated file, which a
 * Layer 3 package must not see in any case. Its absence is a supported state: a
 * deployment with no Access in front of it answers 401, not an open door.
 */
interface AccessBinding {
  getIdentity(): Promise<AccessIdentity | undefined>;
}

interface AccessAuthEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  ENVIRONMENT?: string;
  /**
   * The platform-provisioned Access binding. Never a wrangler declaration.
   */
  ACCESS?: AccessBinding;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function isValidAuthEmail(raw: string): boolean {
  return raw !== '' && !/\s/.test(raw) && isValidEmailFormat(raw);
}

class AccessAuthService {
  /**
  Bounded LRU of JWKS resolvers, keyed by team domain.
  */
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

  /**
   * `config` is injected rather than derived, so the request scope builds one
   * `AppConfiguration` per request instead of two. It is defaulted so a direct
   * construction (`new AccessAuthService(env)`) still works — every value is read
   * through the config either way, never inline off `env`.
   */
  constructor(
    private readonly env: AccessAuthEnv,
    private readonly config: AppConfigurationType = AppConfiguration.fromEnv(env),
  ) {}

  public async getAuthenticatedUserEmail(request: Request): Promise<string> {
    const config = this.config;
    const bypassAllowed = config.isBypassAllowed();

    // Bypasses first, and only when the environment allow-list permits them. The
    // allow-list is deliberately not `!== 'production'`: a deny-list would enable
    // the bypass for `staging`, `Preview`, and a misspelled `prodcution`.
    if (bypassAllowed) {
      // Through the config, never a literal here: the value is a variable, so a second
      // copy of it is a second answer to "who is the demo user".
      if (config.isDemoMode()) return config.getDemoUserEmail();
      // Read through the config, never `env.DEV_AUTH_EMAIL` inline: the config is the
      // only place that knows how a variable is parsed and defaulted.
      const dev = config.getDevAuthEmail()?.trim() ?? '';
      if (dev && isValidAuthEmail(dev)) return dev.toLowerCase();
    }

    const fromJwt = await this.fromJwt(request, config);
    if (fromJwt !== null) return fromJwt;

    const fromBinding = await this.fromBinding();
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

  /**
   * The `ctx.access` → `env.ACCESS` fallback.
   *
   * `undefined` is the platform's "no identity" answer and is handled by the same
   * optional chain as a throw: a rejected `getIdentity` resolves to `undefined` and
   * falls through to the single throw site, so a broken binding is a 401 rather than
   * an unhandled rejection in the auth middleware.
   */
  private async fromBinding(): Promise<string | null> {
    const identity = await this.env.ACCESS?.getIdentity().catch((error) => {
      // A rejected binding is a broken platform configuration, not "no identity".
      // Still a 401 (fail closed), but logged so transient faults are visible.
      console.debug('[AccessAuth] ACCESS binding getIdentity failed:', error);
      return undefined;
    });
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

export { AccessAuthService };
export type { AccessAuthEnv, AccessBinding, AccessIdentity };
