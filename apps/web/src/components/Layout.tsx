import { Activity, House, LogOut, ShieldCheck } from 'lucide-react';
import { useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { navigate, usePath } from '../lib/router.ts';
import { useAuth } from '../state/auth.tsx';
import { Brand } from './Brand.tsx';
import { IdleWarning } from './IdleWarning.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { Button } from './ui/button.tsx';

/** In-app link that uses the History API instead of a full page load. */
export function Link({
  to,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

const NAV = [
  { to: '/', label: 'Home', icon: House },
  { to: '/security', label: 'Security', icon: ShieldCheck },
  { to: '/activity', label: 'Activity', icon: Activity },
] as const;

/** Signed-in layout: top bar on desktop, bottom tab bar on phones. */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePath();
  const { signOut } = useAuth();
  const [leaving, setLeaving] = useState(false);

  const onSignOut = () => {
    setLeaving(true);
    signOut()
      .then(() => {
        navigate('/signin', { replace: true });
      })
      .catch((err: unknown) => {
        toast.error(errorMessage(err));
      })
      .finally(() => {
        setLeaving(false);
      });
  };

  return (
    <div className="min-h-dvh pb-20 sm:pb-0">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
          <Link to="/" aria-label="agentbox home">
            <Brand />
          </Link>
          <nav aria-label="Main" className="ml-6 hidden gap-1 sm:flex">
            {NAV.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                aria-current={path === to ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text',
                  path === to && 'bg-surface-2 text-text',
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Button variant="ghost" onClick={onSignOut} loading={leaving}>
              {leaving ? null : <LogOut className="size-4" aria-hidden />}
              <span>Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
        {children}
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            aria-current={path === to ? 'page' : undefined}
            className={cn(
              'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted',
              path === to && 'text-accent',
            )}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>
      <IdleWarning />
    </div>
  );
}

/** Signed-out layout: one centred card. */
export function AuthLayout({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between px-4">
        <Brand />
        <ThemeToggle />
      </header>
      <main
        id="main"
        className={cn(
          'mx-auto flex w-full flex-1 flex-col justify-center px-4 pb-16',
          wide ? 'max-w-lg' : 'max-w-sm',
        )}
      >
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <div className="mt-2 text-muted">{description}</div> : null}
        <div className="mt-6">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
