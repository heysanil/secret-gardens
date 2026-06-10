import { Link } from "react-router";
import { Wordmark } from "../components/Wordmark";

export function NotFoundPage() {
  return (
    <div className="auth-texture flex min-h-dvh flex-col items-center justify-center gap-5 p-6">
      <Wordmark />
      <p className="font-mono text-6xl font-bold text-ink-faint">404</p>
      <p className="text-sm text-ink-dim">This page doesn't exist.</p>
      <Link
        to="/"
        className="rounded-md text-sm font-medium text-accent hover:text-accent-bright"
      >
        Back to projects →
      </Link>
    </div>
  );
}
