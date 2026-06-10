import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "./auth";
import { Skeleton } from "./components/Skeleton";
import { Wordmark } from "./components/Wordmark";
import { useBootstrap } from "./queries";

function FullScreenLoading() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <Wordmark />
      <Skeleton className="h-1.5 w-40" />
    </div>
  );
}

/** Fresh instances are forced to /setup until the first admin exists. */
export function BootstrapGate() {
  const bootstrap = useBootstrap();
  const location = useLocation();

  if (bootstrap.isPending) {
    return <FullScreenLoading />;
  }
  if (bootstrap.data?.needsSetup === true && location.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }
  return <Outlet />;
}

/** Everything outside /login and /setup requires a session. */
export function RequireSession() {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return <FullScreenLoading />;
  }
  if (!session) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

/** Validates ?next= targets so /login can't be used as an open redirect. */
export function safeNextPath(raw: string | null): string {
  if (raw?.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "/";
}
