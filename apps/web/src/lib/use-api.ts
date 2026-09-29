import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';

type Result<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiError };

/** GET a JSON resource; `reload` fetches it again after a change. */
export function useApi<T>(path: string): Result<T> & { reload: () => void } {
  const [result, setResult] = useState<Result<T>>({ status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api<T>(path)
      .then((data) => {
        if (live) setResult({ status: 'ready', data, error: null });
      })
      .catch((err: unknown) => {
        if (live) {
          setResult({
            status: 'error',
            data: null,
            error: err instanceof ApiError ? err : new ApiError(0, null),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  return { ...result, reload };
}
