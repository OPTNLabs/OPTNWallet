import { TransactionOutput, UTXO } from '../../types/types';
import TransactionService from '../../services/TransactionService';
import { DUST, TOKEN_OUTPUT_SATS } from '../../utils/constants';
import { toErrorMessage } from '../../utils/errorHandling';
import { toTokenAwareCashAddress } from '../../utils/cashAddress';
import { BuildResult, BchBuildResult } from './types';
import { isConfirmed, sortLargestFirst, sumInputsSats } from './helpers';

type PlannerParams = {
  recipient: string;
  selectedCategory: string;
  amountToken: string;
  tokenChangeAddress: string;
  selectedChangeAddress: string;
  dbUtxos: UTXO[];
};

export function createSimpleSendPlanner({
  recipient,
  selectedCategory,
  amountToken,
  tokenChangeAddress,
  selectedChangeAddress,
  dbUtxos,
}: PlannerParams) {
  function sortFeeUtxosPreferred(pool: UTXO[]) {
    return [...pool].sort((a, b) => {
      const aNonZero = a.tx_pos !== 0 ? 1 : 0;
      const bNonZero = b.tx_pos !== 0 ? 1 : 0;
      if (aNonZero !== bNonZero) return bNonZero - aNonZero;
      return Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value));
    });
  }

  async function tryBuild(
    inputs: UTXO[],
    outputs: TransactionOutput[]
  ): Promise<BuildResult> {
    try {
      const r = await TransactionService.buildTransaction(
        outputs,
        null,
        selectedChangeAddress,
        inputs
      );
      if (r.errorMsg) return { ok: false, err: r.errorMsg };

      const feeSats = r.bytecodeSize;
      const outputsTotal = outputs
        .map((o) => Number(o.amount || 0))
        .reduce((a, b) => a + b, 0);
      const totalSats = outputsTotal + feeSats;
      const inputSum = sumInputsSats(inputs);
      const changeSats = inputSum - totalSats;

      return {
        ok: true,
        feeSats,
        totalSats,
        rawTx: r.finalTransaction,
        finalOutputs: r.finalOutputs ?? outputs,
        changeSats,
        inputSum,
      };
    } catch (error: unknown) {
      return { ok: false, err: toErrorMessage(error, 'build failed') };
    }
  }

  function makeTokenOutputForRecipientFT(): TransactionOutput {
    return {
      recipientAddress: toTokenAwareCashAddress(recipient),
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: selectedCategory,
        amount: BigInt(amountToken || '0'),
      },
    };
  }

  function makeTokenChangeOutputFT(remaining: bigint): TransactionOutput {
    return {
      recipientAddress: tokenChangeAddress || selectedChangeAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: selectedCategory,
        amount: remaining,
      },
    };
  }

  function makeTokenOutputForRecipientNFT(nftUtxo: UTXO): TransactionOutput {
    return {
      recipientAddress: toTokenAwareCashAddress(recipient),
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: nftUtxo.token!.category,
        amount: 0n,
        nft: {
          capability: nftUtxo.token!.nft!.capability,
          commitment: nftUtxo.token!.nft!.commitment,
        },
      },
    };
  }

  async function addBchInputsUntilBuild(
    fixedTokenInputs: UTXO[],
    outputs: TransactionOutput[],
    maxInputs = 50
  ) {
    const feeUtxoPool = dbUtxos.filter((u) => !u.token);
    if (feeUtxoPool.length === 0) {
      return {
        ok: false as const,
        err: 'No non-token BCH UTXOs available to cover network fees.',
      };
    }

    const confirmedPool = sortFeeUtxosPreferred(feeUtxoPool.filter(isConfirmed));
    const unconfirmedPool = sortFeeUtxosPreferred(
      feeUtxoPool.filter((u) => !isConfirmed(u))
    );

    let lastErr = '';

    for (let k = 1; k <= Math.min(maxInputs, confirmedPool.length); k++) {
      const bchInputs = confirmedPool.slice(0, k);
      const inputs = [...fixedTokenInputs, ...bchInputs] as UTXO[];
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= 0) return { ...res, inputs };
      if (!res.ok && 'err' in res) lastErr = res.err;
    }

    const combinedPool = sortLargestFirst([...confirmedPool, ...unconfirmedPool]);
    for (let k = 1; k <= Math.min(maxInputs, combinedPool.length); k++) {
      const bchInputs = combinedPool.slice(0, k);
      const inputs = [...fixedTokenInputs, ...bchInputs] as UTXO[];
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= 0) return { ...res, inputs };
      if (!res.ok && 'err' in res) lastErr = res.err;
    }

    const availableSats = sumInputsSats(feeUtxoPool);
    return {
      ok: false as const,
      err: `Unable to build with non-token BCH fee UTXOs (${feeUtxoPool.length} inputs, ${availableSats} sats). ${lastErr || `A BCH change output is only added when leftover funds exceed ${DUST} sats.`}`,
    };
  }

  async function addBchOnlyUntilBuild(
    targetSats: number,
    maxInputs = 50
  ): Promise<BchBuildResult> {
    const confirmedPool = sortFeeUtxosPreferred(dbUtxos.filter(isConfirmed));
    const unconfirmedPool = sortFeeUtxosPreferred(
      dbUtxos.filter((u) => !isConfirmed(u))
    );

    const outputs: TransactionOutput[] = [
      { recipientAddress: recipient, amount: targetSats },
    ];

    let lastErr = '';

    for (let k = 1; k <= Math.min(maxInputs, confirmedPool.length); k++) {
      const inputs = confirmedPool.slice(0, k);
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= 0) {
        return { ok: true, inputs, ...res };
      }
      if (!res.ok && 'err' in res) lastErr = res.err;
    }

    const combined = sortLargestFirst([...confirmedPool, ...unconfirmedPool]);
    for (let k = 1; k <= Math.min(maxInputs, combined.length); k++) {
      const inputs = combined.slice(0, k);
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= 0) {
        return { ok: true, inputs, ...res };
      }
      if (!res.ok && 'err' in res) lastErr = res.err;
    }

    const availableSats = sumInputsSats(dbUtxos);
    return {
      ok: false,
      err: `Unable to build BCH send with ${dbUtxos.length} fee candidates totaling ${availableSats} sats. ${lastErr || `A BCH change output is only added when leftover funds exceed ${DUST} sats.`}`,
    };
  }

  return {
    makeTokenOutputForRecipientFT,
    makeTokenChangeOutputFT,
    makeTokenOutputForRecipientNFT,
    addBchInputsUntilBuild,
    addBchOnlyUntilBuild,
  };
}
