import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PageHeader from '../PageHeader';

describe('PageHeader', () => {
  it('places the title and context around the centered logo', () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="Home" subtitle="Chipnet" compact />
    );

    expect(markup).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    expect(markup.indexOf('Home')).toBeLessThan(markup.indexOf('OPTN'));
    expect(markup.indexOf('OPTN')).toBeLessThan(markup.indexOf('Chipnet'));
  });
});
