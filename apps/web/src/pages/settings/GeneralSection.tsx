import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { Button } from "../../components/Button";
import { AutoTextarea, Field, Input } from "../../components/Input";
import { useToast } from "../../components/Toast";
import type { ProjectDetail } from "../../queries";

export function SettingsSection({
  title,
  sub,
  children,
  danger = false,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      className={`rounded-xl border p-5 ${
        danger ? "border-danger/40" : "border-line"
      }`}
    >
      <h2 className={`text-sm font-semibold ${danger ? "text-danger" : ""}`}>
        {title}
      </h2>
      {sub !== undefined && (
        <p className="mt-0.5 text-[12px] text-ink-faint">{sub}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function GeneralSection({ project }: { project: ProjectDetail }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const queryClient = useQueryClient();
  const toast = useToast();

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.api
          .projects({ projectId: project.id })
          .patch({ name: name.trim(), description: description.trim() }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: keys.project(project.id),
      });
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      toast("Project updated", "success");
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const dirty =
    name.trim() !== project.name ||
    description.trim() !== (project.description ?? "");

  return (
    <SettingsSection
      title="General"
      sub={`Slug: ${project.slug} (immutable — CLI configs reference it)`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && name.trim() !== "") {
            save.mutate();
          }
        }}
      >
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              data-testid="general-name"
              value={name}
              maxLength={100}
              required
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Description">
          {(id) => (
            <AutoTextarea
              id={id}
              mono={false}
              data-testid="general-description"
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What lives here?"
            />
          )}
        </Field>
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            data-testid="general-save"
            disabled={!dirty || name.trim() === ""}
            loading={save.isPending}
          >
            Save changes
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
