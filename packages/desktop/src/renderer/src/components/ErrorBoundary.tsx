import { Component, type ErrorInfo, type ReactNode } from 'react';

type Scope = 'app' | 'view' | 'message';

interface Props {
  scope: Scope;
  /** When this changes after an error, the boundary tries rendering its children again. */
  resetKey?: unknown;
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export function reportError(text: string): void {
  try {
    window.aim?.reportError?.(text);
  } catch {
    /* reporting must never throw */
  }
}

/** Clears saved interface state (last chat, view, panel states) and reloads in safe mode. */
export function resetInterface(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('aim.')) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('safe', '1');
  window.location.replace(url.toString());
}

/**
 * Contains a rendering error to the part of the interface that failed: one message, one page, or (last
 * resort) the whole app — instead of the whole window going blank. Errors are written to A.I.M.'s log.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = (info.componentStack ?? '').split('\n').slice(0, 6).join(' <- ').replace(/\s+/g, ' ');
    reportError(`[${this.props.scope}] ${error.name}: ${error.message}${stack ? ` | ${stack}` : ''}`);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.scope === 'message') {
      return (
        <div className="inline-notice error" role="alert">
          <span>This message could not be displayed. The rest of the chat is unaffected.</span>
        </div>
      );
    }
    const app = this.props.scope === 'app';
    return (
      <div className={app ? 'crash-screen' : 'crash-view'} role="alert">
        <div className="crash-card">
          <div className="crash-title">{app ? 'A.I.M. ran into a problem' : 'This page ran into a problem'}</div>
          <p className="crash-text">
            {app
              ? 'The interface hit an error and stopped drawing. Your chats, goals and memory are safe.'
              : 'Something on this page failed to display. The rest of A.I.M. keeps working.'}
          </p>
          <pre className="crash-detail selectable">{`${error.name}: ${error.message}`}</pre>
          <div className="crash-actions">
            <button className="btn accent" onClick={app ? () => window.location.reload() : this.retry}>
              Try again
            </button>
            <button className="btn" onClick={resetInterface}>
              Reset the interface
            </button>
          </div>
        </div>
      </div>
    );
  }
}
