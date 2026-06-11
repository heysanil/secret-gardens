import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Input } from "../../components/Input";
import { useToast } from "../../components/Toast";
import type { Environment, ProjectDetail } from "../../queries";
import { SettingsSection } from "./GeneralSection";

const ENV_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function EnvironmentsSection({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [renaming, setRenaming] = useState<Environment | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [deleting, setDeleting] = useState<Environment | null>(null);

  const envApi = api.api.projects({ projectId: project.id }).environments;
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: keys.project(project.id) });

  const create = useMutation({
    mutationFn: () =>
      unwrap(envApi.post({ name: newName.trim(), slug: newSlug.trim() })),
    onSuccess: (env) => {
      invalidate();
      setNewName("");
      setNewSlug("");
      toast(`Environment "${env.name}" added`, "success");
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const rename = useMutation({
    mutationFn: ({ envId, name }: { envId: string; name: string }) =>
      unwrap(envApi({ envId }).patch({ name })),
    onSuccess: () => {
      invalidate();
      setRenaming(null);
      toast("Environment renamed", "success");
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const remove = useMutation({
    mutationFn: (envId: string) => unwrap(envApi({ envId }).delete()),
    onSuccess: (_res, envId) => {
      // Hygiene: drop the env's decrypted values from the query cache —
      // plaintext of deleted secrets must not linger in the heap.
      queryClient.removeQueries({
        queryKey: keys.secretValues(project.id, envId),
      });
      invalidate();
      setDeleting(null);
      toast("Environment deleted", "success");
    },
    onError: (err) => {
      setDeleting(null);
      toast(friendlyMessage(err), "error");
    },
  });

  const envs = [...project.environments].sort(
    (a, b) => a.position - b.position,
  );
  const slugTaken = envs.some((e) => e.slug === newSlug.trim());
  const slugValid = ENV_SLUG_RE.test(newSlug.trim());
  const canAdd = newName.trim() !== "" && slugValid && !slugTaken;

  return (
    <SettingsSection
      title="Environments"
      sub="Slugs are immutable after creation; deleting an environment destroys its secrets and history."
    >
      <ul className="flex flex-col">
        {envs.map((env) => (
          <li
            key={env.id}
            data-testid={`env-row-${env.slug}`}
            className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0"
          >
            {renaming?.id === env.id ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (renameTo.trim() !== "") {
                    rename.mutate({ envId: env.id, name: renameTo.trim() });
                  }
                }}
              >
                <Input
                  aria-label={`New name for ${env.name}`}
                  data-testid="env-rename-input"
                  value={renameTo}
                  maxLength={50}
                  autoFocus
                  onChange={(e) => setRenameTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setRenaming(null);
                    }
                  }}
                  className="max-w-56"
                />
                <Button type="submit" size="sm" loading={rename.isPending}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRenaming(null)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="w-8 text-center font-mono text-[11px] text-ink-faint">
                  {env.position}
                </span>
                <span className="font-medium">{env.name}</span>
                <code className="text-[12px] text-ink-faint">{env.slug}</code>
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    data-testid="env-rename"
                    onClick={() => {
                      setRenaming(env);
                      setRenameTo(env.name);
                    }}
                    className="rounded-md text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    data-testid="env-delete"
                    onClick={() => setDeleting(env)}
                    className="rounded-md text-[12px] font-medium text-ink-faint transition-colors hover:text-danger"
                  >
                    Delete
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>

      <form
        className="mt-4 flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAdd && !create.isPending) {
            create.mutate();
          }
        }}
      >
        <Input
          aria-label="New environment name"
          data-testid="env-add-name"
          placeholder="Name (e.g. QA)"
          value={newName}
          maxLength={50}
          onChange={(e) => setNewName(e.target.value)}
          className="max-w-44"
        />
        <div className="w-44">
          <Input
            aria-label="New environment slug"
            data-testid="env-add-slug"
            mono
            placeholder="slug (e.g. qa)"
            value={newSlug}
            maxLength={32}
            onChange={(e) => setNewSlug(e.target.value)}
            aria-invalid={newSlug !== "" && (!slugValid || slugTaken)}
          />
          {newSlug !== "" && (!slugValid || slugTaken) && (
            <p className="mt-1 text-[12px] text-danger">
              {slugTaken
                ? "Slug already used in this project."
                : "Lowercase letters, digits, hyphens."}
            </p>
          )}
        </div>
        <Button
          type="submit"
          data-testid="env-add-submit"
          disabled={!canAdd}
          loading={create.isPending}
        >
          Add environment
        </Button>
      </form>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete environment"
        body={
          <>
            This permanently deletes{" "}
            <strong className="text-ink">{deleting?.name}</strong> and every
            secret and version in it. Service tokens scoped to it lose access.
            This cannot be undone.
          </>
        }
        confirmLabel="Delete environment"
        typedConfirm={deleting === null ? undefined : `delete ${deleting.slug}`}
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting.id);
          }
        }}
        onClose={() => setDeleting(null)}
      />
    </SettingsSection>
  );
}
