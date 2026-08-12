// src/apis/TransactionManager/TransactionManager.ts

import { store } from '../../state/store';
import { addTxOutput } from '../../state/slices/transactionBuilderSlice';
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
  validateNftCapabilityTransition,
  type TokenCapability,
} from '../../services/cashtokens';
import {
  estimateAddP2PKHOutputBytes,
  formatMinRelayError,
  hasExplicitManualChangeOutput,
  relayFeeForBytes,
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

function isCurrentWalletSession(
  walletId: number,
  sessionGeneration: number | undefined
): boolean {
  if (sessionGeneration === undefined) return true;
  const activeWallet = store.getState().wallet_id;
  return (
    activeWallet.currentWalletId === walletId &&
    (activeWallet.sessionGeneration ?? 0) === sessionGeneration
  );
}

// Fee for a tx of `bytes`: the min relay fee by default; in 'custom' mode the
// user's sat/byte (never below the relay minimum). Read live from preferences so
// changing the setting takes effect on the next transaction immediately.
function requiredFeeForBytes(bytes: number): bigint {
  const min = relayFeeForBytes(bytes);
  const prefs = store.getState().preferences;
  if (prefs?.feeMode === 'custom') {
    const rate = Number(prefs.customFeeSatPerByte);
    if (Number.isFinite(rate) && rate > 0) {
      const custom = BigInt(Math.ceil(rate * bytes));
      return custom > min ? custom : min;
    }
  }
  return min;
}

export default function TransactionManager() {
  const dbService = DatabaseService();

  async function storeTransactionHistory(
    walletId: number,
    address: string,
    history: TransactionHistoryItem[],
    sessionGeneration?: number
  ): Promise<TransactionHistoryItem[]> {
    if (!isCurrentWalletSession(walletId, sessionGeneration)) return [];
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
          height = CASE
            WHEN excluded.height > 0 AND excluded.height >= COALESCE(transactions.height, 0)
              THEN excluded.height
            WHEN COALESCE(transactions.height, 0) > 0 THEN transactions.height
            ELSE excluded.height
          END,
          timestamp = CASE
            WHEN excluded.timestamp IS NOT NULL AND excluded.timestamp != ''
              THEN excluded.timestamp
            ELSE transactions.timestamp
          END
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

    // Await status write so the next status-hash gate sees scanned-empty
    // addresses (EMPTY_HISTORY_STATUS). Fire-and-forget left every gap addr
    // permanently dirty → single-address spam + fake ledger rebuilds.
    try {
      const ledger = await import('../../platform/desktop/WalletLedgerService');
      await ledger.recordHistoryItems(walletId, address, history);
    } catch {
      /* desktop ledger optional for non-desktop builds */
    }

    return history;
  }

  async function fetchAndStoreTransactionHistory(
    walletId: number,
    address: string,
    sessionGeneration?: number
  ): Promise<TransactionHistoryItem[]> {
    const history = await ElectrumService.getTransactionHistory(address);
    if (!isCurrentWalletSession(walletId, sessionGeneration)) return [];
    if (!Array.isArray(history)) {
      logWarn('TransactionManager.fetchAndStoreTransactionHistory', 'Skipping non-array transaction history response', {
        address,
        walletId,
      });
      return [];
    }

    return storeTransactionHistory(walletId, address, history, sessionGeneration);
  }

  async function fetchAndStoreTransactionHistories(
    walletId: number,
    addresses: string[],
    sessionGeneration?: number,
    onProgress?: (completedCount: number, totalCount: number) => void
  ): Promise<Record<string, TransactionHistoryItem[] | undefined>> {
    const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
    const histories = await ElectrumService.getTransactionHistoryMany(
      uniqueAddresses,
      onProgress
    );
    const stored: Record<string, TransactionHistoryItem[] | undefined> = {};

    if (!isCurrentWalletSession(walletId, sessionGeneration)) return stored;

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
        if (!isCurrentWalletSession(walletId, sessionGeneration)) return stored;
        stored[address] = await storeTransactionHistory(
          walletId,
          address,
          history,
          sessionGeneration
        );
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
      ? await OutboundTransactionTracker.getByTxid(derivedTxid, walletId)
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
        priorAttempt.lastError ?? null,
        walletId
      );
    }

    try {
      txid = await txBuilder.sendTransaction(rawTX);
      if (derivedTxid) {
        await OutboundTransactionTracker.markState(
          derivedTxid,
          'broadcasted',
          null,
          walletId
        );
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
          message,
          walletId
        );
        txid = derivedTxid;
      } else {
        if (derivedTxid) {
          await OutboundTransactionTracker.remove(derivedTxid, walletId);
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
            (
              await OutboundTransactionTracker.getByTxid(
                derivedTxid,
                walletId
              )
            )?.state === 'submitted'
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
    nftCapability?: TokenCapability,
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
          const requestedCapability =
            nftCapability ?? existingTokenUTXO.token.nft.capability;
          const requestedCommitment =
            nftCommitment ?? existingTokenUTXO.token.nft.commitment;
          const transitionCheck = validateNftCapabilityTransition({
            sourceCapability: existingTokenUTXO.token.nft.capability,
            sourceCommitment: existingTokenUTXO.token.nft.commitment,
            requestedCapability,
            requestedCommitment,
            outputCount: 1,
          });
          if (transitionCheck.ok === false) {
            throw new Error(
              'message' in transitionCheck
                ? transitionCheck.message
                : 'Capability validation failed.'
            );
          }
          newOutput.token.amount = 0;
          newOutput.token.nft = {
            capability: requestedCapability,
            commitment: requestedCommitment,
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
        const isNftGenesis =
          nftCapability !== undefined && nftCommitment !== undefined;

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
    const raw: unknown = src.satoshis ?? src.value ?? src.amount ?? 0;

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
   * - Fee policy: 1.10 sat/byte, rounded up
   * - ALWAYS attempt to add a separate change output if changeAddress is provided.
   * - Only skip auto-change if an output is explicitly marked as manual change
   *   via (o as any)._manualChange === true (not by address equality).
   */
  const buildTransaction = async (
    outputs: TransactionOutput[],
    _contractFunctionInputs: Record<string, unknown> | null,
    changeAddress: string,
    selectedUtxos: UTXO[],
    allowImplicitFungibleTokenBurn = false
  ): Promise<{
    bytecodeSize: number;
    finalTransaction: string;
    finalOutputs: TransactionOutput[] | null;
    errorMsg: string;
  }> => {
    const txBuilder = TransactionBuilderHelper({
      allowImplicitFungibleTokenBurn,
    });
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
      const feeNoChange = requiredFeeForBytes(bytesNoChange);

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

        const feeWithChange = requiredFeeForBytes(bytesWithChange);
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
      const requiredActualFee = requiredFeeForBytes(actualBytes);

      if (feePaid < requiredActualFee) {
        // Stabilizing retry: recompute change using actualBytes as fee
        if (changeAddress && !explicitManualChangeOutput) {
          const feeActual = requiredActualFee;
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
            const requiredRetryFee = requiredFeeForBytes(bytesRetry);

            if (feePaidRetry < requiredRetryFee) {
              const shortBy = Number(requiredRetryFee - feePaidRetry);
              throw new Error(
                formatMinRelayError({
                  paying: feePaidRetry,
                  size: bytesRetry,
                  needAtLeast: Number(requiredRetryFee),
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

        const shortBy = Number(requiredActualFee - feePaid);
        throw new Error(
          formatMinRelayError({
            paying: feePaid,
            size: actualBytes,
            needAtLeast: Number(requiredActualFee),
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
    ).default.fetchAddressPrivateKey(address, 'spend');
  }

  /**
   * Write confirmed height/timestamp back after a verbose Electrum fetch so
   * Home/list stop showing "Pending" for long-confirmed fusion txs that were
   * first inserted with height 0.
   */
  async function applyConfirmedHeight(
    walletId: number,
    txHash: string,
    height: number,
    timestamp?: string
  ): Promise<void> {
    if (!Number.isInteger(walletId) || walletId <= 0) return;
    if (!(typeof height === 'number' && height > 0)) return;
    const hash = String(txHash ?? '')
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return;

    const db = dbService.getDatabase();
    if (!db) return;
    const ts =
      timestamp != null && String(timestamp).trim() !== ''
        ? String(timestamp)
        : '';
    db.run(
      `UPDATE transactions
       SET height = CASE
             WHEN ? > COALESCE(height, 0) THEN ?
             ELSE height
           END,
           timestamp = CASE
             WHEN ? != '' AND (timestamp IS NULL OR timestamp = '') THEN ?
             WHEN ? != '' THEN ?
             ELSE timestamp
           END
       WHERE wallet_id = ? AND lower(tx_hash) = ?`,
      [height, height, ts, ts, ts, ts, walletId, hash]
    );
    try {
      await dbService.saveDatabaseToFile(walletId);
    } catch {
      /* best-effort; Redux still updates */
    }
  }

  return {
    fetchAndStoreTransactionHistory,
    fetchAndStoreTransactionHistories,
    sendTransaction,
    addOutput,
    buildTransaction,
    fetchPrivateKey,
    applyConfirmedHeight,
  };
}
