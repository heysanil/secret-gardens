import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useOutletContext } from "react-router";
import { api, friendlyMessage, keys, unwrap } from "../api";
import { RoleBadge } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Select } from "../components/Select";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { useMe } from "../queries";
import { AddMemberPicker } from "./members/AddMemberPicker";
import type { ProjectContext } from "./ProjectLayout";

const ROLES = ["admin", "write", "read"] as const;
export type MemberRole = (typeof ROLES)[number];

export function ProjectMembersPage() {
  const { project } = useOutletContext<ProjectContext>();
  const isAdmin = project.role === "admin";
  const me = useMe();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<{
    userId: string;
    name: string;
  } | null>(null);

  const membersApi = api.api.projects({ projectId: project.id }).members;

  const members = useQuery({
    queryKey: keys.members(project.id),
    queryFn: () => unwrap(membersApi.get()),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: keys.members(project.id) });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MemberRole }) =>
      unwrap(membersApi({ userId }).patch({ role })),
    onSuccess: (res) => {
      invalidate();
      toast(`Role changed to ${res.role}`, "success");
    },
    onError: (err) => {
      invalidate();
      toast(friendlyMessage(err), "error");
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) => unwrap(membersApi({ userId }).delete()),
    onSuccess: () => {
      invalidate();
      setRemoving(null);
      toast("Member removed", "success");
    },
    onError: (err) => {
      setRemoving(null);
      toast(friendlyMessage(err), "error");
    },
  });

  if (members.isPending) {
    return <SkeletonRows rows={3} />;
  }

  const list = members.data ?? [];
  const myUserId = me.data?.userId;

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-panel text-left text-[11px] tracking-widest text-ink-faint uppercase">
              <th className="px-4 py-2.5 font-semibold">Member</th>
              <th className="w-36 px-4 py-2.5 font-semibold">Role</th>
              {isAdmin && (
                <th className="w-20 px-4 py-2.5" aria-label="Actions" />
              )}
            </tr>
          </thead>
          <tbody>
            {list.map((m) => {
              const isSelf = m.userId === myUserId;
              return (
                <tr
                  key={m.userId}
                  data-testid={`member-row-${m.userId}`}
                  className="border-b border-line last:border-b-0 hover:bg-panel/60"
                >
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{m.name}</span>
                      {isSelf && (
                        <span className="text-[11px] text-ink-faint">
                          (you)
                        </span>
                      )}
                    </span>
                    <span className="text-[12px] text-ink-faint">
                      {m.email}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {isAdmin && !isSelf ? (
                      <Select
                        aria-label={`Role of ${m.name}`}
                        data-testid="member-role-select"
                        value={m.role}
                        disabled={changeRole.isPending}
                        onChange={(e) =>
                          changeRole.mutate({
                            userId: m.userId,
                            role: e.target.value as MemberRole,
                          })
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-2.5 text-right">
                      {!isSelf && (
                        <button
                          type="button"
                          data-testid="member-remove"
                          onClick={() =>
                            setRemoving({ userId: m.userId, name: m.name })
                          }
                          className="rounded-md text-[12px] font-medium text-ink-faint transition-colors hover:text-danger"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <AddMemberPicker
          projectId={project.id}
          existingUserIds={new Set(list.map((m) => m.userId))}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove member"
        body={
          <>
            Remove <strong className="text-ink">{removing?.name}</strong> from
            this project? They lose access to all its environments immediately.
          </>
        }
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing.userId);
          }
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
