import { useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import { ModalShell } from './ModalShell';

/**
 * The second of the two confirmations, and the one that makes the first mean something.
 *
 * ### What it is guarding, specifically
 *
 * The Danger Zone's buttons fire on a single click, which is the pattern every destructive
 * button on this surface already used before there was a Danger Zone — including
 * `deleteLibrary`, which cascades a whole index away. One click cannot be the gate for an
 * irreversible action, because the click is the thing that happens by accident: a row of
 * similar buttons, a mis-registered mouse, a trackpad.
 *
 * So the first click *arms* and the second one requires typing the name of the thing being
 * destroyed. Two properties make that a real gate rather than a delay:
 *
 * - **The phrase is the thing itself.** `expectedName` is the library slug, so the operator
 *   has to read and retype what they are about to lose; a generic "type DELETE" would be a
 *   two-second ritual anyone passes through without reading the dialog.
 * - **The confirm button is disabled, not hidden, until the phrase matches.** Hidden would
 *   remove the affordance and leave the operator hunting for what to do; disabled says the
 *   requirement and leaves it visible. `input.trim()` on both sides, because a trailing space
 *   from a mobile keyboard is not a mismatch of intent.
 *
 * ### What this component deliberately does not do
 *
 * **It does not decide what the phrase is.** The caller passes it, and for the global action
 * the phrase is a literal rather than a library name — there is nothing in the request to
 * name, so the operator types the fact that *everything* is what goes. A component that
 * derived the phrase from props would have that decision inside a file that is otherwise
 * markup, where it could not be tested from the root suite.
 *
 * **It does not fetch, and it does not confirm server-side.** Every caller of `/user/*` is
 * already an operator — Cloudflare Access is the authorization boundary — so a second gate
 * here is a speed bump with no second authority behind it. What the modal owes is to make the
 * operator *read*, and the cost figures are in the body it renders.
 */
function TypeToConfirmModal({
  title,
  description,
  expectedName,
  confirmLabel,
  onConfirm,
  onCancel,
  loading = false,
  cost,
}: {
  title: string;
  description: string;
  /**
   * The exact string the operator must type. For a per-library drop this is the library's
   * slug, which is unique per `idx_libraries_slug_ci` — so the phrase identifies one library
   * and cannot be satisfied by another library's.
   */
  expectedName: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  /**
   * What the action will cost, in rows D1 bills.
   *
   * Passed in rather than formatted here, because the figure is the server's — it comes from
   * `GET /user/index/stats`, which projects it with the same `billedRowsForTable` that will
   * charge the delete. A component that computed `songs * 10` would be a second copy of the
   * per-table arithmetic in the one layer that cannot see the table it is quoting.
   *
   * Rendered **above** the input and not below the confirm button, because the number is the
   * reason to read the dialog and it has to be on screen before the confirm button is armed.
   */
  cost?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);

  const matched = input.trim() === expectedName;

  /**
   * Copy the phrase, and never fail.
   *
   * `navigator.clipboard` is absent on an insecure origin and denied without a user gesture in
   * some browsers, and a copy button that throws is worse than one that does nothing — so the
   * rejection is swallowed and the checkmark still shown. The operator can select the text
   * with the caret; a thrown error would leave them with no way to do either.
   */
  const handleCopy = () => {
    const clipboard = globalThis.navigator?.clipboard as Clipboard | undefined;
    if (clipboard) {
      void clipboard.writeText(expectedName).catch(() => undefined);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
  };

  return (
    <ModalShell onClose={onCancel} widthClass="w-full max-w-md mx-4" ariaLabel={title}>
      <div className="p-6">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-error-bg)] mb-4 mx-auto">
          <AlertTriangle className="h-5 w-5 text-[var(--color-error-text)]" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] text-center mb-2">{title}</h2>
        <p className="text-sm text-[var(--color-text-secondary)] text-center mb-4">{description}</p>
        <div className="flex items-center justify-center gap-2 mb-4">
          <code className="px-2.5 py-1.5 rounded-lg bg-[var(--color-surface-base)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] break-all">
            {expectedName}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            title={t('common.copyToClipboard', 'Copy to clipboard')}
            aria-label={t('common.copyToClipboard', 'Copy to clipboard')}
            className="px-2.5 py-2 rounded-lg bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors duration-150"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-[var(--color-success-text)]" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
        {cost}
        <div className="space-y-1.5 mb-6">
          <Label htmlFor="danger-confirm-input">{t('common.typeToConfirm', 'Type {{name}} to confirm', { name: expectedName })}</Label>
          <Input
            id="danger-confirm-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={expectedName}
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="flex gap-3">
          {/*
            `stopPropagation` on both buttons, because the shell closes on a click anywhere in
            the container. Without it a click on Cancel would fire `onCancel` twice — harmless
            today, and exactly the kind of double-call that becomes a double `DELETE` the first
            time either handler is made idempotent-unsafe.
          */}
          <Button
            variant="ghost"
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            disabled={!matched}
            loading={loading}
            onClick={(e) => {
              e.stopPropagation();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * How long the copy button shows its checkmark.
 *
 * In this module rather than `lib/constants.ts` because nothing else on this surface copies
 * anything, and a constant in a shared file with one caller is a constant that describes the
 * wrong scope.
 */
const COPY_FEEDBACK_TIMEOUT_MS = 1500;

export { TypeToConfirmModal };
