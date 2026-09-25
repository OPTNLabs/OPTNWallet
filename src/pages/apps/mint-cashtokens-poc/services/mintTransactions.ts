import { decodeTransaction, hexToBin } from '@bitauth/libauth';

import TransactionManager from '../../../../apis/TransactionManager/TransactionManager';
import TransactionService from '../../../../services/TransactionService';
import type { TransactionOutput } from '../../../../types/types';
import { toTokenAwareCashAddress } from '../../../../utils/cashAddress';
import type {
  MintAppUtxo,
  MintBcmrPublication,
  MintOutputDraft,
  WalletAddressRecord,
} from '../types';
import { selectFeeCandidates } from './selectFeeCandidates';
import { buildBcmrPublicationOpReturn } from './bcmrOpReturn';
import { readBcmrPublication } from './bcmrRegistryGenerator';
import { sha256 } from '../../../../utils/hash';
import {
  shortHash,
  sumOutputs,
  toBigIntSafe,
  utxoKey,
  utxoValue,
} from '../utils';
import {
  isGenesisMintSource,
  isMintingAuthorityMintSource,
  isSelectableMintSource,
} from '../utils/sourceHelpers';

type BuildResult = Awaited<
  ReturnType<typeof TransactionService.buildTransaction>
> & {
  bytes: number;
  hex: string;
};

type BuildBootstrapPreviewParams = {
  sdk?: unknown;
  fundingUtxos: MintAppUtxo[];
  toAddress: string;
  changeAddress: string;
};

export async function buildBootstrapPreview({
  fundingUtxos,
  toAddress,
  changeAddress,
}: BuildBootstrapPreviewParams): Promise<{
  built: BuildResult;
  feePaid: bigint;
}> {
  const outputs: TransactionOutput[] = [
    { recipientAddress: toAddress, amount: 1000n },
  ];

  const built = await TransactionService.buildTransaction(
    outputs,
    null,
    changeAddress,
    fundingUtxos
  );
  if (built.errorMsg) throw new Error(built.errorMsg);
  if (!built.finalOutputs || !built.finalTransaction) {
    throw new Error('Failed to build bootstrap transaction.');
  }

  const totalInput = fundingUtxos.reduce((sum, u) => sum + utxoValue(u), 0n);
  const totalOutput = sumOutputs(built.finalOutputs);
  const feePaid = totalInput - totalOutput;

  return {
    built: {
      ...built,
      bytes: built.bytecodeSize,
      hex: built.finalTransaction,
    },
    feePaid,
  };
}

type BuildMintPreviewParams = {
  sdk?: {
    tx?: {
      addOutput?: (
        recipientAddress: string,
        tokenOutputSats: number,
        tokenAmount: bigint,
        category: string,
        inputsForBuild: MintAppUtxo[],
        sdkAddressBook: WalletAddressRecord[],
        nftCapability?: undefined | 'none' | 'mutable' | 'minting',
        nftCommitment?: string
      ) => TransactionOutput | undefined;
    };
  } | null;
  selectedUtxos: MintAppUtxo[];
  flatUtxos: MintAppUtxo[];
  activeOutputDrafts: MintOutputDraft[];
  changeAddress: string;
  sdkAddressBook: WalletAddressRecord[];
  tokenOutputSats: number;
  bcmrPublication?: MintBcmrPublication;
};

const BCMR_IDENTITY_OUTPUT_SATS = 1000n;

function toBigIntAmount(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return 0n;
}

function tokenAddressFor(
  address: string,
  addressBook: WalletAddressRecord[]
): string {
  return (
    addressBook.find((entry) => entry.address === address)?.tokenAddress ||
    toTokenAwareCashAddress(address)
  );
}

/**
 * The output that keeps a spent minting NFT alive.
 *
 * Consensus lets a transaction destroy an NFT simply by not re-creating it,
 * and the CashScript builder only guards fungible amounts. Minting from an
 * authority therefore has to put the authority back explicitly — same
 * category, same commitment, any fungible amount it carried — or the token can
 * never be minted again.
 */
function mintingAuthorityReturnOutput(
  authority: MintAppUtxo,
  changeAddress: string,
  addressBook: WalletAddressRecord[],
  tokenOutputSats: number
): TransactionOutput {
  const token = authority.token!;
  return {
    recipientAddress: tokenAddressFor(changeAddress, addressBook),
    amount: tokenOutputSats,
    token: {
      category: token.category,
      amount: toBigIntAmount(token.amount),
      nft: {
        capability: 'minting',
        commitment: token.nft?.commitment ?? '',
      },
    },
  };
}

/**
 * Refuse a built mint that would lose something it cannot get back.
 *
 * Checked against the builder's final outputs, not the requested ones, so a
 * builder that reorders or drops outputs cannot slip past.
 */
function assertMintPreservesAuthority(
  inputs: MintAppUtxo[],
  finalOutputs: TransactionOutput[],
  changeAddress: string,
  needsIdentityOutput: boolean
): void {
  for (const input of inputs) {
    if (!isMintingAuthorityMintSource(input)) continue;
    const category = input.token!.category;
    const kept = finalOutputs.some(
      (output) =>
        output.token?.category === category &&
        output.token.nft?.capability === 'minting'
    );
    if (!kept) {
      throw new Error(
        `Refusing to build: the minting NFT for ${shortHash(
          category,
          12,
          0
        )} would be destroyed.`
      );
    }
  }

  if (needsIdentityOutput) {
    const first = finalOutputs[0];
    const walletOwned =
      !!first &&
      !('opReturn' in first && first.opReturn) &&
      !first.token &&
      first.recipientAddress === changeAddress;
    if (!walletOwned) {
      throw new Error(
        'Refusing to build: output 0 must stay in this wallet so the token metadata can be updated later.'
      );
    }
  }
}

const BCMR_PUBLICATION_PREFIX = [0x6a, 0x04, 0x42, 0x43, 0x4d, 0x52];

function isBcmrPrefixed(lockingBytecode: Uint8Array): boolean {
  return BCMR_PUBLICATION_PREFIX.every(
    (byte, index) => lockingBytecode[index] === byte
  );
}

/**
 * Read the publication back out of the transaction that will be signed.
 *
 * The builder is handed text chunks and encodes them itself, so the requested
 * outputs say nothing certain about the bytes on chain. The first
 * `OP_RETURN <'BCMR'>` output is the definitive one by the specification — a
 * malformed first match is not rescued by a later one — so that is the output
 * checked, with the same reader the wallet uses for other tokens' metadata.
 */
function assertPublishesRegistry(
  transactionHex: string,
  publication: MintBcmrPublication
): void {
  const decoded = decodeTransaction(hexToBin(transactionHex));
  if (typeof decoded === 'string') {
    throw new Error(
      `Refusing to build: could not read back the mint transaction (${decoded}).`
    );
  }
  const output = decoded.outputs.find((candidate) =>
    isBcmrPrefixed(candidate.lockingBytecode)
  );
  const read = output ? readBcmrPublication(output.lockingBytecode) : undefined;
  const expectedUris = publication.uris
    .map((uri) => uri.trim())
    .filter(Boolean);
  const matches =
    !!read &&
    read.sha256 === sha256.text(publication.registryJson) &&
    read.uris.length === expectedUris.length &&
    read.uris.every((uri, index) => uri === expectedUris[index]);
  if (!matches) {
    throw new Error(
      'Refusing to build: the transaction does not publish the uploaded token metadata.'
    );
  }
}

export async function buildMintPreview({
  sdk,
  selectedUtxos,
  flatUtxos,
  activeOutputDrafts,
  changeAddress,
  sdkAddressBook,
  tokenOutputSats,
  bcmrPublication,
}: BuildMintPreviewParams): Promise<{
  built: BuildResult;
  inputsForBuild: MintAppUtxo[];
  feePaid: bigint;
}> {
  const invalidSource = selectedUtxos.find(
    (utxo) => !isSelectableMintSource(utxo)
  );
  if (invalidSource) {
    throw new Error(
      'Only genesis UTXOs or minting authority NFTs can be used as mint sources.'
    );
  }

  const mintInputs = selectedUtxos.filter(isSelectableMintSource);
  if (mintInputs.length === 0) {
    throw new Error(
      'No valid mint source selected (requires a genesis UTXO or minting authority NFT).'
    );
  }

  const sourceByKey = new Map(mintInputs.map((u) => [utxoKey(u), u]));
  const hasGenesisSource = mintInputs.some(isGenesisMintSource);
  if (bcmrPublication?.enabled && !hasGenesisSource) {
    // A publication only counts in a transaction that spends the identity
    // output; minting from an authority NFT does not, so wallets would ignore
    // it and the upload would be wasted.
    throw new Error(
      'Token metadata can only be published when creating a token from a genesis UTXO.'
    );
  }
  // Output 0 of a transaction spending an output 0 continues that identity's
  // chain: whoever holds it controls the token's metadata. Keep it here.
  const needsIdentityOutput = mintInputs.some((u) => u.tx_pos === 0);

  const authorityInputs = mintInputs.filter(isMintingAuthorityMintSource);
  const authoritiesToReturn = authorityInputs.filter((authority) => {
    const category = authority.token!.category;
    // A drafted minting NFT of the same category already carries the
    // authority forward; returning the input as well would duplicate it.
    return !activeOutputDrafts.some((draft) => {
      const src = sourceByKey.get(draft.sourceKey);
      return (
        draft.config.mintType === 'NFT' &&
        draft.config.nftCapability === 'minting' &&
        (src?.token?.category ?? src?.tx_hash) === category
      );
    });
  });

  const mintSourceKeySet = new Set(mintInputs.map((u) => utxoKey(u)));
  const feeCandidates = selectFeeCandidates(flatUtxos, mintSourceKeySet);

  if (feeCandidates.length === 0) {
    throw new Error('No non-genesis UTXOs available to fund transaction fees.');
  }

  const feeInputs: MintAppUtxo[] = [];
  let inputsForBuild: MintAppUtxo[] = [];
  let built: BuildResult | null = null;
  const addOutputFromSdk = sdk?.tx?.addOutput;
  const addOutputFromManager = TransactionManager().addOutput;

  for (let i = 0; i < feeCandidates.length; i++) {
    feeInputs.push(feeCandidates[i]);
    inputsForBuild = mintInputs.concat(feeInputs);

    const outputs: TransactionOutput[] = [];
    if (needsIdentityOutput) {
      outputs.push({
        recipientAddress: changeAddress,
        amount: BCMR_IDENTITY_OUTPUT_SATS,
      });
    }
    if (bcmrPublication?.enabled) {
      const publication = buildBcmrPublicationOpReturn({
        registryJson: bcmrPublication.registryJson,
        uris: bcmrPublication.uris,
      });
      outputs.push({ opReturn: publication.opReturn });
    }

    for (const d of activeOutputDrafts) {
      const src = sourceByKey.get(d.sourceKey);
      if (!src) continue;
      const category = src.token?.category ?? src.tx_hash;
      const isNFT = d.config.mintType === 'NFT';
      const tokenAmount = isNFT ? 0n : toBigIntSafe(d.config.ftAmount);

      const out = addOutputFromSdk
        ? addOutputFromSdk(
            d.recipientCashAddr,
            tokenOutputSats,
            tokenAmount,
            category,
            inputsForBuild,
            sdkAddressBook,
            isNFT ? d.config.nftCapability : undefined,
            isNFT ? d.config.nftCommitment : undefined
          )
        : addOutputFromManager(
            d.recipientCashAddr,
            tokenOutputSats,
            tokenAmount,
            category,
            inputsForBuild,
            sdkAddressBook,
            isNFT ? d.config.nftCapability : undefined,
            isNFT ? d.config.nftCommitment : undefined
          );

      if (!out) {
        throw new Error(
          `Failed creating output for ${shortHash(
            category,
            12,
            0
          )} → ${shortHash(d.recipientCashAddr, 12, 8)}`
        );
      }
      outputs.push(out);
    }

    for (const authority of authoritiesToReturn) {
      outputs.push(
        mintingAuthorityReturnOutput(
          authority,
          changeAddress,
          sdkAddressBook,
          tokenOutputSats
        )
      );
    }

    const attempt = await TransactionService.buildTransaction(
      outputs,
      null,
      changeAddress,
      inputsForBuild
    );
    if (!attempt.errorMsg) {
      built = {
        ...attempt,
        bytes: attempt.bytecodeSize,
        hex: attempt.finalTransaction,
      };
      break;
    }
  }

  if (
    !built ||
    built.errorMsg ||
    !built.finalOutputs ||
    !built.finalTransaction
  ) {
    throw new Error(built?.errorMsg || 'Failed to build mint transaction.');
  }

  assertMintPreservesAuthority(
    inputsForBuild,
    built.finalOutputs,
    changeAddress,
    needsIdentityOutput
  );
  if (bcmrPublication?.enabled) {
    assertPublishesRegistry(built.finalTransaction, bcmrPublication);
  }

  const totalInput = inputsForBuild.reduce((sum, u) => sum + utxoValue(u), 0n);
  const totalOutput = sumOutputs(built.finalOutputs);
  const feePaid = totalInput - totalOutput;

  return {
    built: {
      ...built,
      bytes: built.bytecodeSize,
      hex: built.finalTransaction,
    },
    inputsForBuild,
    feePaid,
  };
}
