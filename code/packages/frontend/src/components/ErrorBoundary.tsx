// The one top-level React error boundary (webapp.mdx §resilience). Before this existed the app had NO
// boundary: any error thrown in the render/commit phase — including the container-level DOM churn errors
// ("Failed to execute 'insertBefore'/'removeChild' … not a child of this node", 687× in the July fault
// trail) — unmounted the ENTIRE root, leaving a blank white page on every route (Processing included).
// This catches those throws, logs them to the fault trail via clientLog, and shows a recoverable card
// instead of a dead screen. Primary recovery is a full reload (a container-DOM error can leave React's
// internal tree out of sync, so a clean remount is the safe path); a lighter "Try again" resets state.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { clientLog } from "../lib/clientLog.js";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reaches error.err through the client-log bridge, with the component stack so the culprit subtree
    // is identifiable — instead of the app just vanishing.
    clientLog.error("ErrorBoundary", { message: error.message, stack: error.stack, componentStack: info.componentStack });
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-full place-items-center p-8">
        <div
          className="max-w-md rounded-lg border bg-white px-6 py-5 text-center shadow-sm"
          style={{ borderColor: "var(--lfb-border)" }}
          role="alert"
        >
          <div className="text-base font-semibold text-black">Something went wrong on this screen.</div>
          <p className="mt-1.5 text-sm text-black/60">
            The page hit an unexpected error and stopped rendering. Reloading usually clears it.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-md px-4 py-1.5 text-sm font-medium text-white"
              style={{ background: "var(--lfb-primary)" }}
            >
              Reload app
            </button>
            <button
              onClick={this.reset}
              className="rounded-md border px-4 py-1.5 text-sm text-black/70 hover:bg-slate-100"
              style={{ borderColor: "var(--lfb-border)" }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
