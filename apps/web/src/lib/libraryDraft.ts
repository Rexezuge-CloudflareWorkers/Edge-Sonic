/**
 * The editable fields of a library, and the one rule about the password.
 *
 * Extracted from the view so the create form, the edit form, and the API client
 * agree on a single shape — and so the rule that makes an edit non-destructive is
 * stated once, next to the code that enforces it, rather than as a comment inside
 * a form.
 */

/**
What the operator typed.
*/
interface LibraryDraft {
  readonly slug: string;
  readonly baseUrl: string;
  readonly rootPath: string;
  readonly davUsername: string;
  readonly davPassword: string;
  readonly displayName: string;
}

/**
The PATCH body. Both trailing fields are **absent**, not empty, when the operator
did not type one — which is exactly the contract `BaseRoute.optionalString`
implements on the receiving end, so "absent" and "present" are the only two states
that exist.

### Why the password has to be absent rather than empty

`BaseRoute.updateLibrary` calls `setPassword` only when `davPassword` is present.
Sending `''` instead would therefore re-encrypt an empty password over a working
one and break every future scan for that library — with nothing in the response to
say so, and with the operator's next symptom being a scan failure they have no
reason to connect to a form they did not submit. `test/user-api.test.ts` asserts
the absent case preserves the stored ciphertext; this is the client half of the
same rule.
*/
interface LibraryPatch {
  readonly slug: string;
  readonly baseUrl: string;
  readonly rootPath: string;
  readonly davUsername: string;
  readonly davPassword?: string;
  readonly displayName?: string;
}

/**
Build a PATCH body from the form.

Trimmed before the emptiness test, so a stray space cannot be mistaken for a new
password and silently replace a working one.
*/
function toPatch(draft: LibraryDraft): LibraryPatch {
  const password = draft.davPassword.trim();
  const displayName = draft.displayName.trim();
  return {
    slug: draft.slug.trim(),
    baseUrl: draft.baseUrl.trim(),
    rootPath: draft.rootPath.trim(),
    davUsername: draft.davUsername.trim(),
    ...(password.length > 0 && { davPassword: password }),
    ...(displayName.length > 0 && { displayName }),
  };
}

export { toPatch };
export type { LibraryDraft, LibraryPatch };
