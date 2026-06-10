import type { ReactNode } from "react";

export type BadgeTone =
  | "accent"
  | "neutral"
  | "ok"
  | "info"
  | "danger"
  | "violet"
  | "cyan";

const TONES: Record<BadgeTone, string> = {
  accent: "bg-accent/10 text-accent border-accent/30",
  neutral: "bg-raised text-ink-dim border-line-strong",
  ok: "bg-ok/10 text-ok border-ok/30",
  info: "bg-info/10 text-info border-info/30",
  danger: "bg-danger/10 text-danger border-danger/30",
  violet: "bg-violet-400/10 text-violet-300 border-violet-400/30",
  cyan: "bg-cyan-400/10 text-cyan-300 border-cyan-400/30",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full border px-2 py-px text-[11px] leading-[18px] font-medium tracking-wide whitespace-nowrap ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const ROLE_TONES: Record<string, BadgeTone> = {
  admin: "accent",
  write: "info",
  read: "neutral",
  owner: "accent",
  member: "neutral",
};

export function RoleBadge({ role }: { role: string }) {
  return <Badge tone={ROLE_TONES[role] ?? "neutral"}>{role}</Badge>;
}
