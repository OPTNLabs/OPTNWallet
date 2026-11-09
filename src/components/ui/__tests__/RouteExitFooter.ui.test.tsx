import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RouteExitFooter from '../RouteExitFooter';

describe('RouteExitFooter', () => {
  it('renders a full-width red route exit with an explicit callback', () => {
    const onBack = vi.fn();
    const markup = renderToStaticMarkup(
      <RouteExitFooter label="Back" onBack={onBack} />
    );

    expect(markup).toContain('data-testid="route-exit-back"');
    expect(markup).toContain('wallet-btn-danger w-full');
    expect(markup).toContain('Back');
  });
});
