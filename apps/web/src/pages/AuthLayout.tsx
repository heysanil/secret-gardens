import type { ReactNode } from "react";
import { Wordmark } from "../components/Wordmark";

/** Centered card chrome shared by /login and /setup. */
export function AuthLayout({
  heading,
  sub,
  children,
  footer,
}: {
  heading: string;
  sub?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-texture flex min-h-dvh flex-col items-center justify-center p-6">
      <div className="mb-8 flex flex-col items-center gap-2">
        <Wordmark size="lg" />
        <p className="text-[13px] tracking-wide text-ink-faint">
          self-hosted secrets manager
        </p>
      </div>
      <div className="w-full max-w-sm rounded-xl border border-line-strong bg-panel/90 p-6 shadow-2xl shadow-black/40 backdrop-blur">
        <h1 className="text-lg font-semibold">{heading}</h1>
        {sub !== undefined && (
          <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">{sub}</p>
        )}
        <div className="mt-5">{children}</div>
      </div>
      {footer !== undefined && (
        <div className="mt-6 text-[13px] text-ink-faint">{footer}</div>
      )}
    </div>
  );
}
