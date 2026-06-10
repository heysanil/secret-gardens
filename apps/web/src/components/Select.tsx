import type { SelectHTMLAttributes } from "react";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/** Styled native select — keyboard and screen-reader behavior for free. */
export function Select({ className = "", children, ...rest }: SelectProps) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        className="w-full cursor-pointer appearance-none rounded-md border border-line-strong bg-bg py-1.5 pr-8 pl-3 text-sm text-ink transition-colors duration-100 focus:border-accent focus:outline-none disabled:opacity-50"
        {...rest}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[10px] text-ink-faint"
      >
        ▾
      </span>
    </span>
  );
}
