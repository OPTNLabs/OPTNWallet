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
  /**
   * Hardware wallets (EC model): cannot software-sign. Plan fees by size
   * estimate; rawTx is left empty and filled by device sign at send time.
   */
  hardwareWallet?: boolean;
};

export function createSimpleSendPlanner({
  recipient,
  selectedCategory,
  amountToken,
  tokenChangeAddress,
  selectedChangeAddress,
  dbUtxos,
  hardwareWallet = false,
}: PlannerParams) {
  function sortFeeUtxosPreferred(pool: UTXO[]) {
    return [...pool].sort((a, b) => {
      const aNonZero = a.tx_pos !== 0 ? 1 : 0;
      const bNonZero = b.tx_pos !== 0 ? 1 : 0;
      if (aNonZero !== bNonZero) return bNonZero - aNonZero;
      return Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value));
    });
  }

  function outputSats(output: TransactionOutput): bigint {
    if ('opReturn' in output && output.opReturn !== undefined) return 0n;

    const rawAmount = output.amount;
    const amount =
      typeof rawAmount === 'bigint'
        ? rawAmount
        : Number.isFinite(rawAmount)
          ? BigInt(Math.trunc(rawAmount))
          : 0n;

    if (output.token && amount < BigInt(TOKEN_OUTPUT_SATS)) {
      return BigInt(TOKEN_OUTPUT_SATS);
    }
    return amount;
  }

  function sumOutputSats(outputs: TransactionOutput[]): bigint {
    return outputs.reduce((sum, output) => sum + outputSats(output), 0n);
  }

  async function tryBuild(
    inputs: UTXO[],
    outputs: TransactionOutput[]
  ): Promise<BuildResult> {
    // Electron Cash hardware path: plan outputs/fees without software keys;
    // device produces the signed serialization (ledger/trezor sign_transaction).
    if (hardwareWallet) {
      try {
        // sumInputsSats returns number; keep arithmetic in bigint (EC fee plan).
        const inputSum = BigInt(sumInputsSats(inputs));
        // EC-style size estimate: ~10 + 148*nIn + 34*nOut (non-segwit P2PKH).
        const nOut = outputs.length + 1; // allow room for auto-change
        const bytes = 10 + inputs.length * 148 + nOut * 34;
        const feeSats = BigInt(Math.ceil(bytes * 1.1));
        const outTotal = sumOutputSats(outputs);
        let finalOutputs = [...outputs];
        const remainder = inputSum - outTotal - feeSats;
        if (remainder >= BigInt(DUST) && selectedChangeAddress) {
          finalOutputs = [
            ...outputs,
            {
              recipientAddress: selectedChangeAddress,
              amount: Number(remainder),
            },
          ];
        }
        const finalOutTotal = sumOutputSats(finalOutputs);
        const fee = inputSum - finalOutTotal;
        if (fee < 0n) {
          return {
            ok: false,
            err: 'Insufficient funds for fee (hardware plan).',
          };
        }
        return {
          ok: true,
          feeSats: Number(fee),
          totalSats: Number(outTotal + fee),
          rawTx: '', // filled by hardwareSignTransaction at Send
          finalOutputs,
          changeSats: Number(inputSum - outTotal - fee),
          inputSum: Number(inputSum),
        };
      } catch (error: unknown) {
        return { ok: false, err: toErrorMessage(error, 'hardware plan failed') };
      }
    }

    try {
      const r = await TransactionService.buildTransaction(
        outputs,
        null,
        selectedChangeAddress,
        inputs
      );
      if (r.errorMsg) return { ok: false, err: r.errorMsg };

      const inputSum = sumInputsSats(inputs);
      const requestedOutputsTotal = sumOutputSats(outputs);
      const finalOutputs = r.finalOutputs ?? outputs;
      const finalOutputsTotal = sumOutputSats(finalOutputs);
      const feeSats = BigInt(inputSum) - finalOutputsTotal;
      if (feeSats < 0n) {
        return {
          ok: false,
          err: 'Transaction outputs exceed the selected input value.',
        };
      }
      const totalSats = requestedOutputsTotal + feeSats;
      const changeSats = BigInt(inputSum) - totalSats;

      return {
        ok: true,
        feeSats: Number(feeSats),
        totalSats: Number(totalSats),
        rawTx: r.finalTransaction,
        finalOutputs,
        changeSats: Number(changeSats),
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

    const confirmedPool = sortFeeUtxosPreferred(
      feeUtxoPool.filter(isConfirmed)
    );
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

    const combinedPool = sortLargestFirst([
      ...confirmedPool,
      ...unconfirmedPool,
    ]);
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

  // "Max" / sweep-all: unlike addBchOnlyUntilBuild (fixed OUTPUT amount, adds
  // inputs until covered), this fixes the INPUT set to everything spendable
  // and computes the output as inputs-minus-fee, so the whole balance moves
  // in one send with no change output. A dust-placeholder probe build against
  // the full input set estimates the fee for the real (inputs, 1-output) shape.
  async function sweepAllBchUntilBuild(
    maxInputs = 50
  ): Promise<BchBuildResult> {
    const feeUtxoPool = dbUtxos.filter((u) => !u.token);
    if (feeUtxoPool.length === 0) {
      return { ok: false, err: 'No spendable BCH UTXOs.' };
    }

    const confirmedPool = sortFeeUtxosPreferred(
      feeUtxoPool.filter(isConfirmed)
    );
    const unconfirmedPool = sortFeeUtxosPreferred(
      feeUtxoPool.filter((u) => !isConfirmed(u))
    );
    const inputs = sortLargestFirst([
      ...confirmedPool,
      ...unconfirmedPool,
    ]).slice(0, maxInputs);
    const availableSats = sumInputsSats(inputs);

    const probe = await tryBuild(inputs, [
      { recipientAddress: recipient, amount: DUST },
    ]);
    if (!probe.ok) {
      return {
        ok: false,
        err: 'err' in probe ? probe.err : 'Unable to estimate the sweep fee.',
      };
    }

    const maxSats = availableSats - probe.feeSats;
    if (maxSats < DUST) {
      return { ok: false, err: 'Not enough funds to cover the network fee.' };
    }

    const final = await tryBuild(inputs, [
      { recipientAddress: recipient, amount: maxSats },
    ]);
    if (!final.ok) {
      return {
        ok: false,
        err: 'err' in final ? final.err : 'Sweep build failed.',
      };
    }

    return {
      ok: true,
      inputs,
      feeSats: final.feeSats,
      totalSats: final.totalSats,
      rawTx: final.rawTx,
      finalOutputs: final.finalOutputs,
    };
  }

  return {
    makeTokenOutputForRecipientFT,
    makeTokenChangeOutputFT,
    makeTokenOutputForRecipientNFT,
    addBchInputsUntilBuild,
    addBchOnlyUntilBuild,
    sweepAllBchUntilBuild,
  };
}
