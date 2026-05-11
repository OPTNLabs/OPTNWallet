import { describe, expect, it } from 'vitest';
import { isComingSoonApp } from '../apps/appsViewHelpers';

describe('AppsView coming-soon selection rules', () => {
  it('marks FundMe addon cards as coming soon', () => {
    expect(isComingSoonApp('optn.builtin.fundme:fundmeApp', 'FundMe')).toBe(
      true
    );
  });

  it('marks ParyonUSD addon cards as coming soon', () => {
    expect(
      isComingSoonApp(
        'optn.builtin.demo:paryonWorkspaceApp',
        'ParyonUSD'
      )
    ).toBe(true);
  });

  it('does not mark active apps as coming soon', () => {
    expect(
      isComingSoonApp('optn.builtin.cauldron:cauldronSwapApp', 'Cauldron')
    ).toBe(false);
  });
});
