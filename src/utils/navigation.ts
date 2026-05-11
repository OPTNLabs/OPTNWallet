import type { Location } from 'react-router-dom';

type NavigationState = {
  returnTo?: string;
};

export function getReturnPath(
  location: Pick<Location, 'state' | 'search'> | null | undefined,
  fallback: string
): string {
  const state = (location?.state as NavigationState | null | undefined) ?? null;
  const fromState = typeof state?.returnTo === 'string' ? state.returnTo.trim() : '';
  if (fromState) return fromState;

  const search = location?.search ?? '';
  if (search) {
    try {
      const params = new URLSearchParams(search);
      const fromSearch = params.get('returnTo')?.trim() ?? '';
      if (fromSearch) return fromSearch;
    } catch {
      // fall through to fallback
    }
  }

  return fallback;
}

export function withReturnTo<T extends { state?: unknown }>(
  target: string,
  returnTo?: string
): { pathname: string; search?: string; state?: T['state'] } {
  if (!returnTo) return { pathname: target };
  return { pathname: target, state: { returnTo } as T['state'] };
}
