import { lockingBytecodeToCashAddress } from '@bitauth/libauth';
import {
  Contract,
  ElectrumNetworkProvider,
  Network,
} from 'cashscript';

import type { AddonSDK } from '../AddonsSDK';
import { getParyonArtifact } from './ParyonService';
import type { ParyonContractBundleName, ParyonWorkspaceSnapshot } from './types';
import type { ParyonNativeSnapshot } from './native';

function toNetwork(network: string | null | undefined): Network {
  return network === 'chipnet' ? Network.CHIPNET : Network.MAINNET;
}

function providerFor(network: string | null | undefined) {
  return new ElectrumNetworkProvider(toNetwork(network));
}

function normalizeHex(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/^0x/i, '').replace(/^\\x/i, '').toLowerCase();
}

function littleEndianHex(value: bigint, byteCount: number): string {
  const hex = value.toString(16).padStart(byteCount * 2, '0');
  return hex.match(/../g)?.reverse().join('') ?? '';
}

function contractNodeFromSnapshot(
  snapshot: ParyonWorkspaceSnapshot,
  name: ParyonContractBundleName
) {
  const node = snapshot.contractsByName[name];
  if (!node || !node.resolved) {
    throw new Error(`Unable to resolve ${name} against the current bundle.`);
  }
  return node;
}

function makeContract(
  sdk: AddonSDK,
  snapshot: ParyonWorkspaceSnapshot,
  name: ParyonContractBundleName,
  constructorInputs?: unknown[]
) {
  const node = contractNodeFromSnapshot(snapshot, name);
  return new Contract(getParyonArtifact(name) as never, (constructorInputs ?? node.constructorInputs) as never, {
    provider: providerFor(sdk.wallet.getContext().network),
    addressType: 'p2sh32',
  });
}

function getContractInputs<T extends { token?: { category?: string; nft?: { capability?: string; commitment?: string } }; tx_hash?: string; tx_pos?: number }>(
  utxos: T[],
  predicate: (utxo: T) => boolean
): T {
  const selected = utxos.find(predicate);
  if (!selected) {
    throw new Error('Required live contract UTXO was not found.');
  }
  return selected;
}

function protocolFeeAddressFromBytecode(
  bytecode: string,
  network: string | null | undefined
): string {
  const result = lockingBytecodeToCashAddress({
    bytecode: Uint8Array.from(Buffer.from(normalizeHex(bytecode), 'hex')),
    prefix: network === 'chipnet' ? 'bchtest' : 'bitcoincash',
  });
  if (typeof result === 'string') {
    throw new Error(result);
  }
  return result.address;
}

function parseParyonAmount(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  const [whole, fraction = ''] = trimmed.split('.');
  const wholePart = BigInt(whole || '0');
  const fractionPart = BigInt((fraction.padEnd(2, '0').slice(0, 2) || '0'));
  return wholePart * 100n + fractionPart;
}

type TransactionPlanBuilder = {
  from(input: unknown, unlocker?: unknown): TransactionPlanBuilder;
  fromP2PKH(input: unknown, signatureTemplate: unknown): TransactionPlanBuilder;
  to(
    recipientAddress: string,
    amount: bigint,
    token?: {
      amount: bigint;
      category: string;
      nft?: {
        capability: 'none' | 'mutable' | 'minting';
        commitment: string;
      };
    }
  ): TransactionPlanBuilder;
  withoutChange(): TransactionPlanBuilder;
  withoutTokenChange(): TransactionPlanBuilder;
  build(): Promise<string>;
};

export async function executeBorrowLoan(args: {
  sdk: AddonSDK;
  snapshot: ParyonWorkspaceSnapshot;
  nativeSnapshot: ParyonNativeSnapshot;
  borrowAmountText: string;
  collateralBchText: string;
  startingInterest?: string;
  interestManagerConfiguration?: string;
}): Promise<{ txid: string | null; hex: string }> {
  const { sdk, snapshot, borrowAmountText, collateralBchText } = args;
  if (snapshot.readiness !== 'ready') {
    throw new Error('Deployment config is missing.');
  }
  if (!args.nativeSnapshot.market.writeEnabled || !snapshot.verifiedMainnetV1) {
    throw new Error('Live borrow flow is only enabled for verified mainnet-v1.');
  }

  const borrowAtomic = parseParyonAmount(borrowAmountText);
  const collateralSats = BigInt(Math.round(Number(collateralBchText || '0') * 100_000_000));
  if (borrowAtomic <= 0n) {
    throw new Error('Borrow amount must be greater than zero.');
  }
  if (collateralSats <= 0n) {
    throw new Error('Collateral amount must be greater than zero.');
  }

  const primaryAddress = await sdk.wallet.getPrimaryAddress();
  if (!primaryAddress) {
    throw new Error('No primary wallet address available.');
  }
  const tokenAddress = await sdk.wallet.toTokenAddress(primaryAddress);
  const signatureTemplate = await sdk.signing.signatureTemplateForAddress(primaryAddress);
  const walletUtxos = await sdk.utxos.listForWallet();
  const feeUtxo = walletUtxos.allUtxos.find(
    (utxo) => !utxo.token && BigInt(utxo.value ?? utxo.amount ?? 0) > collateralSats + 2500n
  );
  if (!feeUtxo) {
    throw new Error('No BCH fee input is available for the borrow transaction.');
  }

  const borrowing = makeContract(sdk, snapshot, 'Borrowing');
  const priceContract = makeContract(sdk, snapshot, 'PriceContract');
  const enforcer = makeContract(sdk, snapshot, 'LoanKeyOriginEnforcer');
  const proof = makeContract(sdk, snapshot, 'LoanKeyOriginProof');

  const borrowingUtxo = getContractInputs(await borrowing.getUtxos(), (utxo) =>
    normalizeHex(utxo.token?.category) === normalizeHex(snapshot.config.tokenIds.paryonTokenId) &&
    String(utxo.token?.nft?.commitment ?? '').length > 0
  );
  const priceUtxo = getContractInputs(await priceContract.getUtxos(), (utxo) =>
    normalizeHex(utxo.token?.category) === normalizeHex(snapshot.config.tokenIds.paryonTokenId) &&
    utxo.token?.nft?.capability === 'mutable'
  );
  const enforcerUtxo = getContractInputs(await enforcer.getUtxos(), (utxo) =>
    normalizeHex(utxo.token?.category).startsWith(normalizeHex(snapshot.config.tokenIds.loanKeyFactoryTokenId)) &&
    utxo.token?.nft?.capability === 'minting'
  );
  const proofUtxo = getContractInputs(await proof.getUtxos(), (utxo) =>
    normalizeHex(utxo.token?.category) === normalizeHex(snapshot.config.tokenIds.loanKeyFactoryTokenId)
  );

  const startingInterest = args.startingInterest?.trim() || '0000';
  const interestManagerConfiguration = args.interestManagerConfiguration?.trim() || '0000000000';
  const periodBorrowingBytes = normalizeHex(String(borrowingUtxo.token?.nft?.commitment ?? '')).slice(0, 8) || '00000000';
  const borrowedAmountBytes = littleEndianHex(borrowAtomic, 6);
  const zeroBytes6 = '000000000000';
  const loanCommitment = `01${borrowedAmountBytes}${zeroBytes6}00${periodBorrowingBytes}${startingInterest.padStart(4, '0').slice(0, 4)}${startingInterest.padStart(4, '0').slice(0, 4)}${interestManagerConfiguration.padStart(10, '0').slice(0, 10)}`;

  const feeAddress = protocolFeeAddressFromBytecode(
    snapshot.config.protocolFeeLockingBytecode,
    snapshot.network
  );

  const loanKeyTokenId = normalizeHex(enforcerUtxo.token?.category ?? '').slice(0, 64);
  const outputTokenCategory = snapshot.config.tokenIds.paryonTokenId;

  const tx = (
    borrowing as unknown as {
      unlock: {
        borrow(startingInterest: unknown, interestManagerConfiguration: unknown): TransactionPlanBuilder;
      };
    }
  ).unlock.borrow(
    Buffer.from(startingInterest, 'hex'),
    Buffer.from(interestManagerConfiguration, 'hex')
  )
    .from(borrowingUtxo)
    .from(
      priceUtxo,
      (
        priceContract as unknown as {
          unlock: { sharePrice(): unknown };
        }
      ).unlock.sharePrice()
    )
    .from(
      enforcerUtxo,
      (
        enforcer as unknown as {
          unlock: { enforce(): unknown };
        }
      ).unlock.enforce()
    )
    .from(
      proofUtxo,
      (
        proof as unknown as {
          unlock: { attach(): unknown };
        }
      ).unlock.attach()
    )
    .fromP2PKH(feeUtxo, signatureTemplate)
    .to(contractNodeFromSnapshot(snapshot, 'Borrowing').address, borrowingUtxo.satoshis, {
      amount: borrowingUtxo.token?.amount ?? 0n,
      category: outputTokenCategory,
      nft: borrowingUtxo.token?.nft ?? { capability: 'mutable', commitment: borrowingUtxo.token?.nft?.commitment ?? '' },
    })
    .to(contractNodeFromSnapshot(snapshot, 'PriceContract').address, priceUtxo.satoshis, {
      amount: 0n,
      category: outputTokenCategory,
      nft: priceUtxo.token?.nft ?? { capability: 'mutable', commitment: priceUtxo.token?.nft?.commitment ?? '' },
    })
    .to(contractNodeFromSnapshot(snapshot, 'Loan').address, collateralSats, {
      amount: 0n,
      category: outputTokenCategory,
      nft: {
        capability: 'mutable',
        commitment: loanCommitment,
      },
    })
    .to(contractNodeFromSnapshot(snapshot, 'LoanSidecar').address, 1000n, {
      amount: 0n,
      category: loanKeyTokenId,
      nft: {
        capability: 'none',
        commitment: '01',
      },
    })
    .to(feeAddress, 1000n)
    .to(tokenAddress, 1000n, {
      amount: 0n,
      category: loanKeyTokenId,
      nft: {
        capability: 'minting',
        commitment: '',
      },
    })
    .to(tokenAddress, 1000n, {
      amount: borrowAtomic,
      category: outputTokenCategory,
    })
    .withoutChange()
    .withoutTokenChange();

  const feeChange = BigInt(feeUtxo.value ?? feeUtxo.amount ?? 0) - 4000n;
  if (feeChange > 546n) {
    tx.to(primaryAddress, feeChange);
  }

  const hex = await tx.build();
  const sent = await sdk.tx.broadcast(hex);
  if (sent.errorMessage) {
    throw new Error(sent.errorMessage);
  }

  return { txid: sent.txid, hex };
}

export async function executeStakeLiquidity(args: {
  sdk: AddonSDK;
  snapshot: ParyonWorkspaceSnapshot;
  nativeSnapshot: ParyonNativeSnapshot;
  stakeAmountText: string;
}): Promise<{ txid: string | null; hex: string }> {
  const { sdk, snapshot, stakeAmountText } = args;
  if (snapshot.readiness !== 'ready') {
    throw new Error('Deployment config is missing.');
  }
  if (!args.nativeSnapshot.market.writeEnabled || !snapshot.verifiedMainnetV1) {
    throw new Error('Live stake flow is only enabled for verified mainnet-v1.');
  }

  const stakeAtomic = parseParyonAmount(stakeAmountText);
  if (stakeAtomic < 10000n) {
    throw new Error('Stake amount must be at least 100.00 PUSD.');
  }

  const primaryAddress = await sdk.wallet.getPrimaryAddress();
  if (!primaryAddress) {
    throw new Error('No primary wallet address available.');
  }
  const tokenAddress = await sdk.wallet.toTokenAddress(primaryAddress);
  const signatureTemplate = await sdk.signing.signatureTemplateForAddress(primaryAddress);
  const walletUtxos = await sdk.utxos.listForWallet();
  const tokenInput = walletUtxos.tokenUtxos.find(
    (utxo) =>
      normalizeHex(utxo.token?.category) === normalizeHex(snapshot.config.tokenIds.paryonTokenId) &&
      BigInt(utxo.token?.amount ?? 0) >= stakeAtomic
  );
  if (!tokenInput) {
    throw new Error('No PUSD token input is available to stake.');
  }
  const feeUtxo = walletUtxos.allUtxos.find(
    (utxo) => !utxo.token && BigInt(utxo.value ?? utxo.amount ?? 0) > 2500n
  );
  if (!feeUtxo) {
    throw new Error('No BCH fee input is available for the stake transaction.');
  }

  const stabilityPool = makeContract(sdk, snapshot, 'StabilityPool');
  const stabilitySidecar = makeContract(sdk, snapshot, 'StabilityPoolSidecar');
  const addLiquidity = makeContract(sdk, snapshot, 'AddLiquidity');

  const poolUtxo = getContractInputs(await stabilityPool.getUtxos(), (utxo) =>
    normalizeHex(utxo.token?.category) === normalizeHex(snapshot.config.tokenIds.poolTokenId)
  );
  const sidecarUtxo = getContractInputs(await stabilitySidecar.getUtxos(), (utxo) =>
    normalizeHex(utxo.token?.category) === normalizeHex(snapshot.config.tokenIds.paryonTokenId)
  );
  const functionUtxo = getContractInputs(await addLiquidity.getUtxos(), (utxo) =>
    normalizeHex(utxo.token?.category) === normalizeHex(snapshot.config.tokenIds.paryonTokenId) &&
    utxo.token?.nft?.capability === 'none'
  );

  const currentEpoch = Number.parseInt(
    String(poolUtxo.token?.nft?.commitment ?? '0').slice(0, 8) || '0',
    16
  );
  const nextEpoch = Number.isFinite(currentEpoch) ? currentEpoch + 1 : 1;
  const receiptCommitment = `${nextEpoch.toString(16).padStart(8, '0')}${littleEndianHex(stakeAtomic, 6)}`;
  const updatedSidecarAmount = BigInt(sidecarUtxo.token?.amount ?? 0) + stakeAtomic;

  const tx = (
    addLiquidity as unknown as {
      unlock: { addToPool(): TransactionPlanBuilder };
    }
  ).unlock.addToPool()
    .from(poolUtxo)
    .from(sidecarUtxo)
    .from(functionUtxo)
    .fromP2PKH(tokenInput, signatureTemplate)
    .fromP2PKH(feeUtxo, signatureTemplate)
    .to(contractNodeFromSnapshot(snapshot, 'StabilityPool').address, BigInt((poolUtxo as { value?: number | bigint }).value ?? 0), {
      amount: poolUtxo.token?.amount ?? 0n,
      category: snapshot.config.tokenIds.poolTokenId,
      nft: poolUtxo.token?.nft ?? { capability: 'minting', commitment: poolUtxo.token?.nft?.commitment ?? '' },
    })
    .to(contractNodeFromSnapshot(snapshot, 'StabilityPoolSidecar').address, BigInt((sidecarUtxo as { value?: number | bigint }).value ?? 0), {
      amount: updatedSidecarAmount,
      category: snapshot.config.tokenIds.paryonTokenId,
      nft: sidecarUtxo.token?.nft ?? { capability: 'none', commitment: sidecarUtxo.token?.nft?.commitment ?? '' },
    })
    .to(contractNodeFromSnapshot(snapshot, 'AddLiquidity').address, 1000n, {
      amount: 0n,
      category: snapshot.config.tokenIds.paryonTokenId,
      nft: functionUtxo.token?.nft ?? { capability: 'none', commitment: '01' },
    })
    .to(tokenAddress, 1000n, {
      amount: 0n,
      category: snapshot.config.tokenIds.poolTokenId,
      nft: { capability: 'none', commitment: receiptCommitment },
    })
    .withoutChange()
    .withoutTokenChange();

  const feeChange = BigInt(feeUtxo.value ?? feeUtxo.amount ?? 0) - 1000n;
  if (feeChange > 546n) {
    tx.to(primaryAddress, feeChange);
  }

  const hex = await tx.build();
  const sent = await sdk.tx.broadcast(hex);
  if (sent.errorMessage) {
    throw new Error(sent.errorMessage);
  }
  return { txid: sent.txid, hex };
}
