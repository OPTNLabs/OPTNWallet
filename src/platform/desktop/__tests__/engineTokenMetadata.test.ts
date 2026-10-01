import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handle: vi.fn(),
  desktop: vi.fn(() => true),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../walletFile', () => ({
  findWalletFileRelForSourceId: mocks.handle,
}));
vi.mock('../../../utils/platform', () => ({
  isDesktopPlatform: mocks.desktop,
}));

import {
  projectEngineTokenMetadata,
  readEngineTokenMetadata,
} from '../engineWalletBridge';
import type { EngineTokenIdentity } from '../engineWalletBridge';
import { resolveTokenPresentation } from '../../../utils/tokenPresentation';

const category = 'ab'.repeat(32);
const identity: EngineTokenIdentity = {
  name: 'Authenticated token',
  ticker: 'AUTH',
  decimals: 2,
  status: 'verified',
  presentation: {
    description: 'Description from committed bytes',
    uris: {
      icon: 'https://example.test/token.png',
      web: 'https://example.test/',
    },
    nfts: { parse: { types: { '01': { name: 'First NFT' } } } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop.mockReturnValue(true);
  mocks.handle.mockResolvedValue('wallets/test.optn');
});

describe('authenticated desktop metadata adapter', () => {
  it('reads the matching wallet/network/epoch and passes through the bounded Rust schema', async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        version: 1,
        wallet: {},
        network: 'chipnet',
        unlock_epoch: 7,
        token_identities: { [category]: identity },
      })
      .mockResolvedValueOnce({ active: 'test.optn', epoch: 7 });
    const metadata = (await readEngineTokenMetadata(1, 'chipnet', [category]))![
      category
    ];
    expect(metadata).toMatchObject({
      identityStatus: 'verified',
      name: identity.name,
      iconUri: null,
    });
    expect(resolveTokenPresentation(category, metadata).statusLabel).toBe(
      'Verified'
    );
    expect(metadata.snapshot).toMatchObject({
      description: identity.presentation!.description,
      uris: identity.presentation!.uris,
      token: { category, nfts: identity.presentation!.nfts },
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ['optn_app_snapshot'],
      ['optn_wallet_security', { request: { command: 'status' } }],
    ]);
  });

  it.each([
    { network: 'mainnet' },
    { wallet: null },
    { version: 2 },
    { unlock_epoch: 8 },
  ])('refuses a mismatched snapshot: %j', async (override) => {
    mocks.invoke
      .mockResolvedValueOnce({
        version: 1,
        wallet: {},
        network: 'chipnet',
        unlock_epoch: 7,
        token_identities: { [category]: identity },
        ...override,
      })
      .mockResolvedValueOnce({ active: 'test.optn', epoch: 7 });
    expect(await readEngineTokenMetadata(1, 'chipnet', [category])).toBeNull();
  });

  it.each([null, 'other.optn'])(
    'refuses a locked or different runtime wallet: %s',
    async (active) => {
      mocks.invoke
        .mockResolvedValueOnce({
          version: 1,
          wallet: {},
          network: 'chipnet',
          unlock_epoch: 7,
          token_identities: { [category]: identity },
        })
        .mockResolvedValueOnce({ active, epoch: 7 });
      expect(
        await readEngineTokenMetadata(1, 'chipnet', [category])
      ).toBeNull();
    }
  );

  it('fails closed on unavailable IPC or a wallet without a file mapping', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('offline host'));
    expect(await readEngineTokenMetadata(1, 'chipnet', [category])).toBeNull();
    mocks.handle.mockResolvedValueOnce(null);
    expect(await readEngineTokenMetadata(2, 'chipnet', [category])).toBeNull();
    mocks.desktop.mockReturnValue(false);
    expect(await readEngineTokenMetadata(1, 'chipnet', [category])).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['stale', 'unpublished', 'unresolved', 'future-status'])(
    'keeps %s distinct without trusting legacy metadata or images',
    (status) => {
      const metadata = projectEngineTokenMetadata(category, {
        ...identity,
        status,
      });
      const presentation = resolveTokenPresentation(category, metadata, {
        name: 'Legacy provider name',
        symbol: 'OLD',
        decimals: 9,
        iconUri: 'https://legacy.test/image',
      });
      expect(presentation.iconUri).toBeNull();
      expect(presentation.hasFallback).toBe(false);
      if (status === 'stale') {
        expect(presentation.primaryLabel).toBe(identity.name);
        expect(presentation.statusLabel).toBe('Last known');
        expect(metadata.snapshot?.description).toBe(
          identity.presentation!.description
        );
      } else {
        expect(metadata.snapshot).toBeNull();
        expect(presentation.primaryLabel).not.toBe(identity.name);
        expect(presentation.primaryLabel).not.toBe('Legacy provider name');
        expect(presentation.decimals).toBe(0);
        expect(presentation.statusLabel).toBe(
          status === 'unpublished' ? 'No registry published' : 'Unverified'
        );
      }
    }
  );
});
