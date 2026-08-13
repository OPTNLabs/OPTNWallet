import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  binToHex,
  cashAddressToLockingBytecode,
  createVirtualMachineBCH,
  generateTransaction,
  hexToBin,
  secp256k1,
  validateSecp256k1PrivateKey,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  type TransactionTemplateFixed,
} from '@bitauth/libauth';
import { Network } from '../../../state/slices/networkSlice';
import {
  deriveBchKeyMaterial,
  derivePrivateKeyAtPath,
  getBchAccountPath,
} from '../../HdWalletService';
import { deriveCashConnectIdentityKey } from '../cashconnectKey';
import {
  cashConnectChangeData,
  cashConnectSpendData,
  tokenFromUtxo,
} from '../cashconnectContext';
import { createP2pkhUTXOSpendable } from '../cashconnectSpendable';

const TEST_MNEMONIC = bip39.entropyToMnemonic('0'.repeat(32));

describe('CashConnect libauth', () => {
  it('derives a valid purpose-5001 identity key distinct from the spend account', async () => {
    const accountPath = getBchAccountPath(Network.CHIPNET, 0);
    const identity = await deriveCashConnectIdentityKey({
      mnemonic: TEST_MNEMONIC,
      passphrase: '',
      network: Network.CHIPNET,
      accountPath,
    });
    const spend = await derivePrivateKeyAtPath(
      TEST_MNEMONIC,
      '',
      `${accountPath}/0/0`
    );

    expect(identity).toHaveLength(32);
    expect(validateSecp256k1PrivateKey(identity)).toBe(true);
    expect(binToHex(identity)).not.toBe(binToHex(spend));

    const pubkey = secp256k1.derivePublicKeyCompressed(identity);
    expect(typeof pubkey === 'string' ? pubkey : pubkey.length).toBe(33);
  });

  it('compiles the CashConnect P2PKH lock/unlock template and the VM accepts a spend', async () => {
    const keys = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      0
    );
    expect(keys).not.toBeNull();
    if (!keys) return;

    const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
    const lock = compiler.generateBytecode({
      data: { keys: { privateKeys: { key: keys.privateKey } } },
      scriptId: 'lock',
    });
    expect(lock.success).toBe(true);
    if (!lock.success) return;

    const fromAddress = cashAddressToLockingBytecode(keys.address);
    expect(typeof fromAddress).not.toBe('string');
    if (typeof fromAddress === 'string') return;
    expect(binToHex(lock.bytecode)).toBe(binToHex(fromAddress.bytecode));

    const sourceOutput = {
      lockingBytecode: fromAddress.bytecode,
      valueSatoshis: 100_000n,
    };
    const tx = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointIndex: 0,
          outpointTransactionHash: hexToBin('11'.repeat(32)),
          sequenceNumber: 0xffffffff,
          unlockingBytecode: {
            compiler,
            script: 'unlock',
            data: { keys: { privateKeys: { key: keys.privateKey } } },
            valueSatoshis: 100_000n,
          },
        },
      ],
      outputs: [
        {
          lockingBytecode: fromAddress.bytecode,
          valueSatoshis: 99_000n,
        },
      ],
    } as TransactionTemplateFixed<typeof compiler>;

    const generated = generateTransaction(tx);
    expect(generated.success).toBe(true);
    if (!generated.success) return;

    const vm = createVirtualMachineBCH();
    const verified = vm.verify({
      sourceOutputs: [sourceOutput],
      transaction: generated.transaction,
    });
    expect(verified).toBe(true);
  });

  it('compiles change from a public key and carries spend keys for live context', async () => {
    const keys = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      1,
      0
    );
    expect(keys).not.toBeNull();
    if (!keys) return;

    const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
    const data = cashConnectChangeData(keys.publicKey);
    expect(data).not.toHaveProperty('keys');
    const lock = compiler.generateBytecode({
      data,
      scriptId: 'lock',
    });
    expect(lock.success).toBe(true);
    if (!lock.success) return;
    const fromAddress = cashAddressToLockingBytecode(keys.address);
    expect(typeof fromAddress).not.toBe('string');
    if (typeof fromAddress === 'string') return;
    expect(binToHex(lock.bytecode)).toBe(binToHex(fromAddress.bytecode));
    expect(cashConnectSpendData(keys.privateKey).keys.privateKeys.key).toEqual(
      keys.privateKey
    );
  });

  it('wraps P2PKH as lock/unlock/fee and adapts to the alpha.31 template shape', async () => {
    const keys = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      0
    );
    expect(keys).not.toBeNull();
    if (!keys) return;

    const coin = createP2pkhUTXOSpendable({
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    const fromAddress = cashAddressToLockingBytecode(keys.address);
    expect(typeof fromAddress).not.toBe('string');
    if (typeof fromAddress === 'string') return;

    expect(binToHex(coin.lock())).toBe(binToHex(fromAddress.bytecode));
    expect(coin.fee).toBe(1000);

    const change = coin.toChangeTemplateDirective();
    expect(change.fee).toBe(1000n);
    expect(change.lock.script).toBe('lock');
    expect(change.unlock.script).toBe('unlock');
    expect(change.unlock.data).not.toBe(change.lock.data);

    const compiledLock = change.lock.compiler.generateBytecode({
      data: change.lock.data,
      scriptId: change.lock.script,
    });
    expect(compiledLock.success).toBe(true);
    if (!compiledLock.success) return;
    expect(binToHex(compiledLock.bytecode)).toBe(binToHex(coin.lock()));
  });

  it('maps CashToken UTXO fields into a libauth Output token', () => {
    const token = tokenFromUtxo({
      address: 'bchtest:qtest',
      height: 1,
      tx_hash: 'aa'.repeat(32),
      tx_pos: 0,
      value: 1000,
      token: {
        category: 'bb'.repeat(32),
        amount: 7,
        nft: { capability: 'none', commitment: 'cc' },
      },
    });
    expect(token?.amount).toBe(7n);
    expect(binToHex(token?.category ?? new Uint8Array())).toBe('bb'.repeat(32));
    expect(token?.nft?.capability).toBe('none');
    expect(binToHex(token?.nft?.commitment ?? new Uint8Array())).toBe('cc');
  });
});
