// src/apis/TransactionManager/TransactionManager.ts

import { store } from '../../redux/store';
import { addTxOutput } from '../../redux/transactionBuilderSlice';
import ElectrumService from '../../services/ElectrumService';
import {
  TransactionHistoryItem,
  TransactionOutput,
  UTXO,
} from '../../types/types';
import DatabaseService from '../DatabaseManager/DatabaseService';
import TransactionBuilderHelper from './TransactionBuilderHelper';
import { DUST, TOKEN_OUTPUT_SATS } from '../../utils/constants';
import { logError, logWarn, toErrorMessage } from '../../utils/errorHandling';
import { classifyBroadcastFailure } from '../../utils/broadcastErrors';
import { toTokenAwareCashAddress } from '../../utils/cashAddress';
import { binToHex, hexToBin } from '../../utils/hex';
import { sha256 } from '../../utils/hash';
import {
  estimateAddP2PKHOutputBytes,
  formatMinRelayError,
  hasExplicitManualChangeOutput,
  txBytesFromHex,
} from './feePolicy';
import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';

function deriveTxidFromRawTx(rawTX: string): string | null {
  try {
    const txBytes = hexToBin(rawTX);
    return binToHex(sha256.hash(sha256.hash(txBytes)).reverse());
  } catch {
    return null;
  }
}

export default function TransactionManager() {
  const dbService = DatabaseService();

  function storeTransactionHistory(
    walletId: number,
    address: string,
    history: TransactionHistoryItem[]
  ): TransactionHistoryItem[] {
    const db = dbService.getDatabase();
    if (!db) {
      throw new Error('Could not get database');
    }

    let transactionOpened = false;

    try {
      db.exec('BEGIN TRANSACTION');
      transactionOpened = true;

      const upsertStmt = db.prepare(`
        INSERT INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
          height = excluded.height,
          timestamp = excluded.timestamp
      `);

      for (const tx of history) {
        upsertStmt.run([walletId, tx.tx_hash, tx.height, tx.timestamp ?? '']);
      }

      upsertStmt.free();
      db.exec('COMMIT');
      transactionOpened = false;
    } catch (error) {
      if (transactionOpened) {
        db.exec('ROLLBACK');
      }
      logError('TransactionManager.fetchAndStoreTransactionHistory', error, {
        address,
        walletId,
      });
    }

    return history;
  }

  async function fetchAndStoreTransactionHistory(
    walletId: number,
    address: string
  ): Promise<TransactionHistoryItem[]> {
    const history = await ElectrumService.getTransactionHistory(address);
    if (!Array.isArray(history)) {
      logWarn('TransactionManager.fetchAndStoreTransactionHistory', 'Skipping non-array transaction history response', {
        address,
        walletId,
      });
      return [];
    }

    return storeTransactionHistory(walletId, address, history);
  }

  async function fetchAndStoreTransactionHistories(
    walletId: number,
    addresses: string[]
  ): Promise<Record<string, TransactionHistoryItem[] | undefined>> {
    const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
    const histories = await ElectrumService.getTransactionHistoryMany(
      uniqueAddresses
    );
    const stored: Record<string, TransactionHistoryItem[] | undefined> = {};

    for (const address of uniqueAddresses) {
      const history = histories[address];
      if (!Array.isArray(history)) {
        if (history == null) {
          stored[address] = undefined;
          continue;
        }

        logWarn(
          'TransactionManager.fetchAndStoreTransactionHistories',
          'Skipping non-array transaction history response',
          {
            address,
            walletId,
          }
        );
        continue;
      }

      try {
        stored[address] = storeTransactionHistory(walletId, address, history);
      } catch (error) {
        logError('TransactionManager.fetchAndStoreTransactionHistories', error, {
          address,
          walletId,
        });
      }
    }

    return stored;
  }

  async function sendTransaction(rawTX: string): Promise<{
    txid: string | null;
    errorMessage: string | null;
    broadcastState?: 'broadcasted' | 'submitted';
  }> {
    const txBuilder = TransactionBuilderHelper();
    const derivedTxid = deriveTxidFromRawTx(rawTX);
    const walletId = store.getState().wallet_id.currentWalletId ?? null;
    const priorAttempt = derivedTxid
      ? await OutboundTransactionTracker.getByTxid(derivedTxid)
      : null;

    if (
      priorAttempt &&
      (priorAttempt.state === 'broadcasting' ||
        priorAttempt.state === 'broadcasted')
    ) {
      return {
        txid: priorAttempt.txid,
        errorMessage: null,
        broadcastState:
          priorAttempt.state === 'broadcasted' ? 'broadcasted' : 'submitted',
      };
    }

    let txid: string | null = null;
    let errorMessage: string | null = null;

    await OutboundTransactionTracker.trackAttempt({
      rawTx: rawTX,
      walletId,
      source: 'wallet',
    });

    if (derivedTxid && priorAttempt?.state === 'submitted') {
      await OutboundTransactionTracker.markState(
        derivedTxid,
        'broadcasting',
        priorAttempt.lastError ?? null
      );
    }

    try {
      txid = await txBuilder.sendTransaction(rawTX);
      if (derivedTxid) {
        await OutboundTransactionTracker.markState(derivedTxid, 'broadcasted');
      }
    } catch (error: unknown) {
      logError('TransactionManager.sendTransaction', error);
      const message = toErrorMessage(error);
      const classified = classifyBroadcastFailure(message);
      if (
        derivedTxid &&
        (classified.ambiguous ||
          /already in mempool|already have transaction|txn-already-known|already known/i.test(
            message
          ))
      ) {
        await OutboundTransactionTracker.markState(
          derivedTxid,
          /already in mempool|already have transaction|txn-already-known|already known/i.test(
            message
          )
            ? 'broadcasted'
            : 'submitted',
          message
        );
        txid = derivedTxid;
      } else {
        if (derivedTxid) {
          await OutboundTransactionTracker.remove(derivedTxid);
        }
        errorMessage = classified.userMessage;
      }
    }
    return {
      txid,
      errorMessage,
      broadcastState:
        txid && !errorMessage
          ? derivedTxid &&
            (await OutboundTransactionTracker.getByTxid(derivedTxid))?.state ===
              'submitted'
            ? 'submitted'
            : 'broadcasted'
          : undefined,
    };
  }

  function addOutput(
    recipientAddress: string,
    transferAmount: number,
    tokenAmount: number | bigint,
    selectedTokenCategory: string = '',
    selectedUtxos: UTXO[] = [],
    addresses: { address: string; tokenAddress?: string }[] = [],
    nftCapability?: undefined | 'none' | 'mutable' | 'minting',
    nftCommitment?: string,
    dispatchToStore = true
  ): TransactionOutput | undefined {
    if (!recipientAddress || (!transferAmount && !tokenAmount)) {
      console.warn(
        'addOutput: Invalid inputs. recipientAddress and at least one amount required.'
      );
      return undefined;
    }

    const newOutput: TransactionOutput = {
      recipientAddress,
      amount: transferAmount || 0,
    };

    if (selectedTokenCategory) {
      const existingTokenUTXO = selectedUtxos.find(
        (utxo) => utxo.token && utxo.token.category === selectedTokenCategory
      );

      const genesisUtxo = selectedUtxos.find(
        (utxo) =>
          !utxo.token &&
          utxo.tx_pos === 0 &&
          utxo.tx_hash === selectedTokenCategory
      );

      if (existingTokenUTXO && existingTokenUTXO.token) {
        newOutput.token = {
          amount: tokenAmount,
          category: existingTokenUTXO.token.category,
        };

        if (existingTokenUTXO.token.nft) {
          newOutput.token.amount = 0;
          newOutput.token.nft = {
            capability: existingTokenUTXO.token.nft.capability,
            commitment: existingTokenUTXO.token.nft.commitment,
          };
        }

        const tokenAddress = addresses.find(
          (addr) => addr.address === recipientAddress
        )?.tokenAddress;
        if (tokenAddress) {
          newOutput.recipientAddress = tokenAddress;
        } else {
          newOutput.recipientAddress = toTokenAwareCashAddress(recipientAddress);
        }

        if (newOutput.amount < TOKEN_OUTPUT_SATS) {
          newOutput.amount = TOKEN_OUTPUT_SATS;
        }
      } else if (genesisUtxo) {
        const isNftGenesis = nftCapability && nftCommitment !== undefined;

        newOutput.token = {
          amount: isNftGenesis ? 0 : tokenAmount,
          category: genesisUtxo.tx_hash,
        };

        if (isNftGenesis) {
          newOutput.token.nft = {
            capability: nftCapability,
            commitment: nftCommitment!,
          };
        }

        const tokenAddress = addresses.find(
          (addr) => addr.address === recipientAddress
        )?.tokenAddress;
        if (tokenAddress) {
          newOutput.recipientAddress = tokenAddress;
        } else {
          newOutput.recipientAddress = toTokenAwareCashAddress(recipientAddress);
        }

        if (newOutput.amount < TOKEN_OUTPUT_SATS) {
          newOutput.amount = TOKEN_OUTPUT_SATS;
        }
      } else {
        console.warn(
          'addOutput: No matching token UTXO or valid genesis UTXO found for the selected category.'
        );
      }
    }

    if (dispatchToStore) {
      store.dispatch(addTxOutput(newOutput));
    }
    return newOutput;
  }

  // ----------------------------
  // Helpers (local, no new files)
  // ----------------------------

  function utxoSats(utxo: UTXO): bigint {
    const src = utxo as UTXO & { satoshis?: unknown };
    const raw = src.satoshis ?? src.value ?? src.amount ?? 0;

    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') {
      return BigInt(Number.isFinite(raw) ? Math.trunc(raw) : 0);
    }
    if (typeof raw === 'string') {
      try {
        return BigInt(raw.trim() || '0');
      } catch {
        return 0n;
      }
    }
    return 0n;
  }

  function outputSats(o: TransactionOutput): bigint {
    if ('opReturn' in o && o.opReturn !== undefined) return 0n;

    const hasToken = !!o.token;
    const raw = o.amount;
    let sats = 0n;

    if (typeof raw === 'bigint') sats = raw;
    else if (typeof raw === 'number')
      sats = BigInt(Number.isFinite(raw) ? Math.trunc(raw) : 0);

    // match TransactionBuilderHelper.prepareTransactionOutputs
    if (hasToken) {
      const minTokenSats = BigInt(TOKEN_OUTPUT_SATS);
      if (sats < minTokenSats) sats = minTokenSats;
    }

    return sats;
  }

  function sumInputs(selectedUtxos: UTXO[]): bigint {
    return selectedUtxos.reduce((sum, u) => sum + utxoSats(u), 0n);
  }

  function sumOutputs(outputs: TransactionOutput[]): bigint {
    return outputs.reduce((sum, o) => sum + outputSats(o), 0n);
  }

  function normalizeTokenOutputs(
    outputs: TransactionOutput[]
  ): TransactionOutput[] {
    return outputs.map((output): TransactionOutput => {
      if ('opReturn' in output && output.opReturn !== undefined) {
        return output;
      }
      if (!output.token) return output;
      return {
        recipientAddress: toTokenAwareCashAddress(output.recipientAddress),
        amount: output.amount,
        token: output.token,
      };
    });
  }

  /**
   * Builds a transaction using the provided outputs, change address, and selected UTXOs.
   *
   * Baseline rules (Advanced Builder):
   * - Fee policy: 1 sat/byte
   * - ALWAYS attempt to add a separate change output if changeAddress is provided.
   * - Only skip auto-change if an output is explicitly marked as manual change
   *   via (o as any)._manualChange === true (not by address equality).
   */
  const buildTransaction = async (
    outputs: TransactionOutput[],
    _contractFunctionInputs: Record<string, unknown> | null,
    changeAddress: string,
    selectedUtxos: UTXO[]
  ): Promise<{
    bytecodeSize: number;
    finalTransaction: string;
    finalOutputs: TransactionOutput[] | null;
    errorMsg: string;
  }> => {
    const txBuilder = TransactionBuilderHelper();
    const returnObj = {
      bytecodeSize: 0,
      finalTransaction: '',
      finalOutputs: null as TransactionOutput[] | null,
      errorMsg: '',
    };

    // track intended outputs so we can return them even on failure (debug UX)
    let intendedOutputs: TransactionOutput[] = normalizeTokenOutputs(outputs);

    try {
      if (!selectedUtxos || selectedUtxos.length === 0) {
        throw new Error('No inputs selected.');
      }
      if (!outputs || outputs.length === 0) {
        throw new Error('No outputs specified.');
      }

      const inputTotal = sumInputs(selectedUtxos);
      const outputsNoChange = [...intendedOutputs];

      // IMPORTANT CHANGE:
      // Do NOT treat "any output to changeAddress" as a manual change output.
      // Only treat it as manual change if explicitly flagged.
      const explicitManualChangeOutput = hasExplicitManualChangeOutput(
        outputsNoChange,
        changeAddress
      );

      // 1) Estimate bytes WITHOUT change first
      const txNoChangeHex = await txBuilder.buildTransaction(
        selectedUtxos,
        outputsNoChange
      );
      const bytesNoChange = txBytesFromHex(txNoChangeHex);
      const feeNoChange = BigInt(bytesNoChange);

      const outNoChangeTotal = sumOutputs(outputsNoChange);
      void (inputTotal - outNoChangeTotal - feeNoChange);

      // Advanced/debug mode: always attempt auto-change if changeAddress is present
      // (unless explicitly flagged as manual change output).
      const shouldTryAutoChange =
        !!changeAddress && !explicitManualChangeOutput;

      let plannedOutputs: TransactionOutput[] = outputsNoChange;

      if (shouldTryAutoChange) {
        const placeholder: TransactionOutput = {
          recipientAddress: changeAddress,
          amount: DUST,
        };

        let bytesWithChange: number;

        // 2) Re-estimate bytes WITH placeholder change output (preferred)
        try {
          const txWithChangeHex = await txBuilder.buildTransaction(
            selectedUtxos,
            [...outputsNoChange, placeholder]
          );
          bytesWithChange = txBytesFromHex(txWithChangeHex);
        } catch (error: unknown) {
          bytesWithChange = estimateAddP2PKHOutputBytes(
            bytesNoChange,
            outputsNoChange.length
          );
          void error;
        }

        const feeWithChange = BigInt(bytesWithChange);
        const remainder = inputTotal - outNoChangeTotal - feeWithChange;

        // Only add change if it is >= DUST
        if (remainder >= BigInt(DUST)) {
          plannedOutputs = [
            ...outputsNoChange,
            { recipientAddress: changeAddress, amount: Number(remainder) },
          ];
        } else {
          plannedOutputs = outputsNoChange;
        }
      }

      intendedOutputs = plannedOutputs;

      // 3) Build final transaction
      let finalHex = await txBuilder.buildTransaction(
        selectedUtxos,
        plannedOutputs
      );

      // 4) Validate min relay fee using ACTUAL bytes and ACTUAL fee paid.
      const actualBytes = txBytesFromHex(finalHex);
      const outputsTotal = sumOutputs(plannedOutputs);
      const feePaid = inputTotal - outputsTotal;

      if (feePaid < BigInt(actualBytes)) {
        // Stabilizing retry: recompute change using actualBytes as fee
        if (changeAddress && !explicitManualChangeOutput) {
          const feeActual = BigInt(actualBytes);
          const remainder2 = inputTotal - outNoChangeTotal - feeActual;

          if (remainder2 >= BigInt(DUST)) {
            const outputsRetry: TransactionOutput[] = [
              ...outputsNoChange,
              { recipientAddress: changeAddress, amount: Number(remainder2) },
            ];

            intendedOutputs = outputsRetry;

            finalHex = await txBuilder.buildTransaction(
              selectedUtxos,
              outputsRetry
            );

            const bytesRetry = txBytesFromHex(finalHex);
            const outputsRetryTotal = sumOutputs(outputsRetry);
            const feePaidRetry = inputTotal - outputsRetryTotal;

            if (feePaidRetry < BigInt(bytesRetry)) {
              const shortBy = Number(BigInt(bytesRetry) - feePaidRetry);
              throw new Error(
                formatMinRelayError({
                  paying: feePaidRetry,
                  size: bytesRetry,
                  needAtLeast: bytesRetry,
                  shortBy,
                })
              );
            }

            returnObj.bytecodeSize = bytesRetry;
            returnObj.finalTransaction = finalHex;
            returnObj.finalOutputs = outputsRetry;
            returnObj.errorMsg = '';
            return returnObj;
          }
        }

        const shortBy = Number(BigInt(actualBytes) - feePaid);
        throw new Error(
          formatMinRelayError({
            paying: feePaid,
            size: actualBytes,
            needAtLeast: actualBytes,
            shortBy,
          })
        );
      }

      // Success
      returnObj.bytecodeSize = actualBytes;
      returnObj.finalTransaction = finalHex;
      returnObj.finalOutputs = plannedOutputs;
      returnObj.errorMsg = '';
      return returnObj;
    } catch (error: unknown) {
      logError('TransactionManager.buildTransaction', error);

      // Debug UX requirement: still return the intended outputs (including change)
      // even if the contract rejects the shape and the tx fails to build.
      returnObj.finalOutputs = intendedOutputs;
      returnObj.finalTransaction = '';
      returnObj.bytecodeSize = 0;
      returnObj.errorMsg = toErrorMessage(error);
      return returnObj;
    }
  };

  async function fetchPrivateKey(address: string): Promise<Uint8Array | null> {
    return await (
      await import('../../services/KeyService')
    ).default.fetchAddressPrivateKey(address);
  }

  return {
    fetchAndStoreTransactionHistory,
    fetchAndStoreTransactionHistories,
    sendTransaction,
    addOutput,
    buildTransaction,
    fetchPrivateKey,
  };
}
