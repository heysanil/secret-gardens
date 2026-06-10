import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Width utility, e.g. "max-w-md". */
  width?: string;
  testId?: string;
}

/**
 * Centered dialog: portal, Escape closes, backdrop click closes, focus
 * moves into the panel on open and back to the opener on close.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-md",
  testId,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    if (panel !== null) {
      const target = panel.querySelector<HTMLElement>(
        "input, textarea, select, button:not([data-modal-close])",
      );
      (target ?? panel).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const restore = restoreRef.current;
      if (restore instanceof HTMLElement) {
        restore.focus();
      }
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; Escape handles keyboard dismissal
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className={`w-full ${width} rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/50`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            data-modal-close
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md px-1.5 text-lg leading-none text-ink-faint transition-colors hover:text-ink"
          >
            ×
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
