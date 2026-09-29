import { useState } from 'react';
import { t } from 'i18next';
import { Button, Input, Label } from './ui/controls';
import type { LibraryDraft } from '../lib/libraryDraft';
import type { LibrarySummary } from '../types';

/**
 * One form, two modes.
 *
 * Create and edit were separate concerns only because the edit path was never
 * built: `PATCH /user/libraries/:id` and `updateLibrary` have both existed since
 * the surface was written, and nothing called them. The consequence was that a
 * rejected WebDAV password — the single most likely probe failure, and the one the
 * server now names explicitly — could only be fixed by deleting the library, which
 * cascades the whole index away. An operator fixing a typo should not lose their
 * scan to do it.
 *
 * ### The password field is the reason this is shared rather than duplicated
 *
 * `davPassword` is sent **only when the operator typed something**. The server's
 * `updateLibrary` skips `setPassword` when the field is absent (asserted in
 * `test/user-api.test.ts`), so an edit that leaves the password blank preserves
 * the stored credential. Sending `''` instead would re-encrypt an empty password
 * and silently break every future scan for that library — the same class of
 * destruction the empty-patch case already guarded against on the server.
 */

interface LibraryFormProps {
  /**
  The library being edited, or absent when creating one.

  Absent rather than optional-and-empty on purpose: `undefined` means "create" and
  an object means "edit this exact row", and a form that can be in the second state
  with no row behind it cannot prefill or address the PATCH.
  */
  readonly library?: LibrarySummary;
  readonly busy: boolean;
  readonly onSubmit: (draft: LibraryDraft) => void;
  readonly onCancel: () => void;
}

/**
An empty draft, with `rootPath` defaulted the way the server defaults it.
*/
function emptyDraft(): LibraryDraft {
  return { slug: '', baseUrl: '', rootPath: '/', davUsername: '', davPassword: '', displayName: '' };
}

/**
Prefill from the row. The password is deliberately **not** prefilled: the server
never returns it, so there is nothing to show and a blank field means "unchanged".
*/
function draftFrom(library: LibrarySummary): LibraryDraft {
  return {
    slug: library.slug,
    baseUrl: library.baseUrl,
    rootPath: library.rootPath,
    davUsername: library.davUsername,
    davPassword: '',
    displayName: library.displayName ?? '',
  };
}

function LibraryForm({ library, busy, onSubmit, onCancel }: LibraryFormProps) {
  const [draft, setDraft] = useState<LibraryDraft>(() => (library === undefined ? emptyDraft() : draftFrom(library)));
  const editing = library !== undefined;

  return (
    <form
      className="mb-4 grid gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <div>
        <Label htmlFor="slug">{t('libraries.field.slug', 'Slug')}</Label>
        <Input id="slug" required value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="home" />
      </div>
      <div>
        <Label htmlFor="displayName">{t('libraries.field.displayName', 'Display name')}</Label>
        <Input
          id="displayName"
          value={draft.displayName}
          onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          placeholder="Home"
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="baseUrl">{t('libraries.field.baseUrl', 'WebDAV origin')}</Label>
        <Input
          id="baseUrl"
          required
          type="url"
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          placeholder="https://dav.example.com"
        />
      </div>
      <div>
        <Label htmlFor="rootPath">{t('libraries.field.rootPath', 'Root path inside the origin')}</Label>
        <Input
          id="rootPath"
          value={draft.rootPath}
          onChange={(e) => setDraft({ ...draft, rootPath: e.target.value })}
          placeholder="/remote.php/dav/files/alice/Music"
        />
      </div>
      <div>
        <Label htmlFor="davUsername">{t('libraries.field.davUsername', 'WebDAV username')}</Label>
        <Input
          id="davUsername"
          required
          value={draft.davUsername}
          onChange={(e) => setDraft({ ...draft, davUsername: e.target.value })}
          autoComplete="off"
        />
      </div>
      <div>
        <Label htmlFor="davPassword">{t('libraries.field.davPassword', 'WebDAV password')}</Label>
        <Input
          id="davPassword"
          // Required on create, optional on edit: an empty edit field means
          // "leave the stored credential alone", which the server honours.
          required={!editing}
          type="password"
          value={draft.davPassword}
          onChange={(e) => setDraft({ ...draft, davPassword: e.target.value })}
          autoComplete="new-password"
          placeholder={editing ? t('libraries.field.davPasswordUnchanged', 'Unchanged — type to replace') : undefined}
        />
      </div>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="primary" loading={busy}>
          {editing ? t('libraries.saveChanges', 'Save changes') : t('libraries.save', 'Save')}
        </Button>
        <Button onClick={onCancel}>{t('libraries.cancel', 'Cancel')}</Button>
      </div>
    </form>
  );
}

export { LibraryForm, emptyDraft, draftFrom };
export type { LibraryFormProps };
