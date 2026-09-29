import { useEffect } from 'react';
import { AppShell } from './components/Layout.tsx';
import { BrandMark } from './components/Brand.tsx';
import { navigate, usePath } from './lib/router.ts';
import { Activity } from './screens/Activity.tsx';
import { Home } from './screens/Home.tsx';
import { Machines } from './screens/Machines.tsx';
import { Security } from './screens/Security.tsx';
import { SetupWizard } from './screens/SetupWizard.tsx';
import { Recovery, SignIn } from './screens/SignIn.tsx';
import { NotFound, ServerError, SetupNeeded } from './screens/StatusScreens.tsx';
import { useAuth } from './state/auth.tsx';

const SIGNED_IN_SCREENS: Record<string, () => React.JSX.Element> = {
  '/': Home,
  '/machines': Machines,
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
    if (path !== '/signin') return <Redirect to="/signin" />;
    return <SignIn />;
  }

  if (path === '/signin' || path === '/recovery') return <Redirect to="/" />;
  const Screen = SIGNED_IN_SCREENS[path];
  if (!Screen) return <NotFound />;
  return (
    <AppShell>
      <Screen />
    </AppShell>
  );
}
