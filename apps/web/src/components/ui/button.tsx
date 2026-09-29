import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

const button = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-input)] px-4 text-sm font-medium ' +
    'transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50 ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
        secondary:
          'border border-border bg-surface text-text hover:bg-surface-2 active:bg-surface-2/70',
        ghost: 'text-text hover:bg-surface-2 active:bg-surface-2/70',
        danger: 'bg-danger text-danger-fg hover:brightness-110 active:brightness-95',
      },
      size: {
        md: '',
        lg: 'min-h-12 px-5 text-base',
        icon: 'size-11 px-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(button({ variant, size }), className)}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      {...(asChild ? {} : { type })}
      {...props}
    >
      {loading ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
      {children}
    </Comp>
  );
}
