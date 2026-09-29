import { LIMITS, totpCodeSchema, displayNameSchema } from '@agentbox/shared';
import type { SetupCompleteResult, SetupTotpInit } from '@agentbox/shared';
import { Check, Fingerprint, LinkIcon, Smartphone } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { AuthLayout } from '../components/Layout.tsx';
import { RecoveryCodes } from '../components/RecoveryCodes.tsx';
import { TotpQr, groupSecret } from '../components/TotpQr.tsx';
import { Button } from '../components/ui/button.tsx';
import { Alert, Skeleton } from '../components/ui/feedback.tsx';
import { Field } from '../components/ui/field.tsx';
import { ApiError, errorMessage, post } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { suggestDeviceName } from '../lib/format.ts';
import { createPasskey, passkeysSupported } from '../lib/passkeys.ts';
import { navigate } from '../lib/router.ts';
import { useAuth } from '../state/auth.tsx';

type Step = 'passkey' | 'totp' | 'finish';
const TOKEN_KEY = 'agentbox.setupToken';

/**
 * The link is /setup#<token>. The fragment never reaches the server logs or
 * Referer. We move it out of the address bar straight away and keep it in
 * sessionStorage only so a reload mid-setup still works.
 */
let memoryToken: string | null = null;

function takeToken(): string | null {
  const fromHash = window.location.hash.slice(1);
  if (fromHash) {
    window.history.replaceState(null, '', '/setup');
    memoryToken = fromHash;
    try {
      sessionStorage.setItem(TOKEN_KEY, fromHash);
    } catch {
      // Storage blocked: the token lives in memory only.
    }
    return fromHash;
  }
  if (memoryToken) return memoryToken;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function forgetToken(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

export function SetupWizard() {
  const [token] = useState(takeToken);
  const [step, setStep] = useState<Step | null>(null);
  const [linkError, setLinkError] = useState<string | null>(
    token ? null : 'This page needs the one-time setup link from your server.',
  );
  const [done, setDone] = useState<SetupCompleteResult | null>(null);

  useEffect(() => {
    if (!token) return;
    post<{ step: Step }>('/api/setup/status', { token })
      .then((r) => {
        setStep(r.step);
      })
      .catch((err: unknown) => {
        forgetToken();
        setLinkError(
          err instanceof ApiError && err.code === 'setup_complete'
            ? 'agentbox is already set up. Sign in instead.'
            : errorMessage(err),
        );
      });
  }, [token]);

  if (linkError || !token) {
    return (
      <AuthLayout title="Setup link not valid" description={linkError}>
        <Alert tone="info" title="Need a new link?">
          Connect to your server over SSH and run{' '}
          <code className="font-mono text-text">sudo agentbox setup-link</code>. Links work once and
          expire after 30 minutes.
        </Alert>
        <Button
          className="mt-4 w-full"
          variant="secondary"
          onClick={() => {
            navigate('/signin');
          }}
        >
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }

  if (done) return <SavedCodes result={done} />;

  return (
    <AuthLayout
      wide
      title="Set up agentbox"
      description="Three quick steps. You'll use your passkey to sign in, with the authenticator app as a backup."
    >
      <Steps current={step} />
      <div className="mt-6">
        {step === null ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : step === 'passkey' ? (
          <PasskeyStep
            token={token}
            onDone={() => {
              setStep('totp');
            }}
          />
        ) : step === 'totp' ? (
          <TotpStep
            token={token}
            onDone={() => {
              setStep('finish');
            }}
          />
        ) : (
          <FinishStep
            token={token}
            onDone={(r) => {
              forgetToken();
              setDone(r);
            }}
          />
        )}
      </div>
    </AuthLayout>
  );
}

const STEPS: { id: Step; label: string }[] = [
  { id: 'passkey', label: 'Passkey' },
  { id: 'totp', label: 'Authenticator' },
  { id: 'finish', label: 'This device' },
];

function Steps({ current }: { current: Step | null }) {
  const index = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="flex gap-2" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const state = i < index ? 'done' : i === index ? 'current' : 'todo';
        return (
          <li
            key={s.id}
            aria-current={state === 'current' ? 'step' : undefined}
            className="flex flex-1 flex-col gap-1.5"
          >
            <span
              className={cn('h-1 rounded-full', state === 'todo' ? 'bg-surface-2' : 'bg-accent')}
            />
            <span className={cn('text-xs', state === 'current' ? 'text-text' : 'text-muted')}>
              {i + 1}. {s.label}
              {state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function PasskeyStep({ token, onDone }: { token: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeysSupported();

  const create = () => {
    setBusy(true);
    setError(null);
    createPasskey('/api/setup/passkey/options', { token })
      .then((response) => post('/api/setup/passkey', { token, response }))
      .then(onDone)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <Fingerprint className="mt-0.5 size-6 shrink-0 text-accent" aria-hidden />
        <div>
          <h2 className="font-semibold">Create your passkey</h2>
          <p className="mt-1 text-sm text-muted">
            Your device will ask for your fingerprint, face or PIN. The passkey can't be phished and
            never leaves your device or password manager.
          </p>
        </div>
      </div>
      {supported ? null : (
        <Alert tone="danger" title="This browser can't create passkeys">
          Use an up-to-date Chrome, Safari, Edge or Firefox.
        </Alert>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button className="w-full" size="lg" onClick={create} loading={busy} disabled={!supported}>
        Create passkey
      </Button>
    </div>
  );
}

function TotpStep({ token, onDone }: { token: string; onDone: () => void }) {
  const [init, setInit] = useState<SetupTotpInit | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    post<SetupTotpInit>('/api/setup/totp/init', { token })
      .then(setInit)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  }, [token]);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the 6-digit code');
      return;
    }
    setBusy(true);
    setError(null);
    post('/api/setup/totp/confirm', { token, code: parsed.data })
      .then(onDone)
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div className="flex gap-3">
        <Smartphone className="mt-0.5 size-6 shrink-0 text-accent" aria-hidden />
        <div>
          <h2 className="font-semibold">Add an authenticator app</h2>
          <p className="mt-1 text-sm text-muted">
            Scan this with Google Authenticator, 1Password, Aegis or similar. It's your backup when
            a passkey isn't available and your second check on new devices.
          </p>
        </div>
      </div>
      {init ? (
        <div className="flex flex-col items-center gap-3 rounded-[var(--radius-input)] border border-border bg-bg p-4">
          <TotpQr uri={init.otpauthUri} />
          <details className="w-full text-center text-sm">
            <summary className="cursor-pointer text-muted">
              Can't scan? Enter the key by hand
            </summary>
            <code className="mt-2 block font-mono tracking-wider break-all select-all">
              {groupSecret(init.secret)}
            </code>
          </details>
        </div>
      ) : error ? null : (
        <Skeleton className="mx-auto size-52" />
      )}
      <Field
        label="6-digit code from the app"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        value={code}
        onChange={(e) => {
          setCode(e.target.value.replace(/\D/g, ''));
        }}
        error={error ?? undefined}
        disabled={!init}
      />
      <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!init}>
        Verify code
      </Button>
    </form>
  );
}

function FinishStep({
  token,
  onDone,
}: {
  token: string;
  onDone: (r: SetupCompleteResult) => void;
}) {
  const [name, setName] = useState(suggestDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = displayNameSchema(LIMITS.deviceNameMax).safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a name');
      return;
    }
    setBusy(true);
    setError(null);
    post<SetupCompleteResult>('/api/setup/complete', { token, deviceName: parsed.data })
      .then(onDone)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div className="flex gap-3">
        <LinkIcon className="mt-0.5 size-6 shrink-0 text-accent" aria-hidden />
        <div>
          <h2 className="font-semibold">Name this device</h2>
          <p className="mt-1 text-sm text-muted">
            It becomes your first approved device. Other devices will need its approval or your
            authenticator code.
          </p>
        </div>
      </div>
      <Field
        label="Device name"
        value={name}
        maxLength={LIMITS.deviceNameMax}
        onChange={(e) => {
          setName(e.target.value);
        }}
        error={error ?? undefined}
        hint="For example “Work laptop” or “Pixel 9”."
      />
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Finish setup
      </Button>
    </form>
  );
}

function SavedCodes({ result }: { result: SetupCompleteResult }) {
  const { setSession } = useAuth();
  const [saved, setSaved] = useState(false);
  return (
    <AuthLayout
      wide
      title="Save your recovery codes"
      description="If you lose your passkeys, a recovery code plus your authenticator code gets you back in. This is the only time they're shown."
    >
      <RecoveryCodes codes={result.recoveryCodes} origin={window.location.origin} />
      <label className="mt-5 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-5 accent-[var(--accent)]"
          checked={saved}
          onChange={(e) => {
            setSaved(e.target.checked);
          }}
        />
        I've saved these codes somewhere safe
      </label>
      <Button
        className="mt-3 w-full"
        size="lg"
        disabled={!saved}
        onClick={() => {
          setSession(result.session);
          navigate('/', { replace: true });
        }}
      >
        <Check className="size-4" aria-hidden />
        Continue to agentbox
      </Button>
    </AuthLayout>
  );
}
