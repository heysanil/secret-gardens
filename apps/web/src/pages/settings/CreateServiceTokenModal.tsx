import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { Button } from "../../components/Button";
import { Field, Input } from "../../components/Input";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { TokenReveal } from "../../components/TokenReveal";
import type { ProjectDetail } from "../../queries";

type Scope = "read" | "read_write";

export function CreateServiceTokenModal({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: ProjectDetail;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [envIds, setEnvIds] = useState<ReadonlySet<string>>(new Set());
  const [expiresInDays, setExpiresInDays] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    if (!open) {
      setName("");
      setScope("read");
      setEnvIds(new Set());
      setExpiresInDays("");
      setMinted(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () => {
      const days = Number(expiresInDays);
      return unwrap(
        api.api.projects({ projectId: project.id }).tokens.post({
          name: name.trim(),
          scope,
          // empty selection = all environments (API: null/omitted)
          ...(envIds.size > 0 && { environmentIds: [...envIds] }),
          ...(expiresInDays !== "" &&
            Number.isInteger(days) &&
            days > 0 && { expiresInDays: days }),
        }),
      );
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({
        queryKey: keys.serviceTokens(project.id),
      });
      setMinted(res.token);
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const days = Number(expiresInDays);
  const expiryValid =
    expiresInDays === "" ||
    (Number.isInteger(days) && days >= 1 && days <= 3650);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={minted === null ? "Create service token" : "Service token created"}
      width="max-w-lg"
      testId="token-create-modal"
    >
      {minted !== null ? (
        <div className="flex flex-col gap-4">
          <TokenReveal token={minted} />
          <p className="text-[13px] text-ink-dim">
            Use it in CI:{" "}
            <code className="rounded bg-raised px-1.5 py-px text-[12px]">
              GARDENS_TOKEN={minted.slice(0, 12)}… gardens pull
            </code>
          </p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={onClose}
              data-testid="token-done"
            >
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
                data-testid="token-name"
                placeholder="github-actions deploy"
                value={name}
                maxLength={100}
                required
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>

          <fieldset>
            <legend className="text-[13px] font-medium text-ink-dim">
              Scope
            </legend>
            <div className="mt-1.5 flex gap-2">
              {(
                [
                  ["read", "Read — pull secrets only"],
                  ["read_write", "Read & write — pull and push"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={`flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                    scope === value
                      ? "border-accent/60 bg-accent/5 text-ink"
                      : "border-line-strong text-ink-dim hover:bg-hover"
                  }`}
                >
                  <input
                    type="radio"
                    name="token-scope"
                    data-testid={`token-scope-${value}`}
                    className="accent-(--color-accent)"
                    checked={scope === value}
                    onChange={() => setScope(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-[13px] font-medium text-ink-dim">
              Environments
            </legend>
            <p className="mt-0.5 text-[12px] text-ink-faint">
              Leave all unchecked to allow every environment (including ones
              added later).
            </p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {project.environments.map((env) => (
                <label
                  key={env.id}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] transition-colors ${
                    envIds.has(env.id)
                      ? "border-accent/60 bg-accent/5 text-ink"
                      : "border-line-strong text-ink-dim hover:bg-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    data-testid={`token-env-${env.slug}`}
                    className="accent-(--color-accent)"
                    checked={envIds.has(env.id)}
                    onChange={(e) => {
                      setEnvIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) {
                          next.add(env.id);
                        } else {
                          next.delete(env.id);
                        }
                        return next;
                      });
                    }}
                  />
                  {env.slug}
                </label>
              ))}
            </div>
          </fieldset>

          <Field
            label="Expires in days (optional)"
            error={expiryValid ? null : "Enter a whole number from 1 to 3650."}
            hint="Empty = never expires."
          >
            {(id, describedBy) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                data-testid="token-expiry"
                inputMode="numeric"
                placeholder="90"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value.trim())}
                className="max-w-32"
              />
            )}
          </Field>

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="token-create-submit"
              disabled={name.trim() === "" || !expiryValid}
              loading={create.isPending}
            >
              Create token
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
