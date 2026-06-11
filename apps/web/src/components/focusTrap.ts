/** Shared Tab-trapping for dialog surfaces (Modal, Drawer). */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Keeps Tab / Shift+Tab cycling within `panel` (WCAG dialog semantics).
 * Call from a keydown listener; no-op for non-Tab keys. If the panel has
 * no focusable children, focus stays parked on the panel itself.
 */
export function trapTabKey(panel: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") {
    return;
  }
  const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (first === undefined || last === undefined) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof Node && panel.contains(active);
  if (e.shiftKey) {
    if (!inside || active === first) {
      e.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    e.preventDefault();
    first.focus();
  }
}
