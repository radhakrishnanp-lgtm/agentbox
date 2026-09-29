import type { AuthState, SessionInfo } from '@agentbox/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { api, ApiError, onSignedOut, post } from '../lib/api.ts';

type Status = 'loading' | 'ready' | 'error';

interface AuthContextValue {
  status: Status;
  error: ApiError | null;
  setupRequired: boolean;
  session: SessionInfo | null;
  /** Re-reads /api/auth/state (used after errors and on tab focus). */
  refresh: () => Promise<void>;
  /** Called by screens that just signed in or re-authenticated. */
  setSession: (session: SessionInfo) => void;
  signOut: () => Promise<void>;
  /** Tells the server you're still here; throttled so typing doesn't flood it. */
  touch: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOUCH_INTERVAL_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [session, setSessionState] = useState<SessionInfo | null>(null);
  const lastTouch = useRef(0);
  const touching = useRef(false);

  const refresh = useCallback(
    () =>
      api<AuthState>('/api/auth/state').then(
        (state) => {
          setSetupRequired(state.setupRequired);
          setSessionState(state.session);
          setError(null);
          setStatus('ready');
        },
        (err: unknown) => {
          setError(err instanceof ApiError ? err : new ApiError(0, null));
          setStatus('error');
        },
      ),
    [],
  );

  const setSession = useCallback((s: SessionInfo) => {
    setSessionState(s);
    setSetupRequired(false);
    lastTouch.current = Date.now();
  }, []);

  const signOut = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      setSessionState(null);
    }
  }, []);

  const touch = useCallback(() => {
    if (touching.current || Date.now() - lastTouch.current < TOUCH_INTERVAL_MS) return;
    touching.current = true;
    lastTouch.current = Date.now();
    post<SessionInfo>('/api/auth/activity')
      .then(setSessionState)
      .catch(() => {
        // A signed-out response is handled by the onSignedOut listener.
      })
      .finally(() => {
        touching.current = false;
      });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any API call that finds the session gone drops us back to sign-in.
  useEffect(
    () =>
      onSignedOut((err) => {
        setSessionState((prev) => {
          if (prev) {
            toast(err.code === 'session_expired' ? 'Your session ended.' : 'You were signed out.', {
              description: err.message,
            });
          }
          return null;
        });
      }),
    [],
  );

  // Coming back to the tab re-checks the session: it may have expired or been revoked.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ status, error, setupRequired, session, refresh, setSession, signOut, touch }),
    [status, error, setupRequired, session, refresh, setSession, signOut, touch],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Same as useAuth, for screens that only render with a session. */
export function useSession(): SessionInfo {
  const { session } = useAuth();
  if (!session) throw new Error('useSession needs a signed-in session');
  return session;
}
