/** Pure time formatting — unit-tested, no Date.now() reads of its own. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Compact relative timestamps for tables: "just now", "5m ago", "3h ago",
 * "2d ago", "4w ago", then an absolute date. Small future skew (client
 * clock ahead of server) clamps to "just now".
 */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 45_000) {
    return "just now";
  }
  if (diff < 90_000) {
    return "1m ago";
  }
  if (diff < HOUR) {
    return `${Math.round(diff / MINUTE)}m ago`;
  }
  if (diff < DAY) {
    return `${Math.round(diff / HOUR)}h ago`;
  }
  if (diff < WEEK) {
    return `${Math.round(diff / DAY)}d ago`;
  }
  if (diff < 5 * WEEK) {
    return `${Math.round(diff / WEEK)}w ago`;
  }
  return formatDate(ts);
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Full timestamp for title attributes and detail views. */
export function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
