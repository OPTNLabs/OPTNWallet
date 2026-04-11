import { beforeEach, describe, expect, it, vi } from 'vitest';

import KeyManager from '../KeyManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';
import SecretCryptoService from '../../../services/SecretCryptoService';
import {
  deriveBchChild,
  deriveBchStandardXpubs,
} from '../../../services/HdWalletService';
import { Network } from '../../../redux/networkSlice';

vi.mock('../../DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../AddressManager/AddressManager', () => ({
  default: vi.fn(() => ({
    registerAddress: vi.fn(async () => {}),
  })),
}));

vi.mock('../../../services/SecretCryptoService', () => ({
  default: {
    decryptText: vi.fn(),
    decryptBytes: vi.fn(),
    encryptBytes: vi.fn(),
  },
  isEncryptedPayload: vi.fn(() => false),
}));

vi.mock('../../../services/HdWalletService', () => ({
  deriveBchChild: vi.fn(),
  deriveBchStandardXpubs: vi.fn(),
}));

type Row = Record<string, unknown>;

function makeSelectStmt(rows: Row[]) {
  let idx = 0;
  return {
    bind: vi.fn(),
    step: vi.fn(() => idx < rows.length),
    getAsObject: vi.fn(() => rows[idx++]),
    free: vi.fn(),
  };
}

describe('KeyManager', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);
  const mockedSecretCryptoService = vi.mocked(SecretCryptoService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSecretCryptoService.decryptText.mockImplementation(async (value: string) => value);
  });

  it('retrieveKeys decodes base64 key material', async () => {
    const pub = btoa(String.fromCharCode(1, 2, 3));
    const pkh = btoa(String.fromCharCode(4, 5, 6));
    const stmt = makeSelectStmt([
      {
        id: 1,
        public_key: pub,
        address: 'bitcoincash:q1',
        token_address: 'simpleledger:q1',
        pubkey_hash: pkh,
        account_index: 0,
        change_index: 0,
        address_index: 0,
      },
    ]);

    const db = { prepare: vi.fn(() => stmt) };
    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    const km = KeyManager();
    const keys = await km.retrieveKeys(1);

    expect(keys).toHaveLength(1);
    expect(Array.from(keys[0].publicKey)).toEqual([1, 2, 3]);
    expect(Array.from(keys[0].pubkeyHash)).toEqual([4, 5, 6]);
  });

  it('fetchAddressPrivateKey supports binary and base64 formats', async () => {
    const fetchQuery = {
      get: vi
        .fn()
        .mockReturnValueOnce([Uint8Array.from([9, 8, 7])])
        .mockReturnValueOnce([btoa(String.fromCharCode(6, 5, 4))]),
      free: vi.fn(),
    };

    const db = {
      prepare: vi.fn(() => fetchQuery),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    const km = KeyManager();

    expect(
      Array.from((await km.fetchAddressPrivateKey('bitcoincash:q1')) || [])
    ).toEqual([9, 8, 7]);
    expect(
      Array.from((await km.fetchAddressPrivateKey('bitcoincash:q2')) || [])
    ).toEqual([6, 5, 4]);
  });

  it('fetchAddressPrivateKey throws when key is missing', async () => {
    const fetchQuery = {
      get: vi.fn(() => undefined),
      free: vi.fn(),
    };

    const db = {
      prepare: vi.fn(() => fetchQuery),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    const km = KeyManager();
    await expect(km.fetchAddressPrivateKey('bitcoincash:qmissing')).rejects.toThrow(
      'No private key found'
    );
  });

  it('getXpubs derives standard wallet xpubs from stored seed material', async () => {
    const walletLookup = {
      get: vi.fn(() => ['enc:mnemonic', 'enc:passphrase', Network.MAINNET]),
      free: vi.fn(),
    };

    const db = {
      prepare: vi.fn(() => walletLookup),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    mockedSecretCryptoService.decryptText
      .mockResolvedValueOnce('wallet mnemonic')
      .mockResolvedValueOnce('wallet passphrase');

    vi.mocked(deriveBchStandardXpubs).mockResolvedValue({
      receive: 'xpub-receive',
      change: 'xpub-change',
      defi: 'xpub-defi',
    });

    const km = KeyManager();
    await expect(km.getXpubs(7, 2)).resolves.toEqual({
      receive: 'xpub-receive',
      change: 'xpub-change',
      defi: 'xpub-defi',
    });

    expect(walletLookup.get).toHaveBeenCalledWith([7]);
    expect(deriveBchStandardXpubs).toHaveBeenCalledWith(
      Network.MAINNET,
      'wallet mnemonic',
      'wallet passphrase',
      2
    );
  });

  it('deriveAddressFromXpub derives a public wallet address for a branch and index', async () => {
    const walletLookup = {
      get: vi.fn(() => ['enc:mnemonic', 'enc:passphrase', Network.CHIPNET]),
      free: vi.fn(),
    };

    const db = {
      prepare: vi.fn(() => walletLookup),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    mockedSecretCryptoService.decryptText
      .mockResolvedValueOnce('wallet mnemonic')
      .mockResolvedValueOnce('wallet passphrase')
      .mockResolvedValueOnce('wallet mnemonic')
      .mockResolvedValueOnce('wallet passphrase');

    vi.mocked(deriveBchStandardXpubs).mockResolvedValue({
      receive: 'xpub-receive',
      change: 'xpub-change',
      defi: 'xpub-defi',
    });
    vi.mocked(deriveBchChild).mockResolvedValue({
      publicKey: Uint8Array.from([1, 2, 3]),
      publicKeyHash: Uint8Array.from([4, 5, 6]),
      address: 'bchtest:qpublic',
      tokenAddress: 'bchtest:zpublic',
    });

    const km = KeyManager();
    await expect(km.deriveAddressFromXpub(7, 'change', 5, 1)).resolves.toEqual({
      publicKey: Uint8Array.from([1, 2, 3]),
      publicKeyHash: Uint8Array.from([4, 5, 6]),
      address: 'bchtest:qpublic',
      tokenAddress: 'bchtest:zpublic',
    });

    expect(deriveBchChild).toHaveBeenCalledWith(
      Network.CHIPNET,
      {
        kind: 'xpub',
        hdPublicKey: 'xpub-change',
      },
      5
    );
  });
});
