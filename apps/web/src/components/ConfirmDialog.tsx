import { type ReactNode, useEffect, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  /** When set, the user must type this exact string to enable confirm. */
  typedConfirm?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmation for destructive actions, with optional typed confirmation. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  typedConfirm,
  danger = true,
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) {
      setTyped("");
    }
  }, [open]);

  const blocked = typedConfirm !== undefined && typed !== typedConfirm;

  return (
    <Modal open={open} onClose={onClose} title={title} testId="confirm-dialog">
      <div className="flex flex-col gap-4">
        <div className="text-sm leading-relaxed text-ink-dim">{body}</div>
        {typedConfirm !== undefined && (
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[13px] text-ink-dim"
              htmlFor="confirm-typed-input"
            >
              Type{" "}
              <code className="rounded bg-raised px-1 py-px text-[12px] text-ink">
                {typedConfirm}
              </code>{" "}
              to confirm
            </label>
            <Input
              id="confirm-typed-input"
              data-testid="confirm-input"
              mono
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button data-testid="confirm-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            data-testid="confirm-accept"
            disabled={blocked}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
