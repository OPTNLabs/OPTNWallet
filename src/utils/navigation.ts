import type { Location } from 'react-router-dom';

type NavigationState = {
  returnTo?: string;
};

function safeInternalRoute(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const route = value.trim();
  if (!route.startsWith('/') || route.startsWith('//')) return null;
  // Browsers and routers can normalize backslashes into path separators.
  // Reject literal and percent-encoded forms before handing the value to
  // React Router so a query-string return path can never become an origin.
  if (route.includes('\\') || /%5c/i.test(route)) return null;
  const first = route.charCodeAt(0);
  if (first <= 0x1f || first === 0x7f) return null;
  return route;
}

export function getReturnPath(
  location: Pick<Location, 'state' | 'search'> | null | undefined,
  fallback: string
): string {
  const state = (location?.state as NavigationState | null | undefined) ?? null;
  const fromState = safeInternalRoute(state?.returnTo);
  if (fromState) return fromState;

  const search = location?.search ?? '';
  if (search) {
    try {
      const params = new URLSearchParams(search);
      const fromSearch = safeInternalRoute(params.get('returnTo'));
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
