import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

type ToastFn = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<ToastFn>(() => {});

const TONE_CLASSES: Record<ToastTone, string> = {
  success: "border-ok/40 text-ink",
  error: "border-danger/50 text-ink",
  info: "border-line-strong text-ink",
};

const TONE_DOT: Record<ToastTone, string> = {
  success: "bg-ok",
  error: "bg-danger",
  info: "bg-accent",
};

const AUTO_DISMISS_MS = 4500;

/** Hand-rolled toasts: top-right stack, auto-dismiss, click to dismiss. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    (message, tone = "info") => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-4), { id, message, tone }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed top-4 right-4 z-[60] flex w-80 flex-col gap-2"
      >
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`toast-${t.tone}`}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-panel/95 px-3.5 py-3 text-left text-[13px] leading-snug shadow-xl shadow-black/40 backdrop-blur transition-opacity ${TONE_CLASSES[t.tone]}`}
          >
            <span
              aria-hidden
              className={`mt-1 size-2 shrink-0 rounded-full ${TONE_DOT[t.tone]}`}
            />
            <span className="break-words">{t.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastContext);
}
