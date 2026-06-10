import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-black font-semibold hover:bg-accent-bright active:bg-accent disabled:bg-accent/40",
  secondary:
    "bg-raised text-ink border border-line-strong hover:bg-hover disabled:text-ink-faint",
  ghost: "text-ink-dim hover:text-ink hover:bg-hover disabled:text-ink-faint",
  danger:
    "bg-danger/10 text-danger border border-danger/40 hover:bg-danger/20 disabled:opacity-50",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center rounded-md whitespace-nowrap transition-colors duration-100 disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
