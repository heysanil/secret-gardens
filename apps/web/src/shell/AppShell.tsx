import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { signOut } from "../auth";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Skeleton } from "../components/Skeleton";
import { Wordmark } from "../components/Wordmark";
import { useMe, useProjects } from "../queries";
import { CreateProjectModal } from "./CreateProjectModal";
import { UserMenu } from "./UserMenu";

/** App frame: left sidebar (wordmark, projects, user block) + content. */
export function AppShell() {
  const projects = useProjects();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return (
    <div className="flex min-h-dvh">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col border-r border-line bg-panel">
        <div className="px-5 pt-5 pb-4">
          <Link to="/" className="inline-block rounded-md">
            <Wordmark />
          </Link>
        </div>

        <nav
          aria-label="Projects"
          className="min-h-0 flex-1 overflow-y-auto px-3"
        >
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-[11px] font-semibold tracking-widest text-ink-faint uppercase">
              Projects
            </span>
          </div>
          {projects.isPending ? (
            <div className="flex flex-col gap-1.5 px-2">
              <Skeleton className="h-7" />
              <Skeleton className="h-7" />
            </div>
          ) : (
            <ul className="flex flex-col gap-px">
              {(projects.data ?? []).map((p) => (
                <li key={p.id}>
                  <NavLink
                    to={`/projects/${p.id}`}
                    data-testid={`sidebar-project-${p.slug}`}
                    className={({ isActive }) =>
                      `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-100 ${
                        isActive
                          ? "bg-hover font-medium text-ink"
                          : "text-ink-dim hover:bg-hover/60 hover:text-ink"
                      }`
                    }
                  >
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full bg-accent/70"
                    />
                    <span className="truncate">{p.name}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
          <div className="px-2 pt-2">
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              data-testid="project-create"
              onClick={() => setCreating(true)}
            >
              <span aria-hidden className="text-accent">
                +
              </span>{" "}
              New project
            </Button>
          </div>
        </nav>

        <div className="border-t border-line p-3">
          {me.isPending ? (
            <Skeleton className="h-10" />
          ) : me.data !== undefined ? (
            <UserMenu
              name={me.data.name}
              email={me.data.email}
              roleBadge={
                me.data.instanceRole !== "member" ? (
                  <Badge tone="accent">{me.data.instanceRole}</Badge>
                ) : null
              }
              onSignOut={() => {
                void signOut().then(() => {
                  queryClient.clear();
                  navigate("/login");
                });
              }}
            />
          ) : null}
        </div>
      </aside>

      <main className="ml-60 min-w-0 flex-1">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <Outlet />
        </div>
      </main>

      <CreateProjectModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
