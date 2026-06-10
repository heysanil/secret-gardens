import { useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { useToast } from "./Toast";

export interface CopyButtonProps {
  /** The text to copy, or an async getter (lets rows fetch values lazily). */
  value: string | (() => Promise<string | null>);
  label?: string;
  testId?: string;
  className?: string;
}

/** Small icon button: copies, flashes a check, raises a toast. */
export function CopyButton({
  value,
  label = "Copy",
  testId,
  className = "",
}: CopyButtonProps) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);

  async function onCopy() {
    const text = typeof value === "function" ? await value() : value;
    if (text === null) {
      return;
    }
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      toast("Copied to clipboard", "success");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast("Could not access the clipboard", "error");
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={`inline-flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors duration-100 hover:bg-hover hover:text-ink ${className}`}
    >
      {copied ? (
        <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 fill-ok">
          <title>Copied</title>
          <path d="M6.5 12.2 2.8 8.5l1-1 2.7 2.6 5.7-5.7 1 1z" />
        </svg>
      ) : (
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="size-3.5 fill-none stroke-current stroke-[1.3]"
        >
          <title>{label}</title>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </svg>
      )}
    </button>
  );
}
