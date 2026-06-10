import { validateSecretKey } from "@safe/shared";
import { useState } from "react";
import { Button } from "../../components/Button";
import { AutoTextarea, Input } from "../../components/Input";

/** Inline "add secret" form below the table. Key validated as you type. */
export function AddSecretRow({
  existingKeys,
  busy,
  onAdd,
}: {
  existingKeys: ReadonlySet<string>;
  busy: boolean;
  onAdd: (key: string, value: string) => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  const keyError =
    key === ""
      ? null
      : (validateSecretKey(key) ??
        (existingKeys.has(key)
          ? "This key already exists — edit its value in the table above."
          : null));

  const canSubmit = key !== "" && keyError === null && !busy;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    try {
      await onAdd(key, value);
      setKey("");
      setValue("");
      setTouched(false);
    } catch {
      // mutation surfaces its own toast; keep the draft for retry
    }
  }

  return (
    <form
      className="mt-3 flex items-start gap-2 rounded-xl border border-dashed border-line-strong bg-panel/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="w-64 shrink-0">
        <Input
          aria-label="New secret key"
          data-testid="add-secret-key"
          mono
          placeholder="SECRET_KEY"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => {
            setKey(e.target.value.trim());
            setTouched(true);
          }}
          aria-invalid={touched && keyError !== null}
        />
        {touched && keyError !== null && (
          <p className="mt-1 text-[12px] leading-snug text-danger">
            {keyError}
          </p>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <AutoTextarea
          aria-label="New secret value"
          data-testid="add-secret-value"
          placeholder="value (multiline supported)"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        disabled={!canSubmit}
        loading={busy}
        data-testid="add-secret-submit"
      >
        Add
      </Button>
    </form>
  );
}
