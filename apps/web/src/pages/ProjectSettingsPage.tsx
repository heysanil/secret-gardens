import { useOutletContext } from "react-router";
import type { ProjectContext } from "./ProjectLayout";
import { DangerZoneSection } from "./settings/DangerZoneSection";
import { EnvironmentsSection } from "./settings/EnvironmentsSection";
import { GeneralSection } from "./settings/GeneralSection";
import { ServiceTokensSection } from "./settings/ServiceTokensSection";

export function ProjectSettingsPage() {
  const { project } = useOutletContext<ProjectContext>();

  if (project.role !== "admin") {
    return (
      <div className="rounded-xl border border-line bg-panel p-8 text-center text-sm text-ink-dim">
        Project settings require the admin role.
      </div>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <GeneralSection project={project} />
      <EnvironmentsSection project={project} />
      <ServiceTokensSection project={project} />
      <DangerZoneSection project={project} />
    </div>
  );
}
