import type { ReactNode } from "react";

/** Guidance-first empty state for fresh instances and empty tables. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-14 text-center"
    >
      <div
        aria-hidden
        className="flex size-10 items-center justify-center rounded-lg border border-line-strong bg-raised font-mono text-sm text-accent"
      >
        {"{}"}
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {body !== undefined && (
        <p className="max-w-sm text-[13px] leading-relaxed text-ink-dim">
          {body}
        </p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
