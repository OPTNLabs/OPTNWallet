import { TransactionOutput, UTXO } from '../../types/types';
import TransactionService from '../../services/TransactionService';
import { TOKEN_OUTPUT_SATS } from '../../utils/constants';
import { toErrorMessage } from '../../utils/errorHandling';
import { BuildResult, BchBuildResult } from './types';
import { isConfirmed, sortLargestFirst, sumInputsSats } from './helpers';

const FEE_BUFFER_SATS = 1000;

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
      recipientAddress: recipient,
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
      recipientAddress: recipient,
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

    const confirmedPool = sortLargestFirst(feeUtxoPool.filter(isConfirmed));
    const unconfirmedPool = sortLargestFirst(
      feeUtxoPool.filter((u) => !isConfirmed(u))
    );

    for (let k = 1; k <= Math.min(maxInputs, confirmedPool.length); k++) {
      const bchInputs = confirmedPool.slice(0, k);
      const inputs = [...fixedTokenInputs, ...bchInputs] as UTXO[];
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= FEE_BUFFER_SATS) return { ...res, inputs };
    }

    const combinedPool = sortLargestFirst([...confirmedPool, ...unconfirmedPool]);
    for (let k = 1; k <= Math.min(maxInputs, combinedPool.length); k++) {
      const bchInputs = combinedPool.slice(0, k);
      const inputs = [...fixedTokenInputs, ...bchInputs] as UTXO[];
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= FEE_BUFFER_SATS) return { ...res, inputs };
    }

    return {
      ok: false as const,
      err: 'Unable to cover 1 sat/byte fee plus buffer using non-token BCH UTXOs.',
    };
  }

  async function addBchOnlyUntilBuild(
    targetSats: number,
    maxInputs = 50
  ): Promise<BchBuildResult> {
    const confirmedPool = sortLargestFirst(dbUtxos.filter(isConfirmed));
    const unconfirmedPool = sortLargestFirst(
      dbUtxos.filter((u) => !isConfirmed(u))
    );

    const outputs: TransactionOutput[] = [
      { recipientAddress: recipient, amount: targetSats },
    ];

    for (let k = 1; k <= Math.min(maxInputs, confirmedPool.length); k++) {
      const inputs = confirmedPool.slice(0, k);
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= FEE_BUFFER_SATS) {
        return { ok: true, inputs, ...res };
      }
    }

    const combined = sortLargestFirst([...confirmedPool, ...unconfirmedPool]);
    for (let k = 1; k <= Math.min(maxInputs, combined.length); k++) {
      const inputs = combined.slice(0, k);
      const res = await tryBuild(inputs, outputs);
      if (res.ok && res.changeSats >= FEE_BUFFER_SATS) {
        return { ok: true, inputs, ...res };
      }
    }

    return {
      ok: false,
      err: 'Insufficient funds: can’t cover amount, 1 sat/byte fee, and 1000-sat buffer.',
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
