import { LIMITS, displayNameSchema, recoveryCodeSchema, totpCodeSchema } from '@agentbox/shared';
import type { SignInResult } from '@agentbox/shared';
import { Fingerprint, LifeBuoy, MonitorSmartphone } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { AuthLayout, Link } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Alert } from '../components/ui/feedback.tsx';
import { Field } from '../components/ui/field.tsx';
import { errorMessage, post } from '../lib/api.ts';
import { suggestDeviceName } from '../lib/format.ts';
import { passkeysSupported, signInWithPasskey } from '../lib/passkeys.ts';
import { navigate } from '../lib/router.ts';
import { useAuth } from '../state/auth.tsx';

type FormErrors<K extends string> = Partial<Record<K, string | undefined>>;

function useFinishSignIn() {
  const { setSession } = useAuth();
  return (result: SignInResult) => {
    if (result.status === 'signed_in') {
      setSession(result.session);
      navigate('/', { replace: true });
    }
  };
}

export function SignIn() {
  const finish = useFinishSignIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const supported = passkeysSupported();

  if (ticket) {
    return (
      <NewDevice
        ticket={ticket}
        onRestart={() => {
          setTicket(null);
        }}
      />
    );
  }

  const start = () => {
    setBusy(true);
    setError(null);
    signInWithPasskey()
      .then((result) => {
        if (result.status === 'device_approval_required') setTicket(result.ticket);
        else finish(result);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <AuthLayout title="Sign in" description="Use the passkey you created during setup.">
      <div className="space-y-4">
        {supported ? null : (
          <Alert tone="warning" title="This browser can't use passkeys">
            Use an up-to-date browser, or sign in with a recovery code below.
          </Alert>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button className="w-full" size="lg" onClick={start} loading={busy} disabled={!supported}>
          {busy ? null : <Fingerprint className="size-5" aria-hidden />}
          Sign in with passkey
        </Button>
        <p className="text-center text-sm text-muted">
          Lost your passkeys?{' '}
          <Link to="/recovery" className="text-accent underline-offset-4 hover:underline">
            Use a recovery code
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}

/** Passkey was fine but this browser is new: prove it's you with the authenticator app. */
function NewDevice({ ticket, onRestart }: { ticket: string; onRestart: () => void }) {
  const finish = useFinishSignIn();
  const [code, setCode] = useState('');
  const [name, setName] = useState(suggestDeviceName);
  const [errors, setErrors] = useState<FormErrors<'code' | 'name' | 'form'>>({});
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const c = totpCodeSchema.safeParse(code);
    const n = displayNameSchema(LIMITS.deviceNameMax).safeParse(name);
    if (!c.success || !n.success) {
      setErrors({
        ...(c.success ? {} : { code: c.error.issues[0]?.message }),
        ...(n.success ? {} : { name: n.error.issues[0]?.message }),
      });
      return;
    }
    setBusy(true);
    setErrors({});
    post<SignInResult>('/api/auth/new-device/totp', { ticket, code: c.data, deviceName: n.data })
      .then(finish)
      .catch((err: unknown) => {
        setErrors({ form: errorMessage(err) });
        setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <AuthLayout
      title="Approve this device"
      description="Your passkey worked, but this browser is new to agentbox. Enter the code from your authenticator app to approve it."
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="flex items-center gap-3 rounded-[var(--radius-input)] bg-surface-2 p-3 text-sm text-muted">
          <MonitorSmartphone className="size-5 shrink-0" aria-hidden />
          Approving from a signed-in device arrives in a later update.
        </div>
        {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
        <Field
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, ''));
          }}
          error={errors.code}
        />
        <Field
          label="Name this device"
          value={name}
          maxLength={LIMITS.deviceNameMax}
          onChange={(e) => {
            setName(e.target.value);
          }}
          error={errors.name}
        />
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          Approve and sign in
        </Button>
        <Button variant="ghost" className="w-full" onClick={onRestart}>
          Start over
        </Button>
      </form>
    </AuthLayout>
  );
}

export function Recovery() {
  const finish = useFinishSignIn();
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [name, setName] = useState(suggestDeviceName);
  const [errors, setErrors] = useState<FormErrors<'code' | 'recovery' | 'name' | 'form'>>({});
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const c = totpCodeSchema.safeParse(code);
    const r = recoveryCodeSchema.safeParse(recoveryCode);
    const n = displayNameSchema(LIMITS.deviceNameMax).safeParse(name);
    if (!c.success || !r.success || !n.success) {
      setErrors({
        ...(c.success ? {} : { code: c.error.issues[0]?.message }),
        ...(r.success ? {} : { recovery: r.error.issues[0]?.message }),
        ...(n.success ? {} : { name: n.error.issues[0]?.message }),
      });
      return;
    }
    setBusy(true);
    setErrors({});
    post<SignInResult>('/api/auth/recovery', {
      code: c.data,
      recoveryCode: r.data,
      deviceName: n.data,
    })
      .then(finish)
      .catch((err: unknown) => {
        setErrors({ form: errorMessage(err) });
        setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <AuthLayout
      title="Recover access"
      description="Enter a code from your authenticator app and one of your saved recovery codes. Each recovery code works once."
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
        <Field
          label="6-digit authenticator code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, ''));
          }}
          error={errors.code}
        />
        <Field
          label="Recovery code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          className="font-mono tracking-wider"
          maxLength={20}
          value={recoveryCode}
          onChange={(e) => {
            setRecoveryCode(e.target.value.toUpperCase());
          }}
          error={errors.recovery}
        />
        <Field
          label="Name this device"
          value={name}
          maxLength={LIMITS.deviceNameMax}
          onChange={(e) => {
            setName(e.target.value);
          }}
          error={errors.name}
        />
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          <LifeBuoy className="size-5" aria-hidden />
          Recover and sign in
        </Button>
        <p className="text-center text-sm text-muted">
          <Link to="/signin" className="text-accent underline-offset-4 hover:underline">
            Back to passkey sign-in
          </Link>
        </p>
        <Alert tone="info" title="Lost your authenticator too?">
          Over SSH on your server, run{' '}
          <code className="font-mono text-text">sudo agentbox setup-link --reset</code> to set up
          new factors.
        </Alert>
      </form>
    </AuthLayout>
  );
}
