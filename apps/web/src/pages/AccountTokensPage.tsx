import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, friendlyMessage, keys, unwrap } from "../api";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { Field, Input } from "../components/Input";
import { Modal } from "../components/Modal";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { TokenReveal } from "../components/TokenReveal";
import { formatDate, formatRelativeTime } from "../lib/relativeTime";

export function AccountTokensPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null,
  );

  useEffect(() => {
    if (!creating) {
      setName("");
      setExpiresInDays("");
      setMinted(null);
    }
  }, [creating]);

  const tokens = useQuery({
    queryKey: keys.myTokens,
    queryFn: () => unwrap(api.api.me.tokens.get()),
  });

  const create = useMutation({
    mutationFn: () => {
      const days = Number(expiresInDays);
      return unwrap(
        api.api.me.tokens.post({
          name: name.trim(),
          ...(expiresInDays !== "" &&
            Number.isInteger(days) &&
            days > 0 && { expiresInDays: days }),
        }),
      );
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.myTokens });
      setMinted(res.token);
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.api.me.tokens({ id }).delete()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.myTokens });
      setRevoking(null);
      toast("Token revoked", "success");
    },
    onError: (err) => {
      setRevoking(null);
      toast(friendlyMessage(err), "error");
    },
  });

  const days = Number(expiresInDays);
  const expiryValid =
    expiresInDays === "" ||
    (Number.isInteger(days) && days >= 1 && days <= 365);
  const now = Date.now();
  const list = tokens.data ?? [];

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-2 text-[13px] text-ink-faint">
        <Link to="/" className="rounded-md transition-colors hover:text-ink">
          Account
        </Link>
        <span aria-hidden className="mx-1.5">
          /
        </span>
        <span className="text-ink-dim">Tokens</span>
      </nav>
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Personal access tokens</h1>
          <p className="mt-0.5 max-w-xl text-[13px] text-ink-dim">
            Tokens act as you across every project you can access. The CLI
            creates one automatically at <code>safe login</code>. Tokens created
            with another token (instead of a browser session) are capped at 30
            days.
          </p>
        </div>
        <Button
          variant="primary"
          data-testid="pat-create"
          onClick={() => setCreating(true)}
        >
          Create token
        </Button>
      </header>

      {tokens.isPending ? (
        <SkeletonRows rows={3} />
      ) : list.length === 0 ? (
        <EmptyState
          title="No personal tokens"
          body="Create one to use the API directly, or run safe login to mint one through the CLI."
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {list.map((t) => {
            const expired = t.expiresAt !== null && t.expiresAt <= now;
            const dead = t.revokedAt !== null || expired;
            return (
              <li
                key={t.id}
                data-testid={`pat-row-${t.id}`}
                className={`flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 ${
                  dead ? "opacity-50" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    {t.createdVia === "token" && (
                      <Badge
                        tone="cyan"
                        title="Created with a personal access token — the 30-day lifetime cap applied"
                      >
                        via CLI token
                      </Badge>
                    )}
                    {t.revokedAt !== null ? (
                      <Badge tone="danger">revoked</Badge>
                    ) : expired ? (
                      <Badge tone="danger">expired</Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-ink-faint">
                    <code>{t.tokenPrefix}…</code>
                    <span>created {formatDate(t.createdAt)}</span>
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
                    data-testid="pat-revoke"
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

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={minted === null ? "Create personal token" : "Token created"}
        testId="pat-create-modal"
      >
        {minted !== null ? (
          <div className="flex flex-col gap-4">
            <TokenReveal token={minted} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setCreating(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() !== "" && expiryValid && !create.isPending) {
                create.mutate();
              }
            }}
          >
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  data-testid="pat-name"
                  placeholder="laptop scripts"
                  value={name}
                  maxLength={100}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Expires in days (optional)"
              error={expiryValid ? null : "Enter a whole number from 1 to 365."}
              hint="Empty = never expires. Maximum 365 days."
            >
              {(id, describedBy) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  data-testid="pat-expiry"
                  inputMode="numeric"
                  placeholder="30"
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value.trim())}
                  className="max-w-32"
                />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                type="submit"
                variant="primary"
                data-testid="pat-create-submit"
                disabled={name.trim() === "" || !expiryValid}
                loading={create.isPending}
              >
                Create token
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke token"
        body={
          <>
            Revoke <strong className="text-ink">{revoking?.name}</strong>?
            Anything using it (including CLI sessions) signs out immediately.
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
    </div>
  );
}
