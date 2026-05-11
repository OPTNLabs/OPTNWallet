import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import SegmentedSubnav from '../SegmentedSubnav';

describe('SegmentedSubnav', () => {
  it('renders all provided options and marks the active value', () => {
    const html = renderToStaticMarkup(
      <SegmentedSubnav
        value="basic"
        onChange={vi.fn()}
        options={[
          { value: 'basic', label: 'Basic' },
          { value: 'advanced', label: 'Advanced' },
        ]}
      />
    );

    expect(html).toContain('Basic');
    expect(html).toContain('Advanced');
    expect(html).toContain('wallet-segment-active');
  });
});
