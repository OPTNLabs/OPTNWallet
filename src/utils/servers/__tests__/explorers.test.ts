/**
 * #75 row 15, from the renderer's side.
 *
 * The Rust core has its own tests for the rule. These assert the thing the row
 * is actually about: that the surface a holder touches obeys it. The renderer
 * used to build these URLs itself with no notion of the connection policy, so
 * "own infrastructure only" stopped at the chain layer and an explorer link
 * walked past it. A test that only exercised Rust would have stayed green
 * through exactly that bug.
 */

import { describe, expect, it } from 'vitest';
import {
  buildAddressUrl,
  buildTxUrl,
  DEFAULT_EXPLORER_ID,
  explorerPolicyFor,
  getExplorerPreset,
  getExplorerPresets,
} from '../explorers';
import { Network } from '../../../state/slices/networkSlice';
import {
  ensureOptnCore,
  explorerDefaultPresetId,
} from '../../../wasm/optn-core';

const TXID = 'f'.repeat(64);
const OWN = {
  kind: 'custom' as const,
  tx: 'https://explorer.lan/tx/{txid}',
  address: 'https://explorer.lan/address/{address}',
};

describe('explorer links follow the chain policy', () => {
  it('opens a public explorer under a public policy', () => {
    expect(
      buildTxUrl({ kind: 'preset', id: 'bchexplorer' }, Network.MAINNET, TXID, 'auto')
    ).toBe(`https://bchexplorer.cash/tx/${TXID}`);
  });

  it('refuses every public explorer under own-infrastructure-only', () => {
    // Not one preset is exempt, including the default a holder never chose.
    for (const preset of getExplorerPresets()) {
      expect(
        buildTxUrl(
          { kind: 'preset', id: preset.id },
          Network.MAINNET,
          TXID,
          'own_infrastructure'
        ),
        `${preset.id} leaked`
      ).toBeNull();
    }
  });

  it('refuses public explorers under the privacy policy too', () => {
    // Privacy exists so addresses are never handed to an indexed server. An
    // explorer lookup hands over the same address.
    expect(
      buildAddressUrl(
        { kind: 'preset', id: DEFAULT_EXPLORER_ID },
        Network.MAINNET,
        'bitcoincash:qqexample',
        'privacy'
      )
    ).toBeNull();
  });

  it('still opens the holder’s own explorer under those policies', () => {
    // Fail-closed must not mean "no explorer ever" for the people it is for.
    for (const policy of ['own_infrastructure', 'privacy']) {
      expect(buildTxUrl(OWN, Network.MAINNET, TXID, policy)).toBe(
        `https://explorer.lan/tx/${TXID}`
      );
    }
  });

  it('treats a policy it does not recognise as private', () => {
    expect(explorerPolicyFor('a_policy_from_a_newer_build')).toBe(
      'user-owned-only'
    );
    expect(
      buildTxUrl(
        { kind: 'preset', id: DEFAULT_EXPLORER_ID },
        Network.MAINNET,
        TXID,
        'a_policy_from_a_newer_build'
      )
    ).toBeNull();
  });

  it('never sends a chipnet txid to a mainnet explorer', () => {
    for (const preset of getExplorerPresets()) {
      const url = buildTxUrl(
        { kind: 'preset', id: preset.id },
        Network.CHIPNET,
        TXID,
        'auto'
      );
      expect(url, `${preset.id} on chipnet`).toContain('chipnet');
    }
  });

  it('will not put a crafted txid into the URL', () => {
    for (const hostile of ['../../evil', `${TXID}?next=https://evil`, '']) {
      expect(
        buildTxUrl(OWN, Network.MAINNET, hostile, 'own_infrastructure'),
        hostile
      ).toBeNull();
    }
  });
});

describe('the preset list comes from the core', () => {
  it('pins the default id to the core’s', () => {
    // DEFAULT_EXPLORER_ID is a literal here because preferencesSlice needs it
    // while building its initial state. This is what stops the two drifting.
    ensureOptnCore();
    expect(DEFAULT_EXPLORER_ID).toBe(explorerDefaultPresetId());
  });

  it('resolves an unknown id to a real preset rather than throwing', () => {
    expect(getExplorerPreset('no-such-explorer').id).toBe(
      getExplorerPresets()[0].id
    );
  });

  it('offers the explorers the settings picker has always offered', () => {
    expect(getExplorerPresets().map((preset) => preset.id)).toEqual([
      'bchexplorer',
      'bch-ninja',
      'imaginary',
      'blockchair',
      '3xpl',
      'tokenexplorer',
    ]);
  });
});
