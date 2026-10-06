import '@xterm/xterm/css/xterm.css';
import type { TerminalServerMessage } from '@agentbox/shared';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { ArrowLeft, Keyboard, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { IdleWarning } from '../components/IdleWarning.tsx';
import { Link } from '../components/Layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../lib/cn.ts';
import { useAuth } from '../state/auth.tsx';

/** Close codes sent by the server (see apps/server/src/terminals/ws.ts). */
const CLOSE_TEXT: Record<number, string> = {
  1000: 'The session ended.',
  4401: 'Your sign-in ended.',
  4403: 'Not allowed.',
  4404: 'There is no session with this name any more.',
  4409: 'The vault is locked.',
  4429: 'Too much input at once.',
  4503: "The terminal service isn't running.",
};

/**
 * Confirm drawn output in small steps, so the server never lets much more than
 * the browser can draw queue up ahead of what you type.
 */
const ACK_EVERY = 8 * 1024;

type Status = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; message: string };

export function TerminalView({ name }: { name: string }) {
  const { refresh } = useAuth();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const mods = useRef({ ctrl: false, alt: false });
  useEffect(() => {
    mods.current = { ctrl, alt };
  }, [ctrl, alt]);

  const send = useCallback((data: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  }, []);

  /** Typed text, with the on-screen Ctrl / Alt applied once and then released. */
  const sendTyped = useCallback(
    (data: string) => {
      let out = data;
      if (mods.current.ctrl && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) out = String.fromCharCode(code - 64);
        setCtrl(false);
      }
      if (mods.current.alt) {
        out = `\x1b${out}`;
        setAlt(false);
      }
      send(out);
    },
    [send],
  );

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: window.matchMedia('(max-width: 640px)').matches ? 13 : 14,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: { background: '#0b0f14', foreground: '#e6edf3', cursor: '#2dd4bf' },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.loadAddon(
      new WebLinksAddon((_e, uri) => {
        // Sign-in links from CLIs open in a new tab, without giving it this page.
        window.open(uri, '_blank', 'noopener,noreferrer');
      }),
    );
    t.open(el);
    // Draw with the GPU: busy screens (grok, claude, codex) keep up far better than
    // with the default renderer. Without WebGL, or if it is lost, fall back.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        gl.dispose();
      });
      t.loadAddon(gl);
    } catch {
      // The default renderer still works.
    }
    fit.fit();
    t.focus();
    term.current = t;

    const url = new URL(`/ws/terminal/${encodeURIComponent(name)}`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('cols', String(t.cols));
    url.searchParams.set('rows', String(t.rows));
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    let pendingAck = 0;
    let serverReason = '';

    const sendSize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'resize', cols: t.cols, rows: t.rows }));
      }
    };
    ws.onmessage = (ev: MessageEvent<ArrayBuffer | string>) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as TerminalServerMessage;
        if (msg.t === 'ready') {
          setStatus({ kind: 'open' });
          sendSize();
        } else serverReason = msg.reason;
        return;
      }
      const bytes = new Uint8Array(ev.data);
      t.write(bytes, () => {
        pendingAck += bytes.length;
        if (pendingAck >= ACK_EVERY && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'ack', bytes: pendingAck }));
          pendingAck = 0;
        }
      });
    };
    ws.onclose = (ev) => {
      const message = CLOSE_TEXT[ev.code] ?? (serverReason || 'The connection was lost.');
      setStatus({ kind: 'closed', message });
      if (ev.code === 4401) void refresh();
    };
    // Flush small acks often so a quiet session never looks stuck.
    const ackTimer = setInterval(() => {
      if (pendingAck > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'ack', bytes: pendingAck }));
        pendingAck = 0;
      }
    }, 100);

    const onData = t.onData(sendTyped);
    const onBinary = t.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0)));
      }
    });

    // Fit to the space left above the phone keyboard, and tell the server.
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const vv = window.visualViewport;
        const root = el.closest<HTMLElement>('[data-terminal-root]');
        if (vv && root) root.style.height = `${vv.height}px`;
        fit.fit();
        sendSize();
      });
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    window.visualViewport?.addEventListener('resize', refit);

    return () => {
      clearInterval(ackTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.visualViewport?.removeEventListener('resize', refit);
      onData.dispose();
      onBinary.dispose();
      ws.onclose = null;
      ws.close();
      t.dispose();
      term.current = null;
      socket.current = null;
    };
  }, [name, attempt, refresh, sendTyped]);

  const pressKey = (seq: string) => {
    send(seq);
    term.current?.focus();
  };
  const paste = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        term.current?.paste(text);
        term.current?.focus();
      })
      .catch(() =>
        toast.error("Couldn't read the clipboard. Long-press in the terminal to paste."),
      );
  };
  const toggleKeyboard = () => {
    const input = host.current?.querySelector('textarea');
    if (!input) return;
    if (document.activeElement === input) input.blur();
    else input.focus();
  };

  return (
    <div data-terminal-root className="fixed inset-x-0 top-0 flex h-dvh flex-col bg-[#0b0f14]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-bg px-2">
        <Button asChild variant="ghost" size="icon">
          <Link to="/terminals" aria-label="Back to terminals">
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-mono text-sm">{name}</h1>
        <span
          className={cn('text-xs', status.kind === 'open' ? 'text-success' : 'text-muted')}
          role="status"
        >
          {status.kind === 'open'
            ? 'Connected'
            : status.kind === 'connecting'
              ? 'Connecting…'
              : 'Disconnected'}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0 p-1" aria-label={`Terminal ${name}`} />
        {status.kind === 'closed' ? (
          <div className="absolute inset-x-0 bottom-4 mx-auto flex w-fit max-w-[90%] flex-wrap items-center justify-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3 text-sm shadow-xl">
            <span>{status.message}</span>
            <Button
              variant="secondary"
              onClick={() => {
                setStatus({ kind: 'connecting' });
                setAttempt((a) => a + 1);
              }}
            >
              <RotateCw className="size-4" aria-hidden />
              Reconnect
            </Button>
          </div>
        ) : null}
      </div>

      {/* Keys phones don't have. Tapping never steals focus from the terminal. */}
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-bg px-1 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:hidden"
        role="toolbar"
        aria-label="Extra keys"
        onPointerDown={(e) => {
          e.preventDefault();
        }}
      >
        <KeyButton
          label="Esc"
          onPress={() => {
            pressKey('\x1b');
          }}
        />
        <KeyButton
          label="Tab"
          onPress={() => {
            pressKey('\t');
          }}
        />
        <KeyButton
          label="⇧Tab"
          aria="Shift Tab"
          onPress={() => {
            pressKey('\x1b[Z');
          }}
        />
        <KeyButton
          label="Ctrl"
          active={ctrl}
          onPress={() => {
            setCtrl((v) => !v);
          }}
        />
        <KeyButton
          label="Alt"
          active={alt}
          onPress={() => {
            setAlt((v) => !v);
          }}
        />
        <KeyButton
          label="←"
          aria="Left"
          onPress={() => {
            pressKey('\x1b[D');
          }}
        />
        <KeyButton
          label="↑"
          aria="Up"
          onPress={() => {
            pressKey('\x1b[A');
          }}
        />
        <KeyButton
          label="↓"
          aria="Down"
          onPress={() => {
            pressKey('\x1b[B');
          }}
        />
        <KeyButton
          label="→"
          aria="Right"
          onPress={() => {
            pressKey('\x1b[C');
          }}
        />
        <KeyButton
          label="^C"
          aria="Control C"
          onPress={() => {
            pressKey('\x03');
          }}
        />
        <KeyButton label="Paste" onPress={paste} />
        <KeyButton
          label={<Keyboard className="size-4" aria-hidden />}
          aria="Show or hide the keyboard"
          onPress={toggleKeyboard}
        />
      </div>
      <IdleWarning />
    </div>
  );
}

function KeyButton({
  label,
  aria,
  active = false,
  onPress,
}: {
  label: React.ReactNode;
  aria?: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      aria-pressed={active || undefined}
      className={cn(
        'flex min-h-10 min-w-11 shrink-0 items-center justify-center rounded-md border border-border px-2 font-mono text-sm',
        active ? 'bg-accent text-accent-fg' : 'bg-surface text-text active:bg-surface-2',
      )}
      onClick={onPress}
    >
      {label}
    </button>
  );
}
