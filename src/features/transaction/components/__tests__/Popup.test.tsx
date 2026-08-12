import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

import Popup from '../Popup';

describe('Popup', () => {
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

  it('keeps modal content scrollable inside the popup shell', () => {
    const html = renderToStaticMarkup(
      <Popup closePopups={() => undefined}>
        <div>Modal content</div>
      </Popup>
    );

    expect(html).toContain('wallet-popup-panel');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('overscroll-contain');
    expect(html).toContain('touch-pan-y');
  });
});
