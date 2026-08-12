import { describe, expect, it } from 'vitest';
import { getBuiltinAddons } from '../../../addons/builtin';

describe('builtin addon visibility', () => {
  it('keeps dev-only apps visible in browser dev builds', async () => {
    const addons = getBuiltinAddons(true);
    const demo = addons.find((addon) => addon.id === 'optn.builtin.demo');
    const fundme = addons.find((addon) => addon.id === 'optn.builtin.fundme');
    const paryonApp = demo?.apps?.find((app) => app.id === 'paryonWorkspaceApp');
    const demoCaps = demo?.permissions.find(
      (perm) => perm.kind === 'capabilities'
    );

    expect(demo?.apps?.some((app) => app.id === 'paryonWorkspaceApp')).toBe(true);
    expect(demo?.contracts?.some((contract) => contract.id === 'paryon-contract-bundle')).toBe(
      true
    );
    expect(fundme?.apps?.some((app) => app.id === 'fundmeApp')).toBe(true);
    expect(paryonApp?.requiredCapabilities).toEqual(
      expect.arrayContaining(['utxo:address:read'])
    );
    expect(
      demoCaps?.kind === 'capabilities' ? demoCaps.capabilities : []
    ).toEqual(expect.arrayContaining(['utxo:address:read']));
  });

  it('hides dev-only apps from packaged builds', async () => {
    const addons = getBuiltinAddons(false);
    const demo = addons.find((addon) => addon.id === 'optn.builtin.demo');
    const fundme = addons.find((addon) => addon.id === 'optn.builtin.fundme');

    expect(
      demo?.apps?.some((app) => app.id === 'paryonWorkspaceApp')
    ).toBe(false);
    expect(
      demo?.contracts?.some((contract) => contract.id === 'paryon-contract-bundle')
    ).toBe(false);
    expect(fundme).toBeUndefined();
  });
});
