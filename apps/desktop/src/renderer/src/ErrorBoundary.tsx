import { Component, type ReactNode } from "react";

type State = { error?: Error };

/** A failure inside one surface stays inside it: the shell and the way back keep working. */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void; label: string }, State> {
  override state: State = {};
  static getDerivedStateFromError(error: Error): State { return { error }; }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="grid h-full place-items-center p-10 text-center">
        <div className="grid max-w-[460px] gap-3">
          <strong className="text-[16px] text-label">{this.props.label} stopped working.</strong>
          <pre className="whitespace-pre-wrap rounded-card bg-content-2 p-3 text-left font-mono text-[12px] text-label-2">{error.message}</pre>
          {this.props.onReset ? <button type="button" className="justify-self-center rounded-pill bg-fill px-3.5 py-1.5 text-[13px] font-medium text-label" onClick={() => { this.setState({}); this.props.onReset?.(); }}>Back</button> : null}
        </div>
      </div>
    );
  }
}
