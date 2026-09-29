export function BrandMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M9 11l5 5-5 5M16 21h7"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <BrandMark />
      agentbox
    </span>
  );
}
