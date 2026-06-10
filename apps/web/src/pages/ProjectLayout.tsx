import { Link, NavLink, Outlet, useParams } from "react-router";
import { RoleBadge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { type ProjectDetail, useProject } from "../queries";

export interface ProjectContext {
  project: ProjectDetail;
}

/** Project chrome: breadcrumb, header, section nav; children via Outlet. */
export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);

  if (project.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (project.isError || project.data === undefined) {
    return (
      <div className="rounded-xl border border-line-strong bg-panel p-8 text-center">
        <p className="text-sm text-ink-dim">
          This project doesn't exist or you don't have access to it.
        </p>
        <Link
          to="/"
          className="mt-3 inline-block rounded-md text-sm text-accent hover:text-accent-bright"
        >
          Back to projects →
        </Link>
      </div>
    );
  }

  const p = project.data;
  const sections = [
    { to: `/projects/${p.id}`, label: "Secrets", end: true },
    { to: `/projects/${p.id}/audit`, label: "Audit log", end: false },
    { to: `/projects/${p.id}/members`, label: "Members", end: false },
    ...(p.role === "admin"
      ? [{ to: `/projects/${p.id}/settings`, label: "Settings", end: false }]
      : []),
  ];

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-2 text-[13px] text-ink-faint">
        <Link to="/" className="rounded-md transition-colors hover:text-ink">
          Projects
        </Link>
        <span aria-hidden className="mx-1.5">
          /
        </span>
        <span className="text-ink-dim">{p.name}</span>
      </nav>

      <header className="mb-5">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{p.name}</h1>
          <RoleBadge role={p.role} />
        </div>
        {p.description !== null && p.description !== "" && (
          <p className="mt-1 max-w-xl text-[13px] text-ink-dim">
            {p.description}
          </p>
        )}
      </header>

      <nav
        aria-label="Project sections"
        className="mb-6 flex gap-1 border-b border-line"
      >
        {sections.map((s) => (
          <NavLink
            key={s.to}
            to={s.to}
            end={s.end}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-100 ${
                isActive
                  ? "border-accent font-medium text-ink"
                  : "border-transparent text-ink-dim hover:text-ink"
              }`
            }
          >
            {s.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ project: p } satisfies ProjectContext} />
    </div>
  );
}
