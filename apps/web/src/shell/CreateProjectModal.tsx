import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, friendlyMessage, keys, unwrap } from "../api";
import { Button } from "../components/Button";
import { AutoTextarea, Field, Input } from "../components/Input";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { deriveProjectSlug } from "../lib/slug";

export function CreateProjectModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const slug = deriveProjectSlug(name);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.api.projects.post({
          name: name.trim(),
          ...(description.trim() !== "" && {
            description: description.trim(),
          }),
        }),
      ),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      toast(`Project "${project.name}" created`, "success");
      onClose();
      navigate(`/projects/${project.id}`);
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const valid = name.trim().length > 0 && slug.length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      testId="project-create-modal"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !create.isPending) {
            create.mutate();
          }
        }}
      >
        <Field
          label="Name"
          hint={
            name.length > 0 ? (
              slug.length > 0 ? (
                <>
                  Slug:{" "}
                  <code
                    data-testid="project-create-slug"
                    className="text-ink-dim"
                  >
                    {slug}
                  </code>
                </>
              ) : (
                "Name must contain at least one letter or digit."
              )
            ) : (
              "Project gets dev, staging, and prod environments by default."
            )
          }
        >
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              data-testid="project-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Billing service"
              maxLength={100}
              required
            />
          )}
        </Field>
        <Field label="Description (optional)">
          {(id) => (
            <AutoTextarea
              id={id}
              mono={false}
              data-testid="project-create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What lives here?"
              maxLength={500}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!valid}
            loading={create.isPending}
            data-testid="project-create-submit"
          >
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
