import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import type { ProjectDetail } from "../../queries";
import { SettingsSection } from "./GeneralSection";

export function DangerZoneSection({ project }: { project: ProjectDetail }) {
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const rotate = useMutation({
    mutationFn: () =>
      unwrap(api.api.projects({ projectId: project.id })["rotate-dek"].post()),
    onSuccess: (res) => {
      setConfirmRotate(false);
      // Cached plaintext values are unchanged by rotation, but drop them so
      // nothing stale lingers if envs were mid-edit.
      void queryClient.invalidateQueries({ queryKey: ["secret-values"] });
      toast(
        `DEK rotated (v${res.oldVersion} → v${res.newVersion}); ${res.secretsRewritten} secrets re-encrypted`,
        "success",
      );
    },
    onError: (err) => {
      setConfirmRotate(false);
      toast(friendlyMessage(err), "error");
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.api.projects({ projectId: project.id }).delete()),
    onSuccess: () => {
      setConfirmDelete(false);
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      queryClient.removeQueries({ queryKey: keys.project(project.id) });
      toast(`Project "${project.name}" deleted`, "success");
      navigate("/");
    },
    onError: (err) => {
      setConfirmDelete(false);
      toast(friendlyMessage(err), "error");
    },
  });

  return (
    <SettingsSection
      danger
      title="Danger zone"
      sub="Irreversible or sensitive operations."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-4 py-3">
          <div>
            <p className="text-[13px] font-medium">Rotate encryption key</p>
            <p className="text-[12px] text-ink-faint">
              Generates a new data-encryption key and re-encrypts every current
              secret. Old versions remain readable.
            </p>
          </div>
          <Button
            data-testid="rotate-dek"
            onClick={() => setConfirmRotate(true)}
          >
            Rotate DEK
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-danger/30 px-4 py-3">
          <div>
            <p className="text-[13px] font-medium">Delete this project</p>
            <p className="text-[12px] text-ink-faint">
              Removes the project, all environments, all secrets, version
              history, and its audit trail.
            </p>
          </div>
          <Button
            variant="danger"
            data-testid="delete-project"
            onClick={() => setConfirmDelete(true)}
          >
            Delete project
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRotate}
        danger={false}
        title="Rotate data-encryption key"
        body="This generates a fresh DEK for the project and re-encrypts every current secret under it. The old key is retired but kept so version history stays decryptable. Secrets and their values do not change."
        confirmLabel="Rotate key"
        busy={rotate.isPending}
        onConfirm={() => rotate.mutate()}
        onClose={() => setConfirmRotate(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete project"
        body={
          <>
            This permanently deletes{" "}
            <strong className="text-ink">{project.name}</strong> — every
            environment, secret, version, token, and audit entry. There is no
            undo and no recovery.
          </>
        }
        confirmLabel="Delete forever"
        typedConfirm={project.slug}
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </SettingsSection>
  );
}
