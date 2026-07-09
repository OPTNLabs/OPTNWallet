import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import CauldronFlowTabs from '../CauldronFlowTabs';

describe('CauldronFlowTabs', () => {
  it('renders the swap and pool labels and forwards flow selection changes', () => {
    const onChange = vi.fn();
    const element = CauldronFlowTabs({
      activeMode: 'swap',
      onChange,
    });

    const html = renderToStaticMarkup(element);
    expect(html).toContain('Swap');
    expect(html).toContain('Pool');
    expect(html).toContain('aria-pressed="true"');

    const buttons = Children.toArray(element.props.children).filter(
      isValidElement
    );
    const poolButton = buttons.find(
      (button) => button.props.children === 'Pool'
    );

    if (!poolButton) {
      throw new Error('Expected all Cauldron flow buttons to render');
    }

    poolButton.props.onClick();

    expect(onChange).toHaveBeenNthCalledWith(1, 'pool');
  });
});
