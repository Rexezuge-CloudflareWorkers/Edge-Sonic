class EnvParser {
  public static positiveInt(env: unknown, key: string, defaultValue: string): number {
    const value = this.readString(env, key);
    const parsed = Number(value ?? defaultValue);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number(defaultValue);
  }

  /**
   * An integer that may be **zero**, for a setting where zero is a supported value.
   *
   * Distinct from {@link positiveInt} because the two are not interchangeable, and the
   * difference is a whole configuration rather than a detail: `TAG_READ_TAIL_BYTES=0`
   * disables the Ogg tail read, which that limit's own documentation calls "a supported
   * configuration and not a degraded one". Through `positiveInt` the `0` became the
   * default instead, so the setting silently did the opposite of what it said.
   *
   * It had no callers before `getTagReadTailBytes` was corrected to use it — a helper for a
   * value nobody could set, sitting beside the line that could not set it.
   */
  public static nonNegativeInt(env: unknown, key: string, defaultValue: string): number {
    const value = this.readString(env, key);
    const parsed = Number(value ?? defaultValue);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number(defaultValue);
  }

  public static isValidPositiveInt(env: unknown, key: string): boolean {
    const value = this.readString(env, key);
    if (value === undefined) return true;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0;
  }

  /**
   * Whether a var that permits zero holds a non-negative integer.
   *
   * The predicate for {@link nonNegativeInt}, beside it and for the same reason:
   * `AppConfiguration.validate()` must be able to *name* a bad value for a setting whose
   * zero is meaningful, and `isValidPositiveInt` would report `TAG_READ_TAIL_BYTES=0` as
   * invalid — so the setting that legitimately disables the tail read would generate a
   * warning about the one value that is correct.
   *
   * Absent is valid, because absent means the default is in force and the default is known.
   */
  public static isValidNonNegativeInt(env: unknown, key: string): boolean {
    const value = this.readString(env, key);
    if (value === undefined) return true;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0;
  }

  public static string(env: unknown, key: string, defaultValue: string): string {
    return this.readString(env, key) ?? defaultValue;
  }

  public static boolean(env: unknown, key: string, defaultValue: string): boolean {
    return (this.readString(env, key) ?? defaultValue) === 'true';
  }

  /**
   * Read one variable.
   *
   * Defensive about the env shape, because every caller's path is a fail-soft one: `env`
   * may be null or a partial object, and a TypeError here would replace a default with a
   * 500 — the exact failure this class exists to prevent, caused by the class that
   * prevents it.
   */
  private static readString(env: unknown, key: string): string | undefined {
    if (env === null || typeof env !== 'object') return undefined;
    const value = (env as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
}

export { EnvParser };
