import { AUDIT_ACTIONS } from "@safe/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useOutletContext } from "react-router";
import { api, keys, unwrap } from "../api";
import { Badge, type BadgeTone } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { Select } from "../components/Select";
import { SkeletonRows } from "../components/Skeleton";
import { formatAbsoluteTime, formatRelativeTime } from "../lib/relativeTime";
import { useMemberNames } from "../queries";
import type { ProjectContext } from "./ProjectLayout";

const RESERVED = new Set(["id", "ts", "action", "actorType", "actorId"]);

const FAMILY_TONES: Record<string, BadgeTone> = {
  project: "violet",
  env: "cyan",
  secret: "accent",
  secrets: "accent",
  member: "info",
  token: "ok",
  auth: "danger",
  dek: "danger",
  kek: "danger",
};

function actionTone(action: string): BadgeTone {
  return FAMILY_TONES[action.split(".")[0] ?? ""] ?? "neutral";
}

function ActorCell({
  type,
  id,
  name,
}: {
  type: string;
  id: string;
  name: string | undefined;
}) {
  const icon = type === "user" ? "@" : type === "service_token" ? "#" : "·";
  return (
    <span className="flex items-center gap-1.5" title={`${type} ${id}`}>
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised font-mono text-[11px] text-ink-dim"
      >
        {icon}
      </span>
      <span
        className={`max-w-36 truncate text-[11px] text-ink-faint ${
          name === undefined ? "font-mono" : ""
        }`}
      >
        {name ?? id}
      </span>
    </span>
  );
}

export function ProjectAuditPage() {
  const { project } = useOutletContext<ProjectContext>();
  const [action, setAction] = useState("");
  const [envId, setEnvId] = useState("");
  const memberNames = useMemberNames(project.id);

  const envSlugById = new Map(
    project.environments.map((e) => [e.id, e.slug] as const),
  );

  const audit = useInfiniteQuery({
    queryKey: keys.audit(project.id, action, envId),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.api.projects({ projectId: project.id }).audit.get({
          query: {
            ...(action !== "" && { action }),
            ...(envId !== "" && { envId }),
            ...(pageParam !== undefined && { cursor: pageParam }),
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const entries = (audit.data?.pages ?? []).flatMap((p) => p.entries);

  return (
    <div>
      <div className="mb-4 flex items-center gap-2.5">
        <Select
          aria-label="Filter by action"
          data-testid="audit-action-filter"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by environment"
          data-testid="audit-env-filter"
          value={envId}
          onChange={(e) => setEnvId(e.target.value)}
        >
          <option value="">All environments</option>
          {project.environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </Select>
      </div>

      {audit.isPending ? (
        <SkeletonRows rows={6} />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No audit entries"
          body="Actions on this project — secret reads and writes, member changes, token activity — appear here as an append-only trail."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-panel text-left text-[11px] tracking-widest text-ink-faint uppercase">
                <th className="px-4 py-2.5 font-semibold whitespace-nowrap">
                  Time
                </th>
                <th className="px-4 py-2.5 font-semibold">Action</th>
                <th className="px-4 py-2.5 font-semibold">Actor</th>
                <th className="px-4 py-2.5 font-semibold">Env</th>
                <th className="px-4 py-2.5 font-semibold">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const fields = Object.entries(entry).filter(
                  ([k]) => !RESERVED.has(k) && k !== "envId",
                );
                const entryEnv =
                  typeof entry.envId === "string"
                    ? (envSlugById.get(entry.envId) ?? entry.envId)
                    : null;
                return (
                  <tr
                    key={entry.id}
                    data-testid="audit-row"
                    className="border-b border-line align-top last:border-b-0 hover:bg-panel/60"
                  >
                    <td
                      className="px-4 py-2.5 text-[12px] whitespace-nowrap text-ink-dim"
                      title={formatAbsoluteTime(entry.ts)}
                    >
                      {formatRelativeTime(entry.ts)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={actionTone(entry.action)}>
                        {entry.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <ActorCell
                        type={entry.actorType}
                        id={entry.actorId}
                        name={
                          entry.actorType === "user"
                            ? memberNames.get(entry.actorId)
                            : undefined
                        }
                      />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-ink-dim">
                      {entryEnv ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex max-w-md flex-wrap gap-1.5">
                        {fields.length === 0 ? (
                          <span className="text-[12px] text-ink-faint">—</span>
                        ) : (
                          fields.map(([k, v]) => (
                            <code
                              key={k}
                              className="rounded bg-raised px-1.5 py-px text-[11px] break-all text-ink-dim"
                            >
                              {k}={String(v)}
                            </code>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {audit.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            data-testid="audit-load-more"
            loading={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
