/** The "secret gardens." wordmark — pure typography, accent full stop. */
export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={`font-bold tracking-tight whitespace-nowrap text-ink select-none ${
        size === "lg" ? "text-4xl" : "text-xl"
      }`}
    >
      secret&nbsp;gardens<span className="text-accent">.</span>
    </span>
  );
}
