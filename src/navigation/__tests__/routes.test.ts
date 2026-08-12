import { describe, expect, it } from 'vitest';
import {
  ROUTE_ALIAS_MAP,
  ROUTE_PATHS,
  homeRoute,
  transactionsRoute,
} from '../routes';

describe('route inventory', () => {
  it('keeps the canonical wallet routes and explicit redirects in one place', () => {
    expect(ROUTE_PATHS.home).toBe('/home/:wallet_id');
    expect(ROUTE_PATHS.transactions).toBe('/transactions/:wallet_id');
    expect(ROUTE_ALIAS_MAP).toEqual([
      {
        path: '/',
        kind: 'entrypoint',
        target: 'Wallet availability gate',
      },
      {
        path: '/history/:wallet_id',
        kind: 'redirect',
        target: '/transactions/:wallet_id',
      },
      {
        path: '/apps/fundme',
        kind: 'redirect',
        target: '/apps/optn.builtin.fundme:fundmeApp',
      },
    ]);
  });

  it('builds canonical wallet-scoped paths from the shared helpers', () => {
    expect(homeRoute(42)).toBe('/home/42');
    expect(transactionsRoute(42)).toBe('/transactions/42');
  });
});

