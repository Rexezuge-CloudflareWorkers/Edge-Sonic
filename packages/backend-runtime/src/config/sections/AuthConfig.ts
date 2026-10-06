import { EnvParser } from '../EnvParser';
import { DEFAULT_DEMO_USER_EMAIL, DEFAULT_ENVIRONMENT } from '../ConfigurationDefaults';

/**
 * The only ENVIRONMENT values that may honor an authentication bypass.
 * Anything else — including values that merely look non-production — is
 * treated as production and refuses the bypass.
 */
const BYPASS_ALLOWED_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'dev', 'local', 'test']);

// Auth / environment identity. Centralizes TEAM_DOMAIN/POLICY_AUD/DEV+DEMO vars.
class AuthConfig {
  constructor(private readonly env: unknown) {}

  public getEnvironment(): string {
    const raw = EnvParser.string(this.env, 'ENVIRONMENT', DEFAULT_ENVIRONMENT);
    const normalized = raw.trim().toLowerCase();
    return normalized === '' ? DEFAULT_ENVIRONMENT : normalized;
  }

  /**
   * Allow-list of environments where the DEMO_MODE / DEV_AUTH_EMAIL bypasses
   * may authenticate a request.
   *
   * This is deliberately an allow-list rather than `!== 'production'`. A
   * deny-list treats every typo and every future environment name as
   * "development": `staging`, `prod`, `Preview` and a misspelled
   * `prodcution` would all enable a bypass that authenticates every
   * unauthenticated request as a fixed identity — a full account takeover
   * triggered by one word of configuration. Unknown values must fail closed.
   */
  public isBypassAllowed(): boolean {
    return BYPASS_ALLOWED_ENVIRONMENTS.has(this.getEnvironment());
  }

  public isDemoMode(): boolean {
    return EnvParser.boolean(this.env, 'DEMO_MODE', 'false');
  }

  public getDevAuthEmail(): string | null {
    const value = EnvParser.string(this.env, 'DEV_AUTH_EMAIL', '');
    return value === '' ? null : value;
  }

  /**
   * Never null: `DEMO_MODE` needs an identity to answer with, so the default *is* the
   * answer rather than an absence of one. A default is not an absence — see the
   * `Authorized` tri-state in the SPA for the same rule on the other side.
   */
  public getDemoUserEmail(): string {
    const value = EnvParser.string(this.env, 'DEMO_USER_EMAIL', DEFAULT_DEMO_USER_EMAIL).trim();
    return value === '' ? DEFAULT_DEMO_USER_EMAIL : value.toLowerCase();
  }

  public getTeamDomain(): string | null {
    const value = EnvParser.string(this.env, 'TEAM_DOMAIN', '');
    return value === '' ? null : value;
  }

  public getPolicyAud(): string | null {
    const value = EnvParser.string(this.env, 'POLICY_AUD', '');
    return value === '' ? null : value;
  }
}

export { AuthConfig };
