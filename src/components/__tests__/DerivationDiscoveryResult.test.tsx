import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import DerivationDiscoveryResult from '../DerivationDiscoveryResult';
import type { DerivationDiscoveryState } from '../../hooks/useDerivationDiscovery';

const handlers = {
  onAdopt: vi.fn(),
  onCancel: vi.fn(),
  onRetry: vi.fn(),
};

function render(
  state: DerivationDiscoveryState,
  context: 'import' | 'settings' = 'import'
) {
  return renderToStaticMarkup(
    <DerivationDiscoveryResult
      state={state}
      currentPath="m/44'/145'/0'"
      defaultPath="m/44'/145'/0'"
      context={context}
      {...handlers}
    />
  );
}

describe('DerivationDiscoveryResult', () => {
  it('does not offer a chosen path as definitive when another path was unchecked', () => {
    const html = render({
      status: 'done',
      result: {
        chosen: "m/44'/0'/0'",
        ambiguous: false,
        incomplete: true,
        candidatesProbed: 3,
        candidatesTotal: 4,
        probed: [{ path: "m/44'/0'/0'", usedAddresses: 2, satoshis: 50_000n }],
      },
    });

    expect(html).toContain('Could not check 1 of 4 derivation paths');
    expect(html).not.toContain('Use m/44&#x27;/0&#x27;/0&#x27;');
  });

  it('lists every previously used path when an empty wallet is ambiguous', () => {
    const html = render({
      status: 'done',
      result: {
        chosen: "m/44'/145'/0'",
        ambiguous: true,
        incomplete: false,
        candidatesProbed: 4,
        candidatesTotal: 4,
        probed: [
          { path: "m/44'/145'/0'", usedAddresses: 4, satoshis: 0n },
          { path: "m/44'/0'/0'", usedAddresses: 2, satoshis: 0n },
        ],
      },
    });

    expect(html).toContain('more than one derivation path');
    expect(html).toContain('m/44&#x27;/145&#x27;/0&#x27;');
    expect(html).toContain('m/44&#x27;/0&#x27;/0&#x27;');
  });

  it('stays silent on import when the default path is already correct', () => {
    const html = render({
      status: 'done',
      result: {
        chosen: "m/44'/145'/0'",
        ambiguous: false,
        incomplete: false,
        candidatesProbed: 4,
        candidatesTotal: 4,
        probed: [
          { path: "m/44'/145'/0'", usedAddresses: 1, satoshis: 10_000n },
        ],
      },
    });

    expect(html).toBe('');
  });
});
