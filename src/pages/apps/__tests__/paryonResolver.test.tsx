import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import { renderDeclarativeScreen } from '../marketplaceScreenResolver';
import ParyonWorkspaceApp from '../paryon/ParyonWorkspaceApp';

describe('Paryon workspace resolver', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const manifest: AddonManifest = {
    id: 'test.addon',
    name: 'Test Addon',
    version: '1.0.0',
    permissions: [{ kind: 'none' }],
    contracts: [],
  };

  const app: AddonAppDefinition = {
    id: 'paryonWorkspaceApp',
    name: 'ParyonUSD',
    kind: 'declarative',
  };

  const sdk = {
    wallet: { getContext: () => ({ walletId: 1, network: 'mainnet' }) },
    utxos: {
      listForWallet: vi.fn().mockResolvedValue({
        allUtxos: [],
        tokenUtxos: [],
      }),
    },
  } as unknown as AddonSDK;

  it('returns the Paryon workspace screen', () => {
    const rendered = renderDeclarativeScreen({
      screenId: 'ParyonWorkspaceApp',
      resolved: { manifest, app },
      sdk,
      loadWalletAddresses: vi.fn().mockResolvedValue(new Set()),
    });

    expect(isValidElement(rendered)).toBe(true);
    if (isValidElement(rendered)) {
      expect(rendered.type).toBe(ParyonWorkspaceApp);
    }
  });

  it('renders the stablecoin dashboard in mobile-first section order', () => {
    const rendered = renderToStaticMarkup(
      <ParyonWorkspaceApp sdk={sdk} app={app} />
    );

    expect(rendered).toContain('data-section="overview"');
    expect(rendered).toContain('data-section="balances"');
    expect(rendered).toContain('data-section="actions"');
    expect(rendered).toContain('data-section="deployment"');
    expect(rendered).toContain('data-section="system-map"');
    expect(rendered).toContain('data-section="resources"');
    expect(rendered).toContain('data-section="debug"');
    expect(rendered).not.toContain('href=');
    expect(rendered).not.toContain('target="_blank"');

    expect(rendered.indexOf('data-section="overview"')).toBeLessThan(
      rendered.indexOf('data-section="balances"')
    );
    expect(rendered.indexOf('data-section="balances"')).toBeLessThan(
      rendered.indexOf('data-section="actions"')
    );
    expect(rendered.indexOf('data-section="actions"')).toBeLessThan(
      rendered.indexOf('data-section="deployment"')
    );
    expect(rendered.indexOf('data-section="deployment"')).toBeLessThan(
      rendered.indexOf('data-section="resources"')
    );
    expect(rendered.indexOf('data-section="resources"')).toBeLessThan(
      rendered.indexOf('data-section="system-map"')
    );
    expect(rendered.indexOf('data-section="system-map"')).toBeLessThan(
      rendered.indexOf('data-section="debug"')
    );

    expect(rendered).toContain('Verified live mainnet-v1');
    expect(rendered).toContain('Loan');
    expect(rendered).toContain('Stability Pool');
    expect(rendered).toContain('Redemption');
    expect(rendered).toContain('Operator');
    expect(rendered).toContain('Open Loan');
    expect(rendered).toContain('Open Pool');
    expect(rendered).toContain('Open Redemption');
    expect(rendered).toContain('26 contracts bundled');
  });

  it('fails closed on chipnet and points the user back to deployment setup', () => {
    const chipnetSdk = {
      wallet: { getContext: () => ({ walletId: 1, network: 'chipnet' }) },
      utxos: {
        listForWallet: vi.fn().mockResolvedValue({
          allUtxos: [],
          tokenUtxos: [],
        }),
      },
    } as unknown as AddonSDK;

    const rendered = renderToStaticMarkup(
      <ParyonWorkspaceApp sdk={chipnetSdk} app={app} />
    );

    expect(rendered).toContain('Deployment config missing');
    expect(rendered).toContain('Set deployment config');
    expect(rendered).toContain('View deployment details');
    expect(rendered).toContain('Fill the missing deployment values to unlock live contract verification.');
  });
});
