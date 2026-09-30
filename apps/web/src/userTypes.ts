/**
 * User wire types for the user API.
 *
 * Nullable, not optional, for "the server may legitimately not know this" — the
 * same convention the worker uses. Optional is reserved for "this field is not
 * present at all".
 */

interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly email: string | null;
  readonly isAdmin: boolean;
  readonly isEnabled: boolean;
  readonly libraryIds: string[];
  readonly createdAt: number;
}

export type { UserSummary };
