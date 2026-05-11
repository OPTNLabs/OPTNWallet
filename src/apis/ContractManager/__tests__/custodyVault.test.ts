import { describe, expect, it } from 'vitest';

import {
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  privateKeyToP2pkhLockingBytecode,
  secp256k1,
} from '@bitauth/libauth';
import {
  Contract,
  type Artifact,
  HashType,
  MockNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from 'cashscript';
import { addressToLockScript } from 'cashscript/dist/utils.js';

import CustodyVaultArtifact from '../artifacts/CustodyVault.json';

const CUSTODY_VAULT_ARTIFACT = {
  ...CustodyVaultArtifact,
  source: 'test',
} satisfies Artifact;

const OWNER_PRIVATE_KEY = hexToBin('11'.repeat(32));
const CUSTODIAN_PRIVATE_KEY = hexToBin('22'.repeat(32));
const RECOVERY_PRIVATE_KEY = hexToBin('33'.repeat(32));
const CONTRACT_SATS = 5_000n;
const FEE_SATS = 1_000n;
const RECOVERY_TIMEOUT = 1_000n;
const RELEASE_AT = 200n;

function toUint8Array(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? hexToBin(value) : value;
}

function toBin(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? hexToBin(value) : value;
}

function createFixture() {
  const provider = new MockNetworkProvider();
  const ownerPk = toBin(secp256k1.derivePublicKeyCompressed(OWNER_PRIVATE_KEY));
  const custodianPk = toBin(secp256k1.derivePublicKeyCompressed(
    CUSTODIAN_PRIVATE_KEY
  ));
  const recoveryPk = toBin(secp256k1.derivePublicKeyCompressed(RECOVERY_PRIVATE_KEY));
  const ownerPkh = toUint8Array(hash160(ownerPk));
  const custodianPkh = toUint8Array(hash160(custodianPk));
  const recoveryPkh = toUint8Array(hash160(recoveryPk));
  const ownerLockingBytecode = privateKeyToP2pkhLockingBytecode({
    privateKey: OWNER_PRIVATE_KEY,
  });
  const ownerAddressResult = lockingBytecodeToCashAddress({
    prefix: 'bchtest',
    bytecode: ownerLockingBytecode,
  });
  if (typeof ownerAddressResult === 'string') {
    throw new Error(ownerAddressResult);
  }
  const ownerAddress = ownerAddressResult.address;

  const release = new Contract(
    CUSTODY_VAULT_ARTIFACT,
    [
      ownerPkh,
      custodianPkh,
      recoveryPkh,
      RECOVERY_TIMEOUT,
      RELEASE_AT,
      new Uint8Array(0),
    ],
    {
      provider,
      addressType: 'p2sh32',
    }
  );

  const vault = new Contract(
    CUSTODY_VAULT_ARTIFACT,
    [
      ownerPkh,
      custodianPkh,
      recoveryPkh,
      RECOVERY_TIMEOUT,
      0n,
      addressToLockScript(release.address),
    ],
    {
      provider,
      addressType: 'p2sh32',
    }
  );

  provider.addUtxo(vault.address, {
    txid: 'a'.repeat(64),
    vout: 0,
    satoshis: CONTRACT_SATS,
  });
  provider.addUtxo(ownerAddress, {
    txid: 'b'.repeat(64),
    vout: 0,
    satoshis: FEE_SATS,
  });
  provider.addUtxo(ownerAddress, {
    txid: 'c'.repeat(64),
    vout: 1,
    satoshis: FEE_SATS,
  });

  return {
    custodianPk,
    custodianSig: new SignatureTemplate(
      CUSTODIAN_PRIVATE_KEY,
      HashType.SIGHASH_ALL
    ),
    ownerAddress,
    ownerPk,
    ownerSig: new SignatureTemplate(OWNER_PRIVATE_KEY, HashType.SIGHASH_ALL),
    ownerUnlocker: new SignatureTemplate(OWNER_PRIVATE_KEY).unlockP2PKH(),
    provider,
    recoveryPk,
    recoverySig: new SignatureTemplate(
      RECOVERY_PRIVATE_KEY,
      HashType.SIGHASH_ALL
    ),
    release,
    vault,
  };
}

describe('custody vault artifacts', () => {
  it('derive the same address for identical constructor params and different addresses for different release states', () => {
    const provider = new MockNetworkProvider();
    const ownerPk = toBin(secp256k1.derivePublicKeyCompressed(OWNER_PRIVATE_KEY));
    const ownerPkh = toUint8Array(hash160(ownerPk));
    const custodianPkh = toUint8Array(
      hash160(toBin(secp256k1.derivePublicKeyCompressed(CUSTODIAN_PRIVATE_KEY)))
    );
    const recoveryPkh = toUint8Array(
      hash160(toBin(secp256k1.derivePublicKeyCompressed(RECOVERY_PRIVATE_KEY)))
    );

    const releaseA = new Contract(
      CUSTODY_VAULT_ARTIFACT,
      [ownerPkh, custodianPkh, recoveryPkh, RECOVERY_TIMEOUT, RELEASE_AT, new Uint8Array(0)],
      { provider, addressType: 'p2sh32' }
    );
    const releaseB = new Contract(
      CUSTODY_VAULT_ARTIFACT,
      [ownerPkh, custodianPkh, recoveryPkh, RECOVERY_TIMEOUT, RELEASE_AT, new Uint8Array(0)],
      { provider, addressType: 'p2sh32' }
    );
    const releaseC = new Contract(
      CUSTODY_VAULT_ARTIFACT,
      [ownerPkh, custodianPkh, recoveryPkh, RECOVERY_TIMEOUT, RELEASE_AT + 1n, new Uint8Array(0)],
      { provider, addressType: 'p2sh32' }
    );

    const activeA = new Contract(
      CUSTODY_VAULT_ARTIFACT,
      [
        ownerPkh,
        custodianPkh,
        recoveryPkh,
        RECOVERY_TIMEOUT,
        0n,
        addressToLockScript(releaseA.address),
      ],
      { provider, addressType: 'p2sh32' }
    );
    const activeB = new Contract(
      CUSTODY_VAULT_ARTIFACT,
      [
        ownerPkh,
        custodianPkh,
        recoveryPkh,
        RECOVERY_TIMEOUT,
        0n,
        addressToLockScript(releaseA.address),
      ],
      { provider, addressType: 'p2sh32' }
    );

    expect(activeA.address).toBe(activeB.address);
    expect(releaseA.address).toBe(releaseB.address);
    expect(releaseA.address).not.toBe(activeA.address);
    expect(releaseA.address).not.toBe(releaseC.address);
  });

  it('moves custody from the active vault to the release state and then finalizes to the owner', async () => {
    const fixture = createFixture();
    const [vaultUtxo] = await fixture.vault.getUtxos();
    if (!vaultUtxo) {
      throw new Error('Expected a vault UTXO to be present');
    }

    const beginReleaseBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        vaultUtxo,
        fixture.vault.unlock.beginRelease(
          fixture.ownerPk,
          fixture.ownerSig,
          fixture.custodianPk,
          fixture.custodianSig
        )
      )
      .addInput(
        {
          txid: 'b'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.release.address, amount: CONTRACT_SATS });

    expect(() => beginReleaseBuilder.debug()).not.toThrow();
    const beginReleaseTxid = await fixture.provider.sendRawTransaction(
      beginReleaseBuilder.build()
    );

    const [releaseUtxo] = await fixture.release.getUtxos();
    if (!releaseUtxo) {
      throw new Error('Expected a release UTXO to be present');
    }
    expect(releaseUtxo.txid).toBe(beginReleaseTxid);
    expect(releaseUtxo.satoshis).toBe(CONTRACT_SATS);

    const finalizeBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .setLocktime(Number(RELEASE_AT))
      .addInput(
        releaseUtxo,
        fixture.release.unlock.finalize(fixture.ownerPk, fixture.ownerSig)
      )
      .addInput(
        {
          txid: 'c'.repeat(64),
          vout: 1,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.ownerAddress, amount: CONTRACT_SATS });

    expect(() => finalizeBuilder.debug()).not.toThrow();
    const finalizeTxid = await fixture.provider.sendRawTransaction(
      finalizeBuilder.build()
    );

    const ownerUtxos = await fixture.provider.getUtxos(fixture.ownerAddress);
    expect(
      ownerUtxos.some(
        (utxo) =>
      utxo.txid === finalizeTxid && utxo.satoshis === CONTRACT_SATS
      )
    ).toBe(true);
  });

  it('accepts a vault deposit from an arbitrary sender and still controls the outbound spend', async () => {
    const fixture = createFixture();
    const depositorPrivateKey = hexToBin('55'.repeat(32));
    const depositorAddressResult = lockingBytecodeToCashAddress({
      prefix: 'bchtest',
      bytecode: privateKeyToP2pkhLockingBytecode({
        privateKey: depositorPrivateKey,
      }),
    });
    if (typeof depositorAddressResult === 'string') {
      throw new Error(depositorAddressResult);
    }
    const depositorAddress = depositorAddressResult.address;
    const depositorUnlocker = new SignatureTemplate(
      depositorPrivateKey
    ).unlockP2PKH();

    fixture.provider.addUtxo(depositorAddress, {
      txid: 'f'.repeat(64),
      vout: 0,
      satoshis: 6_000n,
    });

    const [depositorUtxo] = await fixture.provider.getUtxos(depositorAddress);
    if (!depositorUtxo) {
      throw new Error('Expected a depositor UTXO to be present');
    }

    const depositBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(depositorUtxo, depositorUnlocker)
      .addOutput({ to: fixture.vault.address, amount: CONTRACT_SATS });

    expect(() => depositBuilder.debug()).not.toThrow();
    const depositTxid = await fixture.provider.sendRawTransaction(
      depositBuilder.build()
    );

    const vaultUtxos = await fixture.vault.getUtxos();
    const depositedVaultUtxo = vaultUtxos.find((utxo) => utxo.txid === depositTxid);
    if (!depositedVaultUtxo) {
      throw new Error('Expected the deposited vault UTXO to be present');
    }
    expect(depositedVaultUtxo.satoshis).toBe(CONTRACT_SATS);

    const beginReleaseBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        depositedVaultUtxo,
        fixture.vault.unlock.beginRelease(
          fixture.ownerPk,
          fixture.ownerSig,
          fixture.custodianPk,
          fixture.custodianSig
        )
      )
      .addInput(
        {
          txid: 'b'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.release.address, amount: CONTRACT_SATS });

    expect(() => beginReleaseBuilder.debug()).not.toThrow();
    const beginReleaseTxid = await fixture.provider.sendRawTransaction(
      beginReleaseBuilder.build()
    );

    const [releaseUtxo] = (await fixture.release.getUtxos()).filter(
      (utxo) => utxo.txid === beginReleaseTxid
    );
    if (!releaseUtxo) {
      throw new Error('Expected a release UTXO to be present');
    }

    const finalizeBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .setLocktime(Number(RELEASE_AT))
      .addInput(
        releaseUtxo,
        fixture.release.unlock.finalize(fixture.ownerPk, fixture.ownerSig)
      )
      .addInput(
        {
          txid: 'c'.repeat(64),
          vout: 1,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.ownerAddress, amount: CONTRACT_SATS });

    expect(() => finalizeBuilder.debug()).not.toThrow();
    await fixture.provider.sendRawTransaction(finalizeBuilder.build());
  });

  it('keeps multiple inbound vault deposits independent and spendable one at a time', async () => {
    const fixture = createFixture();

    const depositor1PrivateKey = hexToBin('55'.repeat(32));
    const depositor2PrivateKey = hexToBin('66'.repeat(32));
    const depositor1AddressResult = lockingBytecodeToCashAddress({
      prefix: 'bchtest',
      bytecode: privateKeyToP2pkhLockingBytecode({
        privateKey: depositor1PrivateKey,
      }),
    });
    const depositor2AddressResult = lockingBytecodeToCashAddress({
      prefix: 'bchtest',
      bytecode: privateKeyToP2pkhLockingBytecode({
        privateKey: depositor2PrivateKey,
      }),
    });
    if (
      typeof depositor1AddressResult === 'string' ||
      typeof depositor2AddressResult === 'string'
    ) {
      throw new Error('Expected depositor addresses to be valid');
    }

    fixture.provider.addUtxo(depositor1AddressResult.address, {
      txid: 'f'.repeat(64),
      vout: 0,
      satoshis: 6_000n,
    });
    fixture.provider.addUtxo(depositor2AddressResult.address, {
      txid: 'e'.repeat(64),
      vout: 0,
      satoshis: 7_000n,
    });

    const depositor1Utxo = (await fixture.provider.getUtxos(
      depositor1AddressResult.address
    ))[0];
    const depositor2Utxo = (await fixture.provider.getUtxos(
      depositor2AddressResult.address
    ))[0];
    if (!depositor1Utxo || !depositor2Utxo) {
      throw new Error('Expected both depositor UTXOs to be present');
    }

    const deposit1Builder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        depositor1Utxo,
        new SignatureTemplate(depositor1PrivateKey).unlockP2PKH()
      )
      .addOutput({ to: fixture.vault.address, amount: CONTRACT_SATS });

    const deposit2Builder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        depositor2Utxo,
        new SignatureTemplate(depositor2PrivateKey).unlockP2PKH()
      )
      .addOutput({ to: fixture.vault.address, amount: CONTRACT_SATS });

    expect(() => deposit1Builder.debug()).not.toThrow();
    expect(() => deposit2Builder.debug()).not.toThrow();
    const deposit1Txid = await fixture.provider.sendRawTransaction(
      deposit1Builder.build()
    );
    const deposit2Txid = await fixture.provider.sendRawTransaction(
      deposit2Builder.build()
    );

    const vaultUtxos = await fixture.vault.getUtxos();
    expect(vaultUtxos).toHaveLength(3);
    expect(vaultUtxos.map((utxo) => utxo.txid).sort()).toEqual(
      ['a'.repeat(64), deposit1Txid, deposit2Txid].sort()
    );

    const firstVaultUtxo = vaultUtxos.find((utxo) => utxo.txid === deposit1Txid);
    const secondVaultUtxo = vaultUtxos.find((utxo) => utxo.txid === deposit2Txid);
    if (!firstVaultUtxo || !secondVaultUtxo) {
      throw new Error('Expected both vault UTXOs to be present');
    }

    const releaseBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        firstVaultUtxo,
        fixture.vault.unlock.beginRelease(
          fixture.ownerPk,
          fixture.ownerSig,
          fixture.custodianPk,
          fixture.custodianSig
        )
      )
      .addInput(
        {
          txid: 'b'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.release.address, amount: CONTRACT_SATS });

    expect(() => releaseBuilder.debug()).not.toThrow();
    await fixture.provider.sendRawTransaction(releaseBuilder.build());

    const remainingVaultUtxos = await fixture.vault.getUtxos();
    expect(remainingVaultUtxos.some((utxo) => utxo.txid === 'a'.repeat(64))).toBe(
      true
    );
    expect(remainingVaultUtxos.some((utxo) => utxo.txid === deposit2Txid)).toBe(
      true
    );
  });

  it('rejects token-bearing vault deposits when the vault is spent', async () => {
    const fixture = createFixture();
    fixture.provider.addUtxo(fixture.vault.address, {
      txid: 'f'.repeat(64),
      vout: 0,
      satoshis: CONTRACT_SATS,
      token: {
        category: '11'.repeat(32),
        amount: 1n,
      },
    });

    const tokenVaultUtxo = (await fixture.vault.getUtxos()).find(
      (utxo) => utxo.txid === 'f'.repeat(64)
    );
    if (!tokenVaultUtxo) {
      throw new Error('Expected a token-bearing vault UTXO to be present');
    }

    const builder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        tokenVaultUtxo,
        fixture.vault.unlock.beginRelease(
          fixture.ownerPk,
          fixture.ownerSig,
          fixture.custodianPk,
          fixture.custodianSig
        )
      )
      .addInput(
        {
          txid: 'b'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.release.address, amount: CONTRACT_SATS });

    expect(() => builder.debug()).toThrow();
  });

  it('rejects extra inputs on refresh and recover spends', async () => {
    const fixture = createFixture();
    const [vaultUtxo] = await fixture.vault.getUtxos();
    if (!vaultUtxo) {
      throw new Error('Expected a vault UTXO to be present');
    }

    const refreshBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        vaultUtxo,
        fixture.vault.unlock.refresh(fixture.custodianPk, fixture.custodianSig)
      )
      .addInput(
        {
          txid: 'b'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addInput(
        {
          txid: 'c'.repeat(64),
          vout: 1,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.vault.address, amount: CONTRACT_SATS });

    expect(() => refreshBuilder.debug()).toThrow();

    const recoverBuilder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .setLocktime(Number(RECOVERY_TIMEOUT))
      .addInput(
        vaultUtxo,
        fixture.vault.unlock.recover(
          fixture.recoveryPk,
          fixture.recoverySig
        )
      )
      .addInput(
        {
          txid: 'b'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addInput(
        {
          txid: 'c'.repeat(64),
          vout: 1,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.ownerAddress, amount: CONTRACT_SATS });

    expect(() => recoverBuilder.debug()).toThrow();
  });

  it('rejects beginRelease when the transaction shape includes an extra output', async () => {
    const fixture = createFixture();
    const [vaultUtxo] = await fixture.vault.getUtxos();
    if (!vaultUtxo) {
      throw new Error('Expected a vault UTXO to be present');
    }

    const builder = new TransactionBuilder({
      provider: fixture.provider,
    })
      .addInput(
        vaultUtxo,
        fixture.vault.unlock.beginRelease(
          fixture.ownerPk,
          fixture.ownerSig,
          fixture.custodianPk,
          fixture.custodianSig
        )
      )
      .addInput(
        {
          txid: 'b'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        fixture.ownerUnlocker
      )
      .addOutput({ to: fixture.release.address, amount: CONTRACT_SATS })
      .addOutput({ to: fixture.ownerAddress, amount: 1_000n });

    expect(() => builder.debug()).toThrow();
  });

  it('rejects release finalization before the timelock expires', async () => {
    const provider = new MockNetworkProvider();
    const ownerPk = toBin(secp256k1.derivePublicKeyCompressed(OWNER_PRIVATE_KEY));
    const ownerPkh = toUint8Array(hash160(ownerPk));
    const ownerLockingBytecode = privateKeyToP2pkhLockingBytecode({
      privateKey: OWNER_PRIVATE_KEY,
    });
    const ownerAddressResult = lockingBytecodeToCashAddress({
      prefix: 'bchtest',
      bytecode: ownerLockingBytecode,
    });
    if (typeof ownerAddressResult === 'string') {
      throw new Error(ownerAddressResult);
    }
    const ownerAddress = ownerAddressResult.address;
    const ownerUnlocker = new SignatureTemplate(OWNER_PRIVATE_KEY).unlockP2PKH();
    const ownerSig = new SignatureTemplate(OWNER_PRIVATE_KEY, HashType.SIGHASH_ALL);

    const release = new Contract(
      CUSTODY_VAULT_ARTIFACT,
      [ownerPkh, ownerPkh, ownerPkh, RECOVERY_TIMEOUT, RELEASE_AT, new Uint8Array(0)],
      { provider, addressType: 'p2sh32' }
    );

    provider.addUtxo(release.address, {
      txid: 'd'.repeat(64),
      vout: 0,
      satoshis: CONTRACT_SATS,
    });
    provider.addUtxo(ownerAddress, {
      txid: 'e'.repeat(64),
      vout: 0,
      satoshis: FEE_SATS,
    });

    const [releaseUtxo] = await release.getUtxos();
    if (!releaseUtxo) {
      throw new Error('Expected a release UTXO to be present');
    }

    const builder = new TransactionBuilder({ provider })
      .setLocktime(Number(RELEASE_AT - 1n))
      .addInput(releaseUtxo, release.unlock.finalize(ownerPk, ownerSig))
      .addInput(
        {
          txid: 'e'.repeat(64),
          vout: 0,
          satoshis: FEE_SATS,
        },
        ownerUnlocker
      )
      .addOutput({ to: ownerAddress, amount: CONTRACT_SATS });

    expect(() => builder.debug()).toThrow();
  });
});
