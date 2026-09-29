import { CloudOff, KeyRound, SearchX, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from '../components/Layout.tsx';
import { Brand } from '../components/Brand.tsx';
import { Button } from '../components/ui/button.tsx';

function StatusScreen({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center px-4">
        <Brand />
      </header>
      <main
        id="main"
        className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 pb-16 text-center"
      >
        <div className="rounded-full bg-surface-2 p-4 text-muted">{icon}</div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="space-y-2 text-muted">{children}</div>
        {action ? <div className="mt-2">{action}</div> : null}
      </main>
    </div>
  );
}

export function NotFound() {
  return (
    <StatusScreen
      icon={<SearchX className="size-8" aria-hidden />}
      title="Page not found"
      action={
        <Button asChild>
          <Link to="/">Go home</Link>
        </Button>
      }
    >
      <p>That address doesn't exist in agentbox.</p>
    </StatusScreen>
  );
}

export function ServerError({
  onRetry,
  requestId,
}: {
  onRetry: () => void;
  requestId?: string | undefined;
}) {
  return (
    <StatusScreen
      icon={<CloudOff className="size-8" aria-hidden />}
      title="agentbox isn't responding"
      action={<Button onClick={onRetry}>Try again</Button>}
    >
      <p>The page couldn't load. Your sessions and terminals on the server are unaffected.</p>
      {requestId ? (
        <p className="text-sm">
          Reference: <code className="font-mono">{requestId}</code>
        </p>
      ) : null}
    </StatusScreen>
  );
}

export function SetupNeeded() {
  return (
    <StatusScreen
      icon={<KeyRound className="size-8" aria-hidden />}
      title="Finish setting up agentbox"
    >
      <p>agentbox has no owner yet. To protect it, setup only works through a one-time link.</p>
      <p>Connect to your server over SSH and run:</p>
      <pre className="rounded-[var(--radius-input)] bg-surface-2 px-3 py-2 text-left font-mono text-sm text-text">
        sudo agentbox setup-link
      </pre>
      <p>
        Open the link it prints on the device you want to use. It works once and expires after 30
        minutes.
      </p>
    </StatusScreen>
  );
}

export function AccessDenied({ message }: { message: string }) {
  return (
    <StatusScreen
      icon={<ShieldAlert className="size-8" aria-hidden />}
      title="Access denied"
      action={
        <Button asChild variant="secondary">
          <Link to="/">Go home</Link>
        </Button>
      }
    >
      <p>{message}</p>
    </StatusScreen>
  );
}
