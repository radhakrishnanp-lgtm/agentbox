import { Copy, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from './ui/button.tsx';

/** Shows freshly issued recovery codes once, with copy and download. */
export function RecoveryCodes({ codes, origin }: { codes: string[]; origin: string }) {
  const [copied, setCopied] = useState(false);
  const text = [
    'agentbox recovery codes',
    origin,
    `Created ${new Date().toISOString()}`,
    '',
    'Each code works once, together with a code from your authenticator app.',
    'Keep them somewhere safe and offline, like a password manager or on paper.',
    '',
    ...codes,
    '',
  ].join('\n');

  return (
    <div className="space-y-3">
      <ol
        aria-label="Recovery codes"
        className="grid grid-cols-1 gap-2 rounded-[var(--radius-input)] border border-border bg-bg p-4 font-mono text-sm min-[380px]:grid-cols-2"
      >
        {codes.map((c) => (
          <li key={c} className="tracking-wider select-all">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true);
                toast.success('Recovery codes copied');
              })
              .catch(() => toast.error("Couldn't copy. Select the codes and copy them by hand."));
          }}
        >
          <Copy className="size-4" aria-hidden />
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'agentbox-recovery-codes.txt';
            a.click();
            setTimeout(() => {
              URL.revokeObjectURL(url);
            }, 1000);
          }}
        >
          <Download className="size-4" aria-hidden />
          Download
        </Button>
      </div>
    </div>
  );
}
