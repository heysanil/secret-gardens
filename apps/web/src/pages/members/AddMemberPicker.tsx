import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, friendlyMessage, keys, unwrap } from "../../api";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { useToast } from "../../components/Toast";
import type { MemberRole } from "../ProjectMembersPage";

/**
 * Searchable user picker over GET /api/users (instance directory) minus
 * users who are already members.
 */
export function AddMemberPicker({
  projectId,
  existingUserIds,
}: {
  projectId: string;
  existingUserIds: ReadonlySet<string>;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const [role, setRole] = useState<MemberRole>("read");
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();

  const users = useQuery({
    queryKey: keys.users,
    queryFn: () => unwrap(api.api.users.get()),
    staleTime: 60_000,
  });

  const add = useMutation({
    mutationFn: ({ userId, asRole }: { userId: string; asRole: MemberRole }) =>
      unwrap(
        api.api.projects({ projectId }).members.post({ userId, role: asRole }),
      ),
    onSuccess: (member) => {
      void queryClient.invalidateQueries({ queryKey: keys.members(projectId) });
      setSelected(null);
      setSearch("");
      toast(`${member.name} added as ${member.role}`, "success");
    },
    onError: (err) => toast(friendlyMessage(err), "error"),
  });

  const candidates = (users.data ?? []).filter(
    (u) => !existingUserIds.has(u.id),
  );
  const needle = search.trim().toLowerCase();
  const matches =
    needle === ""
      ? candidates
      : candidates.filter(
          (u) =>
            u.name.toLowerCase().includes(needle) ||
            u.email.toLowerCase().includes(needle),
        );

  return (
    <section className="rounded-xl border border-line bg-panel/40 p-4">
      <h2 className="text-sm font-semibold">Add member</h2>
      <p className="mt-0.5 mb-3 text-[12px] text-ink-faint">
        Anyone with an account on this instance can be added.
      </p>
      <div className="flex items-start gap-2">
        <div className="relative w-72">
          <Input
            aria-expanded={open && matches.length > 0}
            aria-controls={listboxId}
            aria-label="Search users"
            data-testid="add-member-search"
            placeholder="Search by name or email…"
            value={
              selected !== null
                ? `${selected.name} <${selected.email}>`
                : search
            }
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              setSelected(null);
              setSearch(e.target.value);
              setOpen(true);
            }}
          />
          {open && selected === null && (
            <ul
              id={listboxId}
              aria-label="Matching users"
              className="absolute top-full right-0 left-0 z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line-strong bg-raised shadow-xl shadow-black/40"
            >
              {users.isPending ? (
                <li className="px-3 py-2 text-[13px] text-ink-faint">
                  Loading…
                </li>
              ) : matches.length === 0 ? (
                <li className="px-3 py-2 text-[13px] text-ink-faint">
                  {candidates.length === 0
                    ? "Everyone on this instance is already a member."
                    : "No users match."}
                </li>
              ) : (
                matches.slice(0, 50).map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      data-testid={`add-member-option-${u.email}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelected(u);
                        setOpen(false);
                      }}
                      className="block w-full px-3 py-2 text-left transition-colors hover:bg-hover"
                    >
                      <span className="block text-[13px] font-medium">
                        {u.name}
                      </span>
                      <span className="block text-[12px] text-ink-faint">
                        {u.email}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        <Select
          aria-label="Role for new member"
          data-testid="add-member-role"
          value={role}
          onChange={(e) => setRole(e.target.value as MemberRole)}
        >
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="admin">admin</option>
        </Select>
        <Button
          variant="primary"
          data-testid="add-member-submit"
          disabled={selected === null}
          loading={add.isPending}
          onClick={() => {
            if (selected !== null) {
              add.mutate({ userId: selected.id, asRole: role });
            }
          }}
        >
          Add
        </Button>
      </div>
    </section>
  );
}
