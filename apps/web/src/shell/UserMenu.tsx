import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

/** Bottom-of-sidebar user block with a small pop-up menu. */
export function UserMenu({
  name,
  email,
  roleBadge,
  onSignOut,
}: {
  name: string;
  email: string;
  roleBadge: ReactNode;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-lg border border-line-strong bg-raised shadow-xl shadow-black/40"
        >
          <Link
            to="/account/tokens"
            role="menuitem"
            data-testid="user-menu-tokens"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            Account tokens
          </Link>
          <button
            type="button"
            role="menuitem"
            data-testid="user-menu-signout"
            onClick={onSignOut}
            className="block w-full px-3 py-2 text-left text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        data-testid="user-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[13px] font-semibold text-accent uppercase"
        >
          {(name || email).slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{name}</span>
            {roleBadge}
          </span>
          <span className="block truncate text-[12px] text-ink-faint">
            {email}
          </span>
        </span>
      </button>
    </div>
  );
}
