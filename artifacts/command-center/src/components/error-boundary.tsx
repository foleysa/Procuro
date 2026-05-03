import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Top-level / per-route error boundary (task #297, step 3).
 *
 * Catches render-time exceptions from anywhere inside `children` and
 * shows a recoverable fallback with a "Try again" affordance instead
 * of letting the whole page blank out. The boundary deliberately does
 * NOT catch async/promise errors — those are handled by React Query's
 * inline error state — but it does catch the synchronous render errors
 * that previously took the entire SPA down when one widget threw.
 *
 * Used in two flavours:
 *   - root: wraps the whole app in `main.tsx` so a thrown error in any
 *     provider/layout still renders a usable fallback.
 *   - per-route: wraps each top-level route in `App.tsx` so an error in
 *     one section (Dashboard, Operations, Registry, Settings) does not
 *     blank the chrome around it.
 *
 * `resetKey` lets the parent force a re-mount of the boundary's
 * children — e.g. on route change — so a navigation away from a
 * crashing page implicitly clears the fallback.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Friendly label rendered in the fallback ("Couldn't load
   * {scope}."). Defaults to "this section".
   */
  scope?: string;
  /**
   * When this value changes, the boundary resets its captured error so
   * the next render attempts the children again. Pass a route key
   * (e.g. wouter's `location`) at the per-route level.
   */
  resetKey?: unknown;
  /** Optional render override for tests / custom layouts. */
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface in the dev console; production telemetry is the
    // server's request log + the browser's own error reporting.
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary] ${this.props.scope ?? "section"} crashed`,
      error,
      info,
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset });
    }
    const scope = this.props.scope ?? "this section";
    return (
      <div
        className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-6"
        role="alert"
        data-testid="error-boundary-fallback"
      >
        <h2 className="text-base font-semibold text-destructive">
          Couldn&rsquo;t load {scope}.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong while rendering this page. The rest of
          the app is still usable.
        </p>
        <pre
          data-testid="error-boundary-message"
          className="mt-3 max-h-32 overflow-auto rounded bg-background/50 p-2 font-mono text-xs text-muted-foreground"
        >
          {error.message}
        </pre>
        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={this.reset}
            data-testid="button-error-boundary-retry"
          >
            Try again
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
            data-testid="button-error-boundary-reload"
          >
            Reload page
          </Button>
        </div>
      </div>
    );
  }
}
