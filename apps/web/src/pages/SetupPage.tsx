import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { keys } from "../api";
import { signUp } from "../auth";
import { Button } from "../components/Button";
import { Field, Input } from "../components/Input";
import { passwordStrength } from "../lib/password";
import { useBootstrap } from "../queries";
import { AuthLayout } from "./AuthLayout";

const STRENGTH_COLORS = ["bg-danger", "bg-danger", "bg-accent", "bg-ok"];

/** First-run setup: the first signup becomes the instance owner. */
export function SetupPage() {
  const bootstrap = useBootstrap();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  if (!bootstrap.isPending && bootstrap.data?.needsSetup === false) {
    return <Navigate to="/login" replace />;
  }

  const strength = passwordStrength(password);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    const res = await signUp.email({ name, email, password });
    if (res.error) {
      setBusy(false);
      setError(
        res.error.message ??
          "Could not create the account. Check the values and try again.",
      );
      return;
    }
    // signUp auto-signs-in; the instance is no longer in setup state.
    await queryClient.invalidateQueries({ queryKey: keys.bootstrap });
    navigate("/", { replace: true });
  }

  return (
    <AuthLayout
      heading="Create the admin account"
      sub="You're setting up this secret-gardens instance. The first account becomes the instance owner; self-signup is disabled afterwards."
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
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              data-testid="setup-name"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          )}
        </Field>
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              data-testid="setup-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          )}
        </Field>
        <Field
          label="Password"
          error={error}
          hint={
            password.length > 0 ? (
              <span className="flex items-center gap-2">
                <span className="flex gap-1" aria-hidden>
                  {[1, 2, 3].map((step) => (
                    <span
                      key={step}
                      className={`h-1 w-7 rounded-full ${
                        strength.score >= step
                          ? STRENGTH_COLORS[strength.score]
                          : "bg-raised"
                      }`}
                    />
                  ))}
                </span>
                {strength.label}
              </span>
            ) : (
              "12+ characters with mixed types is a good baseline."
            )
          }
        >
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              data-testid="setup-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
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
          data-testid="setup-submit"
        >
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
