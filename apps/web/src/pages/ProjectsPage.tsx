import { useState } from "react";
import { Link } from "react-router";
import { RoleBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { useProjects } from "../queries";
import { CreateProjectModal } from "../shell/CreateProjectModal";

export function ProjectsPage() {
  const projects = useProjects();
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-0.5 text-[13px] text-ink-dim">
            Each project holds environments and their encrypted secrets.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => setCreating(true)}
          data-testid="projects-page-create"
        >
          New project
        </Button>
      </header>

      {projects.isPending ? (
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : (projects.data ?? []).length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Create your first project to start storing secrets. Every project comes with dev, staging, and prod environments — change them any time in settings."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create your first project
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(projects.data ?? []).map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                data-testid={`project-card-${p.slug}`}
                className="group block h-full rounded-xl border border-line bg-panel p-5 transition-colors duration-100 hover:border-line-strong hover:bg-raised"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold transition-colors group-hover:text-accent-bright">
                    {p.name}
                  </h2>
                  <RoleBadge role={p.role} />
                </div>
                <p className="mt-1 font-mono text-[12px] text-ink-faint">
                  {p.slug}
                </p>
                {p.description !== null && p.description !== "" && (
                  <p className="mt-2 line-clamp-2 text-[13px] text-ink-dim">
                    {p.description}
                  </p>
                )}
                <p className="mt-3 text-[12px] text-ink-faint">
                  {p.environmentCount}{" "}
                  {p.environmentCount === 1 ? "environment" : "environments"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateProjectModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
