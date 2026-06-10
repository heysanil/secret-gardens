/** The "safe." wordmark — pure typography, accent full stop. */
export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={`font-bold tracking-tight text-ink select-none ${
        size === "lg" ? "text-4xl" : "text-xl"
      }`}
    >
      safe<span className="text-accent">.</span>
    </span>
  );
}
