import { Suspense, lazy, useEffect } from 'react';
import { AppShell } from './components/Layout.tsx';
import { BrandMark } from './components/Brand.tsx';
import { navigate, usePath } from './lib/router.ts';
import { Activity } from './screens/Activity.tsx';
import { Home } from './screens/Home.tsx';
import { Logs } from './screens/Logs.tsx';
import { Machines } from './screens/Machines.tsx';
import { Security } from './screens/Security.tsx';
import { Terminals } from './screens/Terminals.tsx';
import { SetupWizard } from './screens/SetupWizard.tsx';
import { PasswordSignIn, Recovery, SignIn } from './screens/SignIn.tsx';
import { NotFound, ServerError, SetupNeeded } from './screens/StatusScreens.tsx';
import { useAuth } from './state/auth.tsx';

// xterm.js is big; load it only when a terminal is opened.
const TerminalView = lazy(async () => ({
  default: (await import('./screens/TerminalView.tsx')).TerminalView,
}));

const SIGNED_IN_SCREENS: Record<string, () => React.JSX.Element> = {
  '/': Home,
  '/terminals': Terminals,
  '/machines': Machines,
  '/logs': Logs,
  '/security': Security,
  '/activity': Activity,
};

function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return null;
}

function Splash() {
  return (
    <div
      className="flex min-h-dvh items-center justify-center"
      aria-busy="true"
      aria-label="Loading"
    >
      <BrandMark className="size-10 animate-pulse" />
    </div>
  );
}

export function App() {
  const path = usePath();
  const { status, error, setupRequired, session, refresh } = useAuth();

  // The setup link carries its own token, so it works before anything else loads.
  if (path === '/setup') return <SetupWizard />;
  if (status === 'loading') return <Splash />;
  if (status === 'error') {
    return <ServerError onRetry={() => void refresh()} requestId={error?.requestId} />;
  }
  if (setupRequired) return <SetupNeeded />;

  if (!session) {
    if (path === '/recovery') return <Recovery />;
    if (path === '/signin/password') return <PasswordSignIn />;
    if (path !== '/signin') return <Redirect to="/signin" />;
    return <SignIn />;
  }

  if (path === '/signin' || path === '/signin/password' || path === '/recovery') {
    return <Redirect to="/" />;
  }
  const terminal = /^\/terminals\/([^/]+)$/.exec(path)?.[1];
  if (terminal) {
    // Full screen: the terminal gets all the room, on phones too.
    const name = decodeURIComponent(terminal);
    return (
      <Suspense fallback={<Splash />}>
        <TerminalView key={name} name={name} />
      </Suspense>
    );
  }
  const Screen = SIGNED_IN_SCREENS[path];
  if (!Screen) return <NotFound />;
  return (
    <AppShell>
      <Screen />
    </AppShell>
  );
}
