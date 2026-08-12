import { beforeEach, describe, expect, it, vi } from 'vitest';

import KeyManager from '../KeyManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';
import SecretCryptoService from '../../../services/SecretCryptoService';
import QuantumrootVaultCacheService from '../../../services/QuantumrootVaultCacheService';
import {
  deriveBchChild,
  deriveBchStandardXpubs,
} from '../../../services/HdWalletService';
import { deriveQuantumrootVault } from '../../../services/QuantumrootService';
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

vi.mock('../../../services/QuantumrootService', () => ({
  deriveQuantumrootVault: vi.fn(),
  toQuantumrootVaultRecord: vi.fn(
    (
      walletId: number,
      accountIndex: number,
      vault: any,
      onlineQuantumSigner = 0,
      vaultTokenCategory = '00'.repeat(32)
    ) => ({
      wallet_id: walletId,
      account_index: accountIndex,
      address_index: vault.addressIndex,
      receive_address: vault.receiveAddress,
      quantum_lock_address: vault.quantumLockAddress,
      receive_locking_bytecode: '1122',
      quantum_lock_locking_bytecode: '3344',
      quantum_public_key: 'dd',
      quantum_key_identifier: 'aa',
      vault_token_category: vaultTokenCategory,
      online_quantum_signer: onlineQuantumSigner,
      created_at: '2026-04-12T00:00:00.000Z',
      updated_at: '2026-04-12T00:00:00.000Z',
    })
  ),
}));

vi.mock('../../../services/QuantumrootVaultCacheService', () => ({
  default: {
    list: vi.fn(() => []),
    upsert: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
  },
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
  const mockedVaultCache = vi.mocked(QuantumrootVaultCacheService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSecretCryptoService.decryptText.mockImplementation(async (value: string) => value);
    mockedVaultCache.list.mockReturnValue([]);
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
      flushDatabaseToFile: vi.fn(async () => {}),
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
      flushDatabaseToFile: vi.fn(async () => {}),
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
      flushDatabaseToFile: vi.fn(async () => {}),
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
      flushDatabaseToFile: vi.fn(async () => {}),
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
      flushDatabaseToFile: vi.fn(async () => {}),
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

  it('deriveQuantumrootVaultForWallet derives Quantumroot vault artifacts from stored seed material', async () => {
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
      flushDatabaseToFile: vi.fn(async () => {}),
    } as never);

    mockedSecretCryptoService.decryptText
      .mockResolvedValueOnce('wallet mnemonic')
      .mockResolvedValueOnce('wallet passphrase');

    vi.mocked(deriveQuantumrootVault).mockResolvedValue({
      accountPath: "m/44'/145'/0'",
      accountHdPrivateKey: 'xprv-account',
      addressIndex: 7,
      components: {} as never,
      quantumKeyIdentifier: Uint8Array.from([1]),
      quantumSeed: Uint8Array.from([2]),
      quantumPrivateKey: [],
      quantumPrivateKeyBytes: Uint8Array.from([3]),
      quantumPublicKey: Uint8Array.from([4]),
      receiveSchnorrPublicKey: Uint8Array.from([5]),
      receiveAddress: 'bitcoincash:preceive',
      receiveLockingBytecode: Uint8Array.from([6]),
      quantumLockAddress: 'bitcoincash:pquantum',
      quantumLockLockingBytecode: Uint8Array.from([7]),
    });

    const km = KeyManager();
    await expect(km.deriveQuantumrootVaultForWallet(7, 7, 0)).resolves.toMatchObject({
      receiveAddress: 'bitcoincash:preceive',
      quantumLockAddress: 'bitcoincash:pquantum',
      addressIndex: 7,
    });

    expect(deriveQuantumrootVault).toHaveBeenCalledWith(
      Network.MAINNET,
      'wallet mnemonic',
      'wallet passphrase',
      0,
      7,
      '0',
      '00'.repeat(32)
    );
  });

  it('deriveQuantumrootVaultForWallet forwards configured Quantumroot token category and signer', async () => {
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
      .mockResolvedValueOnce('wallet passphrase');

    vi.mocked(deriveQuantumrootVault).mockResolvedValue({
      accountPath: "m/44'/145'/0'",
      accountHdPrivateKey: 'xprv-account',
      addressIndex: 9,
      components: {} as never,
      quantumKeyIdentifier: Uint8Array.from([1]),
      quantumSeed: Uint8Array.from([2]),
      quantumPrivateKey: [],
      quantumPrivateKeyBytes: Uint8Array.from([3]),
      quantumPublicKey: Uint8Array.from([4]),
      receiveSchnorrPublicKey: Uint8Array.from([5]),
      receiveAddress: 'bchtest:preceive',
      receiveLockingBytecode: Uint8Array.from([6]),
      quantumLockAddress: 'bchtest:pquantum',
      quantumLockLockingBytecode: Uint8Array.from([7]),
    });

    const km = KeyManager();
    await km.deriveQuantumrootVaultForWallet(7, 9, 0, '1', '11'.repeat(32));

    expect(deriveQuantumrootVault).toHaveBeenCalledWith(
      Network.CHIPNET,
      'wallet mnemonic',
      'wallet passphrase',
      0,
      9,
      '1',
      '11'.repeat(32)
    );
  });

  it('createQuantumrootVault persists a dedicated vault record', async () => {
    const walletLookup = {
      get: vi.fn(() => ['enc:mnemonic', 'enc:passphrase', Network.MAINNET]),
      free: vi.fn(),
    };
    const db = {
      prepare: vi.fn(() => walletLookup),
    };

    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      flushDatabaseToFile: vi.fn(async () => {}),
    };
    mockedDatabaseService.mockReturnValue(dbService as never);

    mockedSecretCryptoService.decryptText
      .mockResolvedValueOnce('wallet mnemonic')
      .mockResolvedValueOnce('wallet passphrase');

    vi.mocked(deriveQuantumrootVault).mockResolvedValue({
      accountPath: "m/44'/145'/0'",
      accountHdPrivateKey: 'xprv-account',
      addressIndex: 4,
      components: {} as never,
      quantumKeyIdentifier: Uint8Array.from([0xaa]),
      quantumSeed: Uint8Array.from([0xbb]),
      quantumPrivateKey: [],
      quantumPrivateKeyBytes: Uint8Array.from([0xcc]),
      quantumPublicKey: Uint8Array.from([0xdd]),
      receiveSchnorrPublicKey: Uint8Array.from([0xee]),
      receiveAddress: 'bitcoincash:preceive',
      receiveLockingBytecode: Uint8Array.from([0x11, 0x22]),
      quantumLockAddress: 'bitcoincash:pquantum',
      quantumLockLockingBytecode: Uint8Array.from([0x33, 0x44]),
    });

    const km = KeyManager();
    const record = await km.createQuantumrootVault(7, 4);

    expect(record).toMatchObject({
      wallet_id: 7,
      account_index: 0,
      address_index: 4,
      receive_address: 'bitcoincash:preceive',
      quantum_lock_address: 'bitcoincash:pquantum',
      quantum_public_key: 'dd',
      quantum_key_identifier: 'aa',
    });
    expect(mockedVaultCache.upsert).toHaveBeenCalledWith(7, record);
  });

  it('retrieveQuantumrootVaults returns stored dedicated vault records', async () => {
    mockedVaultCache.list.mockReturnValue([
      {
        wallet_id: 7,
        account_index: 0,
        address_index: 0,
        receive_address: 'bitcoincash:preceive',
        quantum_lock_address: 'bitcoincash:pquantum',
        receive_locking_bytecode: 'aa11',
        quantum_lock_locking_bytecode: 'bb22',
        quantum_public_key: 'cc33',
        quantum_key_identifier: 'dd44',
        vault_token_category: '00'.repeat(32),
        online_quantum_signer: 0,
        created_at: '2026-04-12T00:00:00.000Z',
        updated_at: '2026-04-12T00:00:00.000Z',
      },
      {
        wallet_id: 7,
        account_index: 0,
        address_index: 1,
        receive_address: 'bitcoincash:backfilled-receive',
        quantum_lock_address: 'bitcoincash:backfilled-lock',
        receive_locking_bytecode: 'aa11',
        quantum_lock_locking_bytecode: 'bb22',
        quantum_public_key: 'cc33',
        quantum_key_identifier: 'dd44',
        vault_token_category: '00'.repeat(32),
        online_quantum_signer: 0,
        created_at: '2026-04-12T00:00:00.000Z',
        updated_at: '2026-04-12T00:00:00.000Z',
      },
      {
        wallet_id: 7,
        account_index: 0,
        address_index: 2,
        receive_address: 'bitcoincash:backfilled-receive-2',
        quantum_lock_address: 'bitcoincash:backfilled-lock-2',
        receive_locking_bytecode: 'aa11',
        quantum_lock_locking_bytecode: 'bb22',
        quantum_public_key: 'cc33',
        quantum_key_identifier: 'dd44',
        vault_token_category: '00'.repeat(32),
        online_quantum_signer: 0,
        created_at: '2026-04-12T00:00:00.000Z',
        updated_at: '2026-04-12T00:00:00.000Z',
      },
    ]);
    const walletLookupStmt = {
      get: vi.fn(() => ['enc:mnemonic', 'enc:passphrase', Network.MAINNET]),
      free: vi.fn(),
    };
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM wallets WHERE id = ?')) {
          return walletLookupStmt;
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      flushDatabaseToFile: vi.fn(async () => {}),
    } as never);
    vi.mocked(deriveQuantumrootVault).mockResolvedValue({
      accountPath: "m/44'/145'/0'",
      accountHdPrivateKey: 'xprv-account',
      addressIndex: 1,
      components: {} as never,
      quantumKeyIdentifier: Uint8Array.from([0xaa]),
      quantumSeed: Uint8Array.from([0xbb]),
      quantumPrivateKey: [],
      quantumPrivateKeyBytes: Uint8Array.from([0xcc]),
      quantumPublicKey: Uint8Array.from([0xdd]),
      receiveSchnorrPublicKey: Uint8Array.from([0xee]),
      receiveAddress: 'bitcoincash:backfilled-receive',
      receiveLockingBytecode: Uint8Array.from([0x11, 0x22]),
      quantumLockAddress: 'bitcoincash:backfilled-lock',
      quantumLockLockingBytecode: Uint8Array.from([0x33, 0x44]),
    });

    const km = KeyManager();
    const records = await km.retrieveQuantumrootVaults(7);
    expect(records).toHaveLength(3);
    expect(vi.mocked(deriveQuantumrootVault)).not.toHaveBeenCalled();
  });

  it('configureQuantumrootVault re-derives and updates a persisted vault with the configured token category', async () => {
    const walletLookup = {
      get: vi.fn(() => ['enc:mnemonic', 'enc:passphrase', Network.CHIPNET]),
      free: vi.fn(),
    };
    const db = {
      prepare: vi.fn(() => walletLookup),
    };

    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      flushDatabaseToFile: vi.fn(async () => {}),
    };
    mockedDatabaseService.mockReturnValue(dbService as never);

    mockedSecretCryptoService.decryptText
      .mockResolvedValueOnce('wallet mnemonic')
      .mockResolvedValueOnce('wallet passphrase');

    vi.mocked(deriveQuantumrootVault).mockResolvedValue({
      accountPath: "m/44'/145'/0'",
      accountHdPrivateKey: 'xprv-account',
      addressIndex: 4,
      components: {} as never,
      quantumKeyIdentifier: Uint8Array.from([0xaa]),
      quantumSeed: Uint8Array.from([0xbb]),
      quantumPrivateKey: [],
      quantumPrivateKeyBytes: Uint8Array.from([0xcc]),
      quantumPublicKey: Uint8Array.from([0xdd]),
      receiveSchnorrPublicKey: Uint8Array.from([0xee]),
      receiveAddress: 'bchtest:configured-receive',
      receiveLockingBytecode: Uint8Array.from([0x11, 0x22]),
      quantumLockAddress: 'bchtest:configured-lock',
      quantumLockLockingBytecode: Uint8Array.from([0x33, 0x44]),
    });

    const km = KeyManager();
    const record = await km.configureQuantumrootVault(
      7,
      4,
      0,
      1,
      '22'.repeat(32)
    );

    expect(record.receive_address).toBe('bchtest:configured-receive');
    expect(record.quantum_lock_address).toBe('bchtest:configured-lock');
    expect(record.vault_token_category).toBe('22'.repeat(32));
    expect(record.online_quantum_signer).toBe(1);
    expect(mockedVaultCache.upsert).toHaveBeenCalledWith(7, record);
  });
});
