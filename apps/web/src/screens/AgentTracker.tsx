import type {
  TraceEntry,
  TraceFilter,
  TraceFilterOptions,
  TracePage,
  TraceStepType,
  TraceSummary,
  TraceTool,
  TrackerStatus,
} from '@agentbox/shared';
import { Download, Eye, EyeOff, Radar, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PageHeader } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { ConfirmDialog } from '../components/ui/dialog.tsx';
import { Alert, Badge, EmptyState, Skeleton } from '../components/ui/feedback.tsx';
import { api, errorMessage, post } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { agoTime, dateTime } from '../lib/format.ts';
import { FreshAuthCancelled, withFreshAuth } from '../lib/fresh-auth.ts';
import { useAuth } from '../state/auth.tsx';

/** While the tracker is on, new entries show up by themselves this often. */
const LIVE_MS = 10_000;

const STEP: Record<
  TraceStepType,
  { label: string; tone: 'info' | 'success' | 'warning' | 'danger' }
> = {
  prompt: { label: 'Prompt', tone: 'success' },
  thinking: { label: 'Thinking', tone: 'info' },
  answer: { label: 'Answer', tone: 'success' },
  tool_call: { label: 'Tool', tone: 'warning' },
  command: { label: 'Command', tone: 'danger' },
  mcp: { label: 'MCP', tone: 'warning' },
  tool_result: { label: 'Result', tone: 'info' },
};

const ORDER: TraceStepType[] = [
  'prompt',
  'command',
  'mcp',
  'tool_call',
  'thinking',
  'answer',
  'tool_result',
];

function saveCsv(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

type Pending = { kind: 'delete'; ids: string[] | 'all'; label: string } | null;

const FILTER_KEY = 'agentbox.tracker.filter';

function savedFilter(): TraceFilter {
  try {
    const v = JSON.parse(sessionStorage.getItem(FILTER_KEY) ?? '{}') as Record<string, unknown>;
    const f: TraceFilter = {};
    if (typeof v['machineId'] === 'string') f.machineId = v['machineId'];
    if (typeof v['ip'] === 'string') f.ip = v['ip'];
    if (typeof v['model'] === 'string') f.model = v['model'];
    return f;
  } catch {
    return {};
  }
}

/** The filter with one value changed; an empty value removes it. */
function withValue(f: TraceFilter, key: keyof TraceFilter, value: string): TraceFilter {
  const next: TraceFilter = {};
  for (const k of ['machineId', 'ip', 'model'] as const) {
    const v = k === key ? value : f[k];
    if (v) next[k] = v;
  }
  return next;
}

function query(f: TraceFilter): string {
  const p = new URLSearchParams();
  if (f.machineId) p.set('machineId', f.machineId);
  if (f.ip) p.set('ip', f.ip);
  if (f.model) p.set('model', f.model);
  const q = p.toString();
  return q ? `&${q}` : '';
}

const selectClass =
  'block min-h-11 w-full rounded-[var(--radius-input)] border border-border bg-bg px-3 text-base focus-visible:outline-2';

/** An on/off switch with its label and a line of help. */
function Toggle({
  label,
  help,
  on,
  disabled,
  onChange,
}: {
  label: string;
  help: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">{label}</p>
        <p className="text-sm text-muted">{help}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          onChange(!on);
        }}
        className={cn(
          'relative mt-1 inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-2 disabled:opacity-50',
          on ? 'bg-[var(--accent)]' : 'bg-surface-2',
        )}
      >
        <span
          className={cn(
            'inline-block size-5 rounded-full bg-white shadow transition-transform',
            on ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}

export function AgentTracker({ tabs }: { tabs: ReactNode }) {
  const { setSession } = useAuth();
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [entries, setEntries] = useState<TraceSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [filter, setFilterState] = useState<TraceFilter>(savedFilter);
  const [options, setOptions] = useState<TraceFilterOptions | null>(null);
  const filtered = Boolean(filter.machineId ?? filter.ip ?? filter.model);

  const setFilter = (f: TraceFilter) => {
    setFilterState(f);
    setEntries(null);
    setNext(null);
    setSelected(new Set());
    setOpen(null);
    try {
      sessionStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      // Remembering the filter is only a convenience.
    }
  };

  const fetchFirst = useCallback(
    () =>
      Promise.all([
        api<TrackerStatus>('/api/tracker'),
        api<TracePage>(`/api/tracker/entries?limit=50${query(filter)}`),
        api<TraceFilterOptions>('/api/tracker/filters'),
      ])
        .then(([st, page, opts]) => {
          setStatus(st);
          setOptions(opts);
          // Keep older pages you opened; put new entries on top.
          setEntries((prev) => {
            if (!prev) return page.entries;
            const ids = new Set(page.entries.map((e) => e.id));
            const older = prev.filter(
              (e) =>
                !ids.has(e.id) && page.entries.length > 0 && e.ts < (page.entries.at(-1)?.ts ?? ''),
            );
            return [...page.entries, ...older];
          });
          setNext((prev) => prev ?? page.nextBefore);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(errorMessage(err));
        }),
    [filter],
  );

  useEffect(() => {
    void fetchFirst();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchFirst();
    }, LIVE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [fetchFirst]);

  const reload = () => {
    setBusy('refresh');
    setEntries(null);
    setNext(null);
    void fetchFirst().finally(() => {
      setBusy(null);
    });
  };

  const loadMore = () => {
    if (!next) return;
    setBusy('more');
    api<TracePage>(
      `/api/tracker/entries?limit=50&before=${encodeURIComponent(next)}${query(filter)}`,
    )
      .then((page) => {
        setEntries((prev) => [...(prev ?? []), ...page.entries]);
        setNext(page.nextBefore);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const toggle = (on: boolean) => {
    setBusy('toggle');
    setNotice(null);
    const send = () => api<TrackerStatus>('/api/tracker', { method: 'PUT', body: { enabled: on } });
    (on ? withFreshAuth(send, setSession) : send())
      .then((st) => {
        setStatus(st);
        setNotice(
          on
            ? 'The agent tracker is on. New requests from your computers show up below.'
            : 'The agent tracker is off. Nothing new is saved; what was saved stays until you delete it.',
        );
      })
      .catch((err: unknown) => {
        if (!(err instanceof FreshAuthCancelled)) setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const setSwitch = (name: 'system' | 'tools', on: boolean) => {
    setBusy(name);
    setNotice(null);
    const send = () => api<TrackerStatus>('/api/tracker', { method: 'PUT', body: { [name]: on } });
    (on ? withFreshAuth(send, setSession) : send())
      .then((st) => {
        setStatus(st);
      })
      .catch((err: unknown) => {
        if (!(err instanceof FreshAuthCancelled)) setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  // "All" means all that match the filter, when one is set.
  const pick = (ids: string[] | 'all') => (ids === 'all' && filtered ? { ids, filter } : { ids });

  const exportCsv = (ids: string[] | 'all') => {
    setBusy('export');
    withFreshAuth(
      () => post<{ csv: string; entries: number }>('/api/tracker/export', pick(ids)),
      setSession,
    )
      .then(({ csv, entries: n }) => {
        saveCsv(csv, `agentbox-agent-tracker-${new Date().toISOString().slice(0, 10)}.csv`);
        setNotice(`Exported ${String(n)} ${n === 1 ? 'entry' : 'entries'}.`);
      })
      .catch((err: unknown) => {
        if (!(err instanceof FreshAuthCancelled)) setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const remove = (ids: string[] | 'all') => {
    setBusy('delete');
    post<{ deleted: number }>('/api/tracker/delete', pick(ids))
      .then(({ deleted }) => {
        setNotice(`Deleted ${String(deleted)} ${deleted === 1 ? 'entry' : 'entries'}.`);
        setSelected(new Set());
        setPending(null);
        setOpen(null);
        setEntries((prev) =>
          ids === 'all' ? [] : (prev ?? []).filter((e) => !ids.includes(e.id)),
        );
        if (ids === 'all') setNext(null);
        void fetchFirst();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const list = entries ?? [];
  const allSelected = list.length > 0 && list.every((e) => selected.has(e.id));
  const selectedIds = [...selected];

  return (
    <>
      <PageHeader
        title="Logs"
        description="The agent tracker shows what the AI agents on your computers do: your prompts, their thinking, the tools, commands and MCP calls they use, and their answers."
        action={
          <Button variant="secondary" onClick={reload} loading={busy === 'refresh'}>
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </Button>
        }
      />
      {tabs}

      <Card className="mb-4">
        <CardHeader
          icon={<Radar className="size-5" aria-hidden />}
          title={status?.enabled ? 'Agent tracker is on' : 'Agent tracker is off'}
          description={
            status?.enabled
              ? 'Every request from your computers is saved here, encrypted, until you delete it.'
              : 'Nothing is saved. Turn it on when you want to see what an agent is doing.'
          }
          action={
            status ? (
              status.enabled ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    toggle(false);
                  }}
                  loading={busy === 'toggle'}
                >
                  <EyeOff className="size-4" aria-hidden />
                  Turn off
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    toggle(true);
                  }}
                  loading={busy === 'toggle'}
                >
                  <Eye className="size-4" aria-hidden />
                  Turn on
                </Button>
              )
            ) : null
          }
        />
        <CardBody className="space-y-1 text-sm text-muted">
          <p>
            It reads what passes through agentbox, so it works for claude, codex, grok, kimi and
            gemini on every computer. Turning it on and exporting ask for your passkey or
            authenticator code.
          </p>
          <p>
            {status ? `${status.entries.toLocaleString()} saved` : '…'} · keeps the newest{' '}
            {(status?.maxEntries ?? 20000).toLocaleString()}. Turning it off keeps what was saved.
          </p>
          <div className="divide-y divide-border border-t border-border pt-2">
            <Toggle
              label="Save system prompts"
              help="The instructions each CLI gives the model. Off: not saved."
              on={status?.system ?? false}
              disabled={!status || busy === 'system'}
              onChange={(on) => {
                setSwitch('system', on);
              }}
            />
            <Toggle
              label="Save tools and MCP servers"
              help="Every tool the CLI offers the model, grouped by MCP server. Off: not saved. Commands and MCP calls the agent makes are always saved."
              on={status?.tools ?? false}
              disabled={!status || busy === 'tools'}
              onChange={(on) => {
                setSwitch('tools', on);
              }}
            />
          </div>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Computer</span>
            <select
              className={selectClass}
              value={filter.machineId ?? ''}
              onChange={(e) => {
                setFilter(withValue(filter, 'machineId', e.target.value));
              }}
            >
              <option value="">All computers</option>
              {options?.machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Address</span>
            <select
              className={selectClass}
              value={filter.ip ?? ''}
              onChange={(e) => {
                setFilter(withValue(filter, 'ip', e.target.value));
              }}
            >
              <option value="">All addresses</option>
              {options?.ips.map((ip) => (
                <option key={ip} value={ip}>
                  {ip}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Model</span>
            <select
              className={selectClass}
              value={filter.model ?? ''}
              onChange={(e) => {
                setFilter(withValue(filter, 'model', e.target.value));
              }}
            >
              <option value="">All models</option>
              {options?.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            disabled={!filtered}
            onClick={() => {
              setFilter({});
            }}
          >
            <X className="size-4" aria-hidden />
            Clear filters
          </Button>
        </CardBody>
      </Card>

      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" className="mb-4">
          {notice}
        </Alert>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <label className="mr-2 flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={allSelected}
              disabled={list.length === 0}
              onChange={(e) => {
                setSelected(e.target.checked ? new Set(list.map((x) => x.id)) : new Set());
              }}
            />
            Select all
          </label>
          <Button
            variant="secondary"
            disabled={selected.size === 0}
            loading={busy === 'export' && selected.size > 0}
            onClick={() => {
              exportCsv(selectedIds);
            }}
          >
            <Download className="size-4" aria-hidden />
            Export selected ({selected.size})
          </Button>
          <Button
            variant="secondary"
            disabled={selected.size === 0}
            onClick={() => {
              setPending({
                kind: 'delete',
                ids: selectedIds,
                label: `${String(selected.size)} selected ${selected.size === 1 ? 'entry' : 'entries'}`,
              });
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete selected
          </Button>
          <span className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={filtered ? list.length === 0 : !status?.entries}
              loading={busy === 'export' && selected.size === 0}
              onClick={() => {
                exportCsv('all');
              }}
            >
              <Download className="size-4" aria-hidden />
              {filtered ? 'Export all matching' : 'Export all'}
            </Button>
            <Button
              variant="ghost"
              className="text-danger"
              disabled={filtered ? list.length === 0 : !status?.entries}
              onClick={() => {
                setPending({
                  kind: 'delete',
                  ids: 'all',
                  label: filtered ? 'every entry that matches the filters' : 'every saved entry',
                });
              }}
            >
              <Trash2 className="size-4" aria-hidden />
              {filtered ? 'Delete all matching' : 'Delete all'}
            </Button>
          </span>
        </div>

        {entries === null ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Radar className="size-8" aria-hidden />} title="Nothing saved yet">
            {filtered
              ? 'Nothing matches these filters.'
              : status?.enabled
                ? 'Use an AI CLI on one of your computers; its steps show up here within seconds.'
                : 'Turn the agent tracker on, then use an AI CLI on one of your computers.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                checked={selected.has(e.id)}
                expanded={open === e.id}
                onCheck={(on) => {
                  setSelected((prev) => {
                    const s = new Set(prev);
                    if (on) s.add(e.id);
                    else s.delete(e.id);
                    return s;
                  });
                }}
                onToggle={() => {
                  setOpen((cur) => (cur === e.id ? null : e.id));
                }}
                onNote={(note) => {
                  setEntries((prev) =>
                    (prev ?? []).map((x) => (x.id === e.id ? { ...x, note } : x)),
                  );
                }}
                onExport={() => {
                  exportCsv([e.id]);
                }}
                onDelete={() => {
                  setPending({ kind: 'delete', ids: [e.id], label: 'this entry' });
                }}
              />
            ))}
          </ul>
        )}
      </Card>
      {next ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={loadMore} loading={busy === 'more'}>
            Show older
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
        title="Delete from the agent tracker?"
        description={`This deletes ${pending?.label ?? ''} for good. It can't be undone.`}
        confirmLabel="Delete"
        tone="danger"
        loading={busy === 'delete'}
        onConfirm={() => {
          if (pending) remove(pending.ids);
        }}
      />
    </>
  );
}

function EntryRow({
  entry: e,
  checked,
  expanded,
  onCheck,
  onToggle,
  onNote,
  onExport,
  onDelete,
}: {
  entry: TraceSummary;
  checked: boolean;
  expanded: boolean;
  onCheck: (on: boolean) => void;
  onToggle: () => void;
  onNote: (note: string) => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const tokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
  return (
    <li className="px-5 py-3">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={`Select entry from ${e.machineName}, ${agoTime(e.ts)}`}
          className="mt-1.5 size-4 shrink-0 accent-[var(--accent)]"
          checked={checked}
          onChange={(ev) => {
            onCheck(ev.target.checked);
          }}
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium">{e.machineName}</span>
            {e.ip ? <span className="font-mono text-xs text-muted">{e.ip}</span> : null}
            <span className="text-muted">
              {e.cli ?? e.keySlug}
              {e.model ? ` · ${e.model}` : ''}
            </span>
            {e.status >= 400 ? <Badge tone="danger">Error {e.status}</Badge> : null}
            <span className="ml-auto whitespace-nowrap text-xs text-muted">
              <time dateTime={e.ts} title={dateTime(e.ts)}>
                {agoTime(e.ts)}
              </time>
              {tokens > 0 ? ` · ${tokens.toLocaleString()} tokens` : ''}
              {e.cacheReadTokens ? ` (${e.cacheReadTokens.toLocaleString()} from cache)` : ''}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 break-words text-sm">{e.preview || '(no text)'}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ORDER.filter((t) => e.counts[t]).map((t) => (
              <Badge key={t} tone={STEP[t].tone}>
                {e.counts[t]} {STEP[t].label.toLowerCase()}
              </Badge>
            ))}
            {e.hasSystem ? <Badge>system prompt</Badge> : null}
            {e.toolCount ? (
              <Badge>
                {e.toolCount} {e.toolCount === 1 ? 'tool' : 'tools'}
                {e.mcpToolCount ? ` · ${String(e.mcpToolCount)} MCP` : ''}
              </Badge>
            ) : null}
            {e.note ? <Badge>Note: {e.note}</Badge> : null}
          </div>
        </button>
      </div>
      {expanded ? (
        <EntryDetail
          id={e.id}
          note={e.note}
          onNote={onNote}
          onExport={onExport}
          onDelete={onDelete}
        />
      ) : null}
    </li>
  );
}

function EntryDetail({
  id,
  note,
  onNote,
  onExport,
  onDelete,
}: {
  id: string;
  note: string;
  onNote: (note: string) => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const [entry, setEntry] = useState<TraceEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(note);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api<TraceEntry>(`/api/tracker/entries/${encodeURIComponent(id)}`)
      .then((x) => {
        if (live) setEntry(x);
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [id]);

  const save = () => {
    setSaving(true);
    api<TraceEntry>(`/api/tracker/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { note: draft },
    })
      .then((x) => {
        onNote(x.note);
        setDraft(x.note);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div className="mt-3 space-y-3 pl-7">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {entry === null && !error ? <Skeleton className="h-24 w-full" /> : null}
      {entry ? <Context entry={entry} /> : null}
      {entry ? (
        <ol className="space-y-2">
          {entry.steps.map((s, i) => (
            <li key={i} className="rounded-[var(--radius-input)] border border-border bg-bg p-3">
              <div className="mb-1 flex items-center gap-2 text-xs">
                <Badge tone={STEP[s.type].tone}>{STEP[s.type].label}</Badge>
                {s.name ? <span className="font-mono text-muted">{s.name}</span> : null}
              </div>
              <pre
                className={cn(
                  'max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm',
                  (s.type === 'command' ||
                    s.type === 'tool_call' ||
                    s.type === 'mcp' ||
                    s.type === 'tool_result') &&
                    'font-mono text-xs',
                )}
              >
                {s.text ||
                  (s.type === 'thinking'
                    ? "(empty: the provider didn't send the thinking text for this request)"
                    : '')}
              </pre>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-48 flex-1 text-sm">
          <span className="mb-1 block font-medium">Note</span>
          <input
            className="block min-h-11 w-full rounded-[var(--radius-input)] border border-border bg-bg px-3 text-base focus-visible:outline-2"
            value={draft}
            maxLength={500}
            placeholder="Add a note to find this later"
            onChange={(ev) => {
              setDraft(ev.target.value);
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') save();
            }}
          />
        </label>
        <Button variant="secondary" onClick={save} loading={saving} disabled={draft === note}>
          Save note
        </Button>
        <Button variant="ghost" onClick={onExport}>
          <Download className="size-4" aria-hidden />
          Export
        </Button>
        <Button variant="ghost" className="text-danger" onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden />
          Delete
        </Button>
      </div>
    </div>
  );
}

const summaryClass =
  'flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm font-medium select-none';

/** The system prompt and the tools the agent gave the model, folded away. */
function Context({ entry }: { entry: TraceEntry }) {
  if (!entry.system && entry.tools.length === 0) return null;
  const mcp = new Map<string, TraceTool[]>();
  const other: TraceTool[] = [];
  for (const t of entry.tools) {
    if (t.kind === 'mcp') {
      const k = t.server ?? '';
      mcp.set(k, [...(mcp.get(k) ?? []), t]);
    } else other.push(t);
  }
  return (
    <div className="space-y-2">
      {entry.system ? (
        <details className="rounded-[var(--radius-input)] border border-border bg-bg">
          <summary className={summaryClass}>
            <Badge>System prompt</Badge>
            <span className="text-muted">{entry.system.length.toLocaleString()} characters</span>
          </summary>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border p-3 font-sans text-sm">
            {entry.system}
          </pre>
        </details>
      ) : null}
      {entry.tools.length > 0 ? (
        <details className="rounded-[var(--radius-input)] border border-border bg-bg">
          <summary className={summaryClass}>
            <Badge tone="warning">Tools</Badge>
            <span className="text-muted">
              {entry.tools.length} offered
              {mcp.size > 0
                ? ` · MCP: ${[...mcp.keys()].map((k) => k || 'unnamed').join(', ')}`
                : ''}
            </span>
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            {[...mcp.entries()].map(([server, tools]) => (
              <ToolGroup
                key={`mcp:${server}`}
                title={`MCP server “${server || 'unnamed'}”`}
                tools={tools}
              />
            ))}
            {other.length > 0 ? <ToolGroup title="Built-in tools" tools={other} /> : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ToolGroup({ title, tools }: { title: string; tools: TraceTool[] }) {
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-muted">
        {title} ({tools.length})
      </h4>
      <ul className="space-y-1">
        {tools.map((t, i) => (
          <li key={`${t.name}:${String(i)}`}>
            <details>
              <summary className="cursor-pointer py-1 text-sm">
                <span className="font-mono">{t.name}</span>
                {t.description ? (
                  <span className="text-muted">
                    {' '}
                    · {t.description.split('\n')[0]?.slice(0, 120)}
                  </span>
                ) : null}
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-input)] bg-surface p-2 font-mono text-xs">
                {[t.description, t.schema ? `Input:\n${t.schema}` : '']
                  .filter(Boolean)
                  .join('\n\n') || '(no description)'}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
