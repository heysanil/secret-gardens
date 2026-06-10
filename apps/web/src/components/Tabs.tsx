export interface TabItem {
  id: string;
  label: string;
  testId?: string;
}

export function Tabs({
  items,
  active,
  onChange,
  ariaLabel,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-end gap-1 border-b border-line"
    >
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={item.testId}
            onClick={() => onChange(item.id)}
            className={`-mb-px rounded-t-md border-b-2 px-3.5 py-2 text-sm transition-colors duration-100 ${
              selected
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-dim hover:bg-hover hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
