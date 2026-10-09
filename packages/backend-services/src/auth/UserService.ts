/**
 * Creating a user, and the password it is created with.
 *
 * ### Why this is a service and not a route
 *
 * Because the route was reaching into another package to encrypt a password, and the way it did
 * so was a hole in the layer gate rather than an exception to it. `apps/api` may not import
 * `backend-data`'s values — `LibraryService` owns the WebDAV credential for exactly this reason —
 * so the encryption was reached through `await import('@edge-sonic/backend-data/crypto')`.
 *
 * And that import was invisible to the rule meant to prevent it. `no-restricted-imports` reads
 * `ImportDeclaration` nodes; a dynamic `import()` is an `ImportExpression`, and the rule does not
 * report it at all. So the boundary held for every syntax except the one in use, on the one path
 * that should never have needed it. The rule is now closed for dynamic imports too
 * (`eslint.config.mjs`), so this is the fix rather than a suppression.
 *
 * The rest of the service is the other half of the same decision: **the key never crosses the
 * boundary**. `UserKey` is resolved by the composition root and read here, where the credential
 * is produced, so a caller outside this package cannot encrypt a user password with the
 * application key — and there is exactly one implementation of "encrypt a user's password", which
 * is what `LibraryService` says about the DAV one for the same reason.
 */
import { encryptData } from '@edge-sonic/backend-data/crypto';
import type { UserRow } from '@edge-sonic/backend-data/dao';
import { ConflictError } from '@edge-sonic/backend-errors';

/**
What a caller supplies to create a user. The password is plaintext and never stored as such.
*/
export interface CreateUserInput {
  username: string;
  password: string;
  /**
  `null` for "no email given", which is what `BaseRoute.optionalString` answers.
  */
  email?: string | null;
  isAdmin?: boolean;
}

/**
 * The user writes this service needs, as a **port**.
 *
 * A port rather than a `UserDAO` for the same reason `SubsonicAuthService` has one: DAO tokens
 * are thunks, so a service holding a resolved DAO would capture the one built for the first
 * request. Holding functions means the DAO is built when the call happens.
 */
export interface UserStore {
  findByUsername(username: string): Promise<UserRow | null>;
  create(input: {
    username: string;
    passwordCiphertext: string;
    passwordIv: string;
    /**
    `null` for "no email given", which is what the DAO writes as `NULL`.
    */
    email?: string | null;
    isAdmin: boolean;
  }): Promise<UserRow>;
}

/**
Resolves the application key, once per request, from the composition root.
*/
type UserKeyResolver = () => Promise<string>;

class UserService {
  constructor(
    private readonly users: UserStore,
    private readonly resolveKey: UserKeyResolver,
  ) {}

  /**
   * Create a user, or refuse with `409` when the name is taken.
   *
   * The duplicate check is here rather than left to the DAO because the answer is a **conflict**
   * and not a database error: `INSERT OR IGNORE` on `username_ci` would otherwise produce a
   * success response for a row that was never written, so two registrations of the same name would
   * answer `201` and `201` while the second user did not exist.
   */
  public async create(input: CreateUserInput): Promise<UserRow> {
    if (await this.users.findByUsername(input.username)) {
      throw new ConflictError('A user with that username already exists.');
    }

    const key = await this.resolveKey();
    const encrypted = await encryptData(input.password, key);

    return await this.users.create({
      username: input.username,
      passwordCiphertext: encrypted.ciphertext,
      passwordIv: encrypted.iv,
      email: input.email,
      isAdmin: input.isAdmin ?? false,
    });
  }
}

export { UserService };
