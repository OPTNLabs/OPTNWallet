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
  const actual = await vi.importActual<typeof import('react-router-dom')>(
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
    );

    expect(html).toContain('wallet-popup-backdrop');
    expect(html).toContain('wallet-popup-panel');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Outgoing transaction still syncing');
    expect(html).toContain('Dismiss');
    expect(html).toContain('sm:flex-row');
    expect(html).toContain('min-w-0 flex-1');
  });
});
