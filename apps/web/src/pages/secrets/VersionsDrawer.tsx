import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Drawer } from "../../components/Drawer";
import { SkeletonRows } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/relativeTime";
import type { ProjectRole } from "../../queries";

const OP_TONES: Record<string, BadgeTone> = {
  create: "ok",
  update: "info",
  delete: "danger",
  rollback: "violet",
};

export function VersionsDrawer({
  projectId,
  envId,
  secretKey,
  role,
  onClose,
}: {
  projectId: string;
  envId: string;
  secretKey: string;
  role: ProjectRole;
  onClose: () => void;
}) {
  const isAdmin = role === "admin";
  const canWrite = isAdmin || role === "write";
  // Historical values are admin-only (versions.read_values) — the toggle is
  // hidden for everyone else. Each values fetch emits a secrets.read audit
  // entry server-side.
  const [withValues, setWithValues] = useState(false);
  const [rollbackTo, setRollbackTo] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const secretApi = api.api
    .projects({ projectId })
    .environments({ envId })
    .secrets({ key: secretKey });

  const versions = useQuery({
    queryKey: keys.versions(projectId, envId, secretKey, withValues),
    queryFn: async () =>
      (
        await unwrap(
          secretApi.versions.get({
            query: withValues ? { include_values: "true" } : {},
          }),
        )
      ).versions,
  });

  const rollback = useMutation({
    mutationFn: (toVersion: number) =>
      unwrap(secretApi.rollback.post({ toVersion })),
    onSuccess: (res, toVersion) => {
      setRollbackTo(null);
      toast(`Rolled back to v${toVersion} as v${res.version}`, "success");
      void queryClient.invalidateQueries({
        queryKey: keys.secrets(projectId, envId),
      });
      void queryClient.invalidateQueries({
        queryKey: keys.secretValues(projectId, envId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["versions", projectId, envId, secretKey],
      });
    },
    onError: (err) => {
      setRollbackTo(null);
      toast(friendlyMessage(err), "error");
    },
  });

  const list = versions.data ?? [];
  const newest = list[0]?.version ?? 0;

  return (
    <Drawer
      open
      onClose={onClose}
      testId="versions-drawer"
      title={
        <>
          History · <code className="text-accent">{secretKey}</code>
        </>
      }
    >
      {isAdmin && (
        <div className="mb-4 flex justify-end">
          <Button
            size="sm"
            data-testid="versions-reveal-toggle"
            aria-pressed={withValues}
            onClick={() => setWithValues((v) => !v)}
          >
            {withValues ? "Hide values" : "Reveal values"}
          </Button>
        </div>
      )}

      {versions.isPending ? (
        <SkeletonRows rows={4} />
      ) : list.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ink-faint">
          No history for this key.
        </p>
      ) : (
        <ol className="flex flex-col">
          {list.map((v) => {
            const isTombstone = v.op === "delete";
            return (
              <li
                key={v.version}
                data-testid={`version-row-${v.version}`}
                className="flex flex-col gap-1.5 border-b border-line py-3 last:border-b-0"
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-10 font-mono text-[13px] font-semibold tabular-nums">
                    v{v.version}
                  </span>
                  <Badge tone={OP_TONES[v.op] ?? "neutral"}>{v.op}</Badge>
                  {v.rollbackOf !== undefined && (
                    <span className="text-[12px] text-ink-faint">
                      of v{v.rollbackOf}
                    </span>
                  )}
                  <span
                    className="ml-auto text-[12px] whitespace-nowrap text-ink-dim"
                    title={formatAbsoluteTime(v.ts)}
                  >
                    {formatRelativeTime(v.ts)}
                  </span>
                </div>
                <div className="flex items-start gap-2.5 pl-10">
                  <span
                    className="min-w-0 truncate font-mono text-[11px] text-ink-faint"
                    title={`${v.actorType} ${v.actorId}`}
                  >
                    {v.actorType === "service_token" ? "token " : ""}
                    {v.actorId}
                  </span>
                  {canWrite && v.version !== newest && (
                    <button
                      type="button"
                      data-testid="version-rollback"
                      disabled={isTombstone}
                      title={
                        isTombstone
                          ? "Cannot roll back to a deletion"
                          : `Restore the value of v${v.version}`
                      }
                      onClick={() => setRollbackTo(v.version)}
                      className="ml-auto rounded-md text-[12px] font-medium whitespace-nowrap text-accent hover:text-accent-bright disabled:cursor-not-allowed disabled:text-ink-faint"
                    >
                      Roll back
                    </button>
                  )}
                </div>
                {withValues && (
                  <div className="pl-10">
                    {v.hasValue && v.value !== undefined ? (
                      <code className="mono-value block max-w-full rounded-md bg-bg px-2.5 py-1.5 break-all whitespace-pre-wrap">
                        {v.value === "" ? (
                          <span className="text-ink-faint italic">(empty)</span>
                        ) : (
                          v.value
                        )}
                      </code>
                    ) : (
                      <span className="text-[12px] text-ink-faint">
                        — no value (deleted)
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <ConfirmDialog
        open={rollbackTo !== null}
        title="Roll back secret"
        danger={false}
        body={
          <>
            Restore the value of <code className="text-ink">{secretKey}</code>{" "}
            from v{rollbackTo}? This appends a new version — history is never
            rewritten.
          </>
        }
        confirmLabel="Roll back"
        busy={rollback.isPending}
        onConfirm={() => {
          if (rollbackTo !== null) {
            rollback.mutate(rollbackTo);
          }
        }}
        onClose={() => setRollbackTo(null)}
      />
    </Drawer>
  );
}
