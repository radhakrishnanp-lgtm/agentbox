import {
  TERMINAL_PRESETS,
  VAULT_PASSWORD_MIN,
  terminalNameSchema,
  type TerminalOverview,
  type TerminalPresetId,
  type TerminalSummary,
} from '@agentbox/shared';
import { Lock, LockOpen, Pencil, Plus, SquareTerminal, Trash2, Vault } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { Link, PageHeader } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { ConfirmDialog } from '../components/ui/dialog.tsx';
import { Alert, Badge, EmptyState, Skeleton } from '../components/ui/feedback.tsx';
import { Field } from '../components/ui/field.tsx';
import { api, errorMessage, post } from '../lib/api.ts';
import { withFreshAuth } from '../lib/fresh-auth.ts';
import { relativeTime } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { useApi } from '../lib/use-api.ts';
import { useAuth } from '../state/auth.tsx';

const presetLabel = (id: TerminalPresetId) =>
  TERMINAL_PRESETS.find((p) => p.id === id)?.label ?? 'Shell';

export function Terminals() {
  const overview = useApi<TerminalOverview>('/api/terminals');
  const { reload } = overview;

  // Keep the list fresh (sessions end, CLIs get installed) while the page is open.
  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => {
      clearInterval(t);
    };
  }, [reload]);

  const data = overview.data;
  return (
    <>
      <PageHeader
        title="Terminals"
        description="Sessions on this server that keep running when you close the page. Install and sign in to your AI CLIs here; their logins stay in the encrypted vault."
      />
      <div className="space-y-4">
        {overview.status === 'loading' ? (
          <Card>
            <CardBody className="space-y-2">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-5 w-2/3" />
            </CardBody>
          </Card>
        ) : null}
        {overview.status === 'error' ? (
          <Alert tone="danger" title="Couldn't load terminals">
            {overview.error.message}
          </Alert>
        ) : null}
        {data && !data.available ? (
          <Alert tone="warning" title="The terminal service isn't running">
            Check it on the server with <code>systemctl status agentbox-termd</code>.
          </Alert>
        ) : null}
        {data?.available && data.vault === 'uninitialized' ? <CreateVault onDone={reload} /> : null}
        {data?.available && data.vault === 'locked' ? <UnlockVault onDone={reload} /> : null}
        {data?.available && (data.vault === 'unlocked' || data.vault === 'disabled') ? (
          <>
            <NewSession data={data} onDone={reload} />
            <SessionList data={data} onChange={reload} />
            {data.vault === 'unlocked' ? <VaultCard data={data} onChange={reload} /> : null}
            <InstallHelp />
          </>
        ) : null}
      </div>
    </>
  );
}

function PasswordRules() {
  return (
    <>
      At least {VAULT_PASSWORD_MIN} characters. A few random words work well. Keep it in your
      password manager: without it the vault can't be opened, not even by agentbox.
    </>
  );
}

function CreateVault({ onDone }: { onDone: () => void }) {
  const { setSession } = useAuth();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [autoUnlock, setAutoUnlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const tooShort = password.length > 0 && password.length < VAULT_PASSWORD_MIN;
  const mismatch = again.length > 0 && again !== password;

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (password.length < VAULT_PASSWORD_MIN || again !== password) return;
    setBusy(true);
    withFreshAuth(() => post('/api/terminals/vault/init', { password, autoUnlock }), setSession)
      .then(() => {
        toast.success('Vault created and unlocked');
        onDone();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card>
      <CardHeader
        icon={<Vault className="size-5" aria-hidden />}
        title="Create your vault"
        description="Everything the terminals save (CLI logins, settings, installed tools) is kept in an encrypted folder, locked with a password only you know."
      />
      <CardBody>
        <form className="max-w-md space-y-4" onSubmit={submit}>
          <Field
            label="Vault password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            hint={<PasswordRules />}
            error={tooShort ? `Use at least ${VAULT_PASSWORD_MIN} characters` : undefined}
            required
          />
          <Field
            label="Type it again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => {
              setAgain(e.target.value);
            }}
            error={mismatch ? "The two passwords don't match" : undefined}
            required
          />
          <AutoUnlockChoice checked={autoUnlock} onChange={setAutoUnlock} />
          <Button
            type="submit"
            loading={busy}
            disabled={password.length < VAULT_PASSWORD_MIN || again !== password}
          >
            Create vault
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function AutoUnlockChoice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input
          id={id}
          type="checkbox"
          className="size-5"
          checked={checked}
          onChange={(e) => {
            onChange(e.target.checked);
          }}
        />
        Unlock by itself after the server restarts
      </label>
      <p className="text-sm text-muted">
        Handy, but agentbox then keeps an encrypted copy of the password, so a stolen disk image
        with agentbox's key could open the vault. Leave it off and you unlock once after each
        restart.
      </p>
    </div>
  );
}

function UnlockVault({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    post('/api/terminals/vault/unlock', { password })
      .then(() => {
        toast.success('Vault unlocked');
        setPassword('');
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
    <Card>
      <CardHeader
        icon={<Lock className="size-5" aria-hidden />}
        title="The vault is locked"
        description="Your terminals and CLI logins are encrypted. Unlock the vault to use them."
      />
      <CardBody className="space-y-4">
        <form className="max-w-md space-y-4" onSubmit={submit}>
          <Field
            label="Vault password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            error={error}
            required
          />
          <Button type="submit" loading={busy} disabled={!password}>
            Unlock
          </Button>
        </form>
        <ResetVault onDone={onDone} />
      </CardBody>
    </Card>
  );
}

function ResetVault({ onDone }: { onDone: () => void }) {
  const { setSession } = useAuth();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setBusy(true);
    withFreshAuth(() => post('/api/terminals/vault/reset', { confirm: typed }), setSession)
      .then(() => {
        toast.success('Vault deleted. Create a new one to continue.');
        setOpen(false);
        onDone();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <button
        type="button"
        className="text-sm text-muted underline underline-offset-4 hover:text-text"
        onClick={() => {
          setTyped('');
          setOpen(true);
        }}
      >
        Forgot the password?
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete the vault?"
        tone="danger"
        confirmLabel="Delete vault"
        loading={busy}
        onConfirm={() => {
          if (typed === 'RESET') reset();
        }}
        description="Without the password nothing in the vault can be recovered. Deleting it removes every CLI login, setting and tool installed in the terminals, and you start with an empty vault."
      >
        <div className="mt-4">
          <Field
            label="Type RESET to confirm"
            value={typed}
            autoComplete="off"
            onChange={(e) => {
              setTyped(e.target.value);
            }}
          />
        </div>
      </ConfirmDialog>
    </>
  );
}

function NewSession({ data, onDone }: { data: TerminalOverview; onDone: () => void }) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<TerminalPresetId>('shell');
  const [busy, setBusy] = useState(false);
  const presetId = useId();
  const suggested = suggestName(data.terminals);
  const finalName = name.trim() || suggested;
  const valid = terminalNameSchema.safeParse(finalName).success;

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    post('/api/terminals', { name: finalName, preset })
      .then(() => {
        setName('');
        onDone();
        navigate(`/terminals/${encodeURIComponent(finalName)}`);
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card>
      <CardHeader icon={<Plus className="size-5" aria-hidden />} title="New session" />
      <CardBody>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
          <div className="min-w-40 flex-1">
            <Field
              label="Name"
              value={name}
              placeholder={suggested}
              autoComplete="off"
              maxLength={32}
              onChange={(e) => {
                setName(e.target.value);
              }}
              error={valid ? undefined : 'Use 1–32 letters, digits, - or _'}
            />
          </div>
          <div className="min-w-40 flex-1 space-y-1.5">
            <label htmlFor={presetId} className="block text-sm font-medium">
              Start with
            </label>
            <select
              id={presetId}
              className="block min-h-11 w-full rounded-[var(--radius-input)] border border-border bg-bg px-3 text-base focus-visible:outline-2"
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value as TerminalPresetId);
              }}
            >
              {TERMINAL_PRESETS.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  disabled={p.command !== null && !data.installed.includes(p.id)}
                >
                  {p.label}
                  {p.command !== null && !data.installed.includes(p.id) ? ' (not installed)' : ''}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" loading={busy} disabled={!valid}>
            <SquareTerminal className="size-4" aria-hidden />
            Open
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function suggestName(existing: TerminalSummary[]): string {
  const names = new Set(existing.map((t) => t.name));
  if (!names.has('main')) return 'main';
  for (let i = 2; ; i++) if (!names.has(`main-${i}`)) return `main-${i}`;
}

function SessionList({ data, onChange }: { data: TerminalOverview; onChange: () => void }) {
  return (
    <Card>
      <CardHeader
        icon={<SquareTerminal className="size-5" aria-hidden />}
        title="Sessions"
        description="Closing the page leaves a session running. Open it again from any signed-in device."
      />
      {data.terminals.length === 0 ? (
        <EmptyState icon={<SquareTerminal className="size-8" aria-hidden />} title="No sessions">
          Open one above. A Shell is a good start for installing your CLIs.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {data.terminals.map((t) => (
            <SessionRow key={t.name} t={t} onChange={onChange} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function SessionRow({ t, onChange }: { t: TerminalSummary; onChange: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [newName, setNewName] = useState(t.name);
  const [busy, setBusy] = useState(false);
  const path = `/api/terminals/${encodeURIComponent(t.name)}`;

  const run = (action: () => Promise<unknown>, done: string, after: () => void) => {
    setBusy(true);
    action()
      .then(() => {
        toast.success(done);
        after();
        onChange();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className="font-mono">{t.name}</span>
          <Badge>{presetLabel(t.preset)}</Badge>
          {t.attached > 0 ? <Badge tone="success">open on {t.attached}</Badge> : null}
        </p>
        <p className="text-sm text-muted">
          Running <span className="font-mono">{t.command || 'bash'}</span> · active{' '}
          {relativeTime(t.lastActivityAt)}
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild>
          <Link to={`/terminals/${encodeURIComponent(t.name)}`}>Open</Link>
        </Button>
        <IconButton
          label={`Rename ${t.name}`}
          onClick={() => {
            setNewName(t.name);
            setRenaming(true);
          }}
        >
          <Pencil className="size-4" aria-hidden />
        </IconButton>
        <IconButton
          label={`Close ${t.name}`}
          onClick={() => {
            setClosing(true);
          }}
        >
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
      <ConfirmDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename session"
        description="Open tabs of this session reconnect under the new name next time."
        confirmLabel="Rename"
        loading={busy}
        onConfirm={() => {
          run(
            () => api(path, { method: 'PATCH', body: { name: newName.trim() } }),
            'Renamed',
            () => {
              setRenaming(false);
            },
          );
        }}
      >
        <div className="mt-4">
          <Field
            label="New name"
            value={newName}
            maxLength={32}
            onChange={(e) => {
              setNewName(e.target.value);
            }}
          />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title={`Close “${t.name}”?`}
        tone="danger"
        description="This stops everything running in it. Files and CLI logins in the vault are kept."
        confirmLabel="Close session"
        loading={busy}
        onConfirm={() => {
          run(
            () => api(path, { method: 'DELETE' }),
            `Closed “${t.name}”`,
            () => {
              setClosing(false);
            },
          );
        }}
      />
    </li>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="secondary" size="icon" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  );
}

function VaultCard({ data, onChange }: { data: TerminalOverview; onChange: () => void }) {
  const { setSession } = useAuth();
  const [busy, setBusy] = useState<'lock' | 'auto' | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState('');

  const lock = () => {
    setBusy('lock');
    post('/api/terminals/vault/lock')
      .then(() => {
        toast.success('Vault locked. All sessions were stopped.');
        setConfirmLock(false);
        onChange();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(null);
      });
  };

  const setAuto = (on: boolean, pw?: string) => {
    setBusy('auto');
    withFreshAuth(
      () =>
        api('/api/terminals/vault/settings', {
          method: 'PUT',
          body: { autoUnlock: on, ...(pw ? { password: pw } : {}) },
        }),
      setSession,
    )
      .then(() => {
        toast.success(
          on ? 'Auto-unlock is on' : 'Auto-unlock is off. The stored copy was deleted.',
        );
        setAskPassword(false);
        setPassword('');
        onChange();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <Card>
      <CardHeader
        icon={<LockOpen className="size-5" aria-hidden />}
        title="Vault"
        description="Unlocked. It locks again when the server restarts, unless auto-unlock is on."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setConfirmLock(true);
            }}
          >
            <Lock className="size-4" aria-hidden />
            Lock now
          </Button>
        }
      />
      <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p>
          Auto-unlock after restart:{' '}
          <span className="font-medium">{data.autoUnlock ? 'on' : 'off'}</span>
        </p>
        <Button
          variant="secondary"
          loading={busy === 'auto'}
          onClick={() => {
            if (data.autoUnlock) setAuto(false);
            else setAskPassword(true);
          }}
        >
          {data.autoUnlock ? 'Turn off' : 'Turn on'}
        </Button>
      </CardBody>
      <ConfirmDialog
        open={confirmLock}
        onOpenChange={setConfirmLock}
        title="Lock the vault?"
        description="Every session stops and the files go back to being encrypted only. You'll need the vault password to continue."
        confirmLabel="Lock vault"
        loading={busy === 'lock'}
        onConfirm={lock}
      />
      <ConfirmDialog
        open={askPassword}
        onOpenChange={setAskPassword}
        title="Turn on auto-unlock?"
        description="agentbox will keep an encrypted copy of the vault password so it can unlock after a restart. Enter the password to confirm."
        confirmLabel="Turn on"
        loading={busy === 'auto'}
        onConfirm={() => {
          if (password) setAuto(true, password);
        }}
      >
        <div className="mt-4">
          <Field
            label="Vault password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </div>
      </ConfirmDialog>
    </Card>
  );
}

function InstallHelp() {
  return (
    <Card>
      <CardHeader title="Installing CLIs" />
      <CardBody className="space-y-2 text-sm text-muted">
        <p>
          Open a Shell session and install what you need. No sudo is needed: installs go into your
          home folder, which is inside the vault. For example, Claude Code:
        </p>
        <pre className="overflow-x-auto rounded-[var(--radius-input)] border border-border bg-bg px-3 py-2 font-mono text-text">
          curl -fsSL https://claude.ai/install.sh | bash
        </pre>
        <p>
          npm works too (<code className="font-mono">npm install -g …</code>). Then run the CLI and
          sign in once. The login is saved in the vault and never leaves this server.
        </p>
      </CardBody>
    </Card>
  );
}
