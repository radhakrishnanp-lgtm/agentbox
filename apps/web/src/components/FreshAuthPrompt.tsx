import { useEffect, useState, type SyntheticEvent } from 'react';
import type { SessionInfo } from '@agentbox/shared';
import { ConfirmDialog } from './ui/dialog.tsx';
import { Field } from './ui/field.tsx';
import { errorMessage, post } from '../lib/api.ts';
import { registerCodePrompt, FreshAuthCancelled } from '../lib/fresh-auth.ts';

interface Pending {
  reason: string | null;
  resolve: (s: SessionInfo) => void;
  reject: (err: unknown) => void;
}

/**
 * Asks for an authenticator code before a sensitive action, when the passkey
 * can't be used on this computer (none here, cancelled, or not supported).
 */
export function FreshAuthPrompt() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      registerCodePrompt(
        (reason) =>
          new Promise<SessionInfo>((resolve, reject) => {
            setCode('');
            setError(undefined);
            setPending({ reason, resolve, reject });
          }),
      ),
    [],
  );

  const close = () => {
    pending?.reject(new FreshAuthCancelled());
    setPending(null);
  };

  const confirm = (e?: SyntheticEvent) => {
    e?.preventDefault();
    if (!pending) return;
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app');
      return;
    }
    setBusy(true);
    post<SessionInfo>('/api/auth/reauth/code', { code })
      .then((session) => {
        pending.resolve(session);
        setPending(null);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Confirm it's you"
      description={
        <>
          {pending?.reason ? <p className="mb-2">{pending.reason}</p> : null}
          <p>Enter the code from your authenticator app to continue.</p>
        </>
      }
      confirmLabel="Confirm"
      loading={busy}
      onConfirm={confirm}
    >
      <form className="mt-4" onSubmit={confirm} noValidate>
        <Field
          label="6-digit authenticator code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, ''));
          }}
          error={error}
        />
      </form>
    </ConfirmDialog>
  );
}
