import { TOKEN_OUTPUT_SATS } from '../../../../utils/constants';
import { toTokenAwareCashAddress } from '../../../../utils/cashAddress';
import TransactionService from '../../../../services/TransactionService';
import type { TransactionOutput, UTXO } from '../../../../types/types';
import type { PaperWalletSweepPlan, PaperWalletSweepTokenGroup } from '../types';

const DUST_SATS = 546n;

function satoshisOf(utxo: UTXO): bigint {
  const raw = utxo.value ?? utxo.amount ?? 0;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(Math.trunc(raw));
  if (typeof raw === 'string') return amountToBigInt(raw);
  return 0n;
}

function amountToBigInt(value: number | bigint | string | undefined): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    try {
      return BigInt(value.trim() || '0');
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function groupTokenUtxos(utxos: UTXO[]): PaperWalletSweepTokenGroup[] {
  const byCategory = new Map<string, UTXO[]>();

  for (const utxo of utxos) {
    const category = utxo.token?.category;
    if (!category) continue;
    const bucket = byCategory.get(category) ?? [];
    bucket.push(utxo);
    byCategory.set(category, bucket);
  }

  return [...byCategory.entries()].map(([category, tokenUtxos]) => {
    const hasNft = tokenUtxos.some((u) => !!u.token?.nft);
    const totalAmount = tokenUtxos.reduce((sum, utxo) => {
      const raw = utxo.token?.amount ?? 0;
      const amt =
        typeof raw === 'bigint' ? raw : BigInt(Math.trunc(Number(raw) || 0));
      return sum + amt;
    }, 0n);

    return { category, tokenUtxos, totalAmount, hasNft };
  });
}

function toCombinedOutput(
  destinationAddress: string,
  tokenGroup: PaperWalletSweepTokenGroup
): TransactionOutput {
  const tokenAddress = toTokenAwareCashAddress(destinationAddress);

  if (tokenGroup.hasNft) {
    const nftUtxo = tokenGroup.tokenUtxos.find((u) => !!u.token?.nft);
    if (!nftUtxo?.token?.nft) {
      throw new Error(`Missing NFT metadata for category ${tokenGroup.category}`);
    }

    return {
      recipientAddress: tokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: tokenGroup.category,
        amount: 0n,
        nft: {
          capability: nftUtxo.token.nft.capability,
          commitment: nftUtxo.token.nft.commitment,
        },
      },
    };
  }

  return {
    recipientAddress: tokenAddress,
    amount: TOKEN_OUTPUT_SATS,
    token: {
      category: tokenGroup.category,
      amount: tokenGroup.totalAmount,
    },
  };
}

export async function buildPaperWalletSweepPlan(args: {
  paperWalletAddress: string;
  destinationAddress: string;
  paperWalletUtxos: UTXO[];
  walletFeeUtxos: UTXO[];
}): Promise<PaperWalletSweepPlan> {
  const { paperWalletAddress, destinationAddress, paperWalletUtxos, walletFeeUtxos } =
    args;

  const paperWalletBchUtxos = paperWalletUtxos.filter((u) => !u.token);
  const paperWalletTokenUtxos = paperWalletUtxos.filter((u) => !!u.token);
  const tokenGroups = groupTokenUtxos(paperWalletTokenUtxos);

  const outputs: TransactionOutput[] = [];
  let paperWalletBchTotal = 0n;
  for (const utxo of paperWalletBchUtxos) {
    paperWalletBchTotal += satoshisOf(utxo);
  }

  for (const group of tokenGroups) {
    outputs.push(toCombinedOutput(destinationAddress, group));
  }

  if (outputs.length === 0 && paperWalletBchTotal > 0n) {
    outputs.push({
      recipientAddress: toTokenAwareCashAddress(destinationAddress),
      amount: DUST_SATS,
    });
  }

  const baseBchInputs = paperWalletBchUtxos;
  if (baseBchInputs.length + walletFeeUtxos.length === 0 && outputs.length === 0) {
    throw new Error('No spendable paper wallet funds were found.');
  }

  // Single-transaction invariant:
  // build one combined sweep; if fee coverage is insufficient, top up with
  // wallet BCH inputs, but never split the sweep into multiple transactions.
  const attemptBuild = async (feeInputs: UTXO[]) => {
    const inputs = [...paperWalletUtxos, ...feeInputs];
    const built = await TransactionService.buildTransaction(
      outputs,
      null,
      destinationAddress,
      inputs
    );
    return built;
  };

  const paperOnlyBuild = await attemptBuild([]);
  const feeInputs = paperOnlyBuild.errorMsg ? walletFeeUtxos : [];
  const built = paperOnlyBuild.errorMsg
    ? await attemptBuild(feeInputs)
    : paperOnlyBuild;

  if (built.errorMsg) {
    throw new Error(built.errorMsg);
  }

  const finalOutputs = (built.finalOutputs ?? outputs).filter(
    (out): out is Extract<TransactionOutput, { recipientAddress: string }> =>
      !('opReturn' in out && out.opReturn !== undefined)
  );
  const totalOutput = finalOutputs.reduce((sum, out) => {
    const amount = amountToBigInt(out.amount);
    return sum + amount;
  }, 0n);

  const totalInput = [...paperWalletUtxos, ...feeInputs].reduce(
    (sum, utxo) => sum + satoshisOf(utxo),
    0n
  );

  if (totalInput < totalOutput) {
    throw new Error('Sweep plan would spend more than available inputs.');
  }

  if (finalOutputs.some((o) => !('opReturn' in o) && !o.token && BigInt(Math.trunc(Number(o.amount) || 0)) < DUST_SATS)) {
    throw new Error('Sweep plan produced a sub-dust BCH output.');
  }

  return {
    paperWalletAddress,
    destinationAddress,
    paperWalletUtxos,
    feeInputs,
    outputs: finalOutputs as PaperWalletSweepPlan['outputs'],
    paperWalletBchTotal,
    tokenGroups,
  };
}
