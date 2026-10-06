import type { TransactionOutput, UTXO } from '../../types/types';
import { decodeCashAddress } from '@bitauth/libauth';
import type { AddonTransactionProposal } from '../AddonsSDK';
import { assertAddonProposalExecutable } from './AddonExecutionPreflight';
import type { AddonExecutionAuthority } from './AddonExecutionAuthority';

export type P2pkhExecutionPreparation = {
  inputs: UTXO[];
  outputs: TransactionOutput[];
};

export type P2pkhExecutionRuntime = {
  isP2pkhAddress(address: string): boolean;
  verifyInputs(args: {
    proposal: AddonTransactionProposal;
    inputs: UTXO[];
  }): Promise<void>;
  resolveChangeAddress(): Promise<string>;
  buildTransaction(args: {
    inputs: UTXO[];
    outputs: TransactionOutput[];
    changeAddress: string;
  }): Promise<{ finalTransaction: string; errorMsg: string }>;
  sendTransaction(
    rawTransaction: string,
    inputs: UTXO[]
  ): Promise<{
    txid: string | null;
    errorMessage: string | null;
    broadcastState?: 'broadcasted' | 'submitted';
  }>;
};

export function isP2pkhCashAddress(address: string): boolean {
  const decoded = decodeCashAddress(address);
  return (
    typeof decoded !== 'string' &&
    (decoded.type === 'p2pkh' || decoded.type === 'p2pkhWithTokens')
  );
}

/**
 * Converts a public proposal into the private builder input shape for the
 * narrow P2PKH BCH adapter. This function has no signer, provider, or network
 * access and deliberately rejects token/contract data.
 */
export function prepareP2pkhExecution(
  proposal: AddonTransactionProposal,
  isP2pkhAddress: (address: string) => boolean
): P2pkhExecutionPreparation {
  assertAddonProposalExecutable(proposal);
  const inputs: UTXO[] = proposal.inputs.map((input) => {
    if (input.tokenCategory || input.tokenAmount !== undefined) {
      throw new Error('P2PKH BCH adapter does not support CashToken inputs');
    }
    if (!isP2pkhAddress(input.address)) {
      throw new Error(
        `P2PKH BCH adapter does not support input address: ${input.address}`
      );
    }
    return {
      address: input.address,
      tx_hash: input.txid,
      tx_pos: input.vout,
      value: Number(BigInt(input.valueSats)),
      height: 0,
    } as UTXO;
  });
  const outputs = proposal.outputs.map((output) => {
    if ('opReturn' in output) return { opReturn: [...(output.opReturn ?? [])] };
    if (output.token) {
      throw new Error('P2PKH BCH adapter does not support CashToken outputs');
    }
    return {
      recipientAddress: output.recipientAddress,
      amount: output.amount,
    } as TransactionOutput;
  });
  return { inputs, outputs };
}

export function createP2pkhExecutionAuthority(
  runtime: P2pkhExecutionRuntime
): AddonExecutionAuthority {
  return {
    supportedSchemes: new Set(['p2pkh-bch']),
    async validate(proposal) {
      const prepared = prepareP2pkhExecution(proposal, runtime.isP2pkhAddress);
      await runtime.verifyInputs({ proposal, inputs: prepared.inputs });
    },
    async approve() {
      return true;
    },
    async execute({ proposal, mode }) {
      if (mode !== 'wallet-submit') {
        throw new Error('P2PKH BCH authority does not support signed export');
      }
      const prepared = prepareP2pkhExecution(proposal, runtime.isP2pkhAddress);
      await runtime.verifyInputs({ proposal, inputs: prepared.inputs });
      const changeAddress = await runtime.resolveChangeAddress();
      if (!runtime.isP2pkhAddress(changeAddress)) {
        throw new Error(
          'P2PKH BCH authority returned an unsupported change address'
        );
      }
      const built = await runtime.buildTransaction({
        inputs: prepared.inputs,
        outputs: prepared.outputs,
        changeAddress,
      });
      if (
        typeof built.finalTransaction !== 'string' ||
        built.finalTransaction.length === 0 ||
        built.finalTransaction.length > 2_000_000 ||
        built.errorMsg
      ) {
        throw new Error(built.errorMsg || 'Wallet transaction build failed');
      }
      const submitted = await runtime.sendTransaction(
        built.finalTransaction,
        prepared.inputs
      );
      if (submitted.errorMessage) {
        throw new Error(submitted.errorMessage);
      }
      if (
        submitted.broadcastState !== undefined &&
        submitted.broadcastState !== 'broadcasted' &&
        submitted.broadcastState !== 'submitted'
      ) {
        throw new Error('Wallet returned an invalid broadcast state');
      }
      if (submitted.txid && !/^[0-9a-f]{64}$/.test(submitted.txid)) {
        throw new Error('Wallet returned an invalid transaction id');
      }
      return {
        operationId: `optn-operation-v1:${proposal.commitmentHex}`,
        ...(submitted.txid ? { txid: submitted.txid } : {}),
        // `submitted` means the provider accepted the hand-off but does not
        // prove mempool acceptance. Keep that ambiguity visible so recovery
        // can reconcile it against provider and chain state.
        status:
          submitted.broadcastState === 'broadcasted'
            ? 'mempool'
            : 'submission_unknown',
      };
    },
  };
}
