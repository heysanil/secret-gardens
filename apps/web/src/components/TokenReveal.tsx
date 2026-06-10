import { CopyButton } from "./CopyButton";

/** Show-once token screen: monospace box, copy, unmissable warning. */
export function TokenReveal({ token }: { token: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="token-show-once"
        className="flex items-start gap-2 rounded-lg border border-accent/40 bg-bg p-3"
      >
        <code className="mono-value min-w-0 flex-1 break-all select-all">
          {token}
        </code>
        <CopyButton value={token} label="Copy token" testId="token-copy" />
      </div>
      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-accent">
        <span aria-hidden className="mt-px">
          ⚠
        </span>
        Copy this token now — you won't see it again. It is stored hashed on the
        server.
      </p>
    </div>
  );
}
