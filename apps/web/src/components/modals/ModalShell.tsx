import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * The overlay a modal renders into, and the only place a click-outside is handled.
 *
 * Ported from the reference project's `ModalShell` rather than written fresh, because the
 * parts that are easy to get wrong are the parts worth copying verbatim:
 *
 * - **The backdrop is a sibling of the panel, not its parent.** The panel sits in the same
 *   fixed container so `items-center` centres the pair, and a click on the container closes
 *   while a click on the panel stops propagation. Nesting the panel inside a clickable
 *   backdrop is the arrangement where a stray click inside the dialog closes it — which for a
 *   Danger Zone means an operator loses the phrase they were typing.
 * - **It portals to `document.body`.** Rendered in place, a modal inside a `Card` is clipped
 *   by the card's own stacking context, and the Danger Zone is exactly that shape: one card
 *   holding every destructive row.
 *
 * `ModalHeader`, `ModalBody`, `ModalRow`, `ModalEmpty` and `WIDE_MODAL_CLASS` from the
 * reference are deliberately **not** ported. Every one is an export with no caller here, and
 * an export nothing calls is a second vocabulary to keep in sync — the rule
 * `apps/web/AGENTS.md` records about `lib/locale.ts` and `unwrapList`, which were documented,
 * found absent, and deleted rather than satisfied.
 */
function ModalShell({
  onClose,
  children,
  widthClass = 'w-80',
  ariaLabel,
}: {
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
  ariaLabel?: string;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="fixed inset-0 bg-black/60" />
      <div
        className={`relative bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-2xl shadow-2xl ${widthClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export { ModalShell };
