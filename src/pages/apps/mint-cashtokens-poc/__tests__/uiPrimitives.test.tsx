import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, CardShell } from '../components/uiPrimitives';

describe('CardShell', () => {
  it('stacks the header on narrow screens so subtitle text gets full width', () => {
    const html = renderToStaticMarkup(
      <CardShell
        title="Source UTXOs"
        subtitle="Pick a genesis UTXO to create a category, or a minting NFT authority to mint additional CashTokens."
        right={<Badge tone="green">Sources: 3</Badge>}
        open={true}
        collapsible={false}
        onToggle={() => undefined}
      >
        <div>Body</div>
      </CardShell>
    );

    expect(html).toContain('sm:flex-row');
    expect(html).toContain('min-w-0 flex-1');
    expect(html).toContain('leading-snug');
    expect(html).toContain('Source UTXOs');
    expect(html).toContain('Body');
  });
});
