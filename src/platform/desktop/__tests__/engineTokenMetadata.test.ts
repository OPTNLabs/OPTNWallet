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
    // The read itself is exactly these two calls; an image follows on its own.
    expect(mocks.invoke.mock.calls.slice(0, 2)).toEqual([
      ['optn_app_snapshot'],
      ['optn_wallet_security', { request: { command: 'status' } }],
    ]);
  });

  it('shows a host-fetched image once it arrives, and only an image', async () => {
    const pngCategory = 'cd'.repeat(32);
    const snapshot = {
      version: 1,
      wallet: {},
      network: 'chipnet',
      unlock_epoch: 7,
      token_identities: { [pngCategory]: identity },
    };
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'optn_app_snapshot') return snapshot;
      if (command === 'optn_wallet_security') return { active: 'test.optn', epoch: 7 };
      if (command === 'optn_token_image') return image;
      throw new Error(`unexpected ${command}`);
    });
    const first = (await readEngineTokenMetadata(1, 'chipnet', [pngCategory]))!;
    expect(first[pngCategory].name).toBe(identity.name);
    expect(first[pngCategory].iconUri).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith('optn_token_image', {
      category: pngCategory,
      uri: identity.presentation!.uris.icon,
    });
    await vi.waitFor(async () => {
      const next = (await readEngineTokenMetadata(1, 'chipnet', [pngCategory]))!;
      expect(resolveTokenPresentation(pngCategory, next[pngCategory]).iconUri).toBe(
        image
      );
    });
    // A runtime identity never shows a remote URI the webview would fetch.
    expect(
      resolveTokenPresentation(pngCategory, {
        ...first[pngCategory],
        iconUri: 'https://tracker.example/pixel.png',
      }).iconUri
    ).toBeNull();
    mocks.invoke.mockReset();
  });

  it('keeps names when the image port fails', async () => {
    const failingCategory = 'ef'.repeat(32);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'optn_app_snapshot')
        return {
          version: 1,
          wallet: {},
          network: 'chipnet',
          unlock_epoch: 7,
          token_identities: { [failingCategory]: identity },
        };
      if (command === 'optn_wallet_security') return { active: 'test.optn', epoch: 7 };
      throw new Error('image transport unavailable');
    });
    const metadata = (await readEngineTokenMetadata(1, 'chipnet', [
      failingCategory,
    ]))!;
    expect(metadata[failingCategory].name).toBe(identity.name);
    expect(metadata[failingCategory].iconUri).toBeNull();
    mocks.invoke.mockReset();
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

  it.each([
    [{}, 'Verified'],
    [{ assurance: 'node-validated' }, 'Verified'],
    [{ assurance: 'server-reported' }, 'Verified via server'],
    [{ assurance: 'notarised-by-someone' }, 'Verified'],
    [{ assurance: 'server-reported', burned: true }, 'Verified via server · final'],
    [{ burned: true }, 'Verified · final'],
  ])(
    'says who vouched for a verified identity: %j',
    (fields, label) => {
      const metadata = projectEngineTokenMetadata(category, {
        ...identity,
        ...fields,
      });
      const presentation = resolveTokenPresentation(category, metadata);
      expect(presentation.statusLabel).toBe(label);
      expect(presentation.statusTone).toBe('accent');
      expect(metadata.identityAssurance).toBe(
        fields.assurance === 'node-validated' ||
          fields.assurance === 'server-reported'
          ? fields.assurance
          : undefined
      );
    }
  );

  it('never lets assurance or finality decorate a name that is not current', () => {
    for (const status of ['unpublished', 'unresolved', 'future-status']) {
      const metadata = projectEngineTokenMetadata(category, {
        ...identity,
        status,
        assurance: 'node-validated',
        burned: true,
      });
      expect(metadata.identityAssurance).toBeUndefined();
      expect(metadata.identityFinal).toBe(false);
    }
    const stale = projectEngineTokenMetadata(category, {
      ...identity,
      status: 'stale',
      assurance: 'server-reported',
    });
    expect(resolveTokenPresentation(category, stale).statusLabel).toBe(
      'Last known'
    );
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
