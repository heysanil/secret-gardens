export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-md bg-raised ${className}`}
    />
  );
}

/** Table-shaped loading placeholder. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 py-2" data-testid="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
          key={i}
          className="h-9 w-full"
        />
      ))}
    </div>
  );
}
