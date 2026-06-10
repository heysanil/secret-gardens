import { Link, useOutletContext, useSearchParams } from "react-router";
import { EmptyState } from "../components/EmptyState";
import { Tabs } from "../components/Tabs";
import type { ProjectContext } from "./ProjectLayout";
import { SecretsTable } from "./secrets/SecretsTable";

/** Environment tabs + the secrets table for the active environment. */
export function ProjectSecretsPage() {
  const { project } = useOutletContext<ProjectContext>();
  const [params, setParams] = useSearchParams();

  const envs = [...project.environments].sort(
    (a, b) => a.position - b.position,
  );

  if (envs.length === 0) {
    return (
      <EmptyState
        title="No environments"
        body="This project has no environments yet. Add one in settings to start storing secrets."
        action={
          project.role === "admin" ? (
            <Link
              to={`/projects/${project.id}/settings`}
              className="text-sm font-medium text-accent hover:text-accent-bright"
            >
              Open settings →
            </Link>
          ) : undefined
        }
      />
    );
  }

  const activeSlug = params.get("env");
  const active = envs.find((e) => e.slug === activeSlug) ?? envs[0];
  if (active === undefined) {
    return null; // unreachable: envs.length > 0
  }

  return (
    <div>
      <Tabs
        ariaLabel="Environments"
        items={envs.map((e) => ({
          id: e.slug,
          label: e.name,
          testId: `env-tab-${e.slug}`,
        }))}
        active={active.slug}
        onChange={(slug) =>
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("env", slug);
            return next;
          })
        }
      />
      {/* key resets reveal/edit state when switching environments */}
      <SecretsTable
        key={active.id}
        projectId={project.id}
        envId={active.id}
        role={project.role}
      />
    </div>
  );
}
