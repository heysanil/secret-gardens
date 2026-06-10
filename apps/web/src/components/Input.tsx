import {
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useId,
} from "react";

const FIELD_CLASSES =
  "w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm text-ink placeholder:text-ink-faint transition-colors duration-100 focus:border-accent focus:outline-none disabled:opacity-50";

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** Label + control + hint/error wiring (htmlFor/aria-describedby). */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const hasNote = Boolean(error) || Boolean(hint);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-dim">
        {label}
      </label>
      {children(id, hasNote ? hintId : undefined)}
      {error ? (
        <p id={hintId} className="text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[13px] text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export function Input({ mono = false, className = "", ...rest }: InputProps) {
  return (
    <input
      className={`${FIELD_CLASSES} ${mono ? "font-mono text-[13px] tabular-nums" : ""} ${className}`}
      {...rest}
    />
  );
}

export interface AutoTextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

/** Single-row textarea that grows with its content (multiline secrets). */
export function AutoTextarea({
  mono = true,
  className = "",
  rows = 1,
  ...rest
}: AutoTextareaProps) {
  const ref = useCallback((el: HTMLTextAreaElement | null) => {
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    }
  }, []);
  return (
    <textarea
      ref={ref}
      rows={rows}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight + 2}px`;
      }}
      className={`${FIELD_CLASSES} resize-none overflow-hidden leading-relaxed ${mono ? "font-mono text-[13px] tabular-nums" : ""} ${className}`}
      {...rest}
    />
  );
}
