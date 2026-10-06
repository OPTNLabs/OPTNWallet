import type { TransactionOutput } from '../../types/types';
import type { AddonTransactionProposal } from '../AddonsSDK';
import { TOKEN_OUTPUT_SATS } from '../../utils/constants';
import { ADDON_SDK_LIMITS } from './SDKContract';
import {
  MAX_CASHTOKEN_AMOUNT,
  MAX_NFT_COMMITMENT_HEX_LENGTH,
  validateCashTokenProposal,
} from './CashTokenProposalValidator';

function parseInteger(value: string | number | bigint, label: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Addon proposal contains an invalid ${label}`);
  }
}

export function assertAddonProposalExecutable(
  proposal: AddonTransactionProposal,
  now = Date.now()
): void {
  if (!Number.isSafeInteger(proposal.walletId) || proposal.walletId <= 0) {
    throw new Error('Addon proposal contains an invalid wallet id');
  }
  if (proposal.network !== 'mainnet' && proposal.network !== 'chipnet') {
    throw new Error('Addon proposal contains an unsupported network');
  }
  if (proposal.status !== 'proposed') {
    throw new Error('Addon proposal is not executable');
  }
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error('Addon proposal contains an invalid expiry timestamp');
  }
  if (expiresAt <= now) {
    throw new Error('Addon proposal expired');
  }
  if (proposal.inputs.length === 0) {
    throw new Error('Addon proposal requires at least one input');
  }
  if (proposal.outputs.length === 0) {
    throw new Error('Addon proposal requires at least one output');
  }
  if (proposal.inputs.length > ADDON_SDK_LIMITS.maxProposalInputs) {
    throw new Error('Addon proposal exceeds the input limit');
  }
  if (proposal.outputs.length > ADDON_SDK_LIMITS.maxProposalOutputs) {
    throw new Error('Addon proposal exceeds the output limit');
  }

  const seen = new Set<string>();
  const inputTotals = new Map<string, bigint>();
  let inputBch = 0n;
  for (const input of proposal.inputs) {
    if (!/^[0-9a-f]{64}$/.test(input.txid)) {
      throw new Error('Addon proposal contains an invalid input transaction ID');
    }
    if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) {
      throw new Error('Addon proposal contains an invalid input output index');
    }
    const outpoint = `${input.txid}:${input.vout}`;
    if (seen.has(outpoint))
      throw new Error(`Addon proposal contains duplicate input: ${outpoint}`);
    seen.add(outpoint);
    const value = parseInteger(input.valueSats, 'input value');
    if (value < 0n)
      throw new Error('Addon proposal contains a negative input value');
    if (input.tokenCategory && !/^[0-9a-f]{64}$/.test(input.tokenCategory)) {
      throw new Error(
        'Addon proposal contains an invalid input token category'
      );
    }
    if (input.tokenAmount !== undefined && !input.tokenCategory) {
      throw new Error(
        'Addon proposal input token amount requires a token category'
      );
    }
    if (input.tokenNft && !input.tokenCategory) {
      throw new Error(
        'Addon proposal input NFT metadata requires a token category'
      );
    }
    if (input.tokenCategory && input.tokenAmount === undefined) {
      throw new Error(
        'Addon proposal input token category requires an explicit amount'
      );
    }
    if (
      input.tokenAmount !== undefined &&
      (parseInteger(input.tokenAmount, 'input token amount') < 0n ||
        parseInteger(input.tokenAmount, 'input token amount') > MAX_CASHTOKEN_AMOUNT)
    ) {
      throw new Error('Addon proposal contains an invalid input token amount');
    }
    if (
      input.tokenCategory &&
      input.tokenAmount !== undefined &&
      !input.tokenNft &&
      parseInteger(input.tokenAmount, 'input token amount') === 0n
    ) {
      throw new Error(
        'Addon proposal fungible token amount must be positive unless the output is an NFT'
      );
    }
    if (input.tokenNft) {
      if (
        !['none', 'mutable', 'minting'].includes(input.tokenNft.capability) ||
        !/^[0-9a-f]*$/.test(input.tokenNft.commitment) ||
        input.tokenNft.commitment.length % 2 !== 0 ||
        input.tokenNft.commitment.length > MAX_NFT_COMMITMENT_HEX_LENGTH
      ) {
        throw new Error('Addon proposal contains invalid input NFT metadata');
      }
    }
    inputBch += value;
    if (input.tokenCategory && input.tokenAmount !== undefined) {
      const prior = inputTotals.get(input.tokenCategory) ?? 0n;
      inputTotals.set(
        input.tokenCategory,
        prior + parseInteger(input.tokenAmount, 'input token amount')
      );
    }
  }

  let outputBch = 0n;
  const outputTotals = new Map<string, bigint>();
  for (const output of proposal.outputs as ReadonlyArray<TransactionOutput>) {
    if ('opReturn' in output) continue;
    const outputAmount = parseInteger(output.amount, 'output value');
    outputBch += outputAmount;
    if (outputAmount < 0n)
      throw new Error('Addon proposal contains a negative output value');
    if (output.token) {
      if (outputAmount < BigInt(TOKEN_OUTPUT_SATS)) {
        throw new Error(
          `Addon proposal token output must contain at least ${TOKEN_OUTPUT_SATS} sats`
        );
      }
      if (!/^[0-9a-f]{64}$/.test(output.token.category)) {
        throw new Error(
          'Addon proposal contains an invalid output token category'
        );
      }
      if (
        parseInteger(output.token.amount, 'output token amount') < 0n ||
        parseInteger(output.token.amount, 'output token amount') > MAX_CASHTOKEN_AMOUNT
      ) {
        throw new Error(
          'Addon proposal contains an invalid output token amount'
        );
      }
      if (
        !output.token.nft &&
        parseInteger(output.token.amount, 'output token amount') === 0n
      ) {
        throw new Error(
          'Addon proposal fungible token amount must be positive unless the output is an NFT'
        );
      }
      if (output.token.nft) {
        if (
          !['none', 'mutable', 'minting'].includes(
            output.token.nft.capability
          ) ||
          !/^[0-9a-f]*$/.test(output.token.nft.commitment) ||
          output.token.nft.commitment.length % 2 !== 0 ||
          output.token.nft.commitment.length > MAX_NFT_COMMITMENT_HEX_LENGTH
        ) {
          throw new Error(
            'Addon proposal contains invalid output NFT metadata'
          );
        }
      }
      const prior = outputTotals.get(output.token.category) ?? 0n;
      outputTotals.set(
        output.token.category,
        prior + parseInteger(output.token.amount, 'output token amount')
      );
    }
  }
  if (outputBch > inputBch) {
    throw new Error('Addon proposal outputs exceed input BCH value');
  }
  for (const [category, outputAmount] of outputTotals) {
    if (outputAmount > (inputTotals.get(category) ?? 0n)) {
      if (
        proposal.tokenIntent?.kind === 'mint-fungible' &&
        proposal.tokenIntent.category === category
      ) {
        continue;
      }
      throw new Error(`Addon proposal overdraws token category: ${category}`);
    }
  }
  const tokenValidation = validateCashTokenProposal(proposal);
  if (!tokenValidation.ok) {
    throw new Error(
      `Addon proposal CashToken validation failed: ${tokenValidation.errors.join('; ')}`
    );
  }
}
