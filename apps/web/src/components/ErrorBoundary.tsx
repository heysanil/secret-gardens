import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Root error boundary with a reload affordance. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl border border-line-strong bg-panel p-6 text-center">
          <p className="font-mono text-sm text-danger">something broke</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            {this.state.error.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-semibold text-black transition-colors hover:bg-accent-bright"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
