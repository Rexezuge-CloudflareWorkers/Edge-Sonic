/**
 * WebDAV target paths, shared by the upload script and its tests.
 */

/**
 * The base path when the operator sets none.
 *
 * Declared **here** and exported rather than repeated in `upload-webdav.ts`, which is
 * where the reference project has it twice. Two declarations of one default are free to
 * disagree, and the disagreement is invisible until a backup lands somewhere nobody is
 * looking — which is the one property a backup target must not have.
 */
export const DEFAULT_BASE_PATH = 'edge-sonic';

/**
 * The rclone remote name `upload-webdav.ts` configures from the environment.
 */
export const REMOTE = 'webdav';

/**
 * Where backups land on the remote, e.g. `webdav:edge-sonic/production`.
 */
export function remoteTargetDir(basePath: string): string {
  return `${REMOTE}:${basePath || DEFAULT_BASE_PATH}/production`;
}
