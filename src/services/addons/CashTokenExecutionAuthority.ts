import type { TransactionOutput, UTXO } from '../../types/types';
import type { AddonTransactionProposal } from '../AddonsSDK';
import type { AddonExecutionAuthority } from './AddonExecutionAuthority';
import {
  prepareCashTokenExecution,
  type CashTokenExecutionPreparation,
} from './CashTokenExecutionAdapter';

/**
 * Host-only runtime boundary for CashToken submission.
 *
 * The add-on receives neither this object nor the prepared UTXOs. The host
 * supplies the wallet builder and broadcaster, which keep KeyService,
 * SignatureTemplate, provider state, and outbound tracking private.
 */
export type CashTokenExecutionRuntime = {
  isSupportedAddress(address: string): boolean;
  /**
   * Re-resolve every outpoint against wallet-owned chain state. This must
   * compare address, BCH value, token category/amount/NFT, reservation state,
   * and current spendability; caller-supplied proposal fields are not proof.
   */
  verifyInputs(args: {
    proposal: AddonTransactionProposal;
    inputs: UTXO[];
  }): Promise<void>;
  resolveChangeAddress(): Promise<string>;
  buildTransaction(args: {
    inputs: UTXO[];
    outputs: TransactionOutput[];
    changeAddress: string;
    allowImplicitFungibleTokenBurn: boolean;
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

function hasCashTokenState(prepared: CashTokenExecutionPreparation): boolean {
  return (
    prepared.inputs.some((input) => Boolean(input.token)) ||
    prepared.outputs.some(
      (output) => !('opReturn' in output) && Boolean(output.token)
    )
  );
}

/**
 * Creates the internal CashToken authority without exporting wallet secrets.
 * This adapter is intentionally opt-in: a host must provide the reviewed
 * runtime and separately decide whether to advertise this authority.
 */
export function createCashTokenExecutionAuthority(
  runtime: CashTokenExecutionRuntime
): AddonExecutionAuthority {
  return {
    supportedSchemes: new Set(['cashtoken']),
    async validate(proposal) {
      const prepared = prepareCashTokenExecution(proposal);
      if (!hasCashTokenState(prepared)) {
        throw new Error('CashToken authority requires token-bearing state');
      }
      for (const input of prepared.inputs) {
        if (!runtime.isSupportedAddress(input.address)) {
          throw new Error(
            `CashToken authority does not support input address: ${input.address}`
          );
        }
      }
      await runtime.verifyInputs({ proposal, inputs: prepared.inputs });
    },
    async approve() {
      return true;
    },
    async execute({ proposal, mode }) {
      if (mode !== 'wallet-submit') {
        throw new Error('CashToken authority does not support signed export');
      }
      const prepared = prepareCashTokenExecution(proposal);
      if (!hasCashTokenState(prepared)) {
        throw new Error('CashToken authority requires token-bearing state');
      }
      await runtime.verifyInputs({ proposal, inputs: prepared.inputs });
      const changeAddress = await runtime.resolveChangeAddress();
      if (!runtime.isSupportedAddress(changeAddress)) {
        throw new Error(
          'CashToken authority returned an unsupported change address'
        );
      }
      const built = await runtime.buildTransaction({
        inputs: prepared.inputs,
        outputs: prepared.outputs,
        changeAddress,
        allowImplicitFungibleTokenBurn:
          proposal.tokenIntent?.kind === 'burn' &&
          proposal.tokenIntent.amount !== undefined &&
          proposal.tokenIntent.nft === undefined,
      });
      if (
        typeof built.finalTransaction !== 'string' ||
        built.finalTransaction.length === 0 ||
        built.finalTransaction.length > 2_000_000 ||
        built.errorMsg
      ) {
        throw new Error(
          built.errorMsg || 'Wallet CashToken transaction build failed'
        );
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
        throw new Error('Wallet returned an invalid CashToken broadcast state');
      }
      if (submitted.txid && !/^[0-9a-f]{64}$/.test(submitted.txid)) {
        throw new Error('Wallet returned an invalid CashToken transaction id');
      }
      return {
        operationId: `optn-operation-v1:${proposal.commitmentHex}`,
        ...(submitted.txid ? { txid: submitted.txid } : {}),
        // A provider hand-off (`submitted`) is not proof of mempool
        // acceptance. Preserve the unknown state for host-side recovery.
        status:
          submitted.broadcastState === 'broadcasted'
            ? 'mempool'
            : 'submission_unknown',
      };
    },
  };
}
