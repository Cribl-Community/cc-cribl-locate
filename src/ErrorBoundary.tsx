import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Catches render/runtime errors in the tree and shows them inline instead of a
 * blank screen. Without this, an uncaught error unmounts the whole app — which
 * inside the Cribl iframe just looks like the UI vanishing after it appears.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Also log for the browser console / dev server.
    console.error('Cribl Locate crashed:', error, info);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: 'monospace', color: '#c0392b' }}>
        <h2 style={{ marginTop: 0 }}>Cribl Locate hit an error</h2>
        <p style={{ color: '#333' }}>
          The app crashed while rendering. The message and stack below should point at the cause.
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#fdf1f0', padding: 12, borderRadius: 6 }}>
          {String(error?.stack || error?.message || error)}
        </pre>
        {info?.componentStack && (
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f5f5f5', padding: 12, borderRadius: 6, color: '#555' }}>
            {info.componentStack}
          </pre>
        )}
      </div>
    );
  }
}
