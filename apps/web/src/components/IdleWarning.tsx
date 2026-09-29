import { SESSION_DEFAULTS } from '@agentbox/shared';
import { useEffect, useState } from 'react';
import { post } from '../lib/api.ts';
import { useAuth } from '../state/auth.tsx';
import { Button } from './ui/button.tsx';
import type { SessionInfo } from '@agentbox/shared';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Keeps the idle timer honest: interaction pings the server (throttled), and two
 * minutes before the idle limit a banner offers to stay signed in.
 */
export function IdleWarning() {
  const { session, touch, setSession, refresh } = useAuth();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onActivity = () => {
      touch();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true });
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity);
    };
  }, [touch]);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);

  const idleEnd = session ? new Date(session.idleExpiresAt).getTime() : Infinity;
  const hardEnd = session ? new Date(session.expiresAt).getTime() : Infinity;
  const left = Math.max(0, Math.round((Math.min(idleEnd, hardEnd) - now) / 1000));
  const expired = session !== null && left === 0;

  // The server has already ended it; confirm, which falls back to sign-in.
  useEffect(() => {
    if (expired) void refresh();
  }, [expired, refresh]);

  if (!session || expired || left > SESSION_DEFAULTS.idleWarningSeconds) return null;

  const isHardLimit = hardEnd <= idleEnd;
  const mins = Math.floor(left / 60);
  const secs = String(left % 60).padStart(2, '0');

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Session ending soon"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-lg flex-col gap-3 rounded-[var(--radius-card)] border border-warning/50 bg-surface p-4 shadow-xl sm:flex-row sm:items-center"
    >
      <p className="flex-1 text-sm">
        {isHardLimit
          ? `Your session reaches its maximum length in ${mins}:${secs}. You'll need to sign in again.`
          : `You'll be signed out in ${mins}:${secs} because of inactivity.`}
      </p>
      {isHardLimit ? null : (
        <Button
          onClick={() => {
            post<SessionInfo>('/api/auth/activity')
              .then(setSession)
              .catch(() => undefined);
          }}
        >
          Stay signed in
        </Button>
      )}
    </div>
  );
}
