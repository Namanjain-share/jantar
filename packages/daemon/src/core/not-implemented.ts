/**
 * What a stub throws while its part is not built yet.
 * The API answers it with 501 not_implemented, so a route that reaches an
 * unbuilt part says so instead of failing with 500.
 */
export class NotImplementedError extends Error {
  constructor(readonly what: string) {
    super(`${what} is not built yet`);
    this.name = 'NotImplementedError';
  }
}

/**
 * v0.4: a stand-in object for a part or module not built yet: every method
 * throws NotImplementedError (the API's 501), except the members given in
 * `fixed`. WP0's Life and Intel stubs are made with it; the package that
 * builds the real one replaces the stub file.
 */
export function notBuilt<T extends object>(what: string, fixed: Partial<T> = {}): T {
  return new Proxy(fixed as T, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      // Not a thenable: `await notBuilt(...)` must not call `then`.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return () => {
        throw new NotImplementedError(what);
      };
    },
  });
}
