import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { signIn, useSession } from "../auth";
import { Button } from "../components/Button";
import { Field, Input } from "../components/Input";
import { safeNextPath } from "../gates";
import { AuthLayout } from "./AuthLayout";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: session, isPending } = useSession();

  const next = safeNextPath(params.get("next"));

  if (!isPending && session) {
    return <Navigate to={next} replace />;
  }

  async function onSubmit() {
    setBusy(true);
    setError(null);
    const res = await signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(
        res.error.status === 401 || res.error.status === 403
          ? "Invalid email or password."
          : (res.error.message ?? "Sign-in failed. Please try again."),
      );
      return;
    }
    navigate(next, { replace: true });
  }

  return (
    <AuthLayout
      heading="Sign in"
      sub="Use the account an admin created for you."
      footer={
        <Link
          to="/setup"
          className="rounded-md transition-colors hover:text-ink"
        >
          First run? Create the admin account →
        </Link>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) {
            void onSubmit();
          }
        }}
      >
        <Field label="Email">
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              data-testid="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          )}
        </Field>
        <Field label="Password" error={error}>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="mt-1 w-full"
          loading={busy}
          data-testid="login-submit"
        >
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
