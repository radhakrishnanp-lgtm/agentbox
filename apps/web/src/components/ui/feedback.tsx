import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const toneClass: Record<Tone, string> = {
  info: 'border-border bg-surface-2 text-text',
  success: 'border-success/40 bg-success/10 text-text',
  warning: 'border-warning/40 bg-warning/10 text-text',
  danger: 'border-danger/40 bg-danger/10 text-text',
};

const toneIcon: Record<Tone, ReactNode> = {
  info: <Info aria-hidden className="size-5 text-muted" />,
  success: <CircleCheck aria-hidden className="size-5 text-success" />,
  warning: <TriangleAlert aria-hidden className="size-5 text-warning" />,
  danger: <CircleAlert aria-hidden className="size-5 text-danger" />,
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex gap-3 rounded-[var(--radius-input)] border p-3 text-sm',
        toneClass[tone],
        className,
      )}
    >
      <div className="shrink-0">{toneIcon[tone]}</div>
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-muted">{children}</div> : null}
      </div>
    </div>
  );
}

export function Badge({
  tone = 'info',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  const tones: Record<Tone, string> = {
    info: 'bg-surface-2 text-muted',
    success: 'bg-success/15 text-success',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-danger/15 text-danger',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-surface-2', className)} />;
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-muted">{icon}</div>
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-sm text-sm text-muted">{children}</div> : null}
    </div>
  );
}
