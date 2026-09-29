import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ServerError } from '../screens/StatusScreens.tsx';

/** Last line of defence: a render crash shows a recoverable screen, never a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No remote error reporting: stack traces stay in this browser's console.
    // eslint-disable-next-line no-console -- the only place a crash is reported.
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <ServerError
          onRetry={() => {
            window.location.reload();
          }}
        />
      );
    }
    return this.props.children;
  }
}
