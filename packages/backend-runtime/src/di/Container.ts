/**
 * A request's registry of already-constructed services.
 *
 * ### What this is, precisely
 *
 * A `Map<symbol, unknown>` with a fluent setter. `bindValue` is the only registration
 * this codebase uses — all **thirty** bindings in `createRequestScope`, and
 * `createScanWorkerScope` is a one-line delegation to it — so the container's *factory*
 * tier is unreachable and the
 * "Factory + Singleton scopes" claim in the old header was describing a capability the
 * composition root never used.
 *
 * That capability was deleted rather than kept. Every other member was also dead:
 * `bind` had no caller, so `get`'s factory lookup, its "no binding for token" throw, its
 * invocation and its memoization were all unreachable; `resolve` was not a transient
 * resolver at all, because with an empty factory map it is an alias for `get`; `has`,
 * `createChild` and `dispose` had no callers. That was 23 of 33 instrumented statements.
 *
 * ### Why it is a container and not a plain map
 *
 * Because the reachability check is worth keeping. `Tokens` is `satisfies
 * Record<string, Token<unknown>>`, so a *misspelled* token name is a compile error — but
 * a correctly-spelled token that was never bound is not, and the only runtime diagnostic
 * for that was the throw on the unreachable line. It is asserted instead, which is a
 * stronger guarantee: the test reads the registry and fails for a token nothing binds, at
 * import time of the test run rather than at 3am on a request.
 *
 * ### Why the DAO tokens are thunks
 *
 * `Tokens.SongDAO` is typed `Token<() => Promise<SongDAO>>` and called as a thunk, so the
 * DAO is built on first use and a request that never touches songs never opens the
 * connection. Laziness is the point; singleton identity is deliberately *not* preserved
 * across two `get` calls for a thunk token, because the value cached by `bindValue` is the
 * thunk, not its result.
 */
type Token<T = unknown> = (string | symbol) & { readonly __type?: T };

class Container {
  private readonly bindings = new Map<Token<unknown>, unknown>();
  private readonly registered = new Set<Token<unknown>>();

  public bindValue<T>(token: Token<T>, value: T): this {
    this.bindings.set(token, value);
    this.registered.add(token);
    return this;
  }

  /**
  The token's value, or a throw naming it.
  *
  * The throw is the reachability check, and it names the token: a correct token that was
  * never bound used to produce `undefined` flowing into a service and a `TypeError` several
  * frames away, with nothing saying which registration was missing. `Symbol(X)` is the
  * useful part — every real token is a `Symbol('Name')`, so the message carries the name.
  */
  public get<T>(token: Token<T>): T {
    if (!this.registered.has(token)) {
      throw new Error(`DI container has no binding for token: ${String(token)}`);
    }
    return this.bindings.get(token) as T;
  }
}

export { Container };
export type { Token };