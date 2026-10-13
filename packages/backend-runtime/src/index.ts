// The DI container, the worker bases, the request scope and the logger all live
// in `@rexezuge/runtime` now. What is exported here is what this repo still owns:
// its own configuration composition and its KV domain registry.
//
// `./di` used to re-export `Container` and a forked `RequestScope`. Both were dead
// in production — `createRequestScope` builds the kit's `Container`, and
// `scopeMiddleware` and `BaseRoute` both call the kit's `getRequestScope` — and the
// only thing still importing them was `test/alias-table.int.test.ts`, which asserted
// that an alias resolves. The fork also carried a different `SCOPE_KEY` from the
// kit's, so it could never have been used with a kit-installed scope anyway.
export * from './base';
export * from './config';
export * from './kv';
