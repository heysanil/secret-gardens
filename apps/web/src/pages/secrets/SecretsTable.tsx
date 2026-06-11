import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { Input } from "../../components/Input";
import { SkeletonRows } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { type ProjectRole, useMemberNames } from "../../queries";
import { AddSecretRow } from "./AddSecretRow";
import { SecretRow } from "./SecretRow";
import { VersionsDrawer } from "./VersionsDrawer";

function secretsApi(projectId: string, envId: string) {
  return api.api.projects({ projectId }).environments({ envId }).secrets;
}

export type SecretEntry = {
  key: string;
  version: number;
  updatedAt: number;
  updatedBy: string;
  value?: string;
};

export function SecretsTable({
  projectId,
  envId,
  role,
}: {
  projectId: string;
  envId: string;
  role: ProjectRole;
}) {
  const canWrite = role === "admin" || role === "write";
  const queryClient = useQueryClient();
  const toast = useToast();
  const memberNames = useMemberNames(projectId);

  const [filter, setFilter] = useState("");
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [valuesRequested, setValuesRequested] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);

  const list = useQuery({
    queryKey: keys.secrets(projectId, envId),
    queryFn: async () =>
      (await unwrap(secretsApi(projectId, envId).get({ query: {} }))).secrets,
  });

  // Decrypted values are fetched ONCE per environment (on first reveal/copy)
  // and cached for the session. Each fetch emits exactly one `secrets.read`
  // audit entry on the server — per-row toggles after that are local.
  const fetchValues = useCallback(async (): Promise<Record<string, string>> => {
    const res = await unwrap(
      secretsApi(projectId, envId).get({
        query: { include_values: "true" },
      }),
    );
    return Object.fromEntries(res.secrets.map((s) => [s.key, s.value ?? ""]));
  }, [projectId, envId]);

  const values = useQuery({
    queryKey: keys.secretValues(projectId, envId),
    queryFn: fetchValues,
    enabled: valuesRequested,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 15 * 60_000,
  });

  const getValue = useCallback(
    async (key: string): Promise<string | null> => {
      setValuesRequested(true);
      try {
        const data = await queryClient.fetchQuery({
          queryKey: keys.secretValues(projectId, envId),
          queryFn: fetchValues,
          staleTime: Number.POSITIVE_INFINITY,
        });
        return data[key] ?? null;
      } catch (err) {
        toast(friendlyMessage(err), "error");
        return null;
      }
    },
    [projectId, envId, queryClient, fetchValues, toast],
  );

  function patchCachedValue(key: string, value: string | null) {
    queryClient.setQueryData<Record<string, string>>(
      keys.secretValues(projectId, envId),
      (prev) => {
        if (prev === undefined) {
          return prev;
        }
        const next = { ...prev };
        if (value === null) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next;
      },
    );
  }

  const upsert = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      unwrap(secretsApi(projectId, envId)({ key }).put({ value })),
    onSuccess: (res, { key, value }) => {
      patchCachedValue(key, value);
      void queryClient.invalidateQueries({
        queryKey: keys.secrets(projectId, envId),
      });
      toast(
        res.op === "create"
          ? `${key} created`
          : `${key} updated to v${res.version}`,
        "success",
      );
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const remove = useMutation({
    mutationFn: (key: string) =>
      unwrap(secretsApi(projectId, envId)({ key }).delete()),
    onSuccess: (_res, key) => {
      patchCachedValue(key, null);
      void queryClient.invalidateQueries({
        queryKey: keys.secrets(projectId, envId),
      });
      setDeleting(null);
      toast(`${key} deleted`, "success");
    },
    onError: (err) => {
      setDeleting(null);
      toast(friendlyMessage(err), "error");
    },
  });

  const entries = useMemo(() => {
    const all = list.data ?? [];
    const needle = filter.trim().toUpperCase();
    return needle === ""
      ? all
      : all.filter((s) => s.key.toUpperCase().includes(needle));
  }, [list.data, filter]);

  if (list.isPending) {
    return <SkeletonRows rows={5} />;
  }

  const existingKeys = new Set((list.data ?? []).map((s) => s.key));

  return (
    <div className="mt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Input
          aria-label="Filter secrets by key"
          data-testid="secret-filter"
          placeholder="Filter keys…"
          mono
          className="max-w-60"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-[12px] whitespace-nowrap text-ink-faint">
          {entries.length} of {(list.data ?? []).length}{" "}
          {(list.data ?? []).length === 1 ? "secret" : "secrets"}
        </span>
      </div>

      {(list.data ?? []).length === 0 ? (
        <EmptyState
          title="No secrets in this environment"
          body={
            canWrite
              ? "Add your first secret below, or push a .env file with the CLI: gardens push"
              : "Nothing here yet. Someone with write access can add secrets."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-panel text-left text-[11px] tracking-widest text-ink-faint uppercase">
                <th className="px-4 py-2.5 font-semibold">Key</th>
                <th className="px-4 py-2.5 font-semibold">Value</th>
                <th className="px-4 py-2.5 font-semibold whitespace-nowrap">
                  Updated
                </th>
                <th className="w-28 px-4 py-2.5" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <SecretRow
                  key={entry.key}
                  entry={entry}
                  updatedByName={memberNames.get(entry.updatedBy)}
                  value={values.data?.[entry.key]}
                  revealed={revealed.has(entry.key)}
                  valuesLoading={values.isFetching}
                  canWrite={canWrite}
                  saving={
                    upsert.isPending && upsert.variables?.key === entry.key
                  }
                  onToggleReveal={() => {
                    setRevealed((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.key)) {
                        next.delete(entry.key);
                      } else {
                        next.add(entry.key);
                        setValuesRequested(true);
                      }
                      return next;
                    });
                  }}
                  getValue={() => getValue(entry.key)}
                  onSave={(value) => upsert.mutate({ key: entry.key, value })}
                  onDelete={() => setDeleting(entry.key)}
                  onHistory={() => setHistoryKey(entry.key)}
                />
              ))}
              {entries.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-[13px] text-ink-faint"
                  >
                    No keys match "{filter}"
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && (
        <AddSecretRow
          existingKeys={existingKeys}
          busy={upsert.isPending}
          onAdd={(key, value) => upsert.mutateAsync({ key, value })}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete secret"
        body={
          <>
            Delete <code className="text-ink">{deleting}</code> from this
            environment? Its version history is kept and it can be restored via
            rollback.
          </>
        }
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
        onClose={() => setDeleting(null)}
      />

      {historyKey !== null && (
        <VersionsDrawer
          projectId={projectId}
          envId={envId}
          secretKey={historyKey}
          role={role}
          onClose={() => setHistoryKey(null)}
        />
      )}
    </div>
  );
}
