/**
 * The middleware barrel.
 *
 * The worker imports everything from here rather than reaching into individual
 * modules, so the set of installed middleware is one list instead of one per import
 * line. It was previously exported but imported by nobody, which meant it could drift
 * from what the worker actually wired without anything noticing.
 */
export { scopeMiddleware } from './scopeMiddleware';
export { userAuthentication, userAuthenticationHandler } from './userAuth';
export { rateLimit, resetRateLimitForTests, clientIp, getRateLimitBucketCountForTests } from './rateLimit';
export { RATE_LIMIT_DEFS, registerRestRateLimits, registerUserRateLimits } from './rateLimitConfig';
export type { RateLimitDef, LimitSurface } from './rateLimitConfig';
export { securityHeaders, SECURITY_HEADERS, isSensitiveJsonPath, applySecurityHeaders } from './securityHeaders';
