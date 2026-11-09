import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  type LinkProps = {
    to: string;
    children?: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>;
  return {
    ...actual,
    Link: ({ to, children, ...props }: LinkProps) => (
      <a href={typeof to === 'string' ? to : '#'} {...props}>
        {children}
      </a>
    ),
  };
});

import PendingOutboundPanel from '../PendingOutboundPanel';
import { I18nContext } from '../../../../i18n/I18nContext';
import { translations } from '../../../../i18n/resources';

describe('PendingOutboundPanel', () => {
  const originalDocument = globalThis.document;

  beforeAll(() => {
    (globalThis as typeof globalThis & { document?: Document }).document = {
      body: {} as HTMLBodyElement,
    } as unknown as Document;
  });

  afterAll(() => {
    if (originalDocument) {
      (globalThis as typeof globalThis & { document?: Document }).document =
        originalDocument;
    } else {
      delete (globalThis as typeof globalThis & { document?: Document })
        .document;
    }
  });

  it('renders as a portal-backed modal overlay', () => {
    const html = renderToStaticMarkup(
      <I18nContext.Provider
        value={{
          locale: 'en',
          setLocale: () => undefined,
          t: (key) => translations.en[key],
        }}
      >
        <PendingOutboundPanel
          records={[
            {
              txid: 'a'.repeat(64),
              rawTx: '',
              walletId: 1,
              source: 'test',
              state: 'submitted',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              spentOutpoints: [],
            },
          ]}
          onClose={() => undefined}
        />
      </I18nContext.Provider>
    );

    expect(html).toContain('wallet-popup-backdrop');
    expect(html).toContain('wallet-popup-panel');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Finalizing transaction');
    expect(html).toContain(
      'Your wallet history will update automatically. This usually takes a moment.'
    );
    expect(html).toContain('Dismiss');
    expect(html).toContain('sm:flex-row');
    expect(html).toContain('min-w-0 flex-1');
  });

  it('can render as a non-blocking status surface', () => {
    const html = renderToStaticMarkup(
      <I18nContext.Provider
        value={{
          locale: 'en',
          setLocale: () => undefined,
          t: (key) => translations.en[key],
        }}
      >
        <PendingOutboundPanel
          records={[
            {
              txid: 'b'.repeat(64),
              rawTx: '',
              walletId: 1,
              source: 'test',
              state: 'broadcasted',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              spentOutpoints: [],
            },
          ]}
          blocking={false}
        />
      </I18nContext.Provider>
    );

    expect(html).toContain('wallet-popup-backdrop--non-blocking');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('aria-modal="true"');
  });

  it('surfaces the Fusion verification lock and keeps recovery actions touch-sized', () => {
    const html = renderToStaticMarkup(
      <I18nContext.Provider
        value={{
          locale: 'en',
          setLocale: () => undefined,
          t: (key) => translations.en[key],
        }}
      >
        <PendingOutboundPanel
          records={[
            {
              txid: 'c'.repeat(64),
              rawTx: '',
              walletId: 1,
              source: 'cashfusion',
              privacyRoute: 'tor-only',
              state: 'submitted',
              verificationPending: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              spentOutpoints: [],
            },
          ]}
          onClose={() => undefined}
          onRefresh={() => undefined}
          onRelease={() => undefined}
        />
      </I18nContext.Provider>
    );

    expect(html).toContain('Awaiting verification');
    expect(html).toContain(
      'Wallet sync must confirm this Fusion transaction before its inputs can be reused.'
    );
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('Release send lock');
  });

  it('explains release and clear-lock actions beside the action button', () => {
    const staleHtml = renderToStaticMarkup(
      <I18nContext.Provider
        value={{
          locale: 'en',
          setLocale: () => undefined,
          t: (key) => translations.en[key],
        }}
      >
        <PendingOutboundPanel
          records={[
            {
              txid: 'd'.repeat(64),
              rawTx: '',
              walletId: 1,
              source: 'test',
              state: 'broadcasting',
              createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
              updatedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
              spentOutpoints: [],
            },
          ]}
          onRelease={() => undefined}
        />
      </I18nContext.Provider>
    );

    expect(staleHtml).toContain('Release send lock');
    expect(staleHtml).toContain('pending-outbound-release-');

    const submittedHtml = renderToStaticMarkup(
      <I18nContext.Provider
        value={{
          locale: 'en',
          setLocale: () => undefined,
          t: (key) => translations.en[key],
        }}
      >
        <PendingOutboundPanel
          records={[
            {
              txid: 'e'.repeat(64),
              rawTx: '',
              walletId: 1,
              source: 'test',
              state: 'submitted',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              spentOutpoints: [],
            },
          ]}
          onRelease={() => undefined}
        />
      </I18nContext.Provider>
    );

    expect(submittedHtml).toContain('Clear pending lock');
    expect(submittedHtml).toContain('pending-outbound-clear-');
  });
});
