import type { AddonSDK } from '../../../../services/AddonsSDK';
import type { TransactionOutput } from '../../../../types/types';
import type {
  MintAppUtxo,
  MintOutputDraft,
  WalletAddressRecord,
} from '../types';
import { selectFeeCandidates } from './selectFeeCandidates';
import {
  shortHash,
  sumOutputs,
  toBigIntSafe,
  utxoKey,
  utxoValue,
} from '../utils';

type SdkBuildResult = Awaited<ReturnType<AddonSDK['tx']['build']>>;

type BuildBootstrapPreviewParams = {
  sdk: AddonSDK;
  fundingUtxos: MintAppUtxo[];
  toAddress: string;
  changeAddress: string;
};

export async function buildBootstrapPreview({
  sdk,
  fundingUtxos,
  toAddress,
  changeAddress,
}: BuildBootstrapPreviewParams): Promise<{
  built: SdkBuildResult;
  feePaid: bigint;
}> {
  const outputs: TransactionOutput[] = [
    { recipientAddress: toAddress, amount: 1000n },
  ];

  const built = await sdk.tx.build({
    inputs: fundingUtxos,
    outputs,
    changeAddress,
  });
  if (built.errorMsg) throw new Error(built.errorMsg);
  if (!built.finalOutputs || !built.hex) {
    throw new Error('Failed to build bootstrap transaction.');
  }

  const totalInput = fundingUtxos.reduce((sum, u) => sum + utxoValue(u), 0n);
  const totalOutput = sumOutputs(built.finalOutputs);
  const feePaid = totalInput - totalOutput;

  return { built, feePaid };
}

type BuildMintPreviewParams = {
  sdk: AddonSDK;
  selectedUtxos: MintAppUtxo[];
  flatUtxos: MintAppUtxo[];
  activeOutputDrafts: MintOutputDraft[];
  changeAddress: string;
  sdkAddressBook: WalletAddressRecord[];
  tokenOutputSats: number;
};

export async function buildMintPreview({
  sdk,
  selectedUtxos,
  flatUtxos,
  activeOutputDrafts,
  changeAddress,
  sdkAddressBook,
  tokenOutputSats,
}: BuildMintPreviewParams): Promise<{
  built: SdkBuildResult;
  inputsForBuild: MintAppUtxo[];
  feePaid: bigint;
}> {
  const genesisInputs = selectedUtxos.filter((u) => u.tx_pos === 0 && !u.token);
  if (genesisInputs.length === 0) {
    throw new Error(
      'No valid Candidate UTXO selected (requires vout=0, non-token).'
    );
  }

  const genesisKeySet = new Set(genesisInputs.map((u) => utxoKey(u)));
  const feeCandidates = selectFeeCandidates(flatUtxos, genesisKeySet);
  const sourceByKey = new Map(genesisInputs.map((u) => [utxoKey(u), u]));

  if (feeCandidates.length === 0) {
    throw new Error('No non-genesis UTXOs available to fund transaction fees.');
  }

  let feeInputs: MintAppUtxo[] = [];
  let inputsForBuild: MintAppUtxo[] = [];
  let built: SdkBuildResult | null = null;

  for (let i = 0; i < feeCandidates.length; i++) {
    feeInputs = [...feeInputs, feeCandidates[i]];
    inputsForBuild = [...genesisInputs, ...feeInputs];

    const outputs: TransactionOutput[] = [];
    for (const d of activeOutputDrafts) {
      const src = sourceByKey.get(d.sourceKey);
      if (!src) continue;
      const category = src.tx_hash;
      const isNFT = d.config.mintType === 'NFT';
      const tokenAmount = isNFT ? 0n : toBigIntSafe(d.config.ftAmount);

      const out = sdk.tx.addOutput({
        recipientAddress: d.recipientCashAddr,
        transferAmount: tokenOutputSats,
        tokenAmount,
        selectedTokenCategory: category,
        selectedUtxos: inputsForBuild,
        addresses: sdkAddressBook,
        nftCapability: isNFT ? d.config.nftCapability : undefined,
        nftCommitment: isNFT ? d.config.nftCommitment : undefined,
      });

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

    const attempt = await sdk.tx.build({
      inputs: inputsForBuild,
      outputs,
      changeAddress,
    });
    if (!attempt.errorMsg) {
      built = attempt;
      break;
    }
  }

  if (!built || built.errorMsg || !built.finalOutputs || !built.hex) {
    throw new Error(built?.errorMsg || 'Failed to build mint transaction.');
  }

  const totalInput = inputsForBuild.reduce((sum, u) => sum + utxoValue(u), 0n);
  const totalOutput = sumOutputs(built.finalOutputs);
  const feePaid = totalInput - totalOutput;

  return { built, inputsForBuild, feePaid };
}
