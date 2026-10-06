/**
 * Direct generic CashScript Chipnet E2E.
 *
 * Uses only OPTN_E2E_MNEMONIC from the local environment. The
 * mnemonic and private keys remain in this process and are never logged or
 * written. Set ADDON_CASHSCRIPT_LIVE=1 to authorize the two Chipnet spends.
 */
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { decodeTransaction, hexToBin, createVirtualMachineBCH, secp256k1, encodeCashAddress, cashAddressToLockingBytecode, binToHex, sha256 } from '@bitauth/libauth';
import { Contract, ElectrumNetworkProvider, SighashType, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { Network } from '../src/state/slices/networkSlice';
import { derivePrivateKeyAtPath, getBchAddressPath } from '../src/services/HdWalletService';
import { hash160 } from '@cashscript/utils';
import { anyServer } from '../test-support/chipnetElectrum';

loadDotenv({ path: '.env', override: false });
const mnemonic = process.env.OPTN_E2E_MNEMONIC?.trim() ?? '';
if (!mnemonic) throw new Error('OPTN_E2E_MNEMONIC is required');
if (process.env.ADDON_CASHSCRIPT_LIVE !== '1') {
  throw new Error('Set ADDON_CASHSCRIPT_LIVE=1 to authorize Chipnet broadcasts');
}

const provider = new ElectrumNetworkProvider(Network.CHIPNET);
const artifact = {
  contractName: 'AddonSdkChipnetP2PKH',
  constructorInputs: [{ name: 'pkh', type: 'bytes20' }],
  abi: [{ name: 'spend', inputs: [{ name: 'pk', type: 'pubkey' }, { name: 's', type: 'sig' }] }],
  bytecode: 'OP_OVER OP_HASH160 OP_EQUALVERIFY OP_CHECKSIG',
  compiler: { name: 'cashc', version: '0.14.0' },
};
const transferWithTimeoutArtifact = JSON.parse(
  readFileSync(new URL('../src/apis/ContractManager/artifacts/transfer_with_timeout.json', import.meta.url), 'utf8'),
);

function addressFor(pubkey: Uint8Array): string {
  const encoded = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pubkey) });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}

function scripthash(address: string): string {
  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === 'string') throw new Error(locking);
  return binToHex(sha256.hash(locking.bytecode).reverse());
}

async function findCoin() {
  for (const change of [false, true]) {
    for (let index = 0; index < 10; index += 1) {
      const path = getBchAddressPath(Network.CHIPNET, 0, change ? 1 : 0, index);
      const privkey = await derivePrivateKeyAtPath(mnemonic, '', path);
      const pubkey = secp256k1.derivePublicKeyCompressed(privkey);
      if (typeof pubkey === 'string') throw new Error(pubkey);
      const address = addressFor(Uint8Array.from(pubkey));
      const response = await anyServer([[1, 'blockchain.scripthash.listunspent', [scripthash(address)]]]);
      const coins = (response.results[1] as Array<{ tx_hash: string; tx_pos: number; value: number }> | undefined) ?? [];
      if (coins.length > 0) return { coin: coins.sort((a, b) => b.value - a.value)[0], privkey, address };
    }
  }
  throw new Error('No spendable Chipnet BCH found in the first 10 receive/change addresses');
}

async function waitForUtxo(address: string, txid: string, vout: number) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const utxos = await provider.getUtxos(address);
    if (utxos.some((utxo) => utxo.txid === txid && utxo.vout === vout)) return utxos.find((utxo) => utxo.txid === txid && utxo.vout === vout)!;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Timed out waiting for the contract UTXO to become visible');
}

async function broadcast(raw: string): Promise<string> {
  const result = await anyServer([[1, 'blockchain.transaction.broadcast', [raw]]]);
  const txid = result.results[1];
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) throw new Error(`Chipnet provider rejected the transaction: ${JSON.stringify(txid).slice(0, 500)}`);
  return txid;
}

const source = await findCoin();
const pubkey = secp256k1.derivePublicKeyCompressed(source.privkey);
if (typeof pubkey === 'string') throw new Error(pubkey);
const contract = new Contract(artifact, [binToHex(hash160(Uint8Array.from(pubkey)))], { provider, contractType: 'p2sh32', addressType: 'p2sh32' } as never);
const existingContractUtxo = (await provider.getUtxos(contract.address)).find((utxo) => utxo.satoshis >= 2_000n);
const funding = new TransactionBuilder({ provider });
  funding.addInput({ txid: source.coin.tx_hash, vout: source.coin.tx_pos, satoshis: BigInt(source.coin.value), lockingBytecode: binToHex(cashAddressToLockingBytecode(source.address).bytecode) }, new SignatureTemplate(source.privkey, SighashType.SIGHASH_ALL).unlockP2PKH());
funding.addOutputs([
  { to: contract.address, amount: 10_000n },
  { to: source.address, amount: BigInt(source.coin.value - 10_000 - 1_000) },
]);
const fundingHex = funding.build();
const fundingTx = decodeTransaction(hexToBin(fundingHex));
if (typeof fundingTx === 'string') throw new Error(fundingTx);
if (!createVirtualMachineBCH().verify({ sourceOutputs: [{ lockingBytecode: cashAddressToLockingBytecode(source.address).bytecode, valueSatoshis: BigInt(source.coin.value) }], transaction: fundingTx })) throw new Error('Funding transaction VM validation failed');
const providedFundingTxid = process.env.ADDON_CASHSCRIPT_FUNDING_TXID?.trim() || '';
const fundingTxid = existingContractUtxo || providedFundingTxid ? null : await broadcast(fundingHex);
if (fundingTxid) console.log(`funding txid: ${fundingTxid}`);
const contractUtxo = existingContractUtxo ?? await waitForUtxo(contract.address, providedFundingTxid || fundingTxid!, 0);
if (process.env.ADDON_CASHSCRIPT_FUND_ONLY === '1') {
  console.log(`generic CashScript contract funding visible at ${contract.address}`);
  process.exit(0);
}

const spend = new TransactionBuilder({ provider });
  spend.addInput(contractUtxo, contract.unlock.spend(Uint8Array.from(pubkey), new SignatureTemplate(source.privkey, SighashType.SIGHASH_ALL)));
spend.addOutput({ to: source.address, amount: contractUtxo.satoshis - 1_000n });
const spendHex = spend.build();
const spendTxid = await broadcast(spendHex);
console.log(`contract spend txid: ${spendTxid}`);
await waitForUtxo(source.address, spendTxid, 0);
console.log('generic CashScript Chipnet E2E passed: build, VM validation, broadcast, and mempool/provider visibility');

// Exercise a second deterministic contract shape using the same wallet-derived
// public key for both constructor identities, then return its BCH to the wallet.
const secondSource = await findCoin();
const secondPubkey = secp256k1.derivePublicKeyCompressed(secondSource.privkey);
if (typeof secondPubkey === 'string') throw new Error(secondPubkey);
const secondContract = new Contract(
  transferWithTimeoutArtifact,
  [binToHex(Uint8Array.from(secondPubkey)), binToHex(Uint8Array.from(secondPubkey)), 0n],
  { provider, contractType: 'p2sh32', addressType: 'p2sh32' } as never,
);
const secondFunding = new TransactionBuilder({ provider });
secondFunding.addInput(
  { txid: secondSource.coin.tx_hash, vout: secondSource.coin.tx_pos, satoshis: BigInt(secondSource.coin.value), lockingBytecode: binToHex(cashAddressToLockingBytecode(secondSource.address).bytecode) },
  new SignatureTemplate(secondSource.privkey, SighashType.SIGHASH_ALL).unlockP2PKH(),
);
secondFunding.addOutputs([
  { to: secondContract.address, amount: 10_000n },
  { to: secondSource.address, amount: BigInt(secondSource.coin.value - 10_000 - 1_000) },
]);
const secondFundingTxid = await broadcast(secondFunding.build());
const secondUtxo = await waitForUtxo(secondContract.address, secondFundingTxid, 0);
const secondSpend = new TransactionBuilder({ provider });
secondSpend.addInput(
  secondUtxo,
  secondContract.unlock.transfer(new SignatureTemplate(secondSource.privkey, SighashType.SIGHASH_ALL)),
);
secondSpend.addOutput({ to: secondSource.address, amount: secondUtxo.satoshis - 1_000n });
const secondSpendTxid = await broadcast(secondSpend.build());
await waitForUtxo(secondSource.address, secondSpendTxid, 0);
console.log(`second deterministic contract (${secondContract.address}) returned funds: ${secondSpendTxid}`);
