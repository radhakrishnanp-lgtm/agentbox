import {
  GATEWAY_LIMITS,
  aiKeyCreateSchema,
  machineCreateSchema,
  type AiKeySummary,
  type GatewayOverview,
  type MachineCreated,
  type MachineSummary,
  type ProviderPreset,
} from '@agentbox/shared';
import { Copy, KeyRound, Plus, Power, RefreshCw, Server, Terminal } from 'lucide-react';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { ConfirmDialog } from '../components/ui/dialog.tsx';
import { Alert, Badge, EmptyState, Skeleton } from '../components/ui/feedback.tsx';
import { Field } from '../components/ui/field.tsx';
import { api, errorMessage, post } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { withFreshAuth } from '../lib/fresh-auth.ts';
import { dateTime, relativeTime } from '../lib/format.ts';
import { useApi } from '../lib/use-api.ts';
import { useAuth } from '../state/auth.tsx';

const CLI_LABEL: Record<string, string> = {
  claude: 'Claude Code (claude)',
  codex: 'Codex (codex)',
  grok: 'Grok CLI (grok)',
  kimi: 'Kimi CLI (kimi)',
  gemini: 'Gemini CLI (gemini)',
};

const selectClass =
  'block min-h-11 w-full rounded-[var(--radius-input)] border border-border bg-bg px-3 text-base focus-visible:outline-2';

function Select({
  label,
  hint,
  value,
  onChange,
  children,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        className={selectClass}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {children}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function CopyLine({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-stretch gap-2">
        <code
          className={cn(
            'min-w-0 flex-1 rounded-[var(--radius-input)] border border-border bg-bg px-3 py-2.5 font-mono text-sm break-all select-all',
            secret && 'tracking-wide',
          )}
        >
          {value}
        </code>
        <Button
          variant="secondary"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => toast.success('Copied'))
              .catch(() => toast.error("Couldn't copy. Select the text and copy it by hand."));
          }}
        >
          <Copy className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function Machines() {
  const overview = useApi<GatewayOverview>('/api/gateway');
  const [created, setCreated] = useState<MachineCreated | null>(null);

  return (
    <>
      <PageHeader
        title="Machines"
        description="Use claude, codex, grok, kimi or gemini on any computer. Your AI keys stay here; each computer gets its own pass that you can stop at any time."
      />
      <div className="space-y-4">
        {overview.status === 'error' ? (
          <Alert tone="danger" title="Couldn't load machines">
            {overview.error.message}
          </Alert>
        ) : null}
        {created ? (
          <SetupSteps
            created={created}
            onClose={() => {
              setCreated(null);
            }}
          />
        ) : null}
        <MachineList
          data={overview.data}
          onChange={overview.reload}
          onCreated={(c) => {
            setCreated(c);
            overview.reload();
          }}
        />
        <KeyList data={overview.data} onChange={overview.reload} />
        <HowItWorks />
      </div>
    </>
  );
}

function SetupSteps({ created, onClose }: { created: MachineCreated; onClose: () => void }) {
  return (
    <Card className="border-accent/50">
      <CardHeader
        icon={<Terminal className="size-5" aria-hidden />}
        title={`Set up “${created.machine.name}”`}
        description="Do this on that computer, in its own terminal. No root needed."
      />
      <CardBody className="space-y-4">
        <CopyLine label="1. Run this" value={created.installCommand} />
        <CopyLine label="2. Paste this pass when it asks" value={created.pass} secret />
        <Alert tone="warning" title="This pass is shown only once">
          agentbox keeps only a fingerprint of it. If you lose it, stop this machine and add it
          again. Never paste the pass into chats or files other people can read.
        </Alert>
        <p className="text-sm text-muted">
          After that, open a new terminal there and use claude, codex, grok, kimi or gemini as
          usual. They use the keys on agentbox; the computer never gets them.
        </p>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </CardBody>
    </Card>
  );
}

function machineState(
  m: MachineSummary,
  now: number,
): {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'info';
} {
  if (m.revokedAt) return { label: 'Stopped', tone: 'danger' };
  if (m.expiresAt && new Date(m.expiresAt).getTime() <= now)
    return { label: 'Expired', tone: 'warning' };
  if (!m.lastSeenAt) return { label: 'Not set up yet', tone: 'info' };
  return { label: 'Active', tone: 'success' };
}

function MachineList({
  data,
  onChange,
  onCreated,
}: {
  data: GatewayOverview | null;
  onChange: () => void;
  onCreated: (c: MachineCreated) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = data?.machines.filter((m) => !m.revokedAt) ?? [];

  const stopAll = () => {
    setBusy(true);
    post<{ count: number }>('/api/gateway/machines/revoke-all')
      .then(({ count }) => {
        toast.success(`Stopped ${count} machine${count === 1 ? '' : 's'}`);
        setStoppingAll(false);
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
        icon={<Server className="size-5" aria-hidden />}
        title="Machines"
        description="Computers allowed to use your AI keys through agentbox."
        action={
          <Button
            variant="secondary"
            disabled={!data || data.keys.length === 0}
            title={data && data.keys.length === 0 ? 'Add an AI key first' : undefined}
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />
      {adding && data ? (
        <AddMachine
          keys={data.keys}
          onCancel={() => {
            setAdding(false);
          }}
          onDone={(c) => {
            setAdding(false);
            onCreated(c);
          }}
        />
      ) : null}
      {data === null ? (
        <CardBody>
          <Skeleton className="h-5 w-1/2" />
        </CardBody>
      ) : data.machines.length === 0 ? (
        <EmptyState icon={<Server className="size-8" aria-hidden />} title="No machines yet">
          {data.keys.length === 0
            ? 'First add an AI key below, then add the computers that may use it.'
            : 'Add a GPU server or laptop to use your AI tools there.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {data.machines.map((m) => (
            <MachineRow key={m.id} machine={m} keys={data.keys} onChange={onChange} />
          ))}
        </ul>
      )}
      {active.length > 0 ? (
        <CardBody className="border-t border-border">
          <Button
            variant="ghost"
            className="text-danger"
            onClick={() => {
              setStoppingAll(true);
            }}
          >
            <Power className="size-4" aria-hidden />
            Stop all machines
          </Button>
          <ConfirmDialog
            open={stoppingAll}
            onOpenChange={setStoppingAll}
            title="Stop every machine?"
            description="All machine passes stop working now, and answers that are still streaming are cut off. You can add the machines again later."
            confirmLabel="Stop all machines"
            tone="danger"
            loading={busy}
            onConfirm={stopAll}
          />
        </CardBody>
      ) : null}
    </Card>
  );
}

function MachineRow({
  machine: m,
  keys,
  onChange,
}: {
  machine: MachineSummary;
  keys: AiKeySummary[];
  onChange: () => void;
}) {
  const { setSession } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read the clock once per mount; the list reloads after every change.
  const [now] = useState(() => Date.now());
  const state = machineState(m, now);
  const expiresSoon =
    m.expiresAt !== null && new Date(m.expiresAt).getTime() - now < 7 * 86_400_000;
  const keyNames = m.keyIds.map((id) => keys.find((k) => k.id === id)?.name ?? 'removed key');
  const tokens = m.today.inputTokens + m.today.outputTokens;

  const stop = () => {
    setBusy(true);
    post(`/api/gateway/machines/${encodeURIComponent(m.id)}/revoke`)
      .then(() => {
        toast.success(`Stopped “${m.name}”`);
        setConfirming(false);
        onChange();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  const renew = () => {
    setBusy(true);
    withFreshAuth(
      () =>
        api(`/api/gateway/machines/${encodeURIComponent(m.id)}`, {
          method: 'PATCH',
          body: { renewDays: GATEWAY_LIMITS.lifetimeDefaultDays },
        }),
      setSession,
    )
      .then(() => {
        toast.success(`“${m.name}” now works for ${GATEWAY_LIMITS.lifetimeDefaultDays} more days`);
        onChange();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {m.name}
          <Badge tone={state.tone}>{state.label}</Badge>
        </p>
        <p className="text-sm text-muted">
          Uses {keyNames.join(', ')} · pass {m.passPrefix}…
        </p>
        <p className="text-sm text-muted">
          {m.lastSeenAt
            ? `Last used ${relativeTime(m.lastSeenAt)} from ${m.lastIp ?? '?'}`
            : 'Never used'}
          {` · today ${m.today.requests} requests, ${tokens.toLocaleString()} tokens`}
          {m.dailyTokenLimit ? ` of ${m.dailyTokenLimit.toLocaleString()}` : ''}
        </p>
        <p className="text-sm text-muted">
          {m.ipRules.length ? `Only from ${m.ipRules.join(', ')}` : 'From any address'}
          {` · ${m.rpm} requests a minute`}
          {m.revokedAt
            ? ` · stopped ${relativeTime(m.revokedAt)}`
            : m.expiresAt
              ? ` · pass valid until ${dateTime(m.expiresAt)}`
              : ' · pass valid until stopped'}
        </p>
      </div>
      {m.revokedAt ? null : (
        <div className="flex gap-2">
          {expiresSoon ? (
            <Button variant="secondary" onClick={renew} loading={busy}>
              <RefreshCw className="size-4" aria-hidden />
              Renew
            </Button>
          ) : null}
          <Button
            variant="secondary"
            className="text-danger"
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Power className="size-4" aria-hidden />
            Stop
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Stop “${m.name}”?`}
        description="Its pass stops working now and any answer still streaming is cut off. To use this computer again, add it again."
        confirmLabel="Stop machine"
        tone="danger"
        loading={busy}
        onConfirm={stop}
      />
    </li>
  );
}

function AddMachine({
  keys,
  onDone,
  onCancel,
}: {
  keys: AiKeySummary[];
  onDone: (c: MachineCreated) => void;
  onCancel: () => void;
}) {
  const { setSession } = useAuth();
  const [name, setName] = useState('');
  const [keyIds, setKeyIds] = useState<string[]>(keys.length === 1 && keys[0] ? [keys[0].id] : []);
  const [ips, setIps] = useState('');
  const [lifetime, setLifetime] = useState(String(GATEWAY_LIMITS.lifetimeDefaultDays));
  const [rpm, setRpm] = useState(String(GATEWAY_LIMITS.rpmDefault));
  const [daily, setDaily] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = machineCreateSchema.safeParse({
      name,
      keyIds,
      ipRules: ips
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      rpm: Number(rpm),
      dailyTokenLimit: daily.trim() ? Number(daily.replace(/[,_\s]/g, '')) : null,
      lifetimeDays: lifetime === 'never' ? null : Number(lifetime),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? `${issue.path.join('.') || 'form'}: ${issue.message}` : 'Check the form');
      return;
    }
    setBusy(true);
    setError(null);
    withFreshAuth(() => post<MachineCreated>('/api/gateway/machines', parsed.data), setSession)
      .then(onDone)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <CardBody className="border-b border-border bg-surface-2/40">
      <form className="space-y-4" onSubmit={submit} noValidate>
        <Field
          label="Name"
          placeholder="e.g. gpu-office-1 or work laptop"
          autoFocus
          maxLength={GATEWAY_LIMITS.machineNameMax}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Which AI keys may it use?</legend>
          {keys.map((k) => (
            <label key={k.id} className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={keyIds.includes(k.id)}
                onChange={(e) => {
                  setKeyIds((ids) =>
                    e.target.checked ? [...ids, k.id] : ids.filter((id) => id !== k.id),
                  );
                }}
              />
              <span>
                {k.name}
                <span className="text-muted">{k.cli ? ` · for ${k.cli}` : ''}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field
          label="Only allow these addresses (optional, recommended)"
          placeholder="e.g. 203.0.113.7 or 203.0.113.0/24"
          hint="The computer's public IP. Then a stolen pass is useless anywhere else. Leave empty for laptops that move around."
          value={ips}
          onChange={(e) => {
            setIps(e.target.value);
          }}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Select label="Pass works for" value={lifetime} onChange={setLifetime}>
            {GATEWAY_LIMITS.lifetimesDays.map((d) => (
              <option key={d} value={String(d)}>
                {d} days
              </option>
            ))}
            <option value="never">Until I stop it</option>
          </Select>
          <Field
            label="Requests a minute"
            inputMode="numeric"
            value={rpm}
            onChange={(e) => {
              setRpm(e.target.value);
            }}
          />
          <Field
            label="Tokens a day (optional)"
            inputMode="numeric"
            placeholder="No limit"
            value={daily}
            onChange={(e) => {
              setDaily(e.target.value);
            }}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Create pass
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </CardBody>
  );
}

function KeyList({ data, onChange }: { data: GatewayOverview | null; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader
        icon={<KeyRound className="size-5" aria-hidden />}
        title="AI keys"
        description="Kept encrypted on this server and never shown again, not even to you."
        action={
          <Button
            variant="secondary"
            disabled={!data}
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />
      {adding && data ? (
        <AddKey
          presets={data.presets}
          taken={data.keys.map((k) => k.slug)}
          onCancel={() => {
            setAdding(false);
          }}
          onDone={() => {
            setAdding(false);
            onChange();
          }}
        />
      ) : null}
      {data === null ? (
        <CardBody>
          <Skeleton className="h-5 w-1/2" />
        </CardBody>
      ) : data.keys.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-8" aria-hidden />} title="No AI keys yet">
          Add an API key (or a Claude subscription token) so your machines can use it.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {data.keys.map((k) => (
            <KeyRow
              key={k.id}
              aiKey={k}
              preset={data.presets.find((p) => p.id === k.preset)}
              onRemoved={onChange}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function KeyRow({
  aiKey: k,
  preset,
  onRemoved,
}: {
  aiKey: AiKeySummary;
  preset: ProviderPreset | undefined;
  onRemoved: () => void;
}) {
  const { setSession } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = () => {
    setBusy(true);
    withFreshAuth(
      () => api(`/api/gateway/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }),
      setSession,
    )
      .then(() => {
        toast.success(`Removed “${k.name}”`);
        setConfirming(false);
        onRemoved();
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <li className="flex items-start gap-3 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {k.name}
          {preset?.experimental ? <Badge tone="warning">Experimental</Badge> : null}
        </p>
        <p className="text-sm text-muted">
          {preset?.label ?? k.preset} ·{' '}
          {preset?.noSecret ? 'uses the login in your vault' : `ends in ••••${k.hint}`}
          {k.cli ? ` · used by ${k.cli}` : ''}
          {k.model ? ` · model ${k.model}` : ''}
        </p>
        <p className="text-sm break-all text-muted">
          {k.gatewayUrl}
          {k.lastUsedAt ? ` · last used ${relativeTime(k.lastUsedAt)}` : ' · never used'}
        </p>
      </div>
      <Button
        variant="ghost"
        className="text-danger"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Remove
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove “${k.name}”?`}
        description="Machines stop being able to use it straight away. This does not cancel the key at the provider; do that on their website if you think it leaked."
        confirmLabel="Remove key"
        tone="danger"
        loading={busy}
        onConfirm={remove}
      />
    </li>
  );
}

function AddKey({
  presets,
  taken,
  onDone,
  onCancel,
}: {
  presets: readonly ProviderPreset[];
  taken: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { setSession } = useAuth();
  const first = presets[0];
  const [presetId, setPresetId] = useState(first?.id ?? '');
  const preset = presets.find((p) => p.id === presetId);
  const freeSlug = (base: string) => {
    let slug = base;
    for (let i = 2; taken.includes(slug); i++) slug = `${base}-${i}`;
    return slug;
  };
  const [name, setName] = useState(first?.label.split(' (')[0] ?? '');
  const [slug, setSlug] = useState(freeSlug(first?.slug ?? 'key'));
  const [upstream, setUpstream] = useState(first?.upstream ?? '');
  const [secret, setSecret] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (id: string) => {
    const p = presets.find((x) => x.id === id);
    setPresetId(id);
    if (!p) return;
    setName(p.label.split(' (')[0] ?? p.label);
    setSlug(freeSlug(p.slug));
    setUpstream(p.upstream);
  };

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = aiKeyCreateSchema.safeParse({
      preset: presetId,
      name,
      slug,
      secret: preset?.noSecret ? '' : secret,
      upstream,
      model,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? `${String(issue.path[0] ?? 'form')}: ${issue.message}` : 'Check the form');
      return;
    }
    setBusy(true);
    setError(null);
    withFreshAuth(() => post('/api/gateway/keys', parsed.data), setSession)
      .then(() => {
        setSecret('');
        toast.success('Key saved. It will not be shown again.');
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
      <form className="space-y-4" onSubmit={submit} noValidate autoComplete="off">
        <Select label="Provider" value={presetId} onChange={pick} hint={preset?.help}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
        {preset?.note ? (
          <Alert tone="warning" title={preset.experimental ? 'Experimental' : 'Good to know'}>
            {preset.note}
          </Alert>
        ) : null}
        {preset?.noSecret ? null : (
          <Field
            label="Key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the key"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
            }}
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            maxLength={GATEWAY_LIMITS.keyNameMax}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Field
            label="Short name in the address"
            hint={`Machines call …/gw/${slug || '…'}`}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase());
            }}
          />
        </div>
        {preset?.cli ? (
          <Field
            label={preset.needsModel ? 'Model' : 'Model (optional)'}
            placeholder={
              preset.needsModel
                ? 'Model name from the provider’s docs'
                : 'Leave empty to use the CLI’s default'
            }
            spellCheck={false}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
            }}
          />
        ) : null}
        {preset?.noSecret ? null : (
          <Field
            label="Provider address"
            hint={
              preset?.id === 'custom'
                ? 'The API base address, starting with https://'
                : 'Only change this if your provider told you to use a different address.'
            }
            value={upstream}
            onChange={(e) => {
              setUpstream(e.target.value);
            }}
          />
        )}
        {preset && preset.cli ? (
          <p className="text-sm text-muted">
            Machines get a {CLI_LABEL[preset.cli]} command that uses this key.
          </p>
        ) : (
          <p className="text-sm text-muted">
            No command is set up for this one. Point any compatible tool at the address above, with
            the machine's pass as its API key.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Save key
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </CardBody>
  );
}

function HowItWorks() {
  return (
    <Card>
      <CardHeader title="What a machine can and can't do" />
      <CardBody className="space-y-2 text-sm text-muted">
        <p>
          A machine sends its AI requests to agentbox with its pass. agentbox checks the pass, the
          allowed addresses and the limits, then adds your real key and forwards the request. Every
          request shows up above (which key, how many tokens), never its content.
        </p>
        <p>
          Someone with root on that computer can use your AI through the pass until you stop it.
          They can't read or copy your real keys, can't take over your accounts, and can't use the
          pass from elsewhere if you set allowed addresses.
        </p>
      </CardBody>
    </Card>
  );
}
