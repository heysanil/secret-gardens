import { useState } from "react";
import { CopyButton } from "../../components/CopyButton";
import { AutoTextarea } from "../../components/Input";
import { Skeleton } from "../../components/Skeleton";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/relativeTime";
import type { SecretEntry } from "./SecretsTable";

const MASK = "••••••••";

export function SecretRow({
  entry,
  updatedByName,
  value,
  revealed,
  valuesLoading,
  canWrite,
  saving,
  onToggleReveal,
  getValue,
  onSave,
  onDelete,
  onHistory,
}: {
  entry: SecretEntry;
  /** Resolved display name for updatedBy; undefined → show the raw id. */
  updatedByName: string | undefined;
  value: string | undefined;
  revealed: boolean;
  valuesLoading: boolean;
  canWrite: boolean;
  saving: boolean;
  onToggleReveal: () => void;
  getValue: () => Promise<string | null>;
  onSave: (value: string) => void;
  onDelete: () => void;
  onHistory: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function startEdit() {
    if (canWrite && value !== undefined) {
      setDraft(value);
      setEditing(true);
    }
  }

  function commit() {
    setEditing(false);
    if (draft !== value) {
      onSave(draft);
    }
  }

  const showValue = revealed && value !== undefined;

  return (
    <tr
      data-testid={`secret-row-${entry.key}`}
      className="group border-b border-line last:border-b-0 hover:bg-panel/60"
    >
      <td className="max-w-56 px-4 py-2.5 align-top">
        <code className="block truncate text-[13px] font-medium tabular-nums">
          {entry.key}
        </code>
        <span className="text-[11px] text-ink-faint">v{entry.version}</span>
      </td>

      <td className="w-full px-4 py-2.5 align-top">
        {editing ? (
          <div className="flex flex-col gap-2">
            <AutoTextarea
              aria-label={`Value for ${entry.key}`}
              data-testid="secret-edit-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  commit();
                }
              }}
              autoFocus
            />
            <div className="flex gap-2 text-[12px]">
              <button
                type="button"
                data-testid="secret-edit-save"
                onClick={commit}
                className="rounded-md font-medium text-accent hover:text-accent-bright"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md text-ink-faint hover:text-ink"
              >
                Cancel
              </button>
              <span className="text-ink-faint">⌘↵ to save · esc to cancel</span>
            </div>
          </div>
        ) : revealed && valuesLoading && value === undefined ? (
          <Skeleton className="h-5 w-44" />
        ) : showValue ? (
          <button
            type="button"
            data-testid="secret-value"
            onClick={startEdit}
            title={canWrite ? "Click to edit" : undefined}
            disabled={!canWrite || saving}
            className={`mono-value w-full max-w-xl rounded-md text-left break-all whitespace-pre-wrap ${
              canWrite ? "cursor-text hover:bg-hover/60" : "cursor-default"
            } ${value === "" ? "text-ink-faint italic" : ""} ${
              saving ? "opacity-50" : ""
            }`}
          >
            {value === "" ? "(empty)" : value}
          </button>
        ) : (
          <span className="mono-value text-ink-faint select-none">{MASK}</span>
        )}
      </td>

      <td className="px-4 py-2.5 align-top whitespace-nowrap">
        <span
          className="text-[12px] text-ink-dim"
          title={formatAbsoluteTime(entry.updatedAt)}
        >
          {formatRelativeTime(entry.updatedAt)}
        </span>
        <span
          className={`block max-w-32 truncate text-[11px] text-ink-faint ${
            updatedByName === undefined ? "font-mono" : ""
          }`}
          title={entry.updatedBy}
        >
          {updatedByName ?? entry.updatedBy}
        </span>
      </td>

      <td className="px-4 py-2.5 align-top">
        <div className="flex items-center justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            data-testid="reveal-toggle"
            aria-label={revealed ? `Hide ${entry.key}` : `Reveal ${entry.key}`}
            aria-pressed={revealed}
            title={revealed ? "Hide value" : "Reveal value"}
            onClick={onToggleReveal}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-4 fill-none stroke-current stroke-[1.2]"
            >
              <title>{revealed ? "Hide value" : "Reveal value"}</title>
              <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
              {revealed ? (
                <circle cx="8" cy="8" r="2" className="fill-current" />
              ) : (
                <circle cx="8" cy="8" r="2" />
              )}
            </svg>
          </button>
          <CopyButton
            value={() => getValue()}
            label={`Copy ${entry.key}`}
            testId="copy-value"
          />
          <button
            type="button"
            data-testid="secret-history"
            aria-label={`History of ${entry.key}`}
            title="Version history"
            onClick={onHistory}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-4 fill-none stroke-current stroke-[1.2]"
            >
              <title>Version history</title>
              <circle cx="8" cy="8" r="6.2" />
              <path d="M8 4.5V8l2.5 1.5" />
            </svg>
          </button>
          {canWrite && (
            <button
              type="button"
              data-testid="secret-delete"
              aria-label={`Delete ${entry.key}`}
              title="Delete secret"
              onClick={onDelete}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-danger/15 hover:text-danger"
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="size-4 fill-none stroke-current stroke-[1.2]"
              >
                <title>Delete secret</title>
                <path d="M2.5 4.5h11M6.5 2.5h3M5.5 4.5l.5 9h4l.5-9" />
              </svg>
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
