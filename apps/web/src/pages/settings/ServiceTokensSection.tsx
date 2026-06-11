import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SkeletonRows } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDate, formatRelativeTime } from "../../lib/relativeTime";
import type { ProjectDetail } from "../../queries";
import { CreateServiceTokenModal } from "./CreateServiceTokenModal";
import { SettingsSection } from "./GeneralSection";

export function ServiceTokensSection({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null,
  );

  const tokensApi = api.api.projects({ projectId: project.id }).tokens;

  const tokens = useQuery({
    queryKey: keys.serviceTokens(project.id),
    queryFn: () => unwrap(tokensApi.get()),
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => unwrap(tokensApi({ tokenId }).delete()),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: keys.serviceTokens(project.id),
      });
      setRevoking(null);
      toast("Token revoked", "success");
    },
    onError: (err) => {
      setRevoking(null);
      toast(friendlyMessage(err), "error");
    },
  });

  const envSlugById = new Map(
    project.environments.map((e) => [e.id, e.slug] as const),
  );
  const now = Date.now();

  return (
    <SettingsSection
      title="Service tokens"
      sub="Scoped machine credentials for CI — pull (read) or push (read_write), optionally limited to specific environments."
    >
      <div className="mb-3 flex justify-end">
        <Button data-testid="token-create" onClick={() => setCreating(true)}>
          Create token
        </Button>
      </div>

      {tokens.isPending ? (
        <SkeletonRows rows={2} />
      ) : (tokens.data ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-faint">
          No service tokens. Create one to let CI run{" "}
          <code className="text-ink-dim">gardens pull</code>.
        </p>
      ) : (
        <ul className="flex flex-col">
          {(tokens.data ?? []).map((t) => {
            const expired = t.expiresAt !== null && t.expiresAt <= now;
            const dead = t.revokedAt !== null || expired;
            return (
              <li
                key={t.id}
                data-testid={`token-row-${t.id}`}
                className={`flex items-center gap-3 border-b border-line py-2.5 last:border-b-0 ${
                  dead ? "opacity-50" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    <Badge tone={t.scope === "read_write" ? "info" : "neutral"}>
                      {t.scope}
                    </Badge>
                    {t.revokedAt !== null ? (
                      <Badge tone="danger">revoked</Badge>
                    ) : expired ? (
                      <Badge tone="danger">expired</Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-ink-faint">
                    <code>{t.tokenPrefix}…</code>
                    <span>
                      envs:{" "}
                      {t.environmentIds === null
                        ? "all"
                        : t.environmentIds
                            .map((id) => envSlugById.get(id) ?? id)
                            .join(", ")}
                    </span>
                    <span>
                      {t.expiresAt === null
                        ? "no expiry"
                        : `expires ${formatDate(t.expiresAt)}`}
                    </span>
                    <span>
                      {t.lastUsedAt === null
                        ? "never used"
                        : `last used ${formatRelativeTime(t.lastUsedAt)}`}
                    </span>
                  </div>
                </div>
                {t.revokedAt === null && (
                  <Button
                    size="sm"
                    variant="danger"
                    data-testid="token-revoke"
                    onClick={() => setRevoking({ id: t.id, name: t.name })}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <CreateServiceTokenModal
        open={creating}
        project={project}
        onClose={() => setCreating(false)}
      />

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke service token"
        body={
          <>
            Revoke <strong className="text-ink">{revoking?.name}</strong>? Any
            CI jobs using it will start failing immediately. This cannot be
            undone.
          </>
        }
        confirmLabel="Revoke"
        busy={revoke.isPending}
        onConfirm={() => {
          if (revoking !== null) {
            revoke.mutate(revoking.id);
          }
        }}
        onClose={() => setRevoking(null)}
      />
    </SettingsSection>
  );
}
