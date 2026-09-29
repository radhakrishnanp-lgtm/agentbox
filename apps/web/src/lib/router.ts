import { useSyncExternalStore } from 'react';

/** Minimal History-API router: a handful of screens doesn't need a routing library. */
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

window.addEventListener('popstate', notify);

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  notify();
  window.scrollTo(0, 0);
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => window.location.pathname,
  );
}
