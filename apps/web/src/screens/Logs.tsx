import type { GatewayLogs, LogsDay, LogsMachine, LogsPeriod, LogsRow } from '@agentbox/shared';
import { Download, RefreshCw, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { PageHeader } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { Alert, Badge, EmptyState, Skeleton } from '../components/ui/feedback.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { dateTime, relativeTime } from '../lib/format.ts';
import { AgentTracker } from './AgentTracker.tsx';

/** How often the screen fetches fresh numbers while it is open. */
const REFRESH_MS = 30_000;

const selectClass =
  'block min-h-11 w-full rounded-[var(--radius-input)] border border-border bg-bg px-3 text-base focus-visible:outline-2';

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000).toLocaleString()}k`
      : n.toLocaleString();

const total = (x: { inputTokens: number | null; outputTokens: number | null }) =>
  (x.inputTokens ?? 0) + (x.outputTokens ?? 0);

/** Plain words for what happened to a request. */
function outcome(status: number): { label: string; tone: 'success' | 'warning' | 'danger' } {
  if (status < 400) return { label: 'OK', tone: 'success' };
  if (status === 429) return { label: 'Limit', tone: 'warning' };
  if (status === 499) return { label: 'Cancelled', tone: 'warning' };
  if (status === 401 || status === 403) return { label: 'Refused', tone: 'danger' };
  return { label: `Error ${String(status)}`, tone: 'danger' };
}

function seconds(ms: number): string {
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function csv(rows: LogsRow[]): string {
  const head = [
    'time',
    'computer',
    'address',
    'key',
    'model',
    'status',
    'input_tokens',
    'output_tokens',
    'duration_ms',
    'path',
  ];
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    head.join(','),
    ...rows.map((r) =>
      [
        r.ts,
        r.machineName,
        r.ip,
        r.keySlug,
        r.model,
        r.status,
        r.inputTokens,
        r.outputTokens,
        r.durationMs,
        r.path,
      ]
        .map(cell)
        .join(','),
    ),
  ].join('\n');
}

/** Logs has two views: usage (always on) and the agent tracker (off unless you turn it on). */
export function Logs() {
  const [view, setView] = useState<'usage' | 'tracker'>(() => {
    try {
      return sessionStorage.getItem('agentbox.logs.view') === 'tracker' ? 'tracker' : 'usage';
    } catch {
      return 'usage';
    }
  });
  const pick = (v: 'usage' | 'tracker') => {
    setView(v);
    try {
      sessionStorage.setItem('agentbox.logs.view', v);
    } catch {
      /* private window */
    }
  };
  const tabs = (
    <div role="tablist" aria-label="Logs" className="mb-4 flex gap-1 border-b border-border">
      {(
        [
          ['usage', 'Usage'],
          ['tracker', 'Agent tracker'],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          className={cn(
            '-mb-px min-h-11 border-b-2 px-3 text-sm font-medium',
            view === v
              ? 'border-accent text-text'
              : 'border-transparent text-muted hover:text-text',
          )}
          onClick={() => {
            pick(v);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return view === 'usage' ? <UsageLogs tabs={tabs} /> : <AgentTracker tabs={tabs} />;
}

function UsageLogs({ tabs }: { tabs: ReactNode }) {
  const [period, setPeriod] = useState<LogsPeriod>('7d');
  const [machineId, setMachineId] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [data, setData] = useState<GatewayLogs | null>(null);
  const [rows, setRows] = useState<LogsRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const periodId = useId();
  const machineSelectId = useId();

  const query = useCallback(
    (before?: string) => {
      const q = new URLSearchParams({ period, limit: '50' });
      if (machineId) q.set('machineId', machineId);
      if (errorsOnly) q.set('errors', '1');
      if (before) q.set('before', before);
      return `/api/gateway/logs?${q.toString()}`;
    },
    [period, machineId, errorsOnly],
  );

  /** Fetches the first page again; sets state only once the answer is in. */
  const fetchFirst = useCallback(
    () =>
      api<GatewayLogs>(query())
        .then((d) => {
          setData(d);
          setRows(d.rows);
          setNext(d.nextBefore);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(errorMessage(err));
        }),
    [query],
  );

  useEffect(() => {
    void fetchFirst();
    const timer = setInterval(() => {
      // Only the first page refreshes by itself, so older rows you opened stay put.
      if (document.visibilityState === 'visible') void fetchFirst();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [fetchFirst]);

  const refresh = () => {
    setLoading(true);
    void fetchFirst().finally(() => {
      setLoading(false);
    });
  };

  const loadMore = () => {
    if (!next) return;
    setLoadingMore(true);
    api<GatewayLogs>(query(next))
      .then((d) => {
        setRows((prev) => [...prev, ...d.rows]);
        setNext(d.nextBefore);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentbox-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Logs"
        description={`Which computers are connected, what they asked for and how many tokens they used. Kept for ${String(data?.keepDays ?? 7)} days, then deleted by itself.`}
        action={
          <Button variant="secondary" onClick={refresh} loading={loading}>
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </Button>
        }
      />
      {tabs}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <label htmlFor={periodId} className="block text-sm">
          <span className="mb-1 block font-medium">Period</span>
          <select
            id={periodId}
            className={selectClass}
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value as LogsPeriod);
            }}
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
          </select>
        </label>
        <label htmlFor={machineSelectId} className="block text-sm">
          <span className="mb-1 block font-medium">Computer</span>
          <select
            id={machineSelectId}
            className={selectClass}
            value={machineId}
            onChange={(e) => {
              setMachineId(e.target.value);
            }}
          >
            <option value="">All computers</option>
            {data?.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={errorsOnly}
            onChange={(e) => {
              setErrorsOnly(e.target.checked);
            }}
          />
          Only requests that failed
        </label>
      </div>

      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {data === null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <Totals data={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <MachinesCard machines={data.machines} period={data.period} />
            <DaysCard days={data.days} />
          </div>
          {data.models.length > 0 ? <ModelsCard data={data} /> : null}
          <Card>
            <CardHeader
              title="Requests"
              description="Newest first. Only which computer, key and model, never what was asked or answered."
              action={
                rows.length > 0 ? (
                  <Button variant="ghost" onClick={download}>
                    <Download className="size-4" aria-hidden />
                    CSV
                  </Button>
                ) : null
              }
            />
            {rows.length === 0 ? (
              <EmptyState
                icon={<ScrollText className="size-8" aria-hidden />}
                title={errorsOnly ? 'No failed requests' : 'No requests yet'}
              >
                {errorsOnly
                  ? 'Nothing went wrong in this period.'
                  : 'Requests from your computers show up here.'}
              </EmptyState>
            ) : (
              <RequestTable rows={rows} />
            )}
          </Card>
          {next ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
                Show older
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {note ? <p className="text-xs text-muted">{note}</p> : null}
    </Card>
  );
}

function Totals({ data }: { data: GatewayLogs }) {
  const t = data.totals;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label="Connected now"
        value={`${String(t.connectedNow)} of ${String(t.machines)}`}
        note="seen in the last 5 minutes"
      />
      <Stat
        label="Computers used"
        value={String(t.usedInPeriod)}
        note={data.period === '24h' ? 'last 24 hours' : 'last 7 days'}
      />
      <Stat
        label="Requests"
        value={t.requests.toLocaleString()}
        note={t.errors > 0 ? `${t.errors.toLocaleString()} failed` : 'none failed'}
      />
      <Stat
        label="Tokens"
        value={tokens(t.inputTokens + t.outputTokens)}
        note={`${tokens(t.inputTokens)} in · ${tokens(t.outputTokens)} out`}
      />
    </div>
  );
}

function stateBadge(m: LogsMachine) {
  if (m.state === 'stopped') return <Badge tone="danger">Stopped</Badge>;
  if (m.state === 'expired') return <Badge tone="warning">Expired</Badge>;
  if (m.connected) return <Badge tone="success">Connected</Badge>;
  return <Badge>Idle</Badge>;
}

function MachinesCard({ machines, period }: { machines: LogsMachine[]; period: LogsPeriod }) {
  const most = Math.max(1, ...machines.map(total));
  return (
    <Card>
      <CardHeader
        title="Computers"
        description={`Most tokens first, ${period === '24h' ? 'last 24 hours' : 'last 7 days'}.`}
      />
      {machines.length === 0 ? (
        <CardBody className="text-sm text-muted">No computers added yet.</CardBody>
      ) : (
        <ul className="divide-y divide-border">
          {machines.map((m) => (
            <li key={m.id} className="space-y-1.5 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {stateBadge(m)}
                <span className="ml-auto text-sm font-medium tabular-nums">
                  {tokens(total(m))} tokens
                </span>
              </div>
              <div
                className="h-2 rounded-full bg-surface-2"
                role="img"
                aria-label={`${m.name}: ${tokens(total(m))} tokens`}
              >
                <div
                  className="h-2 rounded-full bg-accent"
                  style={{
                    width: `${String(total(m) === 0 ? 0 : Math.max(2, (total(m) / most) * 100))}%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted">
                {m.requests.toLocaleString()} requests
                {m.errors > 0 ? `, ${m.errors.toLocaleString()} failed` : ''}
                {m.topModel ? ` · mostly ${m.topModel}` : ''}
                {' · last seen '}
                {m.lastSeenAt ? (
                  <time dateTime={m.lastSeenAt} title={dateTime(m.lastSeenAt)}>
                    {relativeTime(m.lastSeenAt)}
                  </time>
                ) : (
                  'never'
                )}
                {m.lastIp ? (
                  <>
                    {' from '}
                    <span className="font-mono">{m.lastIp}</span>
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DaysCard({ days }: { days: LogsDay[] }) {
  const most = Math.max(1, ...days.map(total));
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover === null ? null : days[hover];
  const weekday = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  return (
    <Card>
      <CardHeader
        title="Tokens per day"
        description={
          shown
            ? `${new Date(`${shown.day}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}: ${tokens(total(shown))} tokens, ${shown.requests.toLocaleString()} requests`
            : 'All computers, by UTC day. Point at a day for its numbers.'
        }
      />
      <CardBody>
        <div className="flex h-40 items-end gap-2" role="list" aria-label="Tokens per day">
          {days.map((d, i) => {
            const value = total(d);
            return (
              <div
                key={d.day}
                role="listitem"
                tabIndex={0}
                aria-label={`${d.day}: ${tokens(value)} tokens, ${String(d.requests)} requests`}
                className="flex h-full flex-1 flex-col items-center justify-end gap-1 rounded-md outline-offset-2 focus-visible:outline-2"
                onMouseEnter={() => {
                  setHover(i);
                }}
                onMouseLeave={() => {
                  setHover(null);
                }}
                onFocus={() => {
                  setHover(i);
                }}
                onBlur={() => {
                  setHover(null);
                }}
              >
                <span className="text-xs tabular-nums text-muted">
                  {value > 0 ? tokens(value) : ''}
                </span>
                <div
                  className={cn(
                    'w-full max-w-10 rounded-t bg-accent transition-opacity',
                    hover !== null && hover !== i && 'opacity-50',
                  )}
                  style={{
                    height: `${String(value === 0 ? 0 : Math.max(2, (value / most) * 100))}%`,
                  }}
                />
                <span className="text-xs text-muted">{weekday(d.day)}</span>
              </div>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

function ModelsCard({ data }: { data: GatewayLogs }) {
  return (
    <Card>
      <CardHeader title="Models" description="Which models used the most tokens." />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr className="border-b border-border">
              <th className="px-5 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 text-right font-medium">Requests</th>
              <th className="px-5 py-2 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.models.map((m) => (
              <tr key={`${m.keySlug}/${m.model}`}>
                <td className="px-5 py-2 font-mono text-xs">{m.model}</td>
                <td className="px-3 py-2">{m.keySlug}</td>
                <td className="px-3 py-2 text-right tabular-nums">{m.requests.toLocaleString()}</td>
                <td className="px-5 py-2 text-right tabular-nums">{tokens(total(m))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RequestTable({ rows }: { rows: LogsRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-muted">
          <tr className="border-b border-border">
            <th className="px-5 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Computer</th>
            <th className="px-3 py-2 font-medium">Key · model</th>
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 text-right font-medium">Tokens</th>
            <th className="px-5 py-2 text-right font-medium">Took</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const o = outcome(r.status);
            return (
              <tr key={r.id} className="align-top">
                <td className="whitespace-nowrap px-5 py-2">
                  <time dateTime={r.ts} title={dateTime(r.ts)}>
                    {relativeTime(r.ts)}
                  </time>
                </td>
                <td className="px-3 py-2">
                  <div>{r.machineName}</div>
                  {r.ip ? <div className="font-mono text-xs text-muted">{r.ip}</div> : null}
                </td>
                <td className="px-3 py-2">
                  <div>{r.keySlug}</div>
                  <div className="font-mono text-xs text-muted">{r.model ?? r.path}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={o.tone} title={`HTTP ${String(r.status)}`}>
                    {o.label}
                  </Badge>
                </td>
                <td
                  className="whitespace-nowrap px-3 py-2 text-right tabular-nums"
                  title={
                    r.inputTokens === null && r.outputTokens === null
                      ? undefined
                      : `${(r.inputTokens ?? 0).toLocaleString()} in, ${(r.outputTokens ?? 0).toLocaleString()} out`
                  }
                >
                  {r.inputTokens === null && r.outputTokens === null ? '–' : tokens(total(r))}
                </td>
                <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-muted">
                  {seconds(r.durationMs)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
