import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
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

  it('renders the mobile-first tabbed surface in section order', () => {
    const rendered = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/apps/optn.builtin.demo:paryonWorkspaceApp']}>
        <ParyonWorkspaceApp sdk={sdk} app={app} />
      </MemoryRouter>
    );

    expect(rendered).toContain('data-section="overview"');
    expect(rendered).toContain('data-section="balances"');
    expect(rendered).toContain('data-section="actions"');
    expect(rendered).toContain('data-section="protocol-details"');
    expect(rendered).not.toContain('href=');
    expect(rendered).not.toContain('target="_blank"');

    expect(rendered.indexOf('data-section="overview"')).toBeLessThan(
      rendered.indexOf('data-section="balances"')
    );
    expect(rendered.indexOf('data-section="balances"')).toBeLessThan(
      rendered.indexOf('data-section="actions"')
    );
    expect(rendered.indexOf('data-section="actions"')).toBeLessThan(
      rendered.indexOf('data-section="protocol-details"')
    );

    expect(rendered).toContain('Borrow, stake, redeem, or review positions');
    expect(rendered).toContain('Primary actions');
    expect(rendered).toContain('Safety rails');
    expect(rendered).toContain('Borrow');
    expect(rendered).toContain('Stake');
    expect(rendered).toContain('Redeem');
    expect(rendered).toContain('Positions');
    expect(rendered).toContain('Protocol details');
    expect(rendered).toContain('Live bundle');
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
      <MemoryRouter initialEntries={['/apps/optn.builtin.demo:paryonWorkspaceApp']}>
        <ParyonWorkspaceApp sdk={chipnetSdk} app={app} />
      </MemoryRouter>
    );

    expect(rendered).toContain('Deployment config is missing');
    expect(rendered).toContain('Primary actions');
  });
});
