import TransactionManager from '../../../../apis/TransactionManager/TransactionManager';
import TransactionService from '../../../../services/TransactionService';
import type { TransactionOutput } from '../../../../types/types';
import type {
  MintAppUtxo,
  MintBcmrPublication,
  MintOutputDraft,
  WalletAddressRecord,
} from '../types';
import { selectFeeCandidates } from './selectFeeCandidates';
import { buildBcmrPublicationOpReturn } from './bcmrOpReturn';
import {
  shortHash,
  sumOutputs,
  toBigIntSafe,
  utxoKey,
  utxoValue,
} from '../utils';
import {
  getMintSourceCategory,
  canMintFungibleFromSource,
  isSelectableMintSource,
  selectMintSourceUtxos,
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
  sdk?: unknown;
  selectedUtxos: MintAppUtxo[];
  flatUtxos: MintAppUtxo[];
  activeOutputDrafts: MintOutputDraft[];
  changeAddress: string;
  sdkAddressBook: WalletAddressRecord[];
  tokenOutputSats: number;
  bcmrPublication?: MintBcmrPublication;
};

const BCMR_IDENTITY_OUTPUT_SATS = 1000n;

function buildSelectedUtxosForSource(
  source: MintAppUtxo,
  inputsForBuild: MintAppUtxo[]
): MintAppUtxo[] {
  const sourceKey = utxoKey(source);
  return [
    source,
    ...inputsForBuild.filter((candidate) => utxoKey(candidate) !== sourceKey),
  ];
}

export async function buildMintPreview({
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
  if (selectedUtxos.length === 0) {
    throw new Error(
      'No valid source UTXO selected (requires a genesis UTXO or minting authority NFT).'
    );
  }
  if (selectedUtxos.some((source) => !isSelectableMintSource(source))) {
    throw new Error(
      'Only genesis UTXOs or minting authority NFTs can be used as mint sources.'
    );
  }

  const sourceInputs = selectMintSourceUtxos(selectedUtxos);
  if (sourceInputs.length === 0) {
    throw new Error(
      'No valid source UTXO selected (requires a genesis UTXO or minting authority NFT).'
    );
  }

  const sourceKeySet = new Set(sourceInputs.map((u) => utxoKey(u)));
  const feeCandidates = selectFeeCandidates(flatUtxos, sourceKeySet);
  const sourceByKey = new Map(sourceInputs.map((u) => [utxoKey(u), u] as const));

  if (feeCandidates.length === 0) {
    throw new Error('No non-token fee UTXOs available to fund transaction fees.');
  }

  const feeInputs: MintAppUtxo[] = [];
  let inputsForBuild: MintAppUtxo[] = [];
  let built: BuildResult | null = null;

  for (let i = 0; i < feeCandidates.length; i++) {
    feeInputs.push(feeCandidates[i]);
    inputsForBuild = sourceInputs.concat(feeInputs);

    const outputs: TransactionOutput[] = [];
    if (bcmrPublication?.enabled) {
      outputs.push({
        recipientAddress: changeAddress,
        amount: BCMR_IDENTITY_OUTPUT_SATS,
      });

      const publication = buildBcmrPublicationOpReturn({
        registryJson: bcmrPublication.registryJson,
        uris: bcmrPublication.uris,
      });
      outputs.push({ opReturn: publication.opReturn });
    }

    for (const d of activeOutputDrafts) {
      const src = sourceByKey.get(d.sourceKey);
      if (!src) continue;
      if (d.config.mintType === 'FT' && !canMintFungibleFromSource(src)) {
        throw new Error(
          'Minting authority sources can only mint NFT outputs.'
        );
      }
      const category = getMintSourceCategory(src);
      const isNFT = d.config.mintType === 'NFT';
      const tokenAmount = isNFT ? 0n : toBigIntSafe(d.config.ftAmount);
      const selectedUtxosForOutput = buildSelectedUtxosForSource(
        src,
        inputsForBuild
      );

      const out = TransactionManager().addOutput(
        d.recipientCashAddr,
        tokenOutputSats,
        tokenAmount,
        category,
        selectedUtxosForOutput,
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

    const retainedMintingAuthorities = new Set<string>();
    for (const src of sourceInputs) {
      if (src.token?.nft?.capability !== 'minting') continue;

      const sourceKey = utxoKey(src);
      if (retainedMintingAuthorities.has(sourceKey)) continue;
      retainedMintingAuthorities.add(sourceKey);

      // Preserve minting authority in a wallet-controlled successor output so
      // the category can mint again after this transaction confirms.
      const authorityOut = TransactionManager().addOutput(
        src.address || changeAddress,
        tokenOutputSats,
        0n,
        getMintSourceCategory(src),
        buildSelectedUtxosForSource(src, inputsForBuild),
        sdkAddressBook
      );

      if (!authorityOut) {
        throw new Error(
          `Failed retaining minting authority for ${shortHash(
            getMintSourceCategory(src),
            12,
            0
          )}`
        );
      }

      outputs.push(authorityOut);
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

  if (!built || built.errorMsg || !built.finalOutputs || !built.finalTransaction) {
    throw new Error(built?.errorMsg || 'Failed to build mint transaction.');
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
