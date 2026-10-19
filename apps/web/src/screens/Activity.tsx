import type { AuditEntry, AuditPage, AuditVerifyResult } from '@agentbox/shared';
import { History, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Alert, Badge, EmptyState, Skeleton } from '../components/ui/feedback.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { dateTime, describeClient, relativeTime } from '../lib/format.ts';

const LABELS: Record<string, string> = {
  'setup.link_created': 'Setup link created',
  'setup.reset': 'Sign-in methods reset',
  'setup.completed': 'Setup completed',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.device_approval_required': 'New device needed approval',
  'auth.device_approved': 'Device approved',
  'auth.recovery_used': 'Recovery code used',
  'auth.logout': 'Signed out',
  'auth.reauth': 'Confirmed with passkey',
  'auth.lockout': 'Locked out after failed attempts',
  'session.expired': 'Session ended',
  'passkey.added': 'Passkey added',
  'passkey.removed': 'Passkey removed',
  'password.set': 'Sign-in password set',
  'password.removed': 'Sign-in password removed',
  'ai_key.added': 'AI key added',
  'ai_key.updated': 'AI key changed',
  'ai_key.removed': 'AI key removed',
  'ai_key.tested': 'AI key tested',
  'tracker.enabled': 'Agent tracker turned on',
  'tracker.disabled': 'Agent tracker turned off',
  'tracker.options': 'Agent tracker settings changed',
  'tracker.deleted': 'Agent tracker entries deleted',
  'tracker.exported': 'Agent tracker entries exported',
  'machine.added': 'Machine added',
  'machine.updated': 'Machine changed',
  'machine.revoked': 'Machine stopped',
  'machine.revoked_all': 'All machines stopped',
  'machine.first_used': 'Machine used for the first time',
  'machine.ip_changed': 'Machine used from a new address',
  'machine.blocked_ip': 'Machine pass used from a blocked address',
  'machine.limit_hit': 'Machine reached a limit',
  'machine.grok_token': 'Machine signed Grok in',
  'machine.ip_locked': 'Machine pass locked to its first address',
  'machine.started': 'Machine started again',
  'machine.deleted': 'Machine deleted',
  'machine.ip_allowed': 'New address allowed for a machine',
  'machine.ip_ignored': 'New address refused for a machine',
  'machine.bad_pass_lockout': 'Address locked after wrong machine passes',
  'machine.setup': 'Computer set up with a machine pass',
  'machine.computer_bound': 'Machine pass tied to its computer',
  'machine.other_computer': 'Machine pass used on another computer',
  'machine.blocked_computer': 'Machine pass refused on another computer',
  'machine.off_schedule': 'Machine used outside its schedule',
  'terminal.created': 'Terminal session started',
  'terminal.renamed': 'Terminal session renamed',
  'terminal.killed': 'Terminal session closed',
  'terminal.opened': 'Terminal opened',
  'vault.created': 'Vault created',
  'vault.unlocked': 'Vault unlocked',
  'vault.unlock_failed': 'Wrong vault password',
  'vault.locked': 'Vault locked',
  'vault.reset': 'Vault deleted',
  'vault.auto_unlock_on': 'Vault auto-unlock turned on',
  'vault.auto_unlock_off': 'Vault auto-unlock turned off',
  'vault.auto_unlock_failed': 'Vault auto-unlock failed; stored password deleted',
};

const WARN = new Set([
  'vault.unlock_failed',
  'vault.reset',
  'vault.auto_unlock_failed',
  'auth.login_failed',
  'auth.lockout',
  'auth.recovery_used',
  'setup.reset',
  'machine.ip_changed',
  'machine.blocked_ip',
  'machine.bad_pass_lockout',
  'machine.other_computer',
  'machine.blocked_computer',
  'machine.off_schedule',
]);

function describe(e: AuditEntry): string {
  const d = e.details;
  const parts: string[] = [];
  if (typeof d.method === 'string') parts.push(`with ${d.method}`);
  if (typeof d.deviceName === 'string') parts.push(`on ${d.deviceName}`);
  if (typeof d.name === 'string') parts.push(`“${d.name}”`);
  if (typeof d.reason === 'string') parts.push(`(${d.reason.replace(/_/g, ' ')})`);
  return parts.join(' ');
}

/** "LAPTOP-7 · user krish · Windows 11", from what the computer's setup reported. */
function computerLine(e: AuditEntry): string | null {
  const c = e.details.computer;
  if (!c || typeof c !== 'object') return null;
  const { host, user, os } = c as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof host === 'string' && host) parts.push(host);
  if (typeof user === 'string' && user) parts.push(`user ${user}`);
  if (typeof os === 'string' && os) parts.push(os);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const DETAIL_LABELS: Record<string, string> = {
  client: 'Program',
  computer: 'Computer',
  name: 'Name',
  previousIp: 'Previous address',
  expected: 'Tied to',
  computerName: 'Computer',
  deviceName: 'Device',
  userAgent: 'Browser',
};

function detailLabel(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return DETAIL_LABELS[key] ?? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function detailValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`)
      .join(', ');
  }
  return JSON.stringify(v);
}

/** Who did it: you in the browser, a machine pass, or agentbox itself. */
const ACTORS: Record<string, string> = {
  owner: 'You',
  system: 'agentbox',
  gateway: 'agentbox gateway',
  anonymous: 'Someone not signed in',
  cli: 'agentbox command on the server',
};

function actorLabel(e: AuditEntry): string {
  const name = typeof e.details.name === 'string' ? e.details.name : null;
  if (e.actor.startsWith('machine:')) return name ? `Machine “${name}”` : 'A machine pass';
  if (e.actor.startsWith('device:')) return 'You, on a signed-in device';
  return ACTORS[e.actor] ?? e.actor;
}

function EntryMeta({ e }: { e: AuditEntry }) {
  const computer = computerLine(e);
  const client = typeof e.details.client === 'string' ? describeClient(e.details.client) : null;
  if (!computer && !client) return null;
  return (
    <span className="basis-full text-xs text-muted">
      {computer ? <span>Computer: {computer}</span> : null}
      {computer && client ? <span aria-hidden> · </span> : null}
      {client ? <span>Via {client}</span> : null}
    </span>
  );
}

function EntryDetails({ e }: { e: AuditEntry }) {
  const rows: [string, string][] = [
    ['Done by', actorLabel(e)],
    ['Recorded as', e.actor],
    ...(e.ip ? ([['Address', e.ip]] as [string, string][]) : []),
    ...Object.entries(e.details).map(([k, v]): [string, string] => [
      detailLabel(k),
      detailValue(v),
    ]),
    ['Entry', `#${String(e.seq)} · ${dateTime(e.ts)}`],
  ];
  return (
    <details className="basis-full text-sm">
      <summary className="cursor-pointer text-xs text-muted select-none">Details</summary>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
        {rows.map(([k, v], i) => (
          <div key={i} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="font-mono break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function Activity() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    api<AuditPage>('/api/audit?limit=50')
      .then((p) => {
        setEntries(p.entries);
        setNext(p.nextBefore);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  }, []);

  const loadMore = () => {
    if (next === null) return;
    setLoadingMore(true);
    api<AuditPage>(`/api/audit?limit=50&before=${String(next)}`)
      .then((p) => {
        setEntries((prev) => [...(prev ?? []), ...p.entries]);
        setNext(p.nextBefore);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const runVerify = () => {
    setVerifying(true);
    api<AuditVerifyResult>('/api/audit/verify')
      .then(setVerify)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setVerifying(false);
      });
  };

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every sign-in and security change. Entries can't be edited or deleted."
        action={
          <Button variant="secondary" onClick={runVerify} loading={verifying}>
            <ShieldCheck className="size-4" aria-hidden />
            Check integrity
          </Button>
        }
      />
      {verify ? (
        verify.ok ? (
          <Alert tone="success" title="Log is intact" className="mb-4">
            All {verify.checked} entries match their hash chain.
          </Alert>
        ) : (
          <Alert tone="danger" title="The log has been tampered with" className="mb-4">
            Entry #{verify.brokenAt} doesn't match the chain. Someone with access to the server's
            database changed it. Treat the server as compromised.
          </Alert>
        )
      ) : null}
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <Card>
        {entries === null ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={<History className="size-8" aria-hidden />} title="No activity yet" />
        ) : (
          <ol className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.seq} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-5 py-3">
                <span className="font-medium">
                  {LABELS[e.action] ?? e.action}
                  {WARN.has(e.action) && e.details.sameComputer !== true ? (
                    <Badge tone="warning" className="ml-2 align-middle">
                      Check
                    </Badge>
                  ) : null}
                </span>
                <span className="text-sm text-muted">{describe(e)}</span>
                <span className="ml-auto text-sm text-muted">
                  <time dateTime={e.ts} title={dateTime(e.ts)}>
                    {relativeTime(e.ts)}
                  </time>
                  {e.ip ? <span className="ml-2 font-mono text-xs">{e.ip}</span> : null}
                </span>
                <EntryMeta e={e} />
                <EntryDetails e={e} />
              </li>
            ))}
          </ol>
        )}
      </Card>
      {next !== null ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Show older
          </Button>
        </div>
      ) : null}
    </>
  );
}
