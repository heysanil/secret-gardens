import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { trapTabKey } from "./focusTrap";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  testId?: string;
}

/**
 * Right-hand slide-over (version history). Escape and backdrop close it;
 * Tab is trapped within the panel while open.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  testId,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (panelRef.current !== null) {
        trapTabKey(panelRef.current, e);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close panel"
        tabIndex={-1}
        className="absolute inset-0 size-full cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-md px-1.5 text-lg leading-none text-ink-faint transition-colors hover:text-ink"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
