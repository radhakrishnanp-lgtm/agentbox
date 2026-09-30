import { LIMITS, displayNameSchema, signInPasswordSchema } from '@agentbox/shared';
import type { PasskeySummary, SecurityOverview } from '@agentbox/shared';
import {
  Cloud,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { ConfirmDialog } from '../components/ui/dialog.tsx';
import { Alert, Badge, Skeleton } from '../components/ui/feedback.tsx';
import { Field } from '../components/ui/field.tsx';
import { api, errorMessage, post } from '../lib/api.ts';
import { withFreshAuth } from '../lib/fresh-auth.ts';
import { relativeTime } from '../lib/format.ts';
import { createPasskey } from '../lib/passkeys.ts';
import { useApi } from '../lib/use-api.ts';
import { useAuth } from '../state/auth.tsx';

export function Security() {
  const overview = useApi<SecurityOverview>('/api/security');

  return (
    <>
      <PageHeader
        title="Security"
        description="How you sign in. Changes here ask for your passkey (or authenticator code) first."
      />
      <div className="space-y-4">
        {overview.status === 'error' ? (
          <Alert tone="danger" title="Couldn't load security settings">
            {overview.error.message}
          </Alert>
        ) : null}
        <Passkeys data={overview.data} onChange={overview.reload} />
        <SignInPassword data={overview.data} onChange={overview.reload} />
        <Card>
          <CardHeader
            icon={<Smartphone className="size-5" aria-hidden />}
            title="Authenticator app"
            description="Second check for new devices and for recovery."
            action={
              overview.data ? (
                <Badge tone={overview.data.totpEnabled ? 'success' : 'warning'}>
                  {overview.data.totpEnabled ? 'On' : 'Off'}
                </Badge>
              ) : null
            }
          />
        </Card>
        <Card>
          <CardHeader
            icon={<KeyRound className="size-5" aria-hidden />}
            title="Recovery codes"
            description="Each one works once, together with an authenticator code."
            action={
              overview.data ? (
                <Badge tone={overview.data.recoveryCodesRemaining > 3 ? 'info' : 'warning'}>
                  {overview.data.recoveryCodesRemaining} of {LIMITS.recoveryCodeCount} left
                </Badge>
              ) : null
            }
          />
        </Card>
      </div>
    </>
  );
}

/** Optional: password + authenticator code, for computers without a passkey. */
function SignInPassword({
  data,
  onChange,
}: {
  data: SecurityOverview | null;
  onChange: () => void;
}) {
  const { setSession } = useAuth();
  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const enabled = data?.passwordEnabled ?? false;

  const remove = () => {
    setBusy(true);
    withFreshAuth(() => api('/api/security/password', { method: 'DELETE' }), setSession)
      .then(() => {
        toast.success('Password sign-in turned off');
        setConfirmingRemove(false);
        onChange();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card>
      <CardHeader
        icon={<LockKeyhole className="size-5" aria-hidden />}
        title="Password sign-in"
        description="Sign in on a computer without your passkey, using this password plus your authenticator code."
        action={
          data ? <Badge tone={enabled ? 'success' : 'info'}>{enabled ? 'On' : 'Off'}</Badge> : null
        }
      />
      {editing ? (
        <SetPassword
          changing={enabled}
          onDone={() => {
            setEditing(false);
            onChange();
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <CardBody className="flex flex-wrap gap-2 pt-0">
          <Button
            variant="secondary"
            disabled={!data}
            onClick={() => {
              setEditing(true);
            }}
          >
            {enabled ? 'Change password' : 'Set a password'}
          </Button>
          {enabled ? (
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmingRemove(true);
              }}
            >
              Turn off
            </Button>
          ) : null}
        </CardBody>
      )}
      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Turn off password sign-in?"
        description="Computers already signed in stay signed in. New ones will need a passkey. You'll confirm it's you first."
        confirmLabel="Turn off"
        tone="danger"
        loading={busy}
        onConfirm={remove}
      />
    </Card>
  );
}

function SetPassword({
  changing,
  onDone,
  onCancel,
}: {
  changing: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { setSession } = useAuth();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<{ password?: string; repeat?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = signInPasswordSchema.safeParse(password);
    if (!parsed.success) {
      setErrors({ password: parsed.error.issues[0]?.message ?? 'Enter a password' });
      return;
    }
    if (repeat !== password) {
      setErrors({ repeat: "The passwords don't match" });
      return;
    }
    setBusy(true);
    setErrors({});
    withFreshAuth(
      () => api('/api/security/password', { method: 'PUT', body: { password: parsed.data } }),
      setSession,
    )
      .then(() => {
        toast.success(changing ? 'Password changed' : 'Password sign-in is on');
        onDone();
      })
      .catch((err: unknown) => {
        setErrors({ form: errorMessage(err) });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <CardBody className="border-t border-border bg-surface-2/40">
      <form className="space-y-3" onSubmit={submit} noValidate>
        {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
        <Field
          label={changing ? 'New password' : 'Password'}
          type="password"
          autoComplete="new-password"
          autoFocus
          hint="At least 12 characters. Use a new one, not your vault password, and keep it in your password manager."
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          error={errors.password}
        />
        <Field
          label="Type it again"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => {
            setRepeat(e.target.value);
          }}
          error={errors.repeat}
        />
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            <ShieldCheck className="size-4" aria-hidden />
            Save password
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </CardBody>
  );
}

function Passkeys({ data, onChange }: { data: SecurityOverview | null; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader
        icon={<Fingerprint className="size-5" aria-hidden />}
        title="Passkeys"
        description="Add a second one (another phone or a security key) so losing one device doesn't lock you out."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />
      {adding ? (
        <AddPasskey
          onDone={() => {
            setAdding(false);
            onChange();
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      ) : null}
      <ul className="divide-y divide-border">
        {data === null ? (
          <li className="px-5 py-4">
            <Skeleton className="h-5 w-1/2" />
          </li>
        ) : (
          data.passkeys.map((k) => (
            <PasskeyRow
              key={k.id}
              passkey={k}
              isLast={data.passkeys.length === 1}
              onRemoved={onChange}
            />
          ))
        )}
      </ul>
    </Card>
  );
}

function PasskeyRow({
  passkey,
  isLast,
  onRemoved,
}: {
  passkey: PasskeySummary;
  isLast: boolean;
  onRemoved: () => void;
}) {
  const { setSession } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = () => {
    setBusy(true);
    withFreshAuth(
      () => api(`/api/security/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' }),
      setSession,
    )
      .then(() => {
        toast.success(`Removed “${passkey.name}”`);
        setConfirming(false);
        onRemoved();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate font-medium">
          {passkey.name}
          {passkey.deviceType === 'multiDevice' ? (
            <Badge>
              <Cloud className="mr-1 size-3" aria-hidden />
              Synced
            </Badge>
          ) : null}
        </p>
        <p className="text-sm text-muted">
          Added {relativeTime(passkey.createdAt)}
          {passkey.lastUsedAt
            ? ` · last used ${relativeTime(passkey.lastUsedAt)}`
            : ' · never used'}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove passkey ${passkey.name}`}
        title={isLast ? "You can't remove your only passkey" : 'Remove'}
        disabled={isLast}
        onClick={() => {
          setConfirming(true);
        }}
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove this passkey?"
        description={
          <>
            “{passkey.name}” will stop working for agentbox straight away. You'll confirm with a
            passkey first.
          </>
        }
        confirmLabel="Remove passkey"
        tone="danger"
        loading={busy}
        onConfirm={remove}
      />
    </li>
  );
}

function AddPasskey({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { setSession } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = displayNameSchema(LIMITS.passkeyNameMax).safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a name');
      return;
    }
    setBusy(true);
    setError(null);
    withFreshAuth(() => createPasskey('/api/security/passkeys/options', {}), setSession)
      .then((response) => post('/api/security/passkeys', { response, name: parsed.data }))
      .then(() => {
        toast.success('Passkey added');
        onDone();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <CardBody className="border-b border-border bg-surface-2/40">
      <form className="space-y-3" onSubmit={submit} noValidate>
        <Field
          label="Name for the new passkey"
          placeholder="e.g. YubiKey 5C or iPhone"
          autoFocus
          maxLength={LIMITS.passkeyNameMax}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          error={error ?? undefined}
        />
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            <ShieldCheck className="size-4" aria-hidden />
            Create passkey
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </CardBody>
  );
}
