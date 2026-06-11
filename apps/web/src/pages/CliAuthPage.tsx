import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, friendlyMessage, unwrap } from "../api";
import { Button } from "../components/Button";
import { Wordmark } from "../components/Wordmark";
import { buildCallbackUrl, parseCliAuthParams } from "../lib/cliAuth";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-texture flex min-h-dvh flex-col items-center justify-center p-6">
      <div className="mb-8">
        <Wordmark size="lg" />
      </div>
      <div className="w-full max-w-md rounded-xl border border-line-strong bg-panel/90 p-6 shadow-2xl shadow-black/40 backdrop-blur">
        {children}
      </div>
    </div>
  );
}

/**
 * CLI loopback approval. Contract (FIXED — the CLI depends on it):
 * reads ?redirect_port&state&name; approve mints a PAT and redirects to
 * http://127.0.0.1:<port>/callback?token=<t>&tokenId=<id>&state=<s>.
 */
export function CliAuthPage() {
  const [params] = useSearchParams();
  const parsed = useMemo(() => parseCliAuthParams(params), [params]);
  const [denied, setDenied] = useState(false);

  const approve = useMutation({
    mutationFn: async () => {
      if (!parsed.ok) {
        throw new Error("invalid request");
      }
      const minted = await unwrap(
        api.api.me.tokens.post({ name: `cli on ${parsed.request.name}` }),
      );
      return minted;
    },
    onSuccess: (minted) => {
      if (parsed.ok) {
        window.location.assign(
          buildCallbackUrl(parsed.request.port, {
            token: minted.token,
            tokenId: minted.id,
            state: parsed.request.state,
          }),
        );
      }
    },
  });

  if (!parsed.ok) {
    return (
      <Card>
        <h1 className="text-lg font-semibold text-danger">
          Invalid CLI request
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          {parsed.error} Close this tab and run{" "}
          <code className="rounded bg-raised px-1.5 py-px text-[12px]">
            gardens login
          </code>{" "}
          again.
        </p>
      </Card>
    );
  }

  if (denied) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">Request denied</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          No token was created. You can close this tab — the CLI will time out
          on its own.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-lg font-semibold">
        <span className="text-accent">gardens CLI</span> on{" "}
        <span className="font-mono text-base">{parsed.request.name}</span> is
        requesting access
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-dim">
        Approving creates a personal access token with your identity and
        permissions, and hands it to the CLI waiting on this machine (port{" "}
        <code className="text-ink">{parsed.request.port}</code>). You can revoke
        it any time under{" "}
        <Link to="/account/tokens" className="text-accent hover:underline">
          Account tokens
        </Link>
        .
      </p>
      {approve.isError && (
        <p className="mt-3 text-sm text-danger">
          {friendlyMessage(approve.error)}
        </p>
      )}
      <div className="mt-6 flex gap-2">
        <Button
          variant="primary"
          className="flex-1"
          data-testid="cli-auth-approve"
          loading={approve.isPending || approve.isSuccess}
          onClick={() => approve.mutate()}
        >
          Approve
        </Button>
        <Button
          className="flex-1"
          data-testid="cli-auth-deny"
          disabled={approve.isPending || approve.isSuccess}
          onClick={() => setDenied(true)}
        >
          Deny
        </Button>
      </div>
    </Card>
  );
}
